/**
 * The Postgres migration runner.
 *
 * Three properties carry the weight. A file and its ledger row commit together.
 * A failure names its file and rolls that file back, leaving the ones before it
 * applied. And a rehearsal opens no transaction of its own, because the caller
 * holds the one that will be rolled back.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pgMigrations = require('../pgMigrations');
const migrations = require('../migrations');
const { fakeClient } = require('./helpers/fakePg');

function repo(files) {
    const version = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-pgmig-'));
    const dir = path.join(version, 'migrations', 'postgres');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
    return { version, dir };
}

/** A ledger that holds `names`, or does not exist when `names` is null. */
function ledger(names) {
    return (sql) => {
        if (sql.startsWith('SELECT to_regclass')) return [{ t: names ? '_aegis_migrations' : null }];
        if (sql.startsWith('SELECT name FROM _aegis_migrations')) return (names || []).map((name) => ({ name }));
        return undefined;
    };
}

test('the Postgres files sit one folder under the SQLite ones, which never see them', () => {
    const { version, dir } = repo({ '0001_init.sql': 'CREATE TABLE a (id int);' });
    fs.writeFileSync(path.join(version, 'migrations', '0001_init.sql'), 'CREATE TABLE a (id INTEGER);');

    assert.strictEqual(pgMigrations.dirFor(version, {}), dir);
    assert.strictEqual(pgMigrations.dirFor(version, { migrationsDir: 'db/changes' }),
        path.join(version, 'db/changes', 'postgres'));
    assert.deepStrictEqual(pgMigrations.list(dir), ['0001_init.sql']);
    assert.deepStrictEqual(migrations.list(path.join(version, 'migrations')), ['0001_init.sql'],
        'the SQLite runner must list its own file and not descend');
    assert.deepStrictEqual(pgMigrations.list(path.join(version, 'nowhere')), []);
});

test('each file commits with its ledger row, in name order', async () => {
    const { dir } = repo({
        '0002_more.sql': 'ALTER TABLE a ADD COLUMN b text;',
        '0001_init.sql': 'CREATE TABLE a (id int);'
    });
    const client = fakeClient(ledger(null));

    const res = await pgMigrations.run({ client, dir, sha: 'abc123' });
    assert.deepStrictEqual(res, { applied: ['0001_init.sql', '0002_more.sql'], alreadyApplied: [] });

    const sql = client.sql();
    assert.deepStrictEqual(sql.slice(1, 6).map((s) => s.split(' ')[0] + (s.startsWith('CREATE TABLE a') ? ' a' : '')),
        ['BEGIN', 'CREATE a', 'CREATE', 'INSERT', 'COMMIT']);
    assert.strictEqual(sql.filter((s) => s === 'BEGIN').length, 2);
    assert.strictEqual(sql.filter((s) => s === 'COMMIT').length, 2);

    const inserts = client.log.filter((e) => e.sql.startsWith('INSERT INTO _aegis_migrations'));
    assert.deepStrictEqual(inserts.map((e) => [e.params[0], e.params[2]]),
        [['0001_init.sql', 'abc123'], ['0002_more.sql', 'abc123']]);
});

test('what the ledger already holds is not played again', async () => {
    const { dir } = repo({ '0001_init.sql': 'CREATE TABLE a (id int);', '0002_more.sql': 'SELECT 1;' });
    const client = fakeClient(ledger(['0001_init.sql']));

    const res = await pgMigrations.run({ client, dir });
    assert.deepStrictEqual(res, { applied: ['0002_more.sql'], alreadyApplied: ['0001_init.sql'] });
    assert.ok(!client.sql().includes('CREATE TABLE a (id int);'));
});

test('a failing file is rolled back and named, and the one before it stays applied', async () => {
    const { dir } = repo({ '0001_ok.sql': 'CREATE TABLE a (id int);', '0002_bad.sql': 'CREATE TABEL b;', '0003_never.sql': 'SELECT 1;' });
    const base = ledger(null);
    const client = fakeClient((sql, params) => {
        if (sql === 'CREATE TABEL b;') throw new Error('syntax error at or near "TABEL"');
        return base(sql, params);
    });

    await assert.rejects(pgMigrations.run({ client, dir }),
        (e) => e.code === 'migration_failed' && e.message.startsWith('0002_bad.sql: syntax error'));

    const sql = client.sql();
    assert.strictEqual(sql.filter((s) => s === 'COMMIT').length, 1, 'the first file committed');
    assert.strictEqual(sql[sql.length - 1], 'ROLLBACK');
    assert.ok(!sql.includes('SELECT 1;'), 'nothing runs after a failure');
});

test('a rehearsal opens no transaction of its own', async () => {
    const { dir } = repo({ '0001_init.sql': 'CREATE TABLE a (id int);' });
    const client = fakeClient(ledger(null));

    await pgMigrations.run({ client, dir, inTransaction: true });
    assert.ok(!client.sql().some((s) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(s)),
        'the caller holds the transaction it will roll back');

    const failing = fakeClient((sql) => {
        if (sql.startsWith('CREATE TABLE a')) throw new Error('boom');
        return ledger(null)(sql);
    });
    await assert.rejects(pgMigrations.run({ client: failing, dir, inTransaction: true }), (e) => e.code === 'migration_failed');
    assert.ok(!failing.sql().includes('ROLLBACK'));
});

test('an empty file is refused by name', async () => {
    const { dir } = repo({ '0001_empty.sql': '  \n' });
    await assert.rejects(pgMigrations.run({ client: fakeClient(ledger(null)), dir }),
        (e) => e.code === 'migration_failed' && /0001_empty\.sql: empty file/.test(e.message));
});
