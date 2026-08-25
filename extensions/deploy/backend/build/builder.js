'use strict';

const fs = require('fs');
const path = require('path');
const { assertNoSymlinks } = require('./symlinkGuard');

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
async function buildInSandbox({ pool, workspaceRoot, staging, installCmd, buildCmd, outputDir, timeoutMs, runLauncher, report, signal, buildEnv }) {
    const say = report || SILENT;
    const account = await pool.borrow();
    let stopTail = null;
    try {
        const workspace = path.join(workspaceRoot, account);
        // Wiped first, not after: a crash mid-build leaves a dirty folder
        // rather than an orphaned account, and the NEXT use is what cleans it.
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.mkdirSync(workspace, { recursive: true });
        fs.cpSync(staging, workspace, { recursive: true });

        stopTail = tailLogs({ workspace, installCmd, buildCmd, report: say });
        try {
            await runLauncher({ workspace, account, installCmd: installCmd || '', buildCmd, timeoutMs, signal, buildEnv });
        } catch (e) {
            // The install or build command exited non-zero, or pwsh could not
            // start. Named here because nothing further up can tell that apart
            // from a clone that failed, and "the clone failed" is what the
            // operator was being told about their own build script.
            if (!e.code || typeof e.code === 'number') e.code = 'build_failed';
            throw e;
        }
        stopTail();
        stopTail = null;

        const built = path.resolve(workspace, outputDir || '.');
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
        pool.release(account);
    }
}

module.exports = { buildInSandbox };
