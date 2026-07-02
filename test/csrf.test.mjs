import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Boot the real server on a throwaway port with an isolated HOME/config so the
// CSRF gate can be exercised end-to-end without touching the always-on instance
// or the real ~/.claude tree. Port is overridable to dodge collisions.
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.CC_TEST_PORT || 7466);

function http(method, path, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const req = request(
            { host: '127.0.0.1', port: PORT, method, path, headers },
            (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => resolve({ status: res.statusCode, body: data }));
            },
        );
        req.on('error', reject);
        if (body != null) req.write(body);
        req.end();
    });
}

async function waitForReady(deadlineMs = 8000) {
    const start = Date.now();
    for (;;) {
        try {
            const r = await http('GET', '/healthz');
            if (r.status === 200) return;
        } catch {
            // not listening yet
        }
        if (Date.now() - start > deadlineMs) throw new Error('server did not become ready');
        await new Promise((r) => setTimeout(r, 150));
    }
}

let child;

test.before(async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-csrf-home-'));
    const cfg = mkdtempSync(join(tmpdir(), 'cc-csrf-cfg-'));
    child = spawn(process.execPath, ['server.mjs'], {
        cwd: REPO_ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            HOME: home,
            CC_CONFIG_DIR: cfg,
            CC_LOG_DIR: cfg,
            CC_LAN: '',
            CC_REQUIRE_TOKEN_LOCAL: '',
        },
        stdio: 'ignore',
    });
    await waitForReady();
});

test.after(() => { if (child) child.kill('SIGKILL'); });

test('GET needs no X-CC header (read-only)', async () => {
    const r = await http('GET', '/healthz');
    assert.strictEqual(r.status, 200);
});

test('loopback POST without X-CC is rejected (CSRF gate fires on loopback)', async () => {
    // text/plain mirrors a cross-origin "simple" request that dodges CORS preflight.
    const r = await http('POST', '/api/jobs/dismiss', { 'Content-Type': 'text/plain' }, '{"id":1}');
    assert.strictEqual(r.status, 403);
    assert.match(r.body, /X-CC/);
});

test('loopback POST with X-CC passes the CSRF gate', async () => {
    const r = await http(
        'POST', '/api/jobs/dismiss',
        { 'Content-Type': 'application/json', 'X-CC': '1' }, '{"id":1}',
    );
    assert.strictEqual(r.status, 200);
});

test('state-changing POST to /api/send without X-CC never reaches the spawn path', async () => {
    const r = await http('POST', '/api/send', { 'Content-Type': 'text/plain' },
        '{"sessionId":"11111111-2222-3333-4444-555555555555","text":"hi"}');
    assert.strictEqual(r.status, 403);
    assert.match(r.body, /X-CC/);
});

test('/api/send rejects a non-UUID sessionId before spawning claude', async () => {
    const r = await http(
        'POST', '/api/send',
        { 'Content-Type': 'application/json', 'X-CC': '1' },
        '{"sessionId":"--dangerously-skip-permissions","text":"hi"}',
    );
    assert.strictEqual(r.status, 400);
    assert.match(r.body, /invalid session id/);
});

test('/api/attach rejects a non-UUID sessionId', async () => {
    const r = await http(
        'POST', '/api/attach',
        { 'Content-Type': 'application/json', 'X-CC': '1' },
        '{"sessionId":"../../etc/passwd"}',
    );
    assert.strictEqual(r.status, 400);
    assert.match(r.body, /invalid session id/);
});

test('a body of JSON null is a 400 client error, not a 500', async () => {
    const r = await http(
        'POST', '/api/jobs/stop',
        { 'Content-Type': 'application/json', 'X-CC': '1' }, 'null',
    );
    assert.strictEqual(r.status, 400);
    assert.match(r.body, /invalid JSON/);
});

test('a scalar JSON body is a 400 client error, not a 500', async () => {
    const r = await http(
        'POST', '/api/jobs/stop',
        { 'Content-Type': 'application/json', 'X-CC': '1' }, '5',
    );
    assert.strictEqual(r.status, 400);
    assert.match(r.body, /invalid JSON/);
});

test('/api/send rejects a non-string cwd before it reaches spawn', async () => {
    const r = await http(
        'POST', '/api/send',
        { 'Content-Type': 'application/json', 'X-CC': '1' },
        '{"sessionId":"11111111-2222-3333-4444-555555555555","text":"hi","cwd":123}',
    );
    assert.strictEqual(r.status, 400);
    assert.match(r.body, /invalid cwd/);
});
