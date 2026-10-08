/**
 * The notices a deployed site shows its visitors: the list a project keeps,
 * the words a visitor gets, the script the proxy adds to a page, and the route
 * the script asks.
 *
 * The promise under test is "present by default": a project that never opened
 * its Settings tab still warns a visitor who is on a replaced version, and a
 * site needs no code of its own for it.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.AEGIS_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-deploy-notices-'));
process.env.AEGIS_RUNTIME_PORT_BASE = process.env.AEGIS_TEST_RUNTIME_PORT_BASE_NOTICES || '47700';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const zlib = require('zlib');
const { Readable, Writable } = require('stream');
const { EventEmitter } = require('events');

const siteNotices = require('../siteNotices');
const siteAuth = require('../siteAuth');
const siteConfig = require('../siteConfig');
const siteServer = require('../siteServer');
const projectStore = require('../projectStore');
const runtime = require('../runtime');

console.log = () => {};
console.warn = () => {};

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
        const timer = setTimeout(() => reject(new Error('no answer')), 5000);
        timer.unref();
        run(res);
    });
}

function header(res, name) {
    const key = Object.keys(res.headers).find((h) => h.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : res.headers[key];
}

function upstream(handler) {
    return new Promise((resolve) => {
        const seen = {};
        const srv = http.createServer((req, res) => { seen.headers = req.headers; handler(req, res); });
        srv.listen(0, '127.0.0.1', () => resolve({
            port: srv.address().port,
            seen,
            close: () => new Promise((done) => srv.close(done))
        }));
    });
}

const PAGE = '<!doctype html><html><head><title>Home</title></head><body><p>Hello</p></body></html>';
const NAV = { accept: 'text/html,application/xhtml+xml', 'sec-fetch-dest': 'document' };

/* ---------------------------------------------------------------- the list */

test('a project that never saved its notices has both built-in ones, switched on', () => {
    const config = siteNotices.configOf({ id: 'site' });
    assert.strictEqual(config.inject, true);
    assert.deepStrictEqual(config.items.map((n) => [n.trigger, n.enabled]),
        [['older-version', true], ['page-outdated', true]]);
});

test('a list without the built-in notices gets them back', () => {
    const config = siteNotices.normalize({
        items: [{ id: 'msg-1', trigger: 'always', title: 'Maintenance tonight' }]
    });
    assert.deepStrictEqual(config.items.map((n) => n.id), ['msg-1', 'older-version', 'page-outdated']);
});

test('a built-in notice can be reworded and switched off, and keeps its id', () => {
    const config = siteNotices.normalize({
        inject: false,
        items: [{ id: 'anything', trigger: 'older-version', enabled: false, title: '  New version  ', tone: 'info' }]
    });
    const older = config.items.find((n) => n.trigger === 'older-version');
    assert.deepStrictEqual(older, {
        id: 'older-version', trigger: 'older-version', enabled: false, tone: 'info',
        title: 'New version', body: '', action: ''
    });
    assert.strictEqual(config.inject, false);
});

test('what the route cannot trust is refused, not coerced', () => {
    const bad = [
        'not an object',
        { inject: 'yes' },
        { items: {} },
        { items: [{ trigger: 'popup' }] },
        { items: [{ trigger: 'always', id: 'a', title: 'x', tone: 'red' }] },
        { items: [{ trigger: 'always', id: 'a', title: 'x', enabled: 'true' }] },
        { items: [{ trigger: 'always', id: 'a' }] },
        { items: [{ trigger: 'always', id: 'a', title: 'x' }, { trigger: 'always', id: 'a', title: 'y' }] },
        { items: [{ trigger: 'always', id: 'page-outdated', title: 'x' }] },
        { items: [{ trigger: 'always', id: 'Bad Id', title: 'x' }] },
        { items: [{ trigger: 'always', id: 'a', title: 'x'.repeat(121) }] },
        { items: [{ trigger: 'always', id: 'a', body: 7 }] },
        { items: Array.from({ length: 13 }, (_, i) => ({ trigger: 'always', id: `m${i}`, title: 't' })) }
    ];
    for (const raw of bad) {
        assert.throws(() => siteNotices.normalize(raw), (e) => e.code === 'bad_notices', JSON.stringify(raw));
    }
});

test('a message keeps no button, and loses control characters', () => {
    const config = siteNotices.normalize({
        items: [{ id: 'm', trigger: 'always', title: 'A\u0007B', body: 'one\r\ntwo', action: 'Go' }]
    });
    const m = config.items[0];
    assert.strictEqual(m.title, 'AB');
    assert.strictEqual(m.body, 'one\ntwo');
    assert.strictEqual(m.action, '');
});

test('a record edited into nonsense still gives the visitors the built-in warnings', () => {
    const config = siteNotices.configOf({ notices: { items: 'broken' } });
    assert.deepStrictEqual(config, siteNotices.defaults());
});

/* --------------------------------------------------------------- the words */

test('an empty field is the built-in sentence in the visitor\'s language, with its numbers', () => {
    const config = siteNotices.defaults();
    const fr = siteNotices.forVisitor(config, 'fr', { idle: 30, remaining: 12 });
    assert.strictEqual(fr[0].title, siteNotices.DEFAULT_TEXT.fr['older-version'].title);
    assert.match(fr[0].body, /30 minutes/);
    assert.ok(!fr[0].body.includes('{idle}'));
    const en = siteNotices.forVisitor(config, 'xx', { idle: 30 });
    assert.strictEqual(en[1].action, siteNotices.DEFAULT_TEXT.en['page-outdated'].action);
});

test('a typed sentence is shown as typed, and a switched-off notice is not sent', () => {
    const config = siteNotices.normalize({
        items: [
            { trigger: 'older-version', body: 'Stops in {remaining} min.' },
            { trigger: 'page-outdated', enabled: false }
        ]
    });
    const out = siteNotices.forVisitor(config, 'fr', { idle: 30, remaining: 4 });
    assert.deepStrictEqual(out.map((n) => n.id), ['older-version']);
    assert.strictEqual(out[0].body, 'Stops in 4 min.');
});

/* -------------------------------------------------------------- the script */

test('the script goes before </head>, else </body>, else at the end, and only once', () => {
    const tag = siteNotices.scriptTag('abcdef1');
    assert.strictEqual(tag, '<script src="/__aegis/notices.js" data-release="abcdef1" defer></script>');
    assert.strictEqual(siteNotices.inject(PAGE, 'abcdef1').toString(),
        PAGE.replace('</head>', `${tag}</head>`));
    assert.strictEqual(siteNotices.inject('<body>x</BODY >', null).toString(),
        '<body>x<script src="/__aegis/notices.js" defer></script></BODY >');
    assert.strictEqual(siteNotices.inject('x', null).toString(), 'x<script src="/__aegis/notices.js" defer></script>');
    const once = siteNotices.inject(PAGE, 'abcdef1');
    assert.strictEqual(siteNotices.inject(once, 'abcdef1').toString(), once.toString());
});

test('the bytes of a page in another charset come out as they went in', () => {
    const latin = Buffer.from([0x3c, 0x2f, 0x68, 0x65, 0x61, 0x64, 0x3e, 0xe9, 0xe8]); // </head>éè in latin1
    const out = siteNotices.inject(latin, null);
    assert.deepStrictEqual(out.subarray(out.length - 9), latin);
});

test('only an HTML response is a page', () => {
    assert.ok(siteNotices.isHtml('text/html; charset=utf-8'));
    assert.ok(siteNotices.isHtml('application/xhtml+xml'));
    assert.ok(!siteNotices.isHtml('text/htmlx'));
    assert.ok(!siteNotices.isHtml('application/json'));
    assert.ok(!siteNotices.isHtml(undefined));
});

/* --------------------------------------------------------------- the proxy */

const NODE_CTX = { slug: 'ntc', project: { id: 'app', name: 'App' }, runtime: 'node', notices: { inject: true } };

test('a page a browser navigates to gets the script, naming the version that served it', async () => {
    const up = await upstream((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"v1"' });
        res.end(PAGE);
    });
    try {
        const res = await answer((r) => siteServer.proxyTo(
            fakeReq('GET', '/', Object.assign({ 'accept-encoding': 'gzip, br', 'if-none-match': '"v0"' }, NAV)),
            r, { port: up.port, proxyKey: 'k', sha: 'abcdef1' }, NODE_CTX));
        assert.ok(res.body.includes('<script src="/__aegis/notices.js" data-release="abcdef1" defer></script></head>'));
        assert.strictEqual(Number(header(res, 'content-length')), Buffer.byteLength(res.body));
        assert.strictEqual(header(res, 'etag'), undefined, 'a validator for the page before the script');
        assert.strictEqual(up.seen.headers['accept-encoding'], 'identity');
        assert.strictEqual(up.seen.headers['if-none-match'], undefined);
    } finally {
        await up.close();
    }
});

test('a compressed page is read, given the script, and sent uncompressed', async () => {
    const up = await upstream((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync(PAGE));
    });
    try {
        const res = await answer((r) => siteServer.proxyTo(fakeReq('GET', '/', NAV), r,
            { port: up.port, proxyKey: 'k', sha: 'abcdef1' }, NODE_CTX));
        assert.strictEqual(header(res, 'content-encoding'), undefined);
        assert.ok(res.body.includes('/__aegis/notices.js'));
        assert.ok(res.body.startsWith('<!doctype html>'));
    } finally {
        await up.close();
    }
});

test('a fetch from the page, or a site that turned the notices off, is passed on untouched', async () => {
    const up = await upstream((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(PAGE);
    });
    try {
        const fetched = await answer((r) => siteServer.proxyTo(
            fakeReq('GET', '/', { accept: '*/*', 'sec-fetch-dest': 'empty' }), r,
            { port: up.port, proxyKey: 'k', sha: 'abcdef1' }, NODE_CTX));
        assert.strictEqual(fetched.body, PAGE);
        const off = await answer((r) => siteServer.proxyTo(fakeReq('GET', '/', NAV), r,
            { port: up.port, proxyKey: 'k', sha: 'abcdef1' }, Object.assign({}, NODE_CTX, { notices: { inject: false } })));
        assert.strictEqual(off.body, PAGE);
        const posted = await answer((r) => siteServer.proxyTo(fakeReq('POST', '/', NAV), r,
            { port: up.port, proxyKey: 'k', sha: 'abcdef1' }, NODE_CTX));
        assert.strictEqual(posted.body, PAGE);
    } finally {
        await up.close();
    }
});

test('JSON, an error page and a download are never touched', async () => {
    const cases = [
        [200, { 'content-type': 'application/json' }, '{"a":1}'],
        [500, { 'content-type': 'text/html' }, PAGE],
        [200, { 'content-type': 'text/html', 'content-disposition': 'attachment; filename="p.html"' }, PAGE]
    ];
    for (const [status, headers, body] of cases) {
        const up = await upstream((req, res) => { res.writeHead(status, headers); res.end(body); });
        try {
            const res = await answer((r) => siteServer.proxyTo(fakeReq('GET', '/', NAV), r,
                { port: up.port, proxyKey: 'k', sha: 'abcdef1' }, NODE_CTX));
            assert.strictEqual(res.body, body);
        } finally {
            await up.close();
        }
    }
});

/* ------------------------------------------------------------ static sites */

function staticSite(record) {
    const tenantPaths = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-tenant-')) };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-site-'));
    fs.writeFileSync(path.join(root, 'index.html'), PAGE);
    fs.writeFileSync(path.join(root, 'app.js'), 'console.log(1)');
    projectStore.saveProject(tenantPaths, Object.assign({ id: 'web', port: 3081, name: 'Web' }, record));
    siteConfig.invalidate('ntc', 'web');
    return { slug: 'ntc', tenantPaths, root, project: { id: 'web', name: 'Web' }, runtime: 'static' };
}

test('a static page gets the script with the commit the site last published', async () => {
    const ctx = staticSite({ lastSha: '1234567' });
    const res = await answer((r) => siteServer._serve(fakeReq('GET', '/'), r, ctx));
    assert.ok(res.body.includes('data-release="1234567"'));
    assert.strictEqual(Number(header(res, 'content-length')), Buffer.byteLength(res.body));
    const head = await answer((r) => siteServer._serve(fakeReq('HEAD', '/'), r, ctx));
    assert.strictEqual(header(head, 'content-length'), header(res, 'content-length'));
    const js = await answer((r) => siteServer._serve(fakeReq('GET', '/app.js'), r, ctx));
    assert.strictEqual(js.body, 'console.log(1)');
});

test('a static site that turned the notices off serves its pages as they are', async () => {
    const ctx = staticSite({ lastSha: '1234567', notices: { inject: false } });
    const res = await answer((r) => siteServer._serve(fakeReq('GET', '/'), r, ctx));
    assert.strictEqual(res.body, PAGE);
});

test('/__aegis/notices on a static site: one version, and the project\'s own words', async () => {
    const ctx = staticSite({
        lastSha: '1234567',
        notices: { items: [{ id: 'msg-1', trigger: 'always', title: 'Closed on Friday' }] }
    });
    const res = await answer((r) => siteServer._serve(
        fakeReq('GET', '/__aegis/notices', { 'accept-language': 'fr-FR,fr;q=0.9' }), r, ctx));
    const data = JSON.parse(res.body);
    assert.strictEqual(data.served, '1234567');
    assert.strictEqual(data.latest, '1234567');
    assert.deepStrictEqual(data.notices.map((n) => n.id), ['msg-1', 'older-version', 'page-outdated']);
    assert.strictEqual(data.notices[1].title, siteNotices.DEFAULT_TEXT.fr['older-version'].title);
    assert.strictEqual(header(res, 'cache-control'), 'no-store');
});

/* ------------------------------------------------- the outgoing version */

test('/__aegis/notices tells a visitor on the outgoing version how long it has left', async () => {
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
    const ctx = { slug: 'ntc', project: { id: 'app', name: 'App' }, runtime: 'node' };
    try {
        await runtime.restart({ slug: 'ntc', project, dir: '.', startCmd: 'x', spawn, sha: 'aaaaaaa' });
        await runtime.restart({ slug: 'ntc', project, dir: '.', startCmd: 'x', spawn, sha: 'bbbbbbb', keep: true });

        const onOld = JSON.parse((await answer((r) => siteServer._serve(
            fakeReq('GET', '/__aegis/notices', { cookie: 'aegis_release=aaaaaaa' }), r, ctx))).body);
        assert.strictEqual(onOld.served, 'aaaaaaa');
        assert.strictEqual(onOld.latest, 'bbbbbbb');
        const idle = Math.round(runtime.DRAIN_IDLE_MS / 60000);
        assert.ok(onOld.notices[0].body.includes(`${idle} minutes`), onOld.notices[0].body);

        const fresh = JSON.parse((await answer((r) => siteServer._serve(
            fakeReq('GET', '/__aegis/notices'), r, ctx))).body);
        assert.strictEqual(fresh.served, 'bbbbbbb');
        assert.strictEqual(fresh.latest, 'bbbbbbb');

        // Asking is not using: the outgoing version's clock does not move.
        const before = runtime.versions('ntc', 'app').draining.lastSeen;
        await new Promise((r) => setTimeout(r, 5));
        await answer((r) => siteServer._serve(
            fakeReq('GET', '/__aegis/notices', { cookie: 'aegis_release=aaaaaaa' }), r, ctx));
        assert.strictEqual(runtime.versions('ntc', 'app').draining.lastSeen, before);
    } finally {
        runtime.stop('ntc', 'app');
        if (saved[0] === undefined) delete process.env.AEGIS_DEPLOY_RUNTIME;
        else process.env.AEGIS_DEPLOY_RUNTIME = saved[0];
        if (saved[1] === undefined) delete process.env.AEGIS_RUNTIME_ACCOUNTS;
        else process.env.AEGIS_RUNTIME_ACCOUNTS = saved[1];
    }
});

/* --------------------------------------------------------------- the guard */

test('an open site serves the script and lets the notices route through', async () => {
    const tenantPaths = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-tenant-')) };
    const ctx = { slug: 'ntc', tenantPaths, project: { id: 'app', name: 'App' } };
    const quiet = { writeHead() { this.headersSent = true; }, end() { }, headersSent: false };
    assert.strictEqual(siteAuth.gate(fakeReq('GET', '/__aegis/notices'), quiet, ctx), false);
    const script = await answer((r) => {
        assert.strictEqual(siteAuth.gate(fakeReq('GET', '/__aegis/notices.js'), r, ctx), true);
    });
    assert.strictEqual(script.statusCode, 200);
    assert.match(String(script.headers['Content-Type']), /javascript/);
    assert.ok(script.body.includes('/__aegis/notices'));
});
