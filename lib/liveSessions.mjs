import { spawn, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';

import { isMac } from './platform.mjs';
import { CLAUDE_BIN, shq } from './actions.mjs';
import { RingBuffer } from './ringBuffer.mjs';
import { AnsiStreamStripper } from './ansi.mjs';

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
const STOP_KILL_GRACE_MS = 3000;

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
        // Never evict an entry whose process hasn't confirmed exit: dropping it
        // would lose the only child reference stop/shutdown escalation can
        // signal, permanently orphaning a still-running group.
        if (!e.exited) continue;
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

// `script` setsid()s the agent it launches, so the agent lives in its OWN
// session/process group — a signal to script's group never reaches it (only the
// pty-close SIGHUP does, which a misbehaving agent can ignore). Resolve the
// agent's pid (script's direct child) while script is still alive and remember
// it on the entry so escalation can signal that group too. Best-effort: if
// discovery fails, script's group still gets the signal.
function agentPidOf(e) {
    if (typeof e.agentPid === 'number') return e.agentPid;
    if (e.exited || typeof e.pid !== 'number') return null;
    try {
        const out = execFileSync('pgrep', ['-P', String(e.pid)], { timeout: 1000 }).toString();
        const pid = Number.parseInt(out.trim(), 10);
        if (Number.isInteger(pid) && pid > 1) e.agentPid = pid;
    } catch {
        // no child yet / pgrep unavailable
    }
    return e.agentPid ?? null;
}

// Signal every group the live session owns: script's own group plus the agent's
// setsid'd group. The agent group is only signalled while `exited` is false —
// while script (the agent's parent) is alive the agent's pid cannot have been
// reaped and reused, so a stale pid is never signalled.
function killEntryGroups(e, signal = 'SIGTERM') {
    const agentPid = e.exited ? null : agentPidOf(e);
    killGroup(e.child, signal);
    if (agentPid != null && !e.exited) {
        try { process.kill(-agentPid, signal); } catch { /* group already gone */ }
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
    // fork confusingly. A stopped-but-not-yet-exited entry still holds the PTY,
    // so it counts too. New sessions (no sessionId) have no such constraint.
    if (sessionId) {
        for (const e of live.values()) {
            if (e.sessionId !== sessionId) continue;
            if (e.status === 'running' || !e.exited) {
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
        agentPid: null,
        buf: new RingBuffer(OUTPUT_BYTES),
        child,
    };
    live.set(liveId, entry);

    // Per-entry stateful decode + strip: pipe reads split output at arbitrary
    // byte boundaries, so both the UTF-8 decode and the escape-sequence stripping
    // must carry partial state from one chunk to the next.
    const stripper = new AnsiStreamStripper();
    const decoder = new TextDecoder('utf-8');
    const onChunk = (d) => {
        const text = stripper.push(typeof d === 'string' ? d : decoder.decode(d, { stream: true }));
        if (!text) return;
        entry.buf.push(text);
        onData?.(liveId, text);
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    // Node emits BOTH 'error' and 'close' when the spawn itself fails, so each
    // handler checks whether the other already announced the exit — onExit (the
    // SSE 'live-exit' event + the audit end-line) must fire exactly once.
    child.on('error', (err) => {
        const announced = entry.exited;
        entry.exited = true;
        if (entry.status === 'running') entry.status = 'error';
        entry.error = err.message;
        entry.endedAt = Date.now();
        if (!announced) onExit?.(liveId, serialize(entry));
    });
    child.on('close', (code) => {
        const tail = stripper.push(decoder.decode()) + stripper.flush();
        if (tail) {
            entry.buf.push(tail);
            onData?.(liveId, tail);
        }
        const announced = entry.exited;
        entry.exited = true;
        if (entry.status !== 'stopped') {
            entry.status = code === 0 ? 'exited' : 'error';
            entry.exitCode = code;
            entry.endedAt = Date.now();
        }
        if (!announced) onExit?.(liveId, serialize(entry));
    });

    return serialize(entry);
}

export function stopLive(liveId, graceMs = STOP_KILL_GRACE_MS) {
    const e = live.get(liveId);
    if (!e || e.status !== 'running') return false;
    e.status = 'stopped';
    e.endedAt = Date.now();
    killEntryGroups(e, 'SIGTERM');
    // A SIGTERM-resistant group must not outlive the Stop: escalate to SIGKILL
    // after a grace period unless the close/error handler confirmed exit (the
    // `exited` flag also keeps a since-reused pid from being signalled).
    setTimeout(() => {
        if (!e.exited) killEntryGroups(e, 'SIGKILL');
    }, graceMs).unref();
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
            killEntryGroups(e, 'SIGTERM');
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
            killEntryGroups(e, 'SIGKILL');
            forced++;
        }
    }
    return forced;
}

// Test-only: drop all registry state between cases.
export function _resetLive() {
    live.clear();
}

// Test-only: raw registry entries, for lifecycle/prune coverage.
export function _liveEntries() {
    return [...live.values()];
}
