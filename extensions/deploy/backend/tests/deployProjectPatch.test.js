/**
 * The settings a project can change after it exists.
 *
 * `startCmd` was written once, at creation, and never again: a project created
 * without one was a static site for ever, and the documented repair was to
 * delete it and make another. That is the instruction an operator was given for
 * a typo, so this route exists and this file is what holds it to its promises.
 *
 * No express and no network, same shape as `deployGithubDisconnect.test.js`:
 * `register` is handed a router that records its handlers, and one is called
 * with a request built here.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-patch-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;
process.env.AEGIS_DEPLOY_ENABLED = '1';
process.env.AEGIS_DEPLOY_POLL_MS = '0';
// Left unset on purpose: the host runs no process, which is the refusal one of
// the tests below is about.
delete process.env.AEGIS_DEPLOY_RUNTIME;

const test = require('node:test');
const assert = require('node:assert');

const routes = require('../routes');
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

function request(body) {
    return {
        body: body || {},
        query: {},
        params: {},
        tenant: { slug: SLUG },
        tenantPaths: pathsFor(SLUG),
        user: { email: 'ops@acme.test', role: 'admin' },
        hostname: 'aegis.test',
        protocol: 'http',
        get: () => 'aegis.test'
    };
}

/** A project on disk, with whatever this test needs it to say about itself. */
function plant(id, extra) {
    const paths = pathsFor(SLUG);
    fs.mkdirSync(paths.deploy, { recursive: true });
    return projectStore.saveProject(paths, Object.assign({
        id,
        name: id,
        repoFullName: 'acme/site',
        branch: 'main',
        runtime: 'static',
        port: 3090
    }, extra || {}));
}

function patch(id, body) {
    return call('PATCH /api/deploy/projects/:id/settings',
        Object.assign(request(body), { params: { id } }));
}

test('the route is mounted', () => {
    assert.ok(table.get('PATCH /api/deploy/projects/:id/settings'));
});

test('a start command added to a static project is refused when the host runs none', async () => {
    plant('site-a', { runtime: 'static', startCmd: null });
    const answer = await patch('site-a', { startCmd: 'node server.js' });
    assert.strictEqual(answer.status, 403);
    assert.strictEqual(answer.body.error, 'runtime_disabled');
    const after = projectStore.getProject(pathsFor(SLUG), 'site-a');
    assert.strictEqual(after.runtime, 'static', 'the refusal still wrote the record');
});

test('clearing the start command turns a process back into a static site', async () => {
    plant('site-b', { runtime: 'node', startCmd: 'node server.js' });
    const answer = await patch('site-b', { startCmd: '' });
    assert.strictEqual(answer.status, 200);
    const after = projectStore.getProject(pathsFor(SLUG), 'site-b');
    assert.strictEqual(after.runtime, 'static');
    assert.strictEqual(after.startCmd, null);
});

test('a build key is written and the others are left alone', async () => {
    plant('site-e', { installCmd: 'npm ci', buildCmd: null, outputDir: 'dist' });
    const answer = await patch('site-e', { buildCmd: 'npm run build' });
    assert.strictEqual(answer.status, 200);
    assert.deepStrictEqual(answer.body.changed, ['buildCmd']);
    const after = projectStore.getProject(pathsFor(SLUG), 'site-e');
    assert.strictEqual(after.buildCmd, 'npm run build');
    assert.strictEqual(after.installCmd, 'npm ci', 'a key nobody sent was rewritten');
    assert.strictEqual(after.outputDir, 'dist');
});

test('a dbFile that climbs out of the data folder is refused here too', async () => {
    plant('site-c', { runtime: 'node', startCmd: 'node s.js' });
    const answer = await patch('site-c', { dbFile: '..\\..\\aegis.db' });
    assert.strictEqual(answer.status, 400);
    assert.strictEqual(answer.body.error, 'bad_db_file');
});

test("a preview's settings are its parent's, and are refused here", async () => {
    plant('site-d-preview', { runtime: 'static', parentId: 'site-d' });
    const answer = await patch('site-d-preview', { buildCmd: 'npm run build' });
    assert.strictEqual(answer.status, 400);
    assert.strictEqual(answer.body.error, 'preview_settings_fixed');
});

test('a project nobody planted is a 404, not a record created by a PATCH', async () => {
    const answer = await patch('site-nowhere', { buildCmd: 'npm run build' });
    assert.strictEqual(answer.status, 404);
    assert.strictEqual(answer.body.error, 'unknown_project');
});
