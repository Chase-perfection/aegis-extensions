/**
 * The copy from a project's SQLite file to its Postgres database.
 *
 * What must never happen quietly: a table or a column of the file left behind,
 * rows written into a table that already held somebody's rows, a count that
 * does not match, and a sequence left at 1 under copied ids. Each has a test
 * that fails when the refusal is removed.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const storageCopy = require('../storageCopy');
const { fakeDatabase, fakeReader } = require('./helpers/fakePg');

function migrationsDir(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-copy-'));
    for (const [name, sql] of Object.entries(files || {})) fs.writeFileSync(path.join(dir, name), sql);
    return dir;
}

const FILE = 'C:/data/app.db';

/** A file with a parent table, a child table and the SQLite ledger. */
function source() {
    return fakeReader({
        Lines: { columns: ['id', 'site_id', 'label'], rows: [[10, 1, 'north'], [11, 2, 'south'], [12, 1, null]] },
        sites: { columns: ['id', 'name'], rows: [[1, 'Plant A'], [2, 'Plant B']] },
        _aegis_migrations: { columns: ['name', 'applied_at', 'sha'], rows: [['0001_init.sql', 1, null]] },
        recent: { view: true, columns: ['id'], rows: [] }
    });
}

function target(over) {
    const db = over || {};
    if (!db.tables) {
        db.tables = {
            sites: { columns: [{ name: 'id', generated: 'serial' }, { name: 'name' }], rows: [] },
            lines: { columns: [{ name: 'id', generated: 'identity' }, { name: 'site_id' }, { name: 'label' }], rows: [] }
        };
    }
    if (!db.fks) db.fks = [{ child: 'lines', parent: 'sites' }];
    return fakeDatabase(db);
}

test('order puts parents first, ignores a self reference and refuses a circle', () => {
    assert.deepStrictEqual(
        storageCopy.order(['lines', 'sites', 'notes'], [{ child: 'lines', parent: 'sites' }, { child: 'notes', parent: 'lines' }]),
        ['sites', 'lines', 'notes']);
    assert.deepStrictEqual(storageCopy.order(['tree'], [{ child: 'tree', parent: 'tree' }]), ['tree']);
    assert.deepStrictEqual(storageCopy.order(['a', 'b'], [{ child: 'a', parent: 'elsewhere' }]), ['a', 'b'],
        'a parent outside the copy is not waited for');
    assert.throws(() => storageCopy.order(['a', 'b', 'c'], [{ child: 'a', parent: 'b' }, { child: 'b', parent: 'a' }]),
        (e) => e.code === 'fk_cycle' && /a, b/.test(e.message));
});

test('the plan maps names across the two engines and leaves out what is not the application\'s', async () => {
    const p = await storageCopy.plan({ client: target(), reader: source(), file: FILE });

    assert.strictEqual(p.ok, true);
    assert.deepStrictEqual(p.tables.map((t) => [t.name, t.target, t.state, t.rows]),
        [['Lines', 'lines', 'ok', 3], ['sites', 'sites', 'ok', 2]],
        'the view and the ledger are not tables to carry');
    assert.deepStrictEqual(p.generated, [{ name: 'sites', columns: ['id'] }, { name: 'lines', columns: ['id'] }]);
    assert.deepStrictEqual(p.withoutRls, ['lines', 'sites']);
});

test('the plan refuses, by name, a table, a column and rows that were already there', async () => {
    const noTable = await storageCopy.plan({
        client: target({ tables: { sites: { columns: [{ name: 'id' }, { name: 'name' }], rows: [] } }, fks: [] }),
        reader: source(), file: FILE
    });
    assert.strictEqual(noTable.ok, false);
    assert.deepStrictEqual(noTable.tables.map((t) => [t.name, t.state]), [['Lines', 'missing_table'], ['sites', 'ok']]);

    const noColumn = await storageCopy.plan({
        client: target({
            tables: {
                sites: { columns: [{ name: 'id' }, { name: 'name' }], rows: [] },
                lines: { columns: [{ name: 'id' }, { name: 'site_id' }], rows: [] }
            }
        }),
        reader: source(), file: FILE
    });
    assert.strictEqual(noColumn.ok, false);
    assert.deepStrictEqual(noColumn.tables[0].missingColumns, ['label']);
    assert.strictEqual(noColumn.tables[0].state, 'missing_columns');

    const db = target();
    db_fill(db);
    const occupied = await storageCopy.plan({ client: db, reader: source(), file: FILE });
    assert.strictEqual(occupied.ok, false);
    assert.strictEqual(occupied.tables.find((t) => t.name === 'sites').state, 'not_empty');

    function db_fill(client) {
        // Reach the fake's tables through one insert, as a stranger's row.
        return client.query('INSERT INTO "sites" ("id", "name") VALUES ($1, $2)', [99, 'somebody else']);
    }
});

test('a table with no row needs no table, and a project with no file has nothing to carry', async () => {
    const reader = fakeReader({ drafts: { columns: ['id'], rows: [] }, sites: { columns: ['id', 'name'], rows: [[1, 'A']] } });
    const p = await storageCopy.plan({ client: target(), reader, file: FILE });
    assert.strictEqual(p.ok, true);
    assert.deepStrictEqual(p.tables.map((t) => [t.name, t.state]), [['drafts', 'empty'], ['sites', 'ok']]);

    const none = await storageCopy.plan({ client: target(), reader: fakeReader(null), file: FILE });
    assert.deepStrictEqual([none.ok, none.tables], [true, []]);
});

test('the copy moves every row, parents first, and counts them', async () => {
    const db = {};
    const client = target(db);
    const reader = source();
    const p = await storageCopy.plan({ client, reader, file: FILE });

    const done = await storageCopy.copy({ client, reader, file: FILE, plan: p });
    assert.deepStrictEqual(done, [{ name: 'sites', target: 'sites', source: 2, copied: 2 }, { name: 'Lines', target: 'lines', source: 3, copied: 3 }]);

    const inserts = client.sql().filter((s) => s.startsWith('INSERT INTO'));
    assert.match(inserts[0], /^INSERT INTO "sites" \("id", "name"\) VALUES \(\$1, \$2\), \(\$3, \$4\)$/);
    assert.match(inserts[1], /^INSERT INTO "lines" \("id", "site_id", "label"\) VALUES /);
    assert.deepStrictEqual(db.tables.lines.rows[2], { id: 12, site_id: 1, label: null }, 'a NULL stays a NULL');

    // Both generated columns are moved past what was copied.
    assert.deepStrictEqual(db.setvals.map((s) => s.seq), ['public.sites_id_seq', 'public.lines_id_seq']);
    assert.match(db.setvals[0].sql, /COALESCE\(MAX\("id"\), 0\) FROM "sites"\) \+ 1, false\)/);
});

test('a large table goes in batches and a wide one in smaller batches', async () => {
    const rows = [];
    for (let i = 0; i < 1203; i++) rows.push([i, `row ${i}`]);
    const reader = fakeReader({ sites: { columns: ['id', 'name'], rows } });
    const db = {};
    const client = target(db);

    const p = await storageCopy.plan({ client, reader, file: FILE });
    const done = await storageCopy.copy({ client, reader, file: FILE, plan: p });
    assert.deepStrictEqual(done, [{ name: 'sites', target: 'sites', source: 1203, copied: 1203 }]);
    assert.deepStrictEqual(reader.calls.map((c) => c.offset), [0, 500, 1000]);
    assert.strictEqual(db.tables.sites.rows[1202].name, 'row 1202');

    const wide = [];
    for (let i = 0; i < 200; i++) wide.push(`c${i}`);
    const wideReader = fakeReader({ w: { columns: wide, rows: [wide.map(() => 1)] } });
    const wideClient = fakeDatabase({ tables: { w: { columns: wide.map((name) => ({ name })), rows: [] } } });
    const wp = await storageCopy.plan({ client: wideClient, reader: wideReader, file: FILE });
    await storageCopy.copy({ client: wideClient, reader: wideReader, file: FILE, plan: wp });
    assert.strictEqual(wideReader.calls[0].limit, 300, '60000 bound values over 200 columns');
});

test('a row the server refuses stops the copy and names the table', async () => {
    const client = target({
        onInsert(name) {
            if (name === 'lines') throw new Error('invalid input syntax for type integer: "north"');
        }
    });
    const reader = source();
    const p = await storageCopy.plan({ client, reader, file: FILE });
    await assert.rejects(storageCopy.copy({ client, reader, file: FILE, plan: p }),
        (e) => e.code === 'copy_failed' && e.table === 'Lines' && /^Lines: invalid input syntax/.test(e.message));
});

test('a count that does not match is a refusal, not a warning', async () => {
    const db = {
        onInsert(name, rows) { if (name === 'sites') rows.pop(); }        // the server kept one row fewer
    };
    const client = target(db);
    const reader = source();
    const p = await storageCopy.plan({ client, reader, file: FILE });
    await assert.rejects(storageCopy.copy({ client, reader, file: FILE, plan: p }),
        (e) => e.code === 'count_mismatch' && /sites: the file held 2 row\(s\), 2 were read and the database holds 1/.test(e.message));
});

test('carry plays the migrations, then replaces the reference rows they inserted with the file\'s', async () => {
    const dir = migrationsDir({ '0001_init.sql': 'CREATE sites and lines, seed two sites' });
    const db = {
        tables: {},
        migrate(sql, d) {
            d.tables.sites = { columns: [{ name: 'id', generated: 'serial' }, { name: 'name' }], rows: [{ id: 1, name: 'seed' }, { id: 7, name: 'seed' }] };
            d.tables.lines = { columns: [{ name: 'id' }, { name: 'site_id' }, { name: 'label' }], rows: [] };
            d.fks = [{ child: 'lines', parent: 'sites' }];
        }
    };
    const client = fakeDatabase(db);

    const res = await storageCopy.carry({ client, reader: source(), file: FILE, dir, sha: 'abc' });

    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.migrations, ['0001_init.sql']);
    assert.deepStrictEqual(res.tables.map((t) => [t.name, t.state, t.rows, t.copied]),
        [['Lines', 'ok', 3, 3], ['sites', 'ok', 2, 2]]);
    assert.deepStrictEqual(db.tables.sites.rows.map((r) => r.name), ['Plant A', 'Plant B'], 'the file wins over the seed');
    assert.deepStrictEqual(res.copiedTargets, ['sites', 'lines']);

    // And the way out when the project then cannot start on it.
    await storageCopy.empty({ client, targets: res.copiedTargets });
    assert.deepStrictEqual([db.tables.sites.rows.length, db.tables.lines.rows.length], [0, 0]);
    assert.deepStrictEqual(client.sql().slice(-2), ['DELETE FROM "lines"', 'DELETE FROM "sites"'], 'children first');
    assert.ok(!client.sql().some((s) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(s)), 'the caller decides how the transaction ends');
});

test('carry refuses rows that were there before the migrations, and copies nothing', async () => {
    const dir = migrationsDir({});
    const db = {
        tables: {
            sites: { columns: [{ name: 'id' }, { name: 'name' }], rows: [{ id: 99, name: 'somebody else' }] },
            lines: { columns: [{ name: 'id' }, { name: 'site_id' }, { name: 'label' }], rows: [] }
        }
    };
    const client = fakeDatabase(db);

    const res = await storageCopy.carry({ client, reader: source(), file: FILE, dir });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.tables.find((t) => t.name === 'sites').state, 'not_empty');
    assert.ok(!client.sql().some((s) => s.startsWith('INSERT INTO "') || s.startsWith('DELETE')), 'a refused plan moves nothing');
    assert.deepStrictEqual(db.tables.sites.rows, [{ id: 99, name: 'somebody else' }]);
});

test('a table the reader could not count is a refusal, never an empty table', async () => {
    const reader = fakeReader({ sites: { columns: ['id', 'name'], rows: [[1, 'A']] } });
    const describe = reader.describe.bind(reader);
    reader.describe = async (file) => (await describe(file)).map((o) => Object.assign(o, { rows: null }));

    const p = await storageCopy.plan({ client: target(), reader, file: FILE });
    assert.deepStrictEqual([p.ok, p.tables[0].state], [false, 'unreadable'],
        'unknown read as zero would skip the table and leave its rows behind');
});
