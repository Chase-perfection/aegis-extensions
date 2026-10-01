/**
 * What a site served by a process needs and nothing installs.
 *
 * The case behind it: KPI starts with `python packaging/api/kpi_api.py`, keeps
 * its `requirements.txt` beside the script, and had no install command. Every
 * stage passed and the process died on `import openpyxl`. Deploy now refuses
 * before publishing and asks whether to install what the branch declares.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const siteNeeds = require('../siteNeeds');

function tree(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-needs-'));
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    }
    return root;
}

const KPI_REQUIREMENTS = [
    '# Dependances de KPI-API.',
    'openpyxl>=3.1',
    '',
    '# Uniquement pour construire KPI.exe, pas pour l executer.',
    'pyinstaller>=6.6',
    ''
].join('\r\n');

test('KPI: the requirements beside the script are found, and PyInstaller is left out', () => {
    const root = tree({
        'packaging/api/kpi_api.py': 'import scheduler\n',
        'packaging/api/requirements.txt': KPI_REQUIREMENTS
    });
    const needs = siteNeeds.find({ root, startCmd: 'python packaging/api/kpi_api.py', installCmd: '' });
    assert.deepStrictEqual(needs, {
        kind: 'python',
        file: 'packaging/api/requirements.txt',
        packages: ['openpyxl'],
        installCmd: 'python -m pip install --no-cache-dir -r packaging/api/requirements.txt --target .'
    });
});

test('an install command, typed or declared, is an answer and is not questioned', () => {
    const root = tree({ 'packaging/api/requirements.txt': 'openpyxl\n' });
    const needs = siteNeeds.find({
        root,
        startCmd: 'python packaging/api/kpi_api.py',
        installCmd: 'pip install --no-cache-dir -r packaging/api/requirements.txt --target .'
    });
    assert.strictEqual(needs, null);
});

test('a project served as files runs nothing and needs nothing', () => {
    const root = tree({ 'requirements.txt': 'flask\n' });
    assert.strictEqual(siteNeeds.find({ root, startCmd: '', installCmd: '' }), null);
});

test('the nearest requirements file wins, walking up to the root and no further', () => {
    const root = tree({
        'requirements.txt': 'flask\n',
        'app/api/server.py': '',
        'app/requirements.txt': 'fastapi\nuvicorn\n'
    });
    const needs = siteNeeds.find({ root, startCmd: 'python app/api/server.py', installCmd: '' });
    assert.strictEqual(needs.file, 'app/requirements.txt');
    assert.deepStrictEqual(needs.packages, ['fastapi', 'uvicorn']);

    const atRoot = siteNeeds.find({ root, startCmd: 'python -m app.api.server', installCmd: '' });
    assert.strictEqual(atRoot.file, 'requirements.txt');
});

test('a start command pointing outside the site only ever reads the site root', () => {
    const root = tree({ 'requirements.txt': 'requests\n' });
    const needs = siteNeeds.find({ root, startCmd: 'python ../../elsewhere/app.py', installCmd: '' });
    assert.strictEqual(needs.file, 'requirements.txt');
});

test('a requirements file that only builds an executable needs nothing at run time', () => {
    const root = tree({ 'requirements.txt': 'pyinstaller>=6.6\n# comment\n' });
    assert.strictEqual(siteNeeds.find({ root, startCmd: 'python app.py', installCmd: '' }), null);
});

test('an include it cannot name still counts as something to install', () => {
    const root = tree({ 'requirements.txt': '-r base.txt\n' });
    const needs = siteNeeds.find({ root, startCmd: 'py app.py', installCmd: '' });
    assert.deepStrictEqual(needs.packages, []);
    assert.strictEqual(needs.file, 'requirements.txt');
});

test('python spelled any of the usual ways is recognised', () => {
    const root = tree({ 'requirements.txt': 'flask\n' });
    for (const exe of ['python', 'python3', 'python3.13', 'py', 'python.exe', 'C:\\Python313\\python.exe']) {
        assert.ok(siteNeeds.find({ root, startCmd: `${exe} app.py`, installCmd: '' }), exe);
    }
    assert.strictEqual(siteNeeds.find({ root, startCmd: 'pythonista app.py', installCmd: '' }), null);
});

test('a path with a space is quoted in the install command', () => {
    const root = tree({ 'my api/requirements.txt': 'flask\n' });
    const needs = siteNeeds.find({ root, startCmd: 'python "my api/app.py"', installCmd: '' });
    assert.strictEqual(needs.installCmd,
        'python -m pip install --no-cache-dir -r "my api/requirements.txt" --target .');
});

test('node: dependencies with no node_modules are asked about, with the lockfile manager', () => {
    const root = tree({
        'package.json': JSON.stringify({ dependencies: { express: '^5.0.0' } }),
        'package-lock.json': '{}',
        'server.js': ''
    });
    const needs = siteNeeds.find({ root, startCmd: 'node server.js', installCmd: '' });
    assert.deepStrictEqual(needs, {
        kind: 'node', file: 'package.json', packages: ['express'], installCmd: 'npm ci'
    });
});

test('node: a package.json in a subfolder installs there', () => {
    const root = tree({
        'api/package.json': JSON.stringify({ dependencies: { express: '^5.0.0' } }),
        'api/index.js': ''
    });
    const needs = siteNeeds.find({ root, startCmd: 'node api/index.js', installCmd: '' });
    assert.strictEqual(needs.installCmd, 'cd api && npm install');
});

test('node: committed node_modules, or no dependencies, needs nothing', () => {
    const shipped = tree({
        'package.json': JSON.stringify({ dependencies: { express: '^5.0.0' } }),
        'node_modules/express/package.json': '{}'
    });
    assert.strictEqual(siteNeeds.find({ root: shipped, startCmd: 'npm start', installCmd: '' }), null);

    const bare = tree({ 'package.json': JSON.stringify({ scripts: { start: 'node s.js' } }) });
    assert.strictEqual(siteNeeds.find({ root: bare, startCmd: 'npm start', installCmd: '' }), null);
});

test('an unknown program is not guessed at', () => {
    const root = tree({ 'requirements.txt': 'flask\n' });
    assert.strictEqual(siteNeeds.find({ root, startCmd: './serve.exe', installCmd: '' }), null);
});

test('the console line names the packages, the file and the command', () => {
    const line = siteNeeds.sentence({
        file: 'packaging/api/requirements.txt',
        packages: ['openpyxl'],
        installCmd: 'python -m pip install --no-cache-dir -r packaging/api/requirements.txt --target .'
    });
    assert.match(line, /needs openpyxl to run \(packaging\/api\/requirements\.txt\)/);
    assert.match(line, /python -m pip install/);
    assert.match(line, /version that was serving still is/);
});

test('a long list is cut the way the page cuts it', () => {
    const list = siteNeeds.packageList(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 'and $1 more');
    assert.strictEqual(list, 'a, b, c, d, e, f and 2 more');
});

/**
 * Read from the source, as deployMigrationsHook.test.js does: a real clone
 * needs github.com and a sandbox account to prove an order of calls. What
 * matters is that the question is asked before anything is built or put on
 * the port, so the version serving keeps serving while it waits.
 */
test('the question is asked after the manifest and before the build and the publish', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'cloner.js'), 'utf8');
    const manifest = src.indexOf('manifestLive.apply(');
    const ask = src.indexOf('siteNeeds.find(');
    const build = src.indexOf('await (build || defaultBuild)(');
    const publish = src.indexOf('publish({ served, currentDir');
    for (const [name, at] of Object.entries({ manifest, ask, build, publish })) {
        assert.ok(at > -1, `${name} not found in cloner.js`);
    }
    assert.ok(manifest < ask, 'an install command declared in aegis.deploy.json must count as the answer');
    assert.ok(ask < build, 'asked after the build: the build ran for nothing');
    assert.ok(ask < publish, 'asked after the publish: the version serving was replaced');
});
