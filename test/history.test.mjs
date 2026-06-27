import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redact, parseHistory } from '../lib/history.mjs';

test('redact strips the tokenized /login?key= remote-access link', () => {
    const token = 'e7d09ecc958f6a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aa'; // 64 hex
    const out = redact(`https://host.tail69e31b.ts.net/login?key=${token}`);
    assert.ok(!out.includes(token), 'raw token must not survive redaction');
    assert.ok(out.includes('key=‹redacted›'), 'key= label is kept, value redacted');
    assert.ok(out.startsWith('https://host'), 'surrounding URL context is preserved');
});

test('redact strips common provider key shapes', () => {
    assert.ok(!redact('use sk-ant-api03-abcdefghijklmnopqrstuvwx').includes('sk-ant-api03'));
    assert.ok(!redact('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345').includes('ghp_'));
    assert.ok(!redact('slack xoxb-123456789012-abcdefghijkl').includes('xoxb-1234'));
    assert.ok(redact('password=hunter2 in the form').includes('password=‹redacted›'));
});

test('redact handles underscore-prefixed env labels, DB URLs, JWTs and bearer tokens', () => {
    // \b(label)= used to miss underscore-prefixed identifiers — these must redact now.
    assert.ok(redact('DB_PASSWORD=MySecretPass123').includes('‹redacted›'));
    assert.ok(!redact('DB_PASSWORD=MySecretPass123').includes('MySecretPass123'));
    assert.ok(redact('export GH_TOKEN=ghs_aaaaaaaaaaaaaaaaaaaaaaaa').includes('‹redacted'));
    assert.ok(redact('aws_secret_access_key=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY').includes('‹redacted›'));
    // colon-style assignment (YAML/JSON paste)
    assert.ok(redact('api_key: abcdef123456ghijkl').includes('‹redacted›'));
    // URL-embedded DB credentials — keep user, drop password
    const pg = redact('postgres://admin:s3cr3tP4ss@db.example.com:5432/mydb');
    assert.ok(!pg.includes('s3cr3tP4ss'), 'DB password redacted');
    assert.ok(pg.includes('admin') && pg.includes('db.example.com'), 'user/host kept');
    // JWT + bearer
    assert.ok(!redact('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N').includes('eyJzdWIi'));
});

test('redact leaves ordinary prompts (40-char SHAs, "keyboard:", "monkey=") untouched', () => {
    const plain = 'fix the pricing bug in lib/cost.mjs and add a test';
    assert.equal(redact(plain), plain);
    const sha = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'; // 40-hex SHA-1
    assert.ok(redact(`revert ${sha} please`).includes(sha), '40-char SHA is not a secret');
    // "key" must be a delimited segment — these are NOT credentials and must survive.
    assert.equal(redact('my keyboard: a mechanical one'), 'my keyboard: a mechanical one');
    assert.equal(redact('the monkey=funny meme'), 'the monkey=funny meme');
});

test('redact strips Slack webhook URLs, Google OAuth and npm tokens', () => {
    const slack = redact('post to https://hooks.slack.com/services/T01ABCD2EFG/B03GHIJ4KLM/abcdefABCDEF1234567890zz');
    assert.ok(!slack.includes('B03GHIJ4KLM'), 'slack webhook secret path redacted');
    assert.ok(slack.includes('hooks.slack.com/services/‹redacted›'), 'host kept, secret path dropped');
    assert.ok(!redact('use ya29.a0AfH6SMBx7Qom2lKj3nNqRtUvWxYz0123456789abc').includes('a0AfH6SMB'), 'google oauth token redacted');
    assert.ok(!redact('publish with npm_abcdefghijklmnopqrstuvwxyz0123456789 now').includes('npm_abcdefghij'), 'bare npm token redacted');
    // benign lookalikes survive — npm_config (underscore breaks the run) and a bare "ya29" with no dot.
    assert.equal(redact('run npm_config and ya29 as a var name'), 'run npm_config and ya29 as a var name');
    // threshold boundary locks {30,} against future drift: 29 trailing chars survive, 30 trip.
    assert.ok(redact(`npm_${'a'.repeat(29)}`).includes(`npm_${'a'.repeat(29)}`), 'npm_ + 29 survives');
    assert.ok(!redact(`npm_${'a'.repeat(30)} end`).includes('npm_aaa'), 'npm_ + 30 redacts');
});

test('parseHistory: newest-first, redacted, joins project→repo/cwd', () => {
    const lines = [
        { display: 'first prompt', project: '/Users/me/repo/alpha', sessionId: 'aaa', timestamp: 1000 },
        { display: 'open /login?key=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef12', project: '/Users/me/repo/beta', sessionId: 'bbb', timestamp: 3000 },
        { display: 'middle prompt', project: '/Users/me/repo/alpha', sessionId: 'ccc', timestamp: 2000 },
    ].map((o) => JSON.stringify(o)).join('\n');

    const out = parseHistory(lines, {});
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((e) => e.at), [3000, 2000, 1000], 'sorted newest-first');
    assert.equal(out[0].repo, 'beta');
    assert.equal(out[0].cwd, '/Users/me/repo/beta');
    assert.ok(!out[0].display.includes('deadbeef'), 'secret redacted in parsed output');
});

test('parseHistory: case-insensitive substring filter over prompt + repo, respects limit', () => {
    const lines = [
        { display: 'fix Pricing rollup', project: '/r/cc', sessionId: 's1', timestamp: 5 },
        { display: 'unrelated note', project: '/r/other', sessionId: 's2', timestamp: 6 },
        { display: 'add CSV export', project: '/r/cc', sessionId: 's3', timestamp: 7 },
    ].map((o) => JSON.stringify(o)).join('\n');

    const byText = parseHistory(lines, { q: 'pricing' });
    assert.equal(byText.length, 1);
    assert.equal(byText[0].display, 'fix Pricing rollup');

    const byRepo = parseHistory(lines, { q: 'cc' }); // matches repo name on two rows
    assert.equal(byRepo.length, 2);

    assert.equal(parseHistory(lines, { limit: 2 }).length, 2);
});

test('parseHistory tolerates blank/garbage lines and missing fields', () => {
    const lines = ['', 'not json', '{"no":"display"}', JSON.stringify({ display: 'ok', timestamp: 1 })].join('\n');
    const out = parseHistory(lines, {});
    assert.equal(out.length, 1);
    assert.equal(out[0].repo, null);
    assert.equal(out[0].cwd, null);
});
