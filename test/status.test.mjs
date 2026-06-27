import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claudeStatus } from '../lib/status.mjs';

function tmpHome(files = {}) {
    const home = mkdtempSync(join(tmpdir(), 'cc-status-'));
    const dir = join(home, '.claude');
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
    }
    return home;
}

test('claudeStatus reads version, approval mode, and MCP re-auth list from well-formed files', async () => {
    const home = tmpHome({
        '.last-update-result.json': { status: 'success', outcome: 'success', version_from: '2.1.181', version_to: '2.1.187' },
        'config.json': { approvalMode: 'auto' },
        'mcp-needs-auth-cache.json': { 'claude.ai n8n': { timestamp: 1 }, notion: { timestamp: 2 }, 'claude.ai Google Drive': { timestamp: 3 } },
    });
    try {
        const st = await claudeStatus({ home });
        assert.equal(st.version, '2.1.187');
        assert.equal(st.updateOk, true);
        assert.equal(st.approvalMode, 'auto');
        assert.deepEqual(st.mcpNeedsAuth.sort(), ['claude.ai Google Drive', 'claude.ai n8n', 'notion']);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('claudeStatus degrades to nulls/empty when the files are absent', async () => {
    const home = tmpHome();
    try {
        const st = await claudeStatus({ home });
        assert.equal(st.version, null);
        assert.equal(st.updateOk, true);
        assert.equal(st.approvalMode, null);
        assert.deepEqual(st.mcpNeedsAuth, []);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('claudeStatus tolerates malformed JSON and wrong-typed shapes', async () => {
    const home = tmpHome({
        '.last-update-result.json': '{not valid json',
        'config.json': '[]', // array, not an object
        'mcp-needs-auth-cache.json': '"a string"', // scalar, not an object
    });
    try {
        const st = await claudeStatus({ home });
        assert.equal(st.version, null);
        assert.equal(st.approvalMode, null);
        assert.deepEqual(st.mcpNeedsAuth, []);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('claudeStatus falls back to version_from and flags a failed update', async () => {
    const home = tmpHome({
        '.last-update-result.json': { outcome: 'failure', version_from: '2.1.181' },
    });
    try {
        const st = await claudeStatus({ home });
        assert.equal(st.version, '2.1.181');
        assert.equal(st.updateOk, false);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
