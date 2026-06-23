import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sessionTasks } from '../lib/tasks.mjs';

const VALID_STATUS = new Set(['completed', 'pending', 'in_progress']);

test('summarizes a session with gaps and mixed statuses', async () => {
    const r = await sessionTasks('b7e3a062-bc1d-4176-b9aa-35abfeccfec1');
    assert.equal(r.total, 13);
    assert.equal(r.done, 8);
    assert.equal(r.pending, 5);
    assert.equal(r.blocked, 3);
    assert.equal(r.inProgress, 0);
    assert.equal(r.items.length, 13);
    // numeric filename order: first item comes from 1.json
    assert.equal(r.items[0].subject, 'Map current pricing pipeline + Shopify Markets surface');
    for (const item of r.items) {
        assert.ok(VALID_STATUS.has(item.status), `unexpected status: ${item.status}`);
    }
});

test('summarizes a fully-completed session', async () => {
    const r = await sessionTasks('6ebaa5ce-0038-48d5-8fbe-e6ba4b35c1c4');
    assert.equal(r.total, 15);
    assert.equal(r.done, 15);
});

test('returns zeroed shape for a nonexistent session', async () => {
    const r = await sessionTasks('00000000-0000-0000-0000-000000000000');
    assert.equal(r.total, 0);
    assert.deepEqual(r.items, []);
    assert.equal(r.done, 0);
    assert.equal(r.inProgress, 0);
    assert.equal(r.pending, 0);
    assert.equal(r.blocked, 0);
});
