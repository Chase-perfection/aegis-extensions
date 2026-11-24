/**
 * What a protected site tells core about its visitors.
 *
 * Every login, refused login, logout, administrator close, idle or expired
 * close and refused revalidation reaches the host's `recordSiteEvent` once, with the tenant slug
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

/**
 * Signs out the way a browser does: the GET shows the confirmation form and
 * its CSRF pair, the POST sends them back. Returns both answers.
 */
async function logout(slug, tenantPaths, id, token, ip) {
    const ctx = { slug, tenantPaths, project: { id, name: id } };
    const names = siteAuth.cookieNames(slug, id);
    const page = fakeRes();
    await siteAuth.gate(fakeReq('GET', '/__aegis/logout',
        { ip, headers: { cookie: `${names.session}=${token}` } }), page, ctx);
    const csrf = cookieValue(page.headers['Set-Cookie'], names.csrf);
    const res = fakeRes();
    await siteAuth.gate(fakeReq('POST', '/__aegis/logout', {
        ip,
        body: new URLSearchParams({ csrf }).toString(),
        headers: {
            cookie: `${names.session}=${token}; ${names.csrf}=${csrf}`,
            'content-type': 'application/x-www-form-urlencoded'
        }
    }), res, ctx);
    return { page, res };
}

/** Moves the clock the guard reads, for the body of one test. */
function fakeClock(t) {
    const real = Date.now;
    let skew = 0;
    Date.now = () => real() + skew;
    t.after(() => { Date.now = real; });
    return (ms) => { skew += ms; };
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
    t.after(() => siteAuth.dropFailures(slug));
});

test('plain-HTTP requests to a protected site are a configuration fault: no event, one console line an hour', async (t) => {
    const events = collect(t);
    const tenantPaths = seed('tenant-j4', 'portal');
    const before = consoleLines.length;
    for (let i = 0; i < 50; i++) {
        const res = fakeRes();
        await siteAuth.gate(fakeReq('GET', i % 2 ? '/__aegis/site.css' : '/', { secure: false, ip: `10.0.3.${i}` }), res,
            { slug: 'tenant-j4', tenantPaths, project: { id: 'portal', name: 'portal' } });
        assert.strictEqual(res.statusCode, 503);
    }
    assert.strictEqual(events.length, 0, 'nothing reaches the journal');
    const lines = consoleLines.slice(before).filter((l) => l.includes('tenant-j4/portal') && l.includes('site_not_tls'));
    assert.strictEqual(lines.length, 1, 'one console line for fifty requests');
});

test('a visitor-supplied name cannot forge a console line', async (t) => {
    collect(t);
    const slug = 'tenant-j4b';
    const tenantPaths = seed(slug, 'portal');
    withVerifier(t, { ok: false, error: 'ldap_invalid_credentials' });
    const before = consoleLines.length;
    const sep = String.fromCharCode(0x2028, 0x85, 0x7f, 0);
    const evil = 'bob\r\n[Deploy] tenant-x/portal: site login by admin' + sep + 'x'.repeat(400);
    await login(slug, tenantPaths, 'portal', { username: evil, password: SECRET }, { ip: '10.0.3.50' });
    t.after(() => siteAuth.dropFailures(slug));
    const lines = consoleLines.slice(before).filter((l) => l.includes(`${slug}/portal`));
    assert.ok(lines.length >= 1);
    for (const l of lines) {
        const codes = Array.from(l).map((c) => c.charCodeAt(0));
        assert.ok(!codes.some((n) => n < 0x20 || n === 0x7f || n === 0x85 || n === 0x2028 || n === 0x2029),
            'no control or line separator in a console line');
        assert.ok(l.length < 420, 'the visitor value is capped');
    }
});

test('each directory refusal has its own code; TLS and configuration faults are directory_config', async (t) => {
    const events = collect(t);
    const slug = 'tenant-j4c';
    const tenantPaths = seed(slug, 'portal');
    t.after(() => siteAuth.dropFailures(slug));
    const cases = [
        ['ldap_account_disabled', 'account_disabled'], ['ldap_account_expired', 'account_expired'],
        ['ldap_password_expired', 'password_expired'], ['ldap_password_must_change', 'password_expired'],
        ['ldap_logon_denied', 'logon_denied'],
        ['ldap_requires_tls', 'directory_config'], ['ldap_requires_validation', 'directory_config'],
        ['ldap_bad_config', 'directory_config'], ['ldap_tls_untrusted', 'directory_config'],
        ['ldap_tls_expired', 'directory_config'], ['ldap_tls_name_mismatch', 'directory_config'],
        ['ldap_tls_failed', 'directory_config'], ['ldap_not_tls', 'directory_config'],
        ['ldap_timeout', 'directory_unreachable'], ['ldap_protocol_error', 'directory_unreachable']
    ];
    let n = 0;
    for (const [error, reason] of cases) {
        withVerifier(t, { ok: false, error });
        await login(slug, tenantPaths, 'portal', { username: `d${n}`, password: SECRET }, { ip: `10.1.9.${n}` });
        n += 1;
        assert.strictEqual(events.length, n, error);
        assert.strictEqual(events[n - 1].reason, reason, error);
    }
});

test('no SID with named people, and a CSRF mismatch, have their own codes', async (t) => {
    const events = collect(t);
    const slug = 'tenant-j4d';
    const tenantPaths = seed(slug, 'portal', { allowedGroups: [], allowedUsers: [{ sid: 'S-1-5-21-1-2-3-1103' }] });
    t.after(() => siteAuth.dropFailures(slug));
    withVerifier(t, { ok: true, groups: [VIEWERS_DN] });   // no sid
    await login(slug, tenantPaths, 'portal', { username: 'carol', password: SECRET }, { ip: '10.1.8.1' });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].reason, 'identity_unreadable');

    // A POST whose form token does not match its cookie.
    const ctx = { slug, tenantPaths, project: { id: 'portal', name: 'portal' } };
    const names = siteAuth.cookieNames(slug, 'portal');
    await siteAuth.gate(fakeReq('POST', '/__aegis/login', {
        body: new URLSearchParams({ csrf: 'forged', username: 'carol', password: SECRET }).toString(),
        ip: '10.1.8.2',
        headers: { cookie: `${names.csrf}=other`, 'content-type': 'application/x-www-form-urlencoded' }
    }), fakeRes(), ctx);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[1].reason, 'bad_session');
});

test('a second post while one bind is in flight, and a full failure map, are both reason locked', async (t) => {
    const events = collect(t);
    const slug = 'tenant-j4e';
    const tenantPaths = seed(slug, 'portal');
    t.after(() => siteAuth.dropFailures(slug));
    let release;
    const open = new Promise((r) => { release = r; });
    withVerifier(t, async () => { await open; return { ok: false, error: 'ldap_invalid_credentials' }; });
    const first = login(slug, tenantPaths, 'portal', { username: 'erin', password: SECRET }, { ip: '10.1.7.1' });
    await new Promise((r) => setTimeout(r, 50));
    await login(slug, tenantPaths, 'portal', { username: 'erin', password: SECRET }, { ip: '10.1.7.2' });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].reason, 'locked');
    release();
    await first;
    assert.strictEqual(events[1].reason, 'bad_credentials');

    events.length = 0;
    const policy = { cap: 3, windowMs: 30 * 60 * 1000 };
    for (let i = 0; i < siteAuth.MAX_FAILURE_ENTRIES + 50; i++) {
        siteAuth._noteUserFailure(slug, 'portal', `spray${i}`, policy);
    }
    withVerifier(t, { ok: false, error: 'ldap_invalid_credentials' });
    await login(slug, tenantPaths, 'portal', { username: 'newcomer', password: SECRET }, { ip: '10.1.7.3' });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].reason, 'locked');
});

test('the background timer dropping a session is a revalidation_refused', async (t) => {
    const events = collect(t);
    const slug = 'tenant-j4f';
    const tenantPaths = seed(slug, 'portal');
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions(slug, 'portal'); });
    withVerifier(t, { ok: true, groups: [VIEWERS_DN], login: 'alice' });
    const { token } = await login(slug, tenantPaths, 'portal', { username: 'alice', password: SECRET }, { ip: '10.1.6.1' });
    siteAuth._setLookup(() => ({ ok: true, groups: ['CN=Other,DC=corp,DC=local'] }));
    events.length = 0;
    const real = Date.now;
    Date.now = () => real() + 11 * 60 * 1000;
    t.after(() => { Date.now = real; });
    const names = siteAuth.cookieNames(slug, 'portal');
    const res = fakeRes();
    siteAuth.gate(fakeReq('GET', '/', { ip: '10.1.6.1', headers: { cookie: `${names.session}=${token}` } }), res,
        { slug, tenantPaths, project: { id: 'portal', name: 'portal' } });
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(events, [
        { slug, type: 'revalidation_refused', project: 'portal', username: 'alice', ip: '10.1.6.1', reason: 'not_in_group' }
    ]);
});

test('a logout is one event for the person whose session it closed', async (t) => {
    const events = collect(t);
    const slug = 'tenant-j5';
    const tenantPaths = seed(slug, 'portal');
    withVerifier(t, { ok: true, groups: [VIEWERS_DN], login: 'alice' });
    const { token } = await login(slug, tenantPaths, 'portal', { username: 'alice', password: SECRET }, { ip: '10.0.4.1' });
    events.length = 0;
    await logout(slug, tenantPaths, 'portal', token, '10.0.4.1');
    assert.deepStrictEqual(events, [
        { slug, type: 'logout', project: 'portal', username: 'alice', ip: '10.0.4.1' }
    ]);
    // A logout with no session behind it is no event.
    await siteAuth.gate(fakeReq('POST', '/__aegis/logout', { ip: '10.0.4.1' }), fakeRes(),
        { slug, tenantPaths, project: { id: 'portal', name: 'portal' } });
    assert.strictEqual(events.length, 1);
});

test('a logout without the form token closes nothing and journals nothing', async (t) => {
    const events = collect(t);
    const slug = 'tenant-j5b';
    const tenantPaths = seed(slug, 'portal');
    t.after(() => siteAuth.dropSessions(slug, 'portal'));
    withVerifier(t, { ok: true, groups: [VIEWERS_DN], login: 'alice' });
    const { token } = await login(slug, tenantPaths, 'portal', { username: 'alice', password: SECRET }, { ip: '10.0.4.2' });
    events.length = 0;
    const ctx = { slug, tenantPaths, project: { id: 'portal', name: 'portal' } };
    const names = siteAuth.cookieNames(slug, 'portal');
    const cookie = `${names.session}=${token}`;

    // A link from another site: a GET. It shows a confirmation, it does not sign out.
    const viaLink = fakeRes();
    await siteAuth.gate(fakeReq('GET', '/__aegis/logout', { ip: '10.0.4.2', headers: { cookie } }), viaLink, ctx);
    assert.strictEqual(viaLink.statusCode, 200);
    assert.match(viaLink.body, /<form[^>]*method="post"[^>]*action="\/__aegis\/logout"/);
    assert.match(viaLink.body, /name="csrf" value="[^"]+"/);

    // A form posted from another site: no token, or a token without its cookie.
    for (const req of [
        fakeReq('POST', '/__aegis/logout', { ip: '10.0.4.2', headers: { cookie } }),
        fakeReq('POST', '/__aegis/logout', {
            ip: '10.0.4.2', body: 'csrf=forged',
            headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }
        })
    ]) {
        const res = fakeRes();
        await siteAuth.gate(req, res, ctx);
        assert.strictEqual(res.statusCode, 400);
        assert.ok(!String(res.headers['Set-Cookie'] || '').includes(`${names.session}=;`));
    }

    const still = fakeRes();
    const handled = await siteAuth.gate(fakeReq('GET', '/', { ip: '10.0.4.2', headers: { cookie } }), still, ctx);
    assert.strictEqual(handled, false, 'the session is still open');
    assert.deepStrictEqual(events, []);
});

test('a session closed by the idle timeout is one session_closed, reason idle', async (t) => {
    const events = collect(t);
    const advance = fakeClock(t);
    const slug = 'tenant-j5c';
    const tenantPaths = seed(slug, 'portal');
    t.after(() => siteAuth.dropSessions(slug, 'portal'));
    withVerifier(t, { ok: true, groups: [VIEWERS_DN], login: 'alice' });
    await login(slug, tenantPaths, 'portal', { username: 'alice', password: SECRET }, { ip: '10.0.4.3' });
    events.length = 0;
    advance(siteAuth.IDLE_MS + 1000);
    siteAuth._sweepSessions();
    assert.deepStrictEqual(events.filter((e) => e.slug === slug), [
        { slug, type: 'session_closed', project: 'portal', username: 'alice', ip: '10.0.4.3', reason: 'idle' }
    ]);
    siteAuth._sweepSessions();
    assert.strictEqual(events.filter((e) => e.slug === slug).length, 1, 'one event per session, once');
});

test('a session that reaches the eight hour cap is one session_closed, reason expired', async (t) => {
    const events = collect(t);
    const advance = fakeClock(t);
    const slug = 'tenant-j5d';
    const tenantPaths = seed(slug, 'portal');
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions(slug, 'portal'); });
    withVerifier(t, { ok: true, groups: [VIEWERS_DN], login: 'alice' });
    // The periodic group check still finds her entitled all day.
    siteAuth._setLookup(() => ({ ok: true, groups: [VIEWERS_DN], login: 'alice' }));
    const { token } = await login(slug, tenantPaths, 'portal', { username: 'alice', password: SECRET }, { ip: '10.0.4.4' });
    events.length = 0;
    const ctx = { slug, tenantPaths, project: { id: 'portal', name: 'portal' } };
    const cookie = `${siteAuth.cookieNames(slug, 'portal').session}=${token}`;
    // Active all day: a request every 20 minutes keeps the idle timeout away.
    for (let i = 0; i < 25; i++) {
        advance(20 * 60 * 1000);
        await siteAuth.gate(fakeReq('GET', '/', { ip: '10.0.4.4', headers: { cookie } }), fakeRes(), ctx);
    }
    assert.deepStrictEqual(events.filter((e) => e.slug === slug && e.type === 'session_closed'), [
        { slug, type: 'session_closed', project: 'portal', username: 'alice', ip: '10.0.4.4', reason: 'expired' }
    ]);
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
    t.after(() => { siteAuth.dropSessions(slug, 'portal'); siteAuth.dropFailures(slug); });
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
