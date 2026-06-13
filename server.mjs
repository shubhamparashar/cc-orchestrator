import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanSessions, PROJECTS_DIR } from './lib/scan.mjs';
import { liveSessions, SESSIONS_DIR } from './lib/live.mjs';
import { desktopSessions } from './lib/desktop.mjs';
import { sessionUsageByModel, pruneUsageCache } from './lib/cost.mjs';
import { costSummary, loadPricing } from './lib/pricing.mjs';
import { sendPrompt, listJobs, stopJob, attachInTerminal, attachCommand, buildLaunchCommand, launchInTerminal } from './lib/actions.mjs';
import { CONTEXTS_DIR, contextPathFor, isSessionUuid, loadIndex, readContext } from './lib/contextStore.mjs';
import { rankDocs } from './lib/rank.mjs';
import {
    COOKIE_NAME, getCookie, getToken, hostAllowed, isLocalRequest, isSecureRequest,
    rateLimitKey, recordFailure, remoteLink, setCookieHeader, tokenMatches, tooManyFailures,
} from './lib/auth.mjs';

const PORT = Number(process.env.PORT || 7433);
const LAN_MODE = process.env.CC_LAN === '1';
const HOST = LAN_MODE ? '0.0.0.0' : '127.0.0.1';
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

const STATIC_FILES = {
    '/manifest.json': { file: 'manifest.json', type: 'application/manifest+json' },
    '/icon.svg': { file: 'icon.svg', type: 'image/svg+xml' },
};

const sseClients = new Set();

function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(payload);
}

// Run async work over items with a bounded number in flight at once.
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

async function attachCost(sessions) {
    const pricing = loadPricing();
    const livePaths = new Set();
    for (const s of sessions) {
        livePaths.add(join(PROJECTS_DIR, s.projectDir, `${s.sessionId}.jsonl`));
    }
    pruneUsageCache(livePaths);
    await mapLimit(sessions, 8, async (s) => {
        try {
            const byModel = await sessionUsageByModel(
                join(PROJECTS_DIR, s.projectDir, `${s.sessionId}.jsonl`),
            );
            s.cost = costSummary(byModel, pricing);
        } catch {
            s.cost = null;
        }
    });
}

async function getSessions() {
    const [liveBySession, desktopBySession, index] = await Promise.all([
        liveSessions(),
        desktopSessions(),
        loadIndex(),
    ]);
    const sessions = await scanSessions({ liveBySession, desktopBySession });
    const contextIds = new Set(index.map((e) => e.sessionId));
    for (const s of sessions) s.hasContext = contextIds.has(s.sessionId);
    await attachCost(sessions);
    return sessions;
}

// Concurrent requests share one scan; results staler than one scan-duration are fine here.
let inFlightScan = null;

function getSessionsShared() {
    if (!inFlightScan) {
        inFlightScan = getSessions().finally(() => {
            inFlightScan = null;
        });
    }
    return inFlightScan;
}

let scanTimer = null;

function scheduleRefresh() {
    if (scanTimer) return;
    scanTimer = setTimeout(async () => {
        scanTimer = null;
        if (!sseClients.size) return;
        try {
            const sessions = await getSessionsShared();
            broadcast('sessions', sessions);
        } catch {
            broadcast('refresh', { at: Date.now() });
        }
    }, 1000);
}

function watchSafe(path, opts) {
    try {
        watch(path, opts, scheduleRefresh);
    } catch (err) {
        console.warn(`watch failed for ${path}: ${err.message}`);
    }
}

// Rank candidates for a query (chat launcher) or for a session (modal "related"
// tab). Docs = context-index entries enriched with live scanner state, plus live
// sessions that have no context yet (matched on title + last messages).
async function relatedSessions({ q, repo, forSession }) {
    const [index, sessions] = await Promise.all([loadIndex(), getSessionsShared()]);
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    const docs = [];
    const indexed = new Set();
    for (const e of index) {
        if (e.sessionId === forSession) continue;
        const live = byId.get(e.sessionId);
        if (live?.isArchived) continue;
        indexed.add(e.sessionId);
        docs.push({
            id: e.sessionId,
            title: e.title || live?.title || null,
            tags: e.tags || [],
            goal: e.goal,
            repo: e.repo || live?.repo || null,
            body: '',
            updatedMs: Math.max(e.updated || 0, live?.lastActivityAt || 0),
            path: e.path,
            cwd: e.cwd || live?.cwd || null,
            _live: live || null,
        });
    }
    for (const s of sessions) {
        if (indexed.has(s.sessionId) || s.sessionId === forSession || s.isArchived) continue;
        docs.push({
            id: s.sessionId,
            title: s.title,
            tags: [],
            goal: null,
            repo: s.repo,
            body: `${s.lastUser || ''} ${s.lastAssistant || ''}`,
            updatedMs: s.lastActivityAt,
            path: null,
            cwd: s.cwd,
            _live: s,
        });
    }
    let query = q;
    let repoBoost = repo;
    if (forSession && isSessionUuid(forSession)) {
        const own = await readContext(forSession);
        const ownLive = byId.get(forSession);
        const tagText = (own?.meta?.tags || []).join(' ');
        query = [own?.meta?.title, own?.goal, tagText, ownLive?.title].filter(Boolean).join(' ');
        repoBoost = repoBoost || own?.meta?.repo || ownLive?.repo || null;
    }
    const ranked = rankDocs(query, docs, { repo: repoBoost, limit: 8 });
    return ranked.map(({ doc, score }) => ({
        sessionId: doc.id,
        title: doc.title,
        repo: doc.repo,
        goal: doc.goal,
        contextPath: doc.path,
        cwd: doc._live?.cwd || doc.cwd,
        status: doc._live?.status || 'idle',
        contextPct: doc._live?.contextPct ?? null,
        updated: doc.updatedMs,
        score: Math.round(score * 10) / 10,
    }));
}

const MAX_BODY_BYTES = 1024 * 1024;

async function readBody(req) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        const err = new Error('payload too large');
        err.statusCode = 413;
        throw err;
    }
    let size = 0;
    const parts = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            req.destroy();
            const err = new Error('payload too large');
            err.statusCode = 413;
            throw err;
        }
        parts.push(chunk);
    }
    const raw = Buffer.concat(parts).toString('utf8');
    return raw ? JSON.parse(raw) : {};
}

function sendJson(res, code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function escHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function sendLoginPage(res, code, message) {
    const note = message ? `<p class="err">${escHtml(message)}</p>` : '';
    const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>cc-orchestrator — sign in</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0c10;color:#e8edf4;font:15px/1.5 -apple-system,system-ui,sans-serif}
form{background:#11151c;border:1px solid #1f2630;border-radius:16px;padding:26px;width:min(360px,92vw);box-shadow:0 8px 24px rgba(0,0,0,.4)}
h1{font-size:16px;margin:0 0 4px;background:linear-gradient(90deg,#22d3ee,#6366f1);-webkit-background-clip:text;background-clip:text;color:transparent}
p{color:#8b96a5;font-size:13px;margin:0 0 16px}.err{color:#f87171}
input{width:100%;box-sizing:border-box;background:#0a0c10;border:1px solid #1f2630;border-radius:9px;padding:11px;color:#e8edf4;font:inherit;outline:none}
input:focus{border-color:#6366f1}button{width:100%;margin-top:12px;background:linear-gradient(120deg,#6366f1,#4f46e5);border:none;border-radius:9px;padding:12px;color:#fff;font:inherit;font-weight:600;cursor:pointer}</style></head>
<body><form method="GET" action="/login"><h1>cc-orchestrator</h1><p>Enter your access token to continue.</p>${note}
<input type="password" name="key" placeholder="access token" autocomplete="off" autofocus>
<button type="submit">Sign in</button></form></body></html>`;
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
}

function wantsHtml(req, url) {
    if (req.method !== 'GET') return false;
    if (url.pathname.startsWith('/api/')) return false;
    return url.pathname === '/' || (req.headers.accept || '').includes('text/html');
}

const handler = async (req, res) => {
    if (!hostAllowed(req.headers.host)) {
        return sendJson(res, 403, { error: 'forbidden host' });
    }
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const local = isLocalRequest(req);

    // Remote (non-loopback / proxied) requests must present the token.
    if (!local) {
        const ip = rateLimitKey(req);
        if (url.pathname === '/login') {
            if (tooManyFailures(ip)) return sendJson(res, 429, { error: 'too many attempts, wait a minute' });
            if (tokenMatches(url.searchParams.get('key'))) {
                res.writeHead(302, {
                    'Set-Cookie': setCookieHeader(getToken(), isSecureRequest(req)),
                    Location: '/',
                });
                return res.end();
            }
            recordFailure(ip);
            return sendLoginPage(res, 401, url.searchParams.get('key') ? 'Invalid token.' : '');
        }
        if (!tokenMatches(getCookie(req, COOKIE_NAME))) {
            if (tooManyFailures(ip)) return sendJson(res, 429, { error: 'too many attempts, wait a minute' });
            recordFailure(ip);
            if (wantsHtml(req, url)) return sendLoginPage(res, 401, '');
            return sendJson(res, 401, { error: 'auth required' });
        }
        // Authenticated remote POSTs need the frontend CSRF header (cookie auth belt).
        if (req.method === 'POST' && req.headers['x-cc'] !== '1') {
            return sendJson(res, 403, { error: 'missing X-CC header' });
        }
    }

    try {
        if (req.method === 'GET' && url.pathname === '/healthz') {
            return sendJson(res, 200, { ok: true, at: Date.now() });
        }
        if (req.method === 'GET' && url.pathname === '/') {
            const html = await readFile(join(PUBLIC_DIR, 'index.html'));
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(html);
        }
        if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
            const { file, type } = STATIC_FILES[url.pathname];
            const body = await readFile(join(PUBLIC_DIR, file));
            res.writeHead(200, { 'Content-Type': type });
            return res.end(body);
        }
        if (req.method === 'GET' && url.pathname === '/api/phone-link') {
            const link = remoteLink(PORT);
            const body = { url: link.url, mode: link.mode };
            // Only a loopback caller (the Mac itself) gets the raw token / one-tap link.
            if (local && link.url) {
                body.token = getToken();
                body.oneTap = `${link.url}/login?key=${getToken()}`;
            }
            return sendJson(res, 200, body);
        }
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
            return sendJson(res, 200, await getSessionsShared());
        }
        if (req.method === 'GET' && url.pathname === '/api/jobs') {
            return sendJson(res, 200, listJobs());
        }
        if (req.method === 'GET' && url.pathname === '/api/pricing') {
            return sendJson(res, 200, loadPricing());
        }
        if (req.method === 'GET' && url.pathname === '/api/related') {
            const q = url.searchParams.get('q') || '';
            const repo = url.searchParams.get('repo') || null;
            const forSession = url.searchParams.get('session') || null;
            return sendJson(res, 200, await relatedSessions({ q, repo, forSession }));
        }
        if (req.method === 'GET' && url.pathname.startsWith('/api/context/')) {
            const id = url.pathname.slice('/api/context/'.length);
            if (!isSessionUuid(id)) return sendJson(res, 400, { error: 'invalid session id' });
            const ctx = await readContext(id);
            if (!ctx) return sendJson(res, 404, { error: 'no context for this session' });
            return sendJson(res, 200, { path: ctx.path, meta: ctx.meta, content: ctx.content, goal: ctx.goal });
        }
        if (req.method === 'POST' && url.pathname === '/api/launch') {
            const { prompt, cwd, sessionId, dry } = await readBody(req);
            if (!prompt || typeof prompt !== 'string') return sendJson(res, 400, { error: 'prompt required' });
            let contextPath = null;
            if (sessionId) {
                if (!isSessionUuid(sessionId)) return sendJson(res, 400, { error: 'invalid session id' });
                const ctx = await readContext(sessionId);
                contextPath = ctx?.path || null;
            }
            const opts = { prompt, cwd, contextPath };
            if (dry) return sendJson(res, 200, { command: buildLaunchCommand(opts), contextPath });
            return sendJson(res, 200, await launchInTerminal(opts));
        }
        if (req.method === 'GET' && url.pathname === '/api/events') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
            });
            res.write('event: hello\ndata: {}\n\n');
            sseClients.add(res);
            req.on('close', () => sseClients.delete(res));
            return;
        }
        if (req.method === 'POST' && url.pathname === '/api/send') {
            const { sessionId, cwd, text, fork } = await readBody(req);
            if (!sessionId || !text) return sendJson(res, 400, { error: 'sessionId and text required' });
            const onUpdate = (job) => {
                const { child, ...safe } = job;
                broadcast('job', safe);
            };
            const job = sendPrompt({ sessionId, cwd, text, fork: Boolean(fork) }, onUpdate);
            return sendJson(res, 202, job);
        }
        if (req.method === 'POST' && url.pathname === '/api/jobs/stop') {
            const { id } = await readBody(req);
            return sendJson(res, 200, { stopped: stopJob(Number(id)) });
        }
        if (req.method === 'POST' && url.pathname === '/api/attach') {
            const { sessionId, cwd } = await readBody(req);
            if (!sessionId) return sendJson(res, 400, { error: 'sessionId required' });
            const result = await attachInTerminal({ sessionId, cwd });
            result.command = attachCommand({ sessionId, cwd });
            return sendJson(res, 200, result);
        }
        sendJson(res, 404, { error: 'not found' });
    } catch (err) {
        sendJson(res, err.statusCode || 500, { error: err.message });
    }
};

const server = createServer(handler);
server.on('error', (err) => {
    console.error(`listen failed on ${HOST}:${PORT}: ${err.message}`);
    process.exit(1);
});
server.listen(PORT, HOST, () => {
    console.log(`cc-orchestrator: http://127.0.0.1:${PORT}`);
    if (LAN_MODE) {
        const link = remoteLink(PORT);
        if (link.url) console.log(`LAN: ${link.url} (token required — open ${link.url}/login?key=… or the 📱 panel)`);
    }
    watchSafe(PROJECTS_DIR, { recursive: true });
    watchSafe(SESSIONS_DIR, {});
    watchSafe(join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions'), {
        recursive: true,
    });
});

// Browsers may resolve "localhost" to ::1 first; listen there too so those
// requests don't stall waiting for an IPv6 server that doesn't exist. In LAN
// mode bind all IPv6 interfaces too.
const serverV6 = createServer(handler);
serverV6.on('error', () => { /* IPv6 unavailable — IPv4 listener is enough */ });
serverV6.listen(PORT, LAN_MODE ? '::' : '::1');
