// UserPromptSubmit hook: on the first real prompt, surface relevant prior
// sessions from the context index. Lexical only - no model calls; every
// failure exits 0 silently. Context-window pressure warnings are owned by
// the claude-conductor plugin (context-pressure-warn.js).
if (process.env.CC_CTX_JOB) process.exit(0);

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { isSessionUuid, loadIndex, readSessionState, writeSessionState } from '../lib/contextStore.mjs';
import { rankDocs } from '../lib/rank.mjs';

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

function clip(s, max) {
    if (!s) return s;
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function matchLines(header, matches) {
    const lines = [header];
    for (const { doc } of matches) {
        const goal = doc.goal ? ` - ${clip(doc.goal, 160)}` : '';
        lines.push(`- "${clip(doc.title, 120) || doc.id.slice(0, 8)}" (${doc.repo || '?'})${goal}`);
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
            out.push(...matchLines('Relevant prior sessions (cc-orchestrator index - read a context file if it helps):', matches));
        }
    }

    if (stateDirty) await writeSessionState(sessionId, state);
    if (out.length) console.log(out.join('\n'));
} catch {
    // fail-open
}
process.exit(0);
