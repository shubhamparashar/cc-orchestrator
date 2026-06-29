import { strict as assert } from 'node:assert';
import { test, beforeEach } from 'node:test';
import { EventEmitter } from 'node:events';
import { spawn as realSpawn } from 'node:child_process';

import {
    accessFlags, ACCESS_LEVELS, isLiveCwd, buildClaudeArgs, buildScriptSpawn,
    startLive, stopLive, stopAllLive, hardKillAllLive, listLive, liveBuffer, getLive, _resetLive,
} from '../lib/liveSessions.mjs';
import { shq } from '../lib/actions.mjs';
import { RingBuffer } from '../lib/ringBuffer.mjs';
import { stripAnsi } from '../lib/ansi.mjs';

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

test('ACCESS_LEVELS lists exactly the four supported levels', () => {
    assert.deepEqual([...ACCESS_LEVELS].sort(), ['acceptEdits', 'ask', 'full', 'plan']);
});

// ── cwd validation for a new session ────────────────────────────────────────
test('isLiveCwd accepts an existing absolute directory', () => {
    assert.equal(isLiveCwd('/tmp'), true);
});

test('isLiveCwd rejects relative, traversal, missing, and non-string paths', () => {
    assert.equal(isLiveCwd('relative/dir'), false);
    assert.equal(isLiveCwd('/tmp/..'), false);          // traversal segment
    assert.equal(isLiveCwd('/etc/../etc'), false);      // traversal segment, even if it resolves
    assert.equal(isLiveCwd('/no/such/dir/xyz-12345'), false);
    assert.equal(isLiveCwd('/etc/hosts'), false);       // a file, not a directory
    assert.equal(isLiveCwd(''), false);
    assert.equal(isLiveCwd(42), false);
    assert.equal(isLiveCwd(undefined), false);
});

// ── claude argv builder: resume vs new vs primed ────────────────────────────
test('buildClaudeArgs resumes with --resume and the access flags', () => {
    assert.deepEqual(
        buildClaudeArgs({ resumeId: UUID_A, flags: ['--permission-mode', 'default'] }),
        ['--resume', UUID_A, '--permission-mode', 'default'],
    );
});

test('buildClaudeArgs starts a new session with just the flags', () => {
    assert.deepEqual(
        buildClaudeArgs({ flags: ['--dangerously-skip-permissions'] }),
        ['--dangerously-skip-permissions'],
    );
});

test('buildClaudeArgs appends an initial prompt for a new session', () => {
    assert.deepEqual(
        buildClaudeArgs({ flags: ['--permission-mode', 'plan'], prompt: 'do the thing' }),
        ['--permission-mode', 'plan', 'do the thing'],
    );
});

// ── script argv builder per platform ────────────────────────────────────────
test('buildScriptSpawn (macOS) passes the command as argv after the file', () => {
    const claudeArgs = ['--resume', UUID_A, '--permission-mode', 'default'];
    const out = buildScriptSpawn({ claudeBin: '/bin/claude', claudeArgs, mac: true });
    assert.deepEqual(out, {
        cmd: 'script',
        args: ['-q', '/dev/null', '/bin/claude', '--resume', UUID_A, '--permission-mode', 'default'],
    });
});

test('buildScriptSpawn (Linux) builds a single shell-quoted -c string', () => {
    const claudeArgs = ['--dangerously-skip-permissions'];
    const out = buildScriptSpawn({ claudeBin: '/bin/claude', claudeArgs, mac: false });
    const inner = ['/bin/claude', ...claudeArgs].map(shq).join(' ');
    assert.deepEqual(out, { cmd: 'script', args: ['-qfc', inner, '/dev/null'] });
    assert.equal(out.args[2], '/dev/null');
});

test('buildScriptSpawn (Linux) makes a hostile prompt inert via shq', () => {
    const hostile = "x'; rm -rf / #";
    const claudeArgs = ['--permission-mode', 'plan', hostile];
    const out = buildScriptSpawn({ claudeBin: '/bin/claude', claudeArgs, mac: false });
    // every token (incl. the prompt) is shq-quoted, so the prompt is one inert
    // shell word — the inner string is exactly the quoted join, nothing raw.
    assert.equal(out.args[1], ['/bin/claude', ...claudeArgs].map(shq).join(' '));
    assert.ok(out.args[1].includes(shq(hostile)));
    assert.ok(!out.args[1].includes(` ${hostile} `)); // never sits unquoted between spaces
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
    rb.push('abcde');
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

// ── registry: fakes (no real process behind them) ───────────────────────────
// pid above any real OS pid so killGroup's process.kill(-pid) reliably ESRCHes
// into the child.kill fallback, never signalling a real group.
function fakeChild(pid = 1073741824) {
    const c = new EventEmitter();
    c.pid = pid;
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = (sig) => { c.killed = sig || 'SIGTERM'; };
    return c;
}

test('startLive (resume) returns a fresh liveId and records the resumed session', () => {
    const r = startLive({ sessionId: UUID_A, level: 'ask' }, { spawnFn: () => fakeChild() });
    assert.match(r.liveId, UUID_RE);
    assert.equal(r.sessionId, UUID_A);
    assert.equal(r.isNew, false);
    assert.equal(r.status, 'running');
    assert.equal(getLive(r.liveId).sessionId, UUID_A);
});

test('startLive (new) keys by liveId, has no sessionId, and passes the prompt to claude', () => {
    let captured;
    const spy = (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); };
    const r = startLive({ cwd: '/tmp', level: 'plan', prompt: 'investigate the bug' }, { spawnFn: spy });
    assert.match(r.liveId, UUID_RE);
    assert.equal(r.sessionId, null);
    assert.equal(r.isNew, true);
    assert.equal(r.cwd, '/tmp');
    assert.equal(captured.opts.cwd, '/tmp');
    assert.ok(captured.args.join(' ').includes('investigate the bug'));
    assert.ok(!captured.args.join(' ').includes('--resume'));
});

test('startLive rejects an invalid access level without spawning', () => {
    let spawned = false;
    const r = startLive({ cwd: '/tmp', level: 'root' }, { spawnFn: () => { spawned = true; return fakeChild(); } });
    assert.equal(r.error, 'invalid access level');
    assert.equal(spawned, false);
    assert.equal(listLive().length, 0);
});

test('startLive rejects a second live session resuming the same id', () => {
    const opts = { spawnFn: () => fakeChild() };
    assert.equal(startLive({ sessionId: UUID_A, level: 'ask' }, opts).status, 'running');
    const dup = startLive({ sessionId: UUID_A, level: 'ask' }, opts);
    assert.equal(dup.error, 'a live session is already running for this id');
    assert.equal(listLive().length, 1);
});

test('startLive allows multiple distinct new sessions (no dup constraint)', () => {
    const opts = { spawnFn: () => fakeChild() };
    const a = startLive({ cwd: '/tmp', level: 'ask' }, opts);
    const b = startLive({ cwd: '/tmp', level: 'ask' }, opts);
    assert.match(a.liveId, UUID_RE);
    assert.match(b.liveId, UUID_RE);
    assert.notEqual(a.liveId, b.liveId);
    assert.equal(listLive().length, 2);
});

test('startLive caps concurrent live sessions', () => {
    const opts = { spawnFn: () => fakeChild() };
    for (let i = 0; i < 6; i++) {
        assert.equal(startLive({ cwd: '/tmp', level: 'ask' }, opts).status, 'running');
    }
    assert.equal(startLive({ cwd: '/tmp', level: 'ask' }, opts).error, 'too many live sessions running');
});

// ── output parser/forwarder: ANSI bytes in → stripped text out ──────────────
test('startLive strips ANSI from child output and forwards + buffers it by liveId', () => {
    const child = fakeChild();
    const seen = [];
    const r = startLive({ sessionId: UUID_A, level: 'ask' }, { spawnFn: () => child, onData: (id, text) => seen.push([id, text]) });
    child.stdout.emit('data', Buffer.from('\x1b[32mhello\x1b[0m\n'));
    assert.deepEqual(seen, [[r.liveId, 'hello\n']]);
    assert.equal(liveBuffer(r.liveId), 'hello\n');
});

// ── shutdown escalation (SIGTERM grace → SIGKILL stragglers) ────────────────
test('hardKillAllLive force-kills sessions that have not reported exit', () => {
    const child = fakeChild();
    startLive({ sessionId: UUID_A, level: 'ask' }, { spawnFn: () => child });
    assert.equal(hardKillAllLive(), 1);
    assert.equal(child.killed, 'SIGKILL');
});

test('hardKillAllLive skips sessions that already exited (no kill on a reusable pid)', () => {
    const child = fakeChild();
    startLive({ sessionId: UUID_A, level: 'ask' }, { spawnFn: () => child });
    child.emit('close', 0);
    child.killed = undefined;
    assert.equal(hardKillAllLive(), 0);
    assert.equal(child.killed, undefined);
});

test('stopAllLive SIGTERMs running groups and marks them stopped', () => {
    const child = fakeChild();
    const r = startLive({ sessionId: UUID_B, level: 'ask' }, { spawnFn: () => child });
    stopAllLive();
    assert.equal(child.killed, 'SIGTERM');
    assert.equal(getLive(r.liveId).status, 'stopped');
});

// ── full lifecycle with a real benign stand-in (no real claude) ─────────────
test('startLive streams output, then stopLive kills it and surfaces exit', async () => {
    // `exec sleep` so the stand-in is a SINGLE process: its stdout pipe has one
    // holder, so killing it always closes the stream and fires 'close'. A plain
    // `sh -c '… ; sleep'` is two processes (sh + sleep) and sleep inherits the
    // pipe, so if a kill reaches only the shell the stream stays open and the
    // close event never arrives.
    const standIn = (cmd, args, opts) => realSpawn('sh', ['-c', 'printf "READY\\n"; exec sleep 30'], opts);
    let resolveData, resolveExit;
    const gotData = new Promise((r) => { resolveData = r; });
    const exited = new Promise((r) => { resolveExit = r; });
    const r = startLive(
        { cwd: '/tmp', level: 'ask', prompt: 'go' },
        {
            spawnFn: standIn,
            onData: (id, text) => { if (text.includes('READY')) resolveData(text); },
            onExit: (id, entry) => resolveExit(entry),
        },
    );
    assert.equal(r.status, 'running');
    assert.equal(r.isNew, true);
    assert.ok(r.pid > 0);

    const text = await Promise.race([gotData, timeout(6000, 'no output')]);
    assert.ok(text.includes('READY'));
    assert.equal(getLive(r.liveId).status, 'running');

    assert.equal(stopLive(r.liveId), true);
    const entry = await Promise.race([exited, timeout(6000, 'no exit')]);
    assert.equal(entry.status, 'stopped');
    assert.equal(getLive(r.liveId).status, 'stopped');
});

function timeout(ms, msg) {
    return new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms).unref());
}
