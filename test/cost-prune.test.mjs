import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sessionUsageByModel, usageByDateModel, pruneUsageCache, _cachedPaths } from '../lib/cost.mjs';

const dir = mkdtempSync(join(tmpdir(), 'cc-cost-prune-'));

function transcript(name) {
    const p = join(dir, name);
    const line = JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-01T10:00:00.000Z',
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 5 } },
    });
    writeFileSync(p, line + '\n');
    return p;
}

test('pruneUsageCache sweeps both the usage and the date-usage caches', async () => {
    const a = transcript('a.jsonl');
    const b = transcript('b.jsonl');
    await sessionUsageByModel(a);
    await sessionUsageByModel(b);
    await usageByDateModel(a);
    await usageByDateModel(b);
    let cached = _cachedPaths();
    assert.ok(cached.usage.includes(a) && cached.usage.includes(b));
    assert.ok(cached.dateUsage.includes(a) && cached.dateUsage.includes(b));

    pruneUsageCache(new Set([a])); // b's transcript is gone from the live set
    cached = _cachedPaths();
    assert.ok(cached.usage.includes(a));
    assert.ok(!cached.usage.includes(b));
    assert.ok(cached.dateUsage.includes(a));
    assert.ok(!cached.dateUsage.includes(b));
});
