import { strict as assert } from 'node:assert';
import { test, beforeEach } from 'node:test';
import { EventEmitter } from 'node:events';
import { spawn as realSpawn } from 'node:child_process';

import {
    accessFlags, ACCESS_LEVELS, buildScriptSpawn,
    startLive, stopLive, stopAllLive, hardKillAllLive, listLive, liveBuffer, getLive, _resetLive,
} from '../lib/liveSessions.mjs';
import { shq } from '../lib/actions.mjs';
import { RingBuffer } from '../lib/ringBuffer.mjs';
import { stripAnsi } from '../lib/ansi.mjs';

const UUID_A = '11111111-1111-1111-1111-111111111111';

beforeEach(() => { _resetLive(); });

// ── access level → flag mapping + allowlist rejection ───────────────────────
test('accessFlags maps each known level to static flag tokens', () => {
    assert.deepEqual(accessFlags('ask'), ['--permission-mode', 'default']);
    assert.deepEqual(accessFlags('acceptEdits'), ['--permission-mode', 'acceptEdits']);
    assert.deepEqual(accessFlags('plan'), ['--permission-mode', 'plan']);
    assert.deepEqual(accessFlags('full'), ['--dangerously-skip-permissions']);
});

test('accessFlags rejects unknown / prototype / non-string levels', () => {
    assert.equal(accessFlags('root'), null);
    assert.equal(accessFlags(''), null);
    assert.equal(accessFlags('__proto__'), null);
    assert.equal(accessFlags('constructor'), null);
    assert.equal(accessFlags('hasOwnProperty'), null);
    assert.equal(accessFlags('--dangerously-skip-permissions'), null);
    assert.equal(accessFlags(undefined), null);
    assert.equal(accessFlags(42), null);
});

test('accessFlags returns a fresh array (caller cannot mutate the table)', () => {
    const a = accessFlags('full');
    a.push('--evil');
    assert.deepEqual(accessFlags('full'), ['--dangerously-skip-permissions']);
});

test('ACCESS_LEVELS lists exactly the four supported levels', () => {
    assert.deepEqual([...ACCESS_LEVELS].sort(), ['acceptEdits', 'ask', 'full', 'plan']);
});

// ── script argv builder per platform ────────────────────────────────────────
test('buildScriptSpawn (macOS) passes the command as argv after the file', () => {
    const out = buildScriptSpawn({ claudeBin: '/bin/claude', sessionId: UUID_A, flags: ['--permission-mode', 'default'], mac: true });
    assert.deepEqual(out, {
        cmd: 'script',
        args: ['-q', '/dev/null', '/bin/claude', '--resume', UUID_A, '--permission-mode', 'default'],
    });
});

test('buildScriptSpawn (Linux) builds a single shell-quoted -c string', () => {
    const out = buildScriptSpawn({ claudeBin: '/bin/claude', sessionId: UUID_A, flags: ['--dangerously-skip-permissions'], mac: false });
    const inner = ['/bin/claude', '--resume', UUID_A, '--dangerously-skip-permissions'].map(shq).join(' ');
    assert.deepEqual(out, { cmd: 'script', args: ['-qfc', inner, '/dev/null'] });
    // the typescript sink is /dev/null and the command rides in -c
    assert.equal(out.args[2], '/dev/null');
    assert.ok(out.args[1].includes('--resume'));
});

// ── ring buffer ─────────────────────────────────────────────────────────────
test('RingBuffer concatenates pushed chunks', () => {
    const rb = new RingBuffer(1024);
    rb.push('foo');
    rb.push('bar');
    assert.equal(rb.text(), 'foobar');
});

test('RingBuffer evicts oldest chunks past the byte cap', () => {
    const rb = new RingBuffer(10);
    rb.push('12345');
    rb.push('67890');
    rb.push('abcde');          // total would be 15 > 10 → oldest evicted
    assert.ok(rb.bytes <= 10);
    assert.equal(rb.text(), '67890abcde'.slice(-10));
    assert.ok(!rb.text().includes('12345'));
});

test('RingBuffer keeps only the tail of an oversized single chunk', () => {
    const rb = new RingBuffer(10);
    rb.push('x'.repeat(25));
    assert.equal(rb.bytes, 10);
    assert.equal(rb.text(), 'x'.repeat(10));
});

test('RingBuffer clear empties it', () => {
    const rb = new RingBuffer(10);
    rb.push('abc');
    rb.clear();
    assert.equal(rb.text(), '');
    assert.equal(rb.bytes, 0);
});

// ── ANSI stripping (stripped-text live view) ────────────────────────────────
test('stripAnsi removes SGR colour, cursor moves, erase, and OSC', () => {
    assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
    assert.equal(stripAnsi('a\x1b[2Kb'), 'ab');
    assert.equal(stripAnsi('\x1b[1;1Hx'), 'x');
    assert.equal(stripAnsi('\x1b]0;window-title\x07hi'), 'hi');
    assert.equal(stripAnsi('\x1b[?25lspin\x1b[?25h'), 'spin');
});

test('stripAnsi preserves newlines and tabs, folds CR', () => {
    assert.equal(stripAnsi('a\nb\tc'), 'a\nb\tc');
    assert.equal(stripAnsi('a\r\nb'), 'a\nb');
    assert.equal(stripAnsi('a\rb'), 'ab');
});

// ── registry: invalid input is rejected without spawning ────────────────────
// Use a pid above any real OS pid so process.kill(-pid) in killGroup reliably
// ESRCHes (never signals a real process group) and falls back to child.kill.
function fakeChild(pid = 1073741824) {
    const c = new EventEmitter();
    c.pid = pid;
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = (sig) => { c.killed = sig || 'SIGTERM'; };
    return c;
}

test('startLive rejects an invalid access level without spawning', () => {
    let spawned = false;
    const r = startLive({ sessionId: UUID_A, level: 'root' }, { spawnFn: () => { spawned = true; return fakeChild(); } });
    assert.equal(r.error, 'invalid access level');
    assert.equal(spawned, false);
    assert.equal(listLive().length, 0);
});

test('startLive rejects a second live session for the same id', () => {
    const opts = { spawnFn: () => fakeChild() };
    const first = startLive({ sessionId: UUID_A, level: 'ask' }, opts);
    assert.equal(first.status, 'running');
    const second = startLive({ sessionId: UUID_A, level: 'ask' }, opts);
    assert.equal(second.error, 'a live session is already running for this id');
    assert.equal(listLive().length, 1);
});

test('startLive caps concurrent live sessions', () => {
    const opts = { spawnFn: () => fakeChild() };
    for (let i = 0; i < 6; i++) {
        const id = `2222222${i}-1111-1111-1111-111111111111`;
        assert.equal(startLive({ sessionId: id, level: 'ask' }, opts).status, 'running');
    }
    const over = startLive({ sessionId: '33333333-1111-1111-1111-111111111111', level: 'ask' }, opts);
    assert.equal(over.error, 'too many live sessions running');
});

// ── output parser/forwarder: ANSI bytes in → stripped text out ──────────────
test('startLive strips ANSI from child output and forwards + buffers it', () => {
    const child = fakeChild();
    const seen = [];
    startLive({ sessionId: UUID_A, level: 'ask' }, { spawnFn: () => child, onData: (id, text) => seen.push([id, text]) });
    child.stdout.emit('data', Buffer.from('\x1b[32mhello\x1b[0m\n'));
    assert.deepEqual(seen, [[UUID_A, 'hello\n']]);
    assert.equal(liveBuffer(UUID_A), 'hello\n');
});

// ── shutdown escalation (SIGTERM grace → SIGKILL stragglers) ────────────────
test('hardKillAllLive force-kills sessions that have not reported exit', () => {
    const child = fakeChild();
    startLive({ sessionId: UUID_A, level: 'ask' }, { spawnFn: () => child });
    const forced = hardKillAllLive();
    assert.equal(forced, 1);
    assert.equal(child.killed, 'SIGKILL');
});

test('hardKillAllLive skips sessions that already exited (no kill on a reusable pid)', () => {
    const child = fakeChild();
    startLive({ sessionId: UUID_A, level: 'ask' }, { spawnFn: () => child });
    child.emit('close', 0);          // session reports exit
    child.killed = undefined;
    const forced = hardKillAllLive();
    assert.equal(forced, 0);
    assert.equal(child.killed, undefined);
});

test('stopAllLive SIGTERMs running groups and marks them stopped', () => {
    const child = fakeChild();
    startLive({ sessionId: UUID_A, level: 'ask' }, { spawnFn: () => child });
    stopAllLive();
    assert.equal(child.killed, 'SIGTERM');
    assert.equal(getLive(UUID_A).status, 'stopped');
});

// ── full lifecycle with a real benign stand-in (no real claude) ─────────────
test('startLive streams output, then stopLive kills it and surfaces exit', async () => {
    const standIn = (cmd, args, opts) => realSpawn('sh', ['-c', 'printf "READY\\n"; sleep 30'], opts);
    let resolveData, resolveExit;
    const gotData = new Promise((r) => { resolveData = r; });
    const exited = new Promise((r) => { resolveExit = r; });
    const r = startLive(
        { sessionId: UUID_A, cwd: '/tmp', level: 'ask' },
        {
            spawnFn: standIn,
            onData: (id, text) => { if (text.includes('READY')) resolveData(text); },
            onExit: (id, entry) => resolveExit(entry),
        },
    );
    assert.equal(r.status, 'running');
    assert.ok(r.pid > 0);

    const text = await Promise.race([gotData, timeout(4000, 'no output')]);
    assert.ok(text.includes('READY'));
    assert.equal(getLive(UUID_A).status, 'running');

    assert.equal(stopLive(UUID_A), true);
    const entry = await Promise.race([exited, timeout(4000, 'no exit')]);
    assert.equal(entry.status, 'stopped');
    assert.equal(getLive(UUID_A).status, 'stopped');
});

function timeout(ms, msg) {
    return new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms).unref());
}
