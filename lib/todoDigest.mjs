import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { configDir } from './config.mjs';
import { log } from './logger.mjs';

// Daily digest of open TodoWrite items across the most recently active
// sessions, persisted locally so the list survives restarts and transcript
// cleanup. Local-only by design: nothing leaves the machine.
const TOP_SESSIONS = 15;
const REFRESH_MS = 24 * 60 * 60 * 1000;

function digestPath() {
    return join(configDir(), 'todo-digest.json');
}

export function loadTodoDigest() {
    try {
        const d = JSON.parse(readFileSync(digestPath(), 'utf8'));
        return d && typeof d === 'object' && Array.isArray(d.groups) ? d : null;
    } catch {
        return null;
    }
}

// sessions: scanned list (already sorted by lastActivityAt desc, tasks attached).
// Forked/resumed sessions carry the same todo items; a subject already claimed by
// a more recent session is deduped down to a counter on the first occurrence.
export function buildTodoDigest(sessions) {
    const groups = [];
    const seen = new Map();   // normalized subject -> kept item
    for (const s of sessions) {
        if (groups.length >= TOP_SESSIONS) break;
        const open = (s.tasks?.items || []).filter((i) => i.status !== 'completed' && i.subject);
        const items = [];
        for (const i of open) {
            const subject = String(i.subject).slice(0, 300);
            const norm = subject.toLowerCase().replace(/\s+/g, ' ').trim();
            const kept = seen.get(norm);
            if (kept) {
                kept.also = (kept.also || 0) + 1;
                continue;
            }
            const item = { subject, status: i.status };
            seen.set(norm, item);
            items.push(item);
        }
        if (!items.length) continue;
        groups.push({
            sessionId: s.sessionId,
            title: s.title || s.sessionId.slice(0, 8),
            repo: s.repo || '',
            status: s.status,
            items,
        });
    }
    const digest = {
        generatedAt: Date.now(),
        openItems: groups.reduce((n, g) => n + g.items.length, 0),
        groups,
    };
    try {
        mkdirSync(configDir(), { recursive: true, mode: 0o700 });
        writeFileSync(digestPath(), JSON.stringify(digest), { mode: 0o600 });
    } catch (err) {
        log.warn(`todo digest write failed: ${err.message}`);
    }
    return digest;
}

export function digestStale(digest, now = Date.now()) {
    return !digest || now - (digest.generatedAt || 0) >= REFRESH_MS;
}
