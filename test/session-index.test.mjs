import test from 'node:test';
import assert from 'node:assert/strict';

import { harvestPromptTerms, bodyFromCounts, harvestWorkTokens, workString } from '../lib/sessionIndex.mjs';
import { rankDocs } from '../lib/rank.mjs';

// JSONL transcript of user prompts (the shape Claude Code writes for typed prompts).
function transcript(prompts) {
    return prompts.map((p) => JSON.stringify({ type: 'user', message: { role: 'user', content: p } })).join('\n') + '\n';
}

// JSONL assistant record carrying tool_use blocks.
function assistantTools(blocks) {
    const content = blocks.map((b) => ({ type: 'tool_use', ...b }));
    return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } }) + '\n';
}

test('indexes terms from the WHOLE session — early task survives, not just the tail', () => {
    // An early-task word and a late-task word, separated by lots of filler. The old
    // recent-tail body would have dropped "fable"; the full harvest must keep both.
    const t = transcript([
        'check the fable model availability',
        ...Array(60).fill('continue with the work'),
        'now index the subagent transcripts',
    ]);
    const { counts, firstPrompt } = harvestPromptTerms(t);
    const body = bodyFromCounts(counts);
    assert.ok(body.split(' ').includes('fable'), 'early-task term retained');
    assert.ok(body.split(' ').includes('subagent'), 'late-task term retained');
    assert.equal(firstPrompt, 'check the fable model availability');
});

test('dedupes runaway repetition (term frequency capped)', () => {
    const t = transcript(Array(50).fill('cost cost cost')); // "cost" appears 150x
    const body = bodyFromCounts(harvestPromptTerms(t).counts);
    const n = body.split(' ').filter((w) => w === 'cost').length;
    assert.equal(n, 3, 'a term is emitted at most TERM_TF_CAP times');
});

test('stopwords and empty prompts contribute nothing', () => {
    const { counts } = harvestPromptTerms(transcript(['the and of to with is are']));
    assert.equal(counts.size, 0);
});

test('synthetic / tool-injected user turns are skipped', () => {
    // a meta turn must not pollute the index
    const lines = [
        JSON.stringify({ type: 'user', isMeta: true, message: { content: 'metameta noise' } }),
        JSON.stringify({ type: 'user', message: { content: 'real distinctword here' } }),
    ].join('\n') + '\n';
    const body = bodyFromCounts(harvestPromptTerms(lines).counts);
    assert.ok(body.includes('distinctword'));
    assert.ok(!body.includes('metameta'));
});

test('incremental seam: seeded counts/firstPrompt accumulate across reads', () => {
    const a = harvestPromptTerms(transcript(['alpha task one']));
    const b = harvestPromptTerms(transcript(['omega task two']), a.counts, a.firstPrompt);
    const body = bodyFromCounts(b.counts);
    assert.ok(body.includes('alpha') && body.includes('omega'), 'both reads represented');
    assert.equal(b.firstPrompt, 'alpha task one', 'first prompt preserved across the seam');
});

test('frequency-orders and caps the distinct-term set', () => {
    const counts = new Map();
    for (let i = 0; i < 2000; i++) counts.set(`term${i}`, 1);
    counts.set('dominant', 99);
    const terms = bodyFromCounts(counts).split(' ');
    assert.ok(terms.length <= 1500 * 3, 'bag respects the distinct-term cap');
    assert.ok(terms.includes('dominant'), 'highest-frequency term kept');
});

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

test('a file in the work field makes a session findable by filename', () => {
    const docs = [
        { id: 's1', title: 'first', work: 'cost.mjs server.mjs git', body: '' },
        { id: 's2', title: 'second', work: 'index.html npm', body: '' },
    ];
    const r = rankDocs('cost.mjs', docs);
    assert.equal(r[0].doc.id, 's1', 'session that touched cost.mjs ranks first');
});

test('an exact filename beats generic-prefix noise (forward-only prefix)', () => {
    // Many sessions merely mention the generic word "session"; only one owns the
    // specific file. The owner must rank first — the generic prefix must not dilute.
    const docs = [
        { id: 'owner', title: 'x', work: 'session-index.test.mjs', body: '' },
        ...Array.from({ length: 10 }, (_, i) => ({ id: `noise${i}`, title: 'y', work: '', body: 'session session session' })),
    ];
    const r = rankDocs('session-index.test.mjs', docs);
    assert.equal(r[0].doc.id, 'owner', 'the session owning the exact file ranks first');
});

test('forward prefix still works (query is a prefix of a longer indexed token)', () => {
    const docs = [
        { id: 'a', title: 'signoz-dashboard work', body: '' },
        { id: 'b', title: 'unrelated', body: '' },
    ];
    const r = rankDocs('signoz', docs);
    assert.equal(r[0]?.doc.id, 'a', 'short query still matches a longer token');
});
