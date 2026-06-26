import test from 'node:test';
import assert from 'node:assert';

import { accumulateLine, accumulateDatedLine, mergeUsageByModel, rollupFromDaily } from '../lib/cost.mjs';
import { DEFAULT_PRICING } from '../lib/pricing.mjs';

function assertCleanPrototype() {
    // None of the accumulator fields may leak onto Object.prototype.
    const probe = {};
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h']) {
        assert.strictEqual(probe[k], undefined, `Object.prototype.${k} polluted`);
    }
}

const usage = { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 1 };

test('hostile model "__proto__" does not pollute via accumulateLine', () => {
    const byModel = {};
    accumulateLine(byModel, JSON.stringify({ type: 'assistant', message: { model: '__proto__', usage } }));
    assertCleanPrototype();
    assert.deepStrictEqual(Object.keys(byModel), []);
});

test('hostile model "constructor"/"prototype" does not pollute', () => {
    const byModel = {};
    for (const model of ['constructor', 'prototype']) {
        accumulateLine(byModel, JSON.stringify({ type: 'assistant', message: { model, usage } }));
    }
    assertCleanPrototype();
});

test('accumulateDatedLine ignores the reserved keys', () => {
    const byDate = {};
    accumulateDatedLine(byDate, JSON.stringify({
        type: 'assistant', timestamp: '2026-06-26T00:00:00Z', message: { model: '__proto__', usage },
    }));
    assertCleanPrototype();
    assert.deepStrictEqual(byDate, {});
});

test('mergeUsageByModel drops a computed __proto__ key without polluting', () => {
    const dst = {};
    mergeUsageByModel(dst, { ['__proto__']: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } });
    assertCleanPrototype();
    assert.deepStrictEqual(Object.keys(dst), []);
});

test('rollupFromDaily skips a reserved model key', () => {
    const dailyMaps = [{ '2026-06-26': { ['__proto__']: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } } }];
    const rollup = rollupFromDaily(dailyMaps, { window: 'day', pricing: DEFAULT_PRICING });
    assertCleanPrototype();
    assert.strictEqual(rollup.totalUsd, 0);
});

test('legitimate models still accumulate (no regression)', () => {
    const byModel = {};
    accumulateLine(byModel, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage } }));
    assert.strictEqual(byModel['claude-opus-4-8'].input, 5);
    assert.strictEqual(byModel['claude-opus-4-8'].output, 7);
    assert.strictEqual(byModel['claude-opus-4-8'].cacheRead, 1);
});
