import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
    PROJECTS_DIR, readSlice, parseLines, textOfContent, isSyntheticUserText, digestFile,
} from './scan.mjs';
import { INDEX_PATH, isSessionUuid, listContextSessions, readContext, writeIndexFile } from './contextStore.mjs';

const UUID_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const BODY_BYTES = 512 * 1024;     // tail window to harvest the user's prompts from
const BODY_CHARS = 4000;           // cap the indexed body per session

// Transcript-derived body = the user's own prompts (their words), most-recent
// first, capped. This is the highest-signal text for "what was I working on"
// search and needs no model call. Cached on (size, mtime) like the digest.
const bodyCache = new Map();

async function extractBody(path, st) {
    const cached = bodyCache.get(path);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.val;
    const start = Math.max(0, st.size - BODY_BYTES);
    const text = await readSlice(path, start, Math.min(st.size, BODY_BYTES));
    const prompts = [];
    for (const r of parseLines(text)) {
        if (r.type !== 'user' || r.isMeta) continue;
        const t = textOfContent(r.message?.content);
        if (t && t.trim() && !isSyntheticUserText(t)) prompts.push(t.replace(/\s+/g, ' ').trim());
    }
    let body = '';
    for (let i = prompts.length - 1; i >= 0 && body.length < BODY_CHARS; i--) {
        body = `${prompts[i]} ${body}`;
    }
    const val = { body: body.slice(0, BODY_CHARS).trim(), firstPrompt: prompts[0] || null };
    bodyCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, val });
    return val;
}

function pruneBodyCache(livePaths) {
    for (const p of bodyCache.keys()) if (!livePaths.has(p)) bodyCache.delete(p);
}

function deriveTags({ repo, gitBranch, ctxTags }) {
    const tags = new Set(ctxTags || []);
    if (repo) tags.add(repo);
    if (gitBranch && gitBranch !== 'main' && gitBranch !== 'master') tags.add(gitBranch);
    return [...tags];
}

// Tier-1 index over ALL sessions, transcript-derived (free — no model calls),
// enriched with the curated context.md when one exists. Written to index.json.
export async function buildSessionIndex() {
    let projectDirs = [];
    try {
        projectDirs = await readdir(PROJECTS_DIR);
    } catch {
        return [];
    }
    const ctxSessions = await listContextSessions();
    const entries = [];
    const livePaths = new Set();

    for (const dir of projectDirs) {
        let files;
        try {
            files = await readdir(join(PROJECTS_DIR, dir));
        } catch {
            continue;
        }
        const isWorktree = dir.includes('--claude-worktrees-');
        for (const file of files) {
            if (!UUID_FILE_RE.test(file)) continue;
            const sessionId = basename(file, '.jsonl');
            const path = join(PROJECTS_DIR, dir, file);
            try {
                const st = await stat(path);
                if (st.size === 0) continue;
                livePaths.add(path);
                const { d } = await digestFile(path, st);
                const { body, firstPrompt } = await extractBody(path, st);
                const cwd = d.cwd || null;
                const repo = cwd ? basename(cwd) : dir;
                const hasContext = ctxSessions.has(sessionId);
                const ctx = hasContext ? await readContext(sessionId) : null;
                const goal = ctx?.goal || d.title || firstPrompt || d.lastUser || null;
                entries.push({
                    sessionId,
                    repo,
                    cwd,
                    gitBranch: d.gitBranch || null,
                    title: d.title || firstPrompt || sessionId.slice(0, 8),
                    tags: deriveTags({ repo, gitBranch: d.gitBranch, ctxTags: ctx?.meta?.tags }),
                    goal: goal ? goal.replace(/\s+/g, ' ').slice(0, 280) : null,
                    body,
                    model: d.model || null,
                    isWorktree,
                    hasContext,
                    contextPath: ctx?.path || null,
                    updated: st.mtimeMs,
                    sizeBytes: st.size,
                });
            } catch {
                // unreadable transcript — skip, never block the index build
            }
        }
    }
    pruneBodyCache(livePaths);
    entries.sort((a, b) => b.updated - a.updated);
    await writeIndexFile(entries);
    return entries;
}

export { INDEX_PATH };
