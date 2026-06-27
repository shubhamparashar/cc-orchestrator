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

test('sessionHealth aggregates A5 attribution (sub-agent types, skills, MCP servers) and guards magic keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-health-a5-'));
    const path = join(dir, 't.jsonl');
    const records = [
        { type: 'assistant', attributionSkill: 'skill-a', message: { content: [{ type: 'text', text: 'x' }] } },
        { type: 'assistant', attributionSkill: 'skill-a', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'Explore' } }] } },
        { type: 'assistant', attributionMcpServer: 'server-x', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'Explore' } }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'general-purpose' } }] } },
        // Hostile keys must be dropped, never become own keys: both the prototype-
        // reaching names (constructor/prototype) and inherited method names
        // (hasOwnProperty/toString/valueOf) that would shadow methods on the map.
        { type: 'assistant', attributionSkill: 'constructor', attributionMcpServer: 'prototype', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'constructor' } }] } },
        { type: 'assistant', attributionSkill: 'hasOwnProperty', attributionMcpServer: 'toString', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'valueOf' } }] } },
    ];
    try {
        writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
        const h = await sessionHealth(path);
        assert.deepStrictEqual(h.skills, { 'skill-a': 2 });
        assert.deepStrictEqual(h.mcpServers, { 'server-x': 1 });
        assert.deepStrictEqual(h.subagentTypes, { Explore: 2, 'general-purpose': 1 });
        const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
        for (const k of ['constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf', '__proto__']) {
            assert.ok(!has(h.skills, k) && !has(h.mcpServers, k) && !has(h.subagentTypes, k), `magic key "${k}" leaked as own property`);
        }
        assert.strictEqual({}.polluted, undefined, 'no prototype pollution');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('sessionHealth derives blast-radius + stuck signals (writes, files, destructive kinds, error streak)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-health-risk-'));
    const path = join(dir, 't.jsonl');
    const tu = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
    const res = (isErr) => ({ type: 'user', message: { content: [{ type: 'tool_result', is_error: isErr }] } });
    const records = [
        tu('Edit', { file_path: '/a' }),
        tu('Edit', { file_path: '/a' }), // same file — distinct count stays 1 for /a
        tu('Write', { file_path: '/b' }),
        tu('Bash', { command: 'rm -rf /' }), // catastrophic root target
        tu('Bash', { command: 'sudo rm -rf /var/lib/data' }), // sudo recursive
        tu('Bash', { command: 'rm --recursive --force ~' }), // bare home, long flags
        tu('Bash', { command: 'git reset --hard HEAD~1' }),
        tu('Bash', { command: 'dd if=/dev/zero of=/dev/sda' }), // destructive operand of=, any order
        tu('Bash', { command: 'git push origin main --force-with-lease' }), // NOT destructive (excluded)
        tu('Bash', { command: 'sudo docker run --rm --network host img' }), // NOT — --rm is a flag, not the rm command
        tu('Bash', { command: 'rm -rf node_modules' }), // NOT — routine recursive rm, safe target
        tu('Bash', { command: 'rm -rf ~/.cache/foo' }), // NOT — scoped under home, not bare ~
        tu('Bash', { command: 'rm -rf /tmp/scratch' }), // NOT — scoped path, not root/home
        tu('Bash', { command: 'rm my-report.txt' }), // NOT — filename, not a recursive flag
        tu('Bash', { command: 'ls -la' }), // benign
        { type: 'user', message: { content: [{ type: 'tool_result', is_error: true }, { type: 'tool_result', is_error: true }] } },
        res(false), // success resets the streak
        res(true),
    ];
    try {
        writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
        const h = await sessionHealth(path);
        assert.strictEqual(h.writes, 3, '3 file-mutating calls');
        assert.strictEqual(h.filesTouched, 2, 'distinct files /a and /b');
        assert.strictEqual(h.destructiveBash, 5, 'rm-/ + sudo rm + rm ~ + git reset --hard + dd; not the scoped/routine rms, force-with-lease, or ls');
        assert.deepStrictEqual(h.destructiveKinds, { 'rm -rf root/home': 3, 'git reset --hard': 1, 'dd of=': 1 });
        assert.strictEqual(h.maxErrorStreak, 2, 'two consecutive errors before the success reset');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('maxErrorStreak spans the incremental-append boundary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-health-streak-'));
    const path = join(dir, 'grow.jsonl');
    const errRes = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true }] } }) + '\n';
    try {
        writeFileSync(path, errRes + errRes); // two consecutive errors
        const first = await sessionHealth(path);
        assert.strictEqual(first.maxErrorStreak, 2);
        appendFileSync(path, errRes); // a third error after the cached byte offset
        const second = await sessionHealth(path);
        assert.strictEqual(second.maxErrorStreak, 3, 'the streak continues across the append boundary');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('sessionHealth folds a later compaction in via the incremental-append path (last preTokens wins)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-health-'));
    const path = join(dir, 'grow.jsonl');
    const compact = (pre) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: pre } }) + '\n';
    const toolUse = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }) + '\n';
    const skillRec = JSON.stringify({ type: 'assistant', attributionSkill: 'skill-x', message: { content: [{ type: 'text', text: 'x' }] } }) + '\n';
    try {
        writeFileSync(path, toolUse + skillRec + compact(100000));
        const first = await sessionHealth(path);
        assert.strictEqual(first.compactions, 1);
        assert.strictEqual(first.lastCompactPreTokens, 100000);
        assert.deepStrictEqual(first.skills, { 'skill-x': 1 });

        // Append a more-recent compaction + another skill turn; the second call resumes
        // from the cached byte offset and must fold both over the prior totals.
        appendFileSync(path, skillRec + compact(250000));
        const second = await sessionHealth(path);
        assert.strictEqual(second.compactions, 2);
        assert.strictEqual(second.lastCompactPreTokens, 250000, 'most recent preTokens wins across the append path');
        assert.deepStrictEqual(second.skills, { 'skill-x': 2 }, 'attribution maps accumulate across the append path');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
