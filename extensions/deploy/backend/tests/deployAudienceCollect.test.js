/**
 * The audience collection point, `POST /__aegis/audience`, behind the guard.
 *
 * Each request runs through `siteAuth.gate` and then `siteServer._serve`, the
 * order `handle` uses, so what is under test is the pair a browser meets: a
 * protected site counts only a signed-in visitor and names them by an HMAC,
 * an open site names them by a cookie Deploy sets once, and nothing a foreign
 * page or a bot sends is written.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-deploy-audience-collect-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Readable, Writable } = require('stream');

const siteAuth = require('../siteAuth');
const authStore = require('../authStore');
const projectStore = require('../projectStore');
const siteConfig = require('../siteConfig');
const siteServer = require('../siteServer');
const audience = require('../audience');
const audienceStore = require('../audienceStore');

console.log = () => {};
console.warn = () => {};

const DIRECTORY = {
    url: 'ldaps://dc01.corp.local:636',
    baseDn: 'DC=corp,DC=local',
    bindDn: 'CN=svc,DC=corp,DC=local',
    bindPassword: 'service-secret'
};
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const HOST = 'stock.corp.local';
let n = 0;

function site(record, withDirectory) {
    n++;
    const slug = 'dt-plain';
    const id = 'site' + n;
    const tenantPaths = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-tenant-')) };
    projectStore.saveProject(tenantPaths, Object.assign({ id, port: 3081, name: id }, record));
    if (withDirectory) authStore.writeConfig(tenantPaths, DIRECTORY);
    siteAuth.invalidate(slug, id);
    siteConfig.invalidate(slug, id);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-site-'));
    fs.writeFileSync(path.join(root, 'index.html'), '<html><head></head><body></body></html>');
    return { slug, id, tenantPaths, ctx: { slug, tenantPaths, project: { id, name: id }, runtime: 'static', root } };
}

function fakeReq(method, url, opts) {
    const o = opts || {};
    const req = Readable.from(o.body === undefined ? [] : [Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body, 'utf8')]);
    req.method = method;
    req.url = url;
    req.headers = Object.assign({ host: HOST, 'user-agent': BROWSER }, o.headers);
    req.socket = { remoteAddress: '192.0.2.10', encrypted: o.secure !== false };
    return req;
}

function answer(req, ctx) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const res = new Writable({ write(chunk, enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
        res.headersSent = false;
        res.headers = {};
        res.statusCode = 0;
        res.setHeader = (k, v) => { res.headers[k] = v; };
        res.writeHead = function (status, headers) {
            res.statusCode = status;
            Object.assign(res.headers, headers || {});
            res.headersSent = true;
            return res;
        };
        const end = res.end.bind(res);
        res.end = function (chunk) { if (chunk) chunks.push(Buffer.from(chunk)); return end(); };
        res.on('finish', () => { res.body = Buffer.concat(chunks).toString('utf8'); resolve(res); });
        res.on('error', reject);
        setTimeout(() => reject(new Error('no answer')), 5000).unref();
        Promise.resolve(siteAuth.gate(req, res, ctx)).then((handled) => {
            if (!handled) siteServer._serve(req, res, ctx);
        }).catch(reject);
    });
}

function header(res, name) {
    const key = Object.keys(res.headers).find((h) => h.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : res.headers[key];
}

function batch(events) {
    return JSON.stringify({ v: 1, events: events || [{ k: 'view', pv: 'pv000001', p: '/stock' }] });
}

function post(body, headers, extra) {
    return fakeReq('POST', '/__aegis/audience', Object.assign({
        body: body === undefined ? batch() : body,
        headers: Object.assign({ origin: `https://${HOST}`, 'content-type': 'text/plain' }, headers)
    }, extra));
}

function rawLines(s) {
    return audienceStore.readRaw(s.tenantPaths, s.id, audience.localDay(Date.now()));
}

function cookieValue(setCookie, name) {
    const m = new RegExp(`(?:^|; )?${name}=([^;]*)`).exec([].concat(setCookie || []).join('\n'));
    return m ? m[1] : null;
}

async function signIn(s, login) {
    siteAuth._setVerifier(() => ({ ok: true, login, displayName: 'Alice Martin', groups: [] }));
    try {
        const names = siteAuth.cookieNames(s.slug, s.id);
        const get = await answer(fakeReq('GET', '/__aegis/login'), s.ctx);
        const csrf = cookieValue(header(get, 'set-cookie'), names.csrf);
        const res = await answer(fakeReq('POST', '/__aegis/login', {
            body: new URLSearchParams({ csrf, username: login, password: 'not-a-real-one', next: '/' }).toString(),
            headers: {
                cookie: `${names.csrf}=${csrf}`, origin: `https://${HOST}`,
                'content-type': 'application/x-www-form-urlencoded'
            }
        }), s.ctx);
        const token = cookieValue(header(res, 'set-cookie'), names.session);
        assert.ok(token, 'the sign-in should mint a session');
        return `${names.session}=${token}`;
    } finally {
        siteAuth._setVerifier(null);
    }
}

const PROTECTED = { auth: { enabled: true, allowedGroups: [] }, audience: { enabled: true } };

/* ------------------------------------------------------------------ */

test('audience off: 204 and no file', async () => {
    const s = site({});
    const res = await answer(post(), s.ctx);
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(rawLines(s).length, 0);
});

test('GET on /__aegis/audience: 405', async () => {
    const s = site({ audience: { enabled: true } });
    const res = await answer(fakeReq('GET', '/__aegis/audience'), s.ctx);
    assert.strictEqual(res.statusCode, 405);
});

test('foreign Origin: 403 and no file', async () => {
    const s = site({ audience: { enabled: true } });
    const res = await answer(post(undefined, { origin: 'https://elsewhere.test' }), s.ctx);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(rawLines(s).length, 0);
});

test('open site, first batch: 204, sets aegis_aud_<id> once, writes lines with server time', async () => {
    const s = site({ audience: { enabled: true } });
    const before = Date.now();
    const res = await answer(post(batch([{ k: 'view', pv: 'pv000001', p: '/stock', t: 1 }])), s.ctx);
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(header(res, 'cache-control'), 'no-store');
    const set = [].concat(header(res, 'set-cookie') || []).join('\n');
    assert.match(set, new RegExp(`aegis_aud_${s.id}=[A-Za-z0-9_-]{22}; Max-Age=34214400`));
    const lines = rawLines(s);
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].t >= before);
    assert.match(lines[0].vis, /^[0-9a-f]{16}$/);
});

test('open site, batch with the cookie: no Set-Cookie, same visitor', async () => {
    const s = site({ audience: { enabled: true } });
    const first = await answer(post(), s.ctx);
    const value = cookieValue(header(first, 'set-cookie'), `aegis_aud_${s.id}`);
    const again = await answer(post(batch([{ k: 'view', pv: 'pv000002', p: '/' }]), { cookie: `aegis_aud_${s.id}=${value}` }), s.ctx);
    assert.strictEqual(header(again, 'set-cookie'), undefined);
    const lines = rawLines(s);
    assert.strictEqual(lines[0].vis, lines[1].vis);
});

test('a malformed cookie is replaced, not hashed', async () => {
    const s = site({ audience: { enabled: true } });
    const res = await answer(post(undefined, { cookie: `aegis_aud_${s.id}=../../x` }), s.ctx);
    assert.match([].concat(header(res, 'set-cookie') || []).join(''), new RegExp(`aegis_aud_${s.id}=[A-Za-z0-9_-]{22};`));
});

test('protected site, signed in: the line carries the HMAC of the username, never the name', async (t) => {
    const s = site(PROTECTED, true);
    t.after(() => siteAuth.dropSessions(s.slug, s.id));
    const cookie = await signIn(s, 'alice.martin');
    const res = await answer(post(undefined, { cookie }), s.ctx);
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(header(res, 'set-cookie'), undefined);
    const lines = rawLines(s).filter((l) => l.k === 'view');
    const key = audienceStore.keyFor(s.tenantPaths);
    assert.strictEqual(lines[0].vis, audience.visitorId(key, s.id, { username: 'alice.martin' }));
    const file = fs.readFileSync(path.join(audienceStore.dirFor(s.tenantPaths, s.id), 'raw', audience.localDay(Date.now()) + '.jsonl'), 'utf8');
    assert.ok(!file.toLowerCase().includes('alice'));
});

test('protected site, no session or expired session: 204, no file, no HTML', async () => {
    const s = site(PROTECTED, true);
    const none = await answer(post(), s.ctx);
    assert.strictEqual(none.statusCode, 204);
    assert.strictEqual(none.body, '');
    const stale = await answer(post(undefined, { cookie: `${siteAuth.cookieNames(s.slug, s.id).session}=expired-token` }), s.ctx);
    assert.strictEqual(stale.statusCode, 204);
    assert.strictEqual(rawLines(s).length, 0);
});

test('protected site, signed in: no directory call is made for a batch', async (t) => {
    const s = site(PROTECTED, true);
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions(s.slug, s.id); });
    const cookie = await signIn(s, 'alice.martin');
    let calls = 0;
    siteAuth._setLookup(() => { calls++; return { ok: true, groups: [] }; });
    siteAuth._setVerifier(() => { calls++; return { ok: true, groups: [] }; });
    try {
        const res = await answer(post(undefined, { cookie }), s.ctx);
        assert.strictEqual(res.statusCode, 204);
    } finally {
        siteAuth._setVerifier(null);
    }
    assert.strictEqual(calls, 0);
});

test('bot user agent: 204, no file', async () => {
    const s = site({ audience: { enabled: true } });
    const res = await answer(post(undefined, { 'user-agent': 'curl/8.4.0' }), s.ctx);
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(rawLines(s).length, 0);
});

test('a 17 KiB body: 413, broken JSON: 400', async () => {
    const s = site({ audience: { enabled: true } });
    const big = await answer(post(Buffer.alloc(17 * 1024, 0x20)), s.ctx);
    assert.strictEqual(big.statusCode, 413);
    const bad = await answer(post('{"v":1,'), s.ctx);
    assert.strictEqual(bad.statusCode, 400);
    assert.strictEqual(rawLines(s).length, 0);
});

test('the application behind the proxy never sees aegis_aud_ in its Cookie header', async () => {
    let seen = null;
    const srv = http.createServer((req, res) => { seen = req.headers; res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    try {
        const req = fakeReq('GET', '/api', { headers: { cookie: 'aegis_aud_stock=abcdefghijklmnopqrstuv; app=1' } });
        await new Promise((resolve) => {
            const res = new Writable({ write(chunk, enc, cb) { cb(); } });
            res.writeHead = () => res;
            res.on('finish', resolve);
            siteServer.proxyTo(req, res, { port: srv.address().port }, { slug: 'dt-plain', project: { id: 'stock' }, notices: { inject: false } });
        });
        assert.strictEqual(seen.cookie, 'app=1');
    } finally {
        await new Promise((done) => srv.close(done));
    }
});

test('/__aegis/audience.js is served on an open site and on a protected one', async () => {
    const open = site({ audience: { enabled: true } });
    const a = await answer(fakeReq('GET', '/__aegis/audience.js'), open.ctx);
    assert.strictEqual(a.statusCode, 200);
    assert.match(String(header(a, 'content-type')), /javascript/);
    const shut = site(PROTECTED, true);
    const b = await answer(fakeReq('GET', '/__aegis/audience.js'), shut.ctx);
    assert.strictEqual(b.statusCode, 200);
});
