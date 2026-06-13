import { readFile, stat } from 'node:fs/promises';

import { readSlice } from './scan.mjs';

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
