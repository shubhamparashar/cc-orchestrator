import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateAlerts } from '../lib/alerts.mjs';
import { ALERT_DEFAULTS } from '../lib/config.mjs';

const waiting = (n) => Array.from({ length: n }, () => ({ status: 'waiting-on-input' }));

const TODAY = '2026-06-25';

function cfg(over = {}) {
    return { alerts: { ...ALERT_DEFAULTS, ...over } };
}

// ── evaluateAlerts: digest ─────────────────────────────────────────────────

test('digest fires when the waiting count changes', () => {
    const { notifications, nextState } = evaluateAlerts({
        waitingCount: 3, todayUsd: 0, config: cfg(), prevState: {}, today: TODAY, present: false,
    });
    const digest = notifications.find((n) => n.type === 'digest');
    assert.ok(digest, 'expected a digest notification');
    assert.match(digest.message, /3 session\(s\) waiting/);
    assert.strictEqual(digest.title, 'cc-orchestrator');
    assert.strictEqual(nextState.digest.lastCount, 3);
});

test('digest dedups when the count is unchanged', () => {
    const prevState = { digest: { lastCount: 3 } };
    const { notifications } = evaluateAlerts({
        waitingCount: 3, todayUsd: 0, config: cfg(), prevState, today: TODAY, present: false,
    });
    assert.strictEqual(notifications.filter((n) => n.type === 'digest').length, 0);
});

test('digest does not fire when zero sessions are waiting', () => {
    const { notifications, nextState } = evaluateAlerts({
        waitingCount: 0, todayUsd: 0, config: cfg(), prevState: { digest: { lastCount: 2 } }, today: TODAY, present: false,
    });
    assert.strictEqual(notifications.filter((n) => n.type === 'digest').length, 0);
    // baseline still tracks the current count so a return to a prior count re-fires
    assert.strictEqual(nextState.digest.lastCount, 0);
});

test('digest is suppressed when the user is present and presenceAware', () => {
    const { notifications, nextState } = evaluateAlerts({
        waitingCount: 2, todayUsd: 0, config: cfg({ presenceAware: true }), prevState: {}, today: TODAY, present: true,
    });
    assert.strictEqual(notifications.filter((n) => n.type === 'digest').length, 0);
    // suppressed cycle still advances the baseline so it won't fire late for this count
    assert.strictEqual(nextState.digest.lastCount, 2);
});

test('digest still fires when present but presenceAware is off', () => {
    const { notifications } = evaluateAlerts({
        waitingCount: 2, todayUsd: 0, config: cfg({ presenceAware: false }), prevState: {}, today: TODAY, present: true,
    });
    assert.strictEqual(notifications.filter((n) => n.type === 'digest').length, 1);
});

test('digest is disabled when digest.enabled is false', () => {
    const { notifications } = evaluateAlerts({
        waitingCount: 5, todayUsd: 0, config: cfg({ digest: { enabled: false } }), prevState: {}, today: TODAY, present: false,
    });
    assert.strictEqual(notifications.filter((n) => n.type === 'digest').length, 0);
});

// ── evaluateAlerts: budget ─────────────────────────────────────────────────

test('budget fires once when spend crosses the threshold', () => {
    const { notifications, nextState } = evaluateAlerts({
        waitingCount: 0, todayUsd: 12.5, config: cfg({ budget: { thresholdUsd: 10 } }), prevState: {}, today: TODAY, present: false,
    });
    const budget = notifications.find((n) => n.type === 'budget');
    assert.ok(budget, 'expected a budget notification');
    assert.match(budget.message, /crossed \$10/);
    assert.strictEqual(nextState.budget.lastDayNotified, TODAY);
});

test('budget does not fire twice on the same day', () => {
    const prevState = { budget: { lastDayNotified: TODAY } };
    const { notifications } = evaluateAlerts({
        waitingCount: 0, todayUsd: 50, config: cfg({ budget: { thresholdUsd: 10 } }), prevState, today: TODAY, present: false,
    });
    assert.strictEqual(notifications.filter((n) => n.type === 'budget').length, 0);
});

test('budget fires again on a new day', () => {
    const prevState = { budget: { lastDayNotified: '2026-06-24' } };
    const { notifications } = evaluateAlerts({
        waitingCount: 0, todayUsd: 50, config: cfg({ budget: { thresholdUsd: 10 } }), prevState, today: TODAY, present: false,
    });
    assert.strictEqual(notifications.filter((n) => n.type === 'budget').length, 1);
});

test('budget is disabled when thresholdUsd is 0', () => {
    const { notifications } = evaluateAlerts({
        waitingCount: 0, todayUsd: 9999, config: cfg({ budget: { thresholdUsd: 0 } }), prevState: {}, today: TODAY, present: false,
    });
    assert.strictEqual(notifications.filter((n) => n.type === 'budget').length, 0);
});

test('budget is not suppressed by presence', () => {
    const { notifications } = evaluateAlerts({
        waitingCount: 0, todayUsd: 20, config: cfg({ budget: { thresholdUsd: 10 }, presenceAware: true }), prevState: {}, today: TODAY, present: true,
    });
    assert.strictEqual(notifications.filter((n) => n.type === 'budget').length, 1);
});

test('digest and budget can both fire in one evaluation', () => {
    const { notifications } = evaluateAlerts({
        waitingCount: 2, todayUsd: 20, config: cfg({ budget: { thresholdUsd: 10 } }), prevState: {}, today: TODAY, present: false,
    });
    assert.ok(notifications.some((n) => n.type === 'digest'));
    assert.ok(notifications.some((n) => n.type === 'budget'));
});

// ── loadConfig: default-merge against a throwaway CC_CONFIG_DIR ──────────────

test('loadConfig returns defaults when no config file exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-alerts-'));
    process.env.CC_CONFIG_DIR = dir;
    try {
        const { loadConfig, ALERT_DEFAULTS } = await import(`../lib/config.mjs?missing=${Date.now()}`);
        const loaded = loadConfig({ alerts: ALERT_DEFAULTS });
        assert.deepStrictEqual(loaded.alerts, ALERT_DEFAULTS);
    } finally {
        delete process.env.CC_CONFIG_DIR;
    }
});

test('loadConfig deep-merges the alerts object over defaults', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-alerts-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ alerts: { enabled: true, budget: { thresholdUsd: 5 } } }));
    process.env.CC_CONFIG_DIR = dir;
    try {
        const { loadConfig, ALERT_DEFAULTS } = await import(`../lib/config.mjs?merge=${Date.now()}`);
        const loaded = loadConfig({ alerts: ALERT_DEFAULTS });
        assert.strictEqual(loaded.alerts.enabled, true);
        assert.strictEqual(loaded.alerts.budget.thresholdUsd, 5);
        // untouched sub-keys retain their defaults
        assert.strictEqual(loaded.alerts.digest.enabled, true);
        assert.strictEqual(loaded.alerts.presenceAware, true);
        assert.strictEqual(loaded.alerts.checkIntervalMs, ALERT_DEFAULTS.checkIntervalMs);
    } finally {
        delete process.env.CC_CONFIG_DIR;
    }
});

test('loadConfig tolerates a garbage config file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-alerts-'));
    writeFileSync(join(dir, 'config.json'), '{ this is not json');
    process.env.CC_CONFIG_DIR = dir;
    try {
        const { loadConfig, ALERT_DEFAULTS } = await import(`../lib/config.mjs?garbage=${Date.now()}`);
        const loaded = loadConfig({ alerts: ALERT_DEFAULTS });
        assert.deepStrictEqual(loaded.alerts, ALERT_DEFAULTS);
    } finally {
        delete process.env.CC_CONFIG_DIR;
    }
});

// ── osNotify: dry-run never spawns ──────────────────────────────────────────

test('osNotify returns { dryRun: true } under CC_ALERT_DRYRUN=1', async () => {
    process.env.CC_ALERT_DRYRUN = '1';
    try {
        const { osNotify } = await import(`../lib/notify.mjs?dry=${Date.now()}`);
        const result = await osNotify({ title: 'cc-orchestrator', message: '2 session(s) waiting on your input' });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.dryRun, true);
    } finally {
        delete process.env.CC_ALERT_DRYRUN;
    }
});

// ── checkAlerts: impure orchestrator (state round-trip, dedup, single-flight) ─
// Each test imports a fresh module instance (cache-busting query) so the
// module-level single-flight guard never leaks between tests, and points
// CC_CONFIG_DIR at a throwaway dir so the state file is isolated.

function freshConfigDir() {
    const dir = mkdtempSync(join(tmpdir(), 'cc-alerts-chk-'));
    process.env.CC_CONFIG_DIR = dir;
    return dir;
}

async function importCheckAlerts(tag) {
    return import(`../lib/alerts.mjs?chk=${tag}-${Date.now()}-${Math.random()}`);
}

test('checkAlerts derives waitingCount from session status and persists state', async () => {
    freshConfigDir();
    process.env.CC_ALERT_DRYRUN = '1';
    try {
        const { checkAlerts } = await importCheckAlerts('persist');
        const config = { alerts: { ...ALERT_DEFAULTS, enabled: true, presenceAware: false } };
        const sessions = [...waiting(2), { status: 'running' }, { status: 'idle' }];
        const { notifications, nextState } = await checkAlerts({
            getSessions: async () => sessions,
            getTodayUsd: async () => 0,
            config,
            now: Date.parse(`${TODAY}T12:00:00Z`),
        });
        assert.strictEqual(notifications.filter((n) => n.type === 'digest').length, 1);
        assert.match(notifications[0].message, /2 session\(s\) waiting/);
        assert.strictEqual(nextState.digest.lastCount, 2);
    } finally {
        delete process.env.CC_ALERT_DRYRUN;
        delete process.env.CC_CONFIG_DIR;
    }
});

test('checkAlerts dedups across ticks then re-fires on a 3→0→3 sequence', async () => {
    freshConfigDir();
    process.env.CC_ALERT_DRYRUN = '1';
    try {
        const { checkAlerts } = await importCheckAlerts('seq');
        const config = { alerts: { ...ALERT_DEFAULTS, enabled: true, presenceAware: false } };
        const now = Date.parse(`${TODAY}T12:00:00Z`);
        let count = 3;
        const run = () => checkAlerts({ getSessions: async () => waiting(count), getTodayUsd: async () => 0, config, now });

        const a = await run();            // 3 → fire
        assert.strictEqual(a.notifications.filter((n) => n.type === 'digest').length, 1);
        const b = await run();            // 3 → dedup
        assert.strictEqual(b.notifications.filter((n) => n.type === 'digest').length, 0);
        count = 0;
        const c = await run();            // 0 → no fire, baseline drops to 0
        assert.strictEqual(c.notifications.filter((n) => n.type === 'digest').length, 0);
        count = 3;
        const d = await run();            // 3 again → fires (count changed from 0)
        assert.strictEqual(d.notifications.filter((n) => n.type === 'digest').length, 1);
    } finally {
        delete process.env.CC_ALERT_DRYRUN;
        delete process.env.CC_CONFIG_DIR;
    }
});

test('checkAlerts single-flights overlapping ticks so budget fires once', async () => {
    freshConfigDir();
    process.env.CC_ALERT_DRYRUN = '1';
    try {
        const { checkAlerts } = await importCheckAlerts('single');
        const config = { alerts: { ...ALERT_DEFAULTS, enabled: true, digest: { enabled: false }, budget: { thresholdUsd: 10 } } };
        const now = Date.parse(`${TODAY}T12:00:00Z`);
        let sessionCalls = 0;
        let usdCalls = 0;
        const slow = (v) => new Promise((r) => setTimeout(() => r(v), 30));
        const opts = {
            getSessions: async () => { sessionCalls++; return slow([]); },
            getTodayUsd: async () => { usdCalls++; return slow(20); },
            config,
            now,
        };
        // Fire two ticks before the first resolves — they must coalesce. When
        // coalesced, both calls resolve to the SAME result object, which is itself
        // proof the second tick reused the first's in-flight run.
        const p1 = checkAlerts(opts);
        const p2 = checkAlerts(opts);
        const [r1, r2] = await Promise.all([p1, p2]);
        assert.strictEqual(r1, r2, 'overlapping ticks should resolve to one shared run');
        assert.strictEqual(sessionCalls, 1, 'getSessions should run once under single-flight');
        assert.strictEqual(usdCalls, 1, 'getTodayUsd should run once under single-flight');
        assert.strictEqual(r1.notifications.filter((n) => n.type === 'budget').length, 1, 'budget must fire exactly once');

        // A subsequent (non-overlapping) tick the same day must NOT re-fire budget.
        const r3 = await checkAlerts(opts);
        assert.strictEqual(r3.notifications.filter((n) => n.type === 'budget').length, 0);
    } finally {
        delete process.env.CC_ALERT_DRYRUN;
        delete process.env.CC_CONFIG_DIR;
    }
});

test('checkAlerts skips the cost computation when budget is disabled', async () => {
    freshConfigDir();
    process.env.CC_ALERT_DRYRUN = '1';
    try {
        const { checkAlerts } = await importCheckAlerts('skipcost');
        const config = { alerts: { ...ALERT_DEFAULTS, enabled: true, presenceAware: false, budget: { thresholdUsd: 0 } } };
        let usdCalls = 0;
        const { notifications } = await checkAlerts({
            getSessions: async () => waiting(1),
            getTodayUsd: async () => { usdCalls++; return 999; },
            config,
            now: Date.parse(`${TODAY}T12:00:00Z`),
        });
        assert.strictEqual(usdCalls, 0, 'getTodayUsd must not run when thresholdUsd is 0');
        assert.strictEqual(notifications.filter((n) => n.type === 'budget').length, 0);
        assert.strictEqual(notifications.filter((n) => n.type === 'digest').length, 1);
    } finally {
        delete process.env.CC_ALERT_DRYRUN;
        delete process.env.CC_CONFIG_DIR;
    }
});

test('checkAlerts never throws when getSessions rejects', async () => {
    freshConfigDir();
    try {
        const { checkAlerts } = await importCheckAlerts('throws');
        const config = { alerts: { ...ALERT_DEFAULTS, enabled: true } };
        const result = await checkAlerts({
            getSessions: async () => { throw new Error('scan boom'); },
            getTodayUsd: async () => 0,
            config,
            now: Date.parse(`${TODAY}T12:00:00Z`),
        });
        assert.deepStrictEqual(result.notifications, []);
        assert.strictEqual(result.nextState, null);
    } finally {
        delete process.env.CC_CONFIG_DIR;
    }
});
