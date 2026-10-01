'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { isSid, targetSids, broadSids } = require('../sids');

test('isSid accepts domain SIDs and the well-known SIDs the analysis names', () => {
    for (const ok of ['S-1-5-21-1004336348-1177238915-682003330-512', 'S-1-5-21-1-2-3-4', 'S-1-5-32-544', 'S-1-1-0', 'S-1-5-18']) {
        assert.ok(isSid(ok), ok);
    }
});

test('isSid refuses anything else, including what a route parameter could smuggle', () => {
    const bad = ['S-1-5-21-1-2-3', 'S-1-5-21-1-2-3-4-5', 'S-1-5-21-1-2-3-4\n', 'S-1-5-21-1-2-3-4/../x',
        's-1-5-21-1-2-3-4', 'S-1-5-32-999', '', null, undefined, 42, 'S-1-5-21-12345678901-1-1-1'];
    for (const value of bad) assert.ok(!isSid(value), JSON.stringify(value));
});

test('target and broad SIDs are built under the domain SID', () => {
    const targets = targetSids('S-1-5-21-1-2-3');
    assert.ok(targets.has('S-1-5-21-1-2-3-512'));
    assert.ok(targets.has('S-1-5-32-544'));
    assert.ok(!targets.has('S-1-5-21-1-2-3-513'));
    const broad = broadSids('S-1-5-21-1-2-3');
    assert.ok(broad.has('S-1-5-21-1-2-3-513'));
    assert.ok(broad.has('S-1-5-11'));
});
