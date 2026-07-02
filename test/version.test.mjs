import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeStale, restartCommand, restartCommandFor, versionInfo } from '../lib/version.mjs';

test('computeStale: true only when both commits are known and differ', () => {
    assert.equal(computeStale('abc1234', 'def5678'), true, 'differing known SHAs → stale');
    assert.equal(computeStale('abc1234', 'abc1234'), false, 'same SHA → not stale');
    assert.equal(computeStale(null, 'def5678'), false, 'unknown boot → never stale');
    assert.equal(computeStale('abc1234', null), false, 'unknown head → never stale');
    assert.equal(computeStale(null, null), false, 'both unknown → never stale');
});

test('restartCommandFor: platform-appropriate always-on restart one-liner', () => {
    assert.match(restartCommandFor('darwin'), /launchctl kickstart -k gui\/\$\(id -u\)\/com\.cc-orchestrator/);
    assert.match(restartCommandFor('linux'), /systemctl --user restart cc-orchestrator\.service/);
    assert.match(restartCommandFor('win32'), /restart the cc-orchestrator service/);
    assert.equal(restartCommand(), restartCommandFor(process.platform), 'restartCommand() dispatches on process.platform');
});

test('versionInfo: shape, types, and not stale on a fresh boot', () => {
    const v = versionInfo();
    // keys present
    for (const k of ['app', 'boot', 'head', 'stale', 'startedAt', 'uptimeSec', 'restart']) {
        assert.ok(k in v, `has ${k}`);
    }
    assert.equal(typeof v.stale, 'boolean');
    assert.ok(typeof v.restart === 'string' && v.restart.length > 0);
    assert.ok(Number.isInteger(v.startedAt) && v.startedAt > 0);
    assert.ok(Number.isInteger(v.uptimeSec) && v.uptimeSec >= 0);
    // boot/head are either null (non-git install) or a 7-char short SHA
    for (const sha of [v.boot, v.head]) {
        assert.ok(sha === null || /^[0-9a-f]{7}$/.test(sha), `sha shape: ${sha}`);
    }
    // Just-booted: head is read from the same checkout the process loaded, so it
    // cannot have drifted yet.
    assert.equal(v.stale, false, 'a freshly booted process is never stale');
});

test('versionInfo: boot and head agree at boot (no self-inflicted staleness)', () => {
    const v = versionInfo();
    assert.equal(v.boot, v.head, 'boot commit equals disk commit immediately after start');
});
