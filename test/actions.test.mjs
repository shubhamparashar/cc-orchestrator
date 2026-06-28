import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { attachCommand } from '../lib/actions.mjs';

test('attachCommand resumes the session in its cwd', () => {
    assert.equal(attachCommand({ sessionId: 'abc-123', cwd: '/repo/x' }), 'cd /repo/x && claude --resume abc-123');
});
test('attachCommand with fork appends --fork-session', () => {
    assert.equal(attachCommand({ sessionId: 'abc-123', cwd: '/repo/x', fork: true }), 'cd /repo/x && claude --resume abc-123 --fork-session');
});
test('attachCommand falls back to ~ when no cwd', () => {
    assert.equal(attachCommand({ sessionId: 'abc-123' }), 'cd ~ && claude --resume abc-123');
});
test('attachCommand with skipPermissions appends --dangerously-skip-permissions', () => {
    assert.equal(attachCommand({ sessionId: 'abc-123', cwd: '/repo/x', skipPermissions: true }), 'cd /repo/x && claude --resume abc-123 --dangerously-skip-permissions');
});
test('attachCommand with fork and skipPermissions appends both flags in order', () => {
    assert.equal(attachCommand({ sessionId: 'abc-123', cwd: '/repo/x', fork: true, skipPermissions: true }), 'cd /repo/x && claude --resume abc-123 --fork-session --dangerously-skip-permissions');
});
