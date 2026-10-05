/**
 * A project's schema on Postgres, from the `.sql` files its repository carries.
 *
 * The same idea as `migrations.js`, which plays `<migrationsDir>/*.sql` on the
 * project's SQLite file: numbered files, each played once, in the order of
 * their names, recorded in a ledger table. The Postgres files live one folder
 * down, in `<migrationsDir>/postgres/`. `migrations.list` does not descend, so
 * the SQLite runner never sees them, and a repository can carry both dialects
 * while it moves from one to the other.
 *
 * That folder is also how Deploy knows a project's code can speak Postgres at
 * all. A version with no file there is a version that expects a SQLite file,
 * and the switch refuses it (`storageChecks`, check `code`).
 *
 * One difference from the SQLite runner, and it is Postgres's doing: DDL is
 * transactional here. A file and its ledger row commit together, so a process
 * dying halfway leaves nothing to replay by hand. It also lets the guided setup
 * rehearse: `run` with `inTransaction` plays everything inside a transaction
 * the caller opened and will roll back, and the caller reads what the schema
 * would be.
 *
 * This module holds no connection. The client comes from core
 * (`context.postgres`), because `pg` does not resolve from an extension.
 *
 * A migration file is SQL from the project's own repository, run with the
 * rights of the database user the operator typed. No route passes SQL in.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const migrations = require('./migrations');

/** The folder under `migrationsDir` that holds the Postgres dialect. */
const SUBDIR = 'postgres';

/** Same name as the SQLite ledger, so one word means one thing in both stores. */
const LEDGER = '_aegis_migrations';

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${LEDGER} (`
    + 'name text PRIMARY KEY, applied_at bigint NOT NULL, sha text)';

function fail(code, message) {
    return Object.assign(new Error(message), { code });
}

/** Where one version of a project keeps its Postgres migrations. */
function dirFor(versionDir, project) {
    return path.join(versionDir, (project && project.migrationsDir) || migrations.DEFAULT_DIR, SUBDIR);
}

/** The files present, sorted by name. Empty when the folder is missing. */
function list(dir) {
    return migrations.list(dir);
}

/** The names already played, or an empty list when the ledger does not exist yet. */
async function applied(client) {
    const there = await client.query('SELECT to_regclass($1) AS t', [LEDGER]);
    if (!there.rows[0] || !there.rows[0].t) return [];
    const rows = await client.query(`SELECT name FROM ${LEDGER} ORDER BY applied_at, name`);
    return rows.rows.map((r) => r.name);
}

/**
 * Plays what is left.
 *
 * Returns `{ applied, alreadyApplied }`. A failure throws `migration_failed`
 * naming the file, with that file rolled back and the ones before it kept:
 * each of those committed with its ledger row and will not be played again.
 */
async function run({ client, dir, sha, inTransaction }) {
    const done = await applied(client);
    const todo = migrations.pending(dir, done);

    const played = [];
    for (const name of todo) {
        let sql;
        try {
            sql = fs.readFileSync(path.join(dir, name), 'utf8');
        } catch (e) {
            throw fail('migration_failed', `${name}: unreadable (${e.message})`);
        }
        if (!sql.trim()) throw fail('migration_failed', `${name}: empty file`);

        if (!inTransaction) await client.query('BEGIN');
        try {
            await client.query(sql);
            await client.query(LEDGER_DDL);
            await client.query(`INSERT INTO ${LEDGER} (name, applied_at, sha) VALUES ($1, $2, $3)`,
                [name, Date.now(), sha ? String(sha) : null]);
            if (!inTransaction) await client.query('COMMIT');
        } catch (e) {
            if (!inTransaction) await client.query('ROLLBACK').catch(() => { });
            throw fail('migration_failed', `${name}: ${e.message}`);
        }
        played.push(name);
    }
    return { applied: played, alreadyApplied: done };
}

module.exports = { dirFor, list, applied, run, SUBDIR, LEDGER };
