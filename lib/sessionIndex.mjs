import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
    PROJECTS_DIR, readSlice, parseLines, textOfContent, isSyntheticUserText, digestFile,
} from './scan.mjs';
import { INDEX_PATH, isSessionUuid, listContextSessions, readContext, writeIndexFile } from './contextStore.mjs';
import { subagentDocsFor } from './subagents.mjs';

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

// Fold one session's sub-agent transcripts into the corpus as their own docs. The
// sub-agent's task description carries the title weight, its type the tag weight,
// and its dialogue tail the body weight (the same field weighting rank.mjs already
// applies to session docs). A hit is discriminated by kind:'subagent' and navigates
// to its parent: sessionId is the parent id (so existing navigation works unchanged),
// while parentSessionId, agentType, and description carry the sub-agent's own identity
// for distinct rendering. updated/repo are inherited from the parent so recency and
// same-repo boosts behave the same as for the parent session.
function subagentEntries(docs, { parentRepo, updated }) {
    return docs.map((d) => ({
        kind: 'subagent',
        sessionId: d.parentSessionId,
        parentSessionId: d.parentSessionId,
        agentId: d.id,
        agentType: d.agentType,
        repo: d.repo || parentRepo,
        title: d.description || `${d.agentType} subagent`,
        tags: [d.agentType, d.repo || parentRepo].filter(Boolean),
        goal: null,
        body: d.body || '',
        model: d.model || null,
        description: d.description || '',
        updated,
        sizeBytes: d.body ? d.body.length : 0,
    }));
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
                // Fold in this session's sub-agent transcripts (caches per file on
                // (size,mtime), so the ~565-file walk only re-reads what changed).
                try {
                    const subDocs = await subagentDocsFor(PROJECTS_DIR, dir, sessionId, repo);
                    for (const e of subagentEntries(subDocs, { parentRepo: repo, updated: st.mtimeMs })) {
                        entries.push(e);
                    }
                } catch {
                    // sub-agent walk failed for this session — index the parent anyway
                }
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
