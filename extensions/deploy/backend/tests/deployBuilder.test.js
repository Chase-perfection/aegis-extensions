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

test('the workspace folder itself survives the wipe, so the ACL setup gave it is kept', async () => {
    const staging = tmpStaging({ 'package.json': '{}' });
    const root = tmpRoot();
    const pool = createPool(['acct-a']);
    const workspace = path.join(root, 'acct-a');
    fs.mkdirSync(path.join(workspace, 'old', 'deep'), { recursive: true });
    const before = fs.statSync(workspace, { bigint: true }).ino;
    const scoped = [];

    await buildInSandbox({
        pool, workspaceRoot: root, staging,
        buildCmd: 'build', outputDir: '.', timeoutMs: 1000,
        scopeWorkspace: (dir, account) => {
            scoped.push([dir, account, fs.readdirSync(dir).length]);
        },
        runLauncher: async () => {}
    });

    assert.strictEqual(fs.statSync(workspace, { bigint: true }).ino, before,
        'the folder must be emptied, not deleted and made again');
    assert.ok(!fs.existsSync(path.join(workspace, 'old')));
    assert.deepStrictEqual(scoped, [[workspace, 'acct-a', 0], [`${workspace}.home`, 'acct-a', 0]],
        'permissions are reset on the empty workspace before the copy, and on the empty home beside it');
});

test('a workspace permission failure fails the build and releases the slot', async () => {
    const staging = tmpStaging({ 'package.json': '{}' });
    const pool = createPool(['acct-a']);
    let launched = false;
    await assert.rejects(
        buildInSandbox({
            pool, workspaceRoot: tmpRoot(), staging,
            buildCmd: 'build', outputDir: '.', timeoutMs: 1000,
            scopeWorkspace: () => { throw Object.assign(new Error('icacls refused'), { code: 'build_failed' }); },
            runLauncher: async () => { launched = true; }
        }),
        (e) => e.code === 'build_failed' && /icacls refused/.test(e.message)
    );
    assert.strictEqual(launched, false);
    assert.strictEqual(pool.freeCount(), 1);
});

function sandboxStartError(msg) {
    return Object.assign(new Error('Command failed'), { code: 3, sandboxStart: true, output: `run-sandboxed-build.ps1: ${msg}\n` });
}

test('a slot Windows will not start a process as is quarantined, and the build retries on another', async () => {
    const staging = tmpStaging({ 'package.json': '{}' });
    const pool = createPool(['acct-a', 'acct-b']);
    const tried = [];
    const logs = [];
    const result = await buildInSandbox({
        pool, workspaceRoot: tmpRoot(), staging,
        buildCmd: 'build', outputDir: '.', timeoutMs: 1000,
        report: { stage() { }, log(t) { logs.push(t); } },
        runLauncher: async ({ account }) => {
            tried.push(account);
            if (account === 'acct-a') throw sandboxStartError('could not start the build as acct-a (Windows error 1326)');
        }
    });
    assert.deepStrictEqual(tried, ['acct-a', 'acct-b']);
    assert.ok(result.endsWith('acct-b'));
    assert.deepStrictEqual(pool.health().map((h) => [h.account, h.ok]), [['acct-a', false], ['acct-b', null]]);
    assert.match(pool.health()[0].error, /^could not start the build as acct-a/, 'the reason is kept without the script prefix');
    assert.ok(logs.some((l) => /acct-a could not start a process/.test(l)), 'the console says which account went out and why');
});

test('a command that fails is never retried: the project is at fault, not the slot', async () => {
    const staging = tmpStaging({ 'package.json': '{}' });
    const pool = createPool(['acct-a', 'acct-b']);
    let runs = 0;
    await assert.rejects(
        buildInSandbox({
            pool, workspaceRoot: tmpRoot(), staging,
            buildCmd: 'build', outputDir: '.', timeoutMs: 1000,
            runLauncher: async () => { runs++; throw Object.assign(new Error('command exited 1'), { code: 1 }); }
        }),
        (e) => e.code === 'build_failed'
    );
    assert.strictEqual(runs, 1);
    assert.strictEqual(pool.freeCount(), 2, 'no slot is quarantined for a failing build');
});

test('two broken slots in a row fail as sandbox_unavailable, not build_failed', async () => {
    const staging = tmpStaging({ 'package.json': '{}' });
    const pool = createPool(['acct-a', 'acct-b', 'acct-c']);
    await assert.rejects(
        buildInSandbox({
            pool, workspaceRoot: tmpRoot(), staging,
            buildCmd: 'build', outputDir: '.', timeoutMs: 1000,
            runLauncher: async ({ account }) => { throw sandboxStartError(`could not start the build as ${account} (Windows error 5)`); }
        }),
        (e) => e.code === 'sandbox_unavailable'
    );
    assert.strictEqual(pool.freeCount(), 1, 'the one slot never tried stays in service');
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
        // A build that leaves public/ alone, and writes its output nowhere Aegis
        // looks. The rule under test is "did this build write it", read from the
        // file's own time before and after, so no clock is involved.
        runLauncher: async (args) => {
            fs.writeFileSync(path.join(args.workspace, 'build.log'), 'done');
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
    // A stand-in python.exe, so the runtime check passes whether or not this
    // machine has Python: what is under test is output discovery.
    const fakePython = tmpStaging({ 'python.exe': '' });

    const result = await buildInSandbox({
        pool, workspaceRoot: root, staging,
        installCmd: 'pip install -r requirements.txt --target .', buildCmd: '',
        outputDir: '', timeoutMs: 1000, toolDirs: () => [fakePython],
        runLauncher: async (args) => {
            // pip --target . writes packages, some of which carry an index.html.
            fs.mkdirSync(path.join(args.workspace, 'build'), { recursive: true });
            fs.writeFileSync(path.join(args.workspace, 'build', 'index.html'), 'a package');
        }
    });

    assert.strictEqual(result, path.join(root, 'acct-a'),
        'a dependency folder was served as if it were a built site');
});

// Windows only: the sandbox is, and on another OS no folder holds a python.exe.
test('a build whose command needs a runtime the host lacks stops with runtime_missing, before any account is used', { skip: process.platform !== 'win32' }, async () => {
    const staging = tmpStaging({ 'requirements.txt': 'flask' });
    const root = tmpRoot();
    const pool = createPool(['acct-a']);
    let launched = false;
    // Only toolDirs may count: a python.exe on this machine's own PATH would
    // make the test pass for the wrong reason.
    const inherited = process.env.Path;
    process.env.Path = '';
    try {
        const err = await buildInSandbox({
            pool, workspaceRoot: root, staging,
            installCmd: 'python -m pip install -r requirements.txt --target .', buildCmd: '',
            outputDir: '', timeoutMs: 1000,
            runLauncher: async () => { launched = true; },
            toolDirs: () => []
        }).then(() => null, (e) => e);
        assert.ok(err, 'the build went through');
        assert.strictEqual(err.code, 'runtime_missing');
        assert.strictEqual(err.tool, 'python');
        assert.strictEqual(launched, false);
        assert.strictEqual(pool.freeCount(), 1, 'no account was taken');
    } finally {
        process.env.Path = inherited;
    }
});
