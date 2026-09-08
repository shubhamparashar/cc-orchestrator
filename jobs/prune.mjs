// Reaps orchestrator state that's outlived its session: context .md + .state
// json + canvas dir for sessions whose transcript is gone or whose newest
// artifact is older than N days, plus orphan index-<port>.json files left by
// dead throwaway servers. Then rebuilds index.json via the same path
// jobs/rebuild-index.mjs uses, so it never references a removed session.
import { readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { PROJECTS_DIR } from '../lib/scan.mjs';
import { CONTEXTS_DIR, STATE_DIR, isSessionUuid } from '../lib/contextStore.mjs';
import { buildSessionIndex } from '../lib/sessionIndex.mjs';

const CANVAS_DIR = join(CONTEXTS_DIR, 'canvas');
const ORPHAN_INDEX_RE = /^index-\d+\.json$/;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function listDir(dir) {
    try {
        return await readdir(dir);
    } catch {
        return [];
    }
}

// session id -> newest transcript mtime; a session's transcript is the
// authoritative liveness signal, its derived artifacts regenerate only occasionally
async function transcriptMtimes() {
    const mtimes = new Map();
    for (const projectDir of await listDir(PROJECTS_DIR)) {
        for (const file of await listDir(join(PROJECTS_DIR, projectDir))) {
            if (!file.endsWith('.jsonl')) continue;
            const id = basename(file, '.jsonl');
            if (!isSessionUuid(id)) continue;
            try {
                const { mtimeMs } = await stat(join(PROJECTS_DIR, projectDir, file));
                mtimes.set(id, Math.max(mtimes.get(id) ?? 0, mtimeMs));
            } catch {
                // vanished between listing and stat
            }
        }
    }
    return mtimes;
}

async function sessionArtifactIds() {
    const ids = new Set();
    for (const f of await listDir(CONTEXTS_DIR)) {
        if (f.endsWith('.md') && isSessionUuid(basename(f, '.md'))) ids.add(basename(f, '.md'));
    }
    for (const f of await listDir(STATE_DIR)) {
        if (f.endsWith('.json') && isSessionUuid(basename(f, '.json'))) ids.add(basename(f, '.json'));
    }
    for (const d of await listDir(CANVAS_DIR)) {
        if (isSessionUuid(d)) ids.add(d);
    }
    return ids;
}

async function dirSize(path) {
    let total = 0;
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
        const p = join(path, entry.name);
        if (entry.isDirectory()) total += await dirSize(p);
        else total += await stat(p).then((s) => s.size).catch(() => 0);
    }
    return total;
}

async function statedArtifacts(sessionId) {
    const candidates = [
        join(CONTEXTS_DIR, `${sessionId}.md`),
        join(STATE_DIR, `${sessionId}.json`),
        join(CANVAS_DIR, sessionId),
    ];
    const found = [];
    for (const path of candidates) {
        try {
            found.push({ path, st: await stat(path) });
        } catch {
            // not present for this session - fine
        }
    }
    return found;
}

export async function runPrune({ days = 30, dryRun = false } = {}) {
    const cutoff = Date.now() - days * ONE_DAY_MS;
    const transcripts = await transcriptMtimes();
    const candidates = await sessionArtifactIds();

    let filesRemoved = 0;
    let bytesFreed = 0;

    for (const sessionId of candidates) {
        const artifacts = await statedArtifacts(sessionId);
        if (!artifacts.length) continue;
        const transcriptMtime = transcripts.get(sessionId);
        const newest = Math.max(transcriptMtime ?? 0, ...artifacts.map((a) => a.st.mtimeMs));
        const stale = transcriptMtime === undefined || newest < cutoff;
        if (!stale) continue;
        for (const { path, st } of artifacts) {
            bytesFreed += st.isDirectory() ? await dirSize(path) : st.size;
            filesRemoved += 1;
            if (!dryRun) await rm(path, { recursive: true, force: true });
        }
    }

    const oneDayAgo = Date.now() - ONE_DAY_MS;
    for (const f of await listDir(CONTEXTS_DIR)) {
        if (!ORPHAN_INDEX_RE.test(f)) continue;
        const path = join(CONTEXTS_DIR, f);
        const st = await stat(path).catch(() => null);
        if (!st || st.mtimeMs >= oneDayAgo) continue;
        bytesFreed += st.size;
        filesRemoved += 1;
        if (!dryRun) await rm(path, { force: true });
    }

    if (!dryRun && filesRemoved > 0) await buildSessionIndex();

    const summary = `prune${dryRun ? ' (dry-run)' : ''}: ${filesRemoved} files removed, ${bytesFreed} bytes freed`;
    return { filesRemoved, bytesFreed, summary };
}

function argValue(flag) {
    const i = process.argv.indexOf(flag);
    return i !== -1 ? process.argv[i + 1] : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const days = Number(argValue('--days')) || 30;
    const dryRun = process.argv.includes('--dry-run');
    const { summary } = await runPrune({ days, dryRun });
    console.log(summary);
}
