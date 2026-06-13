// SessionStart hook: tell the agent its own session uuid (it has no other way to
// know it), and point at the rolling context file if one exists. stdout becomes
// injected context.
if (process.env.CC_CTX_JOB) process.exit(0);

import { readFileSync, statSync } from 'node:fs';

import { contextPathFor, isSessionUuid } from '../lib/contextStore.mjs';

try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const sessionId = input.session_id;
    if (!isSessionUuid(sessionId)) process.exit(0);
    const lines = [`session-id: ${sessionId}`];
    const path = contextPathFor(sessionId);
    try {
        statSync(path);
        lines.push(`Rolling context for this session exists at ${path} — read it if you need prior context.`);
    } catch {
        // no context yet
    }
    console.log(lines.join('\n'));
} catch {
    // fail-open
}
process.exit(0);
