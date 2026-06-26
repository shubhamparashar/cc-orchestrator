import test from 'node:test';
import assert from 'node:assert/strict';

import { harvestPromptTerms, bodyFromCounts } from '../lib/sessionIndex.mjs';

// JSONL transcript of user prompts (the shape Claude Code writes for typed prompts).
function transcript(prompts) {
    return prompts.map((p) => JSON.stringify({ type: 'user', message: { role: 'user', content: p } })).join('\n') + '\n';
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
    assert.ok(terms.length <= 800 * 3, 'bag respects the distinct-term cap');
    assert.ok(terms.includes('dominant'), 'highest-frequency term kept');
});
