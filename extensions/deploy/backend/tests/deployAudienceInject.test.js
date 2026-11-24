/**
 * The audience switch of a project, and the script tag it puts in the pages.
 *
 * The audience script rides the notices mechanism (siteNotices.inject), so the
 * promises are about the pair: a page gets each tag it is owed and no other,
 * the notices behave as they did when audience is off, and a project whose
 * notices are off still gets the audience tag when audience is on.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-audience-inject-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;
process.env.AEGIS_DEPLOY_ENABLED = '1';
process.env.AEGIS_DEPLOY_POLL_MS = '0';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Readable, Writable } = require('stream');

const siteNotices = require('../siteNotices');
const siteConfig = require('../siteConfig');
const siteServer = require('../siteServer');
const projectStore = require('../projectStore');
const routes = require('../routes');

console.log = () => {};
console.warn = () => {};

const PAGE = '<!doctype html><html><head><title>Home</title></head><body><p>Hello</p></body></html>';
const NAV = { accept: 'text/html', 'sec-fetch-dest': 'document' };
const NOTICES_TAG = '<script src="/__aegis/notices.js" defer></script>';
const AUDIENCE_TAG = '<script src="/__aegis/audience.js" defer></script>';

function fakeReq(method, url, headers) {
    const req = Readable.from([]);
    req.method = method;
    req.url = url;
    req.headers = Object.assign({}, headers);
    req.socket = { remoteAddress: '192.0.2.10' };
    return req;
}

function answer(run) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const res = new Writable({ write(chunk, enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
        res.headersSent = false;
        res.headers = {};
        res.writeHead = function (status, headers) {
            res.statusCode = status;
            Object.assign(res.headers, headers || {});
            res.headersSent = true;
        };
        const end = res.end.bind(res);
        res.end = function (chunk) { if (chunk) chunks.push(Buffer.from(chunk)); return end(); };
        res.on('finish', () => { res.body = Buffer.concat(chunks).toString('utf8'); resolve(res); });
        res.on('error', reject);
        setTimeout(() => reject(new Error('no answer')), 5000).unref();
        run(res);
    });
}

/* ------------------------------------------------------------- the tags */

test('inject with two arguments is unchanged', () => {
    const out = siteNotices.inject(Buffer.from(PAGE)).toString('latin1');
    assert.ok(out.includes(NOTICES_TAG + '</head>'));
    assert.ok(!out.includes('audience.js'));
});

test('inject adds the audience tag only when audience is on', () => {
    const on = siteNotices.inject(Buffer.from(PAGE), null, { notices: true, audience: true }).toString('latin1');
    assert.ok(on.includes(NOTICES_TAG + AUDIENCE_TAG + '</head>'));
    const off = siteNotices.inject(Buffer.from(PAGE), null, { notices: true, audience: false }).toString('latin1');
    assert.ok(!off.includes('audience.js'));
});

test('inject with notices off and audience on adds the audience tag alone', () => {
    const out = siteNotices.inject(Buffer.from(PAGE), 'abcdef1', { notices: false, audience: true }).toString('latin1');
    assert.ok(out.includes(AUDIENCE_TAG + '</head>'));
    assert.ok(!out.includes('notices.js'));
});

test('a page that already carries audience.js is left alone, the notices tag still added', () => {
    const own = PAGE.replace('</head>', '<script src="/__aegis/audience.js"></script></head>');
    const out = siteNotices.inject(Buffer.from(own), null, { notices: true, audience: true }).toString('latin1');
    assert.strictEqual(out.split('audience.js').length, 2);
    assert.ok(out.includes('notices.js'));
});

test('wantsInjection is true when either switch is on', () => {
    const on = { enabled: true };
    const off = { enabled: false };
    assert.strictEqual(siteNotices.wantsInjection({ notices: { inject: false }, audience: off }), false);
    assert.strictEqual(siteNotices.wantsInjection({ notices: { inject: true }, audience: off }), true);
    assert.strictEqual(siteNotices.wantsInjection({ notices: { inject: false }, audience: on }), true);
    assert.strictEqual(siteNotices.wantsInjection({ notices: { inject: false } }), false);
});

/* --------------------------------------------------------- static sites */

const TENANTS_ROOT = path.join(DATA_ROOT, 'tenants');

function pathsFor(slug) {
    const root = path.join(TENANTS_ROOT, slug);
    return { root, deploy: path.join(root, 'deploy') };
}

function staticSite(record) {
    const tenantPaths = pathsFor('aud');
    fs.mkdirSync(tenantPaths.root, { recursive: true });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-site-'));
    fs.writeFileSync(path.join(root, 'index.html'), PAGE);
    projectStore.saveProject(tenantPaths, Object.assign({ id: 'web', port: 3081, name: 'Web' }, record));
    siteConfig.invalidate('aud', 'web');
    return { slug: 'aud', tenantPaths, root, project: { id: 'web', name: 'Web' }, runtime: 'static' };
}

test('a project that never saved audience reads enabled false', () => {
    staticSite({});
    assert.deepStrictEqual(siteConfig.settingsFor('aud', pathsFor('aud'), 'web').audience, { enabled: false });
});

test('a static page gets the audience tag when notices.inject is false and audience is on', async () => {
    const ctx = staticSite({ notices: { inject: false }, audience: { enabled: true } });
    const res = await answer((r) => siteServer._serve(fakeReq('GET', '/'), r, ctx));
    assert.ok(res.body.includes(AUDIENCE_TAG));
    assert.ok(!res.body.includes('notices.js'));
    assert.strictEqual(Number(res.headers['Content-Length']), Buffer.byteLength(res.body));
});

test('a static site with both switches off serves its page as it is', async () => {
    const ctx = staticSite({ notices: { inject: false }, audience: { enabled: false } });
    const res = await answer((r) => siteServer._serve(fakeReq('GET', '/'), r, ctx));
    assert.strictEqual(res.body, PAGE);
});

/* -------------------------------------------------------- proxied sites */

test('a proxied page gets the tag under the same rule', async () => {
    const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    try {
        const ctx = { slug: 'aud', project: { id: 'app', name: 'App' }, runtime: 'node',
            notices: { inject: false }, audience: { enabled: true } };
        const res = await answer((r) => siteServer.proxyTo(fakeReq('GET', '/', NAV), r,
            { port: srv.address().port, proxyKey: 'k', sha: 'abcdef1' }, ctx));
        assert.ok(res.body.includes(AUDIENCE_TAG));
        assert.ok(!res.body.includes('notices.js'));
    } finally {
        await new Promise((done) => srv.close(done));
    }
});

/* ------------------------------------------------------------ the route */

function collect() {
    const table = new Map();
    const add = (method) => (routePath, ...chain) => table.set(`${method} ${routePath}`, chain);
    routes.register({ get: add('GET'), post: add('POST'), delete: add('DELETE'), put: add('PUT'), patch: add('PATCH') }, {
        requireRole: () => (req, res, next) => next(),
        pathsFor,
        tenantsRoot: () => TENANTS_ROOT
    });
    return table;
}

const table = collect();

function call(key, req) {
    const chain = table.get(key);
    assert.ok(chain, `${key} is not mounted`);
    return new Promise((resolve, reject) => {
        const res = {
            statusCode: 200,
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

function settingsReq(body) {
    return {
        body, query: {}, params: { id: 'web' },
        tenant: { slug: 'aud' }, tenantPaths: pathsFor('aud'),
        user: { email: 'ops@corp.local', role: 'admin' }
    };
}

test('settings accept { audience: { enabled: true } } alone and the next request sees it', async () => {
    staticSite({});
    const res = await call('POST /api/deploy/projects/:id/settings', settingsReq({ audience: { enabled: true } }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.audience, { enabled: true });
    assert.deepStrictEqual(projectStore.getProject(pathsFor('aud'), 'web').audience, { enabled: true });
    assert.deepStrictEqual(siteConfig.settingsFor('aud', pathsFor('aud'), 'web').audience, { enabled: true });
});

test('settings refuse audience.enabled = "yes" with bad_audience and write nothing', async () => {
    staticSite({ spaFallback: false });
    const res = await call('POST /api/deploy/projects/:id/settings',
        settingsReq({ spaFallback: true, audience: { enabled: 'yes' } }));
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'bad_audience');
    const record = projectStore.getProject(pathsFor('aud'), 'web');
    assert.strictEqual(record.audience, undefined);
    assert.strictEqual(record.spaFallback, false);
});
