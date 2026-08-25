'use strict';

const { execFile } = require('child_process');
const path = require('path');
const machineStore = require('../machineStore');

const SCRIPT_PATH = path.join(__dirname, 'run-sandboxed-build.ps1');

/** Windows/pwsh baseline env vars a subprocess needs to start at all -- not Aegis secrets. */
const SAFE_ENV_KEYS = ['SystemRoot', 'windir', 'PATH', 'Path', 'TEMP', 'TMP', 'ComSpec', 'ProgramData', 'PSModulePath'];

/**
 * `buildEnv` is the project's own variables (projectEnv.forBuild). They travel
 * as one JSON blob in this process's environment, the same route the account
 * password takes and for the same reasons: a command-line argument shows up in
 * a process listing, and a file in the workspace outlives the build that needed
 * it. run-sandboxed-build.ps1 reads the blob, puts it on the child's
 * environment block and drops its own copy before starting anything.
 */
function buildSafeEnv(secret, buildEnv) {
    const env = {};
    for (const key of SAFE_ENV_KEYS) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    env.AEGIS_BUILD_ACCOUNT_SECRET = secret;
    if (buildEnv && Object.keys(buildEnv).length) {
        env.AEGIS_BUILD_ENV_JSON = JSON.stringify(buildEnv);
    }
    return env;
}

/**
 * Runs one sandboxed build via run-sandboxed-build.ps1. Never a shell: args
 * go through execFile's argv array, and the account password goes through
 * an env var, never a command-line argument where it would land in a
 * process listing.
 */
function runLauncher({ workspace, account, installCmd, buildCmd, timeoutMs, signal, buildEnv }) {
    return new Promise((resolve, reject) => {
        const secret = machineStore.getBuildAccountSecret(account);
        if (!secret) {
            return reject(Object.assign(
                new Error(`no stored password for build account ${account} -- run Create-BuildAccounts.ps1`),
                { code: 'build_account_unconfigured' }));
        }

        execFile('pwsh', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', SCRIPT_PATH,
            '-WorkspaceDir', workspace,
            '-AccountName', account,
            '-InstallCmd', installCmd || '',
            '-BuildCmd', buildCmd,
            '-TimeoutMs', String(timeoutMs)
        ], {
            windowsHide: true,
            timeout: timeoutMs + 15000,
            // Cancelling from the build console kills pwsh, and the Job Object
            // the script created is set to KILL_ON_JOB_CLOSE, so the install or
            // build process inside it dies with its parent rather than being
            // orphaned under a restricted account nobody can see.
            signal,
            // Only what pwsh.exe itself needs to start and run on Windows, plus
            // the one secret this script needs -- never a blanket pass-through of
            // process.env, so a future Aegis secret added elsewhere in the
            // backend cannot leak into a build without someone having to add it
            // here deliberately.
            env: buildSafeEnv(secret, buildEnv)
        }, (err, stdout, stderr) => {
            if (err) {
                err.output = String(stderr || stdout || err.message);
                return reject(err);
            }
            resolve(String(stdout || ''));
        });
    });
}

module.exports = { runLauncher, buildSafeEnv };
