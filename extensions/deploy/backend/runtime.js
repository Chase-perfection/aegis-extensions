/**
 * Long-running application processes: the node runtime.
 *
 * Everything else in this extension serves files. A project that needs server
 * rendering, API routes or middleware needs a process running its code on this
 * machine, and this machine is a domain's audit server. So this module is behind
 * two locks that nothing else here has:
 *
 * `AEGIS_DEPLOY_RUNTIME=1` on the host, which is a change-management decision
 * and not a form field, exactly like `AEGIS_DEPLOY_ENABLED`. And
 * `AEGIS_RUNTIME_ACCOUNTS`, the restricted local accounts a server process runs
 * as -- separate names from the build accounts, because a build borrows a slot
 * for two minutes and a runtime holds one until the project is deleted. Sharing
 * the pool would mean one SSR project starving every build on the install.
 *
 * The isolation is the one the build sandbox already established: a restricted
 * local account, a Job Object with KILL_ON_JOB_CLOSE, no domain rights. The
 * process is a child of a pwsh that stays alive for its lifetime, so killing
 * pwsh takes the job and the server with it and nothing is orphaned under an
 * account nobody looks at.
 *
 * The swap is two slots, not one. A new version starts on the port the running
 * one is not using, answers a health check there, and only then becomes the
 * proxy's target; the old process is killed after that. A single port would mean
 * every push taking the site down for as long as the application takes to boot,
 * which for a Next.js server is seconds an intranet user would notice.
 *
 * ponytail: no WebSocket upgrade, no streaming request bodies beyond what
 * `pipe` gives, one process per project and no autoscaling. Each of those is a
 * second server on the same machine; ask before adding one.
 */

'use strict';

const http = require('http');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const machineStore = require('./machineStore');

const SCRIPT_PATH = path.join(__dirname, 'runtime', 'run-sandboxed-server.ps1');

/**
 * The internal port range, and how a project's slot maps into it.
 *
 * Derived from the site port rather than allocated, so nothing has to be stored
 * and two projects can never be handed the same one: a site port is already
 * unique across the install, and each gets two consecutive internal ports.
 * `AEGIS_SITES_PORT_BASE` moves the site range and this follows it.
 */
const DEFAULT_RUNTIME_BASE = 3200;

function runtimeBase() {
    return Number(process.env.AEGIS_RUNTIME_PORT_BASE || DEFAULT_RUNTIME_BASE);
}

/** How long an application gets to answer on its port before it is a failure. */
const HEALTH_TIMEOUT_MS = 60000;
const HEALTH_INTERVAL_MS = 500;

/** How long the outgoing process keeps serving after the new one took over. */
const DRAIN_MS = 5000;

/** The accounts a server process may run as. Empty means the runtime is off. */
function accounts() {
    return String(process.env.AEGIS_RUNTIME_ACCOUNTS || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Whether this host allows a process to run for a project at all.
 *
 * Both halves are the host's, not the tenant's. A tenant admin can tick every
 * box on the page and still not get a process on this server.
 */
function isEnabled() {
    return process.env.AEGIS_DEPLOY_RUNTIME === '1' && accounts().length > 0;
}

/**
 * The internal port for one site port and one slot.
 *
 * Two per site, laid out so that neither can collide with another project's or
 * with the site range itself.
 */
function portFor(sitePort, slot, sitesBase, range) {
    const base = Number(sitesBase || process.env.AEGIS_SITES_PORT_BASE || 3081);
    const width = Number(range || 100);
    const index = Number(sitePort) - base;
    if (!Number.isFinite(index) || index < 0 || index >= width) {
        throw Object.assign(new Error(`site port ${sitePort} is outside the site range`),
            { code: 'bad_site_port' });
    }
    return runtimeBase() + (index * 2) + (slot === 1 ? 1 : 0);
}

/** `<slug>/<projectId>` -> { slot, port, child, account, startedAt }. */
const running = new Map();

function key(slug, projectId) {
    return `${slug}/${projectId}`;
}

/** The port the proxy should send this project's requests to, or null. */
function targetFor(slug, projectId) {
    const held = running.get(key(slug, projectId));
    return held ? held.port : null;
}

function isRunning(slug, projectId) {
    return running.has(key(slug, projectId));
}

/**
 * An account for this project, chosen and held.
 *
 * By position rather than from a queue: a runtime keeps its account until the
 * project is deleted, so a pool with a `borrow` that blocks would queue a
 * deployment forever behind a project that is simply still running. The count of
 * node projects an install can hold is the count of accounts it was given, and
 * the refusal says so.
 */
function accountFor(slug, projectId) {
    const held = running.get(key(slug, projectId));
    if (held) return held.account;

    const names = accounts();
    const taken = new Set(Array.from(running.values()).map((r) => r.account));
    const free = names.find((name) => !taken.has(name));
    if (!free) {
        throw Object.assign(
            new Error(`every runtime account is in use (${names.length} configured)`),
            { code: 'no_runtime_account' });
    }
    return free;
}

/** Whether something is answering HTTP on this port. Any status counts. */
function health(port, timeoutMs) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs || 2000 }, (res) => {
            res.resume();
            resolve(true);
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
    });
}

/** Polls until the application answers, or gives up. */
async function waitHealthy(port, { timeoutMs, intervalMs, alive, sleep } = {}) {
    const deadline = Date.now() + (timeoutMs || HEALTH_TIMEOUT_MS);
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    while (Date.now() < deadline) {
        if (alive && !alive()) return false;      // the process died: no point waiting
        if (await health(port, 2000)) return true;
        await wait(intervalMs || HEALTH_INTERVAL_MS);
    }
    return false;
}

/**
 * Starts one server process. Resolves once it is answering on its port.
 *
 * `spawn` is injected so the flip below is testable without pwsh, a restricted
 * account or an application: production passes `spawnSandboxed`, the tests pass
 * a stub that starts a plain `http` server.
 */
async function startProcess({ dir, account, startCmd, port, env, spawn, report, dataDir }) {
    const say = report || { stage() { }, log() { } };
    const child = (spawn || spawnSandboxed)({ dir, account, startCmd, port, env, dataDir });

    let exited = false;
    let exitInfo = null;
    child.on('exit', (code, signal) => {
        exited = true;
        exitInfo = `exit ${code === null ? signal : code}`;
    });
    if (child.stdout) child.stdout.on('data', (b) => say.log(String(b)));
    if (child.stderr) child.stderr.on('data', (b) => say.log(String(b)));

    const healthy = await waitHealthy(port, { alive: () => !exited });
    if (!healthy) {
        try { child.kill(); } catch (_) { /* already gone */ }
        throw Object.assign(
            new Error(exited
                ? `the start command stopped before answering on port ${port} (${exitInfo})`
                : `nothing answered on port ${port} within ${Math.round(HEALTH_TIMEOUT_MS / 1000)}s`),
            { code: exited ? 'start_failed' : 'unhealthy' });
    }
    return child;
}

/**
 * Puts a new version of a project's server behind its port.
 *
 * The order is what makes a push not drop requests: start the new process on the
 * free slot, wait for it to answer, move the proxy, then drain and kill the old
 * one. A new process that never answers leaves the old one exactly where it was
 * and throws, so the deployment fails with the site still up.
 */
async function restart({ slug, project, dir, startCmd, env, spawn, report, drainMs, dataDir }) {
    if (!isEnabled()) {
        throw Object.assign(new Error('the node runtime is not enabled on this host'),
            { code: 'runtime_disabled' });
    }
    const k = key(slug, project.id);
    const previous = running.get(k) || null;
    const slot = previous && previous.slot === 0 ? 1 : 0;
    const port = portFor(project.port, slot);
    const account = accountFor(slug, project.id);

    const child = await startProcess({ dir, account, startCmd, port, env, spawn, report, dataDir });

    running.set(k, { slot, port, child, account, startedAt: Date.now() });

    if (previous) {
        // Killed on a timer, not at once: a request the old process is halfway
        // through answering is a page somebody is looking at.
        const grace = drainMs === undefined ? DRAIN_MS : drainMs;
        const finish = () => { try { previous.child.kill(); } catch (_) { } };
        if (grace > 0) {
            const timer = setTimeout(finish, grace);
            if (timer.unref) timer.unref();
        } else {
            finish();
        }
    }
    return { port, slot };
}

/** Stops a project's process, if it has one. */
function stop(slug, projectId) {
    const held = running.get(key(slug, projectId));
    if (!held) return false;
    running.delete(key(slug, projectId));
    try { held.child.kill(); } catch (_) { /* already gone */ }
    return true;
}

/**
 * Starts pwsh, which creates the Job Object and starts the application inside
 * it.
 *
 * The account password goes through this process's environment and never a
 * command line, same as the build launcher. The application's own variables go
 * the same way, as one JSON blob, and pwsh drops both from its own environment
 * before it starts anything.
 */
/**
 * Lets the runtime account read the folder it is about to run in.
 *
 * The build sandbox never needed this: a build runs in a workspace under
 * ProgramData that `Create-BuildAccounts.ps1` already gave the account an ACL
 * on. A server process runs in the tenant's published folder, which belongs to
 * SYSTEM and which no restricted account can even list, so `Process.Start`
 * fails with access denied before the application gets a chance to boot.
 *
 * Read and execute, inherited, and never write: the process serves this folder
 * and has no business changing it. Aegis replaces it wholesale on the next
 * deployment.
 *
 * Idempotent, so it runs on every start rather than being remembered anywhere:
 * `icacls /grant` on a right the account already has is a no-op, and a folder
 * that was replaced by a publish has lost the grant the last one had.
 */
function grantAccess(dir, account) {
    if (process.platform !== 'win32') return;
    try {
        execFileSync('icacls', [dir, '/grant', `${account}:(OI)(CI)(RX)`, '/T', '/C', '/Q'],
            { windowsHide: true, stdio: 'ignore' });
    } catch (e) {
        throw Object.assign(
            new Error(`could not give ${account} read access to ${dir}: ${e.message}`),
            { code: 'runtime_acl_failed' });
    }
}

/**
 * Lets the runtime account write the one folder it is allowed to write.
 *
 * A second grant rather than widening the one above, because the asymmetry is
 * the point. The process reads what it serves and cannot change it: a process
 * that can rewrite `current/` is a process that can serve something nobody
 * deployed. It writes `data/` and nothing else.
 *
 * Modify and not full control: the account writes its files and does not get to
 * rewrite the ACL that constrains it.
 *
 * The build accounts get neither grant here. A build runs `npm install`, which
 * executes arbitrary scripts from a branch's whole dependency tree, and that is
 * the threat the sandbox pool exists for.
 */
function grantData(dir, account) {
    if (process.platform !== 'win32') return;
    try {
        execFileSync('icacls', [dir, '/grant', `${account}:(OI)(CI)(M)`, '/T', '/C', '/Q'],
            { windowsHide: true, stdio: 'ignore' });
    } catch (e) {
        throw Object.assign(
            new Error(`could not give ${account} write access to ${dir}: ${e.message}`),
            { code: 'runtime_acl_failed' });
    }
}

function spawnSandboxed({ dir, account, startCmd, port, env, dataDir }) {
    const secret = machineStore.getBuildAccountSecret(account);
    if (!secret) {
        throw Object.assign(
            new Error(`no stored password for runtime account ${account} -- run Create-BuildAccounts.ps1 for it`),
            { code: 'build_account_unconfigured' });
    }

    const childEnv = {
        AEGIS_BUILD_ACCOUNT_SECRET: secret,
        AEGIS_BUILD_ENV_JSON: JSON.stringify(Object.assign({}, env, {
            // The convention every node framework reads. The application listens
            // on this and the proxy in siteServer.js sends to it.
            PORT: String(port),
            HOST: '127.0.0.1',
            NODE_ENV: (env && env.NODE_ENV) || 'production',
            // Added here and not in `projectEnv.forBuild`, which is the
            // environment a build also reads. A build is untrusted code from a
            // branch; the path to the live data is not its business. Putting the
            // variable where only this spawn can reach it makes that structural
            // rather than a rule somebody has to remember.
            AEGIS_DATA_DIR: dataDir || ''
        }))
    };
    for (const name of ['SystemRoot', 'windir', 'PATH', 'Path', 'TEMP', 'TMP', 'ComSpec', 'ProgramData', 'PSModulePath']) {
        if (process.env[name] !== undefined) childEnv[name] = process.env[name];
    }

    grantAccess(dir, account);
    if (dataDir) grantData(dataDir, account);

    return execFile('pwsh', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', SCRIPT_PATH,
        '-WorkspaceDir', dir,
        '-AccountName', account,
        '-StartCmd', startCmd
    ], { windowsHide: true, env: childEnv, maxBuffer: 1024 * 1024 });
}

module.exports = {
    isEnabled, accounts, portFor, targetFor, isRunning, restart, stop, health, waitHealthy,
    accountFor, startProcess, spawnSandboxed, grantAccess, grantData,
    HEALTH_TIMEOUT_MS, DRAIN_MS, DEFAULT_RUNTIME_BASE, runtimeBase,
    // Test seam: the flip is about which process the proxy points at, and a
    // test cannot reach that state without starting two of them.
    _running: running
};
