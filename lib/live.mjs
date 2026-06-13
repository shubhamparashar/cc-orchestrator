import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');

function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

// Map sessionId -> {pid, cwd, entrypoint, kind, startedAt} for processes that are alive.
// Stale <pid>.json files (left behind after a crash) are filtered by the liveness check.
export async function liveSessions() {
    const map = new Map();
    let files;
    try {
        files = await readdir(SESSIONS_DIR);
    } catch {
        return map;
    }
    for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
            const raw = await readFile(join(SESSIONS_DIR, file), 'utf8');
            const d = JSON.parse(raw);
            if (!d.sessionId || !d.pid || !pidAlive(d.pid)) continue;
            map.set(d.sessionId, {
                pid: d.pid,
                cwd: d.cwd || null,
                entrypoint: typeof d.entrypoint === 'string' ? d.entrypoint : null,
                kind: d.kind || null,
                startedAt: d.startedAt || null,
            });
        } catch {
            // unreadable registry entry — ignore
        }
    }
    return map;
}

export { SESSIONS_DIR };
