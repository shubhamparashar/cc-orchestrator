import test from 'node:test';
import assert from 'node:assert/strict';

import { harvestWorkTokens, workString } from '../lib/work.mjs';

// JSONL assistant record carrying tool_use blocks.
function assistantTools(blocks) {
    const content = blocks.map((b) => ({ type: 'tool_use', ...b }));
    return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } }) + '\n';
}

test('harvestWorkTokens extracts files, tools, commands, and sub-agent types', () => {
    const t = assistantTools([
        { name: 'Edit', input: { file_path: '/Users/x/repo/lib/cost.mjs' } },
        { name: 'Bash', input: { command: 'git commit -m wip' } },
        { name: 'Agent', input: { subagent_type: 'Explore' } },
    ]);
    const w = harvestWorkTokens(t);
    for (const tok of ['edit', 'cost.mjs', 'bash', 'git', 'agent', 'explore']) {
        assert.ok(w.has(tok), `work has "${tok}"`);
    }
});

test('harvestWorkTokens dedupes a file touched many times / many ways', () => {
    const t = assistantTools([
        { name: 'Edit', input: { file_path: '/a/cost.mjs' } },
        { name: 'Edit', input: { file_path: '/b/cost.mjs' } },
        { name: 'Read', input: { file_path: '/a/cost.mjs' } },
    ]);
    const w = harvestWorkTokens(t);
    assert.equal([...w].filter((x) => x === 'cost.mjs').length, 1, 'basename deduped');
    assert.ok(w.has('edit') && w.has('read'));
});

test('captures the verb of each chained sub-command, skipping junk', () => {
    const t = assistantTools([
        { name: 'Bash', input: { command: 'cd ~/repo && git status && node --test' } },
        { name: 'Bash', input: { command: 'd=$(mktemp); launchctl kickstart -k foo' } },
    ]);
    const w = harvestWorkTokens(t);
    for (const tok of ['cd', 'git', 'node', 'launchctl']) assert.ok(w.has(tok), `command "${tok}"`);
    assert.ok(![...w].some((x) => x.includes('=') || x.includes('$')), 'no assignment/quoted junk');
});

test('only tool_use blocks count as work — a text mention does not', () => {
    const t = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'editing cost.mjs now' }] } }) + '\n';
    assert.equal(harvestWorkTokens(t).size, 0);
});

test('workString caps the distinct work set', () => {
    const big = new Set(Array.from({ length: 1000 }, (_, i) => `f${i}.ts`));
    assert.ok(workString(big).split(' ').length <= 500);
});
