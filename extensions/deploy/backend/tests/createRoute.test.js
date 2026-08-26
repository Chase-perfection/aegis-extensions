/**
 * The create route's contract with the build console.
 *
 * The browser mints a run id, opens the console on it, and only then sends the
 * request that starts the deployment. So every answer this route can give has
 * to leave a run readable under that id: a refusal that returns before the run
 * exists leaves the operator watching a pane with nothing in it, which is
 * exactly the bug this file exists to catch.
 *
 * No express and no network. `register` is handed a router that records its
 * handlers, and they are called with a request object built here, which is
 * enough to reach every refusal that fires before GitHub is contacted.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-deploy-create-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;
process.env.AEGIS_DEPLOY_ENABLED = '1';
// Mounting the routes starts the poller. Zero turns it off, so this file leaves
// no timer calling GitHub behind it.
process.env.AEGIS_DEPLOY_POLL_MS = '0';

const test = require('node:test');
const assert = require('node:assert');

const routes = require('../routes');
const runs = require('../runs');
const projectStore = require('../projectStore');
const siteAuth = require('../siteAuth');

console.log = () => { };

const TENANTS_ROOT = path.join(DATA_ROOT, 'tenants');
fs.mkdirSync(TENANTS_ROOT, { recursive: true });

function pathsFor(slug) {
    const root = path.join(TENANTS_ROOT, slug);
    return { root, deploy: path.join(root, 'deploy') };
}

/** Collects what `register` mounts, so a handler can be called by path. */
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

/** Runs a mounted chain to its first answer and resolves with `{ status, body }`. */
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

function request(body) {
    return {
        body,
        query: {},
        params: {},
        tenant: { slug: 'acme' },
        tenantPaths: pathsFor('acme'),
        user: { email: 'ops@acme.test', role: 'admin' },
        hostname: 'aegis.test',
        protocol: 'http',
        get: () => 'aegis.test'
    };
}

test('a refusal before the clone still leaves the console a run to show', async () => {
    const runId = 'aaaabbbbccccdddd';
    const answer = await call('POST /api/deploy/projects', request({
        runId,
        repoUrl: 'https://gitlab.com/acme/site'   // not github.com
    }));

    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, 'bad_repo_url');
    assert.equal(answer.body.runId, runId, 'the answer names the run the browser is watching');

    const run = runs.get('acme', runId);
    assert.ok(run, 'the console has a run to poll, rather than a blank pane');
    assert.equal(run.status, 'failed');
    assert.equal(run.error, 'bad_repo_url');

    const clone = run.stages.find((s) => s.key === 'clone');
    assert.equal(clone.status, 'failed');
    // Nothing ran after the refusal, so nothing is left spinning.
    assert.ok(run.stages.every((s) => s.status === 'failed' || s.status === 'skipped'));
});

test('a branch name git would read as a flag is refused, on the console too', async () => {
    const runId = 'branchbranch1234';
    const answer = await call('POST /api/deploy/projects', request({
        runId,
        repoUrl: 'https://github.com/acme/site',
        branch: '--upload-pack=calc'
    }));

    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, 'bad_branch');
    assert.equal(runs.get('acme', runId).error, 'bad_branch');
});

test('another tenant cannot read the run, even holding its id', async () => {
    const runId = 'tenantscopeid123';
    await call('POST /api/deploy/projects', request({ runId, repoUrl: 'not a url at all' }));

    assert.ok(runs.get('acme', runId));
    assert.equal(runs.get('other', runId), null);
});

test('the deployments list shows a create that never got a project', async () => {
    const runId = 'unattachedrun999';
    await call('POST /api/deploy/projects', request({ runId, repoUrl: 'ftp://example.test/x' }));

    const listed = runs.listRecent('acme', 30).map((r) => r.id);
    assert.ok(listed.includes(runId), 'a refused create is still a deployment that happened');
});


/* ------------------------------------------------------------------ */
/* dbFile and migrationsDir: settings a project owns because the        */
/* application, not Aegis, chooses them                                 */
/* ------------------------------------------------------------------ */

// The defaults themselves (no settings sent, empty strings sent) are covered
// offline in deployProjectSettings.test.js, against the pure module the
// route calls. Reaching that observation from here would mean letting a real
// `git clone` run, which is the network dependency this file's own docstring
// says the suite must not have.

test('a dbFile that climbs out of the data folder is refused', async () => {
    const answer = await call('POST /api/deploy/projects', request({
        runId: 'baddbfileescape01',
        repoUrl: 'https://github.com/acme/site',
        branch: 'main',
        dbFile: '..\\..\\aegis.db'
    }));

    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, 'bad_db_file');
});

test('a dbFile that is not a database name is refused the same way', async () => {
    const answer = await call('POST /api/deploy/projects', request({
        runId: 'baddbfilekind001',
        repoUrl: 'https://github.com/acme/site',
        branch: 'main',
        dbFile: 'notes.txt'
    }));

    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, 'bad_db_file');
});

test('a migrationsDir that climbs out of the clone is refused', async () => {
    const answer = await call('POST /api/deploy/projects', request({
        runId: 'badmigrationsdir1',
        repoUrl: 'https://github.com/acme/site',
        branch: 'main',
        migrationsDir: '../ailleurs'
    }));

    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, 'bad_migrations_dir');
});


/* ------------------------------------------------------------------ */
/* removing a project: what has to be gone afterwards                  */
/* ------------------------------------------------------------------ */

/** A project on disk, with files, a run, and a lockout against its id. */
function plant(id) {
    const paths = pathsFor('acme');
    projectStore.saveProject(paths, {
        id,
        name: id,
        repoFullName: 'acme/' + id,
        branch: 'main',
        port: 3099,
        lastSha: 'a'.repeat(40),
        auth: { enabled: true, allowedGroups: ['IT'] }
    });
    const dir = projectStore.projectDir(paths, id);
    fs.mkdirSync(path.join(dir, 'current'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'current', 'index.html'), 'the site');

    const run = runs.start({ slug: 'acme', projectId: id, projectName: id, trigger: 'manual' });
    // Three bad passwords from one address is what leaves a lockout behind.
    for (let i = 0; i < siteAuth.LOCK_THRESHOLD; i++) siteAuth._noteFailure('10.0.0.9', id);

    return { paths, dir, run };
}

test('removing a project takes its files, its runs and its lockouts with it', async () => {
    const id = 'site-to-remove';
    const { paths, dir, run } = plant(id);

    assert.ok(fs.existsSync(dir));
    assert.ok(runs.get('acme', run.id));
    assert.ok(siteAuth._lockRemaining('10.0.0.9', id) > 0, 'the lockout is there to begin with');

    const answer = await call('DELETE /api/deploy/projects/:id', Object.assign(
        request({}), { params: { id } }));

    assert.equal(answer.status, 200);
    assert.equal(answer.body.success, true);
    assert.equal(answer.body.name, id, 'the answer names what it removed');

    assert.equal(projectStore.getProject(paths, id), null, 'the record is gone');
    assert.equal(fs.existsSync(dir), false, 'the files it served are gone');
    assert.equal(runs.get('acme', run.id), null, 'its build consoles are gone');
    // The freed id goes back to the next project of the same name, so a lockout
    // left behind would meet a visitor who never typed a password here.
    assert.equal(siteAuth._lockRemaining('10.0.0.9', id), 0, 'its lockouts are gone');
});

test('removing an unknown project is a 404, not a silent success', async () => {
    const answer = await call('DELETE /api/deploy/projects/:id', Object.assign(
        request({}), { params: { id: 'never-existed' } }));
    assert.equal(answer.status, 404);
    assert.equal(answer.body.error, 'unknown_project');
});

test('a project id that is not a slug never reaches the filesystem', async () => {
    for (const id of ['../../etc', 'UPPER', 'has space', '.']) {
        const answer = await call('DELETE /api/deploy/projects/:id', Object.assign(
            request({}), { params: { id } }));
        assert.equal(answer.status, 404, `${id} was not refused`);
    }
});

test('a project being deployed is not deleted underneath the deployment', async () => {
    const id = 'site-busy';
    const { paths, dir } = plant(id);

    // What `deployNow` holds while it is renaming folders under this project.
    const deployService = require('../deployService');
    const inFlight = deployService._inFlight;
    inFlight.add(`acme/${id}`);
    try {
        const answer = await call('DELETE /api/deploy/projects/:id', Object.assign(
            request({}), { params: { id } }));
        assert.equal(answer.status, 409);
        assert.equal(answer.body.error, 'busy');
        assert.ok(fs.existsSync(dir), 'the files a deployment is renaming are still there');
        assert.ok(projectStore.getProject(paths, id), 'and so is the record');
    } finally {
        inFlight.delete(`acme/${id}`);
    }
});
