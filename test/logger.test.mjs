import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the logger at a throwaway dir BEFORE importing it (it reads CC_LOG_DIR at
// module load), so tests never write to the real ~/.config/cc-orchestrator/logs.
const LOGDIR = mkdtempSync(join(tmpdir(), 'cc-log-'));
process.env.CC_LOG_DIR = LOGDIR;
const { rotate, log, logFile, logDir } = await import('../lib/logger.mjs');

test('logDir/logFile honor CC_LOG_DIR', () => {
    assert.equal(logDir(), LOGDIR);
    assert.equal(logFile(), join(LOGDIR, 'cc-orch.log'));
});

test('rotate: no-op under the size threshold', () => {
    const f = join(LOGDIR, 'r1.log');
    writeFileSync(f, 'small');
    assert.equal(rotate(f, { maxBytes: 1000, keep: 3 }), false);
    assert.ok(existsSync(f) && !existsSync(`${f}.1`));
});

test('rotate: shifts files and respects keep', () => {
    const f = join(LOGDIR, 'r2.log');
    const big = 'x'.repeat(200);
    // first rotation: f → f.1
    writeFileSync(f, big);
    assert.equal(rotate(f, { maxBytes: 100, keep: 2 }), true);
    assert.ok(existsSync(`${f}.1`) && !existsSync(f));
    // second: new f → f.1, old f.1 → f.2
    writeFileSync(f, big);
    rotate(f, { maxBytes: 100, keep: 2 });
    assert.ok(existsSync(`${f}.1`) && existsSync(`${f}.2`));
    // third with keep:2 → f.2 is dropped (nothing shifts past keep)
    writeFileSync(f, big);
    rotate(f, { maxBytes: 100, keep: 2 });
    assert.ok(!existsSync(`${f}.3`), 'never grows past keep');
});

test('log.error writes a leveled, timestamped line to the file', () => {
    log.error('boom happened');
    const contents = readFileSync(logFile(), 'utf8');
    assert.match(contents, /ERROR boom happened/);
    assert.match(contents, /^\d{4}-\d{2}-\d{2}T/m, 'ISO timestamp prefix');
});

test.after(() => rmSync(LOGDIR, { recursive: true, force: true }));
