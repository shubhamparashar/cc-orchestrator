import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { attachCommand, contextualPrompt } from '../lib/actions.mjs';

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

test('contextualPrompt primes the prompt to read the context file first', () => {
    assert.equal(
        contextualPrompt('fix the bug', '/ctx/abc.md'),
        'Read /ctx/abc.md for prior context, then: fix the bug',
    );
});
test('contextualPrompt returns the prompt unchanged when there is no context path', () => {
    assert.equal(contextualPrompt('fix the bug'), 'fix the bug');
    assert.equal(contextualPrompt('fix the bug', null), 'fix the bug');
});
