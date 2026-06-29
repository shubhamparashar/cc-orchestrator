import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';

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
//
// A live session either RESUMES an existing session (by its claude UUID) or starts
// a NEW one in a chosen working directory, optionally primed with a first prompt.
// Either way the registry key is a freshly generated `liveId` — a new session has
// no claude UUID until claude creates one, so the resumed id (if any) is tracked
// separately and the liveId is the stable handle for stop / stream / reconnect.

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

// Validate a client-supplied working directory for a new live session: it must be
// an absolute path, free of `..` traversal segments, that resolves to an existing
// directory. The cwd is passed as the spawn() cwd option (not a shell token), so
// this is about refusing bogus/relative/non-existent dirs, not shell-escaping.
export function isLiveCwd(p) {
    if (typeof p !== 'string' || !p) return false;
    if (!isAbsolute(p)) return false;
    if (p.split('/').includes('..')) return false;
    try {
        return statSync(p).isDirectory();
    } catch {
        return false;
    }
}

// The claude args for a live session: resume an existing session or start fresh,
// at the chosen access level, optionally primed with an initial prompt (new
// sessions). Order is `[--resume <id>] <flags> [prompt]`.
export function buildClaudeArgs({ resumeId = null, flags = [], prompt = null }) {
    const args = [];
    if (resumeId) args.push('--resume', resumeId);
    args.push(...flags);
    if (prompt) args.push(prompt);
    return args;
}

// Build the `script` PTY invocation per platform. macOS (BSD script) takes the
// command as argv items after the typescript file — no shell, nothing to quote.
// Linux (util-linux script) takes a single `-c` string, so the command is shell-
// quoted (resumeId is UUID-validated and flags are static literals upstream; the
// prompt is arbitrary user text, made inert by shq here / by separate argv on macOS).
export function buildScriptSpawn({ claudeBin, claudeArgs, mac = isMac }) {
    if (mac) {
        return { cmd: 'script', args: ['-q', '/dev/null', claudeBin, ...claudeArgs] };
    }
    const inner = [claudeBin, ...claudeArgs].map(shq).join(' ');
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
        liveId: e.liveId,
        sessionId: e.sessionId,
        isNew: e.sessionId === null,
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

export function getLive(liveId) {
    const e = live.get(liveId);
    return e ? serialize(e) : null;
}

// Recent output for scrollback (a reconnecting viewer replays this).
export function liveBuffer(liveId) {
    const e = live.get(liveId);
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

// Start a persistent live session. Pass `sessionId` to RESUME an existing session,
// or omit it (with `cwd`, optional `prompt`) to start a NEW one. Returns the
// serialized entry (incl. the generated `liveId`) or { error } on rejection.
// `spawnFn` is injectable so tests exercise the registry/stream/stop/exit lifecycle
// with a stand-in instead of a real agent.
export function startLive({ sessionId = null, cwd, level, prompt = null }, { onData, onExit, spawnFn = spawn } = {}) {
    prune();
    // One live session per resumed id — a second resume of the same session would
    // fork confusingly. New sessions (no sessionId) have no such constraint.
    if (sessionId) {
        for (const e of live.values()) {
            if (e.status === 'running' && e.sessionId === sessionId) {
                return { error: 'a live session is already running for this id' };
            }
        }
    }
    const flags = accessFlags(level);
    if (!flags) return { error: 'invalid access level' };
    if (runningCount() >= MAX_LIVE) return { error: 'too many live sessions running' };

    const dir = cwd || homedir();
    const liveId = randomUUID();
    const claudeArgs = buildClaudeArgs({ resumeId: sessionId, flags, prompt });
    const { cmd, args } = buildScriptSpawn({ claudeBin: CLAUDE_BIN, claudeArgs });
    const child = spawnFn(cmd, args, {
        cwd: dir,
        env: { ...process.env, CLAUDE_NO_RC: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
    });

    const entry = {
        liveId,
        sessionId: sessionId || null,
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
    live.set(liveId, entry);

    const onChunk = (d) => {
        const text = stripAnsi(d.toString('utf8'));
        if (!text) return;
        entry.buf.push(text);
        onData?.(liveId, text);
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (err) => {
        entry.exited = true;
        if (entry.status === 'running') entry.status = 'error';
        entry.error = err.message;
        entry.endedAt = Date.now();
        onExit?.(liveId, serialize(entry));
    });
    child.on('close', (code) => {
        entry.exited = true;
        if (entry.status !== 'stopped') {
            entry.status = code === 0 ? 'exited' : 'error';
            entry.exitCode = code;
            entry.endedAt = Date.now();
        }
        onExit?.(liveId, serialize(entry));
    });

    return serialize(entry);
}

export function stopLive(liveId) {
    const e = live.get(liveId);
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
