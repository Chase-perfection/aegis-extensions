/**
 * Forgetting a GitHub App registration, so another one can take its place.
 *
 * Both registration routes refuse with `github_already_connected` once one
 * exists, and nothing undid that. An App registered under the wrong account is
 * a dead end in that state: a private App installs only on the account that
 * owns it, so the fix is always a different App, and the page offered no way to
 * get to one.
 *
 * No express and no network, same shape as `deployGaveUp.test.js`: `register`
 * is handed a router that records its handlers, and one is called with a
 * request built here.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-ghdisconnect-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;
process.env.AEGIS_DEPLOY_ENABLED = '1';
process.env.AEGIS_DEPLOY_POLL_MS = '0';

const test = require('node:test');
const assert = require('node:assert');

const routes = require('../routes');
const machineStore = require('../machineStore');
const projectStore = require('../projectStore');

console.log = () => { };

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
            json(body) { resolve({ status: this.statusCode, body }); return this; },
            redirect(to) { resolve({ status: 302, body: { to } }); return this; }
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

const SLUG = 'acme';

function request(slug) {
    const s = slug || SLUG;
    return {
        body: {},
        query: {},
        params: {},
        tenant: { slug: s },
        tenantPaths: pathsFor(s),
        user: { email: 'ops@acme.test', role: 'admin' },
        hostname: 'aegis.test',
        protocol: 'http',
        get: () => 'aegis.test'
    };
}

/** A registration with the shape saveGitHubApp stores, key included. */
function registerApp(slug, appId) {
    machineStore.saveGitHubApp(slug, {
        appId,
        slug: `aegis-deploy-${slug}`,
        clientId: 'Iv1.test',
        clientSecret: 'placeholder-not-a-secret',
        privateKey: 'placeholder-not-a-key',
        htmlUrl: `https://github.com/apps/aegis-deploy-${slug}`
    });
}

test('the route is mounted, which is the whole gap it fills', () => {
    assert.ok(table.get('DELETE /api/deploy/github/app'),
        'nothing reached clearGitHubApp, so a wrong App could never be replaced');
});

test('forgetting a registration lets the next one be registered', async () => {
    registerApp(SLUG, '111');
    assert.ok(machineStore.getGitHubApp(SLUG), 'the fixture did not register anything');

    // The refusal that used to be the dead end.
    const before = await call('POST /api/deploy/github/app/manual', request());
    assert.strictEqual(before.status, 409);
    assert.strictEqual(before.body.error, 'github_already_connected');

    const gone = await call('DELETE /api/deploy/github/app', request());
    assert.strictEqual(gone.status, 200);
    assert.strictEqual(gone.body.forgotten, true);
    assert.strictEqual(machineStore.getGitHubApp(SLUG), null, 'the key Aegis held is still on disk');

    // Same call, no longer refused for that reason. It fails on the missing
    // credentials in the body instead, which is the next step, not the wall.
    const after = await call('POST /api/deploy/github/app/manual', request());
    assert.notStrictEqual(after.body.error, 'github_already_connected',
        'registering is still refused, so the dead end is intact');
});

test('the answer says how many projects stop deploying, so the click is informed', async () => {
    registerApp(SLUG, '111');
    const paths = pathsFor(SLUG);
    fs.mkdirSync(paths.deploy, { recursive: true });
    projectStore.saveProject(paths, {
        id: 'pulse-app', name: 'Pulse', repoFullName: 'acme/pulse', branch: 'main'
    });

    const res = await call('DELETE /api/deploy/github/app', request());
    assert.strictEqual(res.body.projects, 1,
        'the operator is not told what the disconnection costs');
});

test('forgetting nothing is not an error, so a double click is harmless', async () => {
    machineStore.clearGitHubApp(SLUG);
    const res = await call('DELETE /api/deploy/github/app', request());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.forgotten, false);
});

test('one tenant forgetting its App leaves another tenant registered', async () => {
    registerApp(SLUG, '111');
    registerApp('beta', '222');

    await call('DELETE /api/deploy/github/app', request(SLUG));

    assert.strictEqual(machineStore.getGitHubApp(SLUG), null);
    const other = machineStore.getGitHubApp('beta');
    assert.ok(other, "another tenant's registration was taken with it");
    assert.strictEqual(other.appId, '222');
});
