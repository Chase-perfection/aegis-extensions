'use strict';

const test = require('node:test');
const assert = require('node:assert');

const sqlite = require('./sqliteDb');
const store = require('../store');

const opts = { skip: sqlite.why || false };

async function fresh() {
    const db = sqlite.openMemoryDb();
    await store.ensure(db);
    return db;
}

test('a scan runs, finishes, and its facts come back', opts, async () => {
    const db = await fresh();
    const id = await store.startScan(db, 'corp.local');
    assert.strictEqual((await store.runningScan(db)).id, id);
    await store.finishScan(db, id, { status: 'ok', facts: { schema: 1 } });
    assert.strictEqual(await store.runningScan(db), undefined);
    assert.deepStrictEqual(await store.latestFacts(db), { id, facts: { schema: 1 } });
});

test('a failed scan is not shown as facts', opts, async () => {
    const db = await fresh();
    const id = await store.startScan(db, null);
    await store.finishScan(db, id, { status: 'failed', errorCode: 'domain_unreachable' });
    assert.strictEqual(await store.latestFacts(db), null);
    assert.strictEqual((await store.latestScan(db)).error_code, 'domain_unreachable');
});

test('only the last five scans are kept', opts, async () => {
    const db = await fresh();
    for (let i = 0; i < 7; i += 1) {
        const id = await store.startScan(db, null);
        await store.finishScan(db, id, { status: 'ok', facts: { schema: 1, i } });
    }
    const { n } = await db.get('SELECT COUNT(*) AS n FROM scans');
    assert.strictEqual(n, store.KEEP_SCANS);
});

test('a running row left by a stopped service becomes scan_interrupted on the next open', opts, async () => {
    const db = sqlite.openMemoryDb();
    await db.exec("CREATE TABLE scans (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, error_code TEXT, domain TEXT, facts_json TEXT)");
    await db.run("INSERT INTO scans (id, started_at, status) VALUES ('old', '2026-01-01T00:00:00Z', 'running')");
    await store.ensure(db);
    const row = await db.get("SELECT status, error_code FROM scans WHERE id = 'old'");
    assert.deepStrictEqual({ ...row }, { status: 'failed', error_code: 'scan_interrupted' });
});

test('a scan running in this process survives a reopened handle', opts, async () => {
    const first = await fresh();
    const id = await store.startScan(first, null);
    const raw = await first.all('SELECT * FROM scans');
    const second = sqlite.openMemoryDb();
    await second.exec("CREATE TABLE scans (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, error_code TEXT, domain TEXT, facts_json TEXT)");
    for (const r of raw) await second.run('INSERT INTO scans (id, started_at, status) VALUES (?, ?, ?)', [r.id, r.started_at, r.status]);
    await store.ensure(second);
    assert.strictEqual((await second.get('SELECT status FROM scans WHERE id = ?', [id])).status, 'running');
    await store.finishScan(first, id, { status: 'failed', errorCode: 'x' });
});

test('five failures in a row do not evict the last good scan', opts, async () => {
    const db = await fresh();
    const pause = () => new Promise((resolve) => setTimeout(resolve, 3));
    const good = await store.startScan(db, null);
    await store.finishScan(db, good, { status: 'ok', facts: { schema: 1 } });
    for (let i = 0; i < 6; i += 1) {
        // Distinct start times: the prune orders by started_at.
        await pause();
        const id = await store.startScan(db, null);
        await store.finishScan(db, id, { status: 'failed', errorCode: 'domain_unreachable' });
    }
    assert.deepStrictEqual(await store.latestFacts(db), { id: good, facts: { schema: 1 } });
    const { n } = await db.get('SELECT COUNT(*) AS n FROM scans');
    assert.strictEqual(n, store.KEEP_SCANS + 1);
});

test('a running row nobody in this process owns is cleared by runningScan', opts, async () => {
    const db = await fresh();
    await db.run("INSERT INTO scans (id, started_at, status) VALUES ('ghost', ?, 'running')", [new Date().toISOString()]);
    assert.strictEqual(await store.runningScan(db), undefined);
    const row = await db.get("SELECT status, error_code, finished_at FROM scans WHERE id = 'ghost'");
    assert.deepStrictEqual([row.status, row.error_code], ['failed', 'scan_interrupted']);
    assert.ok(row.finished_at);
});

test('runningScan still returns a scan started in this process', opts, async () => {
    const db = await fresh();
    await db.run("INSERT INTO scans (id, started_at, status) VALUES ('ghost', ?, 'running')", [new Date().toISOString()]);
    const id = await store.startScan(db, null);
    assert.strictEqual((await store.runningScan(db)).id, id);
    assert.strictEqual((await db.get("SELECT status FROM scans WHERE id = 'ghost'")).status, 'failed');
    await store.finishScan(db, id, { status: 'failed', errorCode: 'x' });
});

test('rules are replaced as a whole, in the order given', opts, async () => {
    const db = await fresh();
    await store.replaceRules(db, [{ kind: 'name', pattern: '*-adm', tier: 0 }, { kind: 'ou', pattern: 'OU=X,DC=corp,DC=local', tier: 1 }], 'ops@corp.local');
    await store.replaceRules(db, [{ kind: 'name', pattern: 'svc-*', tier: 1 }], 'ops@corp.local');
    const rules = await store.getRules(db);
    assert.deepStrictEqual(rules.map((r) => [r.position, r.pattern]), [[0, 'svc-*']]);
});

test('a failing rule replacement leaves the old rules in place', opts, async () => {
    const db = await fresh();
    await store.replaceRules(db, [{ kind: 'name', pattern: 'keep', tier: 0 }], null);
    await assert.rejects(store.replaceRules(db, [{ kind: 'name', pattern: null, tier: 0 }], null));
    assert.deepStrictEqual((await store.getRules(db)).map((r) => r.pattern), ['keep']);
});

test('overrides, remediations and settings round-trip', opts, async () => {
    const db = await fresh();
    await store.setOverride(db, 'S-1-5-21-1-2-3-1200', { tier: 0, reason: 'admin', by: 'a' });
    await store.setOverride(db, 'S-1-5-21-1-2-3-1200', { tier: 1, reason: 'changed', by: 'b' });
    assert.deepStrictEqual((await store.getOverrides(db)).map((o) => [o.tier, o.reason]), [[1, 'changed']]);
    await store.deleteOverride(db, 'S-1-5-21-1-2-3-1200');
    assert.deepStrictEqual(await store.getOverrides(db), []);

    await store.markRemediation(db, 'S-1-5-21-1-2-3-1200', 'a');
    await store.markRemediation(db, 'S-1-5-21-1-2-3-1200', 'a');
    assert.strictEqual((await store.getRemediations(db)).length, 1);

    assert.deepStrictEqual(await store.getSettings(db), { domain: null, passes: 3 });
    await store.putSettings(db, { domain: 'corp.local', passes: 4 });
    assert.deepStrictEqual(await store.getSettings(db), { domain: 'corp.local', passes: 4 });
});
