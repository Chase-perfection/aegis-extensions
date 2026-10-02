'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skip = sqlite ? false : `node:sqlite needs Node 22.5 or later, this is ${process.version}`;

test('seed-db leaves a database the routes read as the fixture', { skip }, async () => {
    const { seed } = require('./fixtures/seed-db');
    const store = require('../../backend/store');
    const { buildModel } = require('../../backend/routes');
    const { facts } = require('./fixtures/build-fixture');
    const expected = require('./fixtures/model.json').model;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-seed-'));
    const file = path.join(dir, 'extension.db');
    new sqlite.DatabaseSync(file).close();

    await seed(file);

    const raw = new sqlite.DatabaseSync(file);
    try {
        const db = {
            run: async (sql, p) => raw.prepare(sql).run(...(p || [])),
            get: async (sql, p) => raw.prepare(sql).get(...(p || [])),
            all: async (sql, p) => raw.prepare(sql).all(...(p || [])),
            exec: async (sql) => raw.exec(sql)
        };
        await store.ensure(db);
        const latest = await store.latestFacts(db);
        assert.deepStrictEqual(latest.facts, facts);
        const model = buildModel(latest.facts, await store.getRules(db), await store.getOverrides(db), await store.getRemediations(db));
        assert.strictEqual(model.accounts.length, expected.accounts.length);
        assert.deepStrictEqual(model.matrix, expected.matrix);
        assert.strictEqual(model.rulesCount, expected.rulesCount);
        const overridden = model.accounts.find((a) => a.override);
        assert.ok(overridden && overridden.override.reason, 'the override survives the seed');
        assert.ok(model.accounts.some((a) => a.remediationProposed), 'the remediation marker survives the seed');
    } finally {
        raw.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
