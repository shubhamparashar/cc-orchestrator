import test from 'node:test';
import assert from 'node:assert';

import { getCookie, rateLimitKey } from '../lib/auth.mjs';

test('getCookie returns the literal value on malformed %-encoding (never throws)', () => {
    const req = { headers: { cookie: 'cc_token=%' } };
    assert.doesNotThrow(() => getCookie(req, 'cc_token'));
    assert.strictEqual(getCookie(req, 'cc_token'), '%');
});

test('getCookie still decodes a well-formed percent-encoded value', () => {
    const req = { headers: { cookie: 'cc_token=a%20b' } };
    assert.strictEqual(getCookie(req, 'cc_token'), 'a b');
});

test('getCookie returns null for an absent cookie', () => {
    assert.strictEqual(getCookie({ headers: {} }, 'cc_token'), null);
});

test('rateLimitKey ignores X-Forwarded-For from a direct (non-loopback) peer', () => {
    // A LAN/remote attacker controls its own XFF; the honest identity is the socket.
    const req = {
        socket: { remoteAddress: '192.168.1.50' },
        headers: { 'x-forwarded-for': '1.1.1.1' },
    };
    assert.strictEqual(rateLimitKey(req), '192.168.1.50');
    // Rotating the spoofed header must not change the key.
    req.headers['x-forwarded-for'] = '2.2.2.2';
    assert.strictEqual(rateLimitKey(req), '192.168.1.50');
});

test('rateLimitKey trusts the last XFF hop from a loopback proxy', () => {
    const req = {
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'x-forwarded-for': 'client, 100.64.0.2' },
    };
    assert.strictEqual(rateLimitKey(req), '100.64.0.2');
});

test('rateLimitKey prefers the non-forgeable Tailscale identity', () => {
    const req = {
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'tailscale-user-login': 'me@example.com', 'x-forwarded-for': '9.9.9.9' },
    };
    assert.strictEqual(rateLimitKey(req), 'ts:me@example.com');
});
