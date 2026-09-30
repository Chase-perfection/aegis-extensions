'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { assertNoSymlinks } = require('./symlinkGuard');
const { applyAutofixes } = require('./autofix');
const hostTools = require('./hostTools');

/** How often the console catches up with what the sandbox has written. */
const TAIL_INTERVAL_MS = 400;

const SILENT = { stage() { }, log() { } };

/**
 * Streams the sandbox's two log files to the console while the build runs.
 *
 * The sandbox redirects each command to its own file (`cmd /c "..." > install.log`
 * in run-sandboxed-build.ps1) rather than to stdout, and it does that on
 * purpose: the launcher passes no shell and the redirect is what keeps the
 * command's output away from the pwsh process's own. So there is no stream to
 * attach to, and the honest way to watch a build is to read the files as they
 * grow.
 *
 * Which file exists is also what tells install and build apart. The pwsh script
 * runs them in order and never announces the switch, so `build.log` appearing
 * is the only signal that install finished.
 *
 * ponytail: polling the two files, not a file watcher. fs.watch on Windows
 * reports a growing file inconsistently across volumes and network shares, and
 * a 400 ms read of a local log costs nothing next to the build it is watching.
 */
function tailLogs({ workspace, installCmd, buildCmd, report }) {
    const files = [
        { stage: 'install', cmd: installCmd, path: path.join(workspace, 'install.log') },
        { stage: 'build', cmd: buildCmd, path: path.join(workspace, 'build.log') }
    ].filter((f) => f.cmd);

    const offsets = new Map();
    let announced = null;

    function drain(file, final) {
        let size;
        try {
            size = fs.statSync(file.path).size;
        } catch {
            return;                       // not created yet, or already cleaned up
        }
        if (announced !== file.stage) {
            // Marking the earlier stage done here rather than on a timer: the
            // sandbox only opens build.log once install has exited.
            if (announced) report.stage(announced, 'done');
            report.stage(file.stage, 'running', file.cmd);
            announced = file.stage;
        }
        const from = offsets.get(file.path) || 0;
        if (size <= from) return;
        let text = '';
        try {
            const fd = fs.openSync(file.path, 'r');
            try {
                const buf = Buffer.alloc(size - from);
                fs.readSync(fd, buf, 0, buf.length, from);
                text = buf.toString('utf8');
            } finally {
                fs.closeSync(fd);
            }
        } catch {
            return;
        }
        offsets.set(file.path, size);
        // A partial last line is held back unless this is the final read, so a
        // chunk boundary in the middle of a word does not become two log lines.
        if (!final) {
            const cut = text.lastIndexOf('\n');
            if (cut === -1) {
                offsets.set(file.path, from);
                return;
            }
            offsets.set(file.path, from + Buffer.byteLength(text.slice(0, cut + 1), 'utf8'));
            text = text.slice(0, cut + 1);
        }
        report.log(text);
    }

    const timer = setInterval(() => files.forEach((f) => drain(f, false)), TAIL_INTERVAL_MS);
    if (timer.unref) timer.unref();

    return function stop() {
        clearInterval(timer);
        files.forEach((f) => drain(f, true));
        if (announced) report.stage(announced, 'done');
    };
}

/**
 * Where a build put its output, when the project did not say.
 *
 * The names every bundler writes into, most specific first. `public/` is last
 * and is the one that needs the second test: it is as often a source folder
 * committed beside the build as it is the build's own output.
 */
const OUTPUT_CANDIDATES = ['dist', 'build', 'out', '_site', 'public'];

/**
 * The directory this build produced, or null to serve the workspace as before.
 *
 * Two conditions, and the second is what keeps this from being a guess. A
 * candidate has to hold an `index.html`, and that file has to have been written
 * by the build that just ran. A repository that commits `public/index.html` and
 * builds into `dist/` would otherwise be served from its source, which looks
 * like a stale deployment rather than a misread.
 *
 * Nothing found means nothing changes: the workspace is served exactly as it was
 * before this existed, and the acceptance test says what it thinks of it.
 */
/**
 * Each candidate's `index.html` modification time before the build, null where
 * there is none. Compared against after the build rather than against the
 * clock: `Date.now()` and a file time come from two clocks of different
 * precision, and a file written a millisecond after the build started could
 * read as older than it, which failed a test at random and could have served a
 * real build from its source.
 */
function snapshotOutputs(workspace) {
    const before = {};
    for (const name of OUTPUT_CANDIDATES) {
        try {
            before[name] = fs.statSync(path.join(workspace, name, 'index.html')).mtimeMs;
        } catch {
            before[name] = null;
        }
    }
    return before;
}

function discoverOutput(workspace, buildCmd, before, say) {
    if (!buildCmd) return null;
    for (const name of OUTPUT_CANDIDATES) {
        const index = path.join(workspace, name, 'index.html');
        let stat;
        try {
            stat = fs.statSync(index);
        } catch {
            continue;
        }
        if (!stat.isFile() || stat.mtimeMs === before[name]) continue;
        say.log(`output directory: ${name}/, which this build wrote. `
            + 'Set it on the project to pin it.\n');
        return name;
    }
    return null;
}

/** Makes `dir` exist and hold nothing, keeping the folder itself and its ACL. */
function emptyDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 3 });
    }
}

/**
 * Gives the workspace the ACL Create-BuildAccounts.ps1 set: the build account,
 * SYSTEM and Administrators, nothing inherited. On every build, the way
 * runtime.js grants its folders on every start, so a folder that was replaced,
 * restored or made by hand is repaired instead of failing the build. Runs on
 * the empty folder, so what is copied in next inherits it.
 *
 * Principals by SID: the hosts are French Windows, and "Administrators" does
 * not resolve there.
 */
function scopeWorkspace(dir, account) {
    if (process.platform !== 'win32') return;
    try {
        execFileSync('icacls', [dir, '/inheritance:r',
            '/grant:r', `${account}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/Q'],
        { windowsHide: true, stdio: 'pipe' });
    } catch (e) {
        throw Object.assign(
            new Error(`could not give build account ${account} its workspace ${dir}: `
                + `${String(e.stderr || e.message).trim()}. Run the Deploy host setup again.`),
            // A slot fault: icacls refuses an account that no longer exists.
            { code: 'sandbox_unavailable', sandboxStart: true });
    }
}

/**
 * Runs install/build for `staging` inside a borrowed sandbox slot, and
 * resolves to the absolute path of the built output (inside that slot's
 * workspace).
 *
 * `pool` is an accountPool (accountPool.js). `runLauncher` is injected --
 * production passes launcher.js's runLauncher; tests pass a stub, so this
 * module is exercised with no real OS process and no real Windows account.
 *
 * `report` and `signal` are the build console's: one receives stages and log
 * lines, the other kills the sandbox when the operator cancels. Both are
 * optional, and a deployment the poller triggered passes neither.
 *
 * `buildEnv` is the project's own variables, already decrypted by
 * projectEnv.forBuild. This module never touches their values: it hands the
 * object to the launcher, which is where the decision about how to get them
 * across a process boundary without leaving a copy behind lives.
 */
async function buildInSandbox(opts) {
    const { pool } = opts;
    const say = opts.report || SILENT;
    // Before any account is taken: a project whose install says `python` on a
    // host with no all-users Python would otherwise fail minutes later with
    // "'python' n'est pas reconnu" inside the sandbox, which reads as the
    // project's fault. The drawer's "Install what is missing" is the fix.
    // Windows only, like the sandbox: elsewhere no folder holds a python.exe.
    const tool = process.platform === 'win32'
        ? hostTools.missingTool([opts.installCmd, opts.buildCmd], (opts.toolDirs || hostTools.toolDirs)())
        : null;
    if (tool) {
        throw Object.assign(new Error(`${tool} is not installed for all users on this server`), { code: 'runtime_missing', tool });
    }
    let last = null;
    // Two attempts: the second exists for one reason, a slot Windows would not
    // start a process as. Nothing of the project ran on that slot, so running
    // it again elsewhere is safe. A command that failed is never retried.
    for (let attempt = 0; attempt < 2; attempt++) {
        const account = await pool.borrow();
        try {
            return await buildOnce(account, opts, say);
        } catch (e) {
            if (!isSandboxFault(e)) throw e;
            const reason = firstLine(e.output || e.message);
            pool.quarantine(account, reason);
            say.log(`build account ${account} could not start a process, and is out of service until it passes a check: ${reason}\n`);
            last = e;
        } finally {
            pool.release(account);
        }
    }
    // A missing password already has a code, and a page sentence that says
    // which click creates it. Everything else is the sandbox, named as such.
    if (last.code !== 'build_account_unconfigured') last.code = 'sandbox_unavailable';
    throw last;
}

/** A failure of the slot rather than of the project: nothing of the project ran. */
function isSandboxFault(e) {
    return !!(e && (e.sandboxStart || e.code === 'build_account_unconfigured'));
}

function firstLine(text) {
    return String(text || '').replace(/^[^:\n]*\.ps1:\s*/, '').split(/\r?\n/).find((l) => l.trim()) || 'unknown error';
}

async function buildOnce(account, { workspaceRoot, staging, installCmd, buildCmd, outputDir, timeoutMs, runLauncher, signal, buildEnv, scopeWorkspace }, say) {
    let stopTail = null;
    try {
        const workspace = path.join(workspaceRoot, account);
        // Wiped first, not after: a crash mid-build leaves a dirty folder
        // rather than an orphaned account, and the NEXT use is what cleans it.
        //
        // Emptied, never removed. The folder carries the ACL that lets this
        // account in, and a folder deleted and made again inherits
        // ProgramData's instead, so Windows refused to start the build there
        // ("Access is denied") on every build after the first.
        emptyDir(workspace);
        if (scopeWorkspace) scopeWorkspace(workspace, account);
        fs.cpSync(staging, workspace, { recursive: true });

        // The account's profile for this build (npm's cache, temp files).
        // A sibling of the workspace, not a subfolder: a site served from `.`
        // would publish it. Emptied each build, like the workspace.
        const homeDir = `${workspace}.home`;
        emptyDir(homeDir);
        if (scopeWorkspace) scopeWorkspace(homeDir, account);

        // On the copy, never on the clone: a dependency this build has no use
        // for is dropped here rather than downloaded again on every deployment.
        // Runs before the tail starts so the operator reads why before they
        // read the install output that no longer mentions it.
        applyAutofixes({ workspace, installCmd, buildCmd, report: say });

        // Taken before the launcher, so `discoverOutput` can tell a directory
        // this build produced from one that was committed beside it.
        const before = snapshotOutputs(workspace);

        stopTail = tailLogs({ workspace, installCmd, buildCmd, report: say });
        try {
            await runLauncher({ workspace, homeDir, account, installCmd: installCmd || '', buildCmd, timeoutMs, signal, buildEnv });
        } catch (e) {
            // The install or build command exited non-zero, or pwsh could not
            // start. Named here because nothing further up can tell that apart
            // from a clone that failed, and "the clone failed" is what the
            // operator was being told about their own build script.
            if (!e.sandboxStart && (!e.code || typeof e.code === 'number')) e.code = 'build_failed';
            throw e;
        }
        stopTail();
        stopTail = null;

        // Nothing to declare when the build says where it put things. An empty
        // outputDir used to mean "serve the whole workspace", which for a build
        // that writes into dist/ serves the source next to it.
        const resolved = outputDir || discoverOutput(workspace, buildCmd, before, say);
        const built = path.resolve(workspace, resolved || '.');
        const inside = path.relative(workspace, built);
        if (inside.startsWith('..') || path.isAbsolute(inside)) {
            throw Object.assign(new Error('output directory escapes the workspace'), { code: 'bad_root_dir' });
        }
        if (!fs.existsSync(built)) {
            throw Object.assign(new Error(`build did not produce ${outputDir}`), { code: 'needs_build' });
        }
        assertNoSymlinks(built);
        return built;
    } finally {
        // A build that threw still wrote whatever explains why, and that tail is
        // the only place the operator will ever see it: the workspace is wiped
        // by the next build of any project.
        if (stopTail) stopTail();
    }
}

module.exports = { buildInSandbox, scopeWorkspace };
