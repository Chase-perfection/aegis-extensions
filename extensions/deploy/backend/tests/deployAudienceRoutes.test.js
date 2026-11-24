/**
 * The dashboard's two audience routes: the report of a period, and the erase.
 *
 * Same shape as deployProjectPatch.test.js: `register` is handed a router that
 * records its handlers, and one is called with a request built here. The role
 * check is a stand-in that refuses a non-admin where the route asks for admin,
 * so the test says which route asks for what.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-audience-routes-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;
process.env.AEGIS_DEPLOY_ENABLED = '1';
process.env.AEGIS_DEPLOY_POLL_MS = '0';

const test = require('node:test');
const assert = require('node:assert');

const routes = require('../routes');
const projectStore = require('../projectStore');
const audienceStore = require('../audienceStore');
const audience = require('../audience');

console.log = () => {};
console.warn = () => {};

const TENANTS_ROOT = path.join(DATA_ROOT, 'tenants');
fs.mkdirSync(TENANTS_ROOT, { recursive: true });
const SLUG = 'dt-plain';

function pathsFor(slug) {
    const root = path.join(TENANTS_ROOT, slug);
    return { root, deploy: path.join(root, 'deploy') };
}

const table = new Map();
const add = (method) => (routePath, ...chain) => table.set(`${method} ${routePath}`, chain);
routes.register({ get: add('GET'), post: add('POST'), delete: add('DELETE'), put: add('PUT'), patch: add('PATCH') }, {
    requireRole: (role) => (req, res, next) => (role === 'admin' && req.user.role !== 'admin'
        ? res.status(403).json({ success: false, error: 'forbidden' })
        : next()),
    pathsFor,
    tenantsRoot: () => TENANTS_ROOT
});

function call(key, req) {
    const chain = table.get(key);
    assert.ok(chain, `${key} is not mounted`);
    return new Promise((resolve, reject) => {
        const res = {
            statusCode: 200,
            headers: {},
            setHeader(k, v) { this.headers[k] = v; },
            status(code) { this.statusCode = code; return this; },
            json(body) { resolve({ status: this.statusCode, body }); return this; }
        };
        let i = 0;
        const next = () => {
            const handler = chain[i++];
            if (!handler) return reject(new Error(`${key} answered nothing`));
            return Promise.resolve(handler(req, res, next)).catch(reject);
        };
        next();
    });
}

function req(query, role, id) {
    return {
        body: {}, query: query || {}, params: { id: id || 'stock' },
        tenant: { slug: SLUG }, tenantPaths: pathsFor(SLUG),
        user: { email: 'ops@corp.local', role: role || 'viewer' }
    };
}

const today = audience.localDay(Date.now());
const tp = pathsFor(SLUG);
fs.mkdirSync(tp.root, { recursive: true });
projectStore.saveProject(tp, { id: 'stock', port: 3081, name: 'Stock', audience: { enabled: true } });

test('report defaults to the last 30 days', async () => {
    await audienceStore.append(tp, 'stock', [{ t: Date.now(), vis: 'a1b2c3d4e5f60718', k: 'view', pv: 'pv000001', p: '/stock' }]);
    const res = await call('GET /api/deploy/projects/:id/audience', req());
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.to, today);
    assert.strictEqual(res.body.from, audienceStore.addDays(today, -29));
    assert.strictEqual(res.body.series.length, 30);
    assert.strictEqual(res.body.enabled, true);
    assert.strictEqual(res.body.totals.visitors, 1);
});

test('a viewer role reads the report', async () => {
    const res = await call('GET /api/deploy/projects/:id/audience', req({}, 'viewer'));
    assert.strictEqual(res.status, 200);
});

test('the report never contains a vis value', async () => {
    const res = await call('GET /api/deploy/projects/:id/audience', req());
    assert.ok(!JSON.stringify(res.body).includes('a1b2c3d4e5f60718'));
});

test('from after to, a 761 day period, a future to, or an impossible date is bad_period', async () => {
    const bad = [
        { from: today, to: audienceStore.addDays(today, -1) },
        { from: audienceStore.addDays(today, -761), to: today },
        { from: today, to: audienceStore.addDays(today, 1) },
        { from: '2026-02-30', to: today },
        { from: 'yesterday', to: today }
    ];
    for (const q of bad) {
        const res = await call('GET /api/deploy/projects/:id/audience', req(q));
        assert.strictEqual(res.status, 400, JSON.stringify(q));
        assert.strictEqual(res.body.error, 'bad_period');
    }
});

test('an unknown project is 404', async () => {
    const res = await call('GET /api/deploy/projects/:id/audience', req({}, 'viewer', 'nope'));
    assert.strictEqual(res.status, 404);
});

test('DELETE needs admin and empties the folder', async () => {
    await audienceStore.append(tp, 'stock', [{ t: Date.now(), vis: 'a1b2c3d4e5f60718', k: 'view', pv: 'pv000002', p: '/' }]);
    const refused = await call('DELETE /api/deploy/projects/:id/audience', req({}, 'viewer'));
    assert.strictEqual(refused.status, 403);
    assert.ok(fs.existsSync(audienceStore.dirFor(tp, 'stock')));
    const done = await call('DELETE /api/deploy/projects/:id/audience', req({}, 'admin'));
    assert.strictEqual(done.status, 200);
    assert.ok(!fs.existsSync(audienceStore.dirFor(tp, 'stock')));
});

test('deleting the project removes its audience folder', async () => {
    projectStore.saveProject(tp, { id: 'wiki', port: 3082, name: 'Wiki', audience: { enabled: true } });
    await audienceStore.append(tp, 'wiki', [{ t: Date.now(), vis: 'a1b2c3d4e5f60718', k: 'view', pv: 'pv000003', p: '/' }]);
    const res = await call('DELETE /api/deploy/projects/:id', req({}, 'admin', 'wiki'));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(!fs.existsSync(audienceStore.dirFor(tp, 'wiki')));
});

test('the hourly pass closes and purges every project with audience data', () => {
    const dir = audienceStore.dirFor(tp, 'stock');
    fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
    const yesterday = audienceStore.addDays(today, -1);
    const old = audienceStore.addDays(today, -120);
    fs.writeFileSync(path.join(dir, 'raw', yesterday + '.jsonl'),
        JSON.stringify({ t: audienceStore.parseDay(yesterday).getTime() + 3600000, vis: 'a1b2c3d4e5f60718', k: 'view', pv: 'pv000009', p: '/' }) + '\n');
    fs.writeFileSync(path.join(dir, 'raw', old + '.jsonl'), '');
    routes._audiencePass(today);
    assert.ok(fs.existsSync(path.join(dir, 'days', yesterday + '.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'raw', old + '.jsonl')));
});
