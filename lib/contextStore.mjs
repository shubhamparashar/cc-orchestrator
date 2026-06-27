import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const CONTEXTS_DIR = join(homedir(), '.claude', 'contexts');
const STATE_DIR = join(CONTEXTS_DIR, '.state');

// The session index is server-private — only the running server reads and writes
// it. Namespace the file by port so a second server on another port (e.g. a
// throwaway verify instance) can't clobber the primary's index when both reach
// their reindex tick. The default port keeps the legacy `index.json` name, so
// existing installs need no migration. The atomic-write temp file is already
// per-pid, so the final rename target is the only path two servers could share.
const DEFAULT_PORT = '7433';

export function indexFileForPort(port) {
    // Canonicalize exactly as the server resolves its bind port — Number(...) — so a
    // non-canonical PORT ('07433', ' 7433', a non-numeric value) maps to the file the
    // server actually reads/writes, never a phantom index-07433.json no server touches.
    // Orphaned index-<port>.json files from dead ephemeral servers are inert (only a
    // server on that exact port would read one), so no reaper is needed.
    const p = String(Number(port) || DEFAULT_PORT);
    return p === DEFAULT_PORT ? 'index.json' : `index-${p}.json`;
}

const INDEX_PATH = join(CONTEXTS_DIR, indexFileForPort(process.env.PORT));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isSessionUuid(id) {
    return typeof id === 'string' && UUID_RE.test(id);
}

export function contextPathFor(sessionId) {
    if (!isSessionUuid(sessionId)) return null;
    return join(CONTEXTS_DIR, `${sessionId}.md`);
}

export function parseFrontmatter(content) {
    const meta = {};
    if (!content.startsWith('---')) return { meta, body: content };
    const end = content.indexOf('\n---', 3);
    if (end === -1) return { meta, body: content };
    const fm = content.slice(4, end);
    for (const line of fm.split('\n')) {
        const m = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
        if (!m) continue;
        const [, key, raw] = m;
        meta[key] = key === 'tags'
            ? raw.replace(/^\[|\]$/g, '').split(',').map((t) => t.trim()).filter(Boolean)
            : raw.trim();
    }
    const body = content.slice(end + 4).replace(/^\n/, '');
    return { meta, body };
}

export function goalOf(body) {
    const m = body.match(/^##\s*Goal[ \t]*\n+([\s\S]*?)(?=\n#{1,6}[ \t]|\n#{1,6}\n|$(?![\s\S]))/m);
    if (!m) return null;
    const goal = m[1].trim().replace(/\s+/g, ' ');
    return goal && !goal.startsWith('#') ? goal : null;
}

export async function readContext(sessionId) {
    const path = contextPathFor(sessionId);
    if (!path) return null;
    try {
        const content = await readFile(path, 'utf8');
        const { meta, body } = parseFrontmatter(content);
        return { path, content, meta, body, goal: goalOf(body) };
    } catch {
        return null;
    }
}

async function writeAtomic(path, content) {
    const tmp = `${path}.tmp-${process.pid}`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, path);
}

export async function writeContext(sessionId, content) {
    const path = contextPathFor(sessionId);
    if (!path) throw new Error(`invalid session id: ${sessionId}`);
    await mkdir(CONTEXTS_DIR, { recursive: true });
    await writeAtomic(path, content);
    return path;
}

export async function loadIndex() {
    try {
        const raw = await readFile(INDEX_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

// Set of session ids that have a curated context.md on disk.
export async function listContextSessions() {
    const set = new Set();
    let files = [];
    try {
        files = await readdir(CONTEXTS_DIR);
    } catch {
        return set;
    }
    for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const id = basename(file, '.md');
        if (isSessionUuid(id)) set.add(id);
    }
    return set;
}

// Atomic write of the (rich, transcript-derived) session index. The actual
// builder lives in lib/sessionIndex.mjs — kept there to avoid an import cycle
// (sessionIndex needs scan.mjs; contextStore must stay dependency-light).
export async function writeIndexFile(entries) {
    await mkdir(CONTEXTS_DIR, { recursive: true });
    await writeAtomic(INDEX_PATH, JSON.stringify(entries, null, 1));
    return entries;
}

export async function readSessionState(sessionId) {
    if (!isSessionUuid(sessionId)) return {};
    try {
        const raw = await readFile(join(STATE_DIR, `${sessionId}.json`), 'utf8');
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

export async function writeSessionState(sessionId, state) {
    if (!isSessionUuid(sessionId)) return;
    await mkdir(STATE_DIR, { recursive: true });
    await writeAtomic(join(STATE_DIR, `${sessionId}.json`), JSON.stringify(state));
}

// Exclusive (O_EXCL) lock so PreCompact + Stop firing together can't run two
// generators for the same session. The generator owns the lifecycle (acquire at
// start, release in finally); a stale lock from a crashed generator is evicted
// after ttlMs.
export async function acquireGenLock(sessionId, ttlMs = 4 * 60 * 1000) {
    if (!isSessionUuid(sessionId)) return null;
    const lock = join(STATE_DIR, `${sessionId}.inflight`);
    await mkdir(STATE_DIR, { recursive: true });
    try {
        const fh = await open(lock, 'wx');
        await fh.writeFile(String(Date.now()));
        await fh.close();
        return lock;
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        try {
            const st = await stat(lock);
            if (Date.now() - st.mtimeMs > ttlMs) {
                await rm(lock, { force: true });
                return acquireGenLock(sessionId, ttlMs);
            }
        } catch {
            // lock vanished between open and stat — let the caller retry naturally
        }
        return null;
    }
}

export async function releaseGenLock(lock) {
    if (!lock) return;
    try {
        await rm(lock, { force: true });
    } catch {
        // best-effort
    }
}

export { CONTEXTS_DIR, INDEX_PATH, STATE_DIR };
