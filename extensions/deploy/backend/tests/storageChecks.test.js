/**
 * The checks of the guided setup.
 *
 * The property the others rest on is the order: nothing reaches the network
 * before the address is approved on the host. A check list that probed first
 * and asked afterwards would scan internal ports for whoever holds an admin
 * session. Then: one failure stops the list, and a check writes nothing.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const storageChecks = require('../storageChecks');
const { fakeClient } = require('./helpers/fakePg');

const TARGET = { kind: 'supabase', host: '10.0.0.10', port: 5432, database: 'postgres', user: 'postgres.acme', ssl: false };
const PROJECT = { id: 'site', runtime: 'node', lastSha: 'abc123' };

/** A deployed version, with or without Postgres migrations. */
function version(withMigrations) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-checks-'));
    if (withMigrations) {
        fs.mkdirSync(path.join(dir, 'migrations', 'postgres'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'migrations', 'postgres', '0001_init.sql'), 'CREATE TABLE a (id int);');
    }
    return dir;
}

/** Everything green, with a record of what was touched. */
function deps(over) {
    const touched = { tcp: 0, connect: [], client: null };
    const client = fakeClient((sql) => {
        if (sql === 'SHOW server_version_num') return [{ server_version_num: '150004' }];
        return undefined;
    });
    touched.client = client;
    return Object.assign({
        touched,
        runtimeEnabled: true,
        accounts: ['aegis-run-01'],
        postgres: { connect: async (opts) => { touched.connect.push(opts); return client; } },
        reauthenticate: async () => ({ email: 'admin@acme.test' }),
        reader: { describe: async () => [], rows: async () => ({ columns: [], rows: [] }) },
        isApproved: () => true,
        approveCommand: (h, p) => `Add-Content -Path 'X' -Value '${h}:${p}'`,
        versionDir: version(true),
        inspectPath: async () => ({ ok: true, blocked: true, managed: true, ip: '10.0.0.10' }),
        tcp: async () => { touched.tcp++; return { ok: true, why: '' }; }
    }, over);
}

function states(result) {
    return result.checks.map((c) => `${c.id}:${c.ok === null ? 'not_asked' : c.code}`);
}

test('every check green, in the order the page shows them', async () => {
    const d = deps();
    const res = await storageChecks.run({ project: PROJECT, target: TARGET, password: 'pw', deps: d });

    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.checks.map((c) => c.id), storageChecks.ORDER);
    assert.deepStrictEqual(states(res), ['runtime:ok', 'capability:ok', 'approved:ok', 'ssl:private', 'reachable:ok',
        'login:ok', 'version:ok', 'create:ok', 'code:ok', 'path:will_open']);
    assert.deepStrictEqual(d.touched.connect, [{ host: '10.0.0.10', port: 5432, database: 'postgres', user: 'postgres.acme', password: 'pw', ssl: false }]);
    assert.strictEqual(d.touched.client.ended, true, 'the connection is closed on the way out');
});

test('an address that is not approved is never contacted, and the fix is the command', async () => {
    const d = deps({ isApproved: () => false });
    const res = await storageChecks.run({ project: PROJECT, target: TARGET, password: 'pw', deps: d });

    assert.strictEqual(res.ok, false);
    assert.deepStrictEqual(states(res).slice(2, 5), ['approved:not_approved', 'ssl:not_asked', 'reachable:not_asked']);
    assert.strictEqual(res.checks[2].command, "Add-Content -Path 'X' -Value '10.0.0.10:5432'");
    assert.strictEqual(d.touched.tcp, 0, 'a TCP probe left before the approval');
    assert.strictEqual(d.touched.connect.length, 0);
});

test('the project has to be one a process serves, on a host that runs processes', async () => {
    const cases = [
        [{ runtime: 'static' }, {}, 'static_project'],
        [{ parentId: 'site' }, {}, 'preview'],
        [{}, { runtimeEnabled: false }, 'runtime_off'],
        [{ lastSha: null }, {}, 'never_deployed'],
        [{}, { versionDir: null }, 'never_deployed']
    ];
    for (const [projectOver, depsOver, code] of cases) {
        const d = deps(depsOver);
        const res = await storageChecks.run({ project: Object.assign({}, PROJECT, projectOver), target: TARGET, password: 'pw', deps: d });
        assert.deepStrictEqual([res.ok, res.checks[0].code], [false, code]);
        assert.ok(res.checks.slice(1).every((c) => c.ok === null), 'nothing is asked below a failure');
        assert.strictEqual(d.touched.tcp, 0);
    }
});

test('an Aegis that hands over no client, no password check or no row reader fails one check', async () => {
    for (const over of [{ postgres: undefined }, { reauthenticate: undefined }, { reader: { describe: async () => [] } }]) {
        const res = await storageChecks.run({ project: PROJECT, target: TARGET, password: 'pw', deps: deps(over) });
        assert.deepStrictEqual(states(res).slice(0, 3), ['runtime:ok', 'capability:core_too_old', 'approved:not_asked']);
    }
});

test('a public address without SSL stops before any connection', async () => {
    const d = deps();
    const publicTarget = Object.assign({}, TARGET, { host: 'db.example.com' });
    const res = await storageChecks.run({ project: PROJECT, target: publicTarget, password: 'pw', deps: d });
    assert.strictEqual(res.checks[3].code, 'public_no_ssl');
    assert.strictEqual(d.touched.tcp, 0);

    const withSsl = await storageChecks.run({ project: PROJECT, target: Object.assign({}, publicTarget, { ssl: true }), password: 'pw', deps: deps() });
    assert.strictEqual(withSsl.checks[3].code, 'ssl_on');
    assert.strictEqual(withSsl.ok, true);

    for (const host of ['db', 'db.corp.local', '10.1.2.3', '172.20.0.5', '192.168.4.4', 'localhost']) {
        assert.strictEqual(storageChecks.isPrivateHost(host), true, host);
    }
    for (const host of ['db.example.com', '172.32.0.1', '203.0.113.9', '']) {
        assert.strictEqual(storageChecks.isPrivateHost(host), false, host);
    }
});

test('each failure names itself and what the server said', async () => {
    const noAnswer = await storageChecks.run({
        project: PROJECT, target: TARGET, password: 'pw',
        deps: deps({ tcp: async () => ({ ok: false, why: 'connect ETIMEDOUT' }) })
    });
    assert.deepStrictEqual([noAnswer.checks[4].code, noAnswer.checks[4].detail], ['no_answer', 'connect ETIMEDOUT']);

    const noPassword = await storageChecks.run({ project: PROJECT, target: TARGET, password: '', deps: deps() });
    assert.strictEqual(noPassword.checks[5].code, 'no_password');

    const refused = await storageChecks.run({
        project: PROJECT, target: TARGET, password: 'wrong',
        deps: deps({ postgres: { connect: async () => { throw new Error('password authentication failed for user "postgres.acme"'); } } })
    });
    assert.deepStrictEqual([refused.checks[5].code, refused.checks[5].detail],
        ['refused', 'password authentication failed for user "postgres.acme"']);

    const old = fakeClient((sql) => (sql === 'SHOW server_version_num' ? [{ server_version_num: '110022' }] : undefined));
    const tooOld = await storageChecks.run({ project: PROJECT, target: TARGET, password: 'pw', deps: deps({ postgres: { connect: async () => old } }) });
    assert.deepStrictEqual([tooOld.checks[6].code, tooOld.checks[6].detail, tooOld.checks[7].ok], ['too_old', '11', null]);
    assert.strictEqual(old.ended, true);

    const readOnly = fakeClient((sql) => {
        if (sql === 'SHOW server_version_num') return [{ server_version_num: '150004' }];
        if (sql.startsWith('CREATE TABLE')) throw new Error('permission denied for schema public');
        return undefined;
    });
    const noCreate = await storageChecks.run({ project: PROJECT, target: TARGET, password: 'pw', deps: deps({ postgres: { connect: async () => readOnly } }) });
    assert.deepStrictEqual([noCreate.checks[7].code, noCreate.checks[7].detail], ['no_create', 'permission denied for schema public']);
    assert.strictEqual(readOnly.sql().pop(), 'ROLLBACK', 'a refused probe still leaves no open transaction');
});

test('the probe table is created inside a transaction that is rolled back', async () => {
    const d = deps();
    await storageChecks.run({ project: PROJECT, target: TARGET, password: 'pw', deps: d });
    const sql = d.touched.client.sql();
    const at = sql.findIndex((s) => s.startsWith('CREATE TABLE aegis_probe_'));
    assert.deepStrictEqual([sql[at - 1], sql[at + 1]], ['BEGIN', 'ROLLBACK']);
    assert.ok(!sql.includes('COMMIT'), 'a check committed something');
});

test('a version with no Postgres migrations is refused: its code expects a file', async () => {
    const res = await storageChecks.run({ project: PROJECT, target: TARGET, password: 'pw', deps: deps({ versionDir: version(false) }) });
    assert.strictEqual(res.ok, false);
    assert.deepStrictEqual([res.checks[8].code, res.checks[8].detail], ['no_migrations', 'migrations/postgres']);
    assert.strictEqual(res.checks[9].ok, null);
});

test('the network path: not blocked, opened at the switch, or blocked with nobody to open it', async () => {
    const run = (inspect) => storageChecks.run({ project: PROJECT, target: TARGET, password: 'pw', deps: deps({ inspectPath: async () => inspect }) });

    assert.strictEqual((await run({ ok: true, blocked: false, managed: false })).checks[9].code, 'not_blocked');
    const open = await run({ ok: true, blocked: true, managed: true, ip: '10.0.0.10' });
    assert.deepStrictEqual([open.ok, open.checks[9].code, open.checks[9].detail], [true, 'will_open', '10.0.0.10:5432']);
    const stuck = await run({ ok: true, blocked: true, managed: false, ip: '10.0.0.10' });
    assert.deepStrictEqual([stuck.ok, stuck.checks[9].code], [false, 'blocked_unmanaged']);
    const unknown = await run({ ok: false, error: 'Access is denied' });
    assert.deepStrictEqual([unknown.checks[9].code, unknown.checks[9].detail], ['unknown', 'Access is denied']);
});
