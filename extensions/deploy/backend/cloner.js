/**
 * Fetches a repository's files and puts them where the site server reads.
 *
 * `git clone` transfers files and runs nothing from the repository: no
 * install script, no build command, no `postinstall`. That part is safe to
 * run as the backend's own user, which on an installed Aegis is SYSTEM on
 * the domain's audit server.
 *
 * `npm ci` and a build command execute code the repository author wrote, so
 * they never run here either. When a project has a `buildCmd` configured,
 * `cloneToCurrent` hands the clone off to `build/builder.js`, which runs
 * install/build inside a restricted account and a Job Object (see
 * docs/superpowers/specs/2026-08-18-deploy-build-sandbox-design.md) and
 * hands back a built output directory. `assertServableAsIs` still runs
 * against whatever directory is about to be served -- unbuilt or built --
 * so a build that produced no usable site is refused the same way an
 * unbuilt repository always was.
 */

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

/** A shallow clone of one branch still transfers the whole tree at that commit. */
const CLONE_TIMEOUT_MS = 120000;

/**
 * Where git is, for a backend that does not share the operator's PATH.
 *
 * Git for Windows installed without admin puts its directory in one user's
 * PATH and in no other. The backend runs as SYSTEM on an installed Aegis, and
 * as whichever elevated account started the launcher on a dev host, so neither
 * sees that entry: `execFile` fails with ENOENT and the deployment is refused
 * for a tool that is sitting on the disk. Probing the install locations costs
 * one `existsSync` per candidate and removes a support call that reads as a
 * broken branch.
 *
 * PATH is tried first, so an operator who put a specific git there keeps it,
 * and `AEGIS_GIT_EXE` overrides everything for a host that keeps git elsewhere.
 */
let resolvedGit = null;
function gitExe() {
    if (resolvedGit) return resolvedGit;
    if (process.env.AEGIS_GIT_EXE) return (resolvedGit = process.env.AEGIS_GIT_EXE);

    try {
        require('child_process').execFileSync('git', ['--version'], { windowsHide: true, stdio: 'ignore' });
        return (resolvedGit = 'git');
    } catch (_) { /* not on this account's PATH; fall through to the disk */ }

    const roots = [
        process.env['ProgramFiles'],
        process.env['ProgramFiles(x86)'],
        process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Programs')
    ];
    for (const root of roots) {
        if (!root) continue;
        const candidate = path.join(root, 'Git', 'cmd', 'git.exe');
        if (fs.existsSync(candidate)) return (resolvedGit = candidate);
    }
    // Nothing found: keep the bare name so the ENOENT names git, which
    // deployService turns into `tool_missing`.
    return (resolvedGit = 'git');
}

function run(file, args, opts) {
    const { onOutput, ...spawnOpts } = opts || {};
    return new Promise((resolve, reject) => {
        // execFile, never exec: no shell means a branch name cannot become a
        // command, and the token below never reaches a shell history.
        const child = execFile(file, args, Object.assign({ timeout: CLONE_TIMEOUT_MS, windowsHide: true }, spawnOpts),
            (err, stdout, stderr) => {
                if (err) {
                    // Git puts the remote URL in its errors, and that URL carries
                    // the access token. Redacted before this string goes anywhere.
                    err.output = redact(String(stderr || stdout || err.message));
                    return reject(err);
                }
                resolve(String(stdout || ''));
            });

        // execFile hands the whole output over at exit, which is fine for a
        // return value and useless for a console someone is watching. The
        // streams are still there underneath, so the build log gets them as
        // they arrive and the callback above keeps doing its job. Redacted the
        // same way, because git writes the tokenised URL to stderr on progress.
        if (onOutput) {
            const feed = (chunk) => onOutput(redact(String(chunk)));
            if (child.stdout) child.stdout.on('data', feed);
            if (child.stderr) child.stderr.on('data', feed);
        }
    });
}

/** Removes an access token from anything about to be logged or returned. */
function redact(text) {
    return text.replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
}

/**
 * Refuses a tree this slice cannot honestly serve.
 *
 * Two refusals, and telling them apart is the whole point. `needs_build` means
 * the branch holds source that some build step turns into a site. `no_index`
 * means this looks like a static site that is missing its entry point, where
 * naming a subdirectory is the fix.
 *
 * The hard case is a folder that has an `index.html` and is still source. A Vite
 * or React tree keeps one at its root that loads `/src/main.tsx`: the file
 * exists, so "is there an index.html" answers yes, and serving it publishes a
 * blank page that reports no error anywhere. `isBuildTemplate` is what tells
 * those apart, by looking at what the page actually loads.
 */
const BUILD_FILES = ['package.json', 'Dockerfile', 'dockerfile'];

/** Entry points a browser will not execute, whatever the server sends. */
const SOURCE_ENTRY_RE = /<script[^>]*\ssrc=["'][^"']*\.(?:tsx?|jsx|vue|svelte)["']/i;

/** Only the head of the file is read: a build entry point is small and the tag is in it. */
const INDEX_PEEK_BYTES = 16384;

function hasBuildFile(dir) {
    return BUILD_FILES.some((f) => fs.existsSync(path.join(dir, f)));
}

/**
 * Whether this index.html is a build entry point rather than a page.
 *
 * Reads the file instead of guessing from a neighbouring `package.json`,
 * because a static site is allowed to carry one for its linter and refusing it
 * on that basis would be wrong. What cannot be argued with is a `<script src>`
 * pointing at a module the browser has no way to run.
 */
function isBuildTemplate(indexPath) {
    let head;
    try {
        const fd = fs.openSync(indexPath, 'r');
        try {
            const buf = Buffer.alloc(INDEX_PEEK_BYTES);
            head = buf.slice(0, fs.readSync(fd, buf, 0, INDEX_PEEK_BYTES, 0)).toString('utf8');
        } finally {
            fs.closeSync(fd);
        }
    } catch (_) {
        return false;   // unreadable: let the rest of the checks decide
    }
    return SOURCE_ENTRY_RE.test(head);
}

/** Immediate subdirectories, hidden ones excluded. Empty when `dir` is unreadable. */
function childDirs(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
            .map((e) => e.name);
    } catch (_) {
        return [];
    }
}

/**
 * The first subdirectory that holds a site, or null. The `rootDir` to suggest.
 *
 * Stricter than the test applied to the folder the operator chose, and
 * deliberately so: naming a folder is a guess made on their behalf, so it takes
 * both signals to be wrong at once before this points at something. A folder
 * with a `package.json` beside its `index.html` is left alone even when the page
 * looks servable, because the odds are it is a `vite build` away from being one.
 */
function siteSubdir(dir) {
    return childDirs(dir).find((name) => {
        const child = path.join(dir, name);
        return fs.existsSync(path.join(child, 'index.html')) &&
            !hasBuildFile(child) &&
            !isBuildTemplate(path.join(child, 'index.html'));
    }) || null;
}

/**
 * Whether this tree is source waiting on a build step.
 *
 * One level only. A deeper walk would start reporting `needs_build` for a static
 * site that happens to vendor a package.json somewhere.
 */
function looksLikeSource(dir) {
    if (hasBuildFile(dir)) return true;
    return childDirs(dir).some((name) => hasBuildFile(path.join(dir, name)));
}

function needsBuild(message) {
    return Object.assign(new Error(message), { code: 'needs_build' });
}

function assertServableAsIs(dir) {
    const index = path.join(dir, 'index.html');

    if (fs.existsSync(index)) {
        // The operator picked this folder, so a `package.json` sitting in it is
        // not enough to overrule them. An entry point the browser cannot run is.
        if (!isBuildTemplate(index)) return;
        throw needsBuild('the index.html here loads a source module, so it is a build entry point and not a page');
    }

    if (hasBuildFile(dir)) {
        throw needsBuild('this branch holds source that has to be built before it can be served');
    }

    const sub = siteSubdir(dir);
    if (sub) {
        throw Object.assign(
            new Error(`no index.html at the root of this branch, but ${sub}/ has one`),
            { code: 'no_index', rootDir: sub });
    }

    if (looksLikeSource(dir)) {
        throw needsBuild('this branch holds source that has to be built before it can be served');
    }
    throw Object.assign(new Error('no index.html at the root of this branch'), { code: 'no_index' });
}

const accountPool = require('./build/accountPool');
const { buildInSandbox } = require('./build/builder');
const { runLauncher } = require('./build/launcher');
const { assertNoSymlinks } = require('./build/symlinkGuard');
const siteConfig = require('./siteConfig');

/** Where sandboxed builds happen -- fixed, machine-level, not tenant-scoped. See the design doc's "Sandbox identity" section for why. */
function buildWorkspaceRoot() {
    return process.env.AEGIS_BUILD_WORKSPACE_ROOT ||
        (process.env.ProgramData ? require('path').join(process.env.ProgramData, 'Aegis', 'deploy-build') : '/var/lib/aegis/deploy-build');
}

async function defaultBuild({ staging, installCmd, buildCmd, outputDir, buildEnv, report, signal }) {
    return buildInSandbox({
        pool: accountPool.defaultPool,
        workspaceRoot: buildWorkspaceRoot(),
        staging, installCmd, buildCmd, outputDir, buildEnv,
        timeoutMs: Number(process.env.AEGIS_BUILD_TIMEOUT_MS) || 10 * 60 * 1000,
        runLauncher,
        report,
        signal
    });
}

/**
 * A no-op reporter, so every call site below can write `report.stage(...)`
 * without asking first whether anyone is listening. The poller deploys with no
 * console attached, and that is the common case.
 */
const SILENT = { stage() { }, log() { } };

/**
 * Clones `branch` into the project's `current` folder, atomically, running a
 * sandboxed build first when the project has one configured.
 *
 * The clone lands in a sibling temporary folder and is renamed into place, so
 * a failure part-way through leaves the previous version serving. That is the
 * plan's "failure never takes the site down", at the size this slice needs it:
 * one rename rather than a release directory and a junction.
 */
async function cloneToCurrent({ token, repoFullName, branch, projectDir, currentDir, rootDir, installCmd, buildCmd, outputDir, buildEnvFor, currentSha, previousSha, runtime, build, report, signal }) {
    const say = report || SILENT;
    const url = token
        ? `https://x-access-token:${token}@github.com/${repoFullName}.git`
        : `https://github.com/${repoFullName}.git`;
    const staging = path.join(projectDir, 'staging');
    const buildOutput = path.join(projectDir, 'build-output');

    fs.mkdirSync(projectDir, { recursive: true });
    fs.rmSync(staging, { recursive: true, force: true });

    try {
        // The command without the URL: the URL is where the token lives, and a
        // console the operator can screenshot is exactly where it must not be.
        say.stage('clone', 'running', `git clone --depth 1 --single-branch --branch ${branch}`);
        await run(gitExe(), ['clone', '--depth', '1', '--single-branch', '--branch', branch, url, staging],
            { signal, onOutput: (text) => say.log(text) });

        const head = (await run(gitExe(), ['-C', staging, 'rev-parse', 'HEAD'], { signal })).trim();
        say.log(`HEAD ${head}`);
        say.stage('clone', 'done');

        let served = staging;
        if (rootDir) {
            served = path.resolve(staging, rootDir);
            const inside = path.relative(staging, served);
            if (inside.startsWith('..') || path.isAbsolute(inside)) {
                throw Object.assign(new Error('root directory escapes the repository'), { code: 'bad_root_dir' });
            }
            if (!fs.existsSync(served)) {
                throw Object.assign(new Error(`no ${rootDir} in this branch`), { code: 'no_root_dir' });
            }
        }

        // An install command with no build command is not a mistake for a
        // project served by a process: `npm ci` then `node server.js` is a
        // whole deployment. The sandbox runs for either.
        if (buildCmd || installCmd) {
            const builtDir = await (build || defaultBuild)({
                staging: served, installCmd, buildCmd, outputDir,
                // A function of the head commit, not a ready-made object: the
                // sha is only known here, and a build whose
                // AEGIS_GIT_COMMIT_SHA names the previously live commit is
                // worse than one that has no sha at all.
                buildEnv: buildEnvFor ? buildEnvFor(head) : undefined,
                report: say, signal
            });
            // Copied rather than renamed: the sandbox workspace lives under
            // ProgramData, not necessarily the same volume as the tenant's
            // data root, and a cross-volume rename throws EXDEV. Copying into
            // a scratch folder on currentDir's own volume keeps the final
            // swap below an atomic same-volume rename, same as the no-build
            // path already relies on.
            fs.rmSync(buildOutput, { recursive: true, force: true });
            fs.cpSync(builtDir, buildOutput, { recursive: true });
            served = buildOutput;
        }

        // Refuse a symlink/junction anywhere in what's about to be served --
        // covers both a plain repository that committed one and (redundantly,
        // intentionally -- defense in depth) a sandboxed build's output, which
        // build/builder.js already checked once before returning it.
        const byProcess = runtime === 'node';
        say.stage('check', 'running', byProcess
            ? 'the start command answering on its port'
            : 'index.html in the served directory');
        assertNoSymlinks(served);

        if (byProcess) {
            // No index.html to look for: this project is served by a process,
            // and its acceptance test is that process answering. That happens
            // after the publish below, in `deployService`, because the process
            // runs against the folder this is about to put on the port.
            say.log('acceptance test: deferred to the start command, this project is served by a process');
        } else {
            assertServableAsIs(served);
            say.log('acceptance test: index.html found, accepted');

            // Read here rather than at the first request, so a `vercel.json`
            // nobody can parse refuses the deployment. A site whose config was
            // ignored looks exactly like a site whose config was wrong, and the
            // operator cannot tell from the outside which one they have. Nothing
            // reads it for a project served by a process: its own routing is the
            // application's job.
            const config = siteConfig.read(served);
            if (config.unsupported.length) {
                say.log(`vercel.json: Aegis does not honour ${config.unsupported.join(', ')}`);
            }
        }
        say.stage('check', 'done');

        // `.git` is 90% of a shallow clone's weight and serving it would publish the
        // repository's history to anyone who can reach the site.
        fs.rmSync(path.join(staging, '.git'), { recursive: true, force: true });

        say.stage('publish', 'running');
        publish({ served, currentDir, projectDir, currentSha, previousSha });
        say.log(currentSha
            ? `${currentSha.slice(0, 8)} filed as a release, current/ replaced`
            : 'current/ published');
        say.stage('publish', 'done');

        return { sha: head };
    } finally {
        // A refused clone used to leave its whole tree on disk, one copy per
        // failing project. Cleared here so the only surviving copy is the one
        // that was renamed into `current`, and a rejected repository costs
        // nothing after the attempt.
        fs.rmSync(staging, { recursive: true, force: true });
        fs.rmSync(buildOutput, { recursive: true, force: true });
    }
}

/**
 * The versions this project has published, newest first.
 *
 * A folder per commit under `releases/`, five of them, and the one on the port
 * is not among them: `current/` is the site and a release is a version waiting
 * to be put back. Before this, a project kept exactly one (`previous/`), which
 * made rollback a switch rather than a choice -- the operator who wanted the
 * version from two deployments ago had to redeploy a commit by hand.
 *
 * Five and not fifty. Each one is a full copy of a built site on the audit
 * server's disk, and a version nobody promoted in five deployments is a version
 * they will reach for through GitHub instead.
 */
const RELEASES_KEPT = 5;

/**
 * What may become a folder name under `releases/`.
 *
 * A release is named after the commit it holds and that name reaches
 * `path.join`, so it is checked before it gets there rather than sanitised
 * after. Seven characters is the short sha the page shows; `unknown` is the one
 * exception, for a version published before Aegis recorded which commit it was.
 */
const RELEASE_RE = /^(?:[0-9a-f]{7,64}|unknown)$/;

function releasesDir(projectDir) {
    return path.join(projectDir, 'releases');
}

/**
 * No default for a missing sha: `promote('')` has to be a refusal and not a
 * lookup of the `unknown` folder. A caller that genuinely means "the version
 * whose commit was never recorded" passes `unknown` itself, which is what the
 * two `keepAs` call sites below do.
 */
function releasePath(projectDir, sha) {
    const name = String(sha == null ? '' : sha);
    if (!RELEASE_RE.test(name)) {
        throw Object.assign(new Error(`${name} is not a commit`), { code: 'bad_release' });
    }
    return path.join(releasesDir(projectDir), name);
}

/**
 * Every kept version, newest first, by the time its folder was filed.
 *
 * Read from disk and not from the project record. The two can disagree -- a
 * crash between the rename and the write, a folder deleted by hand -- and the
 * one that decides whether a promote will work is the disk.
 */
function listReleases(projectDir) {
    let entries;
    try {
        entries = fs.readdirSync(releasesDir(projectDir), { withFileTypes: true });
    } catch (_) {
        return [];
    }
    return entries
        .filter((e) => e.isDirectory() && RELEASE_RE.test(e.name))
        .map((e) => {
            let at = 0;
            try { at = fs.statSync(path.join(releasesDir(projectDir), e.name)).mtimeMs; } catch (_) { }
            return { sha: e.name, at: Math.round(at) };
        })
        .sort((a, b) => b.at - a.at);
}

/** Drops the oldest releases past the cap. Called after a publish, not before. */
function pruneReleases(projectDir) {
    listReleases(projectDir).slice(RELEASES_KEPT).forEach((release) => {
        fs.rmSync(path.join(releasesDir(projectDir), release.sha), { recursive: true, force: true });
    });
}

/**
 * Files a `previous/` folder left by an install that predates `releases/`.
 *
 * An upgrade must not cost an operator the one version they could go back to,
 * and the folder is the same shape as a release, so it becomes one. Called from
 * both paths below rather than at boot: a project nobody deploys or promotes
 * does not need to be touched at all.
 */
function adoptPrevious({ projectDir, previousSha }) {
    const previous = path.join(projectDir, 'previous');
    if (!fs.existsSync(previous)) return false;

    const target = releasePath(projectDir, previousSha || 'unknown');
    fs.mkdirSync(releasesDir(projectDir), { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(previous, target);
    return true;
}

/**
 * Puts `served` on the port, keeping what was there as `keepAs`.
 *
 * Three renames on one volume, and the middle of them is the moment the site
 * has no folder at all. If the last one fails there -- a file an antivirus scan
 * is holding open, a full disk -- the version that was serving goes straight
 * back, because "a failure never takes the site down" is the promise this whole
 * sequence exists to keep. Without that restore the project served nothing
 * until somebody thought to click Rollback.
 *
 * `keepAs` null throws the outgoing version away, which is what a project with
 * nowhere to file it does.
 *
 * Exported so that restore is testable without a clone: it is the one path here
 * that can leave a site down, and it only ever runs when something else has
 * already gone wrong.
 */
function swapOnto({ served, currentDir, keepAs }) {
    const hadCurrent = fs.existsSync(currentDir);
    if (hadCurrent) {
        if (keepAs) {
            fs.mkdirSync(path.dirname(keepAs), { recursive: true });
            fs.rmSync(keepAs, { recursive: true, force: true });
            fs.renameSync(currentDir, keepAs);
        } else {
            fs.rmSync(currentDir, { recursive: true, force: true });
        }
    }
    fs.mkdirSync(path.dirname(currentDir), { recursive: true });
    try {
        fs.renameSync(served, currentDir);
    } catch (e) {
        if (hadCurrent && keepAs && !fs.existsSync(currentDir)) fs.renameSync(keepAs, currentDir);
        throw e;
    }
}

/**
 * Publishes a new version, filing the one it replaces as a release.
 *
 * `currentSha` is the commit the site is serving now, which is the name its
 * folder takes under `releases/`. A project that never recorded one files it as
 * `unknown`, and there is only ever one of those: a nameless version is not
 * worth two folders.
 */
function publish({ served, currentDir, projectDir, currentSha, previousSha }) {
    adoptPrevious({ projectDir, previousSha });
    swapOnto({ served, currentDir, keepAs: releasePath(projectDir, currentSha || 'unknown') });
    pruneReleases(projectDir);
}

/**
 * Puts one kept release back on the port.
 *
 * No clone, no build, no acceptance test: this content already passed all three
 * when it was published. That is what makes it the one action here that is
 * instant and cannot be refused for a reason on GitHub's side.
 *
 * A swap and not a restore: the version being replaced becomes a release, so the
 * same button undoes the undo, and the disk holds the same set either way.
 */
function promote({ projectDir, currentDir, sha, currentSha, previousSha }) {
    adoptPrevious({ projectDir, previousSha });

    const target = releasePath(projectDir, sha);      // throws bad_release first
    if (!fs.existsSync(target)) {
        throw Object.assign(new Error(`no release ${sha} on disk`), { code: 'unknown_release' });
    }
    swapOnto({ served: target, currentDir, keepAs: releasePath(projectDir, currentSha || 'unknown') });
}

/**
 * Puts the most recent release back, which is what the Rollback button asks
 * for.
 *
 * Kept as its own function because the button's promise is "one click, no
 * choice to make", and reading the newest release off the disk is how that
 * promise stays true when the record and the disk disagree.
 */
function rollback({ projectDir, currentDir, currentSha, previousSha }) {
    adoptPrevious({ projectDir, previousSha });

    const newest = listReleases(projectDir)[0];
    if (!newest) {
        throw Object.assign(new Error('no previous version on disk'), { code: 'no_previous' });
    }
    promote({ projectDir, currentDir, sha: newest.sha, currentSha, previousSha });
    return newest.sha;
}

module.exports = {
    cloneToCurrent, publish, promote, rollback, swapOnto,
    listReleases, adoptPrevious, releasesDir, RELEASES_KEPT,
    assertServableAsIs, looksLikeSource, redact, gitExe
};
