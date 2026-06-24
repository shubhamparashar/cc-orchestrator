import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recursiveWatchSupported, startLiveRefresh } from '../lib/watch.mjs';
import { isLinux } from '../lib/platform.mjs';

test('recursiveWatchSupported reflects the platform (false on Linux)', () => {
    assert.equal(typeof recursiveWatchSupported(), 'boolean');
    assert.equal(recursiveWatchSupported(), !isLinux);
});

test('startLiveRefresh uses fs.watch when recursive is supported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-watch-'));
    try {
        const h = startLiveRefresh({
            projectsDir: dir, sessionsDir: dir, desktopDir: dir,
            onProjectsChange() {}, scheduleRefresh() {}, recursiveSupported: true,
        });
        assert.equal(h.mode, 'watch');
        h.stop(); // must not throw
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('startLiveRefresh falls back to polling scheduleRefresh when recursive is unsupported', async () => {
    let ticks = 0;
    const h = startLiveRefresh({
        projectsDir: '/x', sessionsDir: '/x', desktopDir: '/x',
        onProjectsChange() {}, scheduleRefresh() { ticks += 1; },
        recursiveSupported: false, pollMs: 20,
    });
    assert.equal(h.mode, 'poll');
    await new Promise((r) => setTimeout(r, 70));
    const afterStop = ticks;
    assert.ok(afterStop >= 2, `poll should have ticked (got ${afterStop})`);
    h.stop();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ticks, afterStop, 'stop() halts further polling');
});
