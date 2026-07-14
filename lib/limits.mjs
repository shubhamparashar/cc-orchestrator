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
const TTL_MS = 5 * 60 * 1000;

let cache = { fetchedAt: 0, data: null, error: null };

async function oauthToken() {
    if (process.platform === 'darwin') {
        try {
            const { stdout } = await execFileP('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
            const tok = JSON.parse(stdout.trim())?.claudeAiOauth?.accessToken;
            if (tok) return tok;
        } catch { /* fall through to the credentials file */ }
    }
    const raw = await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8');
    const d = JSON.parse(raw);
    const tok = d?.claudeAiOauth?.accessToken || d?.accessToken;
    if (!tok) throw new Error('no OAuth access token found');
    return tok;
}

export async function subscriptionLimits({ getToken = oauthToken, fetchFn = fetch, now = Date.now } = {}) {
    const t = now();
    if (t - cache.fetchedAt < TTL_MS && cache.data) return cache;
    try {
        const token = await getToken();
        const res = await fetchFn(USAGE_URL, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'anthropic-beta': 'oauth-2025-04-20',
                'Content-Type': 'application/json',
            },
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        cache = { fetchedAt: t, data, error: null };
    } catch (err) {
        cache = { fetchedAt: t, data: cache.data, error: err.message };
    }
    return cache;
}

export function resetLimitsCache() {
    cache = { fetchedAt: 0, data: null, error: null };
}
