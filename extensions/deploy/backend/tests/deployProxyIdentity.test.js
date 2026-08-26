/**
 * Tests for the identity a protected site's proxy passes to the application.
 *
 * The question these answer is not "does the guard work" -- `siteAuth.test.js`
 * owns that -- but "does what the guard learned reach the process behind it,
 * and can a visitor forge it". Both halves are observable only from the
 * receiving end, so every test here starts a real listener that records the
 * headers it was handed and proxies a real request into it. Asserting on the
 * bag `proxyTo` builds would prove nothing about what Node agrees to send: the
 * encoding exists precisely because Node refuses some values.
 *
 * `AEGIS_DATA_ROOT` is set before anything is required, so `machineStore`
 * creates its encryption key in a temporary folder instead of
 * C:\ProgramData\Aegis. Without it these tests would write to the machine.
 *
 * `ldap.js` opens sockets to a domain controller, so nothing here touches it:
 * `siteAuth._setVerifier` answers the login from a table.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-deploy-identity-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Readable, Writable } = require('stream');

const siteAuth = require('../siteAuth');
const authStore = require('../authStore');
const projectStore = require('../projectStore');
const siteServer = require('../siteServer');

// The guard logs refusals and logins on purpose. Muted so a passing run is
// readable; a failing assertion still reports everything that matters.
console.log = () => {};
console.warn = () => {};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const SECRET = 'correct-horse-battery';
const GOOD_CONFIG = {
    url: 'ldap://dc01.corp.local:389',
    baseDn: 'DC=corp,DC=local',
    bindDn: 'CN=svc,DC=corp,DC=local',
    bindPassword: 'service-secret'
};

function newTenant() {
    return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-tenant-')) };
}

function fakeReq(method, url, opts) {
    const o = opts || {};
    const req = Readable.from(o.body === undefined ? [] : [Buffer.from(o.body, 'utf8')]);
    req.method = method;
    req.url = url;
    req.headers = Object.assign({}, o.headers);
    req.socket = { remoteAddress: o.ip || '10.0.0.1' };
    if (o.secure) req.socket.encrypted = true;
    return req;
}

function fakeRes() {
    const res = { statusCode: 0, headers: {}, body: '', ended: false, headersSent: false };
    res.writeHead = function (status, headers) {
        res.statusCode = status;
        Object.assign(res.headers, headers || {});
        res.headersSent = true;
        return res;
    };
    res.end = function (chunk) {
        if (chunk) res.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        res.ended = true;
    };
    return res;
}

function cookieValue(setCookie, name) {
    const m = new RegExp(`(?:^|; )?${name}=([^;]*)`).exec(String(setCookie || ''));
    return m ? m[1] : null;
}

function seed(slug, projectId, project, config) {
    const tenantPaths = newTenant();
    projectStore.saveProject(tenantPaths, Object.assign({ id: projectId, port: 3081 }, project));
    if (config) authStore.writeConfig(tenantPaths, config);
    siteAuth.invalidate(slug, projectId);
    return tenantPaths;
}

function ctxFor(slug, tenantPaths, projectId) {
    return {
        slug,
        tenantPaths,
        project: { id: projectId, name: projectId },
        runtime: 'node',
        root: DATA_ROOT
    };
}

/** Logs in and returns the session cookie, with the directory answering `result`. */
async function loginToken(slug, tenantPaths, projectId, result) {
    siteAuth._setVerifier(() => result);
    try {
        const get = fakeRes();
        await siteAuth.gate(fakeReq('GET', '/__aegis/login'), get, ctxFor(slug, tenantPaths, projectId));
        const csrf = cookieValue(get.headers['Set-Cookie'], 'aegis_site_csrf');

        const body = new URLSearchParams({
            csrf, username: 'alice', password: SECRET, next: '/'
        }).toString();
        const res = fakeRes();
        await siteAuth.gate(fakeReq('POST', '/__aegis/login', {
            body,
            ip: '10.0.0.9',
            headers: {
                cookie: `aegis_site_csrf=${csrf}`,
                'content-type': 'application/x-www-form-urlencoded'
            }
        }), res, ctxFor(slug, tenantPaths, projectId));

        const token = cookieValue(res.headers['Set-Cookie'], 'aegis_site');
        assert.ok(token, 'the login should have minted a session');
        return token;
    } finally {
        siteAuth._setVerifier(null);
    }
}

/**
 * A listener standing in for the application behind a site. It records the
 * headers of the last request it answered, which is the only thing under test.
 */
function upstream() {
    return new Promise((resolve) => {
        let seen = null;
        const srv = http.createServer((req, res) => {
            seen = req.headers;
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('ok');
        });
        srv.listen(0, '127.0.0.1', () => {
            resolve({
                port: srv.address().port,
                seen: () => seen,
                close: () => new Promise((done) => srv.close(done))
            });
        });
    });
}

/** Runs one request through the real `proxyTo` and resolves once it is answered. */
function proxied(req, port, ctx) {
    return new Promise((resolve, reject) => {
        const res = new Writable({ write(chunk, enc, cb) { cb(); } });
        res.headersSent = false;
        res.writeHead = function (status) { res.statusCode = status; res.headersSent = true; };
        res.on('finish', resolve);
        res.on('error', reject);
        const timer = setTimeout(() => reject(new Error('the proxy did not answer')), 5000);
        timer.unref();
        siteServer.proxyTo(req, res, port, ctx);
    });
}

/* ------------------------------------------------------------------ */
/* a protected site: the visitor is named                              */
/* ------------------------------------------------------------------ */

test('protected site: the three identity headers arrive', async (t) => {
    const slug = 'tenant-id';
    const tenantPaths = seed(slug, 'named',
        { name: 'Named', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const token = await loginToken(slug, tenantPaths, 'named',
        { ok: true, displayName: 'Alice Martin', groups: ['CN=Viewers,DC=corp,DC=local'] });
    const app = await upstream();
    t.after(async () => { await app.close(); siteAuth.dropSessions(slug, 'named'); });

    await proxied(fakeReq('GET', '/', { headers: { cookie: `aegis_site=${token}` } }),
        app.port, ctxFor(slug, tenantPaths, 'named'));

    const seen = app.seen();
    assert.strictEqual(seen['x-aegis-user'], 'alice');
    assert.strictEqual(decodeURIComponent(seen['x-aegis-name']), 'Alice Martin');
    assert.strictEqual(seen['x-aegis-groups'], encodeURIComponent('CN=Viewers,DC=corp,DC=local'));
});

test('protected site: a plain account name is not mangled by the encoding', async (t) => {
    const slug = 'tenant-plain';
    const tenantPaths = seed(slug, 'plain',
        { name: 'Plain', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const token = await loginToken(slug, tenantPaths, 'plain', { ok: true, groups: [] });
    const app = await upstream();
    t.after(async () => { await app.close(); siteAuth.dropSessions(slug, 'plain'); });

    await proxied(fakeReq('GET', '/', { headers: { cookie: `aegis_site=${token}` } }),
        app.port, ctxFor(slug, tenantPaths, 'plain'));

    // The common case, and the one an operator reads in a log.
    assert.strictEqual(app.seen()['x-aegis-user'], 'alice');
    // No display name from the directory: the account name stands in, so the
    // header never arrives empty.
    assert.strictEqual(app.seen()['x-aegis-name'], 'alice');
    assert.strictEqual(app.seen()['x-aegis-groups'], '');
});

/* ------------------------------------------------------------------ */
/* forgery                                                             */
/* ------------------------------------------------------------------ */

test('forgery: what the client sent is replaced, not appended to', async (t) => {
    const slug = 'tenant-forge';
    const tenantPaths = seed(slug, 'forge',
        { name: 'Forge', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const token = await loginToken(slug, tenantPaths, 'forge',
        { ok: true, displayName: 'Alice Martin', groups: ['CN=Viewers,DC=corp,DC=local'] });
    const app = await upstream();
    t.after(async () => { await app.close(); siteAuth.dropSessions(slug, 'forge'); });

    await proxied(fakeReq('GET', '/', {
        headers: {
            cookie: `aegis_site=${token}`,
            'x-aegis-user': 'administrateur',
            'X-Aegis-Groups': 'CN=Domain Admins,DC=corp,DC=local'
        }
    }), app.port, ctxFor(slug, tenantPaths, 'forge'));

    const seen = app.seen();
    assert.strictEqual(seen['x-aegis-user'], 'alice');
    assert.ok(!String(seen['x-aegis-user']).includes('administrateur'));
    assert.ok(!String(seen['x-aegis-groups']).includes('Domain Admins'));
});

test('forgery: an unprotected site receives none of the three', async (t) => {
    const slug = 'tenant-open';
    const tenantPaths = seed(slug, 'open', { name: 'Open' });
    const app = await upstream();
    t.after(async () => { await app.close(); });

    await proxied(fakeReq('GET', '/', {
        headers: {
            'x-aegis-user': 'administrateur',
            'x-aegis-name': 'Someone Important',
            'x-aegis-groups': 'CN=Domain Admins,DC=corp,DC=local'
        }
    }), app.port, ctxFor(slug, tenantPaths, 'open'));

    const seen = app.seen();
    // Absent, not empty. A site with no gate authenticated nobody, and an empty
    // header an application could read as a user is the trap being avoided.
    for (const name of ['x-aegis-user', 'x-aegis-name', 'x-aegis-groups']) {
        assert.strictEqual(seen[name], undefined, `${name} should not have arrived`);
    }
});

test('forgery: a session for another project does not name the visitor', async (t) => {
    const slug = 'tenant-cross';
    const tenantPaths = seed(slug, 'first',
        { name: 'First', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    projectStore.saveProject(tenantPaths,
        { id: 'second', port: 3082, name: 'Second', auth: { enabled: true, allowedGroups: [] } });
    siteAuth.invalidate(slug, 'second');

    const token = await loginToken(slug, tenantPaths, 'first', { ok: true, groups: [] });
    const app = await upstream();
    t.after(async () => {
        await app.close();
        siteAuth.dropSessions(slug, 'first');
        siteAuth.dropSessions(slug, 'second');
    });

    // Cookies are scoped by host and not by port, so this token really does
    // reach the second site's proxy. It is a valid token and still not a
    // session here.
    await proxied(fakeReq('GET', '/', { headers: { cookie: `aegis_site=${token}` } }),
        app.port, ctxFor(slug, tenantPaths, 'second'));

    assert.strictEqual(app.seen()['x-aegis-user'], undefined);
});

/* ------------------------------------------------------------------ */
/* what the directory can put in a name                                */
/* ------------------------------------------------------------------ */

test('groups arrive in the order the session carries them', async (t) => {
    const slug = 'tenant-order';
    const order = ['CN=Alpha,DC=corp,DC=local', 'CN=Beta,DC=corp,DC=local', 'CN=Gamma,DC=corp,DC=local'];
    const tenantPaths = seed(slug, 'order',
        { name: 'Order', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const token = await loginToken(slug, tenantPaths, 'order', { ok: true, groups: order });
    const app = await upstream();
    t.after(async () => { await app.close(); siteAuth.dropSessions(slug, 'order'); });

    await proxied(fakeReq('GET', '/', { headers: { cookie: `aegis_site=${token}` } }),
        app.port, ctxFor(slug, tenantPaths, 'order'));

    const got = String(app.seen()['x-aegis-groups']).split(',').map(decodeURIComponent);
    assert.deepStrictEqual(got, order);
});

test('a group holding a comma cannot be read as two groups', async (t) => {
    const slug = 'tenant-comma';
    const groups = ['CN=Direction, Finance,DC=corp,DC=local', 'CN=Beta,DC=corp,DC=local'];
    const tenantPaths = seed(slug, 'comma',
        { name: 'Comma', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const token = await loginToken(slug, tenantPaths, 'comma', { ok: true, groups });
    const app = await upstream();
    t.after(async () => { await app.close(); siteAuth.dropSessions(slug, 'comma'); });

    await proxied(fakeReq('GET', '/', { headers: { cookie: `aegis_site=${token}` } }),
        app.port, ctxFor(slug, tenantPaths, 'comma'));

    const got = String(app.seen()['x-aegis-groups']).split(',').map(decodeURIComponent);
    assert.strictEqual(got.length, 2, 'a comma inside a name must not split it');
    assert.deepStrictEqual(got, groups);
});

test('an accented display name is carried, and does not fail the request', async (t) => {
    const slug = 'tenant-accent';
    const tenantPaths = seed(slug, 'accent',
        { name: 'Accent', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    // Latin-1 would carry the first of these and throw on the second. This is
    // the case that would otherwise 502 one person on every page they open.
    const token = await loginToken(slug, tenantPaths, 'accent',
        { ok: true, displayName: 'Paul Vué Даниил', groups: [] });
    const app = await upstream();
    t.after(async () => { await app.close(); siteAuth.dropSessions(slug, 'accent'); });

    await proxied(fakeReq('GET', '/', { headers: { cookie: `aegis_site=${token}` } }),
        app.port, ctxFor(slug, tenantPaths, 'accent'));

    assert.strictEqual(decodeURIComponent(app.seen()['x-aegis-name']), 'Paul Vué Даниил');
});

test('a newline in a directory value cannot inject a header', async (t) => {
    const slug = 'tenant-inject';
    const tenantPaths = seed(slug, 'inject',
        { name: 'Inject', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const token = await loginToken(slug, tenantPaths, 'inject',
        { ok: true, displayName: 'Alice\r\nX-Aegis-Admin: yes', groups: [] });
    const app = await upstream();
    t.after(async () => { await app.close(); siteAuth.dropSessions(slug, 'inject'); });

    await proxied(fakeReq('GET', '/', { headers: { cookie: `aegis_site=${token}` } }),
        app.port, ctxFor(slug, tenantPaths, 'inject'));

    const seen = app.seen();
    assert.strictEqual(seen['x-aegis-admin'], undefined, 'no header should have been injected');
    assert.ok(!String(seen['x-aegis-name']).includes('\n'));
    assert.strictEqual(decodeURIComponent(seen['x-aegis-name']), 'Alice\r\nX-Aegis-Admin: yes');
});

/* ------------------------------------------------------------------ */
/* the pieces on their own                                             */
/* ------------------------------------------------------------------ */

test('stripIdentity removes every case a client might send', () => {
    const headers = {
        'X-Aegis-User': 'a', 'x-aegis-name': 'b', 'X-AEGIS-GROUPS': 'c',
        'x-forwarded-for': 'keep', 'cookie': 'keep'
    };
    siteServer.stripIdentity(headers);
    assert.deepStrictEqual(Object.keys(headers).sort(), ['cookie', 'x-forwarded-for']);
});

test('encodeIdentity answers a string for the values that have no text', () => {
    assert.strictEqual(siteServer.encodeIdentity(null), '');
    assert.strictEqual(siteServer.encodeIdentity(undefined), '');
    // A lone surrogate: encodeURIComponent throws on it, and a throw here would
    // land inside a request the visitor cannot retry differently.
    assert.strictEqual(siteServer.encodeIdentity('\uD800'), '');
});
