import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { digestFile } from '../lib/scan.mjs';

const dir = mkdtempSync(join(tmpdir(), 'cc-scan-digest-'));

function writeTranscript(name, records) {
    const p = join(dir, name);
    writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return p;
}

const REAL_ASSISTANT = {
    type: 'assistant',
    timestamp: '2026-07-01T10:00:00.000Z',
    message: {
        model: 'claude-opus-4-8',
        usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'done, shipped' }],
    },
};

// Harness-injected placeholder turn (a failed/interrupted API call): fake model
// id, all-zero usage. Real transcripts end on one of these routinely.
const SYNTHETIC = {
    type: 'assistant',
    timestamp: '2026-07-01T10:05:00.000Z',
    message: {
        model: '<synthetic>',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'API error' }],
    },
};

const USER = {
    type: 'user',
    timestamp: '2026-07-01T10:02:00.000Z',
    message: { content: 'please continue' },
};

test('digest skips a trailing <synthetic> record for tokens/model/role/snippet', async () => {
    const p = writeTranscript('a.jsonl', [REAL_ASSISTANT, USER, SYNTHETIC]);
    const { d } = await digestFile(p, await stat(p));
    assert.equal(d.usedTokens, 300); // from the newest REAL assistant record, not 0
    assert.equal(d.model, 'claude-opus-4-8'); // never '<synthetic>'
    assert.equal(d.lastRole, 'user'); // a placeholder turn is not "claude replied"
    assert.equal(d.lastAssistant, 'done, shipped');
    assert.equal(d.lastTimestamp, SYNTHETIC.timestamp); // timestamps stay record-level
});

test('digest of a placeholder-only transcript yields null tokens/model, not zeros', async () => {
    const p = writeTranscript('b.jsonl', [SYNTHETIC]);
    const { d } = await digestFile(p, await stat(p));
    assert.equal(d.usedTokens, null); // null → callers fall back; 0 would suppress the gauge
    assert.equal(d.model, null);
    assert.equal(d.lastRole, null);
});
