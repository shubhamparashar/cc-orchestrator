import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Build/version stamp — the fix for the silent-staleness gap. The always-on
// process (LaunchAgent :7433 / systemd) serves public/index.html FRESH from disk
// on every request, but its HTTP route table is frozen at process start. After a
// pull/merge that adds endpoints, the running process keeps serving the new UI
// while 404-ing the new /api/* routes it calls — until someone restarts it.
//
// We detect that entirely server-side: capture the commit the process loaded from
// (`boot`, frozen at module load) and compare it to the commit on disk NOW
// (`head`, read fresh). They diverge exactly when code was updated under a live
// process. No version needs to be baked into the static HTML, so there's still no
// build step — the frontend just reads the `stale` flag.

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Resolve the repo's current commit (full SHA) with cwd pinned to the repo root —
// the always-on service may be started from / or ~, not the checkout. Returns null
// when this isn't a git checkout or git isn't installed (an npm/tarball install):
// callers treat an unknown SHA as "can't be stale", never a false alarm.
function gitHead() {
    try {
        const out = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return out || null;
    } catch {
        return null;
    }
}

function appVersion() {
    try {
        return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version || 'unknown';
    } catch {
        return 'unknown';
    }
}

// Frozen at process start: the commit the running code was loaded from.
const BOOT_SHA = gitHead();
const BOOT_MS = Date.now();
const APP = appVersion();

// The disk HEAD can only change via an external git op (pull/merge/checkout), so a
// short cache keeps a polling dashboard from spawning git on every tick.
const HEAD_TTL_MS = 3000;
let headCache = { sha: BOOT_SHA, at: BOOT_MS };
function currentHead(now) {
    if (now - headCache.at < HEAD_TTL_MS) return headCache.sha;
    headCache = { sha: gitHead(), at: now };
    return headCache.sha;
}

const short = (sha) => (sha ? sha.slice(0, 7) : null);

// Pure so every platform branch is unit-testable (process.platform is fixed per
// run). platform.mjs owns the isMac/isLinux *gating* booleans; this is a string
// map keyed by the same platform values, kept here next to its only caller.
export function restartCommandFor(platform) {
    if (platform === 'darwin') return 'launchctl kickstart -k gui/$(id -u)/com.cc-orchestrator';
    if (platform === 'linux') return 'systemctl --user restart cc-orchestrator.service';
    return 'restart the cc-orchestrator service';
}

export function restartCommand() {
    return restartCommandFor(process.platform);
}

// Stale only when BOTH commits are known and differ. Unknown (non-git / no git)
// ⇒ false, so we never nag an install we can't reason about.
export function computeStale(boot, head) {
    return Boolean(boot && head && boot !== head);
}

export function versionInfo(now = Date.now()) {
    const head = currentHead(now);
    return {
        app: APP,
        boot: short(BOOT_SHA),
        head: short(head),
        stale: computeStale(BOOT_SHA, head),
        startedAt: BOOT_MS,
        uptimeSec: Math.max(0, Math.round((now - BOOT_MS) / 1000)),
        restart: restartCommand(),
    };
}
