import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sessionTasks } from '../lib/tasks.mjs';

// Hermetic: read committed fixtures, not the live ~/.claude/tasks (which a CI
// runner / a fresh clone doesn't have).
const FIXTURES = fileURLToPath(new URL('./fixtures/tasks', import.meta.url));
const VALID_STATUS = new Set(['completed', 'pending', 'in_progress']);

test('summarizes a session with gaps, mixed statuses, and blocked items', async () => {
    const r = await sessionTasks('sess-mixed', FIXTURES);
    assert.equal(r.total, 4);          // 1,2,4,10 — .lock is ignored
    assert.equal(r.done, 1);
    assert.equal(r.pending, 2);
    assert.equal(r.inProgress, 1);
    assert.equal(r.blocked, 2);        // 2 (blockedBy, pending) + 10 (blockedBy, in_progress); not 1 (completed)
    assert.equal(r.items.length, 4);
    // numeric filename order, not lexical: 10.json must sort after 4.json
    assert.equal(r.items[0].subject, 'Map current pricing pipeline');
    assert.equal(r.items[3].subject, 'Verify vendor payout unaffected');
    for (const item of r.items) {
        assert.ok(VALID_STATUS.has(item.status), `unexpected status: ${item.status}`);
    }
});

test('summarizes a fully-completed session', async () => {
    const r = await sessionTasks('sess-done', FIXTURES);
    assert.equal(r.total, 2);
    assert.equal(r.done, 2);
    assert.equal(r.blocked, 0);
});

test('returns zeroed shape for a nonexistent session', async () => {
    const r = await sessionTasks('does-not-exist', FIXTURES);
    assert.equal(r.total, 0);
    assert.deepEqual(r.items, []);
    assert.equal(r.done, 0);
    assert.equal(r.inProgress, 0);
    assert.equal(r.pending, 0);
    assert.equal(r.blocked, 0);
});
