import { readFile, stat } from 'node:fs/promises';

import { readSlice } from './scan.mjs';

// Session health (tool-call volume, per-tool mix, error rate, compaction count)
// needs the WHOLE transcript, not the tail the scanner digests. The counts are
// monotonic integers, so an actively-growing transcript resumes from a byte
// offset and folds only the appended lines into the running totals instead of
// re-reading the file each scan. Cached on (size, mtime).
let healthCache = new Map();

function zeroCounts() {
    return { totalCalls: 0, byTool: {}, errorCount: 0, compactions: 0, lastCompactPreTokens: 0 };
}

function cloneCounts(src) {
    return {
        totalCalls: src.totalCalls,
        byTool: { ...src.byTool },
        errorCount: src.errorCount,
        compactions: src.compactions,
        lastCompactPreTokens: src.lastCompactPreTokens,
    };
}

function accumulateLine(counts, line) {
    let r;
    try {
        r = JSON.parse(line);
    } catch {
        // partial / non-JSON line — skip
        return;
    }
    if (r.type === 'system' && r.subtype === 'compact_boundary') {
        counts.compactions += 1;
        // preTokens = context size right before this compaction; records are
        // folded in order, so the last one seen is the most recent compaction.
        const pre = r.compactMetadata?.preTokens;
        if (typeof pre === 'number' && pre > 0) counts.lastCompactPreTokens = pre;
        return;
    }
    const content = r?.message?.content;
    if (!Array.isArray(content)) return;
    for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'tool_use' && typeof part.name === 'string') {
            counts.totalCalls += 1;
            counts.byTool[part.name] = (counts.byTool[part.name] || 0) + 1;
        } else if (part.type === 'tool_result' && part.is_error) {
            counts.errorCount += 1;
        }
    }
}

// Parse `text`, consuming only fully-terminated lines (everything up to and
// including the last newline). Returns the UTF-8 byte length consumed so the
// caller can advance a byte offset; the trailing partial line (a record still
// being flushed) is left for the next read.
function consumeLines(text, counts) {
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) return { consumedBytes: 0 };
    const consumed = text.slice(0, lastNl + 1);
    for (const line of consumed.split('\n')) {
        if (line.trim()) accumulateLine(counts, line);
    }
    return { consumedBytes: Buffer.byteLength(consumed, 'utf8') };
}

function derive(counts) {
    const errorRate = counts.totalCalls === 0
        ? 0
        : Math.round((counts.errorCount / counts.totalCalls) * 1000) / 10;
    return {
        totalCalls: counts.totalCalls,
        byTool: { ...counts.byTool },
        errorCount: counts.errorCount,
        errorRate,
        compactions: counts.compactions,
        lastCompactPreTokens: counts.lastCompactPreTokens,
    };
}

export async function sessionHealth(path) {
    let st;
    try {
        st = await stat(path);
    } catch {
        return derive(zeroCounts());
    }

    const cached = healthCache.get(path);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
        return derive(cached.counts);
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
            const counts = cloneCounts(cached.counts);
            const { consumedBytes } = consumeLines(slice, counts);
            if (consumedBytes > 0) {
                const entry = {
                    size: st.size,
                    mtimeMs: st.mtimeMs,
                    counts,
                    safeOffset: cached.safeOffset + consumedBytes,
                };
                healthCache.set(path, entry);
                return derive(counts);
            }
            // grew but no complete new line yet — keep totals, refresh size/mtime
            healthCache.set(path, { ...cached, size: st.size, mtimeMs: st.mtimeMs });
            return derive(cached.counts);
        }
    }

    // Cold read, or the file shrank/rotated (size < safeOffset) → full re-read.
    const counts = zeroCounts();
    let text;
    try {
        text = await readFile(path, 'utf8');
    } catch {
        return derive(counts);
    }
    const { consumedBytes } = consumeLines(text, counts);
    healthCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, counts, safeOffset: consumedBytes });
    return derive(counts);
}

// Drop cache entries for files that no longer exist (called with the live path set).
export function pruneHealthCache(livePaths) {
    for (const path of healthCache.keys()) {
        if (!livePaths.has(path)) healthCache.delete(path);
    }
}
