/**
 * What `POST /api/deploy/projects/:id/auth` accepts, refuses, and writes.
 *
 * The route is the only door onto a field the site guard reads on every request
 * to a protected site, so the thing worth testing is not that a valid method
 * saves. It is that an invalid one does not, that the pre-selector body still
 * works, and that what lands on disk carries a mirror the rest of the codebase
 * can keep reading.
 *
 * No express and no network: `register` is handed a recording router, the same
 * shape createRoute.test.js uses.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-deploy-authroute-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;
process.env.AEGIS_DEPLOY_ENABLED = '1';
// Mounting the routes starts the poller. Zero turns it off, so this file leaves
// no timer calling GitHub behind it.
process.env.AEGIS_DEPLOY_POLL_MS = '0';

const test = require('node:test');
const assert = require('node:assert');

const routes = require('../routes');
const projectStore = require('../projectStore');
const authMethods = require('../authMethods');

// The create route reads the branch before it decides anything. No network.
const github = require('../github');
github.readRepoFile = async () => null;
github.listRootEntries = async () => [];

console.log = () => { };
console.error = () => { };

const TENANTS_ROOT = path.join(DATA_ROOT, 'tenants');
fs.mkdirSync(TENANTS_ROOT, { recursive: true });

function pathsFor(slug) {
    const root = path.join(TENANTS_ROOT, slug);
    return { root, deploy: path.join(root, 'deploy') };
}

function collect() {
    const table = new Map();
    const add = (method) => (routePath, ...chain) => table.set(`${method} ${routePath}`, chain);
    const router = {
        get: add('GET'), post: add('POST'), delete: add('DELETE'), put: add('PUT'),
        patch: add('PATCH')
    };
    routes.register(router, {
        // Holds the line core's does: the named role passes, anything else is
        // refused. Every request below is an admin unless a test says not.
        requireRole: (role) => (req, res, next) => (req.user && req.user.role === role
            ? next()
            : res.status(403).json({ success: false, error: 'forbidden' })),
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

function request(id, body) {
    return {
        body,
        query: {},
        params: { id },
        tenant: { slug: 'acme' },
        tenantPaths: pathsFor('acme'),
        user: { email: 'ops@acme.test', role: 'admin' },
        hostname: 'aegis.test',
        protocol: 'http',
        get: () => 'aegis.test'
    };
}

/**
 * A project on disk, with whatever auth record the test needs.
 *
 * It carries a TLS switch by default, because a protected site is refused
 * without one; a test about that refusal passes `tls` as `null`.
 */
function makeProject(id, auth, tls) {
    const record = {
        id, name: id, port: 3081, repoUrl: 'https://github.com/acme/' + id, auth
    };
    record.tls = tls === undefined ? { enabled: true, certFile: 'C:\\certs\\site.pem', keyFile: 'C:\\certs\\site.key' } : tls;
    if (record.tls === null) delete record.tls;
    projectStore.saveProject(pathsFor('acme'), record);
    return id;
}

function storedAuth(id) {
    return projectStore.getProject(pathsFor('acme'), id).auth;
}

/* ------------------------------------------------------------------ */

test('route: a known method is stored with the mirror derived from it', async () => {
    const id = makeProject('site-a', null);
    const answer = await call('POST /api/deploy/projects/:id/auth',
        request(id, { method: 'ldap', allowedGroups: ['Domain Admins'] }));

    assert.equal(answer.status, 200);
    assert.equal(answer.body.method, undefined, 'the method rides on the project object');
    assert.equal(answer.body.project.method, 'ldap');
    assert.equal(answer.body.project.protected, true);
    assert.deepEqual(storedAuth(id),
        { method: 'ldap', enabled: true, audience: 'listed',
          allowedGroups: ['Domain Admins'], allowedUsers: [],
          // A body naming no grants closes every resource the site declares,
          // which is the answer a page predating the field has to get.
          grants: {} });
});

test('route: a body that names no audience keeps the pre-audience meaning', async () => {
    // A page that predates the field sends two keys and no more. Groups named
    // has always meant "those groups"; naming none has always meant the whole
    // directory. Neither may change under a caller that never asked.
    const listed = makeProject('site-audience-listed', null);
    await call('POST /api/deploy/projects/:id/auth',
        request(listed, { method: 'ldap', allowedGroups: ['Ops'] }));
    assert.equal(storedAuth(listed).audience, 'listed');

    const open = makeProject('site-audience-open', null);
    await call('POST /api/deploy/projects/:id/auth',
        request(open, { method: 'ldap', allowedGroups: [] }));
    assert.equal(storedAuth(open).audience, 'directory');
});

test('route: named people are stored, and the administrator flag with them', async () => {
    const id = makeProject('site-people', null);
    const answer = await call('POST /api/deploy/projects/:id/auth',
        request(id, {
            method: 'ldap',
            audience: 'listed',
            allowedGroups: [],
            allowedUsers: [
                { sid: 'S-1-5-21-1-2-3-1103', login: 'AM', name: 'Alice Martin', admin: true },
                { sid: 'S-1-5-21-1-2-3-1200', login: 'JD', name: 'J Doe' }
            ]
        }));

    assert.equal(answer.status, 200);
    assert.deepEqual(storedAuth(id).allowedUsers, [
        { sid: 'S-1-5-21-1-2-3-1103', login: 'AM', name: 'Alice Martin', admin: true },
        { sid: 'S-1-5-21-1-2-3-1200', login: 'JD', name: 'J Doe', admin: false }
    ]);
    assert.equal(storedAuth(id).audience, 'listed');
    // The page repaints from the answer, so it has to carry them back.
    assert.equal(answer.body.project.allowedUsers.length, 2);
    assert.equal(answer.body.project.audience, 'listed');
});

test('route: a value that is not a SID is refused, not stored', async () => {
    // This list is written to projects.json and read by the site guard on every
    // request. Anything that is not a SID could never match a login, so storing
    // it would show an access in the panel that does not exist.
    const id = makeProject('site-bad-sid', null);
    for (const sid of ['', 'not-a-sid', 'S-1-5', '../../etc', 'S-1-5-21-1-2-3-1103; DROP']) {
        const answer = await call('POST /api/deploy/projects/:id/auth',
            request(id, { method: 'ldap', allowedGroups: [], allowedUsers: [{ sid }] }));
        assert.equal(answer.status, 400, `refused: ${JSON.stringify(sid)}`);
        assert.equal(answer.body.error, 'bad_allowed_users');
    }
    assert.equal(storedAuth(id), null);
});

test('route: an audience this build has no rule for is refused', async () => {
    // Refused rather than resolved to a default. A typo must not be the reason
    // a site opens to the whole directory.
    const id = makeProject('site-bad-audience', null);
    const answer = await call('POST /api/deploy/projects/:id/auth',
        request(id, { method: 'ldap', allowedGroups: [], audience: 'everyone' }));
    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, 'bad_audience');
});

test('route: the same person listed twice is stored once', async () => {
    // The picker clicked twice, not an error worth refusing the save over.
    const id = makeProject('site-dup', null);
    await call('POST /api/deploy/projects/:id/auth',
        request(id, {
            method: 'ldap',
            allowedGroups: [],
            allowedUsers: [
                { sid: 'S-1-5-21-1-2-3-1103', login: 'AM', admin: true },
                { sid: 's-1-5-21-1-2-3-1103', login: 'AM', admin: false }
            ]
        }));
    assert.equal(storedAuth(id).allowedUsers.length, 1);
    assert.equal(storedAuth(id).allowedUsers[0].admin, true);
});

test('route: method none stores the mirror as false and unprotects the site', async () => {
    const id = makeProject('site-b', { method: 'ldap', enabled: true, allowedGroups: ['Ops'] });
    const answer = await call('POST /api/deploy/projects/:id/auth',
        request(id, { method: 'none', allowedGroups: [] }));

    assert.equal(answer.status, 200);
    assert.equal(answer.body.project.method, 'none');
    assert.equal(answer.body.project.protected, false);
    assert.equal(storedAuth(id).enabled, false);
});

test('route: a method the backend cannot serve is refused, and nothing is written', async () => {
    const before = { method: 'ldap', enabled: true, allowedGroups: ['Ops'] };
    const id = makeProject('site-c', before);
    const answer = await call('POST /api/deploy/projects/:id/auth',
        request(id, { method: 'saml', allowedGroups: [] }));

    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, 'bad_auth_method');
    assert.deepEqual(storedAuth(id), before, 'the record must be left exactly as it was');
});

test('route: a method that is not a string is refused rather than coerced', async () => {
    const id = makeProject('site-d', null);
    for (const method of [1, true, ['ldap'], { name: 'ldap' }]) {
        const answer = await call('POST /api/deploy/projects/:id/auth',
            request(id, { method, allowedGroups: [] }));
        assert.equal(answer.status, 400, `${JSON.stringify(method)} must be refused`);
        assert.equal(answer.body.error, 'bad_auth_method');
    }
});

test('route: the pre-selector body still works, both ways', async () => {
    // A caller written against the old contract -- a script, a bookmarked
    // request -- must not break on the upgrade.
    const id = makeProject('site-e', null);

    let answer = await call('POST /api/deploy/projects/:id/auth',
        request(id, { enabled: true, allowedGroups: ['Ops'] }));
    assert.equal(answer.status, 200);
    assert.equal(storedAuth(id).method, 'ldap');
    assert.equal(storedAuth(id).enabled, true);

    answer = await call('POST /api/deploy/projects/:id/auth',
        request(id, { enabled: false, allowedGroups: [] }));
    assert.equal(answer.status, 200);
    assert.equal(storedAuth(id).method, 'none');
    assert.equal(storedAuth(id).enabled, false);
});

test('route: a body carrying both is read by the method, not by the mirror', async () => {
    // This is the shape the page sends: `method` for a backend that knows it,
    // `enabled` so an older one does not refuse the whole body. A backend that
    // read the mirror first would undo every choice the selector makes, so the
    // two are made to disagree here on purpose.
    const id = makeProject('site-both', null);

    let answer = await call('POST /api/deploy/projects/:id/auth',
        request(id, { method: 'none', enabled: true, allowedGroups: [] }));
    assert.equal(answer.status, 200);
    assert.equal(storedAuth(id).method, 'none');
    assert.equal(storedAuth(id).enabled, false, 'the stored mirror follows the method');

    answer = await call('POST /api/deploy/projects/:id/auth',
        request(id, { method: 'ldap', enabled: false, allowedGroups: [] }));
    assert.equal(answer.status, 200);
    assert.equal(storedAuth(id).method, 'ldap');
    assert.equal(storedAuth(id).enabled, true);
});

test('route: an unknown method is refused even when the mirror is valid', async () => {
    // The mirror must not become a way past the whitelist.
    const id = makeProject('site-both2', null);
    const answer = await call('POST /api/deploy/projects/:id/auth',
        request(id, { method: 'saml', enabled: true, allowedGroups: [] }));
    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, 'bad_auth_method');
    assert.equal(storedAuth(id), undefined);
});

test('route: a body naming neither is still refused', async () => {
    const id = makeProject('site-f', null);
    const answer = await call('POST /api/deploy/projects/:id/auth',
        request(id, { allowedGroups: [] }));
    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, 'bad_enabled');
    assert.equal(storedAuth(id), undefined, 'no record was created by a refused call');
});

test('route: an unparseable allow list is refused after a valid method', async () => {
    const id = makeProject('site-g', null);
    const answer = await call('POST /api/deploy/projects/:id/auth',
        request(id, { method: 'ldap', allowedGroups: 'Domain Admins' }));
    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, 'bad_allowed_groups');
});

test('route: the pane lists the vocabulary alongside each site method', async () => {
    makeProject('site-h', { method: 'ldap', enabled: true, allowedGroups: [] });
    const answer = await call('GET /api/deploy/auth', request('site-h', {}));

    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.methods, authMethods.METHODS);
    const site = answer.body.sites.find((s) => s.id === 'site-h');
    assert.ok(site, 'the site is listed');
    assert.equal(site.method, 'ldap');
    assert.equal(site.protected, true);
});

test('route: a site carrying an unknown method is shown as it is, not normalised', async () => {
    // The page has to be able to say what is actually stored. Rendering it as
    // one of the options would hide the misconfiguration and then overwrite it
    // on the next Apply, which is how a refusal nobody can explain is born.
    const id = makeProject('site-i', { method: 'saml', enabled: true, allowedGroups: [] });
    const answer = await call('GET /api/deploy/auth', request(id, {}));
    const site = answer.body.sites.find((s) => s.id === id);
    assert.equal(site.method, 'saml');
    assert.equal(site.protected, true, 'an unknown method is a gate, never an open site');
});

/* --------------------------------------------------------------- grants -- */

test('route: the auth payload carries the bindings and what the commit declares', async () => {
    const id = makeProject('site-grants', null);
    await call('POST /api/deploy/projects/:id/auth',
        request(id, {
            method: 'ldap', allowedGroups: [],
            grants: { admin: { groups: ['Site-Admins'], users: [] } }
        }));

    const answer = await call('GET /api/deploy/auth', request(null, null));
    const row = answer.body.sites.filter((s) => s.id === id)[0];
    assert.deepEqual(row.grants.admin.groups, ['Site-Admins']);
    assert.ok(Array.isArray(row.resources),
        'the pane draws one row per resource the deployed commit declares');
});

test('route: saving grants stores them and answers with them', async () => {
    const id = makeProject('site-save', null);
    const answer = await call('POST /api/deploy/projects/:id/auth',
        request(id, {
            method: 'ldap', allowedGroups: [],
            grants: {
                finance: {
                    groups: ['Finance'],
                    users: [{ sid: 'S-1-5-21-1-2-3-1500', login: 'AM', name: 'Alice Martin' }]
                }
            }
        }));

    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.project.grants.finance.groups, ['Finance']);
    assert.equal(storedAuth(id).grants.finance.users[0].sid, 'S-1-5-21-1-2-3-1500');
});

test('route: a grants body that is not an object of entries is refused', async () => {
    const id = makeProject('site-bad', null);
    const answer = await call('POST /api/deploy/projects/:id/auth',
        request(id, { method: 'ldap', allowedGroups: [], grants: 'nope' }));

    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, 'bad_grants');
});

test('route: a save that mentions no grants closes every declared resource', async () => {
    const id = makeProject('site-drop', null);
    await call('POST /api/deploy/projects/:id/auth',
        request(id, { method: 'ldap', allowedGroups: [], grants: { a: { groups: ['G'], users: [] } } }));
    // A page that predates the field, or an operator clearing the list.
    await call('POST /api/deploy/projects/:id/auth',
        request(id, { method: 'ldap', allowedGroups: [] }));

    assert.deepEqual(storedAuth(id).grants, {},
        'the closed state is the one a silent body has to produce');
});

/* ------------------------------------------------------------------ */
/* HTTPS is mandatory for a protected site                             */
/* ------------------------------------------------------------------ */

const TLS_ROUTE = 'POST /api/deploy/projects/:id/tls';
const AUTH_ROUTE = 'POST /api/deploy/projects/:id/auth';
const SETTINGS_ROUTE = 'POST /api/deploy/projects/:id/settings';

test('tls: the auth route refuses a directory login on a project without TLS', async () => {
    for (const [id, tls] of [
        ['tls-absent', null],
        ['tls-off', { enabled: false, certFile: 'C:\\c.pem', keyFile: 'C:\\k.pem' }]
    ]) {
        makeProject(id, null, tls);
        const answer = await call(AUTH_ROUTE, request(id, { method: 'ldap', allowedGroups: ['Ops'] }));
        assert.equal(answer.status, 400, id);
        assert.equal(answer.body.error, 'auth_requires_tls', id);
        assert.equal(storedAuth(id), undefined, `${id}: the project is unchanged on disk`);
    }
});

test('tls: the legacy enabled body is held to the same rule', async () => {
    const id = makeProject('tls-legacy', null, null);
    const answer = await call(AUTH_ROUTE, request(id, { enabled: true }));
    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, 'auth_requires_tls');
});

test('tls: the auth route accepts none without TLS', async () => {
    const id = makeProject('tls-none', null, null);
    const answer = await call(AUTH_ROUTE, request(id, { method: 'none' }));
    assert.equal(answer.status, 200);
    assert.equal(storedAuth(id).method, 'none');
});

test('tls: a project reached under a host name through the TLS router may be protected', async () => {
    const id = makeProject('tls-router', null, null);
    const project = projectStore.getProject(pathsFor('acme'), id);
    project.hostname = 'app.corp.local';
    projectStore.saveProject(pathsFor('acme'), project);

    const saved = { cert: process.env.AEGIS_SITES_ROUTER_CERT, key: process.env.AEGIS_SITES_ROUTER_KEY };
    try {
        const without = await call(AUTH_ROUTE, request(id, { method: 'ldap', allowedGroups: ['Ops'] }));
        assert.equal(without.body.error, 'auth_requires_tls', 'a host name alone is not TLS');

        process.env.AEGIS_SITES_ROUTER_CERT = 'C:\\certs\\router.pem';
        process.env.AEGIS_SITES_ROUTER_KEY = 'C:\\certs\\router.key';
        const withRouter = await call(AUTH_ROUTE, request(id, { method: 'ldap', allowedGroups: ['Ops'] }));
        assert.equal(withRouter.status, 200);
        assert.equal(storedAuth(id).method, 'ldap');

        // And the name cannot be taken away from under the protection.
        const cleared = await call(SETTINGS_ROUTE, request(id, { hostname: '' }));
        assert.equal(cleared.status, 409);
        assert.equal(cleared.body.error, 'tls_required_by_auth');
        assert.equal(projectStore.getProject(pathsFor('acme'), id).hostname, 'app.corp.local');
    } finally {
        for (const [name, value] of [['AEGIS_SITES_ROUTER_CERT', saved.cert], ['AEGIS_SITES_ROUTER_KEY', saved.key]]) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
    }
});

test('tls: the TLS route refuses to switch TLS off under a protected site', async () => {
    const id = makeProject('tls-keep', { method: 'ldap', enabled: true, allowedGroups: ['Ops'] });
    const answer = await call(TLS_ROUTE, request(id, { enabled: false }));
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error, 'tls_required_by_auth');
    assert.equal(projectStore.getProject(pathsFor('acme'), id).tls.enabled, true, 'TLS is still on');
});

/* ------------------------------------------------------------------ */
/* the directory form: encrypted bind, validated certificate           */
/* ------------------------------------------------------------------ */

const DIRECTORY_ROUTE = 'POST /api/deploy/auth';
const DIRECTORY_BODY = {
    url: 'ldaps://dc01.corp.local:636',
    baseDn: 'DC=corp,DC=local',
    bindDn: 'CN=svc,DC=corp,DC=local',
    bindPassword: 'service-secret'
};

test('directory form: ldap:// without StartTLS is refused as ldap_requires_tls', async () => {
    const answer = await call(DIRECTORY_ROUTE, request(null,
        Object.assign({}, DIRECTORY_BODY, { url: 'ldap://dc01.corp.local:389' })));
    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, 'ldap_requires_tls');
});

test('directory form: ldap:// with StartTLS and ldaps:// are accepted', async () => {
    const starttls = await call(DIRECTORY_ROUTE, request(null,
        Object.assign({}, DIRECTORY_BODY, { url: 'ldap://dc01.corp.local:389', startTls: true })));
    assert.equal(starttls.status, 200, JSON.stringify(starttls.body));
    const ldaps = await call(DIRECTORY_ROUTE, request(null, DIRECTORY_BODY));
    assert.equal(ldaps.status, 200, JSON.stringify(ldaps.body));
});

test('directory form: rejectUnauthorized false is refused as ldap_requires_validation', async () => {
    const answer = await call(DIRECTORY_ROUTE, request(null,
        Object.assign({}, DIRECTORY_BODY, { rejectUnauthorized: false })));
    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, 'ldap_requires_validation');
});

/* ------------------------------------------------------------------ */
/* closing site sessions by hand                                       */
/* ------------------------------------------------------------------ */

const { Readable } = require('stream');
const siteAuth = require('../siteAuth');
const authStore = require('../authStore');

function siteReq(method, url, opts) {
    const o = opts || {};
    const req = Readable.from(o.body === undefined ? [] : [Buffer.from(o.body, 'utf8')]);
    req.method = method;
    req.url = url;
    req.headers = Object.assign({}, o.headers);
    req.socket = { remoteAddress: o.ip || '10.0.0.7', encrypted: true };
    return req;
}

function siteRes() {
    const res = { statusCode: 0, headers: {}, body: '', headersSent: false };
    res.writeHead = (status, headers) => {
        res.statusCode = status; Object.assign(res.headers, headers || {}); res.headersSent = true; return res;
    };
    res.setHeader = (name, value) => { res.headers[name] = value; };
    res.end = (chunk) => { if (chunk) res.body += String(chunk); };
    return res;
}

function cookieOf(setCookie, name) {
    const m = new RegExp(`(?:^|; )?${name}=([^;]*)`).exec(String(setCookie || ''));
    return m ? m[1] : null;
}

/** Signs `username` into a site through the real form and returns the token. */
async function siteLogin(id, username) {
    const ctx = { slug: 'acme', tenantPaths: pathsFor('acme'), project: { id, name: id } };
    const form = siteRes();
    await siteAuth.gate(siteReq('GET', '/__aegis/login'), form, ctx);
    const names = siteAuth.cookieNames('acme', id);
    const csrf = cookieOf(form.headers['Set-Cookie'], names.csrf);
    siteAuth._setVerifier(() => ({ ok: true, groups: [] }));
    try {
        const res = siteRes();
        await siteAuth.gate(siteReq('POST', '/__aegis/login', {
            body: new URLSearchParams({ csrf, username, password: 'pw', next: '/' }).toString(),
            headers: { cookie: `${names.csrf}=${csrf}` }
        }), res, ctx);
        return cookieOf(res.headers['Set-Cookie'], names.session);
    } finally {
        siteAuth._setVerifier(null);
    }
}

async function siteVisit(id, token) {
    const res = siteRes();
    const handled = await siteAuth.gate(siteReq('GET', '/', { headers: { cookie: `${siteAuth.cookieNames('acme', id).session}=${token}` } }), res,
        { slug: 'acme', tenantPaths: pathsFor('acme'), project: { id, name: id } });
    return { handled, res };
}

function protectedSite(id) {
    makeProject(id, authMethods.record(authMethods.LDAP, [], { audience: 'directory' }));
    authStore.writeConfig(pathsFor('acme'), Object.assign({}, DIRECTORY_BODY, { revalidateMinutes: 0 }));
    siteAuth.invalidate('acme', id);
    return id;
}

test('sessions route: GET lists who is signed in, without any token', async (t) => {
    const id = protectedSite('sess-list');
    t.after(() => siteAuth.dropSessions('acme', id));
    const token = await siteLogin(id, 'alice');
    assert.ok(token);

    const answer = await call('GET /api/deploy/projects/:id/sessions', request(id));
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.success, true);
    assert.equal(answer.body.sessions.length, 1);
    assert.equal(answer.body.sessions[0].username, 'alice');
    assert.equal(answer.body.sessions[0].ip, '10.0.0.7');
    assert.equal(typeof answer.body.sessions[0].loginAt, 'number', 'the login time is loginAt');
    assert.equal(answer.body.sessions[0].login, undefined);
    assert.ok(!JSON.stringify(answer.body).includes(token), 'the session token never leaves the guard');
});

test('admin DELETE sessions?username=x closes only x\'s sessions', async (t) => {
    const id = protectedSite('sess-drop');
    t.after(() => siteAuth.dropSessions('acme', id));
    const alice = await siteLogin(id, 'alice');
    const bob = await siteLogin(id, 'bob');

    const req = request(id);
    req.query = { username: 'CORP\\Alice' };
    const answer = await call('DELETE /api/deploy/projects/:id/sessions', req);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(answer.body, { success: true, closed: 1 });

    const next = await siteVisit(id, alice);
    assert.equal(next.handled, true);
    assert.equal(next.res.statusCode, 302);
    assert.ok(String(next.res.headers.Location).startsWith('/__aegis/login'), 'x lands on the login form');
    assert.equal((await siteVisit(id, bob)).handled, false, 'the other user is still signed in');

    const all = await call('DELETE /api/deploy/projects/:id/sessions', request(id));
    assert.deepEqual(all.body, { success: true, closed: 1 });
    assert.equal((await siteVisit(id, bob)).res.statusCode, 302);
});

test('sessions route: a blank username is refused rather than read as everyone', async () => {
    const id = protectedSite('sess-blank');
    const req = request(id);
    req.query = { username: '  ' };
    const answer = await call('DELETE /api/deploy/projects/:id/sessions', req);
    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, 'bad_username');
});

test('auth payload: writeRecheck says whether a write can be rechecked against the group', async () => {
    authStore.writeConfig(pathsFor('acme'), Object.assign({}, DIRECTORY_BODY, { bindPassword: 'service-secret' }));
    const searchable = await call('GET /api/deploy/auth', request(null));
    assert.equal(searchable.body.writeRecheck, true);

    // A bind DN with no password: ldap.lookup refuses before opening a socket.
    authStore.writeConfig(pathsFor('acme'), { bindPassword: '' });
    const blind = await call('GET /api/deploy/auth', request(null));
    assert.equal(blind.body.writeRecheck, false);
    authStore.writeConfig(pathsFor('acme'), { bindPassword: 'service-secret' });
});

test('sessions route: an unknown project is 404', async () => {
    const answer = await call('GET /api/deploy/projects/:id/sessions', request('no-such-site'));
    assert.equal(answer.status, 404);
});

test('sessions route: non-admin gets 403 on both routes', async () => {
    const id = protectedSite('sess-role');
    for (const key of ['GET /api/deploy/projects/:id/sessions', 'DELETE /api/deploy/projects/:id/sessions']) {
        const req = request(id);
        req.user = { email: 'viewer@acme.test', role: 'viewer' };
        const answer = await call(key, req);
        assert.equal(answer.status, 403, key);
    }
});
