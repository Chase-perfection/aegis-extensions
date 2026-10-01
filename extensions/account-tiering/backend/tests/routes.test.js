/**
 * The routes' contract, without express and without a network.
 *
 * `register` gets a router that records its handlers, and each chain is run
 * with a request built here: the same shape as deploy's createRoute.test.js.
 * Tests that need a database use `node:sqlite` and skip on Node 20.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const routes = require('../routes');
const store = require('../store');
const sqlite = require('./sqliteDb');
const { sid, user, group, facts } = require('./facts');

const BASE = '/api/account-tiering';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'at-routes-'));
console.error = () => {};

/** Lets the chain through only for `req.user.role === role`, like core's requireRole. */
const requireRole = (role) => (req, res, next) => (req.user && req.user.role === role
    ? next()
    : res.status(403).json({ success: false, error: 'forbidden' }));

function fakeExtensionDb(db) {
    return {
        withRequest: async (req, work) => work(db),
        pathForRequest: () => path.join(DIR, 'extension.db')
    };
}

function mount(context) {
    const table = new Map();
    const add = (method) => (routePath, ...chain) => table.set(`${method} ${routePath}`, chain);
    routes.register({ get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE') }, { requireRole, ...context });
    return table;
}

function call(table, key, req) {
    const chain = table.get(key);
    assert.ok(chain, `${key} is not mounted`);
    return new Promise((resolve, reject) => {
        const res = {
            statusCode: 200, headers: {}, headersSent: false,
            status(code) { this.statusCode = code; return this; },
            setHeader(k, v) { this.headers[k] = v; },
            json(body) { this.headersSent = true; resolve({ status: this.statusCode, body, headers: this.headers }); return this; },
            send(body) { this.headersSent = true; resolve({ status: this.statusCode, body, headers: this.headers }); return this; }
        };
        let i = 0;
        const next = () => Promise.resolve(chain[i++](req, res, next)).catch(reject);
        next();
    });
}

const request = (extra = {}) => ({
    body: {}, params: {}, query: {},
    tenant: { slug: 'acme' },
    user: { email: 'ops@corp.local', role: 'admin' },
    ...extra
});

test('every route is refused to a non-admin', async () => {
    const table = mount({});
    for (const key of table.keys()) {
        const r = await call(table, key, request({ user: { role: 'viewer' }, params: { sid: sid(1200) } }));
        assert.strictEqual(r.status, 403, key);
    }
});

test('without extensionDb, register does not throw and every route answers 501 store_unavailable', async () => {
    const table = mount({});
    assert.ok(table.size >= 12);
    for (const key of table.keys()) {
        const r = await call(table, key, request({ params: { sid: sid(1200) } }));
        assert.deepStrictEqual([r.status, r.body.error], [501, 'store_unavailable'], key);
    }
});

const db = (opts) => ({ skip: sqlite.why || false, ...opts });

test('an invalid SID is refused before any write', db(), async () => {
    const table = mount({ extensionDb: fakeExtensionDb(sqlite.openMemoryDb()) });
    for (const bad of ['S-1-5-21-1-2-3', '../etc', 'S-1-5-21-1-2-3-4\n']) {
        const r = await call(table, `PUT ${BASE}/overrides/:sid`, request({ params: { sid: bad }, body: { tier: 0, reason: 'x' } }));
        assert.deepStrictEqual([r.status, r.body.error], [400, 'invalid_sid'], JSON.stringify(bad));
    }
});

test('no scan yet gives 404 no_scan_yet on the model and on both exports', db(), async () => {
    const table = mount({ extensionDb: fakeExtensionDb(sqlite.openMemoryDb()) });
    for (const key of [`GET ${BASE}/model`, `GET ${BASE}/export.json`, `GET ${BASE}/export.csv`]) {
        const r = await call(table, key, request());
        assert.deepStrictEqual([r.status, r.body.error], [404, 'no_scan_yet'], key);
    }
});

test('a second scan while one runs gives 409 scan_running', db(), async () => {
    const memory = sqlite.openMemoryDb();
    await store.ensure(memory);
    const id = await store.startScan(memory, null);
    const table = mount({ extensionDb: fakeExtensionDb(memory) });
    const r = await call(table, `POST ${BASE}/scan`, request());
    assert.deepStrictEqual([r.status, r.body.error], [409, 'scan_running']);
    await store.finishScan(memory, id, { status: 'failed', errorCode: 'x' });
});

/** Polls GET /scan/status until the latest scan leaves `running`. */
async function settled(table) {
    for (let i = 0; i < 50; i += 1) {
        const r = await call(table, `GET ${BASE}/scan/status`, request());
        if (r.body.scan && r.body.scan.status !== 'running') return r.body.scan;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the scan never settled');
}

test('a scan answers 202, records its facts, and the model follows', db(), async () => {
    const memory = sqlite.openMemoryDb();
    const edb = fakeExtensionDb(memory);
    const table = mount({ extensionDb: edb });
    let seen = null;
    routes._setRunner(async (options) => {
        seen = options;
        return { ok: true, status: 'ok', facts: facts({ principals: [user(1200, 'alice')] }) };
    });
    try {
        const started = await call(table, `POST ${BASE}/scan`, request());
        assert.strictEqual(started.status, 202);
        assert.ok(started.body.id);
        const scan = await settled(table);
        assert.strictEqual(scan.status, 'ok');
        const model = await call(table, `GET ${BASE}/model`, request());
        assert.strictEqual(model.status, 200);
        assert.strictEqual(model.body.model.accounts.length, 1);
        assert.strictEqual(path.dirname(seen.outFile), path.dirname(edb.pathForRequest()));
        assert.strictEqual(path.basename(seen.outFile), `scan-${started.body.id}.json`);
    } finally {
        routes._setRunner(null);
    }
});

test('a failed collector run is recorded with its code', db(), async () => {
    const table = mount({ extensionDb: fakeExtensionDb(sqlite.openMemoryDb()) });
    routes._setRunner(async () => ({ ok: false, code: 'domain_unreachable' }));
    try {
        const started = await call(table, `POST ${BASE}/scan`, request());
        assert.strictEqual(started.status, 202);
        const scan = await settled(table);
        assert.deepStrictEqual([scan.status, scan.error_code], ['failed', 'domain_unreachable']);
    } finally {
        routes._setRunner(null);
    }
});

test('two scans started at once: one runs, the other gets 409', db(), async () => {
    const table = mount({ extensionDb: fakeExtensionDb(sqlite.openMemoryDb()) });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    routes._setRunner(async () => {
        await gate;
        return { ok: true, status: 'ok', facts: facts() };
    });
    try {
        const both = await Promise.all([
            call(table, `POST ${BASE}/scan`, request()),
            call(table, `POST ${BASE}/scan`, request())
        ]);
        assert.deepStrictEqual(both.map((r) => r.status).sort(), [202, 409]);
        release();
        assert.strictEqual((await settled(table)).status, 'ok');
    } finally {
        release();
        routes._setRunner(null);
    }
});

test('the model follows a rule change without a new scan, and carries remediations', db(), async () => {
    const memory = sqlite.openMemoryDb();
    await store.ensure(memory);
    const id = await store.startScan(memory, null);
    await store.finishScan(memory, id, {
        status: 'ok',
        facts: facts({
            principals: [group(1100, 'IT-Admins'), user(1200, 'alice')],
            memberships: [{ group: sid(512), member: sid(1100), via: 'member' }, { group: sid(1100), member: sid(1200), via: 'member' }]
        })
    });
    const table = mount({ extensionDb: fakeExtensionDb(memory) });

    const before = await call(table, `GET ${BASE}/model`, request());
    const alice = (m) => m.accounts.find((a) => a.sid === sid(1200));
    assert.strictEqual(alice(before.body.model).status, 'gap');
    assert.strictEqual(before.body.model.rulesCount, 0);
    assert.match(alice(before.body.model).path[0].remediation.command, /^Remove-ADGroupMember/);

    const put = await call(table, `PUT ${BASE}/rules`, request({ body: { rules: [{ kind: 'name', pattern: 'alice', tier: 0 }] } }));
    assert.strictEqual(put.status, 200);
    const after = await call(table, `GET ${BASE}/model`, request());
    assert.strictEqual(alice(after.body.model).status, 'ok');

    const csv = await call(table, `GET ${BASE}/export.csv`, request());
    assert.match(csv.headers['Content-Type'], /^text\/csv/);
    assert.ok(csv.body.includes('alice'));
});

test('a cached model does not read the facts again', db(), async () => {
    const memory = sqlite.openMemoryDb();
    await store.ensure(memory);
    const id = await store.startScan(memory, null);
    await store.finishScan(memory, id, { status: 'ok', facts: facts({ principals: [user(1200, 'alice')] }) });
    let factsReads = 0;
    const counted = {
        ...memory,
        get: (sql, params) => {
            if (/select[^;]*facts_json/i.test(sql)) factsReads += 1;
            return memory.get(sql, params);
        }
    };
    const table = mount({ extensionDb: fakeExtensionDb(counted) });
    for (let i = 0; i < 2; i += 1) {
        const r = await call(table, `GET ${BASE}/model`, request({ tenant: { slug: 'cache-test' } }));
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.model.accounts.length, 1);
    }
    assert.strictEqual(factsReads, 1);
});

test('a collector that throws at launch ends the scan as failed, and the next scan can start', db(), async () => {
    const table = mount({ extensionDb: fakeExtensionDb(sqlite.openMemoryDb()) });
    routes._setRunner(() => { throw new Error('boom'); });
    try {
        const started = await call(table, `POST ${BASE}/scan`, request());
        assert.strictEqual(started.status, 202);
        const scan = await settled(table);
        assert.deepStrictEqual([scan.status, scan.error_code], ['failed', 'internal']);
        routes._setRunner(async () => ({ ok: false, code: 'domain_unreachable' }));
        const again = await call(table, `POST ${BASE}/scan`, request());
        assert.strictEqual(again.status, 202);
        await settled(table);
    } finally {
        routes._setRunner(null);
    }
});

test('rules, overrides and settings refuse what the spec forbids', db(), async () => {
    const table = mount({ extensionDb: fakeExtensionDb(sqlite.openMemoryDb()) });
    const refused = [
        [`PUT ${BASE}/rules`, { rules: [{ kind: 'regex', pattern: 'x', tier: 0 }] }, 'invalid_rules'],
        [`PUT ${BASE}/rules`, { rules: [{ kind: 'name', pattern: 'x'.repeat(257), tier: 0 }] }, 'invalid_rules'],
        [`PUT ${BASE}/rules`, { rules: [{ kind: 'group', pattern: 'Domain Admins', tier: 0 }] }, 'invalid_rules'],
        [`PUT ${BASE}/rules`, { rules: [{ kind: 'name', pattern: 'x', tier: 3 }] }, 'invalid_rules'],
        [`PUT ${BASE}/settings`, { domain: 'corp.local;calc', passes: 3 }, 'invalid_domain'],
        [`PUT ${BASE}/settings`, { domain: 'corp.local', passes: 6 }, 'invalid_passes'],
        [`PUT ${BASE}/settings`, { domain: 'corp.local', passes: '3' }, 'invalid_passes']
    ];
    for (const [key, body, error] of refused) {
        const r = await call(table, key, request({ body }));
        assert.deepStrictEqual([r.status, r.body.error], [400, error], JSON.stringify(body));
    }
    const noReason = await call(table, `PUT ${BASE}/overrides/:sid`, request({ params: { sid: sid(1200) }, body: { tier: 0, reason: '  ' } }));
    assert.deepStrictEqual([noReason.status, noReason.body.error], [400, 'reason_required']);

    const ok = await call(table, `PUT ${BASE}/settings`, request({ body: { domain: '', passes: 2 } }));
    assert.deepStrictEqual(ok.body.settings, { domain: null, passes: 2 });
});
