import { readFile, stat } from 'node:fs/promises';

import { readSlice } from './scan.mjs';
import { costSummary } from './pricing.mjs';

// Cumulative cost needs the WHOLE transcript (every assistant turn's usage), not
// the tail the scanner digests. Cached on (size, mtime); for an actively-growing
// transcript (the live session you're watching) the cache would miss on every
// write, so we resume from a byte offset and parse only the appended lines
// instead of re-reading tens of MB each second.
//
// Known limitation: a Task-tool subagent whose own assistant turns live in a
// separate transcript records its spend only as a `toolUseResult.usage` rollup
// on a user line, which we do not attribute (the rollup carries no model id).
// Measured impact on real data: ~0.1% of lifetime spend, ≤1.3% on the most
// subagent-heavy single session.
let usageCache = new Map();

function accumulate(byModel, model, usage) {
    const m = (byModel[model] ||= {
        input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0,
    });
    m.input += usage.input_tokens || 0;
    m.output += usage.output_tokens || 0;
    m.cacheRead += usage.cache_read_input_tokens || 0;
    const cc = usage.cache_creation;
    if (cc && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null)) {
        m.cacheWrite5m += cc.ephemeral_5m_input_tokens || 0;
        m.cacheWrite1h += cc.ephemeral_1h_input_tokens || 0;
    } else {
        // older records only carry the flat cache_creation_input_tokens; treat
        // as 5-minute writes (the common case)
        m.cacheWrite5m += usage.cache_creation_input_tokens || 0;
    }
}

function accumulateLine(byModel, line) {
    if (!line.includes('"usage"')) return;
    try {
        const r = JSON.parse(line);
        const usage = r?.message?.usage;
        const model = r?.message?.model;
        // Skip harness placeholders like "<synthetic>" — injected turns, not
        // billable API calls.
        if (r.type === 'assistant' && usage && typeof model === 'string' && !model.startsWith('<')) {
            accumulate(byModel, model, usage);
        }
    } catch {
        // partial / non-JSON line — skip
    }
}

function cloneByModel(src) {
    const out = {};
    for (const [model, tokens] of Object.entries(src)) out[model] = { ...tokens };
    return out;
}

// Parse `text`, consuming only fully-terminated lines (everything up to and
// including the last newline). Returns { byModel, consumedBytes } so the caller
// can advance a byte offset; the trailing partial line (a record still being
// flushed) is left for the next read. consumedBytes is UTF-8 byte length, not
// character count, so it is exact for multi-byte content.
function consumeLines(text, byModel) {
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) return { consumedBytes: 0 };
    const consumed = text.slice(0, lastNl + 1);
    for (const line of consumed.split('\n')) accumulateLine(byModel, line);
    return { consumedBytes: Buffer.byteLength(consumed, 'utf8') };
}

export async function sessionUsageByModel(path) {
    const st = await stat(path);
    const cached = usageCache.get(path);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
        return cached.byModel;
    }

    // Append-only growth from a known safe offset → read just the new bytes.
    if (cached && cached.safeOffset != null && st.size > cached.safeOffset) {
        let slice;
        try {
            slice = await readSlice(path, cached.safeOffset, st.size - cached.safeOffset);
        } catch {
            slice = null;
        }
        if (slice != null) {
            const byModel = cloneByModel(cached.byModel);
            const { consumedBytes } = consumeLines(slice, byModel);
            if (consumedBytes > 0) {
                const entry = { size: st.size, mtimeMs: st.mtimeMs, byModel, safeOffset: cached.safeOffset + consumedBytes };
                usageCache.set(path, entry);
                return byModel;
            }
            // grew but no complete new line yet — keep totals, refresh size/mtime
            usageCache.set(path, { ...cached, size: st.size, mtimeMs: st.mtimeMs });
            return cached.byModel;
        }
    }

    // Cold read, or the file shrank/rotated (size < safeOffset) → full re-read.
    const byModel = {};
    let text;
    try {
        text = await readFile(path, 'utf8');
    } catch {
        return byModel;
    }
    const { consumedBytes } = consumeLines(text, byModel);
    usageCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, byModel, safeOffset: consumedBytes });
    return byModel;
}

// Drop cache entries for files that no longer exist (called with the live path set).
export function pruneUsageCache(livePaths) {
    for (const path of usageCache.keys()) {
        if (!livePaths.has(path)) usageCache.delete(path);
    }
}

// ---------------------------------------------------------------------------
// On-demand per-day × per-model token rollup for the cost-over-time endpoint.
// Separate cache and a full re-read on change: this is not the hot scan path,
// so the byte-offset resume machinery above is unnecessary here.
let dateUsageCache = new Map();

function accumulateDated(byDate, date, model, usage) {
    const day = (byDate[date] ||= {});
    const m = (day[model] ||= {
        input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0,
    });
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

function utcDay(ts) {
    if (typeof ts !== 'string') return null;
    const t = Date.parse(ts);
    if (Number.isNaN(t)) return null;
    return new Date(t).toISOString().slice(0, 10);
}

// { [YYYY-MM-DD]: { [model]: {input, output, cacheRead, cacheWrite5m, cacheWrite1h} } }
// keyed on the UTC day of each assistant record's timestamp. Missing/unreadable
// file → {}.
export async function usageByDateModel(path) {
    let st;
    try {
        st = await stat(path);
    } catch {
        return {};
    }
    const cached = dateUsageCache.get(path);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
        return cached.byDate;
    }

    let text;
    try {
        text = await readFile(path, 'utf8');
    } catch {
        return {};
    }

    const byDate = {};
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
        const date = utcDay(r.timestamp);
        if (!date) continue;
        accumulateDated(byDate, date, model, usage);
    }

    dateUsageCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, byDate });
    return byDate;
}

function addTokens(dst, src) {
    dst.input += src.input || 0;
    dst.output += src.output || 0;
    dst.cacheRead += src.cacheRead || 0;
    dst.cacheWrite5m += src.cacheWrite5m || 0;
    dst.cacheWrite1h += src.cacheWrite1h || 0;
}

// Monday (UTC) of the ISO week containing `date` (a YYYY-MM-DD string),
// formatted YYYY-MM-DD. ISO weeks start on Monday.
function isoWeekStart(date) {
    const d = new Date(`${date}T00:00:00Z`);
    const dow = d.getUTCDay(); // Sun=0..Sat=6
    const backToMonday = (dow + 6) % 7; // Mon→0, Tue→1, ... Sun→6
    d.setUTCDate(d.getUTCDate() - backToMonday);
    return d.toISOString().slice(0, 10);
}

function bucketKey(date, window) {
    if (window === 'month') return date.slice(0, 7);
    if (window === 'week') return isoWeekStart(date);
    return date;
}

function round4(n) {
    return Math.round(n * 1e4) / 1e4;
}

// Merge the per-file day×model maps, regroup by window, and price each bucket
// via costSummary (single source of truth for the cache-tier multipliers).
// dailyMaps: array of usageByDateModel results.
// → { window, buckets: [{ date, usd, byModel: { [model]: usd } }], totalUsd }
export function rollupFromDaily(dailyMaps, { window, pricing }) {
    // Merge into { [bucketKey]: { [model]: tokens } }.
    const buckets = new Map();
    for (const map of dailyMaps || []) {
        for (const [date, models] of Object.entries(map || {})) {
            const key = bucketKey(date, window);
            const bucket = buckets.get(key) || (buckets.set(key, {}), buckets.get(key));
            for (const [model, tokens] of Object.entries(models)) {
                const m = (bucket[model] ||= {
                    input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0,
                });
                addTokens(m, tokens);
            }
        }
    }

    let totalUsd = 0;
    const rows = [];
    for (const [date, bucketModels] of buckets.entries()) {
        const summary = costSummary(bucketModels, pricing);
        totalUsd += summary.totalUsd;
        const byModel = {};
        for (const row of summary.byModel) byModel[row.model] = round4(row.usd);
        rows.push({ date, usd: round4(summary.totalUsd), byModel });
    }
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    return { window, buckets: rows, totalUsd: round4(totalUsd) };
}

// Wide CSV: period,total_usd,<each model sorted ascending>; one row per bucket.
// Model ids and numbers carry no commas, so no escaping is required.
export function rollupToCsv(rollup) {
    const models = new Set();
    for (const b of rollup.buckets) {
        for (const model of Object.keys(b.byModel)) models.add(model);
    }
    const cols = [...models].sort();
    const header = ['period', 'total_usd', ...cols].join(',');
    const lines = [header];
    for (const b of rollup.buckets) {
        const cells = [b.date, round4(b.usd), ...cols.map((m) => round4(b.byModel[m] || 0))];
        lines.push(cells.join(','));
    }
    return lines.join('\n') + '\n';
}
