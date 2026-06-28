import { spawn } from 'node:child_process';
import { accessSync, constants as FS } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isLinux, isMac } from './platform.mjs';

// The real binary, not the shim — orchestrator-spawned jobs are headless (-p),
// so --remote-control injection would be wrong for them anyway.
const CLAUDE_BIN = process.env.CLAUDE_ORIG_BIN || join(homedir(), '.claude', 'local', 'claude');

const jobs = new Map();
let nextJobId = 1;

const FINISHED_STATUSES = new Set(['done', 'error', 'stopped']);
const JOB_RETENTION_MS = 10 * 60 * 1000;

// Drop finished jobs older than the retention window so the in-memory store
// (and what /api/jobs serves on every reload) doesn't grow without bound.
function pruneJobs() {
    const cutoff = Date.now() - JOB_RETENTION_MS;
    for (const [id, job] of jobs) {
        if (FINISHED_STATUSES.has(job.status) && (job.endedAt ?? 0) < cutoff) jobs.delete(id);
    }
}

export function listJobs() {
    pruneJobs();
    return [...jobs.values()].map(({ child, ...rest }) => rest);
}

export function dismissJob(id) {
    return jobs.delete(id);
}

export function stopJob(id) {
    const job = jobs.get(id);
    if (!job || job.status !== 'running') return false;
    job.child.kill('SIGTERM');
    job.status = 'stopped';
    job.endedAt = Date.now();
    return true;
}

// Steer a session headlessly: `claude -p --resume <id> "<text>"`.
// If the target session is concurrently open in an interactive TTY, the CLI
// forks to a new session id — we surface the returned id so that is visible.
export function sendPrompt({ sessionId, cwd, text, fork = false }, onUpdate) {
    const args = ['-p', '--resume', sessionId];
    if (fork) args.push('--fork-session');
    args.push('--output-format', 'json', text);

    const child = spawn(CLAUDE_BIN, args, {
        cwd: cwd || homedir(),
        env: { ...process.env, CLAUDE_NO_RC: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const id = nextJobId++;
    const job = {
        id,
        sessionId,
        fork,
        text: text.length > 200 ? `${text.slice(0, 200)}…` : text,
        status: 'running',
        startedAt: Date.now(),
        endedAt: null,
        pid: child.pid,
        result: null,
        error: null,
        child,
    };
    jobs.set(id, job);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
        job.status = 'error';
        job.error = err.message;
        job.endedAt = Date.now();
        onUpdate?.(job);
    });
    child.on('close', (code) => {
        if (job.status === 'stopped') return onUpdate?.(job);
        job.endedAt = Date.now();
        if (code === 0) {
            job.status = 'done';
            try {
                const parsed = JSON.parse(stdout);
                job.result = {
                    sessionId: parsed.session_id || null,
                    forked: Boolean(parsed.session_id && parsed.session_id !== sessionId),
                    text: typeof parsed.result === 'string' ? parsed.result.slice(0, 2000) : null,
                    costUsd: parsed.total_cost_usd ?? null,
                    numTurns: parsed.num_turns ?? null,
                };
            } catch {
                job.result = { text: stdout.slice(0, 2000) };
            }
        } else {
            job.status = 'error';
            job.error = (stderr || stdout || `exit code ${code}`).slice(0, 2000);
        }
        onUpdate?.(job);
    });

    return { id, pid: child.pid };
}

function shq(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Open a shell command in a new Terminal.app window via AppleScript. The command
// is passed as an argv value (item 1 of argv), NOT interpolated into the script
// source — so newlines/quotes/$() in it are inert data, never parsed as
// AppleScript. Interpolating it would allow a newline to break out of the
// `do script "…"` literal and execute attacker AppleScript.
function runInTerminalMac(shellCmd) {
    const script = [
        'on run argv',
        '  tell application "Terminal"',
        '    activate',
        '    do script (item 1 of argv)',
        '  end tell',
        'end run',
    ].join('\n');
    return new Promise((resolve) => {
        const child = spawn('osascript', ['-e', script, '--', shellCmd], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (code) => {
            resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `osascript exit ${code}` });
        });
        child.on('error', (err) => resolve({ ok: false, error: err.message }));
    });
}

function onPath(bin) {
    for (const dir of (process.env.PATH || '').split(':')) {
        if (!dir) continue;
        try { accessSync(join(dir, bin), FS.X_OK); return true; } catch { /* keep looking */ }
    }
    return false;
}

// Linux: open the command in the first available terminal emulator. The command
// runs via `bash -lc <cmd>` passed as a distinct argv (not interpolated), and
// `exec bash` keeps the window open after the session. shq() already escapes the
// values inside shellCmd, exactly as on macOS.
const LINUX_TERMINALS = [
    { bin: 'x-terminal-emulator', args: (s) => ['-e', 'bash', '-lc', s] },
    { bin: 'gnome-terminal', args: (s) => ['--', 'bash', '-lc', s] },
    { bin: 'konsole', args: (s) => ['-e', 'bash', '-lc', s] },
    { bin: 'xterm', args: (s) => ['-e', 'bash', '-lc', s] },
];

function runInTerminalLinux(shellCmd) {
    const term = LINUX_TERMINALS.find((t) => onPath(t.bin));
    if (!term) {
        return Promise.resolve({ ok: false, error: 'no terminal emulator found (install x-terminal-emulator / gnome-terminal, or copy the command)' });
    }
    return new Promise((resolve) => {
        const child = spawn(term.bin, term.args(`${shellCmd}; exec bash`), { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        // A terminal emulator typically forks and exits 0 immediately; treat a
        // clean spawn as success and surface only a spawn error.
        child.on('error', (err) => resolve({ ok: false, error: err.message }));
        child.unref();
        setTimeout(() => resolve({ ok: true }), 150);
    });
}

export function runInTerminal(shellCmd) {
    if (isMac) return runInTerminalMac(shellCmd);
    if (isLinux) return runInTerminalLinux(shellCmd);
    return Promise.resolve({ ok: false, error: `terminal attach unsupported on ${process.platform}` });
}

export async function attachInTerminal({ sessionId, cwd, fork = false, skipPermissions = false }) {
    const forkFlag = fork ? ' --fork-session' : '';
    const skipFlag = skipPermissions ? ' --dangerously-skip-permissions' : '';
    const shellCmd = `cd ${shq(cwd || homedir())} && ${shq(CLAUDE_BIN)} --resume ${shq(sessionId)}${forkFlag}${skipFlag}`;
    return runInTerminal(shellCmd);
}

export function attachCommand({ sessionId, cwd, fork = false, skipPermissions = false }) {
    const forkFlag = fork ? ' --fork-session' : '';
    const skipFlag = skipPermissions ? ' --dangerously-skip-permissions' : '';
    return `cd ${cwd || '~'} && claude --resume ${sessionId}${forkFlag}${skipFlag}`;
}

// New interactive session, optionally primed with a context file. The new
// session READS the context file itself — quoting-safe and far cheaper than
// inlining transcript text into the prompt.
export function buildLaunchCommand({ prompt, cwd, contextPath = null }) {
    const fullPrompt = contextPath
        ? `Read ${contextPath} for prior context, then: ${prompt}`
        : prompt;
    return `cd ${shq(cwd || homedir())} && ${shq(CLAUDE_BIN)} ${shq(fullPrompt)}`;
}

export async function launchInTerminal(opts) {
    const command = buildLaunchCommand(opts);
    const result = await runInTerminal(command);
    result.command = command;
    return result;
}

export { CLAUDE_BIN };
