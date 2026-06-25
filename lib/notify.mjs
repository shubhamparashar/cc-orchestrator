import { spawn } from 'node:child_process';

import { isLinux, isMac } from './platform.mjs';
import { log } from './logger.mjs';

// Display title/message via an AppleScript that reads them from argv — they are
// items of `argv`, NOT interpolated into the script source. Session-derived text
// (titles, last messages) is therefore inert data: a newline or quote in it can't
// break out of a string literal and execute attacker AppleScript. Mirrors the
// osascript pattern in lib/actions.mjs.
function notifyMac({ title, message }) {
    const script = [
        'on run argv',
        '  display notification (item 1 of argv) with title (item 2 of argv)',
        'end run',
    ].join('\n');
    return new Promise((resolve) => {
        const child = spawn('osascript', ['-e', script, '--', message, title], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (code) => {
            resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `osascript exit ${code}` });
        });
        child.on('error', (err) => resolve({ ok: false, error: err.message }));
    });
}

// notify-send takes title and message as distinct argv values, so the same
// no-interpolation safety holds: the strings are never parsed by a shell.
function notifyLinux({ title, message }) {
    return new Promise((resolve) => {
        const child = spawn('notify-send', [title, message], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (code) => {
            resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `notify-send exit ${code}` });
        });
        child.on('error', (err) => resolve({ ok: false, error: err.message }));
    });
}

export async function osNotify(notification) {
    // Coerce to strings up front: spawn argv entries must be strings, so a caller
    // passing a non-string (or undefined) title/message would otherwise throw
    // inside spawn. The arguments are still passed as argv, never interpolated.
    const title = String(notification?.title ?? '');
    const message = String(notification?.message ?? '');
    // Dry-run: never spawn a real notifier (so tests/verification don't pop OS
    // banners) — just record what would have fired.
    if (process.env.CC_ALERT_DRYRUN === '1') {
        log.info(`[alert dry-run] ${title} — ${message}`);
        return { ok: true, dryRun: true };
    }
    if (isMac) return notifyMac({ title, message });
    if (isLinux) return notifyLinux({ title, message });
    // Headless / unknown platform: no notifier to call.
    return { ok: false, skipped: true };
}
