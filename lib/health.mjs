import { readFile, stat } from 'node:fs/promises';

import { readSlice } from './scan.mjs';

// Session health (tool-call volume, per-tool mix, error rate, compaction count)
// needs the WHOLE transcript, not the tail the scanner digests. The counts are
// monotonic integers, so an actively-growing transcript resumes from a byte
// offset and folds only the appended lines into the running totals instead of
// re-reading the file each scan. Cached on (size, mtime).
let healthCache = new Map();

// Attribution keys (skill / MCP server / sub-agent type) come from transcript
// fields, so a crafted transcript must not corrupt these maps. `key in {}` rejects
// every Object.prototype member (__proto__, constructor, toString, hasOwnProperty,
// valueOf, …); 'prototype' is added explicitly because it lives on functions, not
// Object.prototype, so `in {}` misses it. No key can then reach the prototype chain
// or shadow a method on the map object itself.
function bump(map, key) {
    if (typeof key !== 'string' || !key || key in {} || key === 'prototype') return;
    map[key] = (map[key] || 0) + 1;
}

// Blast-radius signals (A5/B-P1 triage). File-mutating tools feed a distinct-file
// count; Bash commands are matched against destructive patterns and recorded by
// category label only — never the raw command, which can carry a credential.
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const FILES_TOUCHED_CAP = 5000;

const DESTRUCTIVE = [
    { label: 'git reset --hard', re: /\bgit\s+reset\s+--hard\b/i },
    { label: 'git clean -f', re: /\bgit\s+clean\s+-\w*f/i },
    { label: 'git push --force', re: /\bgit\s+push\b[^\n]*(--force(?!-with-lease)|\s-f\b)/i },
    { label: 'git checkout --', re: /\bgit\s+checkout\s+(--\s+)?\.(\/|\s|$)/i },
    { label: 'drop/truncate', re: /\b(drop\s+(table|database)|truncate\s+table)\b/i },
    // dd's destructive operand is of= (the write target), in either operand order.
    { label: 'dd of=', re: /\bdd\s+(?:[^\s]+\s+)*of=/i },
    { label: 'mkfs', re: /\bmkfs\b/i },
    { label: 'chmod -R 777', re: /\bchmod\s+-R\s+777\b/i },
];

// A recursive rm is only blast-radius when it targets root / home / a bare glob, or
// runs under sudo — generic `rm -rf <subdir>` (build cleanup, temp dirs) is far too
// common to be a useful alarm. RECURSIVE_RM has a leading-token guard so a filename
// like `my-report.txt` (contains "-r") can't false-positive.
// `(^|\s)rm` (not `\brm`) so the `rm` in a flag like docker's `--rm` is not read as
// the rm command. Danger targets are only the catastrophic ones — bare root `/`,
// `/*`, a bare glob `*`, or bare home `~`/`~/` (NOT `~/subdir`, which is scoped).
const RECURSIVE_RM = /(^|\s)rm\s+(?:[^\s]+\s+)*--?[a-z]*r/i;
const RM_DANGER = /(^|\s)(sudo\b|--no-preserve-root\b|\/(\s|$)|\/\*|\*(\s|$)|~\/?(\s|$))/i;

// Match per command segment, not the whole line: `rm -rf dist && cd ..` must not be
// flagged just because a later, unrelated segment mentions a dangerous token.
function isDangerousRm(cmd) {
    for (const seg of cmd.split(/&&|\|\||[;|\n]/)) {
        if (RECURSIVE_RM.test(seg) && RM_DANGER.test(seg)) return true;
    }
    return false;
}

function zeroCounts() {
    return {
        totalCalls: 0, byTool: {}, errorCount: 0, compactions: 0, lastCompactPreTokens: 0,
        subagentTypes: {}, skills: {}, mcpServers: {},
        writes: 0, filesTouched: new Set(), destructiveBash: 0, destructiveKinds: {},
        errorStreak: 0, maxErrorStreak: 0,
    };
}

function cloneCounts(src) {
    return {
        totalCalls: src.totalCalls,
        byTool: { ...src.byTool },
        errorCount: src.errorCount,
        compactions: src.compactions,
        lastCompactPreTokens: src.lastCompactPreTokens,
        subagentTypes: { ...src.subagentTypes },
        skills: { ...src.skills },
        mcpServers: { ...src.mcpServers },
        writes: src.writes,
        filesTouched: new Set(src.filesTouched),
        destructiveBash: src.destructiveBash,
        destructiveKinds: { ...src.destructiveKinds },
        errorStreak: src.errorStreak,
        maxErrorStreak: src.maxErrorStreak,
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
    // Per-turn attribution (top-level on assistant records). A skill or MCP server
    // repeats across many turns, so these are distinct-name maps with turn counts.
    bump(counts.skills, r.attributionSkill);
    bump(counts.mcpServers, r.attributionMcpServer);

    const content = r?.message?.content;
    if (!Array.isArray(content)) return;
    for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'tool_use' && typeof part.name === 'string') {
            counts.totalCalls += 1;
            counts.byTool[part.name] = (counts.byTool[part.name] || 0) + 1;
            // The Agent tool spawns a sub-agent; tally how many of each type.
            if (part.name === 'Agent') bump(counts.subagentTypes, part.input?.subagent_type);
            else if (WRITE_TOOLS.has(part.name)) {
                counts.writes += 1;
                const fp = part.input?.file_path;
                if (typeof fp === 'string' && fp && counts.filesTouched.size < FILES_TOUCHED_CAP) {
                    counts.filesTouched.add(fp);
                }
            } else if (part.name === 'Bash') {
                const cmd = part.input?.command;
                if (typeof cmd === 'string') {
                    const hit = DESTRUCTIVE.find((d) => d.re.test(cmd));
                    const label = hit ? hit.label : isDangerousRm(cmd) ? 'rm -rf root/home' : null;
                    if (label) {
                        counts.destructiveBash += 1;
                        bump(counts.destructiveKinds, label);
                    }
                }
            }
        } else if (part.type === 'tool_result') {
            // A run of consecutive error results is the "stuck in a retry loop"
            // signal; any success breaks the streak. maxErrorStreak is monotonic.
            if (part.is_error) {
                counts.errorCount += 1;
                counts.errorStreak += 1;
                if (counts.errorStreak > counts.maxErrorStreak) counts.maxErrorStreak = counts.errorStreak;
            } else {
                counts.errorStreak = 0;
            }
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
        subagentTypes: { ...counts.subagentTypes },
        skills: { ...counts.skills },
        mcpServers: { ...counts.mcpServers },
        writes: counts.writes,
        filesTouched: counts.filesTouched.size,
        destructiveBash: counts.destructiveBash,
        destructiveKinds: { ...counts.destructiveKinds },
        maxErrorStreak: counts.maxErrorStreak,
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
