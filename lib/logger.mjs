import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Size-rotated file log under ~/.config/cc-orchestrator/logs (override with
// CC_LOG_DIR). Also echoes to the console so a tty / the LaunchAgent's stdout
// redirect still sees everything. Logging must never throw — a failed write is
// swallowed rather than taking the server down.
const LOG_DIR = process.env.CC_LOG_DIR || join(homedir(), '.config', 'cc-orchestrator', 'logs');
const LOG_FILE = join(LOG_DIR, 'cc-orch.log');
const MAX_BYTES = 2 * 1024 * 1024;
const KEEP = 5;

export function logDir() { return LOG_DIR; }
export function logFile() { return LOG_FILE; }

// Rotate `file` → `file.1`, shifting older `.N` up to `.keep` and dropping the
// rest, once it grows past `maxBytes`. Pure I/O on the given path so it's testable
// against a temp dir. Returns true if it rotated.
export function rotate(file, { maxBytes = MAX_BYTES, keep = KEEP } = {}) {
    let size;
    try { size = statSync(file).size; } catch { return false; }
    if (size < maxBytes) return false;
    for (let i = keep - 1; i >= 1; i--) {
        if (existsSync(`${file}.${i}`)) {
            try { renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch { /* best-effort */ }
        }
    }
    try { renameSync(file, `${file}.1`); } catch { return false; }
    return true;
}

function consoleFor(level) {
    if (level === 'ERROR') return console.error;
    if (level === 'WARN') return console.warn;
    return console.log;
}

function write(level, msg) {
    consoleFor(level)(msg);
    try {
        mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
        rotate(LOG_FILE);
        // 0o600: the log may carry raw stacks/paths — keep it owner-only, like the token.
        appendFileSync(LOG_FILE, `${new Date().toISOString()} ${level} ${msg}\n`, { mode: 0o600 });
    } catch {
        // never let logging crash the server
    }
}

export const log = {
    info: (msg) => write('INFO', msg),
    warn: (msg) => write('WARN', msg),
    error: (msg) => write('ERROR', msg),
};
