'use strict';

/**
 * Sign-in and sign-out accept a form posted from the site's own origin only.
 *
 * The double-submit check alone does not hold on a shared host. Cookies ignore
 * the port, so another site on the same host is "same site" for the browser and
 * can plant the CSRF cookie of this one, then post the matching field: a forced
 * sign-in under the attacker's account, or a forced sign-out. Its server can
 * even fetch this site's form and take a genuine pair. What it cannot do is make
 * the visitor's browser send this site's origin, so that is what is checked.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.AEGIS_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-deploy-origin-'));

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');

const siteAuth = require('../siteAuth');
const authStore = require('../authStore');
const projectStore = require('../projectStore');

console.log = () => {};
console.warn = () => {};

const HOST = 'apps.corp.local:3081';
const OWN = `https://${HOST}`;
const VERDICT = { ok: true, dn: 'CN=J Doe,DC=corp,DC=local', displayName: 'J Doe', groups: [] };

function fakeReq(method, url, o) {
    const req = Readable.from(o.body === undefined ? [] : [Buffer.from(o.body, 'utf8')]);
    req.method = method;
    req.url = url;
    req.headers = Object.assign({ host: HOST, 'content-type': 'application/x-www-form-urlencoded' }, o.headers);
    req.socket = { remoteAddress: '10.0.0.1', encrypted: o.secure !== false };
    return req;
}

function fakeRes() {
    const res = { statusCode: 0, headers: {}, body: '' };
    res.writeHead = (s, h) => { res.statusCode = s; Object.assign(res.headers, h || {}); return res; };
    res.setHeader = (n, v) => { res.headers[n] = v; };
    res.getHeader = (n) => res.headers[n];
    res.end = (c) => { if (c) res.body += String(c); };
    return res;
}

function valueOf(res, name) {
    for (const line of [].concat(res.headers['Set-Cookie'] || [])) {
        if (line.startsWith(name + '=')) return line.slice(name.length + 1).split(';')[0];
    }
    return null;
}

let n = 0;
function newSite() {
    const slug = 'origin-tenant';
    const id = `site-${++n}`;
    const tenantPaths = { root: fs.mkdtempSync(path.join(process.env.AEGIS_DATA_ROOT, 't-')) };
    projectStore.saveProject(tenantPaths, { id, port: 3081, name: id, auth: { method: 'ldap', enabled: true, allowedGroups: [] } });
    authStore.writeConfig(tenantPaths, {
        url: 'ldaps://dc01.corp.local:636', baseDn: 'DC=corp,DC=local',
        bindDn: 'CN=svc,DC=corp,DC=local', bindPassword: 'service-secret'
    });
    siteAuth.invalidate(slug, id);
    return { site: { slug, tenantPaths, project: { id, name: id } }, names: siteAuth.cookieNames(slug, id) };
}

/** A sign-in with a pair the attacker chose, carrying `headers`. */
async function login(headers) {
    const { site, names } = newSite();
    const token = 'chosen-by-the-caller-0123456789ab';
    const res = fakeRes();
    siteAuth._setVerifier(() => VERDICT);
    try {
        await siteAuth.gate(fakeReq('POST', '/__aegis/login', {
            body: new URLSearchParams({ csrf: token, username: 'jdoe', password: 'pw', next: '/' }).toString(),
            headers: Object.assign({ cookie: `${names.csrf}=${token}` }, headers)
        }), res, site);
    } finally {
        siteAuth._setVerifier(null);
    }
    return { res, session: valueOf(res, names.session) };
}

test('login: a sibling site\'s origin is refused, no session', async () => {
    const { res, session } = await login({ origin: 'https://apps.corp.local:3082', 'sec-fetch-site': 'same-site' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(session, null);
});

test('login: another scheme on the same host and port is refused', async () => {
    const { session } = await login({ origin: 'http://apps.corp.local:3081' });
    assert.strictEqual(session, null);
});

test('login: an opaque origin is refused', async () => {
    const { session } = await login({ origin: 'null' });
    assert.strictEqual(session, null);
});

test('login: no Origin but a same-site fetch is refused', async () => {
    const { session } = await login({ 'sec-fetch-site': 'same-site' });
    assert.strictEqual(session, null);
});

test('login: the site\'s own origin signs in', async () => {
    const { res, session } = await login({ origin: OWN, 'sec-fetch-site': 'same-origin' });
    assert.strictEqual(res.statusCode, 302);
    assert.ok(session);
});

test('login: own origin, case and default port aside, signs in', async () => {
    const { session } = await login({ host: 'Apps.Corp.Local', origin: 'https://apps.corp.local:443' });
    assert.ok(session);
});

test('login: no Origin and no fetch metadata, a non-browser client, still signs in', async () => {
    const { session } = await login({});
    assert.ok(session);
});

test('logout: a sibling site\'s origin closes nothing', async () => {
    const { site, names } = newSite();
    const { session } = await (async () => {
        const token = 'victim-pair-0123456789abcdef0123';
        const res = fakeRes();
        siteAuth._setVerifier(() => VERDICT);
        try {
            await siteAuth.gate(fakeReq('POST', '/__aegis/login', {
                body: new URLSearchParams({ csrf: token, username: 'jdoe', password: 'pw', next: '/' }).toString(),
                headers: { origin: OWN, cookie: `${names.csrf}=${token}` }
            }), res, site);
        } finally {
            siteAuth._setVerifier(null);
        }
        return { session: valueOf(res, names.session) };
    })();
    assert.ok(session);

    const planted = 'planted-by-a-sibling-0123456789ab';
    const out = fakeRes();
    await siteAuth.gate(fakeReq('POST', '/__aegis/logout', {
        body: `csrf=${planted}`,
        headers: { origin: 'https://apps.corp.local:3082', cookie: `${names.session}=${session}; ${names.csrf}=${planted}` }
    }), out, site);
    assert.strictEqual(out.statusCode, 400);

    const after = fakeRes();
    const handled = await siteAuth.gate(fakeReq('GET', '/', { body: undefined, headers: { cookie: `${names.session}=${session}` } }), after, site);
    assert.strictEqual(handled, false, 'the session still opens the site');

    const own = fakeRes();
    await siteAuth.gate(fakeReq('POST', '/__aegis/logout', {
        body: `csrf=${planted}`,
        headers: { origin: OWN, cookie: `${names.session}=${session}; ${names.csrf}=${planted}` }
    }), own, site);
    assert.strictEqual(own.statusCode, 302, 'from its own origin the sign-out goes through');
});
