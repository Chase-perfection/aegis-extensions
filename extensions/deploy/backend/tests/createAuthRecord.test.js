/**
 * A create whose branch names an authentication method stores that method.
 *
 * The route used to refuse it with `auth_requires_tls`, since a new project
 * has no TLS yet; that made such a repository impossible to import, so the
 * record is now stored and `siteAuth.gate` keeps the site closed (503
 * `site_not_tls`) until TLS is on. This file proves the record reaches the
 * store without a real clone: `deployService.deployNow` and
 * `siteServer.startSiteFor` are replaced BEFORE `routes` is required, because
 * routes destructures both at load.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-deploy-create-auth-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;
process.env.AEGIS_DEPLOY_ENABLED = '1';
process.env.AEGIS_DEPLOY_POLL_MS = '0';

const test = require('node:test');
const assert = require('node:assert');

const projectStore = require('../projectStore');
const deployService = require('../deployService');
const siteServer = require('../siteServer');

// The deploy step: what a successful first deployment leaves behind is the
// record, written by deployNow. No clone, no build, no listener.
const deployed = [];
deployService.deployNow = async ({ tenantPaths, project }) => {
    deployed.push(project);
    projectStore.saveProject(tenantPaths, Object.assign({}, project, { lastSha: 'a'.repeat(40) }));
    return { deployed: true };
};
siteServer.startSiteFor = () => null;

const github = require('../github');
github.listRootEntries = async () => [];

const routes = require('../routes');

console.log = () => { };

const TENANTS_ROOT = path.join(DATA_ROOT, 'tenants');
fs.mkdirSync(TENANTS_ROOT, { recursive: true });

function pathsFor(slug) {
    const root = path.join(TENANTS_ROOT, slug);
    return { root, deploy: path.join(root, 'deploy') };
}

const table = new Map();
const add = (method) => (routePath, ...chain) => table.set(`${method} ${routePath}`, chain);
routes.register({ get: add('GET'), post: add('POST'), delete: add('DELETE'), put: add('PUT'), patch: add('PATCH') }, {
    requireRole: () => (req, res, next) => next(),
    pathsFor,
    tenantsRoot: () => TENANTS_ROOT
});

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

test.after(() => fs.rmSync(DATA_ROOT, { recursive: true, force: true }));

test('a create whose manifest names ldap stores the method, with nobody allowed yet', async () => {
    const real = github.readRepoFile;
    github.readRepoFile = async (app, installationId, repo, file) =>
        file === 'aegis.deploy.json' ? JSON.stringify({ auth: 'ldap' }) : null;
    try {
        const answer = await call('POST /api/deploy/projects', {
            body: { runId: 'createauthrecord1', repoUrl: 'https://github.com/acme/site', branch: 'main' },
            query: {},
            params: {},
            tenant: { slug: 'acme' },
            tenantPaths: pathsFor('acme'),
            user: { email: 'ops@acme.test', role: 'admin' },
            hostname: 'aegis.test',
            protocol: 'http',
            get: () => 'aegis.test'
        });
        assert.strictEqual(answer.status, 200, JSON.stringify(answer.body));
        assert.strictEqual(deployed.length, 1, 'the deploy step ran once');
        const stored = projectStore.getProject(pathsFor('acme'), answer.body.project.id);
        assert.ok(stored && stored.auth, 'the auth record reached the store');
        assert.strictEqual(stored.auth.method, 'ldap');
        assert.deepStrictEqual(stored.auth.allowedGroups, [], 'the branch names the method, never who may enter');
    } finally {
        github.readRepoFile = real;
    }
});
