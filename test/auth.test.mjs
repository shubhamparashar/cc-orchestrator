import test from 'node:test';
import assert from 'node:assert';

import { isLocalRequest } from '../lib/auth.mjs';

const loopbackReq = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:7433' } };

test('isLocalRequest treats loopback as local when CC_REQUIRE_TOKEN_LOCAL is unset', () => {
    delete process.env.CC_REQUIRE_TOKEN_LOCAL;
    assert.strictEqual(isLocalRequest(loopbackReq), true);
});

test('CC_REQUIRE_TOKEN_LOCAL=1 forces loopback onto the token-required path', () => {
    process.env.CC_REQUIRE_TOKEN_LOCAL = '1';
    try {
        assert.strictEqual(isLocalRequest(loopbackReq), false);
    } finally {
        // Restore so call order doesn't leak the gate into other tests.
        delete process.env.CC_REQUIRE_TOKEN_LOCAL;
    }
});
