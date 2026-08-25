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
