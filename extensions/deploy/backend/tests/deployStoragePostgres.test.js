/**
 * A deployment of a project whose data is on Postgres.
 *
 * Three things change for such a project, and a deployment that got any of
 * them wrong would look green. Its Postgres migrations are played on the
 * database before the process starts. Its SQLite file is not touched, because
 * that file is what the operator was told is kept as the way back. And the
 * process is started with the database address.
 *
 * `cloner` and `runtime` are replaced on their module objects, as
 * `deployMigrationsGate.test.js` does, so no clone, account or process is
 * needed to prove an order of calls.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-pgdeploy-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;

const test = require('node:test');
const assert = require('node:assert');

const cloner = require('../cloner');
const runtime = require('../runtime');
const projectStore = require('../projectStore');
const projectStorage = require('../projectStorage');
const runs = require('../runs');
const deployService = require('../deployService');
const { fakeClient } = require('./helpers/fakePg');

console.log = () => { };
console.warn = () => { };

/** The fixture's database, on the list an administrator keeps on the host. */
function approve() {
    fs.mkdirSync(path.dirname(projectStorage.targetsFile()), { recursive: true });
    fs.writeFileSync(projectStorage.targetsFile(), '10.0.0.10:5432\n');
}
approve();

function fixture() {
    const slug = `t${Math.random().toString(36).slice(2, 8)}`;
    const root = path.join(DATA_ROOT, 'tenants', slug);
    const tenantPaths = { root, deploy: path.join(root, 'deploy') };

    const project = { id: 'site', name: 'Site', repoFullName: 'acme/site', branch: 'main', runtime: 'node', startCmd: 'node server.js', port: 3160, lastSha: null };
    const target = projectStorage.normalise({ kind: 'postgres', host: '10.0.0.10', port: 5432, database: 'app', user: 'app_rw' });
    project.storage = projectStorage.withTarget(project, target, 'pw');
    project.storage = projectStorage.withMode(project, 'postgres', 'admin@acme.test');

    // The version a clone would have staged, carrying both dialects.
    const versionDir = path.join(projectStore.projectDir(tenantPaths, project.id), 'releases', 'cccc3333');
    fs.mkdirSync(path.join(versionDir, 'migrations', 'postgres'), { recursive: true });
    fs.writeFileSync(path.join(versionDir, 'migrations', '0001_init.sql'), 'CREATE TABLE a (id INTEGER);');
    fs.writeFileSync(path.join(versionDir, 'migrations', 'postgres', '0001_init.sql'), 'CREATE TABLE a (id integer);');

    return { slug, tenantPaths, project, versionDir };
}

/** Replaces the clone and the process start, and records the start's arguments. */
function stub(versionDir) {
    const real = { clone: cloner.cloneToCurrent, restart: runtime.restart, point: cloner.pointCurrent, prune: cloner.pruneReleases };
    const calls = { restarts: [] };
    cloner.cloneToCurrent = async () => ({ sha: 'cccc3333cccc3333cccc3333cccc3333cccc3333', dir: versionDir });
    cloner.pointCurrent = () => { };
    cloner.pruneReleases = () => { };
    runtime.restart = async (args) => { calls.restarts.push(args); return { port: 3400, slot: 0 }; };
    calls.restore = () => {
        cloner.cloneToCurrent = real.clone;
        cloner.pointCurrent = real.point;
        cloner.pruneReleases = real.prune;
        runtime.restart = real.restart;
        deployService.usePostgres(null);
        deployService.useWritableDb(null);
    };
    return calls;
}

function ledgerless(sql) {
    if (sql.startsWith('SELECT to_regclass')) return [{ t: null }];
    return undefined;
}

function sqliteSpy() {
    const spy = { calls: 0 };
    for (const fn of ['appliedMigrations', 'execScript', 'recordMigration']) {
        spy[fn] = async () => { spy.calls++; return []; };
    }
    return spy;
}

function record(slug, tenantPaths, project) {
    return runs.start({ slug, tenantPaths, projectId: project.id, projectName: project.name, branch: project.branch, trigger: 'manual' });
}

test('the Postgres migrations are played on the database, the SQLite file is left alone, and the process gets the address', async () => {
    const { slug, tenantPaths, project, versionDir } = fixture();
    const calls = stub(versionDir);
    const client = fakeClient(ledgerless);
    const connects = [];
    const sqlite = sqliteSpy();
    deployService.usePostgres({ connect: async (opts) => { connects.push(opts); return client; } });
    deployService.useWritableDb(sqlite);
    const run = record(slug, tenantPaths, project);

    try {
        const result = await deployService.deployNow({ app: null, slug, tenantPaths, project, trigger: 'manual', run });
        assert.strictEqual(result.deployed, true);
    } finally {
        calls.restore();
    }

    assert.deepStrictEqual(connects, [{ kind: 'postgres', host: '10.0.0.10', port: 5432, database: 'app', user: 'app_rw', ssl: false, consoleUrl: '', password: 'pw' }]);
    assert.ok(client.sql().includes('CREATE TABLE a (id integer);'), 'the Postgres file was not played');
    assert.strictEqual(client.ended, true);
    assert.strictEqual(sqlite.calls, 0, 'the SQLite file is the way back and must not be migrated');
    assert.strictEqual(run.stages.find((s) => s.key === 'migrate').status, 'done');

    assert.strictEqual(calls.restarts.length, 1);
    assert.strictEqual(calls.restarts[0].env.DATABASE_URL, 'postgresql://app_rw:pw@10.0.0.10:5432/app');
    assert.strictEqual(typeof calls.restarts[0].prepare, 'function');
    // The schema before the process: a version must never boot on a database
    // that lacks the column its code expects.
    assert.ok(client.sql().indexOf('COMMIT') !== -1);
});

test('an Aegis with no Postgres client refuses the deployment and starts nothing', async () => {
    const { slug, tenantPaths, project, versionDir } = fixture();
    const calls = stub(versionDir);
    deployService.usePostgres(null);

    try {
        await assert.rejects(
            deployService.deployNow({ app: null, slug, tenantPaths, project, trigger: 'manual', run: record(slug, tenantPaths, project) }),
            (e) => e.code === 'migrations_unsupported' && e.reason === 'migrations_unsupported');
    } finally {
        calls.restore();
    }
    assert.strictEqual(calls.restarts.length, 0);
});

test('a migration the database refuses stops the deployment before the process, and closes the connection', async () => {
    const { slug, tenantPaths, project, versionDir } = fixture();
    const calls = stub(versionDir);
    const client = fakeClient((sql) => {
        if (sql.startsWith('CREATE TABLE a')) throw new Error('relation "a" already exists');
        return ledgerless(sql);
    });
    deployService.usePostgres({ connect: async () => client });
    const run = record(slug, tenantPaths, project);

    try {
        await assert.rejects(
            deployService.deployNow({ app: null, slug, tenantPaths, project, trigger: 'manual', run }),
            (e) => e.code === 'migration_failed' && /0001_init\.sql: relation "a" already exists/.test(e.message));
    } finally {
        calls.restore();
    }
    assert.strictEqual(calls.restarts.length, 0, 'a process was started on a schema that was refused');
    assert.strictEqual(client.ended, true);
    assert.strictEqual(run.stages.find((s) => s.key === 'migrate').status, 'failed');
});

test('a database that cannot be reached is a refused migration, not a crash', async () => {
    const { slug, tenantPaths, project, versionDir } = fixture();
    const calls = stub(versionDir);
    deployService.usePostgres({ connect: async () => { throw new Error('connect ECONNREFUSED 10.0.0.10:5432'); } });

    try {
        await assert.rejects(
            deployService.deployNow({ app: null, slug, tenantPaths, project, trigger: 'manual', run: record(slug, tenantPaths, project) }),
            (e) => e.code === 'migration_failed' && /ECONNREFUSED/.test(e.message));
    } finally {
        calls.restore();
    }
    assert.strictEqual(calls.restarts.length, 0);
});

test('an address no longer approved is not contacted, and the deployment is refused', async () => {
    const { slug, tenantPaths, project, versionDir } = fixture();
    const calls = stub(versionDir);
    let connects = 0;
    deployService.usePostgres({ connect: async () => { connects++; return fakeClient(ledgerless); } });
    fs.rmSync(projectStorage.targetsFile(), { force: true });

    try {
        await assert.rejects(
            deployService.deployNow({ app: null, slug, tenantPaths, project, trigger: 'manual', run: record(slug, tenantPaths, project) }),
            (e) => e.code === 'migration_failed' && /no longer approved/.test(e.message));
    } finally {
        calls.restore();
        approve();
    }
    assert.strictEqual(connects, 0, 'the service connected to an address that is off the list');
    assert.strictEqual(calls.restarts.length, 0);
});

test('a version that lost its Postgres files is refused: its code expects the file again', async () => {
    const { slug, tenantPaths, project, versionDir } = fixture();
    fs.rmSync(path.join(versionDir, 'migrations', 'postgres'), { recursive: true, force: true });
    const calls = stub(versionDir);
    let connects = 0;
    deployService.usePostgres({ connect: async () => { connects++; return fakeClient(ledgerless); } });
    const run = record(slug, tenantPaths, project);

    try {
        await assert.rejects(
            deployService.deployNow({ app: null, slug, tenantPaths, project, trigger: 'manual', run }),
            (e) => e.code === 'migration_failed' && /no file in migrations\/postgres/.test(e.message));
    } finally {
        calls.restore();
    }
    assert.strictEqual(calls.restarts.length, 0, 'a version with no Postgres support was started with the database address');
    assert.strictEqual(connects, 0);
    assert.strictEqual(run.stages.find((s) => s.key === 'migrate').status, 'failed');
});

test('a deployment from a record read before the switch still starts on the database', async () => {
    const { slug, tenantPaths, project, versionDir } = fixture();
    // What the disk holds: the project, switched. What the caller holds: the
    // same project as the poller read it earlier, with no storage at all.
    projectStore.saveProject(tenantPaths, project, { storage: true });
    const stale = Object.assign({}, project);
    delete stale.storage;

    const calls = stub(versionDir);
    const client = fakeClient(ledgerless);
    const sqlite = sqliteSpy();
    deployService.usePostgres({ connect: async () => client });
    deployService.useWritableDb(sqlite);

    try {
        await deployService.deployNow({ app: null, slug, tenantPaths, project: stale, trigger: 'push', run: record(slug, tenantPaths, stale) });
    } finally {
        calls.restore();
    }
    assert.strictEqual(calls.restarts[0].env.DATABASE_URL, 'postgresql://app_rw:pw@10.0.0.10:5432/app',
        'the new version was started on the old file');
    assert.strictEqual(sqlite.calls, 0);
    assert.strictEqual(projectStorage.mode(projectStore.getProject(tenantPaths, 'site')), 'postgres',
        'the deployment wrote the project back to local files');
});
