'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyAutofixes, requirementFiles, requirementName } = require('../build/autofix');
const { buildInSandbox } = require('../build/builder');
const { createPool } = require('../build/accountPool');

function tmpWorkspace(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-autofix-'));
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
    return dir;
}

function collector() {
    const lines = [];
    return { report: { log: (t) => lines.push(t) }, lines };
}

const KPI_REQUIREMENTS = [
    'openpyxl>=3.1',
    '',
    '# Embarquee dans KPI.exe par PyInstaller : rien a installer sur la machine',
    'pyinstaller>=6.6',
    ''
].join('\n');

test('the KPI case: a packaging-only dependency is skipped when the build does not use it', () => {
    const ws = tmpWorkspace({ 'packaging/api/requirements.txt': KPI_REQUIREMENTS });
    const { report, lines } = collector();

    const removed = applyAutofixes({
        workspace: ws,
        installCmd: 'pip install --no-cache-dir -r packaging/api/requirements.txt --target .',
        buildCmd: '',
        report
    });

    assert.strictEqual(removed.length, 1);
    assert.strictEqual(removed[0].name, 'pyinstaller');

    const after = fs.readFileSync(path.join(ws, 'packaging/api/requirements.txt'), 'utf8');
    assert.match(after, /^# skipped by Aegis Deploy, packaging only: pyinstaller>=6\.6$/m);
    assert.match(after, /^openpyxl>=3\.1$/m, 'the real dependency must survive');
    assert.ok(lines.join('').includes('packaging/api/requirements.txt: pyinstaller>=6.6'));
});

test('necessity: a build that runs the packaging tool keeps it', () => {
    const ws = tmpWorkspace({ 'requirements.txt': 'pyinstaller>=6.6\n' });

    const removed = applyAutofixes({
        workspace: ws,
        installCmd: 'pip install -r requirements.txt',
        buildCmd: 'pyinstaller --onefile app.py'
    });

    assert.deepStrictEqual(removed, []);
    assert.strictEqual(fs.readFileSync(path.join(ws, 'requirements.txt'), 'utf8'), 'pyinstaller>=6.6\n');
});

test('necessity holds when the command name differs from the distribution name', () => {
    const ws = tmpWorkspace({ 'requirements.txt': 'cx_Freeze==6.15\n' });

    const removed = applyAutofixes({
        workspace: ws,
        installCmd: 'pip install -r requirements.txt',
        buildCmd: 'cxfreeze --script app.py'
    });

    assert.deepStrictEqual(removed, [], 'cx-freeze ships the cxfreeze command');
});

test('direction 2, no false positives: ordinary dependencies are never touched', () => {
    const content = [
        'openpyxl>=3.1',
        'flask==3.0.0',
        'pytest>=8',
        'requests[socks]>=2.31',
        'ruff',
        '-e .',
        '-r other.txt',
        '# pyinstaller>=6.6',
        'pyinstaller-hooks-contrib>=2024.1'
    ].join('\n') + '\n';
    const ws = tmpWorkspace({ 'requirements.txt': content });

    // Backdated so the check below measures the write itself, not the content.
    // Asserting on the bytes alone cannot tell "left alone" from "rewritten
    // identically", and those differ: a rewrite changes the mtime pip and the
    // operator read, for a file this run had no reason to touch.
    const file = path.join(ws, 'requirements.txt');
    const past = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(file, past, past);

    const removed = applyAutofixes({
        workspace: ws,
        installCmd: 'pip install -r requirements.txt',
        buildCmd: ''
    });

    assert.deepStrictEqual(removed, []);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), content);
    assert.strictEqual(fs.statSync(file).mtimeMs, past.getTime(),
        'a run that changes nothing must not rewrite the file at all');
});

test('only the requirements file the install command names is read', () => {
    const ws = tmpWorkspace({
        'requirements.txt': 'pyinstaller>=6.6\n',
        'tools/requirements.txt': 'pyinstaller>=6.6\n'
    });

    const removed = applyAutofixes({
        workspace: ws,
        installCmd: 'pip install -r requirements.txt',
        buildCmd: ''
    });

    assert.strictEqual(removed.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(ws, 'tools/requirements.txt'), 'utf8'), 'pyinstaller>=6.6\n',
        'a requirements file nobody installs is none of our business');
});

test('a requirements path that escapes the workspace is refused', () => {
    const ws = tmpWorkspace({ 'requirements.txt': 'pyinstaller>=6.6\n' });
    const outside = path.join(ws, '..', 'escaped-requirements.txt');
    fs.writeFileSync(outside, 'pyinstaller>=6.6\n');

    try {
        const removed = applyAutofixes({
            workspace: ws,
            installCmd: 'pip install -r ../escaped-requirements.txt',
            buildCmd: ''
        });
        assert.deepStrictEqual(removed, []);
        assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'pyinstaller>=6.6\n');
    } finally {
        fs.rmSync(outside, { force: true });
    }
});

test('CRLF files stay CRLF', () => {
    const ws = tmpWorkspace({ 'requirements.txt': 'openpyxl>=3.1\r\npyinstaller>=6.6\r\n' });

    applyAutofixes({ workspace: ws, installCmd: 'pip install -r requirements.txt', buildCmd: '' });

    const after = fs.readFileSync(path.join(ws, 'requirements.txt'), 'utf8');
    assert.ok(after.includes('openpyxl>=3.1\r\n'), 'untouched lines keep their endings');
    assert.ok(after.includes('packaging only: pyinstaller>=6.6\r\n'), 'rewritten lines keep theirs');
});

test('a requirements file named but absent is left to pip to complain about', () => {
    const ws = tmpWorkspace({ 'README.md': 'x' });
    assert.deepStrictEqual(
        applyAutofixes({ workspace: ws, installCmd: 'pip install -r missing.txt', buildCmd: '' }), []);
});

test('requirementFiles reads every spelling pip accepts', () => {
    assert.deepStrictEqual(requirementFiles('pip install -r a.txt'), ['a.txt']);
    assert.deepStrictEqual(requirementFiles('pip install --requirement b.txt'), ['b.txt']);
    assert.deepStrictEqual(requirementFiles('pip install --requirement=c.txt'), ['c.txt']);
    assert.deepStrictEqual(requirementFiles('pip install -r "d e.txt"'), ['d e.txt']);
    assert.deepStrictEqual(requirementFiles('pip install -r a.txt -r b.txt'), ['a.txt', 'b.txt']);
    assert.deepStrictEqual(requirementFiles('npm ci'), []);
    assert.deepStrictEqual(requirementFiles(''), []);
    assert.deepStrictEqual(requirementFiles(undefined), []);
});

test('requirementName ignores what it cannot attribute to a distribution', () => {
    assert.strictEqual(requirementName('pyinstaller>=6.6'), 'pyinstaller');
    assert.strictEqual(requirementName('cx_Freeze==6.15'), 'cx-freeze');
    assert.strictEqual(requirementName('requests[socks]>=2.31'), 'requests');
    assert.strictEqual(requirementName('flask ; python_version < "3.12"'), 'flask');
    assert.strictEqual(requirementName('  # a comment'), null);
    assert.strictEqual(requirementName(''), null);
    assert.strictEqual(requirementName('-e .'), null);
    assert.strictEqual(requirementName('--index-url https://example.invalid'), null);
});

test('through the builder: the copy is fixed and the staging clone is not', async () => {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-autofix-staging-'));
    fs.writeFileSync(path.join(staging, 'requirements.txt'), KPI_REQUIREMENTS);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-autofix-root-'));
    const pool = createPool(['acct-a']);
    let seen = null;

    await buildInSandbox({
        pool, workspaceRoot: root, staging,
        installCmd: 'pip install -r requirements.txt --target .',
        buildCmd: '', outputDir: '', timeoutMs: 1000,
        runLauncher: async (args) => {
            seen = fs.readFileSync(path.join(args.workspace, 'requirements.txt'), 'utf8');
        }
    });

    assert.match(seen, /# skipped by Aegis Deploy, packaging only: pyinstaller>=6\.6/,
        'the sandbox must install from the fixed copy');
    assert.strictEqual(fs.readFileSync(path.join(staging, 'requirements.txt'), 'utf8'), KPI_REQUIREMENTS,
        'the clone Deploy made from GitHub must be untouched');
});
