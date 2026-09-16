'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildInSandbox } = require('../build/builder');
const { createPool } = require('../build/accountPool');

function tmpStaging(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-build-staging-'));
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
    return dir;
}

function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-build-root-'));
}

test('copies staging into the workspace and resolves a legitimate output dir', async () => {
    const staging = tmpStaging({ 'package.json': '{}', 'src/main.js': 'x' });
    const root = tmpRoot();
    const pool = createPool(['acct-a']);
    const calls = [];

    const result = await buildInSandbox({
        pool, workspaceRoot: root, staging,
        installCmd: 'npm ci', buildCmd: 'npm run build', outputDir: 'dist',
        timeoutMs: 1000,
        runLauncher: async (args) => {
            calls.push(args);
            fs.mkdirSync(path.join(args.workspace, 'dist'), { recursive: true });
            fs.writeFileSync(path.join(args.workspace, 'dist', 'index.html'), 'built');
        }
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].account, 'acct-a');
    assert.strictEqual(calls[0].installCmd, 'npm ci');
    assert.strictEqual(result, path.join(root, 'acct-a', 'dist'));
    assert.ok(fs.existsSync(path.join(result, 'index.html')));
    assert.strictEqual(pool.freeCount(), 1, 'slot must be released after success');
});

test('every legitimate relative outputDir shape survives (direction 2: no false positives)', async () => {
    const cases = ['dist', 'build', '.', 'out/public', './dist'];
    for (const outputDir of cases) {
        const staging = tmpStaging({ 'package.json': '{}' });
        const root = tmpRoot();
        const pool = createPool(['acct-a']);
        const result = await buildInSandbox({
            pool, workspaceRoot: root, staging,
            buildCmd: 'build', outputDir, timeoutMs: 1000,
            runLauncher: async (args) => {
                fs.mkdirSync(path.join(args.workspace, outputDir), { recursive: true });
            }
        });
        assert.ok(fs.existsSync(result), `outputDir '${outputDir}' must resolve inside the workspace`);
    }
});

test('every traversal attempt in outputDir is refused (direction 1: no false negatives)', async () => {
    const attempts = ['..', '../..', '../outside', 'a/../../escape', '/absolute/path'];
    for (const outputDir of attempts) {
        const staging = tmpStaging({ 'package.json': '{}' });
        const root = tmpRoot();
        const pool = createPool(['acct-a']);
        await assert.rejects(
            buildInSandbox({
                pool, workspaceRoot: root, staging,
                buildCmd: 'build', outputDir, timeoutMs: 1000,
                runLauncher: async () => {}
            }),
            (e) => e.code === 'bad_root_dir',
            `outputDir '${outputDir}' must be refused, not resolved`
        );
        assert.strictEqual(pool.freeCount(), 1, 'slot must still be released after a refused build');
    }
});

test('a build that never produces outputDir fails needs_build, and the slot is still released', async () => {
    const staging = tmpStaging({ 'package.json': '{}' });
    const root = tmpRoot();
    const pool = createPool(['acct-a']);
    await assert.rejects(
        buildInSandbox({
            pool, workspaceRoot: root, staging,
            buildCmd: 'build', outputDir: 'dist', timeoutMs: 1000,
            runLauncher: async () => {}
        }),
        (e) => e.code === 'needs_build'
    );
    assert.strictEqual(pool.freeCount(), 1);
});

test('a launcher failure (build command exit != 0) still releases the slot', async () => {
    const staging = tmpStaging({ 'package.json': '{}' });
    const root = tmpRoot();
    const pool = createPool(['acct-a']);
    await assert.rejects(
        buildInSandbox({
            pool, workspaceRoot: root, staging,
            buildCmd: 'build', outputDir: 'dist', timeoutMs: 1000,
            runLauncher: async () => { throw new Error('command exited 1'); }
        }),
        /command exited 1/
    );
    assert.strictEqual(pool.freeCount(), 1, 'slot must be released even when the launcher throws');
});

test('the workspace is wiped before copy, so a stale file from a previous build cannot leak', async () => {
    const staging = tmpStaging({ 'package.json': '{}' });
    const root = tmpRoot();
    const pool = createPool(['acct-a']);
    const workspace = path.join(root, 'acct-a');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'leftover-from-other-tenant.txt'), 'stale');

    await buildInSandbox({
        pool, workspaceRoot: root, staging,
        buildCmd: 'build', outputDir: '.', timeoutMs: 1000,
        runLauncher: async () => {}
    });

    assert.ok(!fs.existsSync(path.join(workspace, 'leftover-from-other-tenant.txt')),
        "a previous build's file must not survive into the next one");
    assert.ok(fs.existsSync(path.join(workspace, 'package.json')), "this build's own files must be present");
});

test('build output containing a symlink/junction is refused, and the slot is still released', async () => {
    const staging = tmpStaging({ 'package.json': '{}' });
    const root = tmpRoot();
    const pool = createPool(['acct-a']);
    const outsideTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-outside-target-'));
    fs.writeFileSync(path.join(outsideTarget, 'secret.txt'), 'must-not-be-reachable');

    await assert.rejects(
        buildInSandbox({
            pool, workspaceRoot: root, staging,
            buildCmd: 'build', outputDir: 'dist', timeoutMs: 1000,
            runLauncher: async (args) => {
                const dist = path.join(args.workspace, 'dist');
                fs.mkdirSync(dist, { recursive: true });
                fs.writeFileSync(path.join(dist, 'index.html'), 'ok');
                // The malicious part: a junction inside the build output pointing outside the workspace.
                fs.symlinkSync(outsideTarget, path.join(dist, 'evil-link'), 'junction');
            }
        }),
        (e) => e.code === 'unsafe_symlink',
        'a symlink/junction anywhere in the build output must be refused'
    );
    assert.strictEqual(pool.freeCount(), 1, 'slot must be released even when the build is refused for containing a symlink');
});

// A project served by a process may need `npm ci` and no build at all: the
// dependencies are the deployment. The sandbox has to run for that too, or the
// application starts against a folder with no node_modules in it.
test('an install command with no build command still runs the sandbox', async () => {
    const staging = tmpStaging({ 'package.json': '{}', 'server.js': 'x' });
    const root = tmpRoot();
    const pool = createPool(['acct-a']);
    const calls = [];

    const result = await buildInSandbox({
        pool, workspaceRoot: root, staging,
        installCmd: 'npm ci', buildCmd: '', outputDir: '',
        timeoutMs: 1000,
        runLauncher: async (args) => { calls.push(args); }
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].installCmd, 'npm ci');
    assert.strictEqual(calls[0].buildCmd, '');
    // The whole workspace is what gets published, since nothing named a
    // narrower output directory.
    assert.strictEqual(result, path.resolve(root, 'acct-a'));
    assert.ok(fs.existsSync(path.join(result, 'server.js')));
});

// Nothing to declare when the build says where it put things. An empty
// outputDir used to mean "serve the whole workspace", which for a build writing
// into dist/ serves the source sitting next to it.

test('an empty outputDir takes the directory the build wrote', async () => {
    const staging = tmpStaging({ 'package.json': '{}', 'src/main.js': 'x' });
    const root = tmpRoot();
    const pool = createPool(['acct-a']);
    const lines = [];

    const result = await buildInSandbox({
        pool, workspaceRoot: root, staging,
        installCmd: 'npm ci', buildCmd: 'npm run build', outputDir: '',
        timeoutMs: 1000,
        report: { stage() { }, log: (t) => lines.push(t) },
        runLauncher: async (args) => {
            fs.mkdirSync(path.join(args.workspace, 'dist'), { recursive: true });
            fs.writeFileSync(path.join(args.workspace, 'dist', 'index.html'), 'built');
        }
    });

    assert.strictEqual(result, path.join(root, 'acct-a', 'dist'),
        'the workspace was served instead of the directory the build wrote');
    assert.match(lines.join(''), /output directory: dist\//);
});

test('a directory the build did not write is not mistaken for its output', async () => {
    const staging = tmpStaging({
        'package.json': '{}',
        // Committed beside the source, which is what public/ usually is.
        'public/index.html': '<h1>source</h1>'
    });
    const root = tmpRoot();
    const pool = createPool(['acct-a']);

    const result = await buildInSandbox({
        pool, workspaceRoot: root, staging,
        buildCmd: 'npm run build', outputDir: '', timeoutMs: 1000,
        runLauncher: async (args) => {
            // A build that leaves public/ alone leaves its timestamp alone. Set
            // explicitly rather than relied on: the copy into the workspace and
            // the build's start can land in the same millisecond, and the rule
            // under test is "did this build write it", not "how fast is the disk".
            const old = new Date('2020-01-01T00:00:00Z');
            fs.utimesSync(path.join(args.workspace, 'public', 'index.html'), old, old);
        }
    });

    assert.strictEqual(result, path.join(root, 'acct-a'),
        'a committed public/ was served as if the build had produced it');
});

test('an outputDir the project declares is still what is served', async () => {
    const staging = tmpStaging({ 'package.json': '{}' });
    const root = tmpRoot();
    const pool = createPool(['acct-a']);

    const result = await buildInSandbox({
        pool, workspaceRoot: root, staging,
        buildCmd: 'npm run build', outputDir: 'out', timeoutMs: 1000,
        runLauncher: async (args) => {
            for (const d of ['dist', 'out']) {
                fs.mkdirSync(path.join(args.workspace, d), { recursive: true });
                fs.writeFileSync(path.join(args.workspace, d, 'index.html'), d);
            }
        }
    });

    assert.strictEqual(result, path.join(root, 'acct-a', 'out'),
        'discovery overruled the directory the project declared');
});

test('a project with an install command and no build discovers nothing', async () => {
    const staging = tmpStaging({ 'requirements.txt': 'flask' });
    const root = tmpRoot();
    const pool = createPool(['acct-a']);

    const result = await buildInSandbox({
        pool, workspaceRoot: root, staging,
        installCmd: 'pip install -r requirements.txt --target .', buildCmd: '',
        outputDir: '', timeoutMs: 1000,
        runLauncher: async (args) => {
            // pip --target . writes packages, some of which carry an index.html.
            fs.mkdirSync(path.join(args.workspace, 'build'), { recursive: true });
            fs.writeFileSync(path.join(args.workspace, 'build', 'index.html'), 'a package');
        }
    });

    assert.strictEqual(result, path.join(root, 'acct-a'),
        'a dependency folder was served as if it were a built site');
});
