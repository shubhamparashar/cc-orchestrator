import { readFileSync } from 'node:fs';
import { arch, homedir, platform, release, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redact } from './history.mjs';
import { versionInfo } from './version.mjs';

const USERNAME = (() => { try { return userInfo().username; } catch { return null; } })();

// Consent-gated bug reporting: build a prefilled github issues/new URL from a
// SANITIZED environment summary (+ optional error). No backend, no auto-send, no
// PII — the user clicks the link and reviews the prefilled issue before posting.
const REPO_URL = 'https://github.com/shubhamparashar/cc-orchestrator';
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function appVersion() {
    try {
        return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version || 'unknown';
    } catch {
        return 'unknown';
    }
}

// Deliberately omits cwd, home, username, env vars, and the token — only the
// coarse runtime facts useful for triage. `build` (boot commit) + `stale` catch
// the silent-staleness class of bug: a long-lived process serving an old route
// table after a pull. Git SHAs are public commit ids, not secrets.
export function sanitizedEnv() {
    const v = versionInfo();
    return {
        app: appVersion(),
        node: process.versions.node,
        platform: platform(),
        os: release(),
        arch: arch(),
        build: v.boot,
        stale: v.stale,
    };
}

// Scrub free text before it leaves the machine: collapse home-dir paths to "~"
// (generically, so a case-variant or a path that isn't an exact homedir() prefix
// can't carry the username out), redact the bare username anywhere it appears, and
// run the shared secret redactor (tokens / keys / JWTs / DB passwords).
export function scrub(text) {
    if (typeof text !== 'string') return '';
    let t = text
        .replace(/\/(?:Users|home)\/[^/\s]+/gi, '~') // /Users/<name> or /home/<name> → ~
        .split(homedir()).join('~');
    if (USERNAME && USERNAME.length >= 3) t = t.split(USERNAME).join('<user>');
    return redact(t);
}

export function issueUrl({ title = 'Bug report', error = null } = {}) {
    const env = sanitizedEnv();
    const body = [
        '## What happened', '<!-- describe the problem -->', '',
        '## Steps to reproduce', '1. ', '',
        ...(error ? ['## Error', '```', scrub(String(error)).slice(0, 1500), '```', ''] : []),
        '## Environment',
        `- cc-orchestrator: ${env.app}`,
        `- Build: ${env.build || 'unknown'}${env.stale ? ' ⚠️ STALE — running process older than the code on disk; restart it' : ''}`,
        `- Node: ${env.node}`,
        `- Platform: ${env.platform} ${env.os} (${env.arch})`,
    ].join('\n');
    const u = new URL(`${REPO_URL}/issues/new`);
    u.searchParams.set('title', title);
    u.searchParams.set('labels', 'bug');
    u.searchParams.set('body', body);
    return u.toString();
}

export { REPO_URL };
