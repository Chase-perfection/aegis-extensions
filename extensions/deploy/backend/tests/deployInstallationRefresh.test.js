/**
 * The installation a project was created with is not the one it deploys with
 * forever.
 *
 * `installationId` is written once and was never read back against GitHub, so
 * registering a new App, or uninstalling and installing again, left every
 * project pointing at an installation the App no longer owns. GitHub answers
 * 404 there, and 404 was not a named reason, so the page said the clone failed
 * and the branch was worth checking. Both halves of that are what these tests
 * pin: the id is resolved again, and a repository no installation covers is
 * called `needs_install` rather than `deploy_failed`.
 *
 * No network and no clone: `tokenForProject` decides all of this before a
 * single git command runs, so it is exercised directly.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-install-refresh-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;
process.env.AEGIS_DEPLOY_ENABLED = '1';
process.env.AEGIS_DEPLOY_POLL_MS = '0';

const test = require('node:test');
const assert = require('node:assert');

const github = require('../github');
const projectStore = require('../projectStore');
const deployService = require('../deployService');

const TENANTS_ROOT = path.join(DATA_ROOT, 'tenants');
fs.mkdirSync(TENANTS_ROOT, { recursive: true });

const APP = { appId: '4963527', privateKey: 'not-a-real-key' };

function pathsFor(slug) {
    const root = path.join(TENANTS_ROOT, slug);
    fs.mkdirSync(path.join(root, 'deploy'), { recursive: true });
    return { root, deploy: path.join(root, 'deploy') };
}

let seq = 0;
function makeProject(installationId) {
    seq += 1;
    const slug = `t${seq}`;
    const paths = pathsFor(slug);
    const project = {
        id: `site-${seq}`,
        name: 'Site',
        repoFullName: 'acme/site',
        branch: 'main',
        installationId
    };
    projectStore.saveProject(paths, project);
    return { paths, project };
}

function stored(paths, id) {
    return projectStore.getProject(paths, id).installationId;
}

function collector() {
    const lines = [];
    return { say: { log: (t) => lines.push(t) }, lines };
}

/** Swaps the three github.js calls this path makes, and puts them back. */
function withGithub(impl, run) {
    const real = {
        installationToken: github.installationToken,
        installationForRepo: github.installationForRepo,
        forgetInstallationToken: github.forgetInstallationToken
    };
    Object.assign(github, {
        installationToken: impl.installationToken || (async () => { throw new Error('unexpected installationToken'); }),
        installationForRepo: impl.installationForRepo || (async () => { throw new Error('unexpected installationForRepo'); }),
        forgetInstallationToken: impl.forgetInstallationToken || (() => { })
    });
    return Promise.resolve().then(run).finally(() => Object.assign(github, real));
}

function refused(status) {
    return Object.assign(new Error(`GitHub answered ${status}`), { status });
}

test('a stored installation that still works is used, and nothing is looked up again', async () => {
    const { paths, project } = makeProject('111');
    let lookups = 0;
    await withGithub({
        installationToken: async (app, id) => { assert.strictEqual(id, '111'); return 'tok-111'; },
        installationForRepo: async () => { lookups += 1; return '999'; }
    }, async () => {
        const token = await deployService._tokenForProject(APP, paths, project, null);
        assert.strictEqual(token, 'tok-111');
    });
    assert.strictEqual(lookups, 0, 'a working installation must cost no extra call');
    assert.strictEqual(stored(paths, project.id), '111', 'a working installation must not be rewritten');
});

test('the KPI case: a stored installation GitHub refuses is resolved again and written back', async () => {
    const { paths, project } = makeProject('154611592');
    const { say, lines } = collector();
    let forgotten = null;
    await withGithub({
        installationToken: async (app, id) => {
            if (id === '154611592') throw refused(404);
            return `tok-${id}`;
        },
        installationForRepo: async (app, full) => {
            assert.strictEqual(full, 'acme/site');
            return '222';
        },
        forgetInstallationToken: (id) => { forgotten = id; }
    }, async () => {
        const token = await deployService._tokenForProject(APP, paths, project, say);
        assert.strictEqual(token, 'tok-222', 'the new installation was not used');
    });

    assert.strictEqual(stored(paths, project.id), '222',
        'the new id was not written back, so the next deployment pays the same 404');
    assert.strictEqual(forgotten, '154611592', 'the cached token for the dead installation was kept');
    assert.match(lines.join(''), /not this App's any more/,
        'the console does not say why the installation changed');
});

test('a 401 is treated the same way as a 404: the installation is looked up again', async () => {
    const { paths, project } = makeProject('111');
    await withGithub({
        installationToken: async (app, id) => {
            if (id === '111') throw refused(401);
            return `tok-${id}`;
        },
        installationForRepo: async () => '333'
    }, async () => {
        assert.strictEqual(await deployService._tokenForProject(APP, paths, project, null), 'tok-333');
    });
    assert.strictEqual(stored(paths, project.id), '333');
});

test('an installation refused with no replacement is needs_install, not deploy_failed', async () => {
    const { paths, project } = makeProject('154611592');
    await withGithub({
        installationToken: async () => { throw refused(404); },
        installationForRepo: async () => null
    }, async () => {
        const e = await deployService._tokenForProject(APP, paths, project, null).then(
            () => null, (err) => err);
        assert.ok(e, 'a repository no installation covers must not resolve to a token');
        assert.strictEqual(e.code, 'needs_install');
        assert.strictEqual(deployService.reasonFor(e), 'needs_install',
            'the page would tell the operator to go and check the branch');
    });
});

test('GitHub naming the same installation it just refused stops instead of re-minting', async () => {
    const { paths, project } = makeProject('154611592');
    let mints = 0;
    await withGithub({
        installationToken: async () => { mints += 1; throw refused(404); },
        installationForRepo: async () => '154611592'
    }, async () => {
        const e = await deployService._tokenForProject(APP, paths, project, null).then(
            () => null, (err) => err);
        assert.strictEqual(e && e.code, 'needs_install');
    });
    assert.strictEqual(mints, 1, 'the same installation was asked for a token twice');
});

test('an App installed after the project was created is picked up without recreating it', async () => {
    const { paths, project } = makeProject(null);
    const { say, lines } = collector();
    await withGithub({
        installationToken: async (app, id) => `tok-${id}`,
        installationForRepo: async () => '444'
    }, async () => {
        assert.strictEqual(await deployService._tokenForProject(APP, paths, project, say), 'tok-444');
    });
    assert.strictEqual(stored(paths, project.id), '444');
    assert.match(lines.join(''), /444 covers acme\/site/);
});

test('a repository no installation covers and never had one is still cloned anonymously', async () => {
    const { paths, project } = makeProject(null);
    await withGithub({
        installationForRepo: async () => null
    }, async () => {
        assert.strictEqual(await deployService._tokenForProject(APP, paths, project, null), null,
            'a public repository must still clone with no credential');
    });
    assert.strictEqual(stored(paths, project.id), null);
});

test('no App at all means no token and no call to GitHub', async () => {
    const { paths, project } = makeProject('111');
    await withGithub({}, async () => {
        assert.strictEqual(await deployService._tokenForProject(null, paths, project, null), null);
        assert.strictEqual(await deployService._tokenForProject({ appId: '1' }, paths, project, null), null);
    });
});

test('a failure that is not a refusal is left alone rather than retried', async () => {
    const { paths, project } = makeProject('111');
    await withGithub({
        installationToken: async () => { throw refused(502); }
    }, async () => {
        const e = await deployService._tokenForProject(APP, paths, project, null).then(
            () => null, (err) => err);
        assert.strictEqual(e && e.status, 502, 'GitHub being down must not read as a dead installation');
        assert.strictEqual(deployService.reasonFor(e), 'github_unreachable');
    });
    assert.strictEqual(stored(paths, project.id), '111', 'a transient failure must not rewrite the record');
});
