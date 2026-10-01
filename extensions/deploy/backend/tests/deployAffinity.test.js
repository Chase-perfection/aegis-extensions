/**
 * Version affinity at the proxy: the cookie, the header, and the release routes.
 *
 * runtime.js keeps the outgoing version for its visitors; this is how the proxy
 * recognises them. The cookie names the commit that served the visitor, the
 * `X-Aegis-Release` header tells the page which version answered, and
 * `/__aegis/release` lets the page offer the newer one. Each is a promise a
 * page relies on to tell a person "a new version is here" instead of changing
 * the code under them.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.AEGIS_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-deploy-affinity-'));
process.env.AEGIS_RUNTIME_PORT_BASE = process.env.AEGIS_TEST_RUNTIME_PORT_BASE_AFFINITY || '47600';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Readable, Writable } = require('stream');
const { EventEmitter } = require('events');

const siteAuth = require('../siteAuth');
const siteServer = require('../siteServer');
const runtime = require('../runtime');

console.log = () => {};
console.warn = () => {};

function fakeReq(method, url, headers) {
    const req = Readable.from([]);
    req.method = method;
    req.url = url;
    req.headers = Object.assign({}, headers);
    req.socket = { remoteAddress: '10.0.0.1' };
    return req;
}

/** Resolves with the response once `serve` or `proxyTo` has finished it. */
function answer(run) {
    return new Promise((resolve, reject) => {
        const res = new Writable({ write(chunk, enc, cb) { res.body += chunk; cb(); } });
        res.body = '';
        res.headersSent = false;
        res.headers = {};
        res.writeHead = function (status, headers) {
            res.statusCode = status;
            Object.assign(res.headers, headers || {});
            res.headersSent = true;
        };
        const end = res.end.bind(res);
        res.end = function (chunk) { if (chunk) res.body += chunk; return end(); };
        res.on('finish', () => resolve(res));
        res.on('error', reject);
        const timer = setTimeout(() => reject(new Error('no answer')), 5000);
        timer.unref();
        run(res);
    });
}

function upstream(extraHeaders) {
    return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
            res.writeHead(200, Object.assign({ 'content-type': 'text/plain' }, extraHeaders));
            res.end('ok');
        });
        srv.listen(0, '127.0.0.1', () => resolve({
            port: srv.address().port,
            close: () => new Promise((done) => srv.close(done))
        }));
    });
}

const CTX = { slug: 'aff', project: { id: 'app', name: 'App' }, runtime: 'node' };

test('the proxy names the version that answered and sets the affinity cookie', async () => {
    const up = await upstream({ 'set-cookie': 'app_session=1; Path=/' });
    try {
        const res = await answer((r) => siteServer.proxyTo(
            fakeReq('GET', '/'), r, { port: up.port, proxyKey: 'k', sha: 'aaaaaaa' }, CTX));
        assert.strictEqual(res.headers['X-Aegis-Release'], 'aaaaaaa');
        const cookies = [].concat(res.headers['set-cookie']);
        assert.ok(cookies.includes('app_session=1; Path=/'), 'the application cookie was lost');
        assert.ok(cookies.some((c) => /^aegis_release=aaaaaaa; Path=\/; HttpOnly; SameSite=Lax$/.test(c)),
            'no affinity cookie');
    } finally {
        await up.close();
    }
});

test('a visitor whose cookie already names the version is not sent it again', async () => {
    const up = await upstream({});
    try {
        const res = await answer((r) => siteServer.proxyTo(
            fakeReq('GET', '/', { cookie: 'aegis_release=aaaaaaa' }), r,
            { port: up.port, proxyKey: 'k', sha: 'aaaaaaa' }, CTX));
        assert.strictEqual(res.headers['set-cookie'], undefined);
    } finally {
        await up.close();
    }
});

test('the application cannot claim to be another version', async () => {
    const up = await upstream({ 'X-Aegis-Release': 'fffffff' });
    try {
        const res = await answer((r) => siteServer.proxyTo(
            fakeReq('GET', '/'), r, { port: up.port, proxyKey: 'k', sha: 'aaaaaaa' }, CTX));
        const named = Object.keys(res.headers)
            .filter((h) => h.toLowerCase() === 'x-aegis-release')
            .map((h) => res.headers[h]);
        assert.deepStrictEqual(named, ['aaaaaaa']);
    } finally {
        await up.close();
    }
});

test('/__aegis/release says which version this visitor is on and which one is newest', async () => {
    const saved = [process.env.AEGIS_DEPLOY_RUNTIME, process.env.AEGIS_RUNTIME_ACCOUNTS];
    process.env.AEGIS_DEPLOY_RUNTIME = '1';
    process.env.AEGIS_RUNTIME_ACCOUNTS = 'run-a';
    const spawn = ({ port }) => {
        const child = new EventEmitter();
        const srv = http.createServer((q, s) => s.end('v')).listen(port, '127.0.0.1');
        child.kill = () => { srv.close(); return true; };
        return child;
    };
    const project = { id: 'app', port: 3081 };
    try {
        await runtime.restart({ slug: 'aff', project, dir: '.', startCmd: 'x', spawn, sha: 'aaaaaaa' });
        await runtime.restart({ slug: 'aff', project, dir: '.', startCmd: 'x', spawn, sha: 'bbbbbbb', keep: true });

        const onOld = await answer((r) => siteServer._serve(
            fakeReq('GET', '/__aegis/release', { cookie: 'aegis_release=aaaaaaa' }), r, CTX));
        assert.deepStrictEqual(JSON.parse(onOld.body), { served: 'aaaaaaa', latest: 'bbbbbbb' });
        assert.strictEqual(onOld.headers['Cache-Control'], 'no-store');

        const fresh = await answer((r) => siteServer._serve(fakeReq('GET', '/__aegis/release'), r, CTX));
        assert.deepStrictEqual(JSON.parse(fresh.body), { served: 'bbbbbbb', latest: 'bbbbbbb' });

        // Switching moves the cookie to the newest version and goes back to
        // the page, never to another site.
        const sw = await answer((r) => siteServer._serve(
            fakeReq('GET', '/__aegis/release/switch?next=%2FKPI%2Fdashboard-v2.html',
                { cookie: 'aegis_release=aaaaaaa' }), r, CTX));
        assert.strictEqual(sw.statusCode, 302);
        assert.strictEqual(sw.headers.Location, '/KPI/dashboard-v2.html');
        assert.match(sw.headers['Set-Cookie'], /^aegis_release=bbbbbbb;/);

        const away = await answer((r) => siteServer._serve(
            fakeReq('GET', '/__aegis/release/switch?next=%2F%2Fevil.example'), r, CTX));
        assert.strictEqual(away.headers.Location, '/');
    } finally {
        runtime.stop('aff', 'app');
        if (saved[0] === undefined) delete process.env.AEGIS_DEPLOY_RUNTIME;
        else process.env.AEGIS_DEPLOY_RUNTIME = saved[0];
        if (saved[1] === undefined) delete process.env.AEGIS_RUNTIME_ACCOUNTS;
        else process.env.AEGIS_RUNTIME_ACCOUNTS = saved[1];
    }
});

test('the guard lets the release routes through on an open site and keeps the rest reserved', () => {
    const tenantPaths = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-tenant-')) };
    const ctx = { slug: 'aff', tenantPaths, project: { id: 'app', name: 'App' } };
    const res = { writeHead() { this.headersSent = true; }, end() { }, headersSent: false };
    assert.strictEqual(siteAuth.gate(fakeReq('GET', '/__aegis/release'), res, ctx), false);
    assert.strictEqual(siteAuth.gate(fakeReq('GET', '/__aegis/release/switch?next=/'), res, ctx), false);
    assert.strictEqual(siteAuth.gate(fakeReq('GET', '/__aegis/anything-else'), res, ctx), true);
});
