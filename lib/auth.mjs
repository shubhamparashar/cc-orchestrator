import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const CONFIG_DIR = join(homedir(), '.config', 'cc-orchestrator');
const TOKEN_PATH = join(CONFIG_DIR, 'token');
const HOSTS_PATH = join(CONFIG_DIR, 'hosts');
const REMOTE_PATH = join(CONFIG_DIR, 'remote.json');

export const COOKIE_NAME = 'cc_token';

// ── token ──────────────────────────────────────────────────────────────────
let cachedToken = null;

function tighten(path, mode) {
    try {
        chmodSync(path, mode);
    } catch {
        // best-effort: self-heal loose perms (recursive mkdir/writeFile only set
        // mode on creation, never tighten a pre-existing looser path)
    }
}

export function getToken() {
    if (cachedToken) return cachedToken;
    try {
        const existing = readFileSync(TOKEN_PATH, 'utf8').trim();
        if (existing) {
            cachedToken = existing;
            tighten(CONFIG_DIR, 0o700);
            tighten(TOKEN_PATH, 0o600);
            return cachedToken;
        }
    } catch {
        // no token yet — create one
    }
    cachedToken = randomBytes(32).toString('hex');
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    tighten(CONFIG_DIR, 0o700);
    writeFileSync(TOKEN_PATH, `${cachedToken}\n`, { mode: 0o600 });
    return cachedToken;
}

export function tokenMatches(provided) {
    if (typeof provided !== 'string' || !provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(getToken());
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

// ── request classification ───────────────────────────────────────────────────
// A request is "local" (tokenless) only when it is genuinely from this machine:
// loopback socket, no proxy/Tailscale headers, and a loopback Host. Tailscale
// serve proxies from 127.0.0.1 but adds Tailscale-User-Login / X-Forwarded-*, so
// those headers force the remote (token-required) path even on a loopback socket.
export function isLocalRequest(req) {
    // Opt-in hardening: treat every request as remote so the token is required
    // even on loopback — for shared/multi-user machines where any local user or
    // web page hitting 127.0.0.1 would otherwise get tokenless full control.
    if (process.env.CC_REQUIRE_TOKEN_LOCAL === '1') return false;
    const ra = req.socket?.remoteAddress || '';
    const loopbackSocket = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
    if (!loopbackSocket) return false;
    if (req.headers['tailscale-user-login'] || req.headers['x-forwarded-for']) return false;
    const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    return ['127.0.0.1', 'localhost', '::1'].includes(host);
}

export function isSecureRequest(req) {
    return req.headers['x-forwarded-proto'] === 'https';
}

// For display/logging only — NOT a security identity (the first X-Forwarded-For
// hop is client-supplied, since proxies APPEND the real peer).
export function clientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    return req.socket?.remoteAddress || 'unknown';
}

// Rate-limit identity that an attacker can't rotate. Proxy-injected headers are
// trusted only when the request arrives via the local reverse proxy (loopback
// socket, e.g. Tailscale serve): the Tailscale-injected user when present, else
// the LAST X-Forwarded-For hop (the proxy-appended real peer — the leftmost hop
// is client-controlled). A direct LAN/remote peer controls its own headers and
// would otherwise rotate the key on every request to evade the failed-auth
// limit; its socket address is the one identity it can't forge.
export function rateLimitKey(req) {
    const ra = req.socket?.remoteAddress || 'unknown';
    const loopbackSocket = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
    if (loopbackSocket) {
        const tsUser = req.headers['tailscale-user-login'];
        if (tsUser) return `ts:${tsUser}`;
        const xff = req.headers['x-forwarded-for'];
        if (xff) {
            const hops = String(xff).split(',');
            return hops[hops.length - 1].trim();
        }
    }
    return ra;
}

// ── cookies ──────────────────────────────────────────────────────────────────
export function getCookie(req, name) {
    const raw = req.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() === name) {
            const val = part.slice(eq + 1).trim();
            // A malformed %-escape (e.g. a bare "%") makes decodeURIComponent throw.
            // This runs before the request handler's try/catch, so a thrown error
            // would leave the request hanging — fall back to the literal value.
            try {
                return decodeURIComponent(val);
            } catch {
                return val;
            }
        }
    }
    return null;
}

export function setCookieHeader(token, secure) {
    const attrs = ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000'];
    if (secure) attrs.push('Secure');
    return `${COOKIE_NAME}=${encodeURIComponent(token)}; ${attrs.join('; ')}`;
}

// ── failed-auth rate limit (in-memory, per IP) ────────────────────────────────
const WINDOW_MS = 60_000;
const MAX_FAILURES = 10;
const MAX_KEYS = 5000;
const failures = new Map();

function recent(key, now) {
    const arr = (failures.get(key) || []).filter((t) => now - t < WINDOW_MS);
    failures.set(key, arr);
    return arr;
}

export function tooManyFailures(key) {
    return recent(key, Date.now()).length >= MAX_FAILURES;
}

// A successful login proves the key's owner; dropping their accumulated
// failures lets one correct attempt recover immediately instead of waiting
// out the window.
export function clearFailures(key) {
    failures.delete(key);
}

export function recordFailure(key) {
    const now = Date.now();
    const arr = recent(key, now);
    arr.push(now);
    failures.set(key, arr);
    // Bound memory: a flood of distinct (possibly spoofed) keys must not grow
    // the Map without limit. Sweep expired entries, then evict oldest if needed.
    if (failures.size > MAX_KEYS) {
        for (const [k, v] of failures) {
            if (!v.some((t) => now - t < WINDOW_MS)) failures.delete(k);
        }
        while (failures.size > MAX_KEYS) {
            failures.delete(failures.keys().next().value);
        }
    }
}

// ── Host allowlist (DNS-rebinding protection) ────────────────────────────────
// Base loopback names, plus (in LAN mode) this Mac's own non-internal addresses
// and hostname, plus any names in ~/.config/cc-orchestrator/hosts (the ts.net
// name is written there by phone-link.sh). Re-read at most every 2s so a freshly
// written ts.net host is honored without a restart.
let hostsCache = { at: 0, set: null };

export function allowedHosts() {
    const now = Date.now();
    if (hostsCache.set && now - hostsCache.at < 2000) return hostsCache.set;
    const set = new Set(['127.0.0.1', 'localhost', '::1']);
    if (process.env.CC_LAN === '1') {
        for (const ifaces of Object.values(networkInterfaces())) {
            for (const iface of ifaces || []) {
                if (!iface.internal) set.add(iface.address.toLowerCase());
            }
        }
        const h = hostname().toLowerCase();
        set.add(h);
        if (!h.endsWith('.local')) set.add(`${h}.local`);
    }
    try {
        for (const line of readFileSync(HOSTS_PATH, 'utf8').split('\n')) {
            const name = line.trim().toLowerCase();
            if (name && !name.startsWith('#')) set.add(name);
        }
    } catch {
        // no hosts file
    }
    hostsCache = { at: now, set };
    return set;
}

export function hostAllowed(hostHeader) {
    if (!hostHeader) return false;
    const name = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    return allowedHosts().has(name);
}

// ── remote link resolution (for /api/phone-link) ─────────────────────────────
function lanIp() {
    for (const ifaces of Object.values(networkInterfaces())) {
        for (const iface of ifaces || []) {
            if (!iface.internal && iface.family === 'IPv4') return iface.address;
        }
    }
    return null;
}

export function remoteLink(port) {
    try {
        const r = JSON.parse(readFileSync(REMOTE_PATH, 'utf8'));
        if (r && typeof r.url === 'string' && r.mode === 'tailscale') {
            // Reject anything but http/https so a hand-edited remote.json can't
            // smuggle a javascript: URL into the dashboard's "Open" link.
            const u = new URL(r.url);
            if (u.protocol === 'https:' || u.protocol === 'http:') {
                return { mode: 'tailscale', url: r.url };
            }
        }
    } catch {
        // no/invalid remote.json
    }
    if (process.env.CC_LAN === '1') {
        const ip = lanIp();
        if (ip) return { mode: 'lan', url: `http://${ip}:${port}` };
    }
    return { mode: 'off', url: null };
}

export { CONFIG_DIR, HOSTS_PATH, REMOTE_PATH };
