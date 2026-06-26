import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
    PROJECTS_DIR, readSlice, parseLines, textOfContent, isSyntheticUserText, digestFile,
} from './scan.mjs';
import { INDEX_PATH, isSessionUuid, listContextSessions, readContext, writeIndexFile } from './contextStore.mjs';
import { subagentDocsFor } from './subagents.mjs';
import { tokenize } from './rank.mjs';

const UUID_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
// The indexed body is a deduped bag of the significant terms from the user's own
// prompts across the WHOLE transcript — not just a recent tail — so every task in
// a long, multi-task session stays searchable, even mid-session. Each user prompt
// is tokenized (the shared tokenizer drops stopwords), term frequencies are
// counted, and each distinct term is emitted up to TERM_TF_CAP times. Dedup
// collapses repetition (a word used 50× → 3), so a sprawling session indexes small
// while keeping its full distinct vocabulary; BM25F's IDF then weights the rare,
// high-signal terms at query time. No model call. The harvest is incremental —
// only bytes appended since the last build are re-tokenized (byte-offset resume,
// like cost.mjs) — so the growing live session stays cheap.
const BODY_TERM_CAP = 800;   // distinct terms kept per session (highest-frequency first)
const TERM_TF_CAP = 3;       // max repeats of one term — collapses runaway repetition

// Fold each real user prompt's tokens in `text` into `counts`, capturing the first
// prompt seen (for the title/goal fallback). Pure over the passed text; `counts`
// and `firstPrompt` may be seeded to accumulate across an incremental read.
export function harvestPromptTerms(text, counts = new Map(), firstPrompt = null) {
    let first = firstPrompt;
    for (const r of parseLines(text)) {
        if (r.type !== 'user' || r.isMeta) continue;
        const t = textOfContent(r.message?.content);
        if (!t || !t.trim() || isSyntheticUserText(t)) continue;
        if (!first) first = t.replace(/\s+/g, ' ').trim();
        for (const tok of tokenize(t)) counts.set(tok, (counts.get(tok) || 0) + 1);
    }
    return { counts, firstPrompt: first };
}

// Deduped, frequency-ordered, count-capped bag of terms → the BM25F body field.
export function bodyFromCounts(counts) {
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, BODY_TERM_CAP);
    const out = [];
    for (const [term, c] of top) {
        for (let i = 0; i < Math.min(c, TERM_TF_CAP); i++) out.push(term);
    }
    return out.join(' ');
}

// Cached, incremental per-session harvest. Resumes from the last byte offset on
// append-only growth; full re-read only when the file shrank or its mtime moved
// without growth. Returns { body, firstPrompt }.
const bodyCache = new Map();

async function extractBody(path, st) {
    const cached = bodyCache.get(path);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.val;
    const grew = Boolean(cached && st.size > cached.size);
    const counts = grew ? cached.counts : new Map();
    const fromOffset = grew ? cached.safeOffset : 0;
    const slice = await readSlice(path, fromOffset, st.size - fromOffset);
    const lastNl = slice.lastIndexOf('\n');
    const consumed = lastNl === -1 ? '' : slice.slice(0, lastNl + 1);
    const { firstPrompt } = harvestPromptTerms(consumed, counts, grew ? cached.firstPrompt : null);
    const safeOffset = fromOffset + Buffer.byteLength(consumed, 'utf8');
    const val = { body: bodyFromCounts(counts), firstPrompt };
    bodyCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, safeOffset, counts, firstPrompt, val });
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
