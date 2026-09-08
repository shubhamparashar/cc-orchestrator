// Eval harness for the session-context generator prompt (lib/ctxPrompt.mjs).
// Each case = existing.md (optional) + dialogue.txt + expect.json. The score is
// deterministic string/regex checks on the model output, so a run is repeatable.
//   node evals/ctx-generate/run.mjs            replay recorded outputs (no spend)
//   node evals/ctx-generate/run.mjs --record   call the model, save outputs, score
//   --model <id>  (default claude-haiku-4-5)   --samples <n> (default 2)
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_BODY_LINES, buildPrompt, composeFile } from '../../lib/ctxPrompt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAUDE_BIN = process.env.CC_CTX_CLAUDE_BIN || join(homedir(), '.claude', 'local', 'claude');
const SECTIONS = ['## Goal', '## Key files', '## Decisions', '## State', '## Next step'];
const argv = process.argv.slice(2);
const flag = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1]; };
const record = argv.includes('--record');
const model = flag('--model', 'claude-haiku-4-5');
const samples = Number(flag('--samples', 2));

function callModel(prompt) {
    const r = spawnSync(CLAUDE_BIN, ['-p', '--no-session-persistence', '--model', model], {
        input: prompt, encoding: 'utf8', timeout: 180_000,
        env: { ...process.env, CC_CTX_JOB: '1', CLAUDE_NO_RC: '1' },
    });
    if (r.status !== 0) throw new Error(`claude exited ${r.status}: ${(r.stderr || r.stdout).slice(0, 200)}`);
    return r.stdout;
}

// Returns the list of failed check names; empty = pass.
function score(raw, expect) {
    const fails = [];
    let file;
    try { file = composeFile({ sessionId: 'eval', repo: 'r', cwd: '/r', title: 't', modelOutput: raw }); }
    catch (e) { return [`parse: ${e.message}`]; }
    if (!raw.trimStart().startsWith('tags:')) fails.push('no-preamble');
    const body = file.slice(file.indexOf('## Goal'));
    for (const s of SECTIONS) if (!body.includes(s)) fails.push(`section:${s}`);
    const lines = body.trim().split('\n').length;
    if (lines > MAX_BODY_LINES - 5) fails.push(`length:${lines}>${MAX_BODY_LINES - 5}`);
    const tags = (file.match(/^tags: \[(.*)\]$/m)?.[1] || '').split(',').filter((t) => t.trim()).length;
    if (tags < 3 || tags > 6) fails.push(`tags:${tags}`);
    for (const re of expect.must_contain || []) if (!new RegExp(re, 'i').test(body)) fails.push(`missing:/${re}/`);
    for (const re of expect.must_not_contain || []) if (new RegExp(re, 'i').test(body)) fails.push(`stale:/${re}/`);
    return fails;
}

const rows = [];
for (const name of readdirSync(join(HERE, 'cases')).sort()) {
    const dir = join(HERE, 'cases', name);
    const expect = JSON.parse(readFileSync(join(dir, 'expect.json'), 'utf8'));
    const existing = existsSync(join(dir, 'existing.md')) ? readFileSync(join(dir, 'existing.md'), 'utf8') : null;
    const dialogue = readFileSync(join(dir, 'dialogue.txt'), 'utf8');
    const outDir = join(dir, 'outputs', model);
    mkdirSync(outDir, { recursive: true });
    if (record) {
        const prompt = buildPrompt({ existing, dialogue, repo: expect.repo || 'repo', title: expect.title || name });
        for (let i = 0; i < samples; i++) writeFileSync(join(outDir, `${i}.txt`), callModel(prompt));
    }
    for (const f of readdirSync(outDir).sort()) {
        const fails = score(readFileSync(join(outDir, f), 'utf8'), expect);
        rows.push({ case: name, sample: f, pass: fails.length === 0, fails: fails.join(' ') });
    }
}
const passed = rows.filter((r) => r.pass).length;
for (const r of rows) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.case}/${r.sample}  ${r.fails}`);
console.log(`\n${model}: ${passed}/${rows.length} samples pass`);
process.exitCode = rows.length && passed === rows.length ? 0 : 1;
