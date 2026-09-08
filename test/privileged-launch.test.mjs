import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Boot the real server on a throwaway port with an isolated HOME/config and
// CLAUDE_ORIG_BIN pointed at /bin/echo, so an "allowed" full-access launch
// spawns a harmless echo under the PTY wrapper instead of a real claude
// process (mirrors how liveSessions.test.mjs mocks spawnFn, but here the
// privilege gate lives in server.mjs so the mock has to happen at the binary
// level instead).
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.CC_TEST_PORT_PRIV || 7478);

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

// x-forwarded-for on a loopback socket forces the remote (token-required)
// path in isLocalRequest, the same trick test/auth-ratelimit.test.mjs uses.
function asRemote(extra = {}) {
    return { 'x-forwarded-for': '203.0.113.5', 'X-CC': '1', 'Content-Type': 'application/json', ...extra };
}

function asLocal(extra = {}) {
    return { 'X-CC': '1', 'Content-Type': 'application/json', ...extra };
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
let cookie;

test.before(async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-priv-home-'));
    const cfg = mkdtempSync(join(tmpdir(), 'cc-priv-cfg-'));
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
            CLAUDE_ORIG_BIN: '/bin/echo',
        },
        stdio: 'ignore',
    });
    await waitForReady();
    await http('GET', '/login?key=bootstrap', asRemote());
    const token = readFileSync(join(home, '.config', 'cc-orchestrator', 'token'), 'utf8').trim();
    const login = await http('GET', `/login?key=${token}`, asRemote());
    const setCookie = login.headers?.['set-cookie'];
    cookie = `cc_token=${token}`;
    void setCookie;
});

test.after(() => { if (child) child.kill('SIGKILL'); });

test('remote + level:full is rejected with 403 before any spawn', async () => {
    const r = await http(
        'POST', '/api/live/start',
        asRemote({ Cookie: cookie }),
        JSON.stringify({ cwd: '/tmp', level: 'full' }),
    );
    assert.strictEqual(r.status, 403);
    assert.match(r.body, /privileged launch requires loopback/);
});

test('remote + skipPermissions attach is rejected with 403', async () => {
    const r = await http(
        'POST', '/api/attach',
        asRemote({ Cookie: cookie }),
        JSON.stringify({ sessionId: '11111111-1111-1111-1111-111111111111', skipPermissions: true }),
    );
    assert.strictEqual(r.status, 403);
    assert.match(r.body, /privileged launch requires loopback/);
});

test('loopback + level:full is allowed', async () => {
    const r = await http(
        'POST', '/api/live/start',
        asLocal(),
        JSON.stringify({ cwd: '/tmp', level: 'full' }),
    );
    assert.strictEqual(r.status, 202);
    const started = JSON.parse(r.body);
    assert.ok(started.liveId);
    await http('POST', '/api/live/stop', asLocal(), JSON.stringify({ liveId: started.liveId }));
});

test('remote + normal level (no skipPermissions) still works', async () => {
    const r = await http(
        'POST', '/api/live/start',
        asRemote({ Cookie: cookie }),
        JSON.stringify({ cwd: '/tmp', level: 'ask' }),
    );
    assert.strictEqual(r.status, 202);
    const started = JSON.parse(r.body);
    assert.ok(started.liveId);
    await http('POST', '/api/live/stop', asRemote({ Cookie: cookie }), JSON.stringify({ liveId: started.liveId }));
});
