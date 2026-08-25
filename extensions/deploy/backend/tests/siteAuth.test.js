/**
 * Tests for the deployed-site access guard and the per-tenant directory store.
 *
 * Two things shape this file.
 *
 * `ldap.js` opens sockets to a domain controller, so nothing here touches it.
 * `siteAuth._setVerifier` replaces the verifier with a function that answers
 * from a table, which is what makes the refusal, lockout and success paths
 * testable at all. `siteAuth._setLookup` does the same for the passwordless
 * question the background revalidation asks. The real client has its own tests.
 *
 * `AEGIS_DATA_ROOT` is set before anything is required, so `machineStore`
 * creates its encryption key inside a temporary folder instead of
 * C:\ProgramData\Aegis. Without it these tests would write to the machine.
 *
 * The last two sections leave the fabricated request objects behind and start
 * real listeners, because `siteServer`'s TLS behaviour is only observable from
 * a socket: the question "did a site marked HTTPS come up in clear" cannot be
 * answered by inspecting a return value.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-deploy-data-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const https = require('https');
const { Readable } = require('stream');
const { spawnSync } = require('node:child_process');

const siteAuth = require('../siteAuth');
const authStore = require('../authStore');
const projectStore = require('../projectStore');
const siteServer = require('../siteServer');

// The guard logs refusals on purpose. Muted here so a passing run is readable;
// a failing assertion still reports everything that matters.
console.log = () => {};
console.warn = () => {};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function newTenant() {
    return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-tenant-')) };
}

function fakeReq(method, url, opts) {
    const o = opts || {};
    const req = Readable.from(o.body === undefined ? [] : [Buffer.from(o.body, 'utf8')]);
    req.method = method;
    req.url = url;
    req.headers = Object.assign({}, o.headers);
    // `encrypted` is the only thing `isSecure` looks at, and a real TLS socket
    // is the only thing that sets it. Absent means plain HTTP.
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

const GOOD_CONFIG = {
    url: 'ldap://dc01.corp.local:389',
    baseDn: 'DC=corp,DC=local',
    bindDn: 'CN=svc,DC=corp,DC=local',
    bindPassword: 'service-secret'
};

/* ------------------------------------------------------------------ */
/* group matching (section C)                                          */
/* ------------------------------------------------------------------ */

test('group matching: empty allow list lets any authenticated user through', () => {
    assert.strictEqual(siteAuth._groupAllowed([], ['CN=Anything,DC=corp,DC=local']), true);
    assert.strictEqual(siteAuth._groupAllowed([], []), true);
});

test('group matching: a bare CN matches the full DN it came from', () => {
    const groups = ['CN=Domain Admins,CN=Users,DC=corp,DC=local'];
    assert.strictEqual(siteAuth._groupAllowed(['Domain Admins'], groups), true);
    assert.strictEqual(siteAuth._groupAllowed(['domain admins'], groups), true);
    assert.strictEqual(siteAuth._groupAllowed(['  Domain   Admins  '], groups), true);
});

test('group matching: the full DN matches, case-insensitively', () => {
    const groups = ['CN=Domain Admins,CN=Users,DC=corp,DC=local'];
    assert.strictEqual(
        siteAuth._groupAllowed(['cn=domain admins,cn=users,dc=corp,dc=local'], groups), true);
});

test('group matching: a non-member is refused', () => {
    const groups = ['CN=Helpdesk,OU=Groups,DC=corp,DC=local'];
    assert.strictEqual(siteAuth._groupAllowed(['Domain Admins'], groups), false);
    assert.strictEqual(siteAuth._groupAllowed(['Domain Admins'], []), false);
    // A CN is not a prefix match: "Admins" must not open a site meant for
    // "Domain Admins".
    assert.strictEqual(siteAuth._groupAllowed(['Admins'], groups), false);
});

test('group matching: an escaped comma inside a CN is read as one name', () => {
    assert.strictEqual(siteAuth._firstCn('CN=Ops\\, Paris,OU=Groups,DC=corp,DC=local'), 'Ops, Paris');
    assert.strictEqual(
        siteAuth._groupAllowed(['Ops, Paris'], ['CN=Ops\\, Paris,OU=Groups,DC=corp,DC=local']), true);
});

/* ------------------------------------------------------------------ */
/* the next parameter                                                  */
/* ------------------------------------------------------------------ */

test('next: a scheme-relative path is refused, a real path is kept', () => {
    assert.strictEqual(siteAuth._safeNext('//evil.com'), '/');
    assert.strictEqual(siteAuth._safeNext('//evil.com/path'), '/');
    assert.strictEqual(siteAuth._safeNext('/\\evil.com'), '/');
    assert.strictEqual(siteAuth._safeNext('https://evil.com'), '/');
    assert.strictEqual(siteAuth._safeNext('http://evil.com'), '/');
    assert.strictEqual(siteAuth._safeNext('evil.com'), '/');
    assert.strictEqual(siteAuth._safeNext(''), '/');
    assert.strictEqual(siteAuth._safeNext(null), '/');
    assert.strictEqual(siteAuth._safeNext(undefined), '/');

    assert.strictEqual(siteAuth._safeNext('/a/b'), '/a/b');
    assert.strictEqual(siteAuth._safeNext('/a/b?x=1&y=2'), '/a/b?x=1&y=2');
    assert.strictEqual(siteAuth._safeNext('/'), '/');
});

test('next: control characters and the reserved prefix fall back to the root', () => {
    assert.strictEqual(siteAuth._safeNext('/a\r\nSet-Cookie: x=1'), '/');
    assert.strictEqual(siteAuth._safeNext('/a b'), '/');
    assert.strictEqual(siteAuth._safeNext('/__aegis/login'), '/');
    assert.strictEqual(siteAuth._safeNext('/__aegis'), '/');
});

/* ------------------------------------------------------------------ */
/* lockout                                                             */
/* ------------------------------------------------------------------ */

test('lockout: five failures lock the pair, a success clears it', () => {
    const ip = '192.0.2.77';
    const pid = 'lock-test';
    siteAuth._clearFailures(ip, pid);

    for (let i = 1; i <= siteAuth.LOCK_THRESHOLD - 1; i++) {
        siteAuth._noteFailure(ip, pid);
        assert.strictEqual(siteAuth._lockRemaining(ip, pid), 0, `attempt ${i} must not lock`);
    }

    siteAuth._noteFailure(ip, pid);
    const left = siteAuth._lockRemaining(ip, pid);
    assert.ok(left > 0 && left <= siteAuth.LOCK_MS / 1000, `expected a lock, got ${left}`);

    siteAuth._clearFailures(ip, pid);
    assert.strictEqual(siteAuth._lockRemaining(ip, pid), 0);
});

test('lockout: counters are per ip and per project', () => {
    const pid = 'lock-scope';
    siteAuth._clearFailures('198.51.100.1', pid);
    siteAuth._clearFailures('198.51.100.2', pid);
    for (let i = 0; i < siteAuth.LOCK_THRESHOLD; i++) siteAuth._noteFailure('198.51.100.1', pid);
    assert.ok(siteAuth._lockRemaining('198.51.100.1', pid) > 0);
    assert.strictEqual(siteAuth._lockRemaining('198.51.100.2', pid), 0);
    siteAuth._clearFailures('198.51.100.1', pid);
});

/* ------------------------------------------------------------------ */
/* the gate                                                            */
/* ------------------------------------------------------------------ */

test('gate: an unprotected project is passed straight through', async () => {
    const slug = 'tenant-open';
    const tenantPaths = seed(slug, 'open-site', { name: 'Open site' }, null);
    const res = fakeRes();
    const handled = await siteAuth.gate(fakeReq('GET', '/index.html'), res, {
        slug, tenantPaths, project: { id: 'open-site', name: 'Open site' }
    });
    assert.strictEqual(handled, false);
    assert.strictEqual(res.headersSent, false, 'the guard must not answer for an open site');
});

test('gate: an auth record with enabled:false is still open', async () => {
    const slug = 'tenant-off';
    const tenantPaths = seed(slug, 'off-site',
        { name: 'Off', auth: { enabled: false, allowedGroups: ['Domain Admins'] } }, GOOD_CONFIG);
    const res = fakeRes();
    const handled = await siteAuth.gate(fakeReq('GET', '/'), res, {
        slug, tenantPaths, project: { id: 'off-site', name: 'Off' }
    });
    assert.strictEqual(handled, false);
});

test('gate: the /__aegis/ prefix is reserved even on an unprotected site', async () => {
    const slug = 'tenant-open2';
    const tenantPaths = seed(slug, 'open2', { name: 'Open' }, null);
    for (const url of ['/__aegis/login', '/__aegis/anything', '/__aegis']) {
        const res = fakeRes();
        const handled = await siteAuth.gate(fakeReq('GET', url), res, {
            slug, tenantPaths, project: { id: 'open2', name: 'Open' }
        });
        assert.strictEqual(handled, true, `${url} must be intercepted`);
        assert.strictEqual(res.statusCode, 404);
    }
});

test('gate: a protected project with no directory configured is refused, not served', async () => {
    const slug = 'tenant-noconf';
    const tenantPaths = seed(slug, 'locked',
        { name: 'Locked', auth: { enabled: true, allowedGroups: [] } }, null);

    for (const url of ['/', '/index.html', '/__aegis/login']) {
        const res = fakeRes();
        const handled = await siteAuth.gate(fakeReq('GET', url), res, {
            slug, tenantPaths, project: { id: 'locked', name: 'Locked' }
        });
        assert.strictEqual(handled, true, `${url} must never reach the file server`);
        assert.strictEqual(res.statusCode, 503, `${url} must fail closed`);
    }

    // A half-written directory record is the same as none.
    authStore.writeConfig(tenantPaths, { url: 'ldap://dc01.corp.local:389', baseDn: '' });
    siteAuth.invalidate(slug, 'locked');
    const res = fakeRes();
    const handled = await siteAuth.gate(fakeReq('GET', '/'), res, {
        slug, tenantPaths, project: { id: 'locked', name: 'Locked' }
    });
    assert.strictEqual(handled, true);
    assert.strictEqual(res.statusCode, 503);
});

test('gate: an anonymous request to a protected site is redirected to the login', async () => {
    const slug = 'tenant-prot';
    const tenantPaths = seed(slug, 'prot',
        { name: 'Prot', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const res = fakeRes();
    const handled = await siteAuth.gate(fakeReq('GET', '/deep/page.html?a=1'), res, {
        slug, tenantPaths, project: { id: 'prot', name: 'Prot' }
    });
    assert.strictEqual(handled, true);
    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.headers.Location,
        '/__aegis/login?next=' + encodeURIComponent('/deep/page.html?a=1'));
});

/* ------------------------------------------------------------------ */
/* template rendering and escaping                                     */
/* ------------------------------------------------------------------ */

test('escaping: all five characters are replaced', () => {
    assert.strictEqual(
        siteAuth._escapeHtml(`<img src="x" onerror='y'>&`),
        '&lt;img src=&quot;x&quot; onerror=&#39;y&#39;&gt;&amp;');
    assert.strictEqual(siteAuth._escapeHtml(null), '');
    assert.strictEqual(siteAuth._escapeHtml(undefined), '');
});

test('escaping: a hostile site name cannot break out of the login template', () => {
    const body = siteAuth._renderLogin({
        lang: 'en',
        siteName: '</title><script>alert(1)</script>',
        next: '/a/b" onload="alert(2)',
        error: '<b>boom</b>',
        csrf: 'tok"en',
        username: `o'brien<`
    });
    assert.ok(body, 'the template must be readable from disk');
    assert.ok(!/<script>/.test(body), 'no raw script tag may survive');
    assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(body.includes('&quot; onload=&quot;alert(2)'));
    assert.ok(body.includes('&lt;b&gt;boom&lt;/b&gt;'));
    assert.ok(body.includes('value="tok&quot;en"'));
    assert.ok(body.includes('o&#39;brien&lt;'));
});

test('login page: it is read from disk and carries no password field value', async () => {
    const slug = 'tenant-page';
    const tenantPaths = seed(slug, 'page',
        { name: '<b>Sales</b>', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const res = fakeRes();
    const handled = await siteAuth.gate(
        fakeReq('GET', '/__aegis/login?next=%2Freports', { headers: { 'accept-language': 'fr-FR,fr;q=0.9' } }),
        res, { slug, tenantPaths, project: { id: 'page', name: '<b>Sales</b>' } });

    assert.strictEqual(handled, true);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.includes('&lt;b&gt;Sales&lt;/b&gt;'), 'the site name must be escaped');
    assert.ok(res.body.includes('Se connecter'), 'Accept-Language fr must select the French block');
    assert.ok(res.body.includes('name="next" value="/reports"'));
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(res.body), 'every placeholder must be substituted');
    assert.ok(/id="password"[^>]*>/.test(res.body));
    assert.ok(!/id="password"[^>]*value=/.test(res.body), 'the password field must never carry a value');
    assert.ok(String(res.headers['Set-Cookie']).includes('aegis_site_csrf='));
});

test('login page: Accept-Language chooses English when French is not asked for', async () => {
    const slug = 'tenant-page-en';
    const tenantPaths = seed(slug, 'pageen',
        { name: 'Sales', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const res = fakeRes();
    await siteAuth.gate(
        fakeReq('GET', '/__aegis/login', { headers: { 'accept-language': 'en-GB,en;q=0.9' } }),
        res, { slug, tenantPaths, project: { id: 'pageen', name: 'Sales' } });
    assert.ok(res.body.includes('Sign in'));
});

/* ------------------------------------------------------------------ */
/* the login exchange, with an injected verifier                       */
/* ------------------------------------------------------------------ */

const SECRET = 'correct-horse-battery';

async function login(slug, tenantPaths, projectId, fields, opts) {
    const o = opts || {};
    // First the form, to obtain the CSRF pair the POST has to present.
    const get = fakeRes();
    await siteAuth.gate(fakeReq('GET', '/__aegis/login', { secure: o.secure }), get,
        { slug, tenantPaths, project: { id: projectId, name: projectId } });
    const csrf = cookieValue(get.headers['Set-Cookie'], 'aegis_site_csrf');

    const body = new URLSearchParams(Object.assign({ csrf }, fields)).toString();
    const res = fakeRes();
    const handled = await siteAuth.gate(fakeReq('POST', '/__aegis/login', {
        body,
        ip: o.ip || '10.0.0.9',
        secure: o.secure,
        headers: {
            cookie: `aegis_site_csrf=${csrf}`,
            'content-type': 'application/x-www-form-urlencoded'
        }
    }), res, { slug, tenantPaths, project: { id: projectId, name: projectId } });
    return { res, handled };
}

test('login: a valid user is given a session and sent to the validated next', async () => {
    const slug = 'tenant-login';
    const tenantPaths = seed(slug, 'app',
        { name: 'App', auth: { enabled: true, allowedGroups: ['Domain Admins'] } }, GOOD_CONFIG);

    let seenPassword = null;
    siteAuth._setVerifier((config, username, password) => {
        seenPassword = password;
        assert.strictEqual(config.bindPassword, 'service-secret',
            'the verifier must receive the decrypted bind password');
        return { ok: true, dn: 'CN=J Doe,DC=corp,DC=local', displayName: 'J Doe',
            groups: ['CN=Domain Admins,CN=Users,DC=corp,DC=local'] };
    });

    try {
        const { res, handled } = await login(slug, tenantPaths, 'app',
            { username: 'jdoe', password: SECRET, next: '/a/b' });

        assert.strictEqual(handled, true);
        assert.strictEqual(res.statusCode, 302);
        assert.strictEqual(res.headers.Location, '/a/b');
        assert.strictEqual(seenPassword, SECRET, 'the verifier is the only consumer of the password');

        const setCookie = String(res.headers['Set-Cookie']);
        assert.ok(setCookie.includes('HttpOnly'));
        assert.ok(setCookie.includes('SameSite=Lax'));
        assert.ok(!/;\s*Secure/i.test(setCookie), 'Secure is deliberately absent over plain HTTP');
        assert.ok(!(res.body + JSON.stringify(res.headers)).includes(SECRET),
            'the password must not appear anywhere in the response');

        // The session it just minted opens the site.
        const token = cookieValue(setCookie, 'aegis_site');
        const res2 = fakeRes();
        const handled2 = await siteAuth.gate(
            fakeReq('GET', '/a/b', { headers: { cookie: `aegis_site=${token}` } }), res2,
            { slug, tenantPaths, project: { id: 'app', name: 'App' } });
        assert.strictEqual(handled2, false, 'an authenticated request must be served');

        // The same token on another project is not a session there.
        const otherPaths = seed('tenant-other', 'app',
            { name: 'App', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
        const res3 = fakeRes();
        const handled3 = await siteAuth.gate(
            fakeReq('GET', '/', { headers: { cookie: `aegis_site=${token}` } }), res3,
            { slug: 'tenant-other', tenantPaths: otherPaths, project: { id: 'app', name: 'App' } });
        assert.strictEqual(handled3, true);
        assert.strictEqual(res3.statusCode, 302);
    } finally {
        siteAuth._setVerifier(null);
    }
});

test('login: an authenticated user outside the allowed groups is refused', async () => {
    const slug = 'tenant-group';
    const tenantPaths = seed(slug, 'grp',
        { name: 'Grp', auth: { enabled: true, allowedGroups: ['Domain Admins'] } }, GOOD_CONFIG);

    siteAuth._setVerifier(() => ({
        ok: true, dn: 'CN=Temp,DC=corp,DC=local',
        groups: ['CN=Helpdesk,OU=Groups,DC=corp,DC=local']
    }));
    try {
        const { res } = await login(slug, tenantPaths, 'grp',
            { username: 'temp', password: SECRET, next: '/' }, { ip: '10.0.0.31' });
        assert.strictEqual(res.statusCode, 403);
        assert.ok(!res.body.includes(SECRET));
        assert.strictEqual(cookieValue(res.headers['Set-Cookie'], 'aegis_site'), null);
    } finally {
        siteAuth._setVerifier(null);
        siteAuth._clearFailures('10.0.0.31', 'grp');
    }
});

test('login: bad credentials re-render the form with the username and never the password', async () => {
    const slug = 'tenant-bad';
    const tenantPaths = seed(slug, 'bad',
        { name: 'Bad', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);

    siteAuth._setVerifier(() => ({ ok: false, error: 'ldap_invalid_credentials' }));
    try {
        const { res } = await login(slug, tenantPaths, 'bad',
            { username: 'jdoe', password: SECRET, next: '/' }, { ip: '10.0.0.41' });
        assert.strictEqual(res.statusCode, 401);
        assert.ok(res.body.includes('value="jdoe"'), 'the username is kept for convenience');
        assert.ok(!res.body.includes(SECRET), 'the password is never echoed');
        assert.ok(!res.body.includes('ldap_invalid_credentials'),
            'the machine code stays out of the page');
    } finally {
        siteAuth._setVerifier(null);
        siteAuth._clearFailures('10.0.0.41', 'bad');
    }
});

test('login: the sixth attempt from one address is answered with 429', async () => {
    const slug = 'tenant-brute';
    const tenantPaths = seed(slug, 'brute',
        { name: 'Brute', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const ip = '203.0.113.9';
    siteAuth._clearFailures(ip, 'brute');

    siteAuth._setVerifier(() => ({ ok: false, error: 'ldap_invalid_credentials' }));
    try {
        for (let i = 0; i < siteAuth.LOCK_THRESHOLD; i++) {
            const { res } = await login(slug, tenantPaths, 'brute',
                { username: 'jdoe', password: 'wrong', next: '/' }, { ip });
            assert.strictEqual(res.statusCode, 401, `attempt ${i + 1} should still be answered`);
        }
        const { res } = await login(slug, tenantPaths, 'brute',
            { username: 'jdoe', password: 'wrong', next: '/' }, { ip });
        assert.strictEqual(res.statusCode, 429);
        assert.ok(Number(res.headers['Retry-After']) > 0);
        assert.ok(/\b\d+\b/.test(res.body), 'the page states how long is left');
    } finally {
        siteAuth._setVerifier(null);
        siteAuth._clearFailures(ip, 'brute');
    }
});

test('login: a POST without the matching CSRF cookie is rejected', async () => {
    const slug = 'tenant-csrf';
    const tenantPaths = seed(slug, 'csrf',
        { name: 'Csrf', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);

    let called = false;
    siteAuth._setVerifier(() => { called = true; return { ok: true, groups: [] }; });
    try {
        const res = fakeRes();
        await siteAuth.gate(fakeReq('POST', '/__aegis/login', {
            ip: '10.0.0.51',
            body: 'username=jdoe&password=x&csrf=forged&next=%2F'
        }), res, { slug, tenantPaths, project: { id: 'csrf', name: 'Csrf' } });
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(called, false, 'the directory is not consulted for a forged post');
    } finally {
        siteAuth._setVerifier(null);
        siteAuth._clearFailures('10.0.0.51', 'csrf');
    }
});

test('login: a body over the cap is rejected without reaching the directory', async () => {
    const slug = 'tenant-big';
    const tenantPaths = seed(slug, 'big',
        { name: 'Big', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);

    let called = false;
    siteAuth._setVerifier(() => { called = true; return { ok: true, groups: [] }; });
    try {
        const res = fakeRes();
        await siteAuth.gate(fakeReq('POST', '/__aegis/login', {
            ip: '10.0.0.61',
            body: 'username=jdoe&password=' + 'a'.repeat(16 * 1024)
        }), res, { slug, tenantPaths, project: { id: 'big', name: 'Big' } });
        assert.ok(res.statusCode === 400, `expected 400, got ${res.statusCode}`);
        assert.strictEqual(called, false);
    } finally {
        siteAuth._setVerifier(null);
        siteAuth._clearFailures('10.0.0.61', 'big');
    }
});

test('logout: the session is dropped and the cookie expired', async () => {
    const slug = 'tenant-out';
    const tenantPaths = seed(slug, 'out',
        { name: 'Out', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);

    siteAuth._setVerifier(() => ({ ok: true, groups: [] }));
    try {
        const { res } = await login(slug, tenantPaths, 'out',
            { username: 'jdoe', password: SECRET, next: '/' }, { ip: '10.0.0.71' });
        const token = cookieValue(res.headers['Set-Cookie'], 'aegis_site');
        assert.ok(token);

        const out = fakeRes();
        await siteAuth.gate(fakeReq('POST', '/__aegis/logout',
            { headers: { cookie: `aegis_site=${token}` } }), out,
        { slug, tenantPaths, project: { id: 'out', name: 'Out' } });
        assert.strictEqual(out.statusCode, 302);
        assert.ok(String(out.headers['Set-Cookie']).includes('Max-Age=0'));

        const after = fakeRes();
        const handled = await siteAuth.gate(
            fakeReq('GET', '/', { headers: { cookie: `aegis_site=${token}` } }), after,
            { slug, tenantPaths, project: { id: 'out', name: 'Out' } });
        assert.strictEqual(handled, true);
        assert.strictEqual(after.statusCode, 302);
    } finally {
        siteAuth._setVerifier(null);
    }
});

/* ------------------------------------------------------------------ */
/* authStore                                                           */
/* ------------------------------------------------------------------ */

test('authStore: nothing configured reads as null and as configured:false', () => {
    const tenantPaths = newTenant();
    assert.strictEqual(authStore.readConfig(tenantPaths), null);
    const pub = authStore.publicConfig(tenantPaths);
    assert.strictEqual(pub.configured, false);
    assert.strictEqual(pub.hasPassword, false);
    assert.strictEqual(pub.userFilter, authStore.DEFAULT_USER_FILTER);
    assert.strictEqual(pub.groupAttribute, authStore.DEFAULT_GROUP_ATTR);
});

test('authStore: a missing url or base dn fails closed', () => {
    const a = newTenant();
    authStore.writeConfig(a, { url: '', baseDn: 'DC=corp,DC=local' });
    assert.strictEqual(authStore.readConfig(a), null);
    assert.strictEqual(authStore.publicConfig(a).configured, false);

    const b = newTenant();
    authStore.writeConfig(b, { url: 'ldap://dc01:389', baseDn: '   ' });
    assert.strictEqual(authStore.readConfig(b), null);
});

test('authStore: round trip, and the bind password is never stored in clear', () => {
    const tenantPaths = newTenant();
    const pw = 'Tr0ub4dor&3-plain';

    const pub = authStore.writeConfig(tenantPaths, {
        url: 'ldaps://dc01.corp.local:636',
        startTls: false,
        rejectUnauthorized: true,
        bindDn: 'CN=svc-aegis,OU=Services,DC=corp,DC=local',
        bindPassword: pw,
        baseDn: 'DC=corp,DC=local',
        userDnTemplate: '{username}@corp.local'
    });

    assert.strictEqual(pub.configured, true);
    assert.strictEqual(pub.hasPassword, true);
    assert.strictEqual(pub.bindPassword, undefined, 'publicConfig must not carry the password');
    assert.ok(!JSON.stringify(pub).includes(pw));

    const raw = fs.readFileSync(authStore.storeFile(tenantPaths), 'utf8');
    assert.ok(!raw.includes(pw), 'the file on disk must not contain the plaintext password');
    assert.ok(raw.includes('bindPasswordEnc'));

    const cfg = authStore.readConfig(tenantPaths);
    assert.strictEqual(cfg.bindPassword, pw, 'readConfig decrypts it back');
    assert.strictEqual(cfg.url, 'ldaps://dc01.corp.local:636');
    assert.strictEqual(cfg.rejectUnauthorized, true);
    assert.strictEqual(cfg.userFilter, authStore.DEFAULT_USER_FILTER);
    assert.strictEqual(cfg.groupAttribute, authStore.DEFAULT_GROUP_ATTR);
    assert.strictEqual(cfg.userDnTemplate, '{username}@corp.local');
});

test('authStore: an omitted password is kept, an empty one erases it', () => {
    const tenantPaths = newTenant();
    authStore.writeConfig(tenantPaths, {
        url: 'ldap://dc01:389', baseDn: 'DC=corp,DC=local', bindPassword: 'keep-me'
    });

    const kept = authStore.writeConfig(tenantPaths, { bindDn: 'CN=other,DC=corp,DC=local' });
    assert.strictEqual(kept.hasPassword, true);
    assert.strictEqual(authStore.readConfig(tenantPaths).bindPassword, 'keep-me');
    assert.strictEqual(authStore.readConfig(tenantPaths).bindDn, 'CN=other,DC=corp,DC=local');

    const cleared = authStore.writeConfig(tenantPaths, { bindPassword: '' });
    assert.strictEqual(cleared.hasPassword, false);
    assert.strictEqual(authStore.readConfig(tenantPaths).bindPassword, '');
});

test('authStore: clearConfig removes the record and is idempotent', () => {
    const tenantPaths = newTenant();
    authStore.writeConfig(tenantPaths, { url: 'ldap://dc01:389', baseDn: 'DC=corp,DC=local' });
    assert.ok(authStore.readConfig(tenantPaths));
    authStore.clearConfig(tenantPaths);
    assert.strictEqual(authStore.readConfig(tenantPaths), null);
    authStore.clearConfig(tenantPaths);
});

/* ------------------------------------------------------------------ */
/* cache invalidation                                                  */
/* ------------------------------------------------------------------ */

test('invalidate: turning protection on takes effect without waiting for the cache', async () => {
    const slug = 'tenant-inv';
    const tenantPaths = seed(slug, 'inv', { name: 'Inv' }, GOOD_CONFIG);
    assert.strictEqual(siteAuth.isProtected(slug, tenantPaths, 'inv'), false);

    projectStore.saveProject(tenantPaths, {
        id: 'inv', name: 'Inv', port: 3081, auth: { enabled: true, allowedGroups: [] }
    });
    siteAuth.invalidate(slug, 'inv');
    assert.strictEqual(siteAuth.isProtected(slug, tenantPaths, 'inv'), true);

    const res = fakeRes();
    const handled = await siteAuth.gate(fakeReq('GET', '/'), res,
        { slug, tenantPaths, project: { id: 'inv', name: 'Inv' } });
    assert.strictEqual(handled, true);
    assert.strictEqual(res.statusCode, 302);
});

/* ------------------------------------------------------------------ */
/* the Secure cookie flag                                              */
/* ------------------------------------------------------------------ */

test('cookies: a login over a plain socket gets a session cookie without Secure', async (t) => {
    const slug = 'tenant-plain';
    const tenantPaths = seed(slug, 'plain',
        { name: 'Plain', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);

    siteAuth._setVerifier(() => ({ ok: true, groups: [] }));
    t.after(() => { siteAuth._setVerifier(null); siteAuth.dropSessions(slug, 'plain'); });

    const { res } = await login(slug, tenantPaths, 'plain',
        { username: 'jdoe', password: SECRET, next: '/' }, { ip: '10.0.0.91' });
    const setCookie = String(res.headers['Set-Cookie']);

    assert.ok(setCookie.startsWith('aegis_site='));
    assert.ok(setCookie.includes('Path=/'));
    assert.ok(setCookie.includes('HttpOnly'));
    assert.ok(setCookie.includes('SameSite=Lax'));
    // Setting it here would not harden anything: the browser would refuse to
    // send the cookie back over http and login would stop working outright.
    assert.ok(!/;\s*Secure/i.test(setCookie), 'Secure has no business on a plain socket');
});

test('cookies: the same login over a TLS socket gets Secure', async (t) => {
    const slug = 'tenant-secure';
    const tenantPaths = seed(slug, 'secure',
        { name: 'Secure', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);

    siteAuth._setVerifier(() => ({ ok: true, groups: [] }));
    t.after(() => { siteAuth._setVerifier(null); siteAuth.dropSessions(slug, 'secure'); });

    const { res } = await login(slug, tenantPaths, 'secure',
        { username: 'jdoe', password: SECRET, next: '/' }, { ip: '10.0.0.92', secure: true });
    const setCookie = String(res.headers['Set-Cookie']);

    assert.ok(setCookie.startsWith('aegis_site='));
    assert.ok(/;\s*Secure/.test(setCookie), 'an encrypted socket must carry the flag');
    assert.ok(setCookie.includes('HttpOnly'));
    assert.ok(setCookie.includes('SameSite=Lax'));
});

test('cookies: the login page CSRF cookie follows the socket too', async () => {
    const slug = 'tenant-csrf-flag';
    const tenantPaths = seed(slug, 'csrfflag',
        { name: 'Csrf', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const ctx = { slug, tenantPaths, project: { id: 'csrfflag', name: 'Csrf' } };

    const plain = fakeRes();
    await siteAuth.gate(fakeReq('GET', '/__aegis/login'), plain, ctx);
    const plainCookie = String(plain.headers['Set-Cookie']);
    assert.ok(plainCookie.startsWith('aegis_site_csrf='));
    assert.ok(!/;\s*Secure/i.test(plainCookie));

    const encrypted = fakeRes();
    await siteAuth.gate(fakeReq('GET', '/__aegis/login', { secure: true }), encrypted, ctx);
    const secureCookie = String(encrypted.headers['Set-Cookie']);
    assert.ok(secureCookie.startsWith('aegis_site_csrf='));
    assert.ok(/;\s*Secure/.test(secureCookie));
});

test('cookies: the logout clear follows the socket as well', async (t) => {
    const slug = 'tenant-out-flag';
    const tenantPaths = seed(slug, 'outflag',
        { name: 'Out', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const ctx = { slug, tenantPaths, project: { id: 'outflag', name: 'Out' } };

    siteAuth._setVerifier(() => ({ ok: true, groups: [] }));
    t.after(() => { siteAuth._setVerifier(null); siteAuth.dropSessions(slug, 'outflag'); });

    // A clear that lost the flag would leave the old Secure cookie in place on a
    // TLS site, so the expiry has to be written with the same attributes.
    const secureLogin = await login(slug, tenantPaths, 'outflag',
        { username: 'jdoe', password: SECRET, next: '/' }, { ip: '10.0.0.93', secure: true });
    const secureToken = cookieValue(secureLogin.res.headers['Set-Cookie'], 'aegis_site');
    const secureOut = fakeRes();
    await siteAuth.gate(fakeReq('POST', '/__aegis/logout',
        { secure: true, headers: { cookie: `aegis_site=${secureToken}` } }), secureOut, ctx);
    const secureCleared = String(secureOut.headers['Set-Cookie']);
    assert.ok(secureCleared.includes('Max-Age=0'));
    assert.ok(/;\s*Secure/.test(secureCleared));

    const plainLogin = await login(slug, tenantPaths, 'outflag',
        { username: 'jdoe', password: SECRET, next: '/' }, { ip: '10.0.0.94' });
    const plainToken = cookieValue(plainLogin.res.headers['Set-Cookie'], 'aegis_site');
    const plainOut = fakeRes();
    await siteAuth.gate(fakeReq('POST', '/__aegis/logout',
        { headers: { cookie: `aegis_site=${plainToken}` } }), plainOut, ctx);
    const plainCleared = String(plainOut.headers['Set-Cookie']);
    assert.ok(plainCleared.includes('Max-Age=0'));
    assert.ok(!/;\s*Secure/i.test(plainCleared));
});

/* ------------------------------------------------------------------ */
/* background revalidation                                             */
/* ------------------------------------------------------------------ */

const VIEWERS_DN = 'CN=Site Viewers,OU=Groups,DC=corp,DC=local';
const HELPDESK_DN = 'CN=Helpdesk,OU=Groups,DC=corp,DC=local';

/**
 * Moves the clock the guard reads, for the body of one test.
 *
 * `nextCheckAt` is an absolute timestamp and `authStore` floors
 * `revalidateMinutes` at one minute, so the only way to reach a re-check
 * without sleeping through it is to move `Date.now` forward under the module.
 */
function fakeClock(t) {
    const real = Date.now;
    let skew = 0;
    Date.now = () => real() + skew;
    t.after(() => { Date.now = real; });
    return (ms) => { skew += ms; };
}

/**
 * Lets the revalidation chain finish.
 *
 * `gate` starts it and returns, so there is no promise to await. The chain is
 * microtasks only when the injected lookup answers without I/O, and each
 * `setImmediate` drains the whole microtask queue behind it.
 */
async function settle() {
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
}

/** One request an authenticated session should be allowed straight through. */
function visit(slug, tenantPaths, projectId, token) {
    const res = fakeRes();
    const handled = siteAuth.gate(
        fakeReq('GET', '/', { headers: { cookie: `aegis_site=${token}` } }), res,
        { slug, tenantPaths, project: { id: projectId, name: projectId } });
    return { res, handled };
}

/** Logs a user in through the real form and hands back the session token. */
async function loginToken(slug, tenantPaths, projectId, ip, groups) {
    siteAuth._setVerifier(() => ({ ok: true, groups: groups || [VIEWERS_DN] }));
    try {
        const { res } = await login(slug, tenantPaths, projectId,
            { username: 'alice', password: SECRET, next: '/' }, { ip });
        return cookieValue(res.headers['Set-Cookie'], 'aegis_site');
    } finally {
        siteAuth._setVerifier(null);
    }
}

/** Collects what the guard warns about, over the file-wide mute. */
function captureWarnings(t) {
    const real = console.warn;
    const lines = [];
    console.warn = (msg) => { lines.push(String(msg)); };
    t.after(() => { console.warn = real; });
    return lines;
}

function revalConfig(minutes) {
    return Object.assign({}, GOOD_CONFIG, { revalidateMinutes: minutes });
}

test('revalidation: a still-entitled session is re-checked once per interval and kept', async (t) => {
    const slug = 'tenant-reval-ok';
    const tenantPaths = seed(slug, 'revalok',
        { name: 'Reval', auth: { enabled: true, allowedGroups: ['Site Viewers'] } },
        revalConfig(10));
    const token = await loginToken(slug, tenantPaths, 'revalok', '10.0.0.81');
    assert.ok(token);

    const advance = fakeClock(t);
    let calls = 0;
    siteAuth._setLookup((config, username) => {
        calls += 1;
        assert.strictEqual(username, 'alice', 'the directory is asked about the session owner');
        assert.strictEqual(config.bindPassword, 'service-secret',
            'the lookup gets the decrypted bind password, same as the verifier');
        return { ok: true, groups: [VIEWERS_DN] };
    });
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions(slug, 'revalok'); });

    // The login has just checked, so the first interval is a whole one away.
    assert.strictEqual(visit(slug, tenantPaths, 'revalok', token).handled, false);
    await settle();
    assert.strictEqual(calls, 0, 'nothing is asked before the interval elapses');

    advance(11 * 60 * 1000);
    assert.strictEqual(visit(slug, tenantPaths, 'revalok', token).handled, false,
        'the request that trips the timer is served with the list it already has');
    await settle();
    assert.strictEqual(calls, 1);

    // Past the retry delay but not past a second full interval. A verdict was
    // reached, so the next check must be an interval away and not a minute.
    advance(2 * 60 * 1000);
    assert.strictEqual(visit(slug, tenantPaths, 'revalok', token).handled, false);
    await settle();
    assert.strictEqual(calls, 1, 'a successful check pushes the next one a full interval away');

    advance(9 * 60 * 1000);
    assert.strictEqual(visit(slug, tenantPaths, 'revalok', token).handled, false);
    await settle();
    assert.strictEqual(calls, 2);
});

test('revalidation: a user taken out of the allowed group loses the session', async (t) => {
    const slug = 'tenant-reval-drop';
    const tenantPaths = seed(slug, 'revaldrop',
        { name: 'Reval', auth: { enabled: true, allowedGroups: ['Site Viewers'] } },
        revalConfig(10));
    const token = await loginToken(slug, tenantPaths, 'revaldrop', '10.0.0.82');

    const warnings = captureWarnings(t);
    const advance = fakeClock(t);
    siteAuth._setLookup(() => ({ ok: true, groups: [HELPDESK_DN] }));
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions(slug, 'revaldrop'); });

    advance(11 * 60 * 1000);
    assert.strictEqual(visit(slug, tenantPaths, 'revaldrop', token).handled, false,
        'the request that trips the check is not the one that pays for it');
    await settle();

    const after = visit(slug, tenantPaths, 'revaldrop', token);
    assert.strictEqual(after.handled, true, 'the dropped session must not open the site again');
    assert.strictEqual(after.res.statusCode, 302);
    assert.ok(String(after.res.headers.Location).startsWith('/__aegis/login'));
    assert.ok(warnings.some((l) => l.includes('session dropped') && l.includes('alice')),
        `the drop must be reported, got ${JSON.stringify(warnings)}`);
});

test('revalidation: a directory that cannot answer keeps the session and retries sooner', async (t) => {
    const slug = 'tenant-reval-down';
    const tenantPaths = seed(slug, 'revaldown',
        { name: 'Reval', auth: { enabled: true, allowedGroups: ['Site Viewers'] } },
        revalConfig(10));
    const token = await loginToken(slug, tenantPaths, 'revaldown', '10.0.0.83');

    const advance = fakeClock(t);
    let calls = 0;
    siteAuth._setLookup(() => { calls += 1; return { ok: false, error: 'ldap_unreachable' }; });
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions(slug, 'revaldown'); });

    advance(11 * 60 * 1000);
    visit(slug, tenantPaths, 'revaldown', token);
    await settle();
    assert.strictEqual(calls, 1);

    // A DC down for a minute must not empty every protected site at once.
    assert.strictEqual(visit(slug, tenantPaths, 'revaldown', token).handled, false,
        'no verdict is not a verdict of no');
    await settle();
    assert.strictEqual(calls, 1, 'the retry delay has not elapsed yet');

    // Sixty-one seconds, well short of the ten-minute interval: an unanswered
    // check has to come back soon after the DC does.
    advance(61 * 1000);
    assert.strictEqual(visit(slug, tenantPaths, 'revaldown', token).handled, false);
    await settle();
    assert.strictEqual(calls, 2, 'a failed check retries after a minute, not after the interval');
});

test('revalidation: a lookup that rejects is treated as no answer, not as a refusal', async (t) => {
    const slug = 'tenant-reval-throw';
    const tenantPaths = seed(slug, 'revalthrow',
        { name: 'Reval', auth: { enabled: true, allowedGroups: ['Site Viewers'] } },
        revalConfig(10));
    const token = await loginToken(slug, tenantPaths, 'revalthrow', '10.0.0.84');

    const advance = fakeClock(t);
    let calls = 0;
    siteAuth._setLookup(() => { calls += 1; return Promise.reject(new Error('socket hang up')); });
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions(slug, 'revalthrow'); });

    advance(11 * 60 * 1000);
    visit(slug, tenantPaths, 'revalthrow', token);
    await settle();
    assert.strictEqual(calls, 1);
    assert.strictEqual(visit(slug, tenantPaths, 'revalthrow', token).handled, false,
        'a thrown lookup must not log the user out');
    await settle();

    // And the in-flight flag was cleared on the rejection path too, so the next
    // window still gets a check instead of the session never being asked about.
    advance(61 * 1000);
    visit(slug, tenantPaths, 'revalthrow', token);
    await settle();
    assert.strictEqual(calls, 2);
});

test('revalidation: revalidateMinutes 0 never consults the directory', async (t) => {
    const slug = 'tenant-reval-off';
    const tenantPaths = seed(slug, 'revaloff',
        { name: 'Reval', auth: { enabled: true, allowedGroups: ['Site Viewers'] } },
        revalConfig(0));
    const token = await loginToken(slug, tenantPaths, 'revaloff', '10.0.0.85');

    const advance = fakeClock(t);
    let calls = 0;
    siteAuth._setLookup(() => { calls += 1; return { ok: true, groups: [VIEWERS_DN] }; });
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions(slug, 'revaloff'); });

    // Six hours, comfortably inside the eight-hour session and far past any
    // interval the setting could otherwise have produced.
    advance(6 * 60 * 60 * 1000);
    assert.strictEqual(visit(slug, tenantPaths, 'revaloff', token).handled, false);
    await settle();
    assert.strictEqual(calls, 0, 'off means off, which is the behaviour before this existed');
});

test('revalidation: concurrent requests start one check, and none of them waits for it', async (t) => {
    const slug = 'tenant-reval-once';
    const tenantPaths = seed(slug, 'revalonce',
        { name: 'Reval', auth: { enabled: true, allowedGroups: ['Site Viewers'] } },
        revalConfig(10));
    const token = await loginToken(slug, tenantPaths, 'revalonce', '10.0.0.86');

    const advance = fakeClock(t);
    let calls = 0;
    let release = null;
    siteAuth._setLookup(() => {
        calls += 1;
        return new Promise((resolve) => {
            release = () => resolve({ ok: true, groups: [VIEWERS_DN] });
        });
    });
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions(slug, 'revalonce'); });

    advance(11 * 60 * 1000);
    for (let i = 0; i < 3; i++) {
        const { handled } = visit(slug, tenantPaths, 'revalonce', token);
        // A boolean and not a promise: the gate answered while the lookup it
        // just started is still outstanding.
        assert.strictEqual(handled, false, `request ${i + 1} must be served without waiting`);
    }
    await settle();
    assert.strictEqual(calls, 1, 'the in-flight flag keeps a slow DC from being asked three times');

    release();
    await settle();
    assert.strictEqual(visit(slug, tenantPaths, 'revalonce', token).handled, false);
    await settle();
    assert.strictEqual(calls, 1, 'the answer pushed the next check a full interval away');
});

/* ------------------------------------------------------------------ */
/* the TLS listener                                                    */
/* ------------------------------------------------------------------ */

/**
 * A throwaway certificate, written to the system temp directory at run time.
 *
 * Same reasoning and the same command as `tests/ldap.test.js`: no key material
 * belongs in this tree even when gitignored, and `node:crypto` cannot issue an
 * X.509 certificate. When openssl is not on the path the tests that need a
 * handshake skip rather than fail. Paths and not PEM, because `tlsOptionsFor`
 * reads files.
 */
function selfSignedFiles() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-site-tls-'));
    const keyFile = path.join(dir, 'key.pem');
    const certFile = path.join(dir, 'cert.pem');
    const run = spawnSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyFile, '-out', certFile, '-days', '1',
        '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'
    ], { stdio: 'ignore' });
    if (run.status !== 0) {
        fs.rmSync(dir, { recursive: true, force: true });
        return null;
    }
    return { dir, keyFile, certFile };
}

/**
 * A port the operating system just told us is free.
 *
 * Not a number picked out of a range: these tests bind for real, and a
 * collision would fail a test for a reason unrelated to the code under test.
 */
function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

/** Resolves once the listener is up, and gives up rather than hanging. */
function listening(server, ms) {
    return new Promise((resolve) => {
        if (server.listening) return resolve();
        const timer = setTimeout(resolve, ms || 3000);
        server.once('listening', () => { clearTimeout(timer); resolve(); });
    });
}

/** A GET that reports a transport failure instead of throwing. */
function fetchPort(client, port, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
        const req = client.request(Object.assign({
            host: '127.0.0.1', port, path: o.path || '/',
            // No pooling and no keep-alive: a socket left open would hold the
            // port after close() and turn the restart test into a race.
            agent: false, headers: { connection: 'close' }
        }, o.extra || {}), (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                ok: true, status: res.statusCode, body: Buffer.concat(chunks)
            }));
        });
        req.setTimeout(3000, () => req.destroy(new Error('timeout')));
        req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
        req.end();
    });
}

const getHttp = (port, opts) => fetchPort(http, port, opts);
const getHttps = (port, opts) => fetchPort(https, port, Object.assign({
    // Self-signed and generated two lines ago. What is proved here is that the
    // bytes crossed a handshake at all, not who signed the certificate.
    extra: { rejectUnauthorized: false }
}, opts));

/** `startSiteFor` reports a refusal on console.error. Muted per test. */
function muteErrors(t) {
    const real = console.error;
    console.error = () => {};
    t.after(() => { console.error = real; });
}

/** Polls until the port refuses, because close() unbinds asynchronously. */
async function waitRefused(port) {
    let last = { ok: true };
    for (let i = 0; i < 20; i++) {
        last = await getHttp(port);
        if (!last.ok) return last;
        await new Promise((r) => setTimeout(r, 25));
    }
    return last;
}

/** A tenant, a project record with a port, and one file under `current`. */
function siteFixture(slug, projectId, extra, contents) {
    const tenantPaths = newTenant();
    const project = Object.assign({ id: projectId, name: projectId }, extra);
    projectStore.saveProject(tenantPaths, project);
    siteAuth.invalidate(slug, projectId);

    const current = projectStore.currentDir(tenantPaths, projectId);
    fs.mkdirSync(current, { recursive: true });
    const bytes = Buffer.from(contents, 'utf8');
    fs.writeFileSync(path.join(current, 'index.html'), bytes);
    return { tenantPaths, project, current, bytes };
}

/**
 * A certificate and a key that both exist, both read, and neither parses.
 *
 * The state a renewal leaves behind when the file is read mid-write, and the
 * one no fixture built from openssl can produce. Every other bad-TLS case in
 * this file is missing a file, so on its own it only ever proves the ENOENT
 * path and leaves the parse untested.
 */
function garbageCertFiles(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-site-tls-junk-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const certFile = path.join(dir, 'cert.pem');
    const keyFile = path.join(dir, 'key.pem');
    fs.writeFileSync(certFile, 'not a certificate\n', 'utf8');
    fs.writeFileSync(keyFile, 'not a key\n', 'utf8');
    return { certFile, keyFile };
}

/**
 * Settles either way, so a promise that never settles fails one test instead of
 * hanging the runner with no output to read.
 */
function withTimeout(promise, ms) {
    let timer = null;
    const guard = new Promise((resolve) => { timer = setTimeout(() => resolve({ state: 'timeout' }), ms); });
    return Promise.race([
        Promise.resolve(promise).then(
            (value) => ({ state: 'resolved', value }),
            (error) => ({ state: 'rejected', error })),
        guard
    ]).then((outcome) => { clearTimeout(timer); return outcome; });
}

test('tls: a project with no tls record, or one switched off, stays plain http', () => {
    assert.strictEqual(siteServer.tlsOptionsFor({ id: 'a' }), null);
    assert.strictEqual(siteServer.tlsOptionsFor({ id: 'a', tls: null }), null);
    assert.strictEqual(siteServer.tlsOptionsFor({ id: 'a', tls: {} }), null);
    assert.strictEqual(
        siteServer.tlsOptionsFor({ id: 'a', tls: { enabled: false, certFile: 'c', keyFile: 'k' } }),
        null);
    // Only the boolean counts. A truthy string in the record is a typo, not a
    // request for TLS, and reading it as one would try to load 'c' and 'k'.
    assert.strictEqual(
        siteServer.tlsOptionsFor({ id: 'a', tls: { enabled: 'yes', certFile: 'c', keyFile: 'k' } }),
        null);
});

test('tls: an enabled record missing a path is incomplete rather than plain', () => {
    assert.throws(
        () => siteServer.tlsOptionsFor({ tls: { enabled: true, certFile: '', keyFile: 'k.pem' } }),
        (e) => e.code === 'tls_incomplete');
    assert.throws(
        () => siteServer.tlsOptionsFor({ tls: { enabled: true, certFile: 'c.pem', keyFile: '' } }),
        (e) => e.code === 'tls_incomplete');
    assert.throws(
        () => siteServer.tlsOptionsFor({ tls: { enabled: true } }),
        (e) => e.code === 'tls_incomplete');
});

test('tls: a certificate path that is not on disk throws where the operator is looking', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-site-tls-gone-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const certFile = path.join(dir, 'cert.pem');
    const keyFile = path.join(dir, 'key.pem');

    assert.throws(
        () => siteServer.tlsOptionsFor({ tls: { enabled: true, certFile, keyFile } }),
        (e) => e.code === 'ENOENT');

    // A key missing on its own is caught too, not only the pair.
    fs.writeFileSync(certFile, 'not really a certificate', 'utf8');
    assert.throws(
        () => siteServer.tlsOptionsFor({ tls: { enabled: true, certFile, keyFile } }),
        (e) => e.code === 'ENOENT');
});

test('tls: a site whose certificate will not load does not come up in clear', async (t) => {
    muteErrors(t);
    const slug = 'tenant-tls-bad';
    const port = await freePort();
    const missing = path.join(os.tmpdir(), 'aegis-no-such-cert.pem');
    const { tenantPaths, project } = siteFixture(slug, 'tlsbad', {
        port, tls: { enabled: true, certFile: missing, keyFile: missing }
    }, 'this must never be served');
    t.after(() => siteServer.stopSiteFor(slug, 'tlsbad'));

    const server = siteServer.startSiteFor({ slug, tenantPaths, project });
    assert.strictEqual(server, null, 'a broken certificate must stop the site, not downgrade it');

    // The whole point of the branch: a silent downgrade would look like it
    // worked, while the login form on it sent a password across in clear.
    const plain = await getHttp(port);
    assert.strictEqual(plain.ok, false, `nothing may answer on ${port}, got status ${plain.status}`);
    assert.ok(/ECONNREFUSED/.test(plain.error),
        `expected a refused connection, got ${plain.error}`);
});

test('tls: a readable certificate that is not PEM is refused, not handed to the server', (t) => {
    const bad = garbageCertFiles(t);
    // Both files are present and both read. If this test ever passes on an
    // ENOENT the fixture has broken and the parse is going untested again.
    assert.ok(fs.existsSync(bad.certFile) && fs.existsSync(bad.keyFile));

    let thrown = null;
    try {
        siteServer.tlsOptionsFor({ tls: { enabled: true, certFile: bad.certFile, keyFile: bad.keyFile } });
    } catch (e) {
        thrown = e;
    }
    assert.ok(thrown, 'readable is not usable: bytes that will not parse are not a certificate');
    assert.notStrictEqual(thrown.code, 'ENOENT', 'the files exist, so this has to be a parse failure');
    // The message is an OpenSSL string and differs between builds, so what is
    // pinned is that it threw here, where the caller's try/catch is waiting,
    // rather than later inside the https.createServer constructor.
});

test('tls: a readable but unparseable certificate leaves the site down, not in clear', async (t) => {
    muteErrors(t);
    const bad = garbageCertFiles(t);
    const slug = 'tenant-tls-junk';
    const port = await freePort();
    const { tenantPaths, project } = siteFixture(slug, 'tlsjunk', {
        port, tls: { enabled: true, certFile: bad.certFile, keyFile: bad.keyFile }
    }, 'this must never be served');
    t.after(() => siteServer.stopSiteFor(slug, 'tlsjunk'));

    // Not a throw either: an exception escaping here is what took the whole of
    // startAllSites down at boot, one tenant's half-written file at a time.
    const server = siteServer.startSiteFor({ slug, tenantPaths, project });
    assert.strictEqual(server, null, 'PEM that will not parse must stop the site, like a missing file does');

    const plain = await getHttp(port);
    assert.strictEqual(plain.ok, false, `nothing may answer on ${port}, got status ${plain.status}`);
    assert.ok(/ECONNREFUSED/.test(plain.error), `expected a refused connection, got ${plain.error}`);
});

test('tls: a valid certificate serves the site over https and nothing over http', async (t) => {
    const pair = selfSignedFiles();
    if (!pair) return t.skip('openssl is not available to build a test certificate');
    t.after(() => fs.rmSync(pair.dir, { recursive: true, force: true }));
    muteErrors(t);

    const slug = 'tenant-tls-ok';
    const port = await freePort();
    const { tenantPaths, project, bytes } = siteFixture(slug, 'tlsok', {
        port, tls: { enabled: true, certFile: pair.certFile, keyFile: pair.keyFile }
    }, '<h1>served over tls</h1>');
    t.after(() => siteServer.stopSiteFor(slug, 'tlsok'));

    const server = siteServer.startSiteFor({ slug, tenantPaths, project });
    assert.ok(server, 'a readable certificate must start the listener');
    await listening(server);

    const secure = await getHttps(port);
    assert.strictEqual(secure.ok, true, `expected https to answer, got ${secure.error}`);
    assert.strictEqual(secure.status, 200);
    assert.deepStrictEqual(secure.body, bytes, 'the file crossed the handshake unchanged');

    // The same port spoken to in clear. There is no plain answer to fall back
    // to: on an https listener the handshake is the protocol.
    const plain = await getHttp(port);
    assert.strictEqual(plain.ok, false, `a plain request must not be answered, got ${plain.status}`);
});


/* ------------------------------------------------------------------ */
/* restarting a listener                                               */
/* ------------------------------------------------------------------ */

test('restart: the old listener is replaced and the port serves the new one', async (t) => {
    muteErrors(t);
    const slug = 'tenant-restart';
    const port = await freePort();
    const { tenantPaths, project, current } = siteFixture(slug, 'restart', { port }, 'first');
    t.after(() => siteServer.stopSiteFor(slug, 'restart'));

    const first = siteServer.startSiteFor({ slug, tenantPaths, project });
    assert.ok(first);
    await listening(first);
    const before = await getHttp(port);
    assert.strictEqual(before.ok, true, `expected the site to serve, got ${before.error}`);
    assert.strictEqual(before.body.toString('utf8'), 'first');

    fs.writeFileSync(path.join(current, 'index.html'), 'second', 'utf8');
    const second = await siteServer.restartSiteFor({ slug, tenantPaths, project });
    assert.ok(second, 'the site must come back up');
    assert.notStrictEqual(second, first,
        'a restart builds a new listener: TLS is decided when the server is created');
    await listening(second);

    const after = await getHttp(port);
    assert.strictEqual(after.ok, true, `expected the port to serve again, got ${after.error}`);
    assert.strictEqual(after.body.toString('utf8'), 'second');
});

test('restart: a connection held open does not keep the site from coming back', async (t) => {
    muteErrors(t);
    const slug = 'tenant-restart-open';
    const port = await freePort();
    const { tenantPaths, project } = siteFixture(slug, 'restartopen', { port }, 'held open');
    t.after(() => siteServer.stopSiteFor(slug, 'restartopen'));

    const first = siteServer.startSiteFor({ slug, tenantPaths, project });
    await listening(first);
    assert.strictEqual((await getHttp(port)).ok, true);

    // Half a request, deliberately: the socket is neither idle nor finished, so
    // `close()` on its own will never drop it and the port stays bound. This is
    // the shape that made a synchronous restart re-listen into EADDRINUSE, and
    // because `listen` reports that on an event the site just never came back.
    const held = net.connect(port, '127.0.0.1');
    await new Promise((resolve, reject) => {
        held.once('connect', resolve);
        held.once('error', reject);
    });
    held.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n');
    held.on('error', () => {});           // the restart cuts it, which is the point
    t.after(() => held.destroy());
    await new Promise((r) => setTimeout(r, 50));

    const second = await siteServer.restartSiteFor({ slug, tenantPaths, project });
    assert.ok(second, 'an open connection must not cost the site its listener');
    assert.notStrictEqual(second, first);
    await listening(second);

    const after = await getHttp(port);
    assert.strictEqual(after.ok, true, `expected the port to serve again, got ${after.error}`);
    assert.strictEqual(after.body.toString('utf8'), 'held open');
});

test('restart: a site that is not running is simply started', async (t) => {
    muteErrors(t);
    const slug = 'tenant-restart-cold';
    const port = await freePort();
    const { tenantPaths, project } = siteFixture(slug, 'restartcold', { port }, 'cold start');
    t.after(() => siteServer.stopSiteFor(slug, 'restartcold'));

    // The settings page calls this after every save, including on a project
    // whose listener never came up. Nothing to stop is not an error.
    const server = await siteServer.restartSiteFor({ slug, tenantPaths, project });
    assert.ok(server, 'restarting what was never started must start it');
    await listening(server);

    const res = await getHttp(port);
    assert.strictEqual(res.ok, true, `expected the site to serve, got ${res.error}`);
    assert.strictEqual(res.body.toString('utf8'), 'cold start');
});

test('restart: switching a running site to a certificate that will not load stops it', async (t) => {
    muteErrors(t);
    const slug = 'tenant-restart-tls';
    const port = await freePort();
    const { tenantPaths, project } = siteFixture(slug, 'restarttls', { port }, 'plain for now');
    t.after(() => siteServer.stopSiteFor(slug, 'restarttls'));

    const plainServer = siteServer.startSiteFor({ slug, tenantPaths, project });
    await listening(plainServer);
    assert.strictEqual((await getHttp(port)).ok, true);

    // Turning HTTPS on with a path that does not read must leave nothing
    // listening, rather than leave the plain listener up under an https label.
    project.tls = {
        enabled: true,
        certFile: path.join(os.tmpdir(), 'aegis-absent.pem'),
        keyFile: path.join(os.tmpdir(), 'aegis-absent.key')
    };
    const restarted = await siteServer.restartSiteFor({ slug, tenantPaths, project });
    assert.strictEqual(restarted, null);

    const refused = await waitRefused(port);
    assert.strictEqual(refused.ok, false, 'the old plain listener must be gone');
});

test('restart: a running site can be switched from http to https on its port', async (t) => {
    const pair = selfSignedFiles();
    if (!pair) return t.skip('openssl is not available to build a test certificate');
    t.after(() => fs.rmSync(pair.dir, { recursive: true, force: true }));
    muteErrors(t);

    const slug = 'tenant-restart-https';
    const port = await freePort();
    const { tenantPaths, project, bytes } = siteFixture(slug, 'restarthttps', { port }, 'now encrypted');
    t.after(() => siteServer.stopSiteFor(slug, 'restarthttps'));

    const plainServer = siteServer.startSiteFor({ slug, tenantPaths, project });
    await listening(plainServer);
    assert.strictEqual((await getHttp(port)).ok, true, 'the site starts in clear');

    project.tls = { enabled: true, certFile: pair.certFile, keyFile: pair.keyFile };
    const encrypted = await siteServer.restartSiteFor({ slug, tenantPaths, project });
    assert.ok(encrypted, 'the site must come back on TLS');
    assert.notStrictEqual(encrypted, plainServer);
    await listening(encrypted);

    const secure = await getHttps(port);
    assert.strictEqual(secure.ok, true, `expected https to answer, got ${secure.error}`);
    assert.deepStrictEqual(secure.body, bytes);
    assert.strictEqual((await getHttp(port)).ok, false, 'the plain answer is gone with the restart');
});

test('restart: an unparseable new certificate settles the restart instead of hanging it', async (t) => {
    muteErrors(t);
    const bad = garbageCertFiles(t);
    const slug = 'tenant-restart-junk';
    const port = await freePort();
    const { tenantPaths, project } = siteFixture(slug, 'restartjunk', { port }, 'plain for now');
    t.after(() => siteServer.stopSiteFor(slug, 'restartjunk'));

    const plainServer = siteServer.startSiteFor({ slug, tenantPaths, project });
    await listening(plainServer);
    assert.strictEqual((await getHttp(port)).ok, true);

    // The restart starts the new listener inside the close callback, off the
    // chain the caller awaits. A throw there settles nothing: the promise stays
    // pending and the request that asked for the restart is never answered. The
    // timeout turns that into a failed test rather than a hung suite.
    project.tls = { enabled: true, certFile: bad.certFile, keyFile: bad.keyFile };
    const outcome = await withTimeout(siteServer.restartSiteFor({ slug, tenantPaths, project }), 5000);
    assert.notStrictEqual(outcome.state, 'timeout', 'the restart must settle, whatever the certificate is');
    assert.strictEqual(outcome.state, 'resolved',
        `expected a null result, got ${outcome.state} ${outcome.error && outcome.error.message}`);
    assert.strictEqual(outcome.value, null);

    const refused = await waitRefused(port);
    assert.strictEqual(refused.ok, false, 'the site must be left stopped, not left up in clear');
});
