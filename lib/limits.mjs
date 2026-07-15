// Subscription rate-limit gauges (the Claude Desktop /usage view), fetched from
// the OAuth usage endpoint with the token Claude Code itself stores. The endpoint
// is undocumented and 429s under frequent polling, so responses are cached and a
// stale payload is served on any fetch failure rather than blanking the UI.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { configDir } from './config.mjs';

const execFileP = promisify(execFile);
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TTL_MS = 2 * 60 * 1000;

// A cached payload whose soonest reset has already passed is wrong by
// definition (the gauge would show 'resets now' with pre-reset numbers).
function expired(data, t) {
    for (const l of data?.limits || []) {
        if (l.resets_at && new Date(l.resets_at).getTime() <= t) return true;
    }
    return false;
}

// Last good payload persists to disk so a restart mid-rate-limit still has
// something to show instead of "unavailable".
function cachePath() {
    return join(configDir(), 'limits-cache.json');
}

function loadPersisted() {
    try {
        const c = JSON.parse(readFileSync(cachePath(), 'utf8'));
        if (c && typeof c === 'object') return { fetchedAt: c.fetchedAt || 0, data: c.data || null, plan: c.plan || null, error: null, cooldownUntil: c.cooldownUntil || 0 };
    } catch { /* no persisted cache */ }
    return { fetchedAt: 0, data: null, plan: null, error: null, cooldownUntil: 0 };
}

function persist() {
    try {
        mkdirSync(configDir(), { recursive: true, mode: 0o700 });
        writeFileSync(cachePath(), JSON.stringify({ fetchedAt: cache.fetchedAt, data: cache.data, plan: cache.plan, cooldownUntil }), { mode: 0o600 });
    } catch { /* best effort */ }
}

const persisted = loadPersisted();
let cache = { fetchedAt: persisted.fetchedAt, data: persisted.data, plan: persisted.plan, error: null };

// Failed fetches must not retry on every request: an expired-but-unrefreshable
// payload would otherwise bypass the TTL each time and hammer the endpoint,
// which answers sustained polling with 429s. Rate-limit errors get a long
// cooldown, other failures a short one; a success clears it.
// Persisted with the cache: the upstream rate-limit window RE-ARMS on every
// request made inside it, so a restart that forgets the cooldown and retries
// immediately keeps the account blocked indefinitely.
let cooldownUntil = persisted.cooldownUntil;

async function oauthCreds() {
    let oauth = null;
    if (process.platform === 'darwin') {
        try {
            const { stdout } = await execFileP('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
            oauth = JSON.parse(stdout.trim())?.claudeAiOauth || null;
        } catch { /* fall through to the credentials file */ }
    }
    if (!oauth?.accessToken) {
        const raw = await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8');
        const d = JSON.parse(raw);
        oauth = d?.claudeAiOauth || d;
    }
    if (!oauth?.accessToken) throw new Error('no OAuth access token found');
    return {
        token: oauth.accessToken,
        subscriptionType: oauth.subscriptionType || null,
        rateLimitTier: oauth.rateLimitTier || null,
    };
}

export async function subscriptionLimits({ getCreds = oauthCreds, fetchFn = fetch, now = Date.now } = {}) {
    const t = now();
    if (t < cooldownUntil) return cache;
    if (t - cache.fetchedAt < TTL_MS && cache.data && !expired(cache.data, t)) return cache;
    try {
        const creds = await getCreds();
        const res = await fetchFn(USAGE_URL, {
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'anthropic-beta': 'oauth-2025-04-20',
                'Content-Type': 'application/json',
            },
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
            const ra = Number(res.headers?.get?.('retry-after'));
            const e = new Error(`HTTP ${res.status}`);
            if (Number.isFinite(ra) && ra > 0) e.retryAfterMs = Math.min(ra * 1000, 60 * 60_000);
            throw e;
        }
        const data = await res.json();
        cache = { fetchedAt: t, data, plan: { subscriptionType: creds.subscriptionType, rateLimitTier: creds.rateLimitTier }, error: null };
        cooldownUntil = 0;
        persist();
    } catch (err) {
        cache = { ...cache, fetchedAt: t, error: err.message };
        cooldownUntil = t + (err.retryAfterMs ?? (/429/.test(err.message) ? 10 * 60_000 : 60_000));
        persist();
    }
    return cache;
}

export function resetLimitsCache() {
    cache = { fetchedAt: 0, data: null, plan: null, error: null };
    cooldownUntil = 0;
}
