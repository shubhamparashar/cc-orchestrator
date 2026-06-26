import test from 'node:test';
import assert from 'node:assert/strict';

import { contextWindowFor } from '../lib/scan.mjs';

const M = 1_000_000;
const K = 200_000;

test('current 1M-native models resolve to a 1M window without any marker', () => {
    // The regression: opus-4-8 is natively 1M but carries no "[1m]" marker, so
    // marker-only detection wrongly used the 200k default (showing ~5x the real %).
    assert.equal(contextWindowFor('claude-opus-4-8', 'claude-opus-4-8', 130_000), M);
    assert.equal(contextWindowFor('claude-opus-4-7', null, 0), M);
    assert.equal(contextWindowFor('claude-opus-4-6', null, 0), M);
    assert.equal(contextWindowFor('claude-sonnet-4-6', null, 0), M);
    assert.equal(contextWindowFor('claude-fable-5', null, 0), M);
});

test('a real opus-4-8 occupancy divides by 1M (matches Claude Desktop)', () => {
    const used = 129_898;
    const pct = (used / contextWindowFor('claude-opus-4-8', 'claude-opus-4-8', used)) * 100;
    assert.equal(Math.round(pct), 13); // not 65% (which 200k would give)
});

test('haiku 4.5 and unlisted/older models default to 200k', () => {
    assert.equal(contextWindowFor('claude-haiku-4-5', null, 0), K);
    assert.equal(contextWindowFor('claude-sonnet-4-5', null, 5_000), K); // 200k-native (1M only via beta)
    assert.equal(contextWindowFor('some-unknown-model', null, 5_000), K);
});

test('the [1m] beta marker forces a 1M window on otherwise-200k models', () => {
    assert.equal(contextWindowFor('claude-sonnet-4-5[1m]', null, 0), M);
    assert.equal(contextWindowFor('claude-sonnet-4-5', 'claude-sonnet-4-5[1m]', 0), M); // marker on desktop id
});

test('desktop model wins, then transcript model', () => {
    assert.equal(contextWindowFor('claude-haiku-4-5', 'claude-opus-4-8', 0), M); // desktop 1M overrides transcript 200k
    assert.equal(contextWindowFor('claude-opus-4-8', null, 0), M); // desktop absent → transcript used
});

test('usage above a 200k window forces 1M for unknown models (safety net)', () => {
    assert.equal(contextWindowFor('mystery-model', null, 250_000), M);
    assert.equal(contextWindowFor('mystery-model', null, 50_000), K);
});

test('date-suffixed model ids still match via longest prefix', () => {
    assert.equal(contextWindowFor('claude-haiku-4-5-20251001', null, 0), K);
    assert.equal(contextWindowFor('claude-opus-4-8-20260101', null, 0), M);
});
