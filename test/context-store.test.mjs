import test from 'node:test';
import assert from 'node:assert/strict';

import { indexFileForPort, isSessionUuid } from '../lib/contextStore.mjs';

test('indexFileForPort namespaces non-default ports, keeps the legacy name for the default', () => {
    assert.equal(indexFileForPort('7433'), 'index.json', 'default port keeps the legacy name');
    assert.equal(indexFileForPort(7433), 'index.json', 'numeric default matches');
    assert.equal(indexFileForPort(undefined), 'index.json', 'unset → default');
    assert.equal(indexFileForPort(''), 'index.json', 'empty → default');
    assert.equal(indexFileForPort('7466'), 'index-7466.json', 'a second instance gets its own file');
    assert.equal(indexFileForPort(8000), 'index-8000.json', 'numeric non-default namespaced');
    // Canonicalize like the server's Number(PORT): non-canonical strings must resolve
    // to the file the server actually binds, not a phantom no server reads.
    assert.equal(indexFileForPort('07433'), 'index.json', 'leading zero canonicalizes to default');
    assert.equal(indexFileForPort(' 7433'), 'index.json', 'whitespace canonicalizes to default');
    assert.equal(indexFileForPort('abc'), 'index.json', 'non-numeric falls back to default, not index-abc.json');
    // The whole point: two servers on different ports never resolve to one file.
    assert.notEqual(indexFileForPort('7433'), indexFileForPort('7466'));
});

test('isSessionUuid is strict — anchored, lowercase hex, fixed length (path-traversal guard)', () => {
    assert.ok(isSessionUuid('0123abcd-4567-89ab-cdef-0123456789ab'), 'a real id passes');
    assert.ok(!isSessionUuid('0123ABCD-4567-89AB-CDEF-0123456789AB'), 'uppercase rejected');
    assert.ok(!isSessionUuid('0123abcd-4567-89ab-cdef-0123456789ab.jsonl'), 'trailing suffix rejected');
    assert.ok(!isSessionUuid('../../../etc/passwd'), 'traversal rejected');
    assert.ok(!isSessionUuid('0123abcd-4567-89ab-cdef-0123456789ab/..'), 'embedded slash rejected');
    assert.ok(!isSessionUuid(''), 'empty rejected');
    assert.ok(!isSessionUuid(null), 'non-string rejected');
});
