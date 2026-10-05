/**
 * Carries a project's rows from its SQLite file to its Postgres database.
 *
 * The schema is not this module's business. The project's own migrations
 * created the tables (`pgMigrations.js`), with the types its author chose. What
 * is left is rows, and the question a copy has to answer before it moves one:
 * can every table of the file land somewhere.
 *
 * `plan` answers it, table by table. `copy` moves the rows. Both work on a
 * client whose transaction the caller holds, and that is the whole safety
 * model:
 *
 *   - the guided setup calls both and rolls back, so what it shows the operator
 *     is what a real copy did, type errors included, and the database is left
 *     as it was;
 *   - the switch calls both and commits only when every count matches.
 *
 * Strict on purpose. A table of the file with rows and no table to receive
 * them, or a column with no column, is a refusal that names it. Dropping it
 * quietly would be data lost at the one moment the operator trusted the tool
 * with all of it.
 *
 * The file is read through core's read-only reader and is never modified.
 *
 * ponytail: tables are ordered by foreign key, rows inside a table are not. A
 * table that references itself across more than one batch can refuse a child
 * read before its parent; Postgres then says which key, and nothing is kept.
 * Rows are read with LIMIT and OFFSET, which is quadratic on a very large
 * table. Both are fine for the files a deployed site keeps. A keyset read
 * belongs in core's reader the day one is not.
 */

'use strict';

const pgMigrations = require('./pgMigrations');

/** Rows per INSERT. Small enough that a refusal names a narrow slice. */
const BATCH = 500;

/** Postgres takes 65535 bound values in one statement. */
const MAX_PARAMS = 60000;

function fail(code, message, extra) {
    return Object.assign(new Error(message), { code }, extra || {});
}

/** An identifier, quoted for Postgres. Only names read from a catalogue reach here. */
function q(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
}

/**
 * Finds a name the way the two engines disagree about it.
 *
 * SQLite compares identifiers without case and Postgres folds an unquoted one
 * to lower case, so `Users` in the file is `users` in a migration written the
 * usual way. The exact name wins when both exist.
 */
function match(names, wanted) {
    if (names.includes(wanted)) return wanted;
    const lower = String(wanted).toLowerCase();
    return names.find((n) => n.toLowerCase() === lower) || null;
}

/**
 * Parents before children.
 *
 * `fks` is `[{ child, parent }]`. A table pointing at itself is not an edge. A
 * cycle between tables cannot be ordered and is refused by name.
 */
function order(tables, fks) {
    const waiting = new Map(tables.map((t) => [t, new Set()]));
    for (const { child, parent } of fks || []) {
        if (child === parent || !waiting.has(child) || !waiting.has(parent)) continue;
        waiting.get(child).add(parent);
    }

    const out = [];
    while (waiting.size) {
        const ready = Array.from(waiting.keys()).filter((t) => waiting.get(t).size === 0);
        if (!ready.length) {
            throw fail('fk_cycle', `these tables reference each other in a circle: ${Array.from(waiting.keys()).join(', ')}`);
        }
        for (const t of ready) {
            out.push(t);
            waiting.delete(t);
        }
        for (const deps of waiting.values()) ready.forEach((t) => deps.delete(t));
    }
    return out;
}

/** The tables of the file an application owns: not SQLite's, not the ledger, not a view. */
async function sourceTables(reader, file) {
    let objects;
    try {
        objects = await reader.describe(file);
    } catch (e) {
        if (e && e.code === 'unknown_file') return [];        // no file yet: nothing to carry
        throw e;
    }
    return objects.filter((o) => o.type === 'table' && o.name !== pgMigrations.LEDGER);
}

/** The target's tables in the schema the migrations wrote to, with their columns. */
async function targetTables(client) {
    const res = await client.query(
        'SELECT table_name, column_name, column_default, is_identity '
        + 'FROM information_schema.columns WHERE table_schema = current_schema() '
        + 'ORDER BY table_name, ordinal_position');
    const tables = new Map();
    for (const row of res.rows) {
        if (!tables.has(row.table_name)) tables.set(row.table_name, []);
        tables.get(row.table_name).push({
            name: row.column_name,
            generated: row.is_identity === 'YES' || /^nextval\(/i.test(String(row.column_default || ''))
        });
    }
    return tables;
}

/**
 * How many rows each table of the target holds, before anything is played.
 *
 * Taken first so that `plan` can tell two kinds of rows apart afterwards. Rows
 * that were there before belong to somebody, and their table is refused. Rows
 * that appeared since were inserted by a migration of this project, as
 * reference data, and the file holds the same table as the application left
 * it: the file wins and those rows are replaced.
 */
async function snapshot(client) {
    const names = await client.query(
        'SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace '
        + "WHERE n.nspname = current_schema() AND c.relkind = 'r'");
    const counts = new Map();
    for (const row of names.rows) {
        const held = await client.query(`SELECT count(*)::int AS n FROM ${q(row.name)}`);
        counts.set(row.name, Number(held.rows[0].n));
    }
    return counts;
}

/**
 * What a copy would do, table by table, without moving a row.
 *
 * `state` is `ok`, `empty` (no row to carry, so no table is needed),
 * `missing_table`, `missing_columns`, `not_empty` or `unreadable`. `ok` on the
 * result is true when no table is in one of the last four. `before` is a `snapshot` taken
 * ahead of the migrations; without one, any row in a target table refuses it.
 *
 * `replace` lifts that refusal, and is for one case: a project that was on this
 * database, went back to its file, and switches again. The rows there are the
 * ones its own earlier switch copied, the file is the truth again, and the
 * operator ticked a box that says so. The caller decides whether that case
 * holds (`projectStorage.canReplace`); this function only does what it is told,
 * and reports in `replaced` how many rows give way.
 */
async function plan({ client, reader, file, before, replace }) {
    const source = await sourceTables(reader, file);
    const target = await targetTables(client);
    const targetNames = Array.from(target.keys());

    const tables = [];
    for (const s of source) {
        const entry = { name: s.name, rows: s.rows || 0, state: 'ok', target: null, missingColumns: [], columns: [], seeded: 0, replaced: 0 };

        // The reader could not count this table: the file was busy, or the
        // table is damaged. Unknown is not zero. Read as "empty", the table
        // would be skipped and the switch would succeed with its rows left
        // behind in the file.
        if (s.rows === null || s.rows === undefined) {
            entry.state = 'unreadable';
            tables.push(entry);
            continue;
        }
        const name = match(targetNames, s.name);

        if (!name) {
            entry.state = entry.rows ? 'missing_table' : 'empty';
            tables.push(entry);
            continue;
        }
        entry.target = name;

        const columns = target.get(name).map((c) => c.name);
        for (const c of s.columns) {
            const to = match(columns, c.name);
            if (to) entry.columns.push({ from: c.name, to });
            else entry.missingColumns.push(c.name);
        }
        if (entry.missingColumns.length) {
            entry.state = entry.rows ? 'missing_columns' : 'empty';
        } else {
            const held = await client.query(`SELECT count(*)::int AS n FROM ${q(name)}`);
            const now = Number(held.rows[0].n);
            const earlier = before ? (before.get(name) || 0) : now;
            if (earlier > 0 && !replace) {
                entry.state = 'not_empty';
            } else if (earlier > 0) {
                // Stays `ok` even with no row to carry: the table has to end
                // up as empty as the file's.
                entry.replaced = earlier;
                entry.seeded = now;
            } else if (!entry.rows) {
                entry.state = 'empty';
            } else {
                entry.seeded = now;
            }
        }
        tables.push(entry);
    }

    const fks = await client.query(
        'SELECT cl.relname AS child, pr.relname AS parent FROM pg_constraint co '
        + 'JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_class pr ON pr.oid = co.confrelid '
        + 'JOIN pg_namespace n ON n.oid = cl.relnamespace '
        + "WHERE co.contype = 'f' AND n.nspname = current_schema()");

    // Tables the stack's own API would serve to anyone holding its public key.
    // A warning the page shows for a Supabase target, never a refusal: the
    // owner of a table passes row level security either way.
    const open = await client.query(
        'SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace '
        + "WHERE n.nspname = current_schema() AND c.relkind = 'r' AND NOT c.relrowsecurity ORDER BY c.relname");

    const blocking = ['missing_table', 'missing_columns', 'not_empty', 'unreadable'];
    return {
        ok: tables.every((t) => !blocking.includes(t.state)),
        tables,
        fks: fks.rows.map((r) => ({ child: r.child, parent: r.parent })),
        generated: Array.from(target.entries()).map(([name, cols]) => ({
            name, columns: cols.filter((c) => c.generated).map((c) => c.name)
        })).filter((t) => t.columns.length),
        withoutRls: open.rows.map((r) => r.name).filter((n) => n !== pgMigrations.LEDGER)
    };
}

/** A value as the driver should send it. SQLite hands back numbers, text, buffers and nulls. */
function value(v) {
    return v === undefined ? null : v;
}

/**
 * Moves the rows of every `ok` table of a plan, parents first.
 *
 * The caller holds the transaction. Returns `[{ name, source, copied }]`, and
 * throws `count_mismatch` when a table does not hold exactly what was read:
 * the caller then rolls back and nothing is kept.
 */
async function copy({ client, reader, file, plan: p }) {
    const todo = p.tables.filter((t) => t.state === 'ok');
    const byTarget = new Map(todo.map((t) => [t.target, t]));
    const sequence = order(todo.map((t) => t.target), p.fks);

    // Reference rows a migration inserted give way to the file's. Children
    // first, so no delete trips over a row that still points at it.
    for (const targetName of sequence.slice().reverse()) {
        if (byTarget.get(targetName).seeded) await client.query(`DELETE FROM ${q(targetName)}`);
    }

    const results = [];
    for (const targetName of sequence) {
        const t = byTarget.get(targetName);
        const cols = t.columns;
        const size = Math.max(1, Math.min(BATCH, Math.floor(MAX_PARAMS / Math.max(cols.length, 1))));
        const head = `INSERT INTO ${q(targetName)} (${cols.map((c) => q(c.to)).join(', ')}) VALUES `;

        let read = 0;
        for (let offset = 0; ; offset += size) {
            const page = await reader.rows(file, { table: t.name, limit: size, offset });
            if (!page.rows.length) break;

            // By name, not by position: the reader keys a row by the columns
            // SQLite returned, and the plan holds the names it mapped.
            const at = cols.map((c) => page.columns.indexOf(c.from));
            const params = [];
            const tuples = page.rows.map((row) => {
                const marks = at.map((i) => {
                    params.push(value(i === -1 ? null : row[i]));
                    return `$${params.length}`;
                });
                return `(${marks.join(', ')})`;
            });
            try {
                await client.query(head + tuples.join(', '), params);
            } catch (e) {
                throw fail('copy_failed', `${t.name}: ${e.message}`, { table: t.name });
            }
            read += page.rows.length;
            if (page.rows.length < size) break;
        }

        const held = await client.query(`SELECT count(*)::int AS n FROM ${q(targetName)}`);
        const copied = Number(held.rows[0].n);
        if (copied !== read || read !== t.rows) {
            throw fail('count_mismatch',
                `${t.name}: the file held ${t.rows} row(s), ${read} were read and the database holds ${copied}`,
                { table: t.name });
        }
        results.push({ name: t.name, target: targetName, source: t.rows, copied });
    }

    // A serial or identity column keeps counting from 1 after rows arrived
    // with their own numbers, and the application's first insert would then
    // collide with a row that was just copied.
    for (const g of p.generated) {
        if (!byTarget.has(g.name)) continue;
        for (const column of g.columns) {
            const seq = await client.query('SELECT pg_get_serial_sequence($1, $2) AS s', [q(g.name), column]);
            const name = seq.rows[0] && seq.rows[0].s;
            if (!name) continue;
            await client.query(
                `SELECT setval($1, (SELECT COALESCE(MAX(${q(column)}), 0) FROM ${q(g.name)}) + 1, false)`, [name]);
        }
    }
    return results;
}

/**
 * The whole passage, in the caller's transaction: the project's migrations,
 * then the plan, then the rows when the plan allows them.
 *
 * One function for the rehearsal and for the switch, so what the operator was
 * shown and what then happens cannot drift apart. The caller opens the
 * transaction and decides how it ends: the rehearsal rolls back, the switch
 * commits when `ok` is true.
 */
async function carry({ client, reader, file, dir, sha, replace }) {
    const before = await snapshot(client);
    const played = await pgMigrations.run({ client, dir, sha, inTransaction: true });
    const p = await plan({ client, reader, file, before, replace });
    const copied = p.ok ? await copy({ client, reader, file, plan: p }) : [];
    return {
        ok: p.ok,
        migrations: played.applied,
        tables: p.tables.map((t) => {
            const done = copied.find((c) => c.name === t.name);
            return {
                name: t.name, rows: t.rows, state: t.state,
                missingColumns: t.missingColumns, copied: done ? done.copied : 0,
                replaced: t.replaced || 0
            };
        }),
        withoutRls: p.withoutRls,
        // Parents first, as they were filled. `empty` walks it backwards.
        copiedTargets: copied.map((c) => c.target)
    };
}

/**
 * Takes back what a copy put in, children first.
 *
 * For the one case where a copy committed and the project then could not start
 * on it. The tables were empty before this switch filled them, and the file
 * still holds every row, so emptying them loses nothing. Left full, they would
 * refuse the next attempt as `not_empty`, with no way out from the page.
 */
async function empty({ client, targets }) {
    for (const name of (targets || []).slice().reverse()) {
        await client.query(`DELETE FROM ${q(name)}`);
    }
}

module.exports = { snapshot, plan, copy, carry, empty, order, BATCH, _match: match };
