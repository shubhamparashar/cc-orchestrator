import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    hookSpecs, mergeHooks, unmergeHooks, hooksStatus, readSettings, installHooks,
} from '../lib/onboarding.mjs';

const REPO = '/fake/repo';
const NODE = '/usr/bin/node';
const opts = { nodePath: NODE, repoRoot: REPO };

function tmpHome() {
    const home = mkdtempSync(join(tmpdir(), 'cc-onb-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    return home;
}

test('mergeHooks: empty settings → all 4 events with absolute commands + timeouts', () => {
    const { settings, changed, added } = mergeHooks({}, opts);
    assert.equal(changed, true);
    assert.deepEqual(added, ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact']);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, `"${NODE}" "${REPO}/hooks/session-start.mjs"`);
    assert.equal(settings.hooks.PreCompact[0].hooks[0].timeout, 15);
    assert.equal(settings.hooks.Stop[0].hooks[0].command, `"${NODE}" "${REPO}/hooks/ctx-update.mjs"`);
});

test('mergeHooks: preserves unrelated keys and foreign hooks on the same event', () => {
    const existing = {
        permissions: { allow: ['Bash'] },
        remoteControlAtStartup: true,
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/usr/bin/node /other/tool/start.mjs', timeout: 5 }] }] },
    };
    const { settings } = mergeHooks(existing, opts);
    assert.deepEqual(settings.permissions, { allow: ['Bash'] });
    assert.equal(settings.remoteControlAtStartup, true);
    // foreign SessionStart hook kept, ours appended (2 matchers now)
    assert.equal(settings.hooks.SessionStart.length, 2);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, '/usr/bin/node /other/tool/start.mjs');
    assert.ok(settings.hooks.SessionStart[1].hooks[0].command.includes('/fake/repo/hooks/session-start.mjs'));
});

test('mergeHooks: idempotent — second merge from same repo is a no-op', () => {
    const once = mergeHooks({}, opts).settings;
    const { changed, added } = mergeHooks(once, opts);
    assert.equal(changed, false);
    assert.deepEqual(added, []);
    assert.equal(once.hooks.SessionStart.length, 1, 'no duplicate entries');
});

test('unmergeHooks: removes only ours and restores prior shape', () => {
    const existing = {
        permissions: { allow: ['Bash'] },
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/usr/bin/node /other/tool/start.mjs', timeout: 5 }] }] },
    };
    const merged = mergeHooks(existing, opts).settings;
    const { settings, changed, removed } = unmergeHooks(merged);
    assert.equal(changed, true);
    assert.ok(removed.includes('SessionStart'));
    // foreign hook survives; our Stop/PreCompact/UserPromptSubmit events are gone entirely
    assert.equal(settings.hooks.SessionStart.length, 1);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, '/usr/bin/node /other/tool/start.mjs');
    assert.ok(!('Stop' in settings.hooks));
    assert.ok(!('PreCompact' in settings.hooks));
    assert.deepEqual(settings.permissions, { allow: ['Bash'] });
});

test('unmergeHooks: drops the empty hooks{} when nothing else remains', () => {
    const merged = mergeHooks({}, opts).settings;
    const { settings } = unmergeHooks(merged);
    assert.ok(!('hooks' in settings), 'empty hooks block removed');
});

test('hooksStatus: reports installed vs missing', () => {
    assert.deepEqual(hooksStatus({}, REPO).missing.length, 4);
    const merged = mergeHooks({}, opts).settings;
    const st = hooksStatus(merged, REPO);
    assert.equal(st.missing.length, 0);
    assert.equal(st.installed.length, 4);
});

test('installHooks e2e on a throwaway HOME: install → idempotent re-run → uninstall', () => {
    const home = tmpHome();
    try {
        writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] } }));
        const r1 = installHooks({ home, repoRoot: REPO, nodePath: NODE });
        assert.equal(r1.action, 'installed');
        assert.ok(existsSync(r1.backupPath), 'backup written');
        const onDisk = readSettings(home);
        assert.equal(onDisk.hooks.SessionStart[0].hooks[0].command, `"${NODE}" "${REPO}/hooks/session-start.mjs"`);
        assert.deepEqual(onDisk.permissions, { allow: ['Bash'] }, 'unrelated keys preserved on disk');

        const r2 = installHooks({ home, repoRoot: REPO, nodePath: NODE });
        assert.equal(r2.action, 'noop', 're-run changes nothing');

        const r3 = installHooks({ home, repoRoot: REPO, uninstall: true });
        assert.equal(r3.action, 'removed');
        assert.ok(!('hooks' in readSettings(home)), 'hooks gone after uninstall');
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('mergeHooks: relocating the repo replaces the stale command, never duplicates', () => {
    const fromOld = mergeHooks({}, { nodePath: NODE, repoRoot: '/old/repo' }).settings;
    const { settings, changed } = mergeHooks(fromOld, { nodePath: NODE, repoRoot: '/new/repo' });
    assert.equal(changed, true, 'a relocation is a real change');
    assert.equal(settings.hooks.SessionStart.length, 1, 'no duplicate — exactly one live command');
    assert.ok(settings.hooks.SessionStart[0].hooks[0].command.includes('/new/repo/hooks/session-start.mjs'));
    assert.ok(!JSON.stringify(settings).includes('/old/repo'), 'stale path fully gone');
});

test('mergeHooks: quotes paths so spaces survive', () => {
    const { settings } = mergeHooks({}, { nodePath: '/usr/bin/node', repoRoot: '/Users/me/My Repos/cc' });
    assert.equal(settings.hooks.Stop[0].hooks[0].command, '"/usr/bin/node" "/Users/me/My Repos/cc/hooks/ctx-update.mjs"');
});

test('merge/unmerge refuse a malformed hooks shape instead of crashing or dropping data', () => {
    assert.throws(() => mergeHooks({ hooks: { SessionStart: { not: 'an array' } } }, opts), /not an array/);
    assert.throws(() => mergeHooks({ hooks: 'nope' }, opts), /not an object/);
    assert.throws(() => unmergeHooks({ hooks: { Stop: [{ hooks: 42 }] } }), /not an array/);
});

test('installHooks: a second mutating run keeps the pristine backup', () => {
    const home = tmpHome();
    try {
        const orig = JSON.stringify({ permissions: { allow: ['Bash'] } });
        writeFileSync(join(home, '.claude', 'settings.json'), orig);
        installHooks({ home, repoRoot: '/old/repo', nodePath: NODE });          // backup = pristine
        installHooks({ home, repoRoot: '/new/repo', nodePath: NODE });          // mutating re-run
        const backup = readFileSync(join(home, '.claude', 'settings.json.bak.cc-orchestrator'), 'utf8');
        assert.equal(backup, orig, 'backup is still the original, not a cc-orchestrator-modified copy');
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('installHooks: missing settings.json creates it; malformed JSON throws without writing', () => {
    const home = tmpHome();
    try {
        const r = installHooks({ home, repoRoot: REPO, nodePath: NODE });
        assert.equal(r.action, 'installed');
        assert.equal(hookSpecs(REPO).length, 4);

        const bad = tmpHome();
        try {
            const p = join(bad, '.claude', 'settings.json');
            writeFileSync(p, '{ not valid json ');
            assert.throws(() => installHooks({ home: bad, repoRoot: REPO, nodePath: NODE }), SyntaxError);
            assert.equal(readFileSync(p, 'utf8'), '{ not valid json ', 'malformed file left untouched');
        } finally {
            rmSync(bad, { recursive: true, force: true });
        }
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
