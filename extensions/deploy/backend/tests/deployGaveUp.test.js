/**
 * `pollGaveUp` on the projects route.
 *
 * The sweep stops retrying a commit that has had its attempts, and a card that
 * has been given up on has to say so: otherwise it is indistinguishable from
 * one about to be tried again, and the operator waits for a retry that is never
 * coming. The page cannot work this out for itself -- the attempt counter is
 * not in the record it reads -- so the route answers the question directly.
 *
 * No express and no network, same shape as `createRoute.test.js`: `register` is
 * handed a router that records its handlers, and one is called with a request
 * built here.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-gaveup-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;
process.env.AEGIS_DEPLOY_ENABLED = '1';
// Mounting the routes starts the poller. Zero turns it off, so this file leaves
// no timer calling GitHub behind it.
process.env.AEGIS_DEPLOY_POLL_MS = '0';

const test = require('node:test');
const assert = require('node:assert');

const routes = require('../routes');
const projectStore = require('../projectStore');
const { SAME_SHA_ATTEMPTS } = require('../poller');

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

const SLUG = 'acme';

function request() {
    return {
        body: {},
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

/** Writes one project record and returns its view off the projects route. */
async function viewOf(over) {
    const paths = pathsFor(SLUG);
    fs.mkdirSync(paths.deploy, { recursive: true });
    // Always the same id, so `saveProject` replaces the previous case's record
    // rather than the list growing one project per test.
    projectStore.saveProject(paths, Object.assign({
        id: 'pulse-app',
        name: 'Pulse',
        repoFullName: 'acme/pulse',
        branch: 'main',
        runtime: 'static',
        lastSha: null,
        lastError: 'needs_build',
        failureCount: 8
    }, over || {}));

    const answer = await call('GET /api/deploy/projects', request());
    assert.equal(answer.status, 200);
    const found = answer.body.projects.find((p) => p.id === 'pulse-app');
    assert.ok(found, 'the project is in the answer');
    return found;
}

// The live install's `pulse-app`: eight consecutive `needs_build` failures, and
// nothing that would ever have stopped the ninth.
test('a commit that has had its attempts is reported as given up on', async () => {
    const view = await viewOf({
        lastFailedSha: 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222',
        failedShaAttempts: SAME_SHA_ATTEMPTS
    });
    assert.strictEqual(view.pollGaveUp, true);
    // The refusal is still there: what is wrong and what Aegis stopped doing
    // about it are two separate facts, and the card shows both.
    assert.strictEqual(view.lastError, 'needs_build');
});

test('a commit with attempts left is not reported as given up on', async () => {
    const view = await viewOf({
        lastFailedSha: 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222',
        failedShaAttempts: SAME_SHA_ATTEMPTS - 1
    });
    assert.strictEqual(view.pollGaveUp, false);
});

// A record written before these two fields existed. It must read as "still
// being retried", not as "given up on": an upgrade that silently stopped
// deploying every existing project would be the worse bug of the two.
test('a project predating the counter is not reported as given up on', async () => {
    const view = await viewOf({});
    assert.strictEqual(view.pollGaveUp, false);
});

// A failure that named no commit -- a clone that died before the head was read
// -- blocks nothing, so it must not read as given up on either.
test('a failure with no commit named is not reported as given up on', async () => {
    const view = await viewOf({ lastFailedSha: null, failedShaAttempts: 20 });
    assert.strictEqual(view.pollGaveUp, false);
});

// A project that has since deployed is not carrying a block at all.
test('a project that deployed since is not reported as given up on', async () => {
    const view = await viewOf({
        lastSha: 'cccc3333cccc3333cccc3333cccc3333cccc3333',
        lastError: null,
        failureCount: 0,
        lastFailedSha: null,
        failedShaAttempts: 0
    });
    assert.strictEqual(view.pollGaveUp, false);
});
