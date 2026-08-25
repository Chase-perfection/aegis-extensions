/**
 * The node runtime: the internal ports, the account it holds, and the flip.
 *
 * This is the one part of Deploy that leaves a process running on the audit
 * server, so the tests are about the two things that decide whether that is
 * safe to operate. The port arithmetic, because two projects handed the same
 * internal port would serve each other's application. And the flip, because a
 * new version that does not answer must leave the old one exactly where it was:
 * a deployment that fails is normal, a deployment that fails and takes the site
 * down with it is not.
 *
 * No pwsh, no restricted account and no real application here. `restart` takes
 * the spawner, and these tests pass one that starts a plain `http` server, which
 * is what the proxy sees anyway.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { EventEmitter } = require('events');

const runtime = require('../runtime');

/**
 * A stand-in for the sandboxed pwsh: a real listener on the port it was given,
 * with `kill` closing it. `answers: false` starts nothing, which is how a
 * start command that crashes on boot looks from here.
 */
function fakeSpawn({ answers = true, body = 'ok' } = {}) {
    return ({ port }) => {
        const child = new EventEmitter();
        if (!answers) {
            // Nothing listening, and the process is gone: `restart` must not
            // wait the full health timeout for it.
            setImmediate(() => child.emit('exit', 1, null));
            child.kill = () => true;
            return child;
        }
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(`${body} ${port}`);
        });
        server.listen(port, '127.0.0.1');
        child.kill = () => { server.close(); return true; };
        child.server = server;
        return child;
    };
}

function get(port) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
            let text = '';
            res.on('data', (b) => { text += b; });
            res.on('end', () => resolve(text));
        }).on('error', reject);
    });
}

test('the runtime is off unless the host says otherwise, twice', () => {
    const before = [process.env.AEGIS_DEPLOY_RUNTIME, process.env.AEGIS_RUNTIME_ACCOUNTS];
    try {
        delete process.env.AEGIS_DEPLOY_RUNTIME;
        process.env.AEGIS_RUNTIME_ACCOUNTS = 'aegis-run-01';
        assert.strictEqual(runtime.isEnabled(), false, 'enabled without the host flag');

        process.env.AEGIS_DEPLOY_RUNTIME = '1';
        process.env.AEGIS_RUNTIME_ACCOUNTS = '';
        assert.strictEqual(runtime.isEnabled(), false, 'enabled with no accounts');

        process.env.AEGIS_RUNTIME_ACCOUNTS = 'aegis-run-01, aegis-run-02';
        assert.strictEqual(runtime.isEnabled(), true);
        assert.deepStrictEqual(runtime.accounts(), ['aegis-run-01', 'aegis-run-02']);
    } finally {
        if (before[0] === undefined) delete process.env.AEGIS_DEPLOY_RUNTIME;
        else process.env.AEGIS_DEPLOY_RUNTIME = before[0];
        if (before[1] === undefined) delete process.env.AEGIS_RUNTIME_ACCOUNTS;
        else process.env.AEGIS_RUNTIME_ACCOUNTS = before[1];
    }
});

test('two internal ports per site, and no two sites share one', () => {
    const base = runtime.runtimeBase();
    assert.strictEqual(runtime.portFor(3081, 0, 3081, 100), base);
    assert.strictEqual(runtime.portFor(3081, 1, 3081, 100), base + 1);
    assert.strictEqual(runtime.portFor(3082, 0, 3081, 100), base + 2);

    const seen = new Set();
    for (let sitePort = 3081; sitePort < 3181; sitePort++) {
        for (const slot of [0, 1]) {
            const port = runtime.portFor(sitePort, slot, 3081, 100);
            assert.strictEqual(seen.has(port), false, `${port} handed out twice`);
            seen.add(port);
        }
    }
    assert.strictEqual(seen.size, 200);
});

test('a site port outside the range has no internal port', () => {
    assert.throws(() => runtime.portFor(80, 0, 3081, 100), { code: 'bad_site_port' });
    assert.throws(() => runtime.portFor(3181, 0, 3081, 100), { code: 'bad_site_port' });
});

test('an account is held for the project until it is stopped, then reused', async () => {
    const before = [process.env.AEGIS_DEPLOY_RUNTIME, process.env.AEGIS_RUNTIME_ACCOUNTS];
    process.env.AEGIS_DEPLOY_RUNTIME = '1';
    process.env.AEGIS_RUNTIME_ACCOUNTS = 'run-a,run-b';
    const spawn = fakeSpawn();

    try {
        await runtime.restart({
            slug: 'acme', project: { id: 'one', port: 3081 }, dir: '.', startCmd: 'x',
            spawn, drainMs: 0
        });
        await runtime.restart({
            slug: 'acme', project: { id: 'two', port: 3082 }, dir: '.', startCmd: 'x',
            spawn, drainMs: 0
        });

        assert.throws(() => runtime.accountFor('acme', 'three'), { code: 'no_runtime_account' });

        // The same project asking again keeps the account it already holds,
        // which is what makes a redeploy possible on a full install.
        assert.strictEqual(runtime.accountFor('acme', 'one'), 'run-a');

        runtime.stop('acme', 'one');
        assert.strictEqual(runtime.accountFor('acme', 'three'), 'run-a');
    } finally {
        runtime.stop('acme', 'one');
        runtime.stop('acme', 'two');
        if (before[0] === undefined) delete process.env.AEGIS_DEPLOY_RUNTIME;
        else process.env.AEGIS_DEPLOY_RUNTIME = before[0];
        if (before[1] === undefined) delete process.env.AEGIS_RUNTIME_ACCOUNTS;
        else process.env.AEGIS_RUNTIME_ACCOUNTS = before[1];
    }
});

test('a new version takes over on the other slot, and the old one is dropped', async () => {
    const before = [process.env.AEGIS_DEPLOY_RUNTIME, process.env.AEGIS_RUNTIME_ACCOUNTS];
    process.env.AEGIS_DEPLOY_RUNTIME = '1';
    process.env.AEGIS_RUNTIME_ACCOUNTS = 'run-a';
    const project = { id: 'app', port: 3090 };

    try {
        const first = await runtime.restart({
            slug: 'acme', project, dir: '.', startCmd: 'x',
            spawn: fakeSpawn({ body: 'v1' }), drainMs: 0
        });
        assert.strictEqual(runtime.targetFor('acme', 'app'), first.port);
        assert.ok((await get(first.port)).startsWith('v1'));

        const second = await runtime.restart({
            slug: 'acme', project, dir: '.', startCmd: 'x',
            spawn: fakeSpawn({ body: 'v2' }), drainMs: 0
        });
        assert.notStrictEqual(second.port, first.port, 'the new version took the port in use');
        assert.strictEqual(second.slot, 1);
        assert.strictEqual(runtime.targetFor('acme', 'app'), second.port);
        assert.ok((await get(second.port)).startsWith('v2'));

        // Third time it comes back to the first slot, so the two ports are all
        // this project ever uses.
        const third = await runtime.restart({
            slug: 'acme', project, dir: '.', startCmd: 'x',
            spawn: fakeSpawn({ body: 'v3' }), drainMs: 0
        });
        assert.strictEqual(third.port, first.port);
    } finally {
        runtime.stop('acme', 'app');
        if (before[0] === undefined) delete process.env.AEGIS_DEPLOY_RUNTIME;
        else process.env.AEGIS_DEPLOY_RUNTIME = before[0];
        if (before[1] === undefined) delete process.env.AEGIS_RUNTIME_ACCOUNTS;
        else process.env.AEGIS_RUNTIME_ACCOUNTS = before[1];
    }
});

test('a version that never answers leaves the running one serving', async () => {
    const before = [process.env.AEGIS_DEPLOY_RUNTIME, process.env.AEGIS_RUNTIME_ACCOUNTS];
    process.env.AEGIS_DEPLOY_RUNTIME = '1';
    process.env.AEGIS_RUNTIME_ACCOUNTS = 'run-a';
    const project = { id: 'app2', port: 3091 };

    try {
        const good = await runtime.restart({
            slug: 'acme', project, dir: '.', startCmd: 'x',
            spawn: fakeSpawn({ body: 'live' }), drainMs: 0
        });

        await assert.rejects(() => runtime.restart({
            slug: 'acme', project, dir: '.', startCmd: 'boom',
            spawn: fakeSpawn({ answers: false }), drainMs: 0
        }), (e) => e.code === 'start_failed' || e.code === 'unhealthy');

        assert.strictEqual(runtime.targetFor('acme', 'app2'), good.port, 'the proxy was moved anyway');
        assert.ok((await get(good.port)).startsWith('live'));
    } finally {
        runtime.stop('acme', 'app2');
        if (before[0] === undefined) delete process.env.AEGIS_DEPLOY_RUNTIME;
        else process.env.AEGIS_DEPLOY_RUNTIME = before[0];
        if (before[1] === undefined) delete process.env.AEGIS_RUNTIME_ACCOUNTS;
        else process.env.AEGIS_RUNTIME_ACCOUNTS = before[1];
    }
});

test('restart refuses outright when the host has not enabled the runtime', async () => {
    const before = process.env.AEGIS_DEPLOY_RUNTIME;
    delete process.env.AEGIS_DEPLOY_RUNTIME;
    try {
        await assert.rejects(() => runtime.restart({
            slug: 'acme', project: { id: 'x', port: 3081 }, dir: '.', startCmd: 'x', spawn: fakeSpawn()
        }), { code: 'runtime_disabled' });
    } finally {
        if (before === undefined) delete process.env.AEGIS_DEPLOY_RUNTIME;
        else process.env.AEGIS_DEPLOY_RUNTIME = before;
    }
});

test('health says no for a port with nothing behind it', async () => {
    assert.strictEqual(await runtime.health(3099, 300), false);
});
