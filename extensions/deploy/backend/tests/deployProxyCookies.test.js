/**
 * The proxy keeps Aegis's own cookies away from the applications it serves.
 *
 * Cookies are scoped by host and not by port, and every site on a machine
 * shares one host name, so a browser sends a protected site's session, and the
 * dashboard's, to every other site on that host. An application comes from a
 * repository: whatever reaches it can be logged and replayed. So the proxy
 * removes every Aegis cookie from the request it forwards, and refuses every
 * Aegis cookie an application tries to set, which would otherwise let one site
 * plant another site's CSRF token or session.
 *
 * Observed from the receiving end, with a real listener, like
 * `deployProxyIdentity.test.js`.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.AEGIS_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-deploy-proxy-cookies-'));

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Readable, Writable } = require('stream');

const siteServer = require('../siteServer');

console.warn = () => {};

function fakeReq(cookie) {
    const req = Readable.from([]);
    req.method = 'GET';
    req.url = '/';
    req.headers = cookie === undefined ? {} : { cookie };
    req.socket = { remoteAddress: '10.0.0.1', encrypted: true };
    return req;
}

function upstream(responseHeaders) {
    return new Promise((resolve) => {
        let seen = null;
        const srv = http.createServer((req, res) => {
            seen = req.headers;
            res.writeHead(200, Object.assign({ 'content-type': 'text/plain' }, responseHeaders));
            res.end('ok');
        });
        srv.listen(0, '127.0.0.1', () => resolve({
            port: srv.address().port,
            seen: () => seen,
            close: () => new Promise((done) => srv.close(done))
        }));
    });
}

function proxied(req, target) {
    return new Promise((resolve, reject) => {
        const res = new Writable({ write(chunk, enc, cb) { cb(); } });
        res.headersSent = false;
        res.headers = {};
        res.writeHead = function (status, headers) {
            res.statusCode = status;
            Object.assign(res.headers, headers || {});
            res.headersSent = true;
        };
        res.on('finish', () => resolve(res));
        res.on('error', reject);
        const timer = setTimeout(() => reject(new Error('the proxy did not answer')), 5000);
        timer.unref();
        siteServer.proxyTo(req, res, target, { slug: 't', project: { id: 'b', name: 'b' } });
    });
}

function names(setCookie) {
    return [].concat(setCookie || []).map((l) => String(l).split('=')[0].trim());
}

test('isAegisCookie: every name Aegis uses, and only those', () => {
    for (const n of ['aegis_site_t_a', 'aegis_csrf_t_a', 'aegis_site', 'aegis_site_csrf',
        'aegis_release', 'aegis.sid', 'aegis.admin.sid', 'AEGIS_SITE_X',
        '__Host-aegis_site_t_a', '__Secure-aegis.sid']) {
        assert.strictEqual(siteServer.isAegisCookie(n), true, n);
    }
    for (const n of ['session', 'connect.sid', 'theme', '__Host-app', 'myaegis', '']) {
        assert.strictEqual(siteServer.isAegisCookie(n), false, n);
    }
});

test('a sibling site receives none of the Aegis cookies, and keeps its own', async (t) => {
    const app = await upstream();
    t.after(() => app.close());
    const jar = 'theme=dark; aegis_site_t_a=SESSION-OF-A; aegis_csrf_t_a=CSRF-OF-A; '
        + 'aegis.sid=s%3Adashboard; aegis.admin.sid=s%3Aadmin; aegis_release=abc; '
        + '__Host-aegis_site_t_a=X; app_sid=42';
    await proxied(fakeReq(jar), { port: app.port });

    const got = String(app.seen().cookie || '');
    assert.strictEqual(got, 'theme=dark; app_sid=42');
});

test('a request left with no cookie forwards no Cookie header', async (t) => {
    const app = await upstream();
    t.after(() => app.close());
    await proxied(fakeReq('aegis_site_t_a=S; aegis.sid=D'), { port: app.port });
    assert.strictEqual(app.seen().cookie, undefined);
});

test('an application cannot set an Aegis cookie, and still sets its own', async (t) => {
    const app = await upstream({
        'set-cookie': [
            'aegis_csrf_t_a=planted; Path=/; HttpOnly',
            'aegis_site_t_a=planted; Path=/; HttpOnly',
            'Aegis.Sid=planted; Path=/',
            '__Host-aegis_site_t_a=planted; Path=/; Secure',
            'app_sid=42; Path=/; HttpOnly'
        ]
    });
    t.after(() => app.close());
    const res = await proxied(fakeReq(), { port: app.port });
    assert.deepStrictEqual(names(res.headers['set-cookie']), ['app_sid']);
});

test('the affinity cookie is still the proxy\'s to set', async (t) => {
    const app = await upstream({ 'set-cookie': 'aegis_release=forged; Path=/' });
    t.after(() => app.close());
    const res = await proxied(fakeReq(), { port: app.port, sha: 'a'.repeat(40) });
    const lines = [].concat(res.headers['set-cookie'] || []);
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], new RegExp(`^${siteServer.RELEASE_COOKIE}=a{40}`));
});
