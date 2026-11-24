/**
 * What a protected site tells core about its visitors.
 *
 * Every login, refused login, logout, administrator close and refused
 * revalidation reaches the host's `recordSiteEvent` once, with the tenant slug
 * taken from Deploy's own record of the site, a normalised address and a short
 * machine code for a refusal. Without a sink the console line is all there is
 * and nothing throws.
 *
 * Same fabricated requests as `siteAuth.test.js`: no socket, an injected
 * verifier and lookup. The verifier is handed a password that must never show
 * up in an event or a console line.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-deploy-journal-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;
process.env.AEGIS_DEPLOY_ENABLED = '1';
process.env.AEGIS_DEPLOY_POLL_MS = '0';

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');

const siteAuth = require('../siteAuth');
const authStore = require('../authStore');
const projectStore = require('../projectStore');
const routes = require('../routes');

const SECRET = 'correct-horse-battery';
const VIEWERS_DN = 'CN=Site Viewers,OU=Groups,DC=corp,DC=local';
const CONFIG = {
    url: 'ldap://dc01.corp.local:389',
    baseDn: 'DC=corp,DC=local',
    bindDn: 'CN=svc,DC=corp,DC=local',
    bindPassword: 'service-secret',
    revalidateMinutes: 10
};

// Kept to read the guard's own lines, muted for the rest of the run.
const consoleLines = [];
console.log = (m) => { consoleLines.push(String(m)); };
console.warn = (m) => { consoleLines.push(String(m)); };

function fakeReq(method, url, opts) {
    const o = opts || {};
    const req = Readable.from(o.body === undefined ? [] : [Buffer.from(o.body, 'utf8')]);
    req.method = method;
    req.url = url;
    req.headers = Object.assign({}, o.headers);
    req.socket = { remoteAddress: o.ip === undefined ? '10.0.0.5' : o.ip };
    if (o.secure !== false) req.socket.encrypted = true;
    return req;
}

function fakeRes() {
    const res = { statusCode: 0, headers: {}, body: '', ended: false, headersSent: false };
    res.writeHead = (status, headers) => { res.statusCode = status; Object.assign(res.headers, headers || {}); res.headersSent = true; return res; };
    res.setHeader = (name, value) => { res.headers[name] = value; };
    res.end = (chunk) => { if (chunk) res.body += String(chunk); res.ended = true; };
    return res;
}

function cookieValue(setCookie, name) {
    const m = new RegExp(`(?:^|; )?${name}=([^;]*)`).exec(String(setCookie || ''));
    return m ? m[1] : null;
}

function seed(slug, id, auth) {
    const tenantPaths = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-tenant-')) };
    projectStore.saveProject(tenantPaths, {
        id, port: 3081, name: id, auth: Object.assign({ enabled: true, allowedGroups: ['Site Viewers'] }, auth)
    });
    authStore.writeConfig(tenantPaths, CONFIG);
    siteAuth.invalidate(slug, id);
    return tenantPaths;
}

/** The events the guard sends, in order, as `{ slug, ...event }`. */
function collect(t) {
    const events = [];
    siteAuth.setAuditSink((slug, event) => { events.push(Object.assign({ slug }, event)); });
    t.after(() => siteAuth.setAuditSink(null));
    return events;
}

/**
 * Posts the login form. `viaHost` and `extra` let a request carry another
 * tenant's slug in its Host header, its URL and its form, none of which may
 * decide whose journal the event lands in.
 */
async function login(slug, tenantPaths, id, fields, opts) {
    const o = opts || {};
    const ctx = { slug, tenantPaths, project: { id, name: id } };
    const names = siteAuth.cookieNames(slug, id);
    const loginUrl = o.url || '/__aegis/login';
    const get = fakeRes();
    await siteAuth.gate(fakeReq('GET', loginUrl, { headers: o.headers }), get, ctx);
    const csrf = cookieValue(get.headers['Set-Cookie'], names.csrf);
    const body = new URLSearchParams(Object.assign({ csrf }, o.form, fields)).toString();
    const res = fakeRes();
    await siteAuth.gate(fakeReq('POST', loginUrl, {
        body, ip: o.ip,
        headers: Object.assign({ cookie: `${names.csrf}=${csrf}`, 'content-type': 'application/x-www-form-urlencoded' }, o.headers)
    }), res, ctx);
    return { res, token: cookieValue(res.headers['Set-Cookie'], names.session) };
}

function withVerifier(t, answer) {
    siteAuth._setVerifier(typeof answer === 'function' ? answer : () => answer);
    t.after(() => siteAuth._setVerifier(null));
}

test('a login reaches the sink once, with the owner slug, the project, the name and the address', async (t) => {
    const events = collect(t);
    const tenantPaths = seed('tenant-j1', 'portal');
    withVerifier(t, { ok: true, groups: [VIEWERS_DN], login: 'alice' });
    const { token } = await login('tenant-j1', tenantPaths, 'portal',
        { username: 'CORP\\alice', password: SECRET, next: '/' }, { ip: '10.0.0.5' });
    t.after(() => siteAuth.dropSessions('tenant-j1', 'portal'));
    assert.ok(token);
    assert.deepStrictEqual(events, [
        { slug: 'tenant-j1', type: 'login', project: 'portal', username: 'alice', ip: '10.0.0.5' }
    ]);
    const lines = consoleLines.filter((l) => l.includes('tenant-j1/portal') && l.includes('site login'));
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes('10.0.0.5'), 'the console line carries the address');
});

test('every refused login is one login_refused with a short machine code, never the password', async (t) => {
    const events = collect(t);
    const slug = 'tenant-j2';
    const tenantPaths = seed(slug, 'portal');
    const cases = [
        [{ ok: false, error: 'ldap_invalid_credentials' }, 'bad_credentials'],
        [{ ok: false, error: 'ldap_user_not_found' }, 'bad_credentials'],
        [{ ok: false, error: 'ldap_account_locked' }, 'account_locked'],
        [{ ok: false, error: 'ldap_unreachable' }, 'directory_unreachable'],
        [{ ok: true, groups: ['CN=Other,DC=corp,DC=local'] }, 'not_in_group']
    ];
    let n = 0;
    for (const [answer, reason] of cases) {
        withVerifier(t, answer);
        await login(slug, tenantPaths, 'portal',
            { username: `user${n}`, password: SECRET }, { ip: `10.0.1.${n}` });
        n += 1;
        const e = events[events.length - 1];
        assert.strictEqual(events.length, n, `${reason}: one event per refusal`);
        assert.strictEqual(e.type, 'login_refused');
        assert.strictEqual(e.reason, reason);
        assert.strictEqual(e.username, `user${n - 1}`);
        assert.strictEqual(e.slug, slug);
    }
    assert.ok(!JSON.stringify(events).includes(SECRET), 'no password in any event');
    assert.ok(!consoleLines.some((l) => l.includes(SECRET)), 'no password in any console line');
});

test('a locked account is a login_refused with reason locked', async (t) => {
    const events = collect(t);
    const slug = 'tenant-j3';
    const tenantPaths = seed(slug, 'portal');
    withVerifier(t, { ok: false, error: 'ldap_invalid_credentials' });
    for (let i = 0; i < siteAuth.LOCK_THRESHOLD + 1; i++) {
        await login(slug, tenantPaths, 'portal', { username: 'mallory', password: SECRET }, { ip: '10.0.2.1' });
    }
    const last = events[events.length - 1];
    assert.strictEqual(last.type, 'login_refused');
    assert.strictEqual(last.reason, 'locked');
    t.after(() => siteAuth.dropFailures(slug, 'portal'));
});

test('a plain-HTTP request to a protected site is a login_refused site_not_tls, with no name', async (t) => {
    const events = collect(t);
    const tenantPaths = seed('tenant-j4', 'portal');
    const res = fakeRes();
    await siteAuth.gate(fakeReq('GET', '/', { secure: false, ip: '10.0.3.1' }), res,
        { slug: 'tenant-j4', tenantPaths, project: { id: 'portal', name: 'portal' } });
    assert.strictEqual(res.statusCode, 503);
    assert.deepStrictEqual(events, [
        { slug: 'tenant-j4', type: 'login_refused', project: 'portal', username: '', ip: '10.0.3.1', reason: 'site_not_tls' }
    ]);
});

test('a logout is one event for the person whose session it closed', async (t) => {
    const events = collect(t);
    const slug = 'tenant-j5';
    const tenantPaths = seed(slug, 'portal');
    withVerifier(t, { ok: true, groups: [VIEWERS_DN], login: 'alice' });
    const { token } = await login(slug, tenantPaths, 'portal', { username: 'alice', password: SECRET }, { ip: '10.0.4.1' });
    events.length = 0;
    const names = siteAuth.cookieNames(slug, 'portal');
    await siteAuth.gate(fakeReq('POST', '/__aegis/logout',
        { ip: '10.0.4.1', headers: { cookie: `${names.session}=${token}` } }), fakeRes(),
    { slug, tenantPaths, project: { id: 'portal', name: 'portal' } });
    assert.deepStrictEqual(events, [
        { slug, type: 'logout', project: 'portal', username: 'alice', ip: '10.0.4.1' }
    ]);
    // A logout with no session behind it is no event.
    await siteAuth.gate(fakeReq('POST', '/__aegis/logout', { ip: '10.0.4.1' }), fakeRes(),
        { slug, tenantPaths, project: { id: 'portal', name: 'portal' } });
    assert.strictEqual(events.length, 1);
});

test('closing sessions by hand is one session_closed per session, reason admin', async (t) => {
    const events = collect(t);
    const slug = 'tenant-j6';
    const tenantPaths = seed(slug, 'portal');
    t.after(() => siteAuth.dropSessions(slug, 'portal'));
    withVerifier(t, { ok: true, groups: [VIEWERS_DN] });
    await login(slug, tenantPaths, 'portal', { username: 'alice', password: SECRET }, { ip: '10.0.5.1' });
    await login(slug, tenantPaths, 'portal', { username: 'bob', password: SECRET }, { ip: '10.0.5.2' });
    events.length = 0;
    assert.strictEqual(siteAuth.dropSessionsFor(slug, 'portal'), 2);
    assert.strictEqual(events.length, 2);
    assert.deepStrictEqual(events.map((e) => e.type), ['session_closed', 'session_closed']);
    assert.deepStrictEqual(events.map((e) => e.reason), ['admin', 'admin']);
    assert.deepStrictEqual(events.map((e) => e.username).sort(), ['alice', 'bob']);
    assert.deepStrictEqual(events.map((e) => e.ip).sort(), ['10.0.5.1', '10.0.5.2']);
    assert.strictEqual(siteAuth.dropSessionsFor(slug, 'portal'), 0);
    assert.strictEqual(events.length, 2, 'nothing closed, nothing journalled');
});

async function writeAs(slug, tenantPaths, token) {
    const names = siteAuth.cookieNames(slug, 'portal');
    const res = fakeRes();
    await siteAuth.gate(fakeReq('POST', '/api/items', {
        ip: '10.0.6.1', headers: { cookie: `${names.session}=${token}` }
    }), res, { slug, tenantPaths, project: { id: 'portal', name: 'portal' } });
    return res;
}

test('a write refused by the directory is a revalidation_refused, with its reason', async (t) => {
    const events = collect(t);
    const slug = 'tenant-j7';
    const tenantPaths = seed(slug, 'portal');
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions(slug, 'portal'); });

    withVerifier(t, { ok: true, groups: [VIEWERS_DN], login: 'alice' });
    const first = await login(slug, tenantPaths, 'portal', { username: 'alice', password: SECRET }, { ip: '10.0.6.1' });
    siteAuth._setLookup(() => ({ ok: true, groups: ['CN=Other,DC=corp,DC=local'] }));
    events.length = 0;
    assert.strictEqual((await writeAs(slug, tenantPaths, first.token)).statusCode, 403);
    assert.deepStrictEqual(events, [
        { slug, type: 'revalidation_refused', project: 'portal', username: 'alice', ip: '10.0.6.1', reason: 'not_in_group' }
    ]);

    const second = await login(slug, tenantPaths, 'portal', { username: 'alice', password: SECRET }, { ip: '10.0.6.1' });
    siteAuth._setLookup(() => ({ ok: false, error: 'ldap_user_not_found' }));
    events.length = 0;
    assert.strictEqual((await writeAs(slug, tenantPaths, second.token)).statusCode, 403);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'revalidation_refused');
    assert.strictEqual(events[0].reason, 'account_not_found');

    // An unanswered directory refuses nothing, so it journals nothing.
    const third = await login(slug, tenantPaths, 'portal', { username: 'alice', password: SECRET }, { ip: '10.0.6.1' });
    siteAuth._setLookup(() => ({ ok: false, error: 'ldap_unreachable' }));
    events.length = 0;
    assert.strictEqual((await writeAs(slug, tenantPaths, third.token)).statusCode, 503);
    assert.strictEqual(events.length, 0);
});

test('the address is normalised: mapped IPv4 loses its prefix, an unknown one is "unknown"', async (t) => {
    const events = collect(t);
    const slug = 'tenant-j8';
    const tenantPaths = seed(slug, 'portal');
    t.after(() => { siteAuth.dropSessions(slug, 'portal'); siteAuth.dropFailures(slug, 'portal'); });
    withVerifier(t, { ok: false, error: 'ldap_invalid_credentials' });
    await login(slug, tenantPaths, 'portal', { username: 'a1', password: SECRET }, { ip: '::ffff:192.0.2.7' });
    await login(slug, tenantPaths, 'portal', { username: 'a2', password: SECRET }, { ip: '2001:db8::1' });
    await login(slug, tenantPaths, 'portal', { username: 'a3', password: SECRET }, { ip: '' });
    assert.deepStrictEqual(events.map((e) => e.ip), ['192.0.2.7', '2001:db8::1', 'unknown']);
});

test('another tenant\'s slug in the Host header, the URL or the form never moves the event', async (t) => {
    const events = collect(t);
    const owner = 'tenant-owner';
    const tenantPaths = seed(owner, 'portal');
    seed('tenant-victim', 'portal');
    t.after(() => siteAuth.dropSessions(owner, 'portal'));
    withVerifier(t, { ok: true, groups: [VIEWERS_DN], login: 'alice' });
    await login(owner, tenantPaths, 'portal', {
        username: 'alice', password: SECRET, slug: 'tenant-victim', tenant: 'tenant-victim', project: 'victim-app'
    }, {
        ip: '10.0.7.1',
        url: '/__aegis/login?slug=tenant-victim&project=victim-app',
        headers: { host: 'tenant-victim.corp.local', 'x-forwarded-host': 'tenant-victim.corp.local', 'x-tenant': 'tenant-victim' },
        form: { slug: 'tenant-victim' }
    });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].slug, owner);
    assert.strictEqual(events[0].project, 'portal');
    assert.ok(!events.some((e) => e.slug === 'tenant-victim'));
});

test('no sink: the console line is still written and nothing throws; a throwing sink changes nothing', async (t) => {
    const slug = 'tenant-j9';
    const tenantPaths = seed(slug, 'portal');
    t.after(() => siteAuth.dropSessions(slug, 'portal'));
    siteAuth.setAuditSink(null);
    withVerifier(t, { ok: true, groups: [VIEWERS_DN], login: 'alice' });
    const before = consoleLines.length;
    const { token } = await login(slug, tenantPaths, 'portal', { username: 'alice', password: SECRET }, { ip: '10.0.9.1' });
    assert.ok(token);
    assert.ok(consoleLines.slice(before).some((l) => l.includes('site login by alice') && l.includes('10.0.9.1')));

    siteAuth.setAuditSink(() => { throw new Error('journal down'); });
    t.after(() => siteAuth.setAuditSink(null));
    const again = await login(slug, tenantPaths, 'portal', { username: 'alice', password: SECRET }, { ip: '10.0.9.2' });
    assert.ok(again.token, 'a failing sink never refuses a visitor');
    assert.strictEqual(siteAuth.dropSessionsFor(slug, 'portal'), 2);
});

test('register() hands the host sink to the guard, and the admin close is journalled under the tenant of the request', async (t) => {
    const slug = 'tenant-reg';
    const tenantPaths = seed(slug, 'portal');
    const events = [];
    const table = new Map();
    const add = (m) => (p, ...chain) => table.set(`${m} ${p}`, chain);
    routes.register({ get: add('GET'), post: add('POST'), delete: add('DELETE'), put: add('PUT'), patch: add('PATCH') }, {
        requireRole: () => (req, res, next) => next(),
        pathsFor: () => tenantPaths,
        tenantsRoot: () => path.join(DATA_ROOT, 'tenants'),
        recordSiteEvent: (s, e) => { events.push(Object.assign({ slug: s }, e)); }
    });
    t.after(() => { siteAuth.setAuditSink(null); siteAuth.dropSessions(slug, 'portal'); });

    withVerifier(t, { ok: true, groups: [VIEWERS_DN], login: 'alice' });
    await login(slug, tenantPaths, 'portal', { username: 'alice', password: SECRET }, { ip: '10.0.8.1' });
    assert.strictEqual(events[events.length - 1].type, 'login');

    events.length = 0;
    const chain = table.get('DELETE /api/deploy/projects/:id/sessions');
    const req = { params: { id: 'portal' }, query: {}, tenant: { slug }, tenantPaths, user: { email: 'ops@corp.local' } };
    const answer = await new Promise((resolve, reject) => {
        const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve(b); return this; } };
        let i = 0;
        const next = () => Promise.resolve(chain[i++](req, res, next)).catch(reject);
        next();
    });
    assert.strictEqual(answer.closed, 1);
    assert.deepStrictEqual(events, [
        { slug, type: 'session_closed', project: 'portal', username: 'alice', ip: '10.0.8.1', reason: 'admin' }
    ]);
});
