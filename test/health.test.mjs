import { fileURLToPath } from 'node:url';

import test from 'node:test';
import assert from 'node:assert';

import { sessionHealth } from '../lib/health.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/health-sample.jsonl', import.meta.url));

test('sessionHealth counts tool_use, errors, and compactions from a transcript', async () => {
    const result = await sessionHealth(FIXTURE);

    assert.strictEqual(result.totalCalls, 49);
    assert.strictEqual(result.errorCount, 2);
    assert.strictEqual(result.compactions, 1);

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
});
