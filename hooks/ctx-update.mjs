// Stop + PreCompact hook: spawn the context generator detached, never block a turn.
// Must stay cheap (stdin parse + 2 stats) — all model work happens in the job.
if (process.env.CC_CTX_JOB) process.exit(0);

import { readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contextPathFor, isSessionUuid } from '../lib/contextStore.mjs';

const MIN_TRANSCRIPT_BYTES = 50 * 1024;
const DEBOUNCE_MS = 5 * 60 * 1000;
const GENERATOR = join(dirname(fileURLToPath(import.meta.url)), '..', 'jobs', 'ctx-generate.mjs');

try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const sessionId = input.session_id;
    const transcript = input.transcript_path;
    const event = input.hook_event_name || process.argv[2] || 'Stop';
    if (!isSessionUuid(sessionId) || !transcript) process.exit(0);

    const tStat = statSync(transcript);
    if (event !== 'PreCompact') {
        if (tStat.size < MIN_TRANSCRIPT_BYTES) process.exit(0);
        try {
            const cStat = statSync(contextPathFor(sessionId));
            if (Date.now() - cStat.mtimeMs < DEBOUNCE_MS) process.exit(0);
        } catch {
            // no context yet — generate one
        }
    }

    const args = [GENERATOR, '--session', sessionId, '--transcript', transcript, '--cwd', input.cwd || ''];
    const child = spawn(process.execPath, args, {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, CC_CTX_JOB: '1' },
    });
    child.unref();
} catch {
    // fail-open: a broken hook must never break a session
}
process.exit(0);
