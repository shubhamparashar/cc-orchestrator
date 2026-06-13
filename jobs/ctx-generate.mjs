// Regenerates ~/.claude/contexts/<session>.md from a transcript: dialogue-only
// tail → one cheap model call → merged/curated file → index rebuild.
// Spawned detached by hooks/ctx-update.mjs with CC_CTX_JOB=1 so the headless
// claude run below can never re-trigger the hooks recursively.
import { appendFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { isSyntheticUserText, parseLines, readSlice, digestFile } from '../lib/scan.mjs';
import { CONTEXTS_DIR, acquireGenLock, readContext, rebuildIndex, releaseGenLock, writeContext } from '../lib/contextStore.mjs';

const CLAUDE_BIN = process.env.CC_CTX_CLAUDE_BIN || join(homedir(), '.claude', 'local', 'claude');
const MODEL = process.env.CC_CTX_MODEL || 'claude-fable-5';
const RAW_TAIL_BYTES = 512 * 1024;
const DIALOGUE_CAP_BYTES = 30 * 1024;
const PER_MESSAGE_CAP = 1500;
const MODEL_TIMEOUT_MS = 180_000;
const MAX_BODY_LINES = 55;
const LOG = '/tmp/cc-orch-ctx.log';

function log(msg) {
    try {
        appendFileSync(LOG, `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
    } catch {
        // logging must never kill the job
    }
}

function argValue(flag) {
    const i = process.argv.indexOf(flag);
    return i !== -1 ? process.argv[i + 1] : null;
}

function textPartsOf(message) {
    const c = message?.content;
    if (typeof c === 'string') return c;
    if (!Array.isArray(c)) return null;
    const texts = c.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text);
    return texts.length ? texts.join('\n') : null;
}

function clip(text) {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > PER_MESSAGE_CAP ? `${t.slice(0, PER_MESSAGE_CAP)}…` : t;
}

// Dialogue only — never raw transcript records. Newest-first budget keeps the
// most recent DIALOGUE_CAP_BYTES of conversation.
function extractDialogue(records) {
    const turns = [];
    for (const r of records) {
        if (r.type === 'user' && !r.isMeta) {
            const text = textPartsOf(r.message);
            if (text && text.trim() && !isSyntheticUserText(text)) turns.push(`USER: ${clip(text)}`);
        } else if (r.type === 'assistant') {
            const text = textPartsOf(r.message);
            if (text && text.trim()) turns.push(`ASSISTANT: ${clip(text)}`);
        }
    }
    const kept = [];
    let budget = DIALOGUE_CAP_BYTES;
    for (let i = turns.length - 1; i >= 0 && budget > 0; i--) {
        budget -= turns[i].length + 1;
        if (budget >= 0) kept.unshift(turns[i]);
    }
    return kept.join('\n');
}

function buildPrompt({ existing, dialogue, repo, title }) {
    return `You maintain a rolling context file for a coding session so a future agent can resume the work cold. Merge the EXISTING FILE (may be empty) with the NEW CONVERSATION EXCERPT: keep still-true durable facts, drop stale or superseded ones, compress aggressively. Curate — never append. Hard limit ${MAX_BODY_LINES - 5} lines total.

Output EXACTLY this, with no preamble, no code fences:
tags: <3-6 short comma-separated topic tags>
## Goal
<1-2 lines: what this session is trying to achieve>
## Key files
<bullet list of paths that matter, with a few words each>
## Decisions
<bullet list of decisions made and constraints discovered>
## State
<bullet list: what is done / verified, what is broken>
## Next step
<1-3 bullets: the immediate next actions>

Session repo: ${repo}. Session title: ${title}.

EXISTING FILE:
${existing || '(none)'}

NEW CONVERSATION EXCERPT (oldest first):
${dialogue}`;
}

function runClaude(prompt) {
    return new Promise((resolve, reject) => {
        const args = ['-p', '--model', MODEL, '--effort', 'low', '--no-session-persistence'];
        const child = spawn(CLAUDE_BIN, args, {
            cwd: CONTEXTS_DIR,
            env: { ...process.env, CC_CTX_JOB: '1', CLAUDE_NO_RC: '1' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('model call timed out'));
        }, MODEL_TIMEOUT_MS);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(stdout);
            else reject(new Error(`claude exited ${code}: ${stderr.slice(0, 400)}`));
        });
        child.stdin.end(prompt);
    });
}

function composeFile({ sessionId, repo, cwd, title, modelOutput }) {
    let body = modelOutput.trim()
        .replace(/^```[a-z]*\n/, '').replace(/\n```$/, '');
    let tags = [];
    const tagsMatch = body.match(/^tags:\s*(.+)$/m);
    if (tagsMatch) {
        tags = tagsMatch[1].split(',').map((t) => t.trim()).filter(Boolean).slice(0, 6);
        body = body.replace(/^tags:.*\n?/m, '');
    }
    const goalAt = body.indexOf('## Goal');
    if (goalAt === -1) throw new Error('model output missing "## Goal" section');
    body = body.slice(goalAt).trim();
    body = body.split('\n').slice(0, MAX_BODY_LINES).join('\n');
    const fm = [
        '---',
        `session: ${sessionId}`,
        `repo: ${repo}`,
        `cwd: ${cwd}`,
        `title: ${String(title).replace(/\n/g, ' ').slice(0, 120)}`,
        `tags: [${tags.join(', ')}]`,
        `updated: ${new Date().toISOString()}`,
        '---',
    ];
    return `${fm.join('\n')}\n\n${body}\n`;
}

const sessionId = argValue('--session');
const transcript = argValue('--transcript');
const cwdArg = argValue('--cwd');

let lock = null;
try {
    if (!sessionId || !transcript) throw new Error('usage: ctx-generate.mjs --session <uuid> --transcript <path> [--cwd <dir>]');
    lock = await acquireGenLock(sessionId);
    if (!lock) {
        log(`skip ${sessionId}: sibling generator in-flight`);
        process.exit(0);
    }
    const st = await stat(transcript);
    const { d } = await digestFile(transcript, st);
    const tailStart = Math.max(0, st.size - RAW_TAIL_BYTES);
    const raw = await readSlice(transcript, tailStart, Math.min(st.size, RAW_TAIL_BYTES));
    const dialogue = extractDialogue(parseLines(raw));
    if (dialogue.length < 200) throw new Error('not enough dialogue to summarize');

    const cwd = cwdArg || d.cwd || homedir();
    const repo = basename(cwd);
    const title = d.title || d.lastUser?.slice(0, 80) || sessionId.slice(0, 8);
    const existing = (await readContext(sessionId))?.content || null;

    const prompt = buildPrompt({ existing, dialogue, repo, title });
    const modelOutput = await runClaude(prompt);
    const file = composeFile({ sessionId, repo, cwd, title, modelOutput });
    const path = await writeContext(sessionId, file);
    await rebuildIndex();
    log(`ok ${sessionId} -> ${path} (${file.length}B)`);
} catch (err) {
    log(`fail ${sessionId || '?'}: ${err.message}`);
    await releaseGenLock(lock);
    process.exit(1);
}
await releaseGenLock(lock);
