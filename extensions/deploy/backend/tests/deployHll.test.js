/**
 * The anonymous visitor sketch behind the audience counts past 90 days.
 *
 * What it promises: one visitor counts once however often they are added, two
 * halves merged count what the whole would, and a large count lands near the
 * truth. What it must never do is hold a visitor id, which is why the only
 * thing it stores is 1024 small numbers.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const hll = require('../hll');

function vis(i) {
    return crypto.createHash('sha256').update(String(i)).digest('hex').slice(0, 16);
}

test('an empty sketch counts zero', () => {
    assert.strictEqual(hll.count(hll.create()), 0);
});

test('the same visitor added twice counts once', () => {
    const s = hll.create();
    hll.add(s, 'a1b2c3d4e5f60718');
    hll.add(s, 'a1b2c3d4e5f60718');
    assert.strictEqual(hll.count(s), 1);
});

test('10 000 distinct visitors count within 5 %', () => {
    const s = hll.create();
    for (let i = 0; i < 10000; i++) hll.add(s, vis(i));
    const n = hll.count(s);
    assert.ok(Math.abs(n - 10000) / 10000 < 0.05, `counted ${n}`);
});

test('a few hundred visitors count within 5 %', () => {
    const s = hll.create();
    for (let i = 0; i < 300; i++) hll.add(s, vis(i));
    const n = hll.count(s);
    assert.ok(Math.abs(n - 300) / 300 < 0.05, `counted ${n}`);
});

test('merging two halves equals adding everything to one sketch', () => {
    const a = hll.create();
    const b = hll.create();
    const whole = hll.create();
    for (let i = 0; i < 2000; i++) {
        hll.add(i % 2 ? a : b, vis(i));
        hll.add(whole, vis(i));
    }
    hll.merge(a, b);
    assert.deepStrictEqual(a, whole);
});

test('a sketch survives encode then decode', () => {
    const s = hll.create();
    for (let i = 0; i < 50; i++) hll.add(s, vis(i));
    assert.deepStrictEqual(hll.decode(hll.encode(s)), s);
});

test('decode refuses a wrong length', () => {
    assert.strictEqual(hll.decode(Buffer.alloc(10).toString('base64')), null);
    assert.strictEqual(hll.decode(42), null);
});
