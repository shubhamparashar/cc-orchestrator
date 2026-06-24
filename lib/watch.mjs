import { watch } from 'node:fs';

import { isLinux } from './platform.mjs';

// Recursive fs.watch is supported on macOS and Windows but throws
// ERR_FEATURE_UNAVAILABLE_ON_PLATFORM on Linux. Branch on that, not a probe
// (probing would create and leak a watcher).
export function recursiveWatchSupported() {
    return !isLinux;
}

export function watchSafe(path, opts, cb, onWarn) {
    try {
        return watch(path, opts, cb);
    } catch (err) {
        onWarn?.(`watch failed for ${path}: ${err.message}`);
        return null;
    }
}

// Drive live refresh across platforms.
//   macOS/Windows: recursive fs.watch on the project tree (which also tells us
//     WHICH transcript changed), plus the live-pid registry and Desktop dirs.
//   Linux (no recursive watch): a periodic tick calling scheduleRefresh, which
//     reuses the scanner's (size,mtime) cache so only changed files re-parse and
//     a no-op is cheap. The per-file "transcript changed" nudge is Mac-only; the
//     ~pollMs session-list refresh + the browser's own refetch cover Linux.
// Returns { mode: 'watch'|'poll', stop() }.
export function startLiveRefresh({
    projectsDir, sessionsDir, desktopDir,
    onProjectsChange, scheduleRefresh, onWarn, pollMs = 3000,
    recursiveSupported = recursiveWatchSupported(),
}) {
    if (recursiveSupported) {
        const watchers = [
            watchSafe(projectsDir, { recursive: true }, onProjectsChange, onWarn),
            watchSafe(sessionsDir, {}, scheduleRefresh, onWarn),
            desktopDir ? watchSafe(desktopDir, { recursive: true }, scheduleRefresh, onWarn) : null,
        ];
        return { mode: 'watch', stop() { for (const w of watchers) w?.close?.(); } };
    }
    const timer = setInterval(scheduleRefresh, pollMs);
    timer.unref?.();
    return { mode: 'poll', stop() { clearInterval(timer); } };
}
