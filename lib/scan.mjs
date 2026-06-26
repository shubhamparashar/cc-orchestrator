import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 32 * 1024;
const DEFAULT_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;
const RUNNING_WRITE_WINDOW_MS = 90_000;

// Harness-injected user turns that shouldn't count as "the last thing the user said".
const SYNTHETIC_USER_PREFIXES = [
    '<task-notification>',
    '<system-reminder>',
    '<local-command',
    '<command-',
    '<create-pr-command',
    '<ide_opened_file>',
    '<ide_selection>',
    '<ide_diagnostics>',
    'Caveat:',
    '[Request interrupted',
];

async function readSlice(path, position, length) {
    const fh = await open(path, 'r');
    try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, position);
        return buf.toString('utf8', 0, bytesRead);
    } finally {
        await fh.close();
    }
}

function parseLines(text) {
    const records = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            records.push(JSON.parse(line));
        } catch {
            // partial line at a slice boundary — skip
        }
    }
    return records;
}

function textOfContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    const texts = content
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text);
    return texts.length ? texts.join('\n') : null;
}

function isSyntheticUserText(text) {
    const t = text.trimStart();
    return SYNTHETIC_USER_PREFIXES.some((p) => t.startsWith(p));
}

function snippet(text, max = 280) {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
}

// Context windows by model id. Current Opus 4.6+/Sonnet 4.6/Fable 5 ship a 1M
// window as standard (no marker on the id); Haiku 4.5 and any unlisted/older
// model are 200k. The "[1m]" suffix is Claude Code's marker for a 1M-beta session
// on an otherwise-200k model (e.g. claude-sonnet-4-5[1m]) — current 1M-native
// models carry no such marker, which is why marker-only detection misses them.
const WINDOW_BY_MODEL = {
    'claude-fable-5': LARGE_WINDOW,
    'claude-opus-4-8': LARGE_WINDOW,
    'claude-opus-4-7': LARGE_WINDOW,
    'claude-opus-4-6': LARGE_WINDOW,
    'claude-sonnet-4-6': LARGE_WINDOW,
    'claude-haiku-4-5': DEFAULT_WINDOW,
};

// Strip any "[...]" suffix and longest-prefix-match the id, the same shape as
// pricing.mjs's rateFor. "[1m]" forces the large window regardless of the table.
function windowForModelId(modelId) {
    if (typeof modelId !== 'string' || !modelId) return null;
    if (modelId.includes('[1m]')) return LARGE_WINDOW;
    const clean = modelId.replace(/\[.*$/, '').trim();
    let best = null;
    let bestLen = -1;
    for (const [id, win] of Object.entries(WINDOW_BY_MODEL)) {
        if (clean.startsWith(id) && id.length > bestLen) {
            best = win;
            bestLen = id.length;
        }
    }
    return best;
}

// The Desktop metadata model is the most authoritative signal; fall back to the
// transcript's model id, then to a usage-based guess (the window must be larger
// than 200k if more than a 200k window's worth of tokens is already in context).
function contextWindowFor(model, desktopModel, usedTokens) {
    const known = windowForModelId(desktopModel) ?? windowForModelId(model);
    if (known) return known;
    if (usedTokens > DEFAULT_WINDOW * 1.05) return LARGE_WINDOW;
    return DEFAULT_WINDOW;
}

// Walks the tail records backwards and pulls everything the UI needs.
function digest(records) {
    const out = {
        cwd: null, gitBranch: null, title: null, model: null,
        lastUser: null, lastAssistant: null, lastRole: null,
        usedTokens: null, lastTimestamp: null, prNumbers: [],
    };
    for (let i = records.length - 1; i >= 0; i--) {
        const r = records[i];
        if (!out.lastTimestamp && typeof r.timestamp === 'string') out.lastTimestamp = r.timestamp;
        if (!out.cwd && typeof r.cwd === 'string') out.cwd = r.cwd;
        if (!out.gitBranch && typeof r.gitBranch === 'string') out.gitBranch = r.gitBranch;
        if (!out.title && (r.type === 'custom-title' || r.type === 'ai-title')) {
            const t = r.customTitle ?? r.aiTitle;
            if (typeof t === 'string' && t) out.title = t;
        }
        if (r.type === 'pr-link' && r.prNumber && !out.prNumbers.includes(r.prNumber)) {
            out.prNumbers.push(r.prNumber);
        }
        if (r.type === 'assistant' && r.message) {
            if (!out.lastRole) out.lastRole = 'assistant';
            if (out.usedTokens == null && r.message.usage) {
                const u = r.message.usage;
                out.usedTokens =
                    (u.input_tokens || 0) +
                    (u.cache_read_input_tokens || 0) +
                    (u.cache_creation_input_tokens || 0);
            }
            if (!out.model && typeof r.message.model === 'string') out.model = r.message.model;
            if (!out.lastAssistant) {
                const text = textOfContent(r.message.content);
                if (text && text.trim()) out.lastAssistant = snippet(text);
            }
        }
        if (r.type === 'user' && !r.isMeta && r.message) {
            const text = textOfContent(r.message.content);
            if (text && text.trim() && !isSyntheticUserText(text)) {
                if (!out.lastRole) out.lastRole = 'user';
                if (!out.lastUser) out.lastUser = snippet(text);
            }
        }
        const done =
            out.lastUser && out.lastAssistant && out.usedTokens != null &&
            out.cwd && out.gitBranch && out.title;
        if (done) break;
    }
    return out;
}

function statusOf(live, mtimeMs, lastRole, desktopMeta) {
    if (live) {
        const writingRecently = Date.now() - mtimeMs < RUNNING_WRITE_WINDOW_MS;
        if (writingRecently && lastRole !== 'assistant') return 'running';
        if (writingRecently) return 'running';
        return lastRole === 'assistant' ? 'waiting-on-input' : 'open-idle';
    }
    if (desktopMeta?.isArchived) return 'archived';
    return 'idle';
}

// Digest of an unchanged file is fully determined by (size, mtime); caching it
// means a refresh re-parses only the files that actually changed. Status, live
// pids, and desktop joins are computed fresh on every scan — never cached.
let digestCache = new Map();

async function digestFile(path, st) {
    const cached = digestCache.get(path);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached;
    const tailStart = Math.max(0, st.size - TAIL_BYTES);
    const tailText = await readSlice(path, tailStart, Math.min(st.size, TAIL_BYTES));
    const records = parseLines(tailText);
    const d = digest(records);
    let headUser = null;
    if ((!d.cwd || !d.title) && tailStart > 0) {
        const headRecords = parseLines(await readSlice(path, 0, HEAD_BYTES));
        const h = digest(headRecords);
        d.cwd = d.cwd || h.cwd;
        d.gitBranch = d.gitBranch || h.gitBranch;
        d.title = d.title || h.title;
        headUser = h.lastUser;
    }
    return { size: st.size, mtimeMs: st.mtimeMs, d, headUser };
}

export async function scanSessions({ liveBySession = new Map(), desktopBySession = new Map() } = {}) {
    let projectDirs = [];
    try {
        projectDirs = await readdir(PROJECTS_DIR);
    } catch {
        return [];
    }
    const sessions = [];
    const nextCache = new Map();
    for (const dir of projectDirs) {
        const dirPath = join(PROJECTS_DIR, dir);
        let files;
        try {
            files = await readdir(dirPath);
        } catch {
            continue;
        }
        const isWorktree = dir.includes('--claude-worktrees-');
        for (const file of files) {
            if (!UUID_RE.test(file)) continue;
            const path = join(dirPath, file);
            const sessionId = basename(file, '.jsonl');
            try {
                const st = await stat(path);
                if (st.size === 0) continue;
                const entry = await digestFile(path, st);
                nextCache.set(path, entry);
                const { d, headUser } = entry;
                const live = liveBySession.get(sessionId) || null;
                const desktop = desktopBySession.get(sessionId) || null;
                const usedTokens = d.usedTokens ?? 0;
                const window = contextWindowFor(d.model, desktop?.model, usedTokens);
                sessions.push({
                    sessionId,
                    projectDir: dir,
                    isWorktree,
                    cwd: live?.cwd || desktop?.cwd || d.cwd || null,
                    repo: basename(live?.cwd || desktop?.cwd || d.cwd || dir),
                    gitBranch: d.gitBranch,
                    title: snippet(desktop?.title || d.title || d.lastUser || headUser || sessionId.slice(0, 8), 90),
                    model: desktop?.model || d.model,
                    status: statusOf(live, st.mtimeMs, d.lastRole, desktop),
                    entrypoint: live?.entrypoint || (desktop ? 'claude-desktop' : null),
                    pid: live?.pid || null,
                    // Fields the join already has but the card never showed (A7):
                    // effort/permissionMode are Desktop-only; startedAt/kind come
                    // from the live pid registry (null for sessions with no live process).
                    effort: desktop?.effort || null,
                    permissionMode: desktop?.permissionMode || null,
                    startedAt: live?.startedAt || null,
                    kind: live?.kind || null,
                    lastActivityAt: st.mtimeMs,
                    lastTimestamp: d.lastTimestamp,
                    usedTokens,
                    contextWindow: window,
                    contextPct: usedTokens ? Math.min(100, Math.round((usedTokens / window) * 100)) : null,
                    lastUser: d.lastUser,
                    lastAssistant: d.lastAssistant,
                    prNumbers: desktop?.prNumber ? [desktop.prNumber] : d.prNumbers,
                    prState: desktop?.prState || null,
                    isArchived: Boolean(desktop?.isArchived),
                    sizeBytes: st.size,
                });
            } catch {
                // unreadable file — skip, never block the listing
            }
        }
    }
    digestCache = nextCache;
    sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return sessions;
}

export { PROJECTS_DIR, readSlice, parseLines, textOfContent, isSyntheticUserText, digestFile, contextWindowFor, TAIL_BYTES };
