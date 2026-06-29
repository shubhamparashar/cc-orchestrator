import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

import { isMac } from './platform.mjs';
import { CLAUDE_BIN, shq } from './actions.mjs';
import { RingBuffer } from './ringBuffer.mjs';
import { stripAnsi } from './ansi.mjs';

// A persistent, interactive `claude` process the user starts and watches from the
// dashboard. Unlike the headless `-p` job runner (lib/actions.mjs), this stays
// alive in the orchestrator independent of any phone/SSE connection, streams its
// output live, and can be stopped. It is its OWN control plane — it does NOT use
// the claude.ai `--remote-control` channel or the shim; it spawns the real binary
// under a PTY and drives it directly.

// Interactive claude needs a TTY. We allocate one with the OS `script` command
// rather than a native pty dependency. The child's stdin is /dev/null here
// (output-only); BSD `script` tolerates that (a Node socketpair stdin would fail
// its tcgetattr). Driving stdin is a later phase.
const OUTPUT_BYTES = 256 * 1024;
const MAX_LIVE = 6;
const FINISHED = new Set(['exited', 'stopped', 'error']);
const RETENTION_MS = 10 * 60 * 1000;

// Access level → STATIC permission flag tokens. The mapping is the security
// boundary: the client picks a level NAME, never a flag. An unknown level resolves
// to null (rejected) so no client string is ever spliced into the spawned argv.
const ACCESS_FLAGS = Object.freeze({
    ask: Object.freeze(['--permission-mode', 'default']),
    acceptEdits: Object.freeze(['--permission-mode', 'acceptEdits']),
    plan: Object.freeze(['--permission-mode', 'plan']),
    full: Object.freeze(['--dangerously-skip-permissions']),
});

export const ACCESS_LEVELS = Object.keys(ACCESS_FLAGS);

export function accessFlags(level) {
    if (typeof level !== 'string') return null;
    if (!Object.prototype.hasOwnProperty.call(ACCESS_FLAGS, level)) return null;
    return [...ACCESS_FLAGS[level]];
}

// Build the `script` PTY invocation per platform. macOS (BSD script) takes the
// command as argv items after the typescript file — no shell, nothing to quote.
// Linux (util-linux script) takes a single `-c` string, so the command is shell-
// quoted (sessionId is UUID-validated upstream; flags are static literals).
export function buildScriptSpawn({ claudeBin, sessionId, flags, mac = isMac }) {
    const cmdArgs = ['--resume', sessionId, ...flags];
    if (mac) {
        return { cmd: 'script', args: ['-q', '/dev/null', claudeBin, ...cmdArgs] };
    }
    const inner = [claudeBin, ...cmdArgs].map(shq).join(' ');
    return { cmd: 'script', args: ['-qfc', inner, '/dev/null'] };
}

const live = new Map();

function prune() {
    const cutoff = Date.now() - RETENTION_MS;
    for (const [id, e] of live) {
        if (FINISHED.has(e.status) && (e.endedAt ?? 0) < cutoff) live.delete(id);
    }
}

function serialize(e) {
    return {
        sessionId: e.sessionId,
        cwd: e.cwd,
        level: e.level,
        status: e.status,
        startedAt: e.startedAt,
        endedAt: e.endedAt,
        pid: e.pid,
        exitCode: e.exitCode,
    };
}

export function listLive() {
    prune();
    return [...live.values()].map(serialize);
}

export function getLive(sessionId) {
    const e = live.get(sessionId);
    return e ? serialize(e) : null;
}

// Recent output for scrollback (a reconnecting viewer replays this).
export function liveBuffer(sessionId) {
    const e = live.get(sessionId);
    return e ? e.buf.text() : null;
}

export function runningCount() {
    let n = 0;
    for (const e of live.values()) if (e.status === 'running') n++;
    return n;
}

// Kill the whole PTY pipeline. `script` runs in its own process group (detached),
// so signal the group; fall back to the direct child if the group is already gone.
function killGroup(child, signal = 'SIGTERM') {
    if (!child || typeof child.pid !== 'number') return;
    try {
        process.kill(-child.pid, signal);
    } catch {
        try { child.kill(signal); } catch { /* already dead */ }
    }
}

// Start a persistent live session resuming `sessionId`. `spawnFn` is injectable so
// tests can exercise the registry/stream/stop/exit lifecycle with a stand-in
// instead of launching a real agent. Returns { error } on a rejected request.
export function startLive({ sessionId, cwd, level }, { onData, onExit, spawnFn = spawn } = {}) {
    prune();
    const existing = live.get(sessionId);
    if (existing && existing.status === 'running') {
        return { error: 'a live session is already running for this id' };
    }
    const flags = accessFlags(level);
    if (!flags) return { error: 'invalid access level' };
    if (runningCount() >= MAX_LIVE) return { error: 'too many live sessions running' };

    const dir = cwd || homedir();
    const { cmd, args } = buildScriptSpawn({ claudeBin: CLAUDE_BIN, sessionId, flags });
    const child = spawnFn(cmd, args, {
        cwd: dir,
        env: { ...process.env, CLAUDE_NO_RC: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
    });

    const entry = {
        sessionId,
        cwd: dir,
        level,
        status: 'running',
        startedAt: Date.now(),
        endedAt: null,
        pid: child.pid,
        exitCode: null,
        exited: false,
        buf: new RingBuffer(OUTPUT_BYTES),
        child,
    };
    live.set(sessionId, entry);

    const onChunk = (d) => {
        const text = stripAnsi(d.toString('utf8'));
        if (!text) return;
        entry.buf.push(text);
        onData?.(sessionId, text);
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (err) => {
        entry.exited = true;
        if (entry.status === 'running') entry.status = 'error';
        entry.error = err.message;
        entry.endedAt = Date.now();
        onExit?.(sessionId, serialize(entry));
    });
    child.on('close', (code) => {
        entry.exited = true;
        if (entry.status !== 'stopped') {
            entry.status = code === 0 ? 'exited' : 'error';
            entry.exitCode = code;
            entry.endedAt = Date.now();
        }
        onExit?.(sessionId, serialize(entry));
    });

    return serialize(entry);
}

export function stopLive(sessionId) {
    const e = live.get(sessionId);
    if (!e || e.status !== 'running') return false;
    e.status = 'stopped';
    e.endedAt = Date.now();
    killGroup(e.child);
    return true;
}

// Graceful teardown of every running session — SIGTERM each detached group so a
// LaunchAgent restart doesn't orphan agents (notably Full ones). The groups
// survive our own exit, so the caller must let SIGTERM land (then escalate via
// hardKillAllLive) rather than exiting in the same tick.
export function stopAllLive() {
    for (const e of live.values()) {
        if (e.status === 'running') {
            e.status = 'stopped';
            e.endedAt = Date.now();
            killGroup(e.child, 'SIGTERM');
        }
    }
}

// Escalation for shutdown: SIGKILL any group that hasn't reported exit yet, and
// return how many were force-killed. Only targets children still alive (the
// `exited` flag is set by the close/error handler), so a since-reused pid is
// never signalled. Use after stopAllLive + a short grace window.
export function hardKillAllLive() {
    let forced = 0;
    for (const e of live.values()) {
        if (!e.exited && e.child) {
            killGroup(e.child, 'SIGKILL');
            forced++;
        }
    }
    return forced;
}

// Test-only: drop all registry state between cases.
export function _resetLive() {
    live.clear();
}
