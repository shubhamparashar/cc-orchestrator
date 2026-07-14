// Subscription rate-limit gauges (the Claude Desktop /usage view), fetched from
// the OAuth usage endpoint with the token Claude Code itself stores. The endpoint
// is undocumented and 429s under frequent polling, so responses are cached and a
// stale payload is served on any fetch failure rather than blanking the UI.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

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

let cache = { fetchedAt: 0, data: null, plan: null, error: null };

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
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        cache = { fetchedAt: t, data, plan: { subscriptionType: creds.subscriptionType, rateLimitTier: creds.rateLimitTier }, error: null };
    } catch (err) {
        cache = { ...cache, fetchedAt: t, error: err.message };
    }
    return cache;
}

export function resetLimitsCache() {
    cache = { fetchedAt: 0, data: null, plan: null, error: null };
}
