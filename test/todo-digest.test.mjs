import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { buildTodoDigest, loadTodoDigest, digestStale } = await import('../lib/todoDigest.mjs');

function fresh() {
    process.env.CC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cc-todo-'));
}

const sess = (id, items, extra = {}) => ({
    sessionId: id, title: `t-${id}`, repo: 'r', status: 'idle',
    tasks: { items }, ...extra,
});

test('collects open items from the most recent sessions, skips completed and empty', () => {
    fresh();
    const d = buildTodoDigest([
        sess('a', [{ subject: 'fix bug', status: 'pending' }, { subject: 'done thing', status: 'completed' }]),
        sess('b', []),
        sess('c', [{ subject: 'ship it', status: 'in_progress' }]),
    ]);
    assert.equal(d.openItems, 2);
    assert.deepEqual(d.groups.map((g) => g.sessionId), ['a', 'c']);
    assert.deepEqual(d.groups[0].items, [{ subject: 'fix bug', status: 'pending' }]);
});

test('caps at 15 session groups and persists to disk', () => {
    fresh();
    const many = Array.from({ length: 25 }, (_, i) => sess('s' + i, [{ subject: 'x', status: 'pending' }]));
    const d = buildTodoDigest(many);
    assert.equal(d.groups.length, 15);
    const loaded = loadTodoDigest();
    assert.equal(loaded.groups.length, 15);
    assert.equal(loaded.generatedAt, d.generatedAt);
});

test('digestStale flips after 24h', () => {
    const d = { generatedAt: 1000, groups: [] };
    assert.equal(digestStale(d, 1000 + 1), false);
    assert.equal(digestStale(d, 1000 + 24 * 3600 * 1000), true);
    assert.equal(digestStale(null), true);
});
