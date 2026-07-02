import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Boot the real server on a throwaway port with an isolated HOME so the failed-
// auth rate limit can be exercised end-to-end. An X-Forwarded-For header on a
// loopback socket puts a request on the remote (token-required) path, and its
// last hop becomes the rate-limit key — so each test isolates its budget by
// using a distinct forwarded peer.
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.CC_TEST_PORT_AUTH || 7477);

function http(method, path, headers = {}) {
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
        req.end();
    });
}

function asPeer(ip, extra = {}) {
    return { 'x-forwarded-for': ip, ...extra };
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
let token;

test.before(async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-auth-home-'));
    const cfg = mkdtempSync(join(tmpdir(), 'cc-auth-cfg-'));
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
    // Force lazy token creation, then read it back for the correct-key cases.
    await http('GET', '/login?key=bootstrap', asPeer('192.0.2.99'));
    token = readFileSync(join(home, '.config', 'cc-orchestrator', 'token'), 'utf8').trim();
    assert.ok(token);
});

test.after(() => { if (child) child.kill('SIGKILL'); });

test('cookie-less polling never consumes the login budget (stale-tab self-lockout)', async () => {
    const peer = asPeer('192.0.2.1');
    // A logged-out dashboard tab polling for a minute: > MAX_FAILURES requests.
    for (let i = 0; i < 15; i++) {
        const r = await http('GET', '/api/sessions', peer);
        assert.strictEqual(r.status, 401); // never 429 — nothing was guessed
    }
    const login = await http('GET', `/login?key=${token}`, peer);
    assert.strictEqual(login.status, 302); // the correct token still gets in
});

test('a stale (rotated) cookie cannot lock the correct token out of /login', async () => {
    const peer = asPeer('192.0.2.2');
    const stale = asPeer('192.0.2.2', { cookie: 'cc_token=deadbeefdeadbeef' });
    let last;
    for (let i = 0; i < 15; i++) last = await http('GET', '/api/sessions', stale);
    // The presented-but-wrong cookie saturates the generic budget…
    assert.strictEqual(last.status, 429);
    // …but /login draws from its own bucket, so the correct token still works.
    const login = await http('GET', `/login?key=${token}`, peer);
    assert.strictEqual(login.status, 302);
});

test('/login key guessing is still brute-force limited', async () => {
    const peer = asPeer('192.0.2.3');
    for (let i = 0; i < 10; i++) {
        const r = await http('GET', `/login?key=wrong-${i}`, peer);
        assert.strictEqual(r.status, 401);
    }
    const blocked = await http('GET', `/login?key=${token}`, peer);
    assert.strictEqual(blocked.status, 429); // budget spent on guesses — even the right key waits
});
