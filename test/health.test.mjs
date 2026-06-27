import { fileURLToPath } from 'node:url';

import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sessionHealth } from '../lib/health.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/health-sample.jsonl', import.meta.url));

test('sessionHealth counts tool_use, errors, and compactions from a transcript', async () => {
    const result = await sessionHealth(FIXTURE);

    assert.strictEqual(result.totalCalls, 49);
    assert.strictEqual(result.errorCount, 2);
    assert.strictEqual(result.compactions, 1);
    assert.strictEqual(result.lastCompactPreTokens, 960000);

    // 2 / 49 * 100 = 4.08… → 4.1
    assert.ok(Math.abs(result.errorRate - 4.1) < 0.2, `errorRate was ${result.errorRate}`);

    // Bash must be present and the strict plurality.
    assert.ok('Bash' in result.byTool, 'Bash missing from byTool');
    const bash = result.byTool.Bash;
    for (const [tool, count] of Object.entries(result.byTool)) {
        if (tool === 'Bash') continue;
        assert.ok(bash > count, `Bash (${bash}) not strictly greater than ${tool} (${count})`);
    }
});

test('sessionHealth returns the zeroed shape for a missing file', async () => {
    const result = await sessionHealth('/no/such/transcript-does-not-exist.jsonl');

    assert.strictEqual(result.totalCalls, 0);
    assert.deepStrictEqual(result.byTool, {});
    assert.strictEqual(result.errorCount, 0);
    assert.strictEqual(result.errorRate, 0);
    assert.strictEqual(result.compactions, 0);
    assert.strictEqual(result.lastCompactPreTokens, 0);
});

test('sessionHealth folds a later compaction in via the incremental-append path (last preTokens wins)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-health-'));
    const path = join(dir, 'grow.jsonl');
    const compact = (pre) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: pre } }) + '\n';
    const toolUse = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }) + '\n';
    try {
        writeFileSync(path, toolUse + compact(100000));
        const first = await sessionHealth(path);
        assert.strictEqual(first.compactions, 1);
        assert.strictEqual(first.lastCompactPreTokens, 100000);

        // Append a more-recent compaction; the second call resumes from the cached
        // byte offset and must fold the newer preTokens over the older one.
        appendFileSync(path, compact(250000));
        const second = await sessionHealth(path);
        assert.strictEqual(second.compactions, 2);
        assert.strictEqual(second.lastCompactPreTokens, 250000, 'most recent preTokens wins across the append path');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
