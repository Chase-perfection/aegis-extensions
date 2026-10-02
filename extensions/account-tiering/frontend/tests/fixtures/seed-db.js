/**
 * Loads the invented corp.local fixture into a real account-tiering database,
 * so the page can be looked at in a running Aegis before a collector exists.
 *
 * Run: node seed-db.js <path to extension.db>
 *
 * The database is the one core opens for the tenant, at
 * `<tenant data>\extensions\account-tiering\extension.db`. Open the page once
 * first, so the file exists, then run this and reload the page. It writes one
 * finished scan with the fixture's facts, replaces the rules, sets the
 * fixture's override and remediation marker, and touches nothing else.
 *
 * Every write goes through backend/store.js, the module the routes use, so the
 * rows are exactly what a real scan would leave. Needs Node 22.5 or later for
 * `node:sqlite`; the Aegis installer's Node 20 does not have it, a developer
 * machine does. Lives under tests/, which the release keeps out of the package.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const store = require(path.join(__dirname, '..', '..', '..', 'backend', 'store'));
const { facts, rules, overrides, remediations } = require('./build-fixture');

/** core's extensionDb facade (run/get/all/exec) over a node:sqlite file. */
function openFile(file) {
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA busy_timeout = 5000');
    const bind = (params) => (params || []).map((v) => (v === undefined ? null : v));
    const db = Object.freeze({
        async run(sql, params) {
            const r = raw.prepare(sql).run(...bind(params));
            return { lastID: Number(r.lastInsertRowid), changes: Number(r.changes) };
        },
        async get(sql, params) { return raw.prepare(sql).get(...bind(params)); },
        async all(sql, params) { return raw.prepare(sql).all(...bind(params)); },
        async exec(sql) { raw.exec(sql); }
    });
    return { db, close: () => raw.close() };
}

async function seed(file) {
    const { db, close } = openFile(file);
    try {
        await store.ensure(db);
        const id = await store.startScan(db, facts.domain);
        await store.finishScan(db, id, { status: facts.unreadable.length ? 'partial' : 'ok', facts });
        await store.replaceRules(db, rules.map(({ kind, pattern, tier }) => ({ kind, pattern, tier })), 'seed-db');
        for (const o of overrides) await store.setOverride(db, o.sid, { tier: o.tier, reason: o.reason, by: o.set_by });
        for (const r of remediations) await store.markRemediation(db, r.sid, r.proposed_by);
        return id;
    } finally {
        close();
    }
}

module.exports = { seed };

if (require.main === module) {
    const file = process.argv[2];
    if (!file) {
        console.error('usage: node seed-db.js <path to extension.db>');
        process.exit(1);
    }
    if (!fs.existsSync(file)) {
        console.error(`${file} does not exist: open the Arbre des comptes page once, then rerun`);
        process.exit(1);
    }
    seed(file).then(
        (id) => console.log(`seeded scan ${id} into ${file}: reload the page`),
        (error) => { console.error(error); process.exit(1); }
    );
}
