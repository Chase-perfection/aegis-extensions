'use strict';

/**
 * One session cookie name per protected project.
 *
 * Cookies are scoped by host and not by port, and every site on a machine
 * shares one host name, so a shared cookie name made the second login replace
 * the first. The name now carries the tenant slug and the project id.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.AEGIS_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-deploy-cookies-'));

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');

const siteAuth = require('../siteAuth');
const authStore = require('../authStore');
const projectStore = require('../projectStore');

const SECRET = 'correct-horse-battery';
const GOOD_CONFIG = {
    url: 'ldap://dc01.corp.local:389',
    baseDn: 'DC=corp,DC=local',
    bindDn: 'CN=svc,DC=corp,DC=local',
    bindPassword: 'service-secret'
};
const VERDICT = { ok: true, dn: 'CN=J Doe,DC=corp,DC=local', displayName: 'J Doe', groups: [] };

function fakeReq(method, url, opts) {
    const o = opts || {};
    const req = Readable.from(o.body === undefined ? [] : [Buffer.from(o.body, 'utf8')]);
    req.method = method;
    req.url = url;
    req.headers = Object.assign({}, o.headers);
    req.socket = { remoteAddress: '10.0.0.1', encrypted: true };
    return req;
}

function fakeRes() {
    const res = { statusCode: 0, headers: {}, body: '', ended: false };
    res.writeHead = function (status, headers) {
        res.statusCode = status;
        Object.assign(res.headers, headers || {});
        return res;
    };
    res.setHeader = function (name, value) { res.headers[name] = value; };
    res.end = function (chunk) {
        if (chunk) res.body += String(chunk);
        res.ended = true;
    };
    return res;
}

/** Every Set-Cookie line of a response, as an array. */
function setCookies(res) {
    const v = res.headers['Set-Cookie'];
    return v === undefined ? [] : [].concat(v);
}

function valueOf(lines, name) {
    for (const line of lines) {
        if (line.startsWith(name + '=')) return line.slice(name.length + 1).split(';')[0];
    }
    return null;
}

function newSite(slug, projectId) {
    const tenantPaths = { root: fs.mkdtempSync(path.join(process.env.AEGIS_DATA_ROOT, slug + '-')) };
    projectStore.saveProject(tenantPaths, {
        id: projectId, port: 3081, name: projectId,
        auth: { method: 'ldap', enabled: true, allowedGroups: [] }
    });
    authStore.writeConfig(tenantPaths, GOOD_CONFIG);
    siteAuth.invalidate(slug, projectId);
    return { slug, tenantPaths, project: { id: projectId, name: projectId } };
}

function run(req, res, site) {
    return siteAuth.gate(req, res, site);
}

async function signIn(site) {
    const names = siteAuth.cookieNames(site.slug, site.project.id);
    const get = fakeRes();
    await run(fakeReq('GET', '/__aegis/login'), get, site);
    const csrf = valueOf(setCookies(get), names.csrf);
    assert.ok(csrf, 'the login form sets the project CSRF cookie');
    const body = new URLSearchParams({ csrf, username: 'jdoe', password: SECRET, next: '/' }).toString();
    const post = fakeRes();
    siteAuth._setVerifier(() => VERDICT);
    try {
        await run(fakeReq('POST', '/__aegis/login', {
            body,
            headers: {
                cookie: `${names.csrf}=${csrf}`,
                'content-type': 'application/x-www-form-urlencoded'
            }
        }), post, site);
    } finally {
        siteAuth._setVerifier(null);
    }
    const token = valueOf(setCookies(post), names.session);
    assert.ok(token, 'login issues a session cookie under the project name');
    return token;
}

async function visit(site, cookie, url) {
    const res = fakeRes();
    const handled = await run(fakeReq('GET', url || '/', { headers: cookie ? { cookie } : {} }), res, site);
    return { res, handled };
}

test('cookieNames: carries slug and project id, sanitised or hashed', () => {
    const n = siteAuth.cookieNames('corp-a', 'web_1');
    assert.strictEqual(n.session, 'aegis_site_corp-a_web_1');
    assert.strictEqual(n.csrf, 'aegis_csrf_corp-a_web_1');

    const odd = siteAuth.cookieNames('corp-a', 'we b;x=1');
    assert.match(odd.session, /^aegis_site_[0-9a-f]{16}$/);
    assert.match(odd.csrf, /^aegis_csrf_[0-9a-f]{16}$/);

    // A tenant called `csrf` must not make one project's session name another
    // project's CSRF name: the two prefixes never overlap.
    const a = siteAuth.cookieNames('csrf', 'x_y');
    const b = siteAuth.cookieNames('x', 'y');
    assert.notStrictEqual(a.session, b.csrf);
    assert.ok(!a.session.startsWith('aegis_csrf_') && !a.csrf.startsWith('aegis_site_'));

    assert.notStrictEqual(siteAuth.cookieNames('corp-a', 'web').session,
        siteAuth.cookieNames('corp-b', 'web').session, 'two tenants with one project id differ');
});

test('two protected projects on one host keep both sessions', async () => {
    const a = newSite('cookie-tenant', 'site-a');
    const b = newSite('cookie-tenant', 'site-b');
    const tokenA = await signIn(a);
    const tokenB = await signIn(b);

    const nA = siteAuth.cookieNames(a.slug, 'site-a');
    const nB = siteAuth.cookieNames(b.slug, 'site-b');
    assert.notStrictEqual(nA.session, nB.session);
    const jar = `${nA.session}=${tokenA}; ${nB.session}=${tokenB}`;

    assert.strictEqual((await visit(a, jar)).handled, false, 'A is still served after B logged in');
    assert.strictEqual((await visit(b, jar)).handled, false, 'B is served');
});

test('two tenants sharing a project id keep both sessions', async () => {
    const a = newSite('cookie-tenant-one', 'shared');
    const b = newSite('cookie-tenant-two', 'shared');
    const tokenA = await signIn(a);
    const tokenB = await signIn(b);
    const jar = `${siteAuth.cookieNames(a.slug, 'shared').session}=${tokenA}; `
        + `${siteAuth.cookieNames(b.slug, 'shared').session}=${tokenB}`;

    assert.strictEqual((await visit(a, jar)).handled, false);
    assert.strictEqual((await visit(b, jar)).handled, false);
});

test('the old shared cookie names are ignored for auth and cleared', async () => {
    const site = newSite('cookie-legacy', 'app');
    const token = await signIn(site);

    const { res, handled } = await visit(site, `aegis_site=${token}; aegis_site_csrf=x`);
    assert.strictEqual(handled, true, 'a session under the old name does not open the site');
    assert.strictEqual(res.statusCode, 302);

    const lines = setCookies(res);
    const session = lines.find((l) => l.startsWith('aegis_site='));
    const csrf = lines.find((l) => l.startsWith('aegis_site_csrf='));
    for (const line of [session, csrf]) {
        assert.ok(line, 'both old cookies are cleared');
        assert.ok(line.includes('Max-Age=0'));
        assert.ok(line.includes('Path=/'));
        assert.ok(/;\s*Secure/.test(line));
    }

    const none = await visit(site, '');
    assert.ok(!setCookies(none.res).some((l) => l.startsWith('aegis_site=')),
        'nothing is cleared when the browser holds no old cookie');
});

test('logout clears the project cookie under its own name', async () => {
    const site = newSite('cookie-logout', 'app');
    const token = await signIn(site);
    const names = siteAuth.cookieNames(site.slug, 'app');

    const { res } = await visit(site, `${names.session}=${token}`, '/__aegis/logout');
    const line = setCookies(res).find((l) => l.startsWith(names.session + '='));
    assert.ok(line && line.includes('Max-Age=0'));

    const after = await visit(site, `${names.session}=${token}`);
    assert.strictEqual(after.handled, true, 'the session is gone server side');
});

test('the login POST reads the project CSRF cookie, not the old one', async () => {
    const site = newSite('cookie-csrf', 'app');
    const names = siteAuth.cookieNames(site.slug, 'app');
    const body = new URLSearchParams({ csrf: 'abc', username: 'jdoe', password: SECRET, next: '/' }).toString();
    siteAuth._setVerifier(() => VERDICT);
    try {
        const res = fakeRes();
        await run(fakeReq('POST', '/__aegis/login', {
            body,
            headers: { cookie: 'aegis_site_csrf=abc', 'content-type': 'application/x-www-form-urlencoded' }
        }), res, site);
        assert.ok(!valueOf(setCookies(res), names.session), 'the old CSRF cookie name is not honoured');
    } finally {
        siteAuth._setVerifier(null);
    }
});

test('a preview project gets its own cookie names, apart from its parent', async () => {
    const parent = newSite('cookie-preview', 'web');
    const preview = newSite('cookie-preview', 'web-preview-1');
    const nParent = siteAuth.cookieNames(parent.slug, 'web');
    const nPreview = siteAuth.cookieNames(preview.slug, 'web-preview-1');
    assert.notStrictEqual(nParent.session, nPreview.session);
    assert.notStrictEqual(nParent.csrf, nPreview.csrf);

    // Through gate itself: the parent's session does not open the preview, and
    // the preview's login form carries the preview's CSRF name.
    const token = await signIn(parent);
    assert.strictEqual((await visit(parent, `${nParent.session}=${token}`)).handled, false);
    const other = await visit(preview, `${nParent.session}=${token}`);
    assert.strictEqual(other.handled, true);
    assert.strictEqual(other.res.statusCode, 302);

    const form = fakeRes();
    await run(fakeReq('GET', '/__aegis/login'), form, preview);
    assert.ok(setCookies(form).some((l) => l.startsWith(nPreview.csrf + '=')));
});

test('legacy clear keeps every Set-Cookie of the answer, whatever its key case', async () => {
    const http = require('http');
    const site = newSite('cookie-merge', 'app');
    const token = await signIn(site);
    const names = siteAuth.cookieNames(site.slug, 'app');

    const server = http.createServer((req, res) => {
        // The gate reads the encryption flag from the socket; this listener is
        // plain, so declare it encrypted the way a TLS socket would.
        req.socket.encrypted = true;
        Promise.resolve(siteAuth.gate(req, res, Object.assign({ viaRouterHostName: 'app.corp.local' }, site)))
            .then((handled) => {
                if (handled) return;
                // What the proxy writes: the application's cookie and the
                // release affinity cookie under a lowercase key.
                res.writeHead(200, { 'set-cookie': ['app=1', 'aegis_release=abc; Path=/'], 'Content-Length': 0 });
                res.end();
            });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        const got = await new Promise((resolve, reject) => {
            http.get({
                host: '127.0.0.1', port: server.address().port, path: '/',
                headers: { cookie: `${names.session}=${token}; aegis_site=old` }
            }, (res) => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject);
        });
        assert.strictEqual(got.statusCode, 200);
        assert.strictEqual(got.headers['strict-transport-security'], 'max-age=31536000');
        const lines = got.headers['set-cookie'] || [];
        assert.ok(lines.includes('app=1'), `application cookie kept: ${lines}`);
        assert.ok(lines.some((l) => l.startsWith('aegis_release=abc')), 'affinity cookie kept');
        assert.ok(lines.some((l) => l.startsWith('aegis_site=;') && l.includes('Max-Age=0')), 'old cookie cleared');
    } finally {
        await new Promise((r) => server.close(r));
    }
});
