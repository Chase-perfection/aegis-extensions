/**
 * A Postgres client that remembers what it was asked.
 *
 * Small on purpose. It understands transactions (a ROLLBACK undoes what the
 * transaction did to the tables this fake holds) and nothing else about SQL.
 * A test hands it `answer(sql, params)`, which returns rows, throws, or returns
 * undefined to say "no rows".
 *
 * What the suites prove with it is the conversation: which statements, in
 * which order, inside which transaction. That the statements are valid
 * Postgres is proved against a real server, which these tests do not have.
 */

'use strict';

function fakeClient(answer) {
    const log = [];
    const client = {
        log,
        ended: false,
        /** The statements only, for assertions on order. */
        sql() { return log.map((e) => e.sql); },
        async query(sql, params) {
            log.push({ sql, params: params || [] });
            const out = answer ? await answer(sql, params || [], client) : undefined;
            if (Array.isArray(out)) return { rows: out, rowCount: out.length };
            return out || { rows: [], rowCount: 0 };
        },
        async end() { client.ended = true; }
    };
    return client;
}

/**
 * A client over a few tables held in memory, for the copy.
 *
 * It answers exactly the statements `storageCopy.js` and `pgMigrations.js`
 * send, recognised by their text, and throws on anything else so a statement
 * added there without a case here fails loudly instead of returning no rows.
 *
 * `db.tables` is `{ name: { columns: [{ name, generated }], rows: [[...]], rls } }`.
 * `db.migrate(sql, db)` is called for each migration file's text, and is where a
 * test makes a migration "create" its tables. `db.onInsert(table, rows)` may
 * throw to play a refusal by the server.
 */
function fakeDatabase(db) {
    db.tables = db.tables || {};
    db.fks = db.fks || [];
    db.ledger = db.ledger || null;
    db.setvals = [];

    const unquote = (s) => s.replace(/^"|"$/g, '').replace(/""/g, '"');
    const tableOf = (sql, re) => {
        const m = re.exec(sql);
        if (!m) return null;
        const name = unquote(m[1]);
        if (!db.tables[name]) throw new Error(`relation "${name}" does not exist`);
        return name;
    };

    return fakeClient((sql, params) => {
        if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return undefined;

        if (sql.startsWith('SELECT to_regclass')) return [{ t: db.ledger ? '_aegis_migrations' : null }];
        if (sql.startsWith('SELECT name FROM _aegis_migrations')) return (db.ledger || []).map((name) => ({ name }));
        if (sql.startsWith('CREATE TABLE IF NOT EXISTS _aegis_migrations')) { db.ledger = db.ledger || []; return undefined; }
        if (sql.startsWith('INSERT INTO _aegis_migrations')) { db.ledger.push(params[0]); return undefined; }

        if (sql.includes('FROM information_schema.columns')) {
            const rows = [];
            for (const [name, t] of Object.entries(db.tables)) {
                for (const c of t.columns) {
                    rows.push({
                        table_name: name, column_name: c.name,
                        column_default: c.generated === 'serial' ? `nextval('${name}_${c.name}_seq'::regclass)` : null,
                        is_identity: c.generated === 'identity' ? 'YES' : 'NO'
                    });
                }
            }
            return rows;
        }
        if (sql.includes('FROM pg_constraint')) return db.fks.slice();
        if (sql.includes('NOT c.relrowsecurity')) {
            return Object.keys(db.tables).filter((n) => !db.tables[n].rls).sort().map((name) => ({ name }));
        }
        if (sql.includes("c.relkind = 'r'")) return Object.keys(db.tables).map((name) => ({ name }));

        const counted = tableOf(sql, /^SELECT count\(\*\)::int AS n FROM ("(?:[^"]|"")+")$/);
        if (counted) return [{ n: db.tables[counted].rows.length }];

        const cleared = tableOf(sql, /^DELETE FROM ("(?:[^"]|"")+")$/);
        if (cleared) { db.tables[cleared].rows = []; return undefined; }

        const filled = /^INSERT INTO ("(?:[^"]|"")+") \((.+?)\) VALUES /.exec(sql);
        if (filled) {
            const name = unquote(filled[1]);
            if (!db.tables[name]) throw new Error(`relation "${name}" does not exist`);
            const cols = filled[2].split(', ').map(unquote);
            const rows = [];
            for (let i = 0; i < params.length; i += cols.length) {
                const row = {};
                cols.forEach((c, j) => { row[c] = params[i + j]; });
                rows.push(row);
            }
            if (db.onInsert) db.onInsert(name, rows);
            db.tables[name].rows.push(...rows);
            return undefined;
        }

        if (sql.startsWith('SELECT pg_get_serial_sequence')) {
            const table = unquote(params[0]);
            const col = (db.tables[table].columns.find((c) => c.name === params[1]) || {});
            return [{ s: col.generated ? `public.${table}_${params[1]}_seq` : null }];
        }
        if (sql.startsWith('SELECT setval')) { db.setvals.push({ seq: params[0], sql }); return undefined; }

        // Anything else is a migration file's own text.
        if (db.migrate) { db.migrate(sql, db); return undefined; }
        throw new Error(`fakeDatabase has no answer for: ${sql}`);
    });
}

/**
 * Core's read-only SQLite reader, over tables held in memory.
 *
 * `tables` is `{ name: { columns: ['a', 'b'], rows: [[1, 'x']] } }`. Null plays
 * a project that has no database file yet.
 */
function fakeReader(tables) {
    return {
        calls: [],
        async describe() {
            if (!tables) throw Object.assign(new Error('SQLITE_CANTOPEN'), { code: 'unknown_file' });
            return Object.entries(tables).map(([name, t]) => ({
                name, type: t.view ? 'view' : 'table',
                columns: t.columns.map((c) => ({ name: c, type: '', notNull: false, pk: false })),
                rows: t.rows.length
            }));
        },
        async rows(file, { table, limit, offset }) {
            this.calls.push({ table, limit, offset });
            const t = tables[table];
            return { columns: t.columns.slice(), rows: t.rows.slice(offset, offset + limit) };
        }
    };
}

module.exports = { fakeClient, fakeDatabase, fakeReader };
