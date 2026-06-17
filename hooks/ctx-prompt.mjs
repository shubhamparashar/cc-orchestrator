// UserPromptSubmit hook: (a) on the first real prompt, surface relevant prior
// sessions from the context index; (b) warn once when the context window crosses
// 70%. Lexical only — no model calls; every failure exits 0 silently.
if (process.env.CC_CTX_JOB) process.exit(0);

import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { contextWindowFor, digestFile } from '../lib/scan.mjs';
import { isSessionUuid, loadIndex, readContext, readSessionState, writeSessionState } from '../lib/contextStore.mjs';
import { rankDocs } from '../lib/rank.mjs';

const WARN_PCT = 70;
const MAX_MATCHES = 3;

function indexToDocs(index, excludeSessionId) {
    const docs = [];
    for (const e of index) {
        if (e.sessionId === excludeSessionId) continue;
        docs.push({
            id: e.sessionId, title: e.title, tags: e.tags, goal: e.goal, repo: e.repo,
            body: e.body || '', updatedMs: e.updated, contextPath: e.contextPath, cwd: e.cwd,
        });
    }
    return docs;
}

function matchLines(header, matches) {
    const lines = [header];
    for (const { doc } of matches) {
        const goal = doc.goal ? ` — ${doc.goal}` : '';
        lines.push(`- "${doc.title || doc.id.slice(0, 8)}" (${doc.repo || '?'})${goal}`);
        const ctx = doc.contextPath ? `context: ${doc.contextPath}   ` : '';
        lines.push(`  ${ctx}resume: claude --resume ${doc.id}   fork: claude --resume ${doc.id} --fork-session`);
    }
    return lines;
}

try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const sessionId = input.session_id;
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    if (!isSessionUuid(sessionId)) process.exit(0);
    if (prompt.trimStart().startsWith('/')) process.exit(0); // slash command, not a real prompt

    const state = await readSessionState(sessionId);
    const out = [];
    let stateDirty = false;

    if (!state.greeted) {
        state.greeted = true;
        stateDirty = true;
        const index = await loadIndex();
        const docs = indexToDocs(index, sessionId);
        const repo = input.cwd ? basename(input.cwd) : null;
        const matches = rankDocs(prompt, docs, { repo, limit: MAX_MATCHES });
        if (matches.length) {
            out.push(...matchLines('Relevant prior sessions (cc-orchestrator index — read a context file if it helps):', matches));
        }
    }

    if (!state.warned70 && input.transcript_path) {
        try {
            const st = await stat(input.transcript_path);
            if (st.size > 200 * 1024) {
                const { d } = await digestFile(input.transcript_path, st);
                const used = d.usedTokens ?? 0;
                const window = contextWindowFor(d.model, null, used);
                const pct = Math.round((used / window) * 100);
                if (pct >= WARN_PCT) {
                    state.warned70 = true;
                    stateDirty = true;
                    out.push(`Context window is at ~${pct}% (${Math.round(used / 1000)}k tokens). Consider running /context to save a rolling context file, then continue in a fork: claude --resume ${sessionId} --fork-session`);
                    const own = await readContext(sessionId);
                    if (own?.goal) {
                        const index = await loadIndex();
                        const related = rankDocs(`${own.meta?.title || ''} ${own.goal}`, indexToDocs(index, sessionId), { limit: 2 });
                        if (related.length) out.push(...matchLines('Related contexts:', related));
                    }
                }
            }
        } catch {
            // transcript unreadable — skip the warning path
        }
    }

    if (stateDirty) await writeSessionState(sessionId, state);
    if (out.length) console.log(out.join('\n'));
} catch {
    // fail-open
}
process.exit(0);
