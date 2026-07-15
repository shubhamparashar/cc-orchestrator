import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { subscriptionLimits, resetLimitsCache } from '../lib/limits.mjs';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The module persists its last-good payload to configDir(); every test must
// point that at a scratch dir or the suite pollutes the real user cache.
function freshConfig() {
    process.env.CC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cc-limits-'));
}

const ok = (data) => async () => ({ ok: true, json: async () => data });
const fail = async () => { throw new Error('network down'); };

test('caches a successful fetch within the TTL', async () => {
    freshConfig();
    resetLimitsCache();
    let calls = 0;
    const fetchFn = async () => { calls++; return { ok: true, json: async () => ({ limits: [] }) }; };
    const deps = { getCreds: async () => ({ token: 't' }), fetchFn, now: () => 1000 };
    const a = await subscriptionLimits(deps);
    const b = await subscriptionLimits(deps);
    assert.equal(calls, 1);
    assert.deepEqual(a.data, { limits: [] });
    assert.equal(b.data, a.data);
});

test('serves stale data with the error on fetch failure', async () => {
    freshConfig();
    resetLimitsCache();
    let t = 0;
    const deps = { getCreds: async () => ({ token: 't' }), now: () => t };
    await subscriptionLimits({ ...deps, fetchFn: ok({ limits: [1] }) });
    t = 10 * 60 * 1000;
    const r = await subscriptionLimits({ ...deps, fetchFn: fail });
    assert.deepEqual(r.data, { limits: [1] });
    assert.match(r.error, /network down/);
});

test('retries after failure once the cooldown passes', async () => {
    freshConfig();
    resetLimitsCache();
    let t = 0;
    const deps = { getCreds: async () => ({ token: 't' }), now: () => t };
    const r1 = await subscriptionLimits({ ...deps, fetchFn: fail });
    assert.equal(r1.data, null);
    t = 2 * 60_000;
    const r2 = await subscriptionLimits({ ...deps, fetchFn: ok({ limits: [2] }) });
    assert.deepEqual(r2.data, { limits: [2] });
});

test('a failed fetch enters cooldown instead of retrying every call', async () => {
    freshConfig();
    resetLimitsCache();
    let t = 0, calls = 0;
    const failing = async () => { calls++; throw new Error('HTTP 429'); };
    const deps = { getCreds: async () => ({ token: 't' }), fetchFn: failing, now: () => t };
    await subscriptionLimits(deps);       // fails, starts cooldown
    t = 30_000;
    await subscriptionLimits(deps);       // inside cooldown — no retry
    assert.equal(calls, 1);
    t = 11 * 60_000;
    await subscriptionLimits(deps);       // cooldown over — retries
    assert.equal(calls, 2);
});

test('an expired payload cannot bypass the failure cooldown', async () => {
    freshConfig();
    resetLimitsCache();
    let t = Date.parse('2026-01-01T00:00:00Z'), calls = 0;
    const past = { limits: [{ resets_at: '2020-01-01T00:00:00Z', percent: 5 }] };
    await subscriptionLimits({ getCreds: async () => ({ token: 't' }), fetchFn: async () => ({ ok: true, json: async () => past }), now: () => t });
    const failing = async () => { calls++; throw new Error('fetch failed'); };
    const deps = { getCreds: async () => ({ token: 't' }), fetchFn: failing, now: () => t };
    t += 1000; await subscriptionLimits(deps);   // expired → refetch attempt fails, cooldown starts
    t += 1000; await subscriptionLimits(deps);   // still expired, but cooldown holds
    t += 1000; await subscriptionLimits(deps);
    assert.equal(calls, 1);
});

test('honors Retry-After on 429 for the cooldown length', async () => {
    freshConfig();
    resetLimitsCache();
    let t = 0, calls = 0;
    const limited = async () => {
        calls++;
        return { ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '1800' : null) } };
    };
    const deps = { getCreds: async () => ({ token: 't' }), fetchFn: limited, now: () => t };
    await subscriptionLimits(deps);
    t = 15 * 60_000;                       // past the default 10-min cooldown, inside retry-after
    await subscriptionLimits(deps);
    assert.equal(calls, 1);
    t = 31 * 60_000;                       // past retry-after
    await subscriptionLimits(deps);
    assert.equal(calls, 2);
});

test('a known-expired token never reaches the network', async () => {
    freshConfig();
    resetLimitsCache();
    let calls = 0;
    const fetchFn = async () => { calls++; return { ok: true, json: async () => ({}) }; };
    const deps = { getCreds: async () => ({ token: 't', expiresAt: 500 }), fetchFn, now: () => 1000 };
    const r = await subscriptionLimits(deps);
    assert.equal(calls, 0);
    assert.match(r.error, /token expired/);
});
