/**
 * What a project's storage adds to the start of its process.
 *
 * A process starts in three places (a deployment, a promote, the boot) and in
 * the storage switch. Each one has to hand the process its database address and
 * set the firewall path for the account it runs as, and each one has to do
 * neither for a project on local files or for a preview. One function builds
 * that, and these tests hold it and the hook `runtime.restart` calls it through.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

process.env.AEGIS_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-start-root-'));

const runtime = require('../runtime');
const deployService = require('../deployService');
const projectStorage = require('../projectStorage');
const storageNetwork = require('../storageNetwork');

function listening() {
    return ({ port }) => {
        const child = new EventEmitter();
        const server = http.createServer((req, res) => res.end('ok'));
        server.listen(port, '127.0.0.1');
        child.kill = () => { server.close(); return true; };
        return child;
    };
}

async function withRuntime(fn) {
    const before = [process.env.AEGIS_DEPLOY_RUNTIME, process.env.AEGIS_RUNTIME_ACCOUNTS];
    process.env.AEGIS_DEPLOY_RUNTIME = '1';
    process.env.AEGIS_RUNTIME_ACCOUNTS = 'run-a,run-b';
    try {
        return await fn();
    } finally {
        if (before[0] === undefined) delete process.env.AEGIS_DEPLOY_RUNTIME;
        else process.env.AEGIS_DEPLOY_RUNTIME = before[0];
        if (before[1] === undefined) delete process.env.AEGIS_RUNTIME_ACCOUNTS;
        else process.env.AEGIS_RUNTIME_ACCOUNTS = before[1];
    }
}

function switched(over) {
    const target = projectStorage.normalise({ kind: 'postgres', host: '10.0.0.10', port: 5432, database: 'app', user: 'app_rw' });
    const project = Object.assign({ id: 'site', runtime: 'node', port: 3170 }, over);
    project.storage = projectStorage.withTarget(project, target, 'pw');
    project.storage = projectStorage.withMode(project, 'postgres', 'admin@acme.test');
    return project;
}

test('restart calls prepare with the account it chose, before the process exists', async () => {
    await withRuntime(async () => {
        const order = [];
        const spawn = (args) => { order.push(`spawn as ${args.account}`); return listening()(args); };
        try {
            await runtime.restart({
                slug: 'acme', project: { id: 'prep', port: 3170 }, dir: '.', startCmd: 'x', spawn, drainMs: 0,
                prepare: async (account) => { order.push(`prepare ${account}`); }
            });
            assert.deepStrictEqual(order, ['prepare run-a', 'spawn as run-a']);
        } finally {
            runtime.stop('acme', 'prep');
        }
    });
});

test('a prepare that throws does not fail the start', async () => {
    await withRuntime(async () => {
        try {
            const started = await runtime.restart({
                slug: 'acme', project: { id: 'prep2', port: 3171 }, dir: '.', startCmd: 'x', spawn: listening(), drainMs: 0,
                prepare: async () => { throw new Error('the firewall service is stopped'); }
            });
            assert.ok(started.port > 0);
            assert.strictEqual(runtime.isRunning('acme', 'prep2'), true);
        } finally {
            runtime.stop('acme', 'prep2');
        }
    });
});

test('runtimeExtras: the address and the path for a switched project, neither for the others', async () => {
    const calls = [];
    const before = process.env.AEGIS_DEPLOY_FIREWALL;
    process.env.AEGIS_DEPLOY_FIREWALL = '1';
    storageNetwork._setRunner((script) => {
        calls.push(script);
        return { ok: true, out: JSON.stringify({ deny: [], data: null }) };
    });
    fs.mkdirSync(path.dirname(projectStorage.targetsFile()), { recursive: true });
    fs.writeFileSync(projectStorage.targetsFile(), '10.0.0.10:5432\n');
    try {
        const live = deployService.runtimeExtras(switched());
        assert.deepStrictEqual(live.env, { DATABASE_URL: 'postgresql://app_rw:pw@10.0.0.10:5432/app' });
        assert.deepStrictEqual(await live.prepare('run-a'), { ok: true, changed: false, managed: true, inside: false });
        assert.strictEqual(calls.length, 1, 'the account\'s rules are read at every start');

        const local = deployService.runtimeExtras({ id: 'plain', runtime: 'node' });
        assert.deepStrictEqual(local.env, {});
        assert.strictEqual((await local.prepare('run-a')).ok, true, 'a local project still puts the account back to its whole rules');

        const preview = deployService.runtimeExtras(switched({ id: 'site-pr', parentId: 'site' }));
        assert.deepStrictEqual(preview.env, {}, 'a preview was handed the live database');
    } finally {
        fs.rmSync(projectStorage.targetsFile(), { force: true });
        storageNetwork._setRunner(null);
        if (before === undefined) delete process.env.AEGIS_DEPLOY_FIREWALL;
        else process.env.AEGIS_DEPLOY_FIREWALL = before;
    }
});

test('exclusive holds the project the way a deployment does', async () => {
    let release;
    const held = deployService.exclusive('acme', 'site', () => new Promise((resolve) => { release = resolve; }));

    assert.strictEqual(deployService.isDeploying('acme', 'site'), true);
    assert.deepStrictEqual(await deployService.exclusive('acme', 'site', async () => 'second'), { busy: true });
    assert.deepStrictEqual(
        await deployService.deployNow({ slug: 'acme', tenantPaths: {}, project: { id: 'site' } }),
        { deployed: false, reason: 'busy' }, 'a push must not deploy in the middle of a switch');

    release('done');
    assert.deepStrictEqual(await held, { busy: false, value: 'done' });
    assert.strictEqual(deployService.isDeploying('acme', 'site'), false);

    await assert.rejects(deployService.exclusive('acme', 'site', async () => { throw new Error('boom'); }), /boom/);
    assert.strictEqual(deployService.isDeploying('acme', 'site'), false, 'a failure must not leave the project locked');
});

test('an address taken off the approved list closes the path at the next start', async () => {
    const file = projectStorage.targetsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const scripts = [];
    const before = process.env.AEGIS_DEPLOY_FIREWALL;
    process.env.AEGIS_DEPLOY_FIREWALL = '1';
    const opened = {
        deny: [{ name: 'AegisBuild-run-a-DenyDomain-10_0_0_0_8', enabled: 'True', remote: ['10.0.0.0-10.0.0.9', '10.0.0.11-10.255.255.255'] }],
        data: { remote: ['10.0.0.10'], ports: ['1-5431', '5433-65535'] }
    };
    storageNetwork._setRunner((script) => {
        scripts.push(script);
        return { ok: true, out: JSON.stringify(opened) };
    });
    try {
        fs.writeFileSync(file, '10.0.0.10:5432\n');
        const approved = await deployService.runtimeExtras(switched()).prepare('run-a');
        assert.deepStrictEqual([approved.changed, approved.inside], [false, true], 'approved and already open: nothing to do');

        fs.writeFileSync(file, '# removed by an administrator\n');
        const revoked = await deployService.runtimeExtras(switched()).prepare('run-a');
        assert.deepStrictEqual([revoked.changed, revoked.inside], [true, false]);
        const written = scripts[scripts.length - 1];
        assert.ok(written.includes('-RemoteAddress 10.0.0.0/8 -Enabled True'), 'the deny rule was not put back whole');
        assert.ok(!written.includes('New-NetFirewallRule'));
    } finally {
        storageNetwork._setRunner(null);
        fs.rmSync(file, { force: true });
        if (before === undefined) delete process.env.AEGIS_DEPLOY_FIREWALL;
        else process.env.AEGIS_DEPLOY_FIREWALL = before;
    }
});
