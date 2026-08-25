/**
 * The two pieces of the static-site slice that fail silently if they break.
 *
 * `resolveFile` serves bytes from disk to anyone who can reach the site port, so
 * a path that escapes the site directory would publish the tenant's tree.
 * `assertServableAsIs` is the boundary that keeps repository code from running
 * on the audit server: if it ever stops refusing a project that needs building,
 * the next step is someone adding `npm ci` behind it.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveFile } = require('../siteServer');
const { assertServableAsIs } = require('../cloner');
const projectStore = require('../projectStore');
const { PROJECT_ID_RE } = projectStore;

function tmpTree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-sites-'));
    const site = path.join(root, 'current');
    fs.mkdirSync(path.join(site, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(site, 'index.html'), '<h1>ok</h1>');
    fs.writeFileSync(path.join(site, 'assets', 'app.css'), 'body{}');
    // The file a traversal would be reaching for.
    fs.writeFileSync(path.join(root, 'secret.txt'), 'tenant data');
    return { root, site };
}

test('resolveFile serves a file inside the site', () => {
    const { site } = tmpTree();
    assert.strictEqual(resolveFile(site, ['index.html']), path.join(site, 'index.html'));
    assert.strictEqual(resolveFile(site, ['assets', 'app.css']), path.join(site, 'assets', 'app.css'));
});

test('resolveFile falls back to index.html for a directory', () => {
    const { site } = tmpTree();
    assert.strictEqual(resolveFile(site, ['']), path.join(site, 'index.html'));
});

test('resolveFile refuses to leave the site directory', () => {
    const { site } = tmpTree();
    for (const attempt of [
        ['..', 'secret.txt'],
        ['assets', '..', '..', 'secret.txt'],
        ['%2e%2e', 'secret.txt'],          // encoded, decoded before resolution
        ['..%2fsecret.txt'],
        ['....', '....', 'secret.txt']
    ]) {
        assert.strictEqual(resolveFile(site, attempt), null,
            `${attempt.join('/')} must not resolve`);
    }
});

test('resolveFile refuses a segment that is not valid percent-encoding', () => {
    const { site } = tmpTree();
    assert.strictEqual(resolveFile(site, ['%ZZ']), null);
});

test('resolveFile gives no directory listing when index.html is missing', () => {
    const { site } = tmpTree();
    assert.strictEqual(resolveFile(site, ['assets']), null);
});

test('assertServableAsIs accepts a plain static site', () => {
    const { site } = tmpTree();
    assert.doesNotThrow(() => assertServableAsIs(site));
});

test('assertServableAsIs refuses a repository that needs building', () => {
    const { root } = tmpTree();
    const built = path.join(root, 'needs-build');
    fs.mkdirSync(built);
    fs.writeFileSync(path.join(built, 'package.json'), '{"scripts":{"build":"vite build"}}');
    assert.throws(() => assertServableAsIs(built), (e) => e.code === 'needs_build',
        'running an untrusted build command needs the container, not this path');
});

// A Vite tree keeps an index.html at the root of its source folder, so "does an
// index.html exist" answers yes for something that serves a blank page. This is
// the shape of Chase-perfection/portail-interne, and pointing an operator at
// `frontend` would have published nothing and reported success.
test('assertServableAsIs refuses a folder whose index.html is a build entry point', () => {
    const { root } = tmpTree();
    const repo = path.join(root, 'vite');
    fs.mkdirSync(path.join(repo, 'frontend'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'infra'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'frontend', 'index.html'),
        '<!doctype html><body><div id="root"></div>' +
        '<script type="module" src="/src/main.tsx"></script></body>');
    fs.writeFileSync(path.join(repo, 'frontend', 'package.json'), '{}');
    fs.writeFileSync(path.join(repo, 'infra', 'Dockerfile'), 'FROM nginx');
    assert.throws(() => assertServableAsIs(repo), (e) =>
        e.code === 'needs_build' && !e.rootDir,
        'a folder that serves a blank page must not be offered as the fix');
});

// Same test applied to the folder the operator chose themselves, where an
// index.html exists and provably cannot work.
test('assertServableAsIs refuses a build entry point at the served root', () => {
    const { root } = tmpTree();
    const repo = path.join(root, 'viteroot');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'index.html'),
        '<script type="module" src="/src/main.tsx"></script>');
    assert.throws(() => assertServableAsIs(repo), (e) => e.code === 'needs_build');
});

// A package.json alone does not make a page unservable: a static site is allowed
// to carry one for its linter, and the operator pointed at this folder.
test('assertServableAsIs serves a real page that has a package.json beside it', () => {
    const { root } = tmpTree();
    const repo = path.join(root, 'linted');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'index.html'), '<script src="app.js"></script>');
    fs.writeFileSync(path.join(repo, 'package.json'), '{"devDependencies":{"eslint":"*"}}');
    assert.doesNotThrow(() => assertServableAsIs(repo));
});

// The case the suggestion exists for: a genuine static site one level down, with
// the build machinery in a sibling folder that has nothing to do with it.
test('assertServableAsIs points at a subfolder that really holds a site', () => {
    const { root } = tmpTree();
    const repo = path.join(root, 'split');
    fs.mkdirSync(path.join(repo, 'site'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'infra'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'site', 'index.html'), '<h1>hello</h1>');
    fs.writeFileSync(path.join(repo, 'infra', 'Dockerfile'), 'FROM nginx');
    assert.throws(() => assertServableAsIs(repo), (e) =>
        e.code === 'no_index' && e.rootDir === 'site');
});

// Still source when nothing underneath is servable: front end in `app/`, no
// index.html anywhere. Nothing to point at, so `needs_build` is the honest answer.
test('assertServableAsIs still refuses source with no site under it', () => {
    const { root } = tmpTree();
    const repo = path.join(root, 'allsource');
    fs.mkdirSync(path.join(repo, 'app'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'app', 'package.json'), '{"scripts":{"build":"vite build"}}');
    assert.throws(() => assertServableAsIs(repo), (e) => e.code === 'needs_build');
});

test('assertServableAsIs refuses a tree with no entry point', () => {
    const { root } = tmpTree();
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    assert.throws(() => assertServableAsIs(empty), (e) => e.code === 'no_index');
});

// A project id becomes a directory name and a URL segment.
test('a project id cannot be a path', () => {
    for (const bad of ['..', 'a/b', 'a\\b', '.hidden', '-lead', 'UPPER', '']) {
        assert.ok(!PROJECT_ID_RE.test(bad), `${bad} must be refused`);
    }
    assert.ok(PROJECT_ID_RE.test('my-site'));
});

// Deleting a project is the only way to undo a mistaken one, and it touches
// three things: the record, the folder, and the listener. The first two are what
// a wrong id would damage.
test('deleteProject removes the record and the files, and only the named one', () => {
    const { root } = tmpTree();
    const tenantPaths = { root: path.join(root, 'tenant') };
    for (const id of ['keep', 'drop']) {
        projectStore.saveProject(tenantPaths, { id, name: id, port: 3081 });
        fs.mkdirSync(projectStore.currentDir(tenantPaths, id), { recursive: true });
        fs.writeFileSync(path.join(projectStore.currentDir(tenantPaths, id), 'index.html'), 'x');
    }

    const removed = projectStore.deleteProject(tenantPaths, 'drop');
    assert.strictEqual(removed.id, 'drop');
    assert.deepStrictEqual(projectStore.listProjects(tenantPaths).map((p) => p.id), ['keep']);
    assert.ok(!fs.existsSync(projectStore.projectDir(tenantPaths, 'drop')));
    assert.ok(fs.existsSync(projectStore.currentDir(tenantPaths, 'keep')));

    assert.strictEqual(projectStore.deleteProject(tenantPaths, 'drop'), null,
        'deleting twice must report the second one as absent, not throw');
});
