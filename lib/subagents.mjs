import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { parseLines, textOfContent, isSyntheticUserText } from './scan.mjs';
import {
    accumulateLine, consumeLines, accumulateDatedLine, mergeUsageByModel,
} from './cost.mjs';

// Claude Code spawns sub-agents (Explore, Task, workflow steps) whose transcripts
// live in files the top-level scanner never reads:
//   <projectsDir>/<projectDir>/<sessionId>/subagents/**/agent-<id>.jsonl
// alongside a sibling agent-<id>.meta.json. Workflow sub-agents nest one level
// deeper under subagents/workflows/wf_*/. Each agent-*.jsonl is the SAME schema
// as a top-level transcript (user/assistant/attachment lines; assistant lines
// carry message.usage + message.model), so cost.mjs's accumulation works on them
// unchanged. The parent-session join key is the path component immediately before
// /subagents/ — matched exactly (not by prefix) so one session id that is a
// prefix of another can never collide.

const AGENT_FILE_RE = /^agent-.*\.jsonl$/;
const DOC_BODY_BYTES = 4096;       // dialogue-tail cap per sub-agent search doc

function subagentsDir(projectsDir, projectDir, sessionId) {
    return join(projectsDir, projectDir, sessionId, 'subagents');
}

// agent-<id>.jsonl → "agent-<id>"; the meta sibling swaps the extension.
function agentIdFromFile(file) {
    return basename(file, '.jsonl');
}

// All sub-agent transcripts for one parent session, recursing into the workflow
// nesting. A missing subagents/ dir (the common case — most sessions spawn none)
// yields []. The orchestration-only journal.jsonl is excluded by the agent-*
// name filter.
export async function subagentFilesFor(projectsDir, projectDir, sessionId) {
    const dir = subagentsDir(projectsDir, projectDir, sessionId);
    let entries;
    try {
        entries = await readdir(dir, { recursive: true, withFileTypes: true });
    } catch {
        return [];
    }
    const out = [];
    for (const ent of entries) {
        if (!ent.isFile() || !AGENT_FILE_RE.test(ent.name)) continue;
        // Node 20 exposes the containing dir as parentPath (path on older 20.x).
        const parent = ent.parentPath || ent.path || dir;
        const jsonlPath = join(parent, ent.name);
        const metaPath = join(parent, `${agentIdFromFile(ent.name)}.meta.json`);
        out.push({ jsonlPath, metaPath });
    }
    return out;
}

// Tolerant meta read: a missing or malformed sidecar degrades to a generic
// subagent label rather than failing the walk.
export async function readMeta(metaPath) {
    const fallback = { agentType: 'subagent', description: '', toolUseId: null };
    let raw;
    try {
        raw = await readFile(metaPath, 'utf8');
    } catch {
        return fallback;
    }
    try {
        const m = JSON.parse(raw);
        if (!m || typeof m !== 'object') return fallback;
        return {
            agentType: typeof m.agentType === 'string' && m.agentType ? m.agentType : 'subagent',
            description: typeof m.description === 'string' ? m.description : '',
            toolUseId: typeof m.toolUseId === 'string' ? m.toolUseId : null,
        };
    } catch {
        return fallback;
    }
}

// Per-file (size, mtime) cache for the merged usage of a single agent transcript.
// Sub-agent transcripts are terminal (the sub-agent finishes and the file stops
// growing), so a plain full-read on change — no byte-offset resume — is enough.
const usageCache = new Map();

async function usageForFile(path) {
    let st;
    try {
        st = await stat(path);
    } catch {
        return {};
    }
    const cached = usageCache.get(path);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.byModel;
    let text;
    try {
        text = await readFile(path, 'utf8');
    } catch {
        return {};
    }
    const byModel = {};
    consumeLines(text, byModel);
    usageCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, byModel });
    return byModel;
}

// Merged { [model]: {input, output, cacheRead, cacheWrite5m, cacheWrite1h} } summed
// across every sub-agent transcript of one parent session, in the exact shape the
// pricing layer consumes — so the caller can fold it into the session's own usage
// before pricing and the result prices identically to a native map. {} when the
// session spawned no sub-agents.
export async function subagentUsageByModel(projectsDir, projectDir, sessionId) {
    const files = await subagentFilesFor(projectsDir, projectDir, sessionId);
    const merged = {};
    for (const { jsonlPath } of files) {
        const byModel = await usageForFile(jsonlPath);
        mergeUsageByModel(merged, byModel);
    }
    return merged;
}

// Per-file (size, mtime) cache for a single agent transcript's day×model map.
const dateCache = new Map();

async function dateModelForFile(path) {
    let st;
    try {
        st = await stat(path);
    } catch {
        return {};
    }
    const cached = dateCache.get(path);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.byDate;
    let text;
    try {
        text = await readFile(path, 'utf8');
    } catch {
        return {};
    }
    const byDate = {};
    for (const line of text.split('\n')) accumulateDatedLine(byDate, line);
    dateCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, byDate });
    return byDate;
}

// Per-day × per-model usage merged across one session's sub-agent transcripts, in
// the same { [YYYY-MM-DD]: { [model]: tokens } } shape usageByDateModel produces —
// so it drops straight into the rollup's dailyMaps and the budget alert picks up
// sub-agent spend on the right calendar day. {} when none.
export async function subagentDateModel(projectsDir, projectDir, sessionId) {
    const files = await subagentFilesFor(projectsDir, projectDir, sessionId);
    const byDate = {};
    for (const { jsonlPath } of files) {
        const fileMap = await dateModelForFile(jsonlPath);
        for (const [date, models] of Object.entries(fileMap)) {
            const day = (byDate[date] ||= {});
            for (const [model, tokens] of Object.entries(models)) {
                mergeUsageByModel(day, { [model]: tokens });
            }
        }
    }
    return byDate;
}

// Dialogue-only tail of a sub-agent transcript: human/assistant text turns joined
// most-recent-last, tool calls / results / thinking / synthetic turns dropped, and
// capped at DOC_BODY_BYTES so a long sub-agent run can't bloat the index.
function dialogueTail(text) {
    const turns = [];
    for (const r of parseLines(text)) {
        if (!r || !r.message) continue;
        if (r.type === 'assistant') {
            const t = textOfContent(r.message.content);
            if (t && t.trim()) turns.push(t.replace(/\s+/g, ' ').trim());
        } else if (r.type === 'user' && !r.isMeta) {
            const t = textOfContent(r.message.content);
            if (t && t.trim() && !isSyntheticUserText(t)) turns.push(t.replace(/\s+/g, ' ').trim());
        }
    }
    let body = '';
    for (let i = turns.length - 1; i >= 0 && body.length < DOC_BODY_BYTES; i--) {
        body = `${turns[i]} ${body}`;
    }
    return body.slice(0, DOC_BODY_BYTES).trim();
}

// Per-file (size, mtime) cache for a single sub-agent search doc.
const docCache = new Map();

async function docForFile(jsonlPath, metaPath, repo) {
    let st;
    try {
        st = await stat(jsonlPath);
    } catch {
        return null;
    }
    const cached = docCache.get(jsonlPath);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs && cached.repo === repo) {
        return cached.doc;
    }
    let text;
    try {
        text = await readFile(jsonlPath, 'utf8');
    } catch {
        return null;
    }
    const meta = await readMeta(metaPath);
    const byModel = await usageForFile(jsonlPath);
    const models = Object.keys(byModel);
    const doc = {
        id: agentIdFromFile(basename(jsonlPath)),
        agentType: meta.agentType,
        description: meta.description,
        repo,
        body: dialogueTail(text),
        model: models.length === 1 ? models[0] : (models[0] || null),
    };
    docCache.set(jsonlPath, { size: st.size, mtimeMs: st.mtimeMs, repo, doc });
    return doc;
}

// Search docs for one session's sub-agents, each attributed back to the parent so a
// hit can navigate to the parent session. id is the agent id; parentSessionId is the
// join key. [] when the session spawned no sub-agents.
export async function subagentDocsFor(projectsDir, projectDir, sessionId, repo = null) {
    const files = await subagentFilesFor(projectsDir, projectDir, sessionId);
    const docs = [];
    for (const { jsonlPath, metaPath } of files) {
        const doc = await docForFile(jsonlPath, metaPath, repo);
        if (doc) docs.push({ ...doc, parentSessionId: sessionId });
    }
    return docs;
}

// Cheap count of a session's sub-agent transcripts for the UI chip — a directory
// walk only, no file reads.
export async function subagentCountFor(projectsDir, projectDir, sessionId) {
    const files = await subagentFilesFor(projectsDir, projectDir, sessionId);
    return files.length;
}

// Drop cached entries for sub-agent files no longer present (mirrors cost.mjs's
// pruneUsageCache; called with the live set so a deleted session's caches don't leak).
export function pruneSubagentCaches(livePaths) {
    for (const cache of [usageCache, dateCache, docCache]) {
        for (const path of cache.keys()) {
            if (!livePaths.has(path)) cache.delete(path);
        }
    }
}
