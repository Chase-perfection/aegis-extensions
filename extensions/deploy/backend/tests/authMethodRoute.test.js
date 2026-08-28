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

/** A project on disk, with whatever auth record the test needs. */
function makeProject(id, auth) {
    projectStore.saveProject(pathsFor('acme'), {
        id, name: id, port: 3081, repoUrl: 'https://github.com/acme/' + id, auth
    });
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
          allowedGroups: ['Domain Admins'], allowedUsers: [] });
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
                { sid: 'S-1-5-21-1-2-3-1103', login: 'PV', name: 'Paul Vue', admin: true },
                { sid: 'S-1-5-21-1-2-3-1200', login: 'JD', name: 'J Doe' }
            ]
        }));

    assert.equal(answer.status, 200);
    assert.deepEqual(storedAuth(id).allowedUsers, [
        { sid: 'S-1-5-21-1-2-3-1103', login: 'PV', name: 'Paul Vue', admin: true },
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
                { sid: 'S-1-5-21-1-2-3-1103', login: 'PV', admin: true },
                { sid: 's-1-5-21-1-2-3-1103', login: 'PV', admin: false }
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
