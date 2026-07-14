import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { usageAttribution, _resetAttribution } from '../lib/attribution.mjs';

async function mapLimit(items, limit, fn) {
    return Promise.all(items.map((it, i) => fn(it, i)));
}

const PRICING = { m1: { input: 10, output: 20 } };

function line({ ts, model = 'm1', input = 1_000_000, skill, mcp }) {
    return JSON.stringify({
        type: 'assistant',
        timestamp: ts,
        attributionSkill: skill,
        attributionMcpServer: mcp,
        message: { model, usage: { input_tokens: input, output_tokens: 0 } },
    }) + '\n';
}

function freshProject(files) {
    const projectsDir = mkdtempSync(join(tmpdir(), 'cc-attr-'));
    const projectDir = 'proj';
    mkdirSync(join(projectsDir, projectDir), { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
        const p = join(projectsDir, projectDir, rel);
        mkdirSync(join(p, '..'), { recursive: true });
        writeFileSync(p, content);
    }
    _resetAttribution();
    return { projectsDir, projectDir };
}

const NOW_ISO = () => new Date().toISOString();
const OLD_ISO = '2020-01-01T00:00:00.000Z';

test('attributes recent spend by skill and mcp, ignores old turns', async () => {
    const { projectsDir, projectDir } = freshProject({
        's1.jsonl':
            line({ ts: NOW_ISO(), skill: 'deploy-watch' }) +
            line({ ts: NOW_ISO(), mcp: 'postgres' }) +
            line({ ts: OLD_ISO, skill: 'ancient' }),
    });
    const r = await usageAttribution({
        sessions: [{ projectDir, sessionId: 's1', usedTokens: 0 }],
        projectsDir, hours: 24, pricing: PRICING, mapLimit,
    });
    // 2 recent turns × 1M input × $10/M
    assert.equal(r.totalUsd, 20);
    assert.deepEqual(r.bySkill, [{ key: 'deploy-watch', usd: 10, pct: 50 }]);
    assert.deepEqual(r.byMcp, [{ key: 'postgres', usd: 10, pct: 50 }]);
});

test('sub-agent spend lands under its meta agentType and in the stats', async () => {
    const { projectsDir, projectDir } = freshProject({
        's2.jsonl': line({ ts: NOW_ISO() }),
        's2/subagents/agent-a.jsonl': line({ ts: NOW_ISO() }) + line({ ts: NOW_ISO() }),
        's2/subagents/agent-a.meta.json': JSON.stringify({ agentType: 'Explore' }),
    });
    const r = await usageAttribution({
        sessions: [{ projectDir, sessionId: 's2', usedTokens: 200_000 }],
        projectsDir, hours: 24, pricing: PRICING, mapLimit,
    });
    assert.equal(r.totalUsd, 30);
    assert.deepEqual(r.bySubagentType, [{ key: 'Explore', usd: 20, pct: 66.7 }]);
    assert.equal(r.stats.subagentPct, 66.7);
    // sub share 2/3 > 30% → subagent-heavy; usedTokens 200k > 150k → high-context
    assert.equal(r.stats.subagentHeavyPct, 100);
    assert.equal(r.stats.highContextPct, 100);
});

test('empty window yields zeroes, not NaN', async () => {
    const { projectsDir, projectDir } = freshProject({ 's3.jsonl': line({ ts: OLD_ISO }) });
    const r = await usageAttribution({
        sessions: [{ projectDir, sessionId: 's3', usedTokens: 0 }],
        projectsDir, hours: 24, pricing: PRICING, mapLimit,
    });
    assert.equal(r.totalUsd, 0);
    assert.deepEqual(r.bySkill, []);
    assert.equal(r.stats.subagentPct, 0);
});
