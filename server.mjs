#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanSessions, PROJECTS_DIR, readSlice, parseLines, textOfContent, isSyntheticUserText } from './lib/scan.mjs';
import { liveSessions, SESSIONS_DIR } from './lib/live.mjs';
import { desktopSessions, DESKTOP_SESSIONS_DIR } from './lib/desktop.mjs';
import { sessionUsageByModel, pruneUsageCache, usageByDateModel, rollupFromDaily, rollupToCsv, mergeUsageByModel } from './lib/cost.mjs';
import {
    subagentUsageByModel, subagentDateModel, subagentFilesFor, pruneSubagentCaches,
} from './lib/subagents.mjs';
import { sessionTasks } from './lib/tasks.mjs';
import { sessionHealth, pruneHealthCache } from './lib/health.mjs';
import { recentPrompts } from './lib/history.mjs';
import { loadConfig, ALERT_DEFAULTS } from './lib/config.mjs';
import { checkAlerts } from './lib/alerts.mjs';
import { startLiveRefresh } from './lib/watch.mjs';
import { log } from './lib/logger.mjs';
import { sanitizedEnv, issueUrl } from './lib/diag.mjs';
import { costSummary, loadPricing } from './lib/pricing.mjs';
import { sendPrompt, listJobs, stopJob, dismissJob, attachInTerminal, attachCommand, buildLaunchCommand, launchInTerminal } from './lib/actions.mjs';
import { CONTEXTS_DIR, contextPathFor, isSessionUuid, listContextSessions, loadIndex, readContext } from './lib/contextStore.mjs';
import { buildSessionIndex } from './lib/sessionIndex.mjs';
import { rankDocs } from './lib/rank.mjs';
import {
    COOKIE_NAME, getCookie, getToken, hostAllowed, isLocalRequest, isSecureRequest,
    rateLimitKey, recordFailure, remoteLink, setCookieHeader, tokenMatches, tooManyFailures,
} from './lib/auth.mjs';

// Node >= 20 baseline. On macOS/Windows live refresh uses recursive fs.watch
// (best on >= 20); on Linux, where recursive fs.watch is unavailable, lib/watch.mjs
// falls back to polling. Fail loudly at startup rather than degrade silently.
const NODE_MAJOR = Number.parseInt(process.versions.node, 10);
if (Number.isFinite(NODE_MAJOR) && NODE_MAJOR < 20) {
    console.error(
        `cc-orchestrator requires Node >= 20. ` +
        `You are running Node ${process.versions.node}. Upgrade Node and retry.`,
    );
    process.exit(1);
}

const PORT = Number(process.env.PORT || 7433);
const LAN_MODE = process.env.CC_LAN === '1';
const HOST = LAN_MODE ? '0.0.0.0' : '127.0.0.1';
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

// AFK alerts config. The subsystem defaults to disabled, so this is a no-op for
// users who haven't opted in via <config-dir>/config.json.
const cfg = loadConfig({ alerts: ALERT_DEFAULTS });

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
    // Sub-agent (Explore/Task/workflow) spend lives in nested transcripts the
    // parent's own usage map omits; the parent only carries a model-less Agent
    // rollup on user lines, which the cost accumulator (assistant-only) never
    // counts — so merging the sub-agent map in is purely additive, no double-count.
    const liveSubPaths = new Set();
    await mapLimit(sessions, 8, async (s) => {
        try {
            const own = await sessionUsageByModel(
                join(PROJECTS_DIR, s.projectDir, `${s.sessionId}.jsonl`),
            );
            const sub = await subagentUsageByModel(PROJECTS_DIR, s.projectDir, s.sessionId);
            // Merge into a fresh map so neither the cost cache (own) nor the
            // subagent cache (sub) is mutated in place by the token accumulation.
            const byModel = mergeUsageByModel(mergeUsageByModel({}, own), sub);
            const subFiles = await subagentFilesFor(PROJECTS_DIR, s.projectDir, s.sessionId);
            for (const { jsonlPath } of subFiles) liveSubPaths.add(jsonlPath);
            s.subagents = subFiles.length;
            const subSummary = costSummary(sub, pricing);
            s.subagentCost = subSummary.totalUsd;
            s.cost = costSummary(byModel, pricing);
        } catch {
            s.cost = null;
            s.subagents = 0;
            s.subagentCost = 0;
        }
    });
    pruneSubagentCaches(liveSubPaths);
}

function transcriptPaths(sessions) {
    const paths = new Map();
    for (const s of sessions) {
        paths.set(s, join(PROJECTS_DIR, s.projectDir, `${s.sessionId}.jsonl`));
    }
    return paths;
}

// TodoWrite progress per session (A1) — reads the ~/.claude/tasks mirror by id.
async function attachTasks(sessions) {
    await mapLimit(sessions, 8, async (s) => {
        try {
            s.tasks = await sessionTasks(s.sessionId);
        } catch {
            s.tasks = null;
        }
    });
}

// Tool-mix + error-rate + compaction signals per session (A2). Same (size,mtime)
// cache discipline as attachCost; prune entries for transcripts no longer listed.
async function attachHealth(sessions) {
    const paths = transcriptPaths(sessions);
    pruneHealthCache(new Set(paths.values()));
    await mapLimit(sessions, 8, async (s) => {
        try {
            s.health = await sessionHealth(paths.get(s));
        } catch {
            s.health = null;
        }
    });
}

async function getSessions() {
    const [liveBySession, desktopBySession, ctxIds] = await Promise.all([
        liveSessions(),
        desktopSessions(),
        listContextSessions(),
    ]);
    const sessions = await scanSessions({ liveBySession, desktopBySession });
    for (const s of sessions) s.hasContext = ctxIds.has(s.sessionId);
    await Promise.all([attachCost(sessions), attachTasks(sessions), attachHealth(sessions)]);
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

// Per-day × per-model token rollup, priced, across the given sessions. Shared by
// the /api/cost/rollup handler and the budget alert so both compute spend the same way.
async function costRollup(sessions, window) {
    const pricing = loadPricing();
    // Two day×model maps per session — its own transcript plus its sub-agents —
    // both fed to the rollup so the cost-over-time view and the budget alert
    // include sub-agent spend (additive, same no-double-count guarantee as attachCost).
    const perSession = await mapLimit(sessions, 8, async (s) => {
        const own = await usageByDateModel(join(PROJECTS_DIR, s.projectDir, `${s.sessionId}.jsonl`)).catch(() => ({}));
        const sub = await subagentDateModel(PROJECTS_DIR, s.projectDir, s.sessionId).catch(() => ({}));
        return [own, sub];
    });
    const dailyMaps = perSession.flat();
    return rollupFromDaily(dailyMaps, { window, pricing });
}

// Today's (UTC) total spend in USD across all scanned sessions, for the budget alert.
async function getTodayUsd() {
    const sessions = await getSessionsShared();
    const rollup = await costRollup(sessions, 'day');
    const today = new Date().toISOString().slice(0, 10);
    const bucket = rollup.buckets.find((b) => b.date === today);
    return bucket?.usd ?? 0;
}

// Tier-1 index build over ALL sessions (free, transcript-derived). Single-flight
// so the startup build, the periodic refresh, and /api/reindex never overlap.
let inFlightIndex = null;
function reindex() {
    if (!inFlightIndex) {
        inFlightIndex = buildSessionIndex().finally(() => { inFlightIndex = null; });
    }
    return inFlightIndex;
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

const SESSION_FILE_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const transcriptBroadcastTimers = new Map();

// A streaming response appends to its .jsonl many times a second; collapse that
// burst into at most one 'transcript' nudge per session per window.
function broadcastTranscript(sessionId) {
    if (transcriptBroadcastTimers.has(sessionId)) return;
    transcriptBroadcastTimers.set(sessionId, setTimeout(() => {
        transcriptBroadcastTimers.delete(sessionId);
        if (sseClients.size) broadcast('transcript', { sessionId });
    }, 300));
}

// A project-file change both refreshes the session list and, when it is a
// transcript write, tells any open in-app chat viewer which session changed.
function onProjectsChange(eventType, filename) {
    scheduleRefresh();
    if (!filename || !sseClients.size) return;
    const m = String(filename).match(SESSION_FILE_RE);
    if (m) broadcastTranscript(m[1]);
}

// Rank candidates for a query (chat launcher) or for a session (modal "related"
// tab). The Tier-1 index already covers ALL sessions (transcript-derived body +
// any context.md), so we rank it directly and enrich with live scanner state;
// brand-new sessions not yet in the index are folded in from the live scan.
async function relatedSessions({ q, repo, forSession }) {
    const [index, sessions] = await Promise.all([loadIndex(), getSessionsShared()]);
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    const docs = [];
    const seen = new Set();
    for (const e of index) {
        // A sub-agent entry shares its parent's sessionId; skip it on the parent's
        // own "related" tab (a session isn't related to its own sub-agents), but
        // give it a unique doc id and carry its sub-agent identity through so a hit
        // renders distinctly and still navigates to the parent session.
        if (e.kind === 'subagent') {
            if (e.parentSessionId === forSession) continue;
            const parentLive = byId.get(e.parentSessionId);
            if (parentLive?.isArchived) continue;
            docs.push({
                id: `sub:${e.agentId}`,
                kind: 'subagent',
                parentSessionId: e.parentSessionId,
                agentType: e.agentType || 'subagent',
                description: e.description || e.title || '',
                title: e.title || null,
                tags: e.tags || [],
                goal: null,
                repo: e.repo || parentLive?.repo || null,
                body: e.body || '',
                updatedMs: Math.max(e.updated || 0, parentLive?.lastActivityAt || 0),
                contextPath: null,
                cwd: parentLive?.cwd || null,
                _live: parentLive || null,
            });
            continue;
        }
        if (e.sessionId === forSession) continue;
        const live = byId.get(e.sessionId);
        if (live?.isArchived) continue;
        seen.add(e.sessionId);
        docs.push({
            id: e.sessionId,
            title: e.title || live?.title || null,
            tags: e.tags || [],
            goal: e.goal,
            repo: e.repo || live?.repo || null,
            work: e.work || '',
            body: e.body || '',
            updatedMs: Math.max(e.updated || 0, live?.lastActivityAt || 0),
            contextPath: e.contextPath || null,
            cwd: e.cwd || live?.cwd || null,
            _live: live || null,
        });
    }
    // sessions created since the last index build
    for (const s of sessions) {
        if (seen.has(s.sessionId) || s.sessionId === forSession || s.isArchived) continue;
        docs.push({
            id: s.sessionId, title: s.title, tags: [s.repo].filter(Boolean), goal: null, repo: s.repo,
            body: `${s.lastUser || ''} ${s.lastAssistant || ''}`, updatedMs: s.lastActivityAt,
            contextPath: null, cwd: s.cwd, _live: s,
        });
    }
    let query = q;
    let repoBoost = repo;
    if (forSession && isSessionUuid(forSession)) {
        const self = index.find((e) => !e.kind && e.sessionId === forSession);
        const ownLive = byId.get(forSession);
        query = [self?.title, self?.goal, (self?.tags || []).join(' '), self?.body, ownLive?.title]
            .filter(Boolean).join(' ').slice(0, 1500);
        repoBoost = repoBoost || self?.repo || ownLive?.repo || null;
    }
    // Rank a wider slate, then collapse: keep at most one hit per (kind, parent
    // session) so a session whose many sub-agents all match the query doesn't crowd
    // the list with near-duplicate "↳" rows, and a session already surfaced on its
    // own merits isn't shadowed by one of its sub-agents. Highest score wins per key.
    const ranked = rankDocs(query, docs, { repo: repoBoost, limit: 24 });
    const out = [];
    const taken = new Set();
    for (const { doc, score } of ranked) {
        const isSub = doc.kind === 'subagent';
        const sessionId = isSub ? doc.parentSessionId : doc.id;
        const key = `${isSub ? 'sub' : 'session'}:${sessionId}`;
        if (taken.has(key)) continue;
        taken.add(key);
        const live = byId.get(sessionId) || doc._live;
        out.push({
            sessionId,
            kind: isSub ? 'subagent' : 'session',
            agentType: isSub ? doc.agentType : null,
            description: isSub ? doc.description : null,
            title: doc.title,
            repo: doc.repo,
            goal: doc.goal,
            contextPath: doc.contextPath,
            cwd: live?.cwd || doc.cwd,
            status: live?.status || 'idle',
            contextPct: live?.contextPct ?? null,
            updated: doc.updatedMs,
            score: Math.round(score * 10) / 10,
        });
        if (out.length >= 8) break;
    }
    return out;
}

const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
const TRANSCRIPT_MAX_MESSAGES = 200;

async function transcriptPathFor(sessionId) {
    let dirs;
    try {
        dirs = await readdir(PROJECTS_DIR);
    } catch {
        return null;
    }
    for (const dir of dirs) {
        const p = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
        try {
            await stat(p);
            return p;
        } catch {
            // not in this project dir
        }
    }
    return null;
}

// Chat-only view of a transcript: human/assistant text turns only — no tool
// calls, tool results, thinking, or harness-injected synthetic turns.
async function readTranscript(path, since = 0) {
    const st = await stat(path);
    const start = Math.max(0, st.size - TRANSCRIPT_TAIL_BYTES);
    const text = await readSlice(path, start, Math.min(st.size, TRANSCRIPT_TAIL_BYTES));
    const records = parseLines(text);
    const out = [];
    for (const r of records) {
        if (!r || !r.message) continue;
        const ts = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : 0;
        if (since && ts && ts <= since) continue;
        if (r.type === 'assistant') {
            const t = textOfContent(r.message.content);
            if (t && t.trim()) out.push({ role: 'assistant', text: t, ts: ts || 0 });
        } else if (r.type === 'user' && !r.isMeta) {
            const t = textOfContent(r.message.content);
            if (t && t.trim() && !isSyntheticUserText(t)) out.push({ role: 'user', text: t, ts: ts || 0 });
        }
    }
    return out.slice(-TRANSCRIPT_MAX_MESSAGES);
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
    }

    // CSRF: every state-changing request must carry the first-party X-CC header.
    // A cross-origin <form> or "simple" fetch cannot set a custom header without a
    // CORS preflight, which this server never answers — so this blocks drive-by
    // POSTs from a malicious page. Enforced on loopback too, where requests are
    // otherwise tokenless; the dashboard sends X-CC:1 on every mutating fetch.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-cc'] !== '1') {
        return sendJson(res, 403, { error: 'missing X-CC header' });
    }

    try {
        if (req.method === 'GET' && url.pathname === '/healthz') {
            return sendJson(res, 200, { ok: true, at: Date.now() });
        }
        if (req.method === 'GET' && url.pathname === '/') {
            const html = await readFile(join(PUBLIC_DIR, 'index.html'));
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
            return res.end(html);
        }
        if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
            const { file, type } = STATIC_FILES[url.pathname];
            const body = await readFile(join(PUBLIC_DIR, file));
            res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
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
        if (req.method === 'GET' && url.pathname === '/api/diag') {
            // Only a loopback caller (the Mac itself, single user) gets the last
            // server error prefilled — never bleed one viewer's error into another
            // viewer's report on a shared (Tailscale/LAN) dashboard.
            return sendJson(res, 200, { env: sanitizedEnv(), issueUrl: issueUrl({ error: local ? lastError : null }) });
        }
        if (req.method === 'GET' && url.pathname === '/api/history') {
            const q = url.searchParams.get('q') || '';
            const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
            return sendJson(res, 200, await recentPrompts({ q, limit }));
        }
        if (req.method === 'GET' && url.pathname === '/api/cost/rollup') {
            const w = url.searchParams.get('window');
            const window = ['day', 'week', 'month'].includes(w) ? w : 'day';
            const sessions = await getSessionsShared();
            const rollup = await costRollup(sessions, window);
            if (url.searchParams.get('format') === 'csv') {
                res.writeHead(200, {
                    'Content-Type': 'text/csv; charset=utf-8',
                    'Content-Disposition': `attachment; filename="cc-cost-${window}.csv"`,
                });
                return res.end(rollupToCsv(rollup));
            }
            return sendJson(res, 200, rollup);
        }
        if (req.method === 'POST' && url.pathname === '/api/reindex') {
            const entries = await reindex();
            return sendJson(res, 200, { ok: true, sessions: entries.length });
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
        if (req.method === 'GET' && url.pathname.startsWith('/api/transcript/')) {
            const id = url.pathname.slice('/api/transcript/'.length);
            if (!isSessionUuid(id)) return sendJson(res, 400, { error: 'invalid session id' });
            const path = await transcriptPathFor(id);
            if (!path) return sendJson(res, 404, { error: 'no transcript for this session' });
            const since = Number(url.searchParams.get('since')) || 0;
            return sendJson(res, 200, await readTranscript(path, since));
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
        if (req.method === 'POST' && url.pathname === '/api/jobs/dismiss') {
            const { id } = await readBody(req);
            return sendJson(res, 200, { dismissed: dismissJob(Number(id)) });
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
        const code = err.statusCode || 500;
        // Server faults (5xx) feed the consent-gated bug report at /api/diag; client
        // errors (4xx) are expected and not recorded.
        if (code >= 500) {
            lastError = err.stack || err.message;
            log.error(`${req.method} ${url.pathname} → ${code}: ${err.stack || err.message}`);
        }
        sendJson(res, code, { error: err.message });
    }
};

// Most recent server-side fault, surfaced (sanitized) by /api/diag's issue link.
let lastError = null;

process.on('unhandledRejection', (reason) => {
    lastError = reason?.stack || String(reason);
    log.error(`unhandledRejection: ${reason?.stack || reason}`);
});
process.on('uncaughtException', (err) => {
    log.error(`uncaughtException: ${err?.stack || err}`);
    process.exit(1); // preserve crash semantics — log, then exit
});

const server = createServer(handler);
server.on('error', (err) => {
    log.error(`listen failed on ${HOST}:${PORT}: ${err.message}`);
    process.exit(1);
});
server.listen(PORT, HOST, () => {
    log.info(`cc-orchestrator: http://127.0.0.1:${PORT}`);
    if (LAN_MODE) {
        const link = remoteLink(PORT);
        if (link.url) log.info(`LAN: ${link.url} (token required — open ${link.url}/login?key=… or the 📱 panel)`);
    }
    const refresh = startLiveRefresh({
        projectsDir: PROJECTS_DIR,
        sessionsDir: SESSIONS_DIR,
        desktopDir: DESKTOP_SESSIONS_DIR,
        onProjectsChange,
        scheduleRefresh,
        onWarn: (m) => log.warn(m),
    });
    log.info(`live refresh: ${refresh.mode}`);
    // Build the Tier-1 index over ALL sessions on first run (free), then keep it
    // fresh on an interval. Background — never blocks serving.
    reindex().then((e) => log.info(`session index: ${e.length} sessions`)).catch(() => {});
    setInterval(() => { reindex().catch(() => {}); }, 5 * 60 * 1000);
    // AFK alerts: fire OS notifications for waiting-session digests / budget
    // crossings. Opt-in — only scheduled when the config enables it.
    if (cfg.alerts.enabled) {
        log.info(`AFK alerts enabled (every ${cfg.alerts.checkIntervalMs}ms)`);
        setInterval(
            () => checkAlerts({ getSessions: getSessionsShared, getTodayUsd, config: cfg, now: Date.now() }).catch(() => {}),
            cfg.alerts.checkIntervalMs,
        );
    }
});

// Browsers may resolve "localhost" to ::1 first; listen there too so those
// requests don't stall waiting for an IPv6 server that doesn't exist. In LAN
// mode bind all IPv6 interfaces too.
const serverV6 = createServer(handler);
serverV6.on('error', () => { /* IPv6 unavailable — IPv4 listener is enough */ });
serverV6.listen(PORT, LAN_MODE ? '::' : '::1');
