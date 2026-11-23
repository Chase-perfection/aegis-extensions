/**
 * Explicit Windows ACL for the machine key.
 *
 * `machine.key` decrypts every secret the extension stores (directory bind
 * password, GitHub App key, project environment). The data root inherits the
 * ACL of its parent, which on a default install lets every local user read it.
 * This cuts inheritance and grants only SYSTEM and the account the service runs
 * as. Principals go by SID, never by name: the hosts are localised.
 *
 * Administrators (S-1-5-32-544) are left out on purpose. An administrator can
 * take ownership anyway, and listing the group would widen who a backup agent
 * running as that group can read it for.
 *
 * Synchronous, like `machineKey()` which calls it: the key is needed on the
 * first read and the public API of machineStore is synchronous. Native
 * `icacls.exe` through `execFileSync` with an argv array, no shell, no
 * PowerShell.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SYSTEM_SID = 'S-1-5-18';

/**
 * The native tool from System32, not whatever `PATH` finds first: a PATH can
 * carry a GNU `whoami` that rejects `/user`, or a planted `icacls.exe`.
 */
function defaultRun(cmd, args) {
    const root = process.env.SystemRoot || process.env.windir;
    const exe = root ? path.join(root, 'System32', `${cmd}.exe`) : cmd;
    return execFileSync(exe, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function fail(message, stderr) {
    const e = new Error(stderr ? `${message}: ${String(stderr).trim()}` : message);
    e.code = 'key_acl_failed';
    e.stderr = stderr ? String(stderr) : '';
    return e;
}

function stderrOf(e) {
    if (e && e.stderr) return String(e.stderr);
    if (e && e.stdout) return String(e.stdout);
    return (e && e.message) || '';
}

/** SID of the account this process runs as: second field of `whoami /user /fo csv /nh`. */
function currentSid(run) {
    let out;
    try {
        out = run('whoami', ['/user', '/fo', 'csv', '/nh']);
    } catch (e) {
        throw fail('cannot read the service account SID', stderrOf(e));
    }
    const m = /"[^"]*"\s*,\s*"(S-1-[0-9-]+)"/.exec(String(out));
    if (!m) throw fail('cannot parse the service account SID', String(out));
    return m[1];
}

/**
 * Restricts `file` to SYSTEM and the current process user. Throws an Error with
 * `code = 'key_acl_failed'` when it cannot. Off Windows: chmod 0600 only.
 */
function protect(file, { run = defaultRun, platform = process.platform } = {}) {
    if (platform !== 'win32') {
        fs.chmodSync(file, 0o600);
        return;
    }
    const sid = currentSid(run);
    const grants = [`*${SYSTEM_SID}:F`];
    if (sid !== SYSTEM_SID) grants.push(`*${sid}:F`);
    try {
        run('icacls', [file, '/inheritance:r', '/grant:r', ...grants]);
    } catch (e) {
        throw fail(`icacls failed on ${file}`, stderrOf(e));
    }
}

module.exports = { protect, SYSTEM_SID };
