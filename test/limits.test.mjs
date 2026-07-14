import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { subscriptionLimits, resetLimitsCache } from '../lib/limits.mjs';

const ok = (data) => async () => ({ ok: true, json: async () => data });
const fail = async () => { throw new Error('network down'); };

test('caches a successful fetch within the TTL', async () => {
    resetLimitsCache();
    let calls = 0;
    const fetchFn = async () => { calls++; return { ok: true, json: async () => ({ limits: [] }) }; };
    const deps = { getToken: async () => 't', fetchFn, now: () => 1000 };
    const a = await subscriptionLimits(deps);
    const b = await subscriptionLimits(deps);
    assert.equal(calls, 1);
    assert.deepEqual(a.data, { limits: [] });
    assert.equal(b.data, a.data);
});

test('serves stale data with the error on fetch failure', async () => {
    resetLimitsCache();
    let t = 0;
    const deps = { getToken: async () => 't', now: () => t };
    await subscriptionLimits({ ...deps, fetchFn: ok({ limits: [1] }) });
    t = 10 * 60 * 1000;
    const r = await subscriptionLimits({ ...deps, fetchFn: fail });
    assert.deepEqual(r.data, { limits: [1] });
    assert.match(r.error, /network down/);
});

test('retries after failure when nothing is cached yet', async () => {
    resetLimitsCache();
    const deps = { getToken: async () => 't', now: () => 0 };
    const r1 = await subscriptionLimits({ ...deps, fetchFn: fail });
    assert.equal(r1.data, null);
    const r2 = await subscriptionLimits({ ...deps, fetchFn: ok({ limits: [2] }) });
    assert.deepEqual(r2.data, { limits: [2] });
});
