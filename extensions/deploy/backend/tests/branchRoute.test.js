/**
 * Changing the branch a project tracks.
 *
 * Every refusal here fires before GitHub is contacted, which is the point: the
 * route writes the record and then deploys, so anything it will not accept has
 * to be rejected while the record is still the one that is serving. A refusal
 * that arrived after the write would leave a project pointing at a branch it
 * never cloned, and the poller would then complain about that name every twenty
 * seconds.
 *
 * Same harness as createRoute.test.js: no express, no network. `register` is
 * handed a router that records its handlers, and they are called with a request
 * built here.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-deploy-branch-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;
process.env.AEGIS_DEPLOY_ENABLED = '1';
// Mounting the routes starts the poller. Zero turns it off, so this file leaves
// no timer calling GitHub behind it.
process.env.AEGIS_DEPLOY_POLL_MS = '0';

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
    const router = { get: add('GET'), post: add('POST'), delete: add('DELETE'), put: add('PUT') };

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

function request(extra) {
    return Object.assign({
        body: {},
        query: {},
        params: {},
        tenant: { slug: 'acme' },
        tenantPaths: pathsFor('acme'),
        user: { email: 'ops@acme.test', role: 'admin' },
        hostname: 'aegis.test',
        protocol: 'http',
        get: () => 'aegis.test'
    }, extra || {});
}

/** A project on a public repository, so no GitHub App is needed to reach it. */
function plant(id, fields) {
    return projectStore.saveProject(pathsFor('acme'), Object.assign({
        id,
        name: id,
        repoFullName: 'acme/' + id,
        branch: 'main',
        installationId: null,
        port: 3099,
        lastSha: 'a'.repeat(40)
    }, fields || {}));
}

/* ------------------------------------------------------------------ */
/* listing the branches of a repository                                */
/* ------------------------------------------------------------------ */

test('the branch list refuses anything that is not a github.com repository', async () => {
    for (const repo of ['https://gitlab.com/acme/site', 'not a url at all', '']) {
        const answer = await call('GET /api/deploy/github/branches',
            request({ query: { repo } }));
        assert.equal(answer.status, 400, `${repo} was not refused`);
        assert.equal(answer.body.error, 'bad_repo_url');
    }
});

/* ------------------------------------------------------------------ */
/* moving a project to another branch                                  */
/* ------------------------------------------------------------------ */

test('an unknown project is a 404, and an id that is not a slug never reaches disk', async () => {
    for (const id of ['never-existed', '../../etc', 'UPPER', 'has space']) {
        const answer = await call('POST /api/deploy/projects/:id/branch',
            request({ params: { id }, body: { branch: 'next' } }));
        assert.equal(answer.status, 404, `${id} was not refused`);
        assert.equal(answer.body.error, 'unknown_project');
    }
});

test('a branch name git would read as a flag is refused before anything is written', async () => {
    const id = 'branch-flag';
    plant(id);

    for (const branch of ['--upload-pack=calc', '../../evil', 'has space', '']) {
        const answer = await call('POST /api/deploy/projects/:id/branch',
            request({ params: { id }, body: { branch } }));
        assert.equal(answer.status, 400, `${branch} was not refused`);
        assert.equal(answer.body.error, 'bad_branch');
    }
    assert.equal(projectStore.getProject(pathsFor('acme'), id).branch, 'main',
        'the record still tracks the branch that is serving');
});

test('the branch already being served is refused rather than redeployed', async () => {
    const id = 'branch-same';
    plant(id);

    const answer = await call('POST /api/deploy/projects/:id/branch',
        request({ params: { id }, body: { branch: 'main' } }));
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error, 'branch_unchanged');
});

test('a preview keeps its branch: it is what the preview is', async () => {
    plant('branch-parent');
    plant('branch-parent-dev', { parentId: 'branch-parent', branch: 'dev' });

    const answer = await call('POST /api/deploy/projects/:id/branch',
        request({ params: { id: 'branch-parent-dev' }, body: { branch: 'other' } }));
    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, 'preview_branch_fixed');
    assert.equal(projectStore.getProject(pathsFor('acme'), 'branch-parent-dev').branch, 'dev');
});

test('a branch one of its own previews deploys is refused, not published twice', async () => {
    plant('branch-dup');
    plant('branch-dup-staging', { parentId: 'branch-dup', branch: 'staging' });

    const answer = await call('POST /api/deploy/projects/:id/branch',
        request({ params: { id: 'branch-dup' }, body: { branch: 'staging' } }));
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error, 'branch_is_preview');
    assert.equal(projectStore.getProject(pathsFor('acme'), 'branch-dup').branch, 'main');
});

test('a private project whose App is gone is told so, rather than throwing on a token', async () => {
    const id = 'branch-no-app';
    plant(id, { installationId: 4242 });

    const answer = await call('POST /api/deploy/projects/:id/branch',
        request({ params: { id }, body: { branch: 'next' } }));
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error, 'github_not_connected');
    assert.equal(projectStore.getProject(pathsFor('acme'), id).branch, 'main');
});
