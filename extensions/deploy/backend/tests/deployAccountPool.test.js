'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createPool } = require('../build/accountPool');

test('borrow returns a slot immediately while capacity remains', async () => {
    const pool = createPool(['a', 'b', 'c']);
    const a = await pool.borrow();
    const b = await pool.borrow();
    assert.notStrictEqual(a, b);
    assert.strictEqual(pool.freeCount(), 1);
});

test('a 4th borrow on a pool of 3 queues instead of resolving', async () => {
    const pool = createPool(['a', 'b', 'c']);
    await pool.borrow(); await pool.borrow(); await pool.borrow();
    assert.strictEqual(pool.freeCount(), 0);

    let resolved = false;
    const p = pool.borrow().then((acct) => { resolved = true; return acct; });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(resolved, false, 'must not hand out a 4th slot from a pool of 3');
    assert.strictEqual(pool.waitingCount(), 1);

    pool.release('a');
    const acct = await p;
    assert.strictEqual(resolved, true);
    assert.strictEqual(acct, 'a', 'the queued borrower must receive the released slot, not a stale one');
});

test('release with no waiters returns the slot to the free list, not silently dropped', async () => {
    const pool = createPool(['a', 'b']);
    const x = await pool.borrow();
    assert.strictEqual(pool.freeCount(), 1);
    pool.release(x);
    assert.strictEqual(pool.freeCount(), 2, 'released slot must become borrowable again');
    const y = await pool.borrow();
    assert.ok(['a', 'b'].includes(y));
});

test('waiters are served in FIFO order, not LIFO', async () => {
    const pool = createPool(['a']);
    const held = await pool.borrow();
    const order = [];
    const p1 = pool.borrow().then((acct) => { order.push('first'); return acct; });
    const p2 = pool.borrow().then((acct) => { order.push('second'); return acct; });
    await new Promise((r) => setImmediate(r));

    pool.release(held);
    const gotP1 = await p1;
    assert.deepStrictEqual(order, ['first'], 'the earlier waiter must be served first');

    pool.release(gotP1);
    await p2;
    assert.deepStrictEqual(order, ['first', 'second']);
});

test('a quarantined slot is never handed out again, and restore puts it back', async () => {
    const pool = createPool(['a', 'b']);
    const a = await pool.borrow();
    pool.quarantine(a, 'Windows error 1326');
    pool.release(a);
    assert.strictEqual(pool.freeCount(), 1, 'the quarantined slot must not return to the free list');

    const b = await pool.borrow();
    assert.strictEqual(b, 'b');
    const waiting = pool.borrow();
    pool.restore('a');
    assert.strictEqual(await waiting, 'a', 'a restored slot goes to whoever is waiting');
    assert.deepStrictEqual(pool.health().map((h) => [h.account, h.ok]), [['a', true], ['b', null]]);
});

test('when every slot is quarantined, borrow refuses at once and waiters are refused, not hung', async () => {
    const pool = createPool(['a', 'b']);
    const a = await pool.borrow();
    const b = await pool.borrow();
    const waiting = pool.borrow();
    pool.quarantine(a, 'error 5');
    pool.release(a);
    pool.quarantine(b, 'error 1326');
    pool.release(b);

    await assert.rejects(waiting, (e) => e.code === 'sandbox_unavailable' && /a: error 5; b: error 1326/.test(e.message));
    await assert.rejects(pool.borrow(), (e) => e.code === 'sandbox_unavailable');
});

test('borrow(account) waits for that slot and leaves the others to anyone else', async () => {
    const pool = createPool(['a', 'b']);
    const a = await pool.borrow();
    let got = null;
    const wantA = pool.borrow('a').then((x) => { got = x; });
    assert.strictEqual(await pool.borrow(), 'b', 'a waiter for a named slot must not hold the free one');
    pool.release('b');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(got, null, 'releasing another slot must not satisfy it');
    pool.release(a);
    await wantA;
    assert.strictEqual(got, 'a');
});
