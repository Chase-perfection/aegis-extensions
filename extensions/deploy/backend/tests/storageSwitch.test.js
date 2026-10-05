/**
 * The switch to Postgres and the way back.
 *
 * One test per step that can fail, and each asks the same two questions: is
 * the site serving at the end, and from where. A switch that fails is normal.
 * A switch that fails and leaves the site down, or leaves it running on a
 * database that holds half its rows, is the thing these tests exist to stop.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.AEGIS_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-switch-root-'));

const storageSwitch = require('../storageSwitch');
const projectStorage = require('../projectStorage');
const { fakeDatabase, fakeReader } = require('./helpers/fakePg');

console.error = () => { };

function savedProject(mode) {
    const target = projectStorage.normalise({ kind: 'postgres', host: '10.0.0.10', port: 5432, database: 'app', user: 'app_rw' });
    const project = { id: 'site', runtime: 'node', lastSha: 'abc123' };
    project.storage = projectStorage.withTarget(project, target, 'pw');
    if (mode === 'postgres') project.storage = projectStorage.withMode(project, 'postgres', 'someone@acme.test');
    return project;
}

/**
 * A world: one project record, one database, one file, and a log of what
 * happened to the process. `over` replaces any dependency.
 */
function world(over) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-switch-mig-'));
    fs.writeFileSync(path.join(dir, '0001_init.sql'), 'CREATE TABLE sites');

    const w = {
        record: savedProject((over && over.mode) || 'local'),
        events: [],
        db: {
            tables: {},
            migrate(sql, d) { d.tables.sites = { columns: [{ name: 'id', generated: 'serial' }, { name: 'name' }], rows: [] }; }
        },
        clients: []
    };
    w.deps = Object.assign({
        runChecks: async () => ({ ok: true, checks: [] }),
        connect: async (opts) => {
            w.events.push(`connect ${opts.user}@${opts.host}:${opts.port}/${opts.database}`);
            // One database behind every connection. A rolled back transaction
            // is played by snapshotting the tables at BEGIN.
            const client = fakeDatabase(w.db);
            const query = client.query;
            let snapshot = null;
            client.query = async (sql, params) => {
                if (sql === 'BEGIN') snapshot = JSON.stringify({ tables: w.db.tables, ledger: w.db.ledger });
                if (sql === 'ROLLBACK' && snapshot) {
                    const s = JSON.parse(snapshot);
                    w.db.tables = s.tables;
                    w.db.ledger = s.ledger;
                }
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') w.events.push(sql);
                return query(sql, params);
            };
            w.clients.push(client);
            return client;
        },
        reader: fakeReader({ sites: { columns: ['id', 'name'], rows: [[1, 'Plant A'], [2, 'Plant B']] } }),
        file: 'C:/data/app.db',
        migrationsDir: dir,
        sha: 'abc123',
        stop: () => { w.events.push('stop'); },
        start: async (project) => { w.events.push(`start ${projectStorage.mode(project)}`); return { port: 3400 }; },
        getProject: () => w.record,
        save: (project) => { w.record = project; w.events.push(`save ${projectStorage.mode(project)}`); }
    }, (over && over.deps) || {});
    return w;
}

function failedSteps(res) {
    return res.steps.filter((s) => !s.ok).map((s) => s.id);
}

test('a switch that works: rehearsed with the site up, copied with it down, started on the database', async () => {
    const w = world();
    const res = await storageSwitch.toPostgres({ project: w.record, actor: 'admin@acme.test', deps: w.deps });

    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.steps.map((s) => [s.id, s.ok]),
        [['checks', true], ['rehearsal', true], ['stop', true], ['copy', true], ['start', true]]);
    assert.deepStrictEqual(w.events, [
        'connect app_rw@10.0.0.10:5432/app', 'BEGIN', 'ROLLBACK',        // the rehearsal leaves nothing
        'stop',
        'connect app_rw@10.0.0.10:5432/app', 'BEGIN', 'COMMIT',
        'save postgres', 'start postgres'
    ]);
    assert.deepStrictEqual(res.tables.map((t) => [t.name, t.rows, t.copied]), [['sites', 2, 2]]);
    assert.deepStrictEqual(res.migrations, ['0001_init.sql']);
    assert.deepStrictEqual(w.db.tables.sites.rows.map((r) => r.name), ['Plant A', 'Plant B']);
    assert.strictEqual(projectStorage.mode(w.record), 'postgres');
    assert.strictEqual(w.record.storage.switchedBy, 'admin@acme.test');
    assert.ok(w.clients.every((c) => c.ended), 'a connection was left open');
});

test('checks that fail on the server stop everything, whatever the page showed', async () => {
    const w = world({ deps: { runChecks: async () => ({ ok: false, checks: [{ id: 'approved', ok: false, code: 'not_approved' }] }) } });
    const res = await storageSwitch.toPostgres({ project: w.record, actor: 'a', deps: w.deps });

    assert.deepStrictEqual([res.ok, res.failed], [false, 'checks']);
    assert.deepStrictEqual(res.checks, [{ id: 'approved', ok: false, code: 'not_approved' }]);
    assert.deepStrictEqual(w.events, [], 'nothing connects, nothing stops');
    assert.strictEqual(projectStorage.mode(w.record), 'local');
});

test('a project with no saved target or no password is refused before any check', async () => {
    const w = world();
    const res = await storageSwitch.toPostgres({ project: { id: 'site', runtime: 'node' }, actor: 'a', deps: w.deps });
    assert.deepStrictEqual([res.ok, res.failed, res.steps[0].detail], [false, 'checks', 'no_target']);
    assert.deepStrictEqual(w.events, []);
});

test('a rehearsal that is refused never stops the site', async () => {
    const w = world();
    w.db.migrate = (sql, d) => { d.tables.other = { columns: [{ name: 'id' }], rows: [] }; };       // no `sites` table
    const res = await storageSwitch.toPostgres({ project: w.record, actor: 'a', deps: w.deps });

    assert.deepStrictEqual([res.ok, res.failed], [false, 'rehearsal']);
    assert.strictEqual(res.steps[1].detail, 'sites: missing_table');
    assert.ok(!w.events.includes('stop'), 'the site was stopped for a copy that could not work');
    assert.deepStrictEqual(w.db.tables, {}, 'the rehearsal left a table behind');
    assert.strictEqual(projectStorage.mode(w.record), 'local');
});

test('a rehearsal that throws is reported and never stops the site', async () => {
    const w = world({ deps: { connect: async () => { throw new Error('connect ECONNREFUSED'); } } });
    const res = await storageSwitch.toPostgres({ project: w.record, actor: 'a', deps: w.deps });
    assert.deepStrictEqual([res.ok, res.failed, res.steps[1].detail], [false, 'rehearsal', 'connect ECONNREFUSED']);
    assert.ok(!w.events.includes('stop'));
});

test('a copy that fails after the stop commits nothing and restarts the site on its file', async () => {
    const w = world();
    let passages = 0;
    w.db.onInsert = () => {
        // The rehearsal passes; the real copy meets a row the server refuses.
        if (passages++ >= 1) throw new Error('duplicate key value violates unique constraint');
    };
    const res = await storageSwitch.toPostgres({ project: w.record, actor: 'a', deps: w.deps });

    assert.deepStrictEqual([res.ok, res.failed], [false, 'copy']);
    assert.deepStrictEqual(failedSteps(res), ['copy']);
    assert.deepStrictEqual(w.events.slice(-4), ['stop', 'connect app_rw@10.0.0.10:5432/app', 'BEGIN', 'ROLLBACK', 'start local'].slice(1));
    assert.strictEqual(w.events.filter((e) => e === 'stop').length, 1);
    assert.ok(!w.events.includes('COMMIT'));
    assert.ok(!w.events.includes('save postgres'), 'the record moved for a copy that did not happen');
    assert.deepStrictEqual(w.db.tables, {}, 'a failed copy left rows or tables');
    assert.strictEqual(res.steps[res.steps.length - 1].id, 'restore');
});

test('a project that will not start on the database is emptied out, put back on its file and restarted', async () => {
    const w = world();
    w.deps.start = async (project) => {
        const m = projectStorage.mode(project);
        w.events.push(`start ${m}`);
        if (m === 'postgres') throw new Error('the start command stopped before answering on port 3400 (exit 1)');
        return { port: 3400 };
    };
    const res = await storageSwitch.toPostgres({ project: w.record, actor: 'a', deps: w.deps });

    assert.deepStrictEqual([res.ok, res.failed], [false, 'start']);
    assert.deepStrictEqual(res.steps.map((s) => [s.id, s.ok]),
        [['checks', true], ['rehearsal', true], ['stop', true], ['copy', true], ['start', false], ['undo', true], ['restore', true]]);
    assert.deepStrictEqual(w.events.slice(-5), ['save postgres', 'start postgres', 'save local', 'connect app_rw@10.0.0.10:5432/app', 'start local']);
    assert.strictEqual(projectStorage.mode(w.record), 'local');
    assert.deepStrictEqual(w.db.tables.sites.rows, [], 'rows left behind would refuse the next attempt as not_empty');

    // And the next attempt is not refused by what this one left.
    w.deps.start = async (project) => { w.events.push(`start ${projectStorage.mode(project)}`); return { port: 3400 }; };
    const again = await storageSwitch.toPostgres({ project: w.record, actor: 'a', deps: w.deps });
    assert.strictEqual(again.ok, true);
    assert.deepStrictEqual(again.migrations, [], 'the migrations of the first attempt stay applied');
});

test('when even the file will not start, the result says the site is down', async () => {
    const w = world();
    w.deps.start = async () => { throw new Error('no_runtime_account'); };
    const res = await storageSwitch.toPostgres({ project: w.record, actor: 'a', deps: w.deps });

    assert.strictEqual(res.ok, false);
    assert.deepStrictEqual(failedSteps(res), ['start', 'restore']);
    assert.strictEqual(projectStorage.mode(w.record), 'local', 'the next start must be on the file');
});

test('going back restarts on the file and keeps the connection for a later switch', async () => {
    const w = world({ mode: 'postgres' });
    const res = await storageSwitch.toLocal({ project: w.record, actor: 'admin@acme.test', deps: w.deps });

    assert.deepStrictEqual(res, { ok: true, steps: [{ id: 'start', ok: true, detail: '' }] });
    assert.deepStrictEqual(w.events, ['save local', 'start local']);
    assert.strictEqual(projectStorage.mode(w.record), 'local');
    assert.strictEqual(projectStorage.targetOf(w.record).host, '10.0.0.10');
    assert.strictEqual(projectStorage.passwordOf(w.record), 'pw');
    assert.ok(!w.events.some((e) => e.startsWith('connect')), 'going back copies nothing');
});

test('a way back that will not start leaves the site on the database it was serving from', async () => {
    const w = world({ mode: 'postgres' });
    w.deps.start = async (project) => {
        const m = projectStorage.mode(project);
        w.events.push(`start ${m}`);
        if (m === 'local') throw new Error('unhealthy');
        return { port: 3400 };
    };
    const res = await storageSwitch.toLocal({ project: w.record, actor: 'a', deps: w.deps });

    assert.deepStrictEqual([res.ok, res.failed], [false, 'start']);
    assert.deepStrictEqual(w.events, ['save local', 'start local', 'save postgres', 'start postgres']);
    assert.strictEqual(projectStorage.mode(w.record), 'postgres');
});

test('going back from local is refused', async () => {
    const w = world();
    const res = await storageSwitch.toLocal({ project: w.record, actor: 'a', deps: w.deps });
    assert.deepStrictEqual([res.ok, res.steps[0].detail], [false, 'already_local']);
    assert.deepStrictEqual(w.events, []);
});

test('a project already on its database is never copied over again', async () => {
    const w = world({ mode: 'postgres' });
    const res = await storageSwitch.toPostgres({ project: w.record, actor: 'a', deps: w.deps, replace: true });

    assert.deepStrictEqual([res.ok, res.failed, res.steps[0].detail], [false, 'checks', 'already_on_postgres']);
    assert.deepStrictEqual(w.events, [], 'the site was stopped, or the database touched, for a switch that is already done');
});

test('a record that cannot be written after the copy is undone like a start that failed', async () => {
    const w = world();
    let saves = 0;
    w.deps.save = (project) => {
        saves++;
        if (saves === 1) throw new Error('EBUSY: projects.json is locked');
        w.record = project;
        w.events.push(`save ${projectStorage.mode(project)}`);
    };
    const res = await storageSwitch.toPostgres({ project: w.record, actor: 'a', deps: w.deps });

    assert.deepStrictEqual([res.ok, res.failed], [false, 'start']);
    assert.deepStrictEqual(res.steps.map((s) => [s.id, s.ok]).slice(-3), [['start', false], ['undo', true], ['restore', true]]);
    assert.strictEqual(w.events[w.events.length - 1], 'start local', 'the site was left stopped');
    assert.deepStrictEqual(w.db.tables.sites.rows, []);
    assert.strictEqual(projectStorage.mode(w.record), 'local');
});
