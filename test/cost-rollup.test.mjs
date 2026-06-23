import test from 'node:test';
import assert from 'node:assert/strict';

import { rollupFromDaily, rollupToCsv } from '../lib/cost.mjs';
import { DEFAULT_PRICING } from '../lib/pricing.mjs';

// Synthetic day×model maps, no real files. Dates chosen to exercise bucketing:
// 2026-06-08 (Mon) and 2026-06-09 (Tue) share an ISO week; 2026-07-01 is a
// different month (and a different week).
function tokens({ input = 0, output = 0, cacheRead = 0, cacheWrite5m = 0, cacheWrite1h = 0 }) {
    return { input, output, cacheRead, cacheWrite5m, cacheWrite1h };
}

const dailyMaps = [
    {
        '2026-06-08': { 'claude-opus-4-8': tokens({ input: 10000, output: 2000, cacheRead: 50000 }) },
        '2026-06-09': { 'claude-opus-4-8': tokens({ input: 5000, output: 1000, cacheRead: 20000 }) },
    },
    {
        '2026-07-01': { 'claude-opus-4-8': tokens({ input: 8000, output: 3000, cacheRead: 10000 }) },
    },
];

const pricing = DEFAULT_PRICING;

function sumBucketUsd(rollup) {
    return rollup.buckets.reduce((acc, b) => acc + b.usd, 0);
}

test('day window → one bucket per distinct date', () => {
    const r = rollupFromDaily(dailyMaps, { window: 'day', pricing });
    assert.equal(r.window, 'day');
    assert.equal(r.buckets.length, 3);
    assert.deepEqual(r.buckets.map((b) => b.date), ['2026-06-08', '2026-06-09', '2026-07-01']);
});

test('week window → two ISO-week buckets, June days collapse to Monday', () => {
    const r = rollupFromDaily(dailyMaps, { window: 'week', pricing });
    assert.equal(r.buckets.length, 2);
    // The two June days collapse into the Monday of their week.
    assert.equal(r.buckets[0].date, '2026-06-08');
    // July is its own week.
    assert.equal(r.buckets[1].date, '2026-06-29');
});

test('month window → two month buckets', () => {
    const r = rollupFromDaily(dailyMaps, { window: 'month', pricing });
    assert.equal(r.buckets.length, 2);
    assert.deepEqual(r.buckets.map((b) => b.date), ['2026-06', '2026-07']);
});

test('every bucket has positive usd and totalUsd ≈ sum of buckets', () => {
    for (const window of ['day', 'week', 'month']) {
        const r = rollupFromDaily(dailyMaps, { window, pricing });
        for (const b of r.buckets) {
            assert.ok(b.usd > 0, `bucket ${b.date} (${window}) should have usd > 0, got ${b.usd}`);
            assert.ok(b.byModel['claude-opus-4-8'] > 0);
        }
        const sum = sumBucketUsd(r);
        assert.ok(Math.abs(r.totalUsd - sum) < 1e-4, `${window}: totalUsd ${r.totalUsd} ≈ ${sum}`);
    }
});

test('rollupToCsv emits header + one row per bucket', () => {
    const r = rollupFromDaily(dailyMaps, { window: 'month', pricing });
    const csv = rollupToCsv(r);
    const lines = csv.split('\n');
    // Trailing newline yields a final empty element.
    assert.equal(lines[lines.length - 1], '');
    const content = lines.slice(0, -1);
    assert.equal(content.length, 1 + r.buckets.length); // header + N buckets
    assert.ok(content[0].startsWith('period,total_usd,'), content[0]);
    assert.ok(content[0].includes('claude-opus-4-8'), content[0]);
});
