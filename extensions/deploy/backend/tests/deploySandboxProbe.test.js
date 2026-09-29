'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPool } = require('../build/accountPool');
const { probeAll } = require('../build/sandboxProbe');

function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-probe-'));
}

const refused = (account) => Object.assign(new Error('Command failed'),
    { code: 3, sandboxStart: true, output: `could not start the build as ${account} (Windows error 1326)\n` });

test('a probe takes out the account that will not start, and leaves the others in service', async () => {
    const pool = createPool(['a', 'b']);
    const seen = [];
    const results = await probeAll({
        pool, workspaceRoot: tmpRoot(),
        runLauncher: async ({ account, buildCmd }) => {
            seen.push([account, buildCmd]);
            if (account === 'b') throw refused('b');
        }
    });
    assert.deepStrictEqual(seen, [['a', 'exit 0'], ['b', 'exit 0']]);
    assert.deepStrictEqual(results.map((r) => [r.account, r.ok]), [['a', true], ['b', false]]);
    assert.strictEqual(pool.freeCount(), 1);
    assert.strictEqual(await pool.borrow(), 'a');
});

test('a probe that passes puts a quarantined account back in service', async () => {
    const pool = createPool(['a']);
    pool.quarantine(await pool.borrow(), 'error 1326');
    pool.release('a');
    assert.strictEqual(pool.freeCount(), 0);

    await probeAll({ pool, workspaceRoot: tmpRoot(), runLauncher: async () => {} });
    assert.strictEqual(pool.freeCount(), 1);
    assert.strictEqual(pool.health()[0].ok, true);
});

test('a probe that times out says so without taking the account out', async () => {
    const pool = createPool(['a']);
    const [r] = await probeAll({
        pool, workspaceRoot: tmpRoot(),
        runLauncher: async () => { throw Object.assign(new Error('command timed out after 30000ms'), { code: 1 }); }
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(pool.freeCount(), 1, 'a slow host says nothing about the account');
});

test('a probe waits for a slot a build holds instead of running beside it', async () => {
    const pool = createPool(['a']);
    const held = await pool.borrow();
    let ran = false;
    const probing = probeAll({ pool, workspaceRoot: tmpRoot(), runLauncher: async () => { ran = true; } });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(ran, false);
    pool.release(held);
    await probing;
    assert.strictEqual(ran, true);
});
