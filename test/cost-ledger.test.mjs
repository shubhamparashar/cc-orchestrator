import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { bankAndDeletedUsd, bankAndMergeDaily: bankAndMergeDailyRef, _reset } = await import('../lib/costLedger.mjs');

function freshLedger() {
    process.env.CC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cc-ledger-'));
    _reset();
}

test('deleted session cost stays in the lifetime total', () => {
    freshLedger();
    // a and b are live
    assert.equal(bankAndDeletedUsd([{ sessionId: 'a', usd: 5 }, { sessionId: 'b', usd: 3 }]), 0);
    // a deleted → its $5 is now banked as "deleted"
    assert.equal(bankAndDeletedUsd([{ sessionId: 'b', usd: 3 }]), 5);
    // both gone → both banked
    assert.equal(bankAndDeletedUsd([]), 8);
});

test('high-water mark: growth tracked, no double-count when a session reappears', () => {
    freshLedger();
    bankAndDeletedUsd([{ sessionId: 'a', usd: 5 }]);
    // transient scan miss banks a's $5...
    assert.equal(bankAndDeletedUsd([]), 5);
    // ...but when it reappears it's live again, not double-counted
    assert.equal(bankAndDeletedUsd([{ sessionId: 'a', usd: 9 }]), 0);
    // and the higher water mark is what persists after deletion
    assert.equal(bankAndDeletedUsd([]), 9);
});

test('survives a restart (reloads ledger from disk)', () => {
    freshLedger();
    bankAndDeletedUsd([{ sessionId: 'x', usd: 7 }]);
    _reset(); // simulate process restart: drop in-memory cache, keep the file
    assert.equal(bankAndDeletedUsd([]), 7);
});

test('daily buckets survive transcript deletion', () => {
    freshLedger();
    const bankAndMergeDaily = bankAndMergeDailyRef;
    const day1 = { date: '2026-07-01', usd: 10, byModel: { m: 10 } };
    const day2 = { date: '2026-07-02', usd: 4, byModel: { m: 4 } };
    let r = bankAndMergeDaily([day1, day2]);
    assert.equal(r.totalUsd, 14);
    // day1's transcripts deleted → still served from the ledger
    r = bankAndMergeDaily([day2]);
    assert.equal(r.totalUsd, 14);
    assert.deepEqual(r.buckets.map((b) => b.date), ['2026-07-01', '2026-07-02']);
});

test('daily high-water: partial deletion keeps the higher mark, growth wins', () => {
    freshLedger();
    bankAndMergeDailyRef([{ date: '2026-07-03', usd: 8, byModel: { m: 8 } }]);
    // partial deletion: live usd dropped below banked → banked snapshot served
    let r = bankAndMergeDailyRef([{ date: '2026-07-03', usd: 3, byModel: { m: 3 } }]);
    assert.equal(r.buckets[0].usd, 8);
    // growth: live above banked → live served and banked
    r = bankAndMergeDailyRef([{ date: '2026-07-03', usd: 12, byModel: { m: 12 } }]);
    assert.equal(r.buckets[0].usd, 12);
});
