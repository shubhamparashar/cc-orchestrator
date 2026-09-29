import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PRICING, costSummary, rateFor } from '../lib/pricing.mjs';

const MTOK = 1_000_000;

// USD per MTok from platform.claude.com/docs/en/about-claude/pricing:
// base input, output, cache hit, 5m cache write, 1h cache write.
const OFFICIAL = {
    'claude-fable-5-1': [10, 50, 0.25, 12.5, 20],
    'claude-fable-5': [10, 50, 1, 12.5, 20],
    'claude-opus-5-5': [4, 20, 0.2, 5, 8],
    'claude-opus-5': [5, 25, 0.5, 6.25, 10],
    'claude-sonnet-5-5': [2, 10, 0.2, 2.5, 4],
    'claude-sonnet-5': [2, 10, 0.2, 2.5, 4],
    'claude-sonnet-4-6': [3, 15, 0.3, 3.75, 6],
    'claude-haiku-4-5-20251001': [1, 5, 0.1, 1.25, 2],
};

function usdFor(model, tokens) {
    return costSummary({ [model]: tokens }, DEFAULT_PRICING).totalUsd;
}

for (const [model, [input, output, cacheRead, write5m, write1h]] of Object.entries(OFFICIAL)) {
    test(`${model} prices every token class at the official rate`, () => {
        assert.ok(rateFor(model, DEFAULT_PRICING), `no price for ${model}`);
        const cases = [
            [{ input: MTOK }, input],
            [{ output: MTOK }, output],
            [{ cacheRead: MTOK }, cacheRead],
            [{ cacheWrite5m: MTOK }, write5m],
            [{ cacheWrite1h: MTOK }, write1h],
        ];
        for (const [tokens, expected] of cases) {
            assert.ok(Math.abs(usdFor(model, tokens) - expected) < 1e-9, `${model} ${Object.keys(tokens)[0]}: ${usdFor(model, tokens)} != ${expected}`);
        }
    });
}

test('a [1m] marker does not change the rate', () => {
    assert.equal(rateFor('claude-opus-5-5[1m]', DEFAULT_PRICING), rateFor('claude-opus-5-5', DEFAULT_PRICING));
});
