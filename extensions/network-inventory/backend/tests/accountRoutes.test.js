'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const childProcess = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ni-routes-'));
process.env.AEGIS_DATA_ROOT = ROOT;

// routes.js takes execFile off child_process when it loads, so the fake goes
// in first. It records every call and answers with whatever `nextRun` says.
const calls = [];
let nextRun = { stdout: '{"ips":[],"subnets":[],"diagnostics":[]}', stderr: '', err: null };
childProcess.execFile = (file, args, options, cb) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => cb(nextRun.err, nextRun.stdout, nextRun.stderr));
    return child;
};

const scanAccount = require('../scanAccount');
const routes = require('../routes');

/** A router that keeps each handler by "METHOD path", minus the middleware. */
function fakeRouter() {
    const handlers = {};
    const add = (method) => (p, ...fns) => { handlers[method + ' ' + p] = fns[fns.length - 1]; };
    return { handlers, get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE') };
}

function call(handlers, key, { body = {}, slug = 'acme', dataDir } = {}) {
    return new Promise((resolve) => {
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(payload) { resolve({ status: this.statusCode, body: payload }); }
        };
        const req = { body, tenant: { slug }, tenantPaths: { data: dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ni-t-')) } };
        handlers[key](req, res);
    });
}

function mount(context = {}) {
    const router = fakeRouter();
    routes.register(router, {
        requireRole: () => (req, res, next) => next(),
        reauthenticate: async (req) => (req.body.password === 'aegis-ok' ? { email: 'admin@corp.local' } : null),
        ...context
    });
    return router.handlers;
}

beforeEach(() => {
    calls.length = 0;
    nextRun = { stdout: '{"ips":[],"subnets":[],"diagnostics":[]}', stderr: '', err: null };
    fs.rmSync(path.join(ROOT, 'network-inventory'), { recursive: true, force: true });
    scanAccount._failures.clear();
    scanAccount._setRunner(async () => ({ ok: true }));
});

test('GET shows the account and the service identity, never the secret', async () => {
    scanAccount.save('acme', 'CORP\\svc-scan', 'pw-get', null);
    const r = await call(mount(), 'GET /api/inventory/account');
    assert.strictEqual(r.body.account.account, 'CORP\\svc-scan');
    assert.ok(!JSON.stringify(r.body).includes('pw-get'));
    assert.ok(!('secret' in r.body.account));
    assert.strictEqual(typeof r.body.serviceIdentity, 'string');
});

test('PUT asks for the Aegis password, then the account, then Windows', async () => {
    const h = mount();
    assert.strictEqual((await call(h, 'PUT /api/inventory/account', { body: { account: 'CORP\\svc', accountPassword: 'x', password: 'no' } })).body.code, 'EREAUTH');
    assert.strictEqual((await call(h, 'PUT /api/inventory/account', { body: { account: 'svc', accountPassword: 'x', password: 'aegis-ok' } })).body.code, 'EBADACCOUNT');
    const ok = await call(h, 'PUT /api/inventory/account', { body: { account: ' CORP\\svc ', accountPassword: 'pw-put', password: 'aegis-ok' } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.account.account, 'CORP\\svc');
    assert.strictEqual(scanAccount.credentials('acme').password, 'pw-put');
});

test('PUT refuses with ECOREOLD on a core without reauthenticate, and the scan still runs', async () => {
    const h = mount({ reauthenticate: undefined });
    const r = await call(h, 'PUT /api/inventory/account', { body: { account: 'CORP\\svc', accountPassword: 'x', password: 'aegis-ok' } });
    assert.deepStrictEqual([r.status, r.body.code], [501, 'ECOREOLD']);
    const g = await call(h, 'GET /api/inventory/account');
    assert.strictEqual(g.body.canChange, false);
    const s = await call(h, 'POST /api/inventory/scan', { body: {} });
    assert.strictEqual(s.body.success, true);
});

test('refused Windows passwords lock the form at the sixth try', async () => {
    scanAccount._setRunner(async () => ({ ok: false, win32: 1326 }));
    const h = mount();
    const body = { account: 'CORP\\svc', accountPassword: 'wrong', password: 'aegis-ok' };
    for (let i = 0; i < scanAccount.LOCK_MAX; i++) {
        const r = await call(h, 'PUT /api/inventory/account', { body });
        assert.deepStrictEqual([r.status, r.body.code, r.body.reason], [400, 'EBADCRED', 'bad_password']);
    }
    const locked = await call(h, 'PUT /api/inventory/account', { body });
    assert.deepStrictEqual([locked.status, locked.body.code], [429, 'ELOCKED']);
    assert.strictEqual(scanAccount.describe('acme'), null);
});

test('DELETE goes back to the service identity, behind the Aegis password', async () => {
    scanAccount.save('acme', 'CORP\\svc', 'pw', null);
    const h = mount();
    assert.strictEqual((await call(h, 'DELETE /api/inventory/account', { body: { password: 'no' } })).body.code, 'EREAUTH');
    assert.ok(scanAccount.describe('acme'));
    const r = await call(h, 'DELETE /api/inventory/account', { body: { password: 'aegis-ok' } });
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(scanAccount.describe('acme'), null);
});

test('without an account the scan runs as the service, exactly as before', async () => {
    await call(mount(), 'POST /api/inventory/scan', { body: { domain: 'corp.local' } });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].file, 'powershell.exe');
    assert.ok(calls[0].args.includes(routes.SCRIPT_PATH));
    assert.deepStrictEqual(calls[0].args.slice(-2), ['-Domain', 'corp.local']);
    assert.strictEqual(calls[0].options.env, undefined);
});

test('with an account the scan goes through the launcher, password in env only', async () => {
    scanAccount.save('acme', 'CORP\\svc', 'pw-scan', null);
    const r = await call(mount(), 'POST /api/inventory/scan', { body: { domain: 'corp.local' } });
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].args.includes(scanAccount.LAUNCHER_PATH));
    assert.ok(!calls[0].args.some(a => String(a).includes('pw-scan')));
    assert.strictEqual(calls[0].options.env.AEGIS_SCAN_NET_SECRET, 'pw-scan');
    assert.strictEqual(calls[0].options.env.AEGIS_SCAN_NET_ACCOUNT, 'CORP\\svc');
});

test('with an account a domain that could break the command line is refused', async () => {
    scanAccount.save('acme', 'CORP\\svc', 'pw', null);
    const r = await call(mount(), 'POST /api/inventory/scan', { body: { domain: 'corp.local" -X' } });
    assert.deepStrictEqual([r.status, r.body.code], [400, 'EBADDOMAIN']);
    assert.strictEqual(calls.length, 0);
});

test('an unreadable saved password refuses the scan instead of running it as the service', async () => {
    scanAccount.save('acme', 'CORP\\svc', 'pw', null);
    fs.writeFileSync(path.join(ROOT, 'network-inventory', 'machine.key'), Buffer.alloc(32, 9));
    const r = await call(mount(), 'POST /api/inventory/scan', { body: {} });
    assert.deepStrictEqual([r.status, r.body.code], [409, 'ESCANACCOUNT']);
    assert.match(r.body.diagnostics[0].message, /CORP\\svc/);
    assert.strictEqual(calls.length, 0);
});

test('a launcher Windows refused to start reports the error and the account', async () => {
    scanAccount.save('acme', 'CORP\\svc', 'pw', null);
    nextRun = { stdout: '', stderr: 'NETONLY_ERROR:1058:The service cannot be started', err: Object.assign(new Error('exit 3'), { code: 3 }) };
    const r = await call(mount(), 'POST /api/inventory/scan', { body: {} });
    assert.strictEqual(r.status, 500);
    const d = r.body.diagnostics[0];
    assert.strictEqual(d.source, 'Compte du scan');
    assert.match(d.message, /CORP\\svc/);
    assert.match(d.hint, /seclogon/);
    assert.match(d.detail, /1058/);
});

test('the access test runs the probe as the scan account and returns its diagnostics', async () => {
    scanAccount.save('acme', 'CORP\\svc', 'pw', null);
    nextRun.stdout = 'PROGRESS:30\n{"account":"CORP\\\\svc","diagnostics":[{"source":"DHCP","status":"ok","message":"lu"}]}';
    const r = await call(mount(), 'POST /api/inventory/account/check');
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(r.body.account, 'CORP\\svc');
    assert.strictEqual(r.body.diagnostics[0].source, 'DHCP');
    assert.ok(calls[0].args.includes('-ProbeOnly'));
    assert.ok(calls[0].args.includes(scanAccount.LAUNCHER_PATH));
});
