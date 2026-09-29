'use strict';

/**
 * The sandbox for real: a local account made by Create-BuildAccounts.ps1, the
 * workspace ACL, the deny-logon rights and the stored password all as setup
 * leaves them, and run-sandboxed-build.ps1 starting the build as that account.
 *
 * Every other builder test stubs the launcher, which is how a build that failed
 * on every host after its first ("Accès refusé", 2026-09-29) shipped green.
 *
 * CI only. It creates a local account and firewall rules and edits the local
 * security policy, which is fine on a runner thrown away after the job and not
 * on anyone's workstation. test.yml sets AEGIS_SANDBOX_IT; GitHub sets CI.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function whyNot() {
    if (process.platform !== 'win32') return 'Windows only: the sandbox is a local account and a Job Object';
    if (process.env.CI !== 'true' || process.env.AEGIS_SANDBOX_IT !== '1') {
        return 'CI only (CI=true, AEGIS_SANDBOX_IT=1): it creates a local account and edits the security policy';
    }
    try {
        execFileSync('net', ['session'], { stdio: 'ignore' });
    } catch {
        return 'needs an elevated process to create the account';
    }
    return false;
}

const skip = whyNot();
const SETUP = path.join(__dirname, '..', 'build', 'setup', 'Create-BuildAccounts.ps1');
const suffix = crypto.randomBytes(3).toString('hex');
const account = `aegis-it-${suffix}`;
const dataRoot = skip ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-it-data-'));
const workspaceRoot = skip ? null : path.join(process.env.ProgramData, `aegis-it-${suffix}`);

// Set before machineStore is required: setup's own `node -e` inherits it, so
// the password lands in this temp store and not in the runner's ProgramData.
if (!skip) process.env.AEGIS_DATA_ROOT = dataRoot;

function pwsh(args) {
    return execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
}

function staging() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-it-staging-'));
    fs.writeFileSync(path.join(dir, 'build.cmd'),
        '@echo off\r\nmkdir dist\r\n>dist\\index.html echo ok\r\nwhoami>dist\\who.txt\r\n'
        + '>dist\\home.txt echo %USERPROFILE%\r\n'
        + 'node --version\r\n'
        + 'if defined PSExecutionPolicyPreference echo POLICY-LEAK\r\n'
        + 'echo built-by-sandbox\r\n');
    return dir;
}

test('the real sandbox', { skip, timeout: 600000 }, async (t) => {
    const { buildInSandbox, scopeWorkspace } = require('../build/builder');
    const { runLauncher } = require('../build/launcher');
    const { createPool } = require('../build/accountPool');
    const machineStore = require('../machineStore');

    pwsh(['-File', SETUP, '-AccountNames', account, '-WorkspaceRoot', workspaceRoot]);
    t.after(() => {
        try {
            pwsh(['-Command', `Remove-LocalUser -Name '${account}' -ErrorAction SilentlyContinue; `
                + `Get-NetFirewallRule -DisplayName 'AegisBuild-${account}-*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`]);
        } catch { /* the runner is discarded anyway */ }
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });
    assert.ok(machineStore.getBuildAccountSecret(account), 'setup stored the password where the launcher reads it');

    const build = (pool) => buildInSandbox({
        pool, workspaceRoot, staging: staging(),
        // Chained, because a quoting mistake in the sandbox's command line
        // turned `a && b` into the name of a program, and wrote no log.
        installCmd: '', buildCmd: 'build.cmd && echo chained-after-build', outputDir: 'dist',
        timeoutMs: 120000, runLauncher, scopeWorkspace
    });

    await t.test('builds as the account, twice in a row', async () => {
        // Twice because the second is the one that failed: the first build
        // used to delete the folder setup had scoped, and make it again without.
        for (const run of [1, 2]) {
            const out = await build(createPool([account]));
            const log = fs.readFileSync(path.join(path.dirname(out), 'build.log'), 'utf8');
            const who = fs.readFileSync(path.join(out, 'who.txt'), 'utf8').trim().toLowerCase();
            assert.ok(who.endsWith(`\\${account}`), `run ${run} ran as "${who}", not as ${account}. build.log:\n${log}`);
            assert.match(log, /built-by-sandbox/, 'what the build printed reaches build.log');
            assert.match(log, /^v\d+\./m, `node resolves on the build's PATH and PATHEXT. build.log:\n${log}`);
            assert.doesNotMatch(log, /POLICY-LEAK/, "pwsh's -ExecutionPolicy Bypass must not reach the build");
            const home = fs.readFileSync(path.join(out, 'home.txt'), 'utf8').trim();
            assert.strictEqual(home.toLowerCase(), `${path.dirname(out)}.home`.toLowerCase(),
                "the build's profile is its own home beside the workspace, not the backend's");
            assert.match(log, /chained-after-build/, 'the whole && chain ran, as one command line');
        }
    });

    await t.test('a wrong stored password fails as the sandbox, names the Windows error, and takes the slot out', async () => {
        const good = machineStore.getBuildAccountSecret(account);
        machineStore.saveBuildAccountSecret(account, `Wrong-${crypto.randomBytes(8).toString('hex')}-9!`);
        try {
            const pool = createPool([account]);
            await assert.rejects(build(pool), (e) => e.code === 'sandbox_unavailable' && /1326/.test(e.message));
            assert.strictEqual(pool.health()[0].ok, false);
        } finally {
            machineStore.saveBuildAccountSecret(account, good);
        }
    });
});
