/**
 * The tenant's authority on domain machines: distribution by GPO through
 * core's `trustedRoot` capability, and the rotation that waits for it.
 *
 * Core is faked: `publish` records what it was asked and `status` answers what
 * the test says the agent answered. No express and no network: `register` is
 * handed a recording router, as in authMethodRoute.test.js.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-deploy-cadist-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;
process.env.AEGIS_DEPLOY_ENABLED = '1';
process.env.AEGIS_DEPLOY_POLL_MS = '0';

const test = require('node:test');
const assert = require('node:assert');

const routes = require('../routes');
const ssc = require('../selfSignedCert');
const dist = require('../caDistribution');
const certMaintenance = require('../certMaintenance');
const projectStore = require('../projectStore');

console.log = () => { };
console.error = () => { };

const TENANTS_ROOT = path.join(DATA_ROOT, 'tenants');
fs.mkdirSync(TENANTS_ROOT, { recursive: true });
const pathsFor = (slug) => { const root = path.join(TENANTS_ROOT, slug); return { root, deploy: path.join(root, 'deploy') }; };
const noProtect = { protectKey: () => { } };
const DAY = 86400000;
const YEAR = 365 * DAY;

/** A fake of core's seam: every publish is queued, the test decides the answer. */
function fakeCore() {
    const runs = [];
    return {
        runs,
        publish: async (slug, args) => {
            const pending = runs.find((r) => r.slug === slug && r.answer === null);
            if (pending) return { status: 'pending', runId: pending.runId, host: 'dc01.corp.local' };
            const runId = `gpo-${Date.now()}-${String(runs.length).padStart(8, '0')}`;
            runs.push({ slug, runId, args, answer: null });
            return { status: 'queued', runId, host: 'dc01.corp.local', gpoName: 'SEC-TrustedRoot-DeployCA' };
        },
        status: (slug, runId) => {
            const r = runs.find((x) => x.runId === runId);
            if (!r) return { status: 'unknown' };
            return r.answer || { status: 'queued' };
        },
        answer(status, message) { runs[runs.length - 1].answer = { status, message }; }
    };
}

function tenant(slug) {
    const tp = pathsFor(slug);
    fs.mkdirSync(tp.deploy, { recursive: true });
    return tp;
}

test('off by default: nothing is published, and the rotation counts from when the successor was made', async () => {
    const tp = tenant('off');
    const core = fakeCore();
    ssc.maintainCa(tp, noProtect);
    const v = await dist.publish('off', tp, core);
    assert.strictEqual(v.enabled, false);
    assert.strictEqual(core.runs.length, 0);
    assert.strictEqual(dist.overlapSince(tp), undefined);
});

test('on: the bundle is published, confirmed when the agent answers, and not sent again while unchanged', async () => {
    const tp = tenant('on');
    const core = fakeCore();
    ssc.maintainCa(tp, noProtect);
    dist.setEnabled(tp, true, 'ops@corp.local');
    let v = await dist.publish('on', tp, core, { force: true });
    assert.strictEqual(v.status, 'queued');
    assert.strictEqual(core.runs.length, 1);
    assert.strictEqual(core.runs[0].args.topic, 'DeployCA');
    assert.strictEqual(core.runs[0].args.certificates.length, 1);
    const current = ssc.trustBundle(tp)[0].thumbprint;
    assert.strictEqual(core.runs[0].args.certificates[0].thumbprint, current);

    // While queued, a second publish waits.
    await dist.publish('on', tp, core);
    assert.strictEqual(core.runs.length, 1);

    core.answer('done');
    v = await dist.publish('on', tp, core);
    assert.strictEqual(v.status, 'done');
    assert.deepStrictEqual(v.published, [current]);
    assert.ok(v.confirmed[current]);
    assert.strictEqual(core.runs.length, 1, 'unchanged and fresh: not sent again');

    // A week later it is sent again, to repair a GPO edited by hand.
    await dist.publish('on', tp, core, { now: Date.now() + 8 * DAY });
    assert.strictEqual(core.runs.length, 2);
});

test('a failed or lost run is reported and retried', async () => {
    const tp = tenant('fail');
    const core = fakeCore();
    ssc.maintainCa(tp, noProtect);
    dist.setEnabled(tp, true);
    await dist.publish('fail', tp, core, { force: true });
    core.answer('failed', 'RESULT: failure [GPO_FOREIGN_NAME] - the GPO SEC-TrustedRoot-DeployCA was not created by Aegis');
    const v = dist.view(tp, core);
    assert.strictEqual(dist.refresh('fail', tp, core).lastStatus, 'failed');
    assert.match(dist.view(tp, core).message, /GPO_FOREIGN_NAME/);
    assert.ok(v);
    await dist.publish('fail', tp, core);
    assert.strictEqual(core.runs.length, 2, 'retried at the next pass');
});

test('rotation with distribution on: the successor is published, and signs only 30 days after it was confirmed', async () => {
    const tp = tenant('rot');
    const core = fakeCore();
    const t0 = Date.now();
    const a = ssc.maintainCa(tp, Object.assign({ now: t0 }, noProtect)).current;
    dist.setEnabled(tp, true);
    await dist.publish('rot', tp, core, { force: true, now: t0 });
    core.answer('done');

    // Two years before the end: the successor is made and published beside it.
    const tPrep = t0 + 8.1 * YEAR;
    const p = ssc.maintainCa(tp, Object.assign({ now: tPrep, overlapSince: dist.overlapSince(tp) }, noProtect));
    assert.strictEqual(p.prepared, true);
    await dist.publish('rot', tp, core, { now: tPrep, force: true });
    const sent = core.runs[core.runs.length - 1].args.certificates.map((c) => c.thumbprint);
    assert.deepStrictEqual(sent, ssc.trustBundle(tp, tPrep).map((c) => c.thumbprint));
    assert.strictEqual(sent.length, 2);

    // A year before the end, but the GPO run never came back: no switch.
    const tLate = t0 + 9.1 * YEAR;
    let s = ssc.maintainCa(tp, Object.assign({ now: tLate, overlapSince: dist.overlapSince(tp) }, noProtect));
    assert.strictEqual(s.switched, false);
    assert.strictEqual(s.current.cert, a.cert);

    // Confirmed now: still 30 days to wait.
    core.answer('done');
    dist.refresh('rot', tp, core, tLate);
    s = ssc.maintainCa(tp, Object.assign({ now: tLate + 10 * DAY, overlapSince: dist.overlapSince(tp) }, noProtect));
    assert.strictEqual(s.switched, false);
    s = ssc.maintainCa(tp, Object.assign({ now: tLate + 31 * DAY, overlapSince: dist.overlapSince(tp) }, noProtect));
    assert.strictEqual(s.switched, true);

    // The next publish keeps the retired one for its 30 days, then forgets it.
    const tSw = tLate + 31 * DAY;
    await dist.publish('rot', tp, core, { now: tSw, force: true });
    assert.deepStrictEqual(core.runs[core.runs.length - 1].args.certificates.map((c) => c.thumbprint).length, 2);
    core.answer('done');
    dist.refresh('rot', tp, core, tSw);
    ssc.maintainCa(tp, Object.assign({ now: tSw + 31 * DAY }, noProtect));
    await dist.publish('rot', tp, core, { now: tSw + 31 * DAY });
    const last = core.runs[core.runs.length - 1].args;
    assert.strictEqual(last.certificates.length, 1);
    assert.strictEqual(last.forget.length, 1, 'the retired authority is named for removal');
});

test('a site certificate needs no restart while its authority is valid, and is renewed after a switch', async () => {
    const slug = 'sweep';
    const tp = tenant(slug);
    const project = { id: 'site-a', name: 'site-a', tls: { enabled: false } };
    projectStore.saveProject(tp, project);
    ssc.ensureFor(tp, project, Object.assign({ want: true, save: (p) => projectStore.saveProject(tp, p) }, noProtect));
    const restarted = [];
    const restartSite = async ({ project: p }) => {
        restarted.push(p.id);
        ssc.ensureFor(tp, p, Object.assign({ save: (x) => projectStore.saveProject(tp, x) }, noProtect));
    };
    await certMaintenance.maintainTenant({ slug, tenantPaths: tp, restartSite });
    assert.deepStrictEqual(restarted, []);
    await certMaintenance.maintainTenant({ slug, tenantPaths: tp, restartSite, action: 'prepare' });
    await certMaintenance.maintainTenant({ slug, tenantPaths: tp, restartSite, action: 'switch' });
    assert.deepStrictEqual(restarted, ['site-a']);
    const ca = ssc.maintainCa(tp, noProtect).current.cert;
    assert.strictEqual(ssc.needsRenewal(projectStore.getProject(tp, 'site-a').tls.certFile, ca), false);
});

/* ---------- routes ---------- */

const core = fakeCore();
let passwordOk = true;
const table = new Map();
{
    const add = (method) => (p, ...chain) => table.set(`${method} ${p}`, chain);
    routes.register({ get: add('GET'), post: add('POST'), delete: add('DELETE'), put: add('PUT'), patch: add('PATCH') }, {
        requireRole: (role) => (req, res, next) => (req.user && req.user.role === role ? next() : res.status(403).json({ success: false })),
        pathsFor,
        tenantsRoot: () => TENANTS_ROOT,
        reauthenticate: async () => (passwordOk ? { email: 'ops@corp.local' } : null),
        trustedRoot: core
    });
}

function call(key, body) {
    const chain = table.get(key);
    assert.ok(chain, `${key} is not mounted`);
    const req = { body, query: {}, params: {}, tenant: { slug: 'routes' }, tenantPaths: tenant('routes'), user: { email: 'ops@corp.local', role: 'admin' }, get: () => 'aegis.test' };
    return new Promise((resolve, reject) => {
        const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
        let i = 0;
        const next = () => { const h = chain[i++]; if (!h) return reject(new Error('no answer')); return Promise.resolve(h(req, res, next)).catch(reject); };
        next();
    });
}

test('routes: turning distribution on needs the password, makes the authority and queues the GPO', async () => {
    passwordOk = false;
    let r = await call('POST /api/deploy/ca/distribution', { enabled: true, password: 'x' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(core.runs.length, 0);
    passwordOk = true;
    r = await call('POST /api/deploy/ca/distribution', { enabled: 'yes' });
    assert.strictEqual(r.status, 400);
    r = await call('POST /api/deploy/ca/distribution', { enabled: true, password: 'x' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ca.enabled, true);
    assert.strictEqual(r.body.ca.status, 'queued');
    assert.strictEqual(r.body.ca.authorities.length, 1);
    assert.strictEqual(r.body.ca.authorities[0].der, undefined, 'the view carries no certificate bytes');
    core.answer('done');
    r = await call('GET /api/deploy/ca');
    assert.strictEqual(r.body.ca.status, 'done');
});

test('routes: rotate prepares, refuses a bad action, and switches with the password', async () => {
    let r = await call('POST /api/deploy/ca/rotate', { action: 'nope', password: 'x' });
    assert.strictEqual(r.status, 400);
    r = await call('POST /api/deploy/ca/rotate', { action: 'prepare', password: 'x' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.ca.authorities.map((a) => a.role), ['current', 'next']);
    core.answer('done');
    r = await call('POST /api/deploy/ca/rotate', { action: 'switch', password: 'x' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.ca.authorities.map((a) => a.role), ['current', 'previous']);
    r = await call('POST /api/deploy/ca/rotate', { action: 'switch', password: 'x' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, 'no_next');
});
