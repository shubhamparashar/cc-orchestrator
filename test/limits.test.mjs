import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { subscriptionLimits, resetLimitsCache } from '../lib/limits.mjs';

const ok = (data) => async () => ({ ok: true, json: async () => data });
const fail = async () => { throw new Error('network down'); };

test('caches a successful fetch within the TTL', async () => {
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
