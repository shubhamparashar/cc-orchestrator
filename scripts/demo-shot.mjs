#!/usr/bin/env node
// Screenshot the live dashboard with every real value replaced by a fixture.
// Proxies the running server, rewrites the sensitive fields in /api/* JSON, and
// drives headless Chrome at the proxy. Nothing real reaches the PNG.
//
//   node scripts/demo-shot.mjs [--port 7433] [--out docs/img/board.png] [--wide]

import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const UPSTREAM = Number(arg('--port', 7433));
const OUT = arg('--out', 'docs/img/board.png');
const SIZE = process.argv.includes('--wide') ? '1600,1000' : '1440,940';
const PROXY = 7455;

const CHROME = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
].find((p) => { try { return spawnSync(p, ['--version']).status === 0; } catch { return false; } });

// ---- fixtures -------------------------------------------------------------
const REPOS = ['acme-api', 'acme-web', 'billing-svc', 'infra', 'design-system'];
const BRANCHES = ['main', 'feat/checkout-v2', 'fix/webhook-retry', 'chore/ci-cache', 'spike/search'];
const TITLES = [
    'Checkout country rollout', 'Webhook retry backoff', 'CI cache experiment',
    'Search relevance spike', 'Invoice PDF renderer', 'Design tokens migration',
    'Rate limiter audit', 'Staging seed data', 'Flaky test triage', 'Docs site refresh',
];
const SAID = [
    'Tests are green - 41 passed, 0 failed. Want me to open the PR?',
    'Traced it to the retry loop dropping the idempotency key.',
    'Cache hit rate went 38% -> 91%. Build is 4m12s, down from 11m.',
    'Two callers still pass the old shape. Fixing both before the rename.',
    'Draft is written. Nothing pushed yet.',
];
// deterministic pick so re-running produces the same image
const pick = (arr, seed) => arr[Math.abs(hash(String(seed))) % arr.length];
const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; };
const money = (seed, max) => Math.round((Math.abs(hash('$' + seed)) % (max * 100)) / 100 * 100) / 100;

function scrubSession(s, i) {
    const seed = s.sessionId || i;
    const repo = pick(REPOS, seed);
    return {
        ...s,
        sessionId: `${String(Math.abs(hash(seed))).padStart(8, '0').slice(0, 8)}-0000-4000-8000-000000000000`,
        projectDir: `-Users-you-repo-${repo}`,
        cwd: `/Users/you/repo/${repo}`,
        repo,
        gitBranch: pick(BRANCHES, seed + 'b'),
        title: pick(TITLES, seed + 't'),
        lastUser: s.lastUser ? 'can you take a look at this before I ship it' : null,
        lastAssistant: s.lastAssistant ? pick(SAID, seed + 'a') : null,
        prNumbers: (s.prNumbers || []).map((_, n) => 1200 + (Math.abs(hash(seed)) % 90) + n),
        costOwn: money(seed, 9),
        subagentCost: money(seed + 's', 2),
        cost: s.cost ? { ...s.cost, totalUsd: money(seed, 11), byModel: (s.cost.byModel || []).map((m) => ({ ...m, usd: money(seed + m.model, 8) })) } : s.cost,
    };
}

// Any remaining dollar total anywhere in a payload gets scaled to demo range.
function scrubGeneric(v, key = '') {
    if (Array.isArray(v)) return v.map((x) => scrubGeneric(x));
    if (v && typeof v === 'object') {
        const out = {};
        for (const [k, val] of Object.entries(v)) out[k] = scrubGeneric(val, k);
        return out;
    }
    if (typeof v === 'number' && /usd|cost|total(?!Calls)/i.test(key)) return Math.round(v % 400 * 100) / 100;
    if (typeof v === 'string' && /shubham|fleek|joinfleek/i.test(v)) return v.replace(/[A-Za-z]*shubhamparashar[A-Za-z]*/g, 'you').replace(/fleek-api/g, 'acme-api').replace(/joinfleek/g, 'acme');
    return v;
}

const scrub = (path, body) => {
    let json;
    try { json = JSON.parse(body); } catch { return body; }
    if (path.startsWith('/api/sessions') && Array.isArray(json.sessions)) {
        json.sessions = json.sessions.map(scrubSession);
    }
    return JSON.stringify(scrubGeneric(json));
};

// ---- proxy ----------------------------------------------------------------
const proxy = http.createServer((req, res) => {
    if (req.url.startsWith('/api/events')) { res.writeHead(204).end(); return; }   // no SSE in a still
    const headersOut = { ...req.headers, 'accept-encoding': 'identity' };
    const up = http.request({ host: '127.0.0.1', port: UPSTREAM, path: req.url, method: req.method, headers: headersOut }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
            const raw = Buffer.concat(chunks);
            const isJson = (r.headers['content-type'] || '').includes('json');
            const body = isJson ? Buffer.from(scrub(req.url, raw.toString('utf8'))) : raw;
            const headers = { ...r.headers };
            delete headers['content-encoding'];
            delete headers['transfer-encoding'];
            headers['content-length'] = body.length;
            res.writeHead(r.statusCode, headers).end(body);
        });
    });
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
});

// ---- run ------------------------------------------------------------------
const ping = await fetch(`http://127.0.0.1:${UPSTREAM}/api/status`).catch(() => null);
if (!ping?.ok) { console.error(`no server on :${UPSTREAM} - start it with \`node server.mjs\` first`); process.exit(1); }
if (!CHROME) { console.error('no Chrome/Chromium found'); process.exit(1); }

mkdirSync(dirname(OUT), { recursive: true });
await new Promise((r) => proxy.listen(PROXY, '127.0.0.1', r));

const shot = spawnSync(CHROME, [
    '--headless=old', '--disable-gpu', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-sync', '--disable-component-update', `--user-data-dir=/tmp/shot-${Date.now()}`,
    `--window-size=${SIZE}`, '--force-device-scale-factor=2',
    '--virtual-time-budget=6000', `--screenshot=${OUT}`,
    `http://127.0.0.1:${PROXY}/`,
], { stdio: 'ignore', timeout: 90_000 });

proxy.close();
console.log(shot.status === 0 ? `wrote ${OUT}` : 'chrome failed');
process.exit(shot.status ?? 1);
