import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRUNE_SCRIPT = fileURLToPath(new URL('../jobs/prune.mjs', import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;

async function makeHome() {
    const home = await mkdtemp(join(tmpdir(), 'cc-prune-test-'));
    const projects = join(home, '.claude', 'projects', 'demo-repo');
    const contexts = join(home, '.claude', 'contexts');
    const state = join(contexts, '.state');
    const canvas = join(contexts, 'canvas');
    await mkdir(projects, { recursive: true });
    await mkdir(state, { recursive: true });
    await mkdir(canvas, { recursive: true });
    return { home, projects, contexts, state, canvas };
}

async function ageFile(path, msAgo) {
    const t = new Date(Date.now() - msAgo);
    await utimes(path, t, t);
}

async function seedSession({ projects, contexts, state, canvas }, id, { transcript = true, ageMs = 0, transcriptAgeMs = ageMs } = {}) {
    if (transcript) {
        const tPath = join(projects, `${id}.jsonl`);
        await writeFile(tPath, `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`);
        await ageFile(tPath, transcriptAgeMs);
    }
    const mdPath = join(contexts, `${id}.md`);
    await writeFile(mdPath, `# ${id}\n`);
    await ageFile(mdPath, ageMs);
    const statePath = join(state, `${id}.json`);
    await writeFile(statePath, '{}');
    await ageFile(statePath, ageMs);
    const canvasDir = join(canvas, id);
    await mkdir(canvasDir, { recursive: true });
    const canvasFile = join(canvasDir, 'note.txt');
    await writeFile(canvasFile, 'canvas data');
    await ageFile(canvasFile, ageMs);
    await ageFile(canvasDir, ageMs);
}

function runPrune(home, extraArgs = []) {
    return execFileSync(process.execPath, [PRUNE_SCRIPT, ...extraArgs], {
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
    });
}

const FRESH_ID = '11111111-1111-4111-8111-111111111111';
const OLD_LIVE_ID = '22222222-2222-4222-8222-222222222222';
const ACTIVE_STALE_ARTIFACTS_ID = '55555555-5555-4555-8555-555555555555';
const NO_TRANSCRIPT_ID = '33333333-3333-4333-8333-333333333333';

test('dry-run reports what would be removed but touches nothing', async () => {
    const fixture = await makeHome();
    await seedSession(fixture, FRESH_ID, { transcript: true, ageMs: 0 });
    await seedSession(fixture, OLD_LIVE_ID, { transcript: true, ageMs: 40 * DAY_MS });
    await seedSession(fixture, NO_TRANSCRIPT_ID, { transcript: false, ageMs: 0 });

    const out = runPrune(fixture.home, ['--dry-run']);
    assert.match(out, /prune \(dry-run\): 6 files removed, \d+ bytes freed/);

    assert.ok(existsSync(join(fixture.contexts, `${OLD_LIVE_ID}.md`)), 'dry-run must not delete');
    assert.ok(existsSync(join(fixture.contexts, `${NO_TRANSCRIPT_ID}.md`)), 'dry-run must not delete');
});

test('removes sessions with no transcript or with a stale transcript, leaves fresh sessions alone', async () => {
    const fixture = await makeHome();
    await seedSession(fixture, FRESH_ID, { transcript: true, ageMs: 0 });
    await seedSession(fixture, OLD_LIVE_ID, { transcript: true, ageMs: 40 * DAY_MS });
    await seedSession(fixture, NO_TRANSCRIPT_ID, { transcript: false, ageMs: 0 });

    const out = runPrune(fixture.home, ['--days', '30']);
    assert.match(out, /^prune: 6 files removed, \d+ bytes freed/);

    // Fresh session (live transcript, recent artifacts): untouched.
    assert.ok(existsSync(join(fixture.contexts, `${FRESH_ID}.md`)));
    assert.ok(existsSync(join(fixture.state, `${FRESH_ID}.json`)));
    assert.ok(existsSync(join(fixture.canvas, FRESH_ID)));

    // Old-but-still-live transcript, stale artifacts: removed.
    assert.ok(!existsSync(join(fixture.contexts, `${OLD_LIVE_ID}.md`)));
    assert.ok(!existsSync(join(fixture.state, `${OLD_LIVE_ID}.json`)));
    assert.ok(!existsSync(join(fixture.canvas, OLD_LIVE_ID)));

    // Transcript gone entirely, even though artifacts are fresh: removed.
    assert.ok(!existsSync(join(fixture.contexts, `${NO_TRANSCRIPT_ID}.md`)));
    assert.ok(!existsSync(join(fixture.state, `${NO_TRANSCRIPT_ID}.json`)));
    assert.ok(!existsSync(join(fixture.canvas, NO_TRANSCRIPT_ID)));

    // Index regenerated: valid JSON, only the surviving live session listed.
    const index = JSON.parse(await readFile(join(fixture.contexts, 'index.json'), 'utf8'));
    const ids = index.map((e) => e.sessionId);
    assert.ok(ids.includes(FRESH_ID), 'surviving session is indexed');
});

test('reaps orphan index-<port>.json files older than a day, leaves recent ones and the default index.json', async () => {
    const fixture = await makeHome();
    await seedSession(fixture, FRESH_ID, { transcript: true, ageMs: 0 });

    const staleOrphan = join(fixture.contexts, 'index-7466.json');
    await writeFile(staleOrphan, '[]');
    await ageFile(staleOrphan, 2 * DAY_MS);

    const freshOrphan = join(fixture.contexts, 'index-9001.json');
    await writeFile(freshOrphan, '[]');

    runPrune(fixture.home, ['--days', '30']);

    assert.ok(!existsSync(staleOrphan), 'stale orphan index removed');
    assert.ok(existsSync(freshOrphan), 'recent orphan index left alone');
    assert.ok(existsSync(join(fixture.contexts, 'index.json')), 'default index.json is never a prune target');
});

test('a session with a fresh transcript keeps its artifacts even when they are older than N days', async () => {
    const fixture = await makeHome();
    await seedSession(fixture, ACTIVE_STALE_ARTIFACTS_ID, { transcript: true, ageMs: 40 * DAY_MS, transcriptAgeMs: 0 });
    runPrune(fixture.home, ['--days', '30']);
    assert.ok(existsSync(join(fixture.contexts, `${ACTIVE_STALE_ARTIFACTS_ID}.md`)), 'live transcript must protect its artifacts');
    assert.ok(existsSync(join(fixture.state, `${ACTIVE_STALE_ARTIFACTS_ID}.json`)));
    assert.ok(existsSync(join(fixture.canvas, ACTIVE_STALE_ARTIFACTS_ID)));
});
