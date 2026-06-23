import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

// Cross-session prompt palette (A6): a searchable, read-only log of the prompts
// you've typed across every repo, joined back to their sessions. Source is the
// rolling ~93-entry ~/.claude/history.jsonl, each row carrying display + project
// (the cwd) + sessionId + timestamp(ms). Read-only, no model calls — search is a
// plain lexical substring match so it stays free.
const HISTORY_PATH = join(homedir(), '.claude', 'history.jsonl');
const MAX_DISPLAY = 300;

// Secrets leak into typed/pasted prompts — most notably this tool's own tokenized
// /login?key=<token> remote-access link, but also API keys, bearer tokens, and DB
// connection strings someone pasted into a prompt. Redact them before the palette
// ever renders them (the dashboard is reachable from a phone over Tailscale).
// Safety over precision: a few false positives (a bare SHA-256, a "turnkey=" that
// isn't a credential) are acceptable; a leaked token is not. This is a best-effort
// net over common shapes, not a guarantee — hence the "common secrets" UI wording.
const SECRET_PATTERNS = [
    // PEM private-key blocks (may span lines before snippet() collapses whitespace).
    [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '‹redacted-private-key›'],
    // Credentials embedded in a URL: scheme://user:password@host → keep user, drop password.
    [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)@/gi, (_m, pre) => `${pre}‹redacted›@`],
    // JSON Web Tokens (three base64url segments).
    [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '‹redacted-jwt›'],
    // Bearer / Authorization tokens.
    [/\bbearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, 'bearer ‹redacted›'],
    // <identifier containing a secret word> = / : <value> — keep the label, redact the
    // value. The secret word must be a delimited segment (start, or after . _ -) so
    // "key" matches DB_KEY=/api_key:/key= but not "keyboard:" or "monkey=".
    [/\b((?:[\w.-]*[._-])?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|credential|auth[_-]?token|key|pwd)(?:[._-][\w.-]*)?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&"'#,;]+)/gi, (_m, label) => `${label}‹redacted›`],
    // Known provider key shapes (bare).
    [/\b(?:sk|rk|pk)[-_][A-Za-z0-9_-]{16,}\b/gi, '‹redacted-key›'],
    [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '‹redacted-key›'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '‹redacted-key›'],
    [/\bglpat-[A-Za-z0-9_-]{16,}\b/g, '‹redacted-key›'],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '‹redacted-key›'],
    [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '‹redacted-key›'],
    [/\bAIza[0-9A-Za-z_-]{35}\b/g, '‹redacted-key›'],
    // Bare high-entropy hex run (≥48 chars) — catches a raw 64-hex access token if
    // ever pasted without the key= prefix, while leaving 40-char SHA-1 hashes alone.
    [/\b[0-9a-f]{48,}\b/gi, '‹redacted›'],
];

export function redact(text) {
    if (typeof text !== 'string') return '';
    let out = text;
    for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
    return out;
}

function snippet(text, max = MAX_DISPLAY) {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
}

// Pure parse so it's testable without touching the filesystem: newest-first,
// redacted, optionally filtered by a case-insensitive substring over the prompt
// text and repo name.
export function parseHistory(text, { q = '', limit = 100 } = {}) {
    const rows = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let r;
        try {
            r = JSON.parse(line);
        } catch {
            continue;
        }
        if (typeof r.display !== 'string' || !r.display.trim()) continue;
        const cwd = typeof r.project === 'string' ? r.project : null;
        rows.push({
            display: snippet(redact(r.display)),
            repo: cwd ? basename(cwd) : null,
            cwd,
            sessionId: typeof r.sessionId === 'string' ? r.sessionId : null,
            at: Number.isFinite(r.timestamp) ? r.timestamp : 0,
        });
    }
    rows.sort((a, b) => b.at - a.at);
    let out = rows;
    const needle = q.trim().toLowerCase();
    if (needle) {
        out = rows.filter((e) => `${e.display} ${e.repo || ''}`.toLowerCase().includes(needle));
    }
    return out.slice(0, Math.max(0, limit));
}

export async function recentPrompts({ q = '', limit = 100 } = {}) {
    let text;
    try {
        text = await readFile(HISTORY_PATH, 'utf8');
    } catch {
        return [];
    }
    return parseHistory(text, { q, limit });
}

export { HISTORY_PATH };
