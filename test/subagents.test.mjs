import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    subagentFilesFor, readMeta, subagentUsageByModel, subagentDateModel,
    subagentDocsFor, subagentCountFor,
} from '../lib/subagents.mjs';
import { mergeUsageByModel } from '../lib/cost.mjs';
import { costSummary, DEFAULT_PRICING } from '../lib/pricing.mjs';

// Fixture tree mirrors the real on-disk layout:
//   <projects>/proj-a/sess-1111/subagents/agent-explore01.jsonl        (+ good meta)
//   <projects>/proj-a/sess-1111/subagents/agent-task02.jsonl           (+ garbage meta)
//   <projects>/proj-a/sess-1111/subagents/workflows/wf_abc/agent-wf03.jsonl (no meta) + journal.jsonl
//   <projects>/proj-a/sess-1111222/subagents/agent-sibling01.jsonl     (prefix-collision sibling)
const PROJECTS = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'subagents-projects');
const PROJ = 'proj-a';
const SESS = 'sess-1111';
const SIBLING = 'sess-1111222'; // SESS is a string prefix of this id

test('subagentFilesFor joins every transcript under the session, recursing into workflows', async () => {
    const files = await subagentFilesFor(PROJECTS, PROJ, SESS);
    const names = files.map((f) => f.jsonlPath.split('/subagents/')[1]).sort();
    assert.deepEqual(names, [
        'agent-explore01.jsonl',
        'agent-task02.jsonl',
        'workflows/wf_abc/agent-wf03.jsonl',
    ]);
    // Each jsonl pairs with its sibling meta path (same dir, .meta.json extension).
    for (const f of files) {
        assert.ok(f.metaPath.endsWith('.meta.json'));
        assert.equal(dirname(f.metaPath), dirname(f.jsonlPath));
    }
});

test('the orchestration-only journal.jsonl is excluded from the walk', async () => {
    const files = await subagentFilesFor(PROJECTS, PROJ, SESS);
    assert.ok(files.every((f) => !f.jsonlPath.endsWith('journal.jsonl')));
});

test('a missing subagents/ directory yields an empty list (not a throw)', async () => {
    const files = await subagentFilesFor(PROJECTS, PROJ, 'does-not-exist');
    assert.deepEqual(files, []);
});

test('subagentCountFor counts the joined transcripts', async () => {
    assert.equal(await subagentCountFor(PROJECTS, PROJ, SESS), 3);
    assert.equal(await subagentCountFor(PROJECTS, PROJ, 'does-not-exist'), 0);
});

test('readMeta is tolerant: missing file → generic fallback', async () => {
    const meta = await readMeta(join(PROJECTS, PROJ, SESS, 'subagents', 'workflows', 'wf_abc', 'agent-wf03.meta.json'));
    assert.deepEqual(meta, { agentType: 'subagent', description: '', toolUseId: null });
});

test('readMeta is tolerant: malformed JSON → generic fallback', async () => {
    const meta = await readMeta(join(PROJECTS, PROJ, SESS, 'subagents', 'agent-task02.meta.json'));
    assert.deepEqual(meta, { agentType: 'subagent', description: '', toolUseId: null });
});

test('readMeta parses a well-formed sidecar', async () => {
    const meta = await readMeta(join(PROJECTS, PROJ, SESS, 'subagents', 'agent-explore01.meta.json'));
    assert.equal(meta.agentType, 'Explore');
    assert.equal(meta.description, 'Explore the widget rendering pipeline');
    assert.equal(meta.toolUseId, 'toolu_explore01');
});

test('subagentUsageByModel sums usage across all transcripts, by model', async () => {
    const usage = await subagentUsageByModel(PROJECTS, PROJ, SESS);
    assert.deepEqual(Object.keys(usage).sort(), [
        'claude-haiku-4-5-20251001', 'claude-opus-4-8', 'claude-sonnet-4-6',
    ]);
    // Haiku: explore01's two assistant lines (100+50 in, 40+30 out, 1000+500 cacheRead, 200+100 cacheWrite5m).
    assert.deepEqual(usage['claude-haiku-4-5-20251001'], {
        input: 150, output: 70, cacheRead: 1500, cacheWrite5m: 300, cacheWrite1h: 0,
    });
    // Sonnet: wf03's single assistant line.
    assert.deepEqual(usage['claude-sonnet-4-6'], {
        input: 300, output: 120, cacheRead: 3000, cacheWrite5m: 600, cacheWrite1h: 0,
    });
});

test('usage excludes the synthetic-model line and the user toolUseResult rollup (no double-count)', async () => {
    const usage = await subagentUsageByModel(PROJECTS, PROJ, SESS);
    // task02 has: one real opus assistant line (input 200), one "<synthetic>" model
    // line (input 9999), and a user line carrying toolUseResult.usage (input 50000).
    // Only the real assistant line is billable.
    assert.deepEqual(usage['claude-opus-4-8'], {
        input: 200, output: 80, cacheRead: 2000, cacheWrite5m: 400, cacheWrite1h: 0,
    });
    // The huge synthetic / rollup numbers must be absent everywhere.
    for (const tokens of Object.values(usage)) {
        assert.ok(tokens.input < 9999, 'no synthetic input leaked');
        assert.ok(tokens.output < 9999, 'no synthetic output leaked');
    }
});

test('prefix-collision sibling is NOT attributed to the prefix session', async () => {
    // sess-1111 must not absorb sess-1111222's sub-agent (input 1).
    const usage = await subagentUsageByModel(PROJECTS, PROJ, SESS);
    const sibling = await subagentUsageByModel(PROJECTS, PROJ, SIBLING);
    assert.deepEqual(Object.keys(sibling), ['claude-opus-4-8']);
    assert.equal(sibling['claude-opus-4-8'].input, 1);
    // The sibling's opus (input 1) did not inflate sess-1111's opus (still 200).
    assert.equal(usage['claude-opus-4-8'].input, 200);
});

test('subagentUsageByModel is {} for a session with no sub-agents', async () => {
    assert.deepEqual(await subagentUsageByModel(PROJECTS, PROJ, 'does-not-exist'), {});
});

test('merging sub-agent usage into a parent map is purely additive', async () => {
    const sub = await subagentUsageByModel(PROJECTS, PROJ, SESS);
    // Pretend the parent already spent some opus and some haiku.
    const parentOwn = {
        'claude-opus-4-8': { input: 1000, output: 500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    };
    const before = costSummary(parentOwn, DEFAULT_PRICING).totalUsd;
    const subUsd = costSummary(sub, DEFAULT_PRICING).totalUsd;

    // Merge into a fresh map (the production pattern) so neither input is mutated.
    const merged = mergeUsageByModel(mergeUsageByModel({}, parentOwn), sub);
    const after = costSummary(merged, DEFAULT_PRICING).totalUsd;

    assert.ok(Math.abs(after - (before + subUsd)) < 1e-9, `merged ${after} == parent ${before} + sub ${subUsd}`);
    // Opus tokens added, not replaced: 1000 (parent) + 200 (sub) = 1200.
    assert.equal(merged['claude-opus-4-8'].input, 1200);
    // The source maps were not mutated by the merge.
    assert.equal(parentOwn['claude-opus-4-8'].input, 1000);
    assert.equal(sub['claude-opus-4-8'].input, 200);
});

test('subagent spend is non-trivial and fully priced for this fixture', async () => {
    const usage = await subagentUsageByModel(PROJECTS, PROJ, SESS);
    const summary = costSummary(usage, DEFAULT_PRICING);
    assert.ok(summary.pricedKnown, 'all fixture models are in DEFAULT_PRICING');
    assert.ok(summary.totalUsd > 0);
});

test('subagentDateModel buckets by the UTC day of each assistant record', async () => {
    const byDate = await subagentDateModel(PROJECTS, PROJ, SESS);
    assert.deepEqual(Object.keys(byDate).sort(), ['2026-06-20', '2026-06-21']);
    // 2026-06-20 carries haiku (explore) + opus (task); 2026-06-21 carries sonnet (wf).
    assert.deepEqual(Object.keys(byDate['2026-06-20']).sort(), ['claude-haiku-4-5-20251001', 'claude-opus-4-8']);
    assert.deepEqual(Object.keys(byDate['2026-06-21']), ['claude-sonnet-4-6']);
});

test('subagentDocsFor returns one navigable doc per transcript with the expected shape', async () => {
    const docs = await subagentDocsFor(PROJECTS, PROJ, SESS, 'myrepo');
    assert.equal(docs.length, 3);
    const byId = new Map(docs.map((d) => [d.id, d]));

    const explore = byId.get('agent-explore01');
    assert.equal(explore.parentSessionId, SESS);
    assert.equal(explore.agentType, 'Explore');
    assert.equal(explore.description, 'Explore the widget rendering pipeline');
    assert.equal(explore.repo, 'myrepo');
    assert.equal(explore.model, 'claude-haiku-4-5-20251001');
    assert.ok(explore.body.includes('widget'), 'body carries dialogue text');

    // garbage meta → generic agentType + empty description, but still a valid doc
    const task = byId.get('agent-task02');
    assert.equal(task.agentType, 'subagent');
    assert.equal(task.description, '');
    assert.equal(task.parentSessionId, SESS);

    // doc shape: exactly these keys
    for (const d of docs) {
        assert.deepEqual(
            Object.keys(d).sort(),
            ['agentType', 'body', 'description', 'id', 'model', 'parentSessionId', 'repo'],
        );
    }
});

test('subagent doc body is dialogue-only (no synthetic / harness turns)', async () => {
    const docs = await subagentDocsFor(PROJECTS, PROJ, SESS, 'myrepo');
    const task = docs.find((d) => d.id === 'agent-task02');
    // task02's transcript contains a "<system-reminder>" user line — it must not
    // appear in the indexed body.
    assert.ok(!task.body.includes('system-reminder'), 'synthetic turn excluded from body');
    assert.ok(task.body.includes('Refactor') || task.body.includes('Refactoring'), 'real dialogue present');
});
