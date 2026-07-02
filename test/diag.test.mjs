import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';

import { sanitizedEnv, scrub, issueUrl, REPO_URL } from '../lib/diag.mjs';

test('sanitizedEnv reports coarse runtime facts and no PII', () => {
    const e = sanitizedEnv();
    assert.ok(e.app && e.node && e.platform && e.os && e.arch);
    const json = JSON.stringify(e);
    assert.ok(!json.includes(homedir()), 'no home path');
    // no username / cwd / token keys
    for (const k of ['cwd', 'home', 'user', 'token', 'env']) assert.ok(!(k in e), `no ${k}`);
    // build stamp (boot commit) + staleness flag for triage; a short git SHA is a
    // public commit id, not a secret, and never a home path.
    assert.ok('build' in e && 'stale' in e, 'build + stale present');
    assert.equal(typeof e.stale, 'boolean');
    assert.ok(e.build === null || /^[0-9a-f]{7}$/.test(e.build), 'build is null or a short SHA');
});

test('scrub collapses the home dir and redacts secrets', () => {
    const out = scrub(`error at ${homedir()}/repo/cc-orchestrator/server.mjs with key=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef12`);
    assert.ok(!out.includes(homedir()), 'home dir collapsed');
    assert.ok(out.includes('~/repo/cc-orchestrator/server.mjs'), 'path made relative to ~');
    assert.ok(out.includes('key=‹redacted›'), 'secret redacted');
});

test('scrub collapses home paths generically (any user, case-variant), not just an exact homedir match', () => {
    assert.equal(scrub('at /Users/someoneelse/repo/x.mjs:10').includes('someoneelse'), false);
    assert.match(scrub('at /Users/someoneelse/repo/x.mjs:10'), /~\/repo\/x\.mjs/);
    assert.equal(scrub('at /home/ci-runner/app/server.mjs').includes('ci-runner'), false);
});

test('issueUrl builds a prefilled github issues/new URL', () => {
    const url = issueUrl({});
    assert.ok(url.startsWith(`${REPO_URL}/issues/new`));
    const u = new URL(url);
    assert.equal(u.searchParams.get('labels'), 'bug');
    const body = u.searchParams.get('body');
    assert.match(body, /## Environment/);
    assert.match(body, /cc-orchestrator: /);
    assert.match(body, /- Build: /, 'issue body carries the build stamp for triage');
});

test('issueUrl embeds a scrubbed error when given one', () => {
    const err = `TypeError at ${homedir()}/x.mjs — token=abcdef1234567890abcdef1234567890abcdef1234567890ab`;
    const body = new URL(issueUrl({ error: err })).searchParams.get('body');
    assert.match(body, /## Error/);
    assert.ok(!body.includes(homedir()), 'no home path leaked into the issue');
    assert.ok(!/abcdef1234567890abcdef1234567890/.test(body), 'no raw token leaked');
});
