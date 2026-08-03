// SessionStart hook: cadence enforcer for knowledge-surface consolidation.
// Checks size caps on the always-loaded surfaces (CLAUDE.md + rules, MEMORY.md,
// memory file count) and staleness of the second-brain log, and nags at most
// once per week to run the hygiene pass. Never mutates anything itself.
if (process.env.CC_CTX_JOB) process.exit(0);

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const STATE = join(HOME, '.claude', 'contexts', '.state', 'consolidation.json');
const NUDGE_INTERVAL_MS = 7 * 24 * 3600 * 1000;
const BRAIN_STALE_MS = 14 * 24 * 3600 * 1000;

// caps: always-loaded surfaces must not grow unbounded (chars, ~4 chars/token)
const CAP_RULES_BYTES = 100 * 1024; // CLAUDE.md + ~/.claude/rules (~25k tokens)
const CAP_MEMORY_MD_BYTES = 4 * 1024;
const CAP_MEMORY_FILES = 25;

const size = (p) => { try { return statSync(p).size; } catch { return 0; } };

try {
    let state = {};
    try { state = JSON.parse(readFileSync(STATE, 'utf8')); } catch { /* first run */ }
    if (Date.now() - (state.lastNudgeMs || 0) < NUDGE_INTERVAL_MS) process.exit(0);

    const findings = [];

    const rulesDir = join(HOME, '.claude', 'rules');
    let rulesBytes = size(join(HOME, '.claude', 'CLAUDE.md'));
    try { for (const f of readdirSync(rulesDir)) rulesBytes += size(join(rulesDir, f)); } catch { /* no rules dir */ }
    if (rulesBytes > CAP_RULES_BYTES) {
        findings.push(`CLAUDE.md+rules at ${Math.round(rulesBytes / 1024)}KB (cap ${CAP_RULES_BYTES / 1024}KB) - merge or retire rules`);
    }

    const memDir = join(HOME, '.claude', 'projects', '-Users-shubhamparashar-repo', 'memory');
    if (size(join(memDir, 'MEMORY.md')) > CAP_MEMORY_MD_BYTES) {
        findings.push(`MEMORY.md over ${CAP_MEMORY_MD_BYTES / 1024}KB - prune stale entries`);
    }
    try {
        const n = readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').length;
        if (n > CAP_MEMORY_FILES) findings.push(`${n} memory files (cap ${CAP_MEMORY_FILES}) - consolidate or delete`);
    } catch { /* no memory dir */ }

    const brainLog = join(HOME, 'repo', 'shubham', 'context', 'okf', 'second-brain', 'log.md');
    try {
        const age = Date.now() - statSync(brainLog).mtimeMs;
        if (age > BRAIN_STALE_MS) {
            findings.push(`brain log.md last updated ${Math.round(age / 86400000)}d ago - run /brain-hygiene or /brain-sync`);
        }
    } catch { /* no brain */ }

    if (!findings.length) process.exit(0);

    mkdirSync(join(HOME, '.claude', 'contexts', '.state'), { recursive: true });
    writeFileSync(STATE, JSON.stringify({ lastNudgeMs: Date.now() }));
    process.stdout.write(
        `Knowledge consolidation due (weekly check): ${findings.join('; ')}. ` +
        `Mention this to the user in one line; do not act on it unprompted.`
    );
} catch {
    // fail-open: a broken hook must never break a session
}
process.exit(0);
