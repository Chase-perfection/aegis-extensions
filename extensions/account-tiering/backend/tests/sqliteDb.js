/**
 * A real SQLite handle shaped like the one `extensionDb` hands over, for tests.
 *
 * Core opens extension databases with the `sqlite3` package, which an
 * extension may not require. `node:sqlite` ships with Node 22.5 and later, so
 * on a developer machine the store runs against a real engine. This
 * repository's CI pins Node 20.19.1, which has no `node:sqlite`: there
 * `available` is false and the tests that need it skip with that reason, and
 * the pure modules keep their coverage.
 */

'use strict';

let DatabaseSync = null;
try {
    ({ DatabaseSync } = require('node:sqlite'));
} catch (_) {
    DatabaseSync = null;
}

const available = DatabaseSync !== null;
const why = available ? null : `node:sqlite needs Node 22.5 or later, this is ${process.version}`;

/** An in-memory database with core's facade: async `run`, `get`, `all`, `exec`. */
function openMemoryDb() {
    const raw = new DatabaseSync(':memory:');
    const bind = (params) => (params || []).map((v) => (v === undefined ? null : v));
    return Object.freeze({
        async run(sql, params) {
            const r = raw.prepare(sql).run(...bind(params));
            return { lastID: Number(r.lastInsertRowid), changes: Number(r.changes) };
        },
        async get(sql, params) { return raw.prepare(sql).get(...bind(params)); },
        async all(sql, params) { return raw.prepare(sql).all(...bind(params)); },
        async exec(sql) { raw.exec(sql); }
    });
}

module.exports = { available, why, openMemoryDb };
