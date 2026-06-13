// OPT-IN backfill: generate context.md for the N most recent sessions that lack
// one. Costs model quota — never run automatically.
//   node jobs/backfill-contexts.mjs --limit 10 [--force]
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanSessions } from '../lib/scan.mjs';
import { liveSessions } from '../lib/live.mjs';
import { desktopSessions } from '../lib/desktop.mjs';
import { contextPathFor, readContext } from '../lib/contextStore.mjs';

const MIN_BYTES = 50 * 1024;
const GENERATOR = join(dirname(fileURLToPath(import.meta.url)), 'ctx-generate.mjs');

const limitArg = process.argv.indexOf('--limit');
const parsedLimit = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : 10;
// NaN/non-numeric (e.g. `--limit` with no value, `--limit all`) would make the
// `candidates.length >= limit` guard always false → an unbounded backfill that
// spends quota on every session. Fall back to the default instead.
const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 10;
const force = process.argv.includes('--force');

function generate(session) {
    return new Promise((resolve) => {
        const transcript = join(
            process.env.HOME, '.claude', 'projects', session.projectDir, `${session.sessionId}.jsonl`,
        );
        const args = [GENERATOR, '--session', session.sessionId, '--transcript', transcript, '--cwd', session.cwd || ''];
        const child = spawn(process.execPath, args, {
            stdio: 'inherit',
            env: { ...process.env, CC_CTX_JOB: '1' },
        });
        child.on('close', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
    });
}

const [liveBySession, desktopBySession] = await Promise.all([liveSessions(), desktopSessions()]);
const sessions = await scanSessions({ liveBySession, desktopBySession });
const candidates = [];
for (const s of sessions) {
    if (candidates.length >= limit) break;
    if (s.isArchived || s.sizeBytes < MIN_BYTES) continue;
    if (!force && (await readContext(s.sessionId))) continue;
    candidates.push(s);
}

console.log(`backfilling ${candidates.length} session(s), sequentially:`);
let ok = 0;
for (const s of candidates) {
    console.log(`- ${s.sessionId.slice(0, 8)} "${s.title}" (${s.repo})`);
    if (await generate(s)) {
        ok++;
        console.log(`  -> ${contextPathFor(s.sessionId)}`);
    } else {
        console.log('  -> FAILED (see /tmp/cc-orch-ctx.log)');
    }
}
console.log(`done: ${ok}/${candidates.length} generated`);
