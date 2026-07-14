import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { costSummary } from './pricing.mjs';
import { readMeta, subagentFilesFor } from './subagents.mjs';

// "What's using your limits?" — recent spend attributed to skill / MCP server /
// sub-agent type. Assistant lines carry per-turn attribution fields
// (attributionSkill, attributionMcpServer) plus message.usage and a timestamp;
// sub-agent transcripts carry their type in the agent-*.meta.json sidecar.
//
// Per transcript we bucket token usage by (UTC hour, skill, mcp) so any
// trailing-window query is a filter over cached buckets. Categories overlap by
// design (one turn can belong to a skill AND an mcp server AND live in a
// sub-agent), so percentages are each "share of total", not a partition.
//
// ponytail: full re-read on (size,mtime) change, no byte-offset resume — this is
// a dialog-open path, not the hot scan loop; add resume if profiling ever says so.
let bucketCache = new Map();

const SEP = '\u0000';
const NONE = '';

function safeKey(key) {
    return typeof key === 'string' && key && !(key in {}) && key !== 'prototype' ? key : NONE;
}

function addUsage(byModel, model, usage) {
    const m = (byModel[model] ||= { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
    m.input += usage.input_tokens || 0;
    m.output += usage.output_tokens || 0;
    m.cacheRead += usage.cache_read_input_tokens || 0;
    const cc = usage.cache_creation;
    if (cc && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null)) {
        m.cacheWrite5m += cc.ephemeral_5m_input_tokens || 0;
        m.cacheWrite1h += cc.ephemeral_1h_input_tokens || 0;
    } else {
        m.cacheWrite5m += usage.cache_creation_input_tokens || 0;
    }
}

function parseBuckets(text) {
    // { "<hourIso>\0<skill>\0<mcp>": byModelUsageMap }
    const buckets = {};
    for (const line of text.split('\n')) {
        if (!line.includes('"usage"')) continue;
        let r;
        try {
            r = JSON.parse(line);
        } catch {
            continue;
        }
        const usage = r?.message?.usage;
        const model = r?.message?.model;
        if (r.type !== 'assistant' || !usage || typeof model !== 'string' || model.startsWith('<')) continue;
        if (typeof r.timestamp !== 'string' || model in {}) continue;
        const hour = r.timestamp.slice(0, 13);
        const key = hour + SEP + safeKey(r.attributionSkill) + SEP + safeKey(r.attributionMcpServer);
        addUsage((buckets[key] ||= {}), model, usage);
    }
    return buckets;
}

async function transcriptBuckets(path) {
    let st;
    try {
        st = await stat(path);
    } catch {
        return {};
    }
    const cached = bucketCache.get(path);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.buckets;
    let text;
    try {
        text = await readFile(path, 'utf8');
    } catch {
        return {};
    }
    const buckets = parseBuckets(text);
    bucketCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, buckets });
    return buckets;
}

export function pruneAttributionCache(livePaths) {
    for (const path of bucketCache.keys()) {
        if (!livePaths.has(path)) bucketCache.delete(path);
    }
}

function mergeInto(dst, src) {
    for (const [model, t] of Object.entries(src)) {
        const m = (dst[model] ||= { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
        m.input += t.input; m.output += t.output; m.cacheRead += t.cacheRead;
        m.cacheWrite5m += t.cacheWrite5m; m.cacheWrite1h += t.cacheWrite1h;
    }
}

// Sum a transcript's buckets newer than cutoffHour into per-category usage maps.
function foldBuckets(buckets, cutoffHour, into) {
    for (const [key, usage] of Object.entries(buckets)) {
        const [hour, skill, mcp] = key.split(SEP);
        if (hour < cutoffHour) continue;
        mergeInto(into.total, usage);
        if (skill) mergeInto((into.bySkill[skill] ||= {}), usage);
        if (mcp) mergeInto((into.byMcp[mcp] ||= {}), usage);
    }
}

const round4 = (n) => Math.round(n * 1e4) / 1e4;

function pricedList(catMaps, totalUsd, pricing) {
    return Object.entries(catMaps)
        .map(([key, byModel]) => {
            const usd = round4(costSummary(byModel, pricing).totalUsd);
            return { key, usd, pct: totalUsd > 0 ? Math.round((usd / totalUsd) * 1000) / 10 : 0 };
        })
        .filter((e) => e.usd > 0)
        .sort((a, b) => b.usd - a.usd);
}

const HIGH_CONTEXT_TOKENS = 150_000;
const SUBAGENT_HEAVY_SHARE = 0.3;

// sessions: scanned session objects (projectDir, sessionId, usedTokens).
export async function usageAttribution({ sessions, projectsDir, hours = 24, pricing, mapLimit }) {
    const cutoffHour = new Date(Date.now() - hours * 3600_000).toISOString().slice(0, 13);
    const into = { total: {}, bySkill: {}, byMcp: {} };
    const bySubType = {};
    let subUsd = 0, highContextUsd = 0, heavyUsd = 0;
    const livePaths = new Set();

    const perSession = await mapLimit(sessions, 8, async (s) => {
        const ownPath = join(projectsDir, s.projectDir, `${s.sessionId}.jsonl`);
        livePaths.add(ownPath);
        const ownBuckets = await transcriptBuckets(ownPath);
        const own = { total: {}, bySkill: {}, byMcp: {} };
        foldBuckets(ownBuckets, cutoffHour, own);

        const subFiles = await subagentFilesFor(projectsDir, s.projectDir, s.sessionId);
        const subByType = {};
        const subTotal = {};
        for (const { jsonlPath, metaPath } of subFiles) {
            livePaths.add(jsonlPath);
            const buckets = await transcriptBuckets(jsonlPath);
            const sub = { total: {}, bySkill: {}, byMcp: {} };
            foldBuckets(buckets, cutoffHour, sub);
            if (!Object.keys(sub.total).length) continue;
            const { agentType } = await readMeta(metaPath);
            mergeInto((subByType[safeKey(agentType) || 'subagent'] ||= {}), sub.total);
            mergeInto(subTotal, sub.total);
        }
        return { s, own, subByType, subTotal };
    });

    for (const r of perSession) {
        if (!r) continue;
        mergeInto(into.total, r.own.total);
        for (const [k, v] of Object.entries(r.own.bySkill)) mergeInto((into.bySkill[k] ||= {}), v);
        for (const [k, v] of Object.entries(r.own.byMcp)) mergeInto((into.byMcp[k] ||= {}), v);
        mergeInto(into.total, r.subTotal);
        for (const [k, v] of Object.entries(r.subByType)) mergeInto((bySubType[k] ||= {}), v);

        const ownUsd = costSummary(r.own.total, pricing).totalUsd;
        const sUsd = costSummary(r.subTotal, pricing).totalUsd;
        const sessionUsd = ownUsd + sUsd;
        subUsd += sUsd;
        if ((r.s.usedTokens || 0) > HIGH_CONTEXT_TOKENS) highContextUsd += sessionUsd;
        if (sessionUsd > 0 && sUsd / sessionUsd > SUBAGENT_HEAVY_SHARE) heavyUsd += sessionUsd;
    }

    pruneAttributionCache(livePaths);
    const totalUsd = round4(costSummary(into.total, pricing).totalUsd);
    const pct = (usd) => (totalUsd > 0 ? Math.round((usd / totalUsd) * 1000) / 10 : 0);
    return {
        hours,
        totalUsd,
        bySubagentType: pricedList(bySubType, totalUsd, pricing),
        bySkill: pricedList(into.bySkill, totalUsd, pricing),
        byMcp: pricedList(into.byMcp, totalUsd, pricing),
        stats: {
            subagentUsd: round4(subUsd),
            subagentPct: pct(subUsd),
            subagentHeavyPct: pct(heavyUsd),
            highContextPct: pct(highContextUsd),
        },
    };
}

// test-only
export function _resetAttribution() {
    bucketCache = new Map();
}
