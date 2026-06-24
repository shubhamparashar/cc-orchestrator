import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isLinux } from './platform.mjs';

// Claude Desktop's per-session metadata dir. macOS keeps it under Application
// Support; the Linux path is the XDG-conventional ~/.config/Claude — UNVERIFIED
// (can't confirm Desktop's Linux layout from a Mac). The join is fail-open: an
// absent dir just means no Desktop titles/PR-state, and CLI sessions still work.
const DESKTOP_SESSIONS_DIR = isLinux
    ? join(homedir(), '.config', 'Claude', 'claude-code-sessions')
    : join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');

function toBool(v) {
    return v === true || v === 'True' || v === 'true';
}

// Best-effort, read-only join table: cliSessionId -> Desktop metadata.
// Desktop stores one local_<uuid>.json per session under <org>/<user>/.
export async function desktopSessions() {
    const map = new Map();
    let level1;
    try {
        level1 = await readdir(DESKTOP_SESSIONS_DIR);
    } catch {
        return map;
    }
    for (const org of level1) {
        let level2;
        try {
            level2 = await readdir(join(DESKTOP_SESSIONS_DIR, org));
        } catch {
            continue;
        }
        for (const user of level2) {
            let files;
            try {
                files = await readdir(join(DESKTOP_SESSIONS_DIR, org, user));
            } catch {
                continue;
            }
            for (const file of files) {
                if (!file.startsWith('local_') || !file.endsWith('.json')) continue;
                try {
                    const raw = await readFile(join(DESKTOP_SESSIONS_DIR, org, user, file), 'utf8');
                    const d = JSON.parse(raw);
                    if (!d.cliSessionId) continue;
                    map.set(d.cliSessionId, {
                        title: d.title || null,
                        cwd: d.cwd || null,
                        model: d.model || null,
                        effort: d.effort || null,
                        permissionMode: d.permissionMode || null,
                        isArchived: toBool(d.isArchived),
                        prNumber: d.prNumber ? Number(d.prNumber) : null,
                        prState: d.prState || null,
                        lastActivityAt: d.lastActivityAt ? Number(d.lastActivityAt) : null,
                    });
                } catch {
                    // best-effort: skip unreadable entries
                }
            }
        }
    }
    return map;
}

export { DESKTOP_SESSIONS_DIR };
