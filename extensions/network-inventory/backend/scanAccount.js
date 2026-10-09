/**
 * The account the network scan reads DHCP, AD and DNS with, one per tenant.
 *
 * Without one, the scan runs as the backend service, which on an installed
 * Aegis is LocalSystem and reaches the network as the machine account,
 * `DOMAIN\HOST$`. A DHCP server refuses that account unless someone added a
 * computer to its "DHCP Users" group, which nobody does. With one, the scan is
 * started through scan/Start-NetOnly.ps1: same local identity as the service,
 * every remote read made as the chosen account, the way `runas /netonly` does.
 *
 * Independent of the account the audit runs as (core's serviceAccount.js):
 * changing this one restarts nothing, and it can be a dedicated directory
 * account that holds only the rights the scan needs. A right it lacks shows up
 * as a diagnostic naming it, never as a fallback to another identity.
 *
 * Where the password lives. Not under `tenants/<slug>/`: that subtree is tenant
 * data, inside the project tree on a dev install and inside every backup, and
 * the workspace rule is that no secret sits there. One file outside the tree,
 * keyed by slug, AES-256-GCM under a key file beside it. The deploy extension's
 * machineStore.js keeps its GitHub App keys the same way, and this is a copy of
 * its scheme rather than an import: an extension imports its own files only.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ALGO = 'aes-256-gcm';
const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);

// --- Where ------------------------------------------------------------------

/** `<AEGIS_DATA_ROOT | ProgramData\Aegis>\network-inventory`, never the repository. */
function storeDir() {
    if (process.env.AEGIS_DATA_ROOT) {
        return path.join(path.resolve(process.env.AEGIS_DATA_ROOT), 'network-inventory');
    }
    const machineRoot = process.platform === 'win32'
        ? (process.env.ProgramData && path.join(process.env.ProgramData, 'Aegis'))
        : '/var/lib/aegis';
    if (!machineRoot) throw new Error('no machine data folder: set AEGIS_DATA_ROOT');
    return path.join(machineRoot, 'network-inventory');
}
function storeFile() { return path.join(storeDir(), 'scan-accounts.json'); }
function keyFile() { return path.join(storeDir(), 'machine.key'); }

// --- Encryption (deploy/backend/machineStore.js, same scheme) -----------------

/** `wx`, so two workers racing on first use cannot each write a key. */
function machineKey() {
    fs.mkdirSync(storeDir(), { recursive: true });
    try {
        const fd = fs.openSync(keyFile(), 'wx', 0o600);
        const key = crypto.randomBytes(32);
        fs.writeSync(fd, key);
        fs.closeSync(fd);
        return key;
    } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        return fs.readFileSync(keyFile());
    }
}

/** `iv.tag.ciphertext`, base64, one line. */
function encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv(ALGO, machineKey(), iv);
    const enc = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
    return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

/** null rather than a throw: a rotated key reads as "no password", not a crash. */
function decrypt(packed) {
    try {
        const [ivB64, tagB64, dataB64] = String(packed).split('.');
        const d = crypto.createDecipheriv(ALGO, machineKey(), Buffer.from(ivB64, 'base64'));
        d.setAuthTag(Buffer.from(tagB64, 'base64'));
        return Buffer.concat([d.update(Buffer.from(dataB64, 'base64')), d.final()]).toString('utf8');
    } catch (_) {
        return null;
    }
}

// --- Store ------------------------------------------------------------------

function readAll() {
    try {
        const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (_) {
        return {};
    }
}

/** tmp + rename: a crash mid-write leaves the previous file, not half of one. */
function writeAll(all) {
    fs.mkdirSync(storeDir(), { recursive: true });
    const tmp = storeFile() + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, storeFile());
}

/** What the page may see. Never the secret, not even encrypted. */
function describe(slug) {
    const entry = readAll()[slug];
    if (!entry || typeof entry.account !== 'string') return null;
    return { account: entry.account, updatedAt: entry.updatedAt || null, updatedBy: entry.updatedBy || null };
}

/** `{ account, password }`, `{ account, password: null }` when it will not decrypt, or null. */
function credentials(slug) {
    const entry = readAll()[slug];
    if (!entry || typeof entry.account !== 'string') return null;
    return { account: entry.account, password: decrypt(entry.secret) };
}

function save(slug, account, password, updatedBy) {
    const all = readAll();
    all[slug] = { account, secret: encrypt(password), updatedAt: new Date().toISOString(), updatedBy: updatedBy || null };
    writeAll(all);
}

function clear(slug) {
    const all = readAll();
    if (!(slug in all)) return false;
    delete all[slug];
    writeAll(all);
    return true;
}

// --- Account names ----------------------------------------------------------

// Same grammar as core's serviceAccount.normalize, minus what /netonly cannot
// use: LocalSystem, a gMSA (no password to present) and `.\local` (a local
// account means nothing to a remote server).
const NAME = '[\\p{L}\\p{N}_-](?:[\\p{L}\\p{N} ._-]{0,62}[\\p{L}\\p{N}_-])?';
const DOMAIN = '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}.-]{0,62}[\\p{L}\\p{N}])?';
const DOWN_LEVEL = new RegExp('^(' + DOMAIN + ')\\\\(' + NAME + ')$', 'u');
const UPN = new RegExp('^(' + NAME + ')@([\\p{L}\\p{N}](?:[\\p{L}\\p{N}.-]{0,252}[\\p{L}\\p{N}])?)$', 'u');

/** `DOMAIN\name` or `name@dns.domain`, trimmed; anything else is null. */
function normalize(input) {
    if (typeof input !== 'string') return null;
    const s = input.trim();
    if (!s || s.length > 256) return null;
    let m = DOWN_LEVEL.exec(s);
    if (m) return m[1] + BS + m[2];
    m = UPN.exec(s);
    if (m && m[2].includes('.')) return s;
    return null;
}

/** What the scan's -Domain may hold: it ends up in a command line. */
const SCAN_DOMAIN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

// --- Password check ---------------------------------------------------------

/**
 * The environment for a `powershell.exe` (5.1) child: this process's, minus
 * PSModulePath. Core's hostOptIn.windowsPowerShellEnv says why: a backend
 * started from pwsh 7 hands 5.1 the 7 module folders, and 5.1 then loses
 * ConvertTo-SecureString.
 */
function powerShellEnv(extra) {
    const out = { ...process.env };
    for (const name of Object.keys(out)) {
        if (name.toLowerCase() === 'psmodulepath') delete out[name];
    }
    return Object.assign(out, extra);
}

function defaultRunner(script, vars) {
    return new Promise((resolve) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64')], {
            env: powerShellEnv(vars),
            timeout: 60000,
            windowsHide: true
        }, (err, stdout) => {
            const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
            try { return resolve(JSON.parse(lines.pop() || '')); } catch (_) { }
            resolve({ ok: false, detail: err ? 'powershell failed' : 'unreadable answer' });
        });
    });
}

let runner = defaultRunner;

// A network logon (type 3), nothing cached, the way core's serviceAccount
// checks the audit account. Unlike that check, no group is required: a
// dedicated account holding only "DHCP Users" is exactly what least privilege
// asks for. /netonly never tries the password itself, so this is the only
// place a wrong one is caught before a scan.
const VERIFY_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "if (-not ('AegisScanLogon' -as [type])) {",
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class AegisScanLogon {',
    '    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
    '    static extern bool LogonUser(string user, string domain, string password, int logonType, int provider, out IntPtr token);',
    '    [DllImport("kernel32.dll")]',
    '    static extern bool CloseHandle(IntPtr handle);',
    '    public static int Network(string user, string domain, string password) {',
    '        IntPtr token;',
    '        if (string.IsNullOrEmpty(domain)) domain = null;',
    '        if (!LogonUser(user, domain, password, 3, 0, out token)) return Marshal.GetLastWin32Error();',
    '        CloseHandle(token);',
    '        return 0;',
    '    }',
    '}',
    "'@",
    '}',
    '$account = $env:AEGIS_SCAN_NET_ACCOUNT',
    '$secret = $env:AEGIS_SCAN_NET_SECRET',
    'Remove-Item Env:AEGIS_SCAN_NET_SECRET -ErrorAction SilentlyContinue',
    "if ($account -match '^(.+)\\\\(.+)$') { $domain = $Matches[1]; $user = $Matches[2] } else { $domain = $null; $user = $account }",
    '$err = [AegisScanLogon]::Network($user, $domain, $secret)',
    '$secret = $null',
    'if ($err -ne 0) { Write-Output (@{ ok = $false; win32 = $err } | ConvertTo-Json -Compress); exit 0 }',
    'Write-Output (@{ ok = $true } | ConvertTo-Json -Compress)'
].join(NL);

/** Win32 errors a wrong or unusable account returns, by name for the page. */
const LOGON_ERRORS = { 1326: 'bad_password', 1327: 'restricted', 1330: 'expired', 1331: 'disabled', 1385: 'logon_type', 1793: 'expired', 1909: 'locked' };

async function verify(account, password) {
    // No password, or one no form could have produced, never reaches Windows:
    // it is not a wrong guess and must not feed the lockout.
    if (typeof password !== 'string' || !password || /[\r\n\u0000]/.test(password)) {
        return { ok: false, code: 'ENOPASSWORD' };
    }
    const r = await runner(VERIFY_SCRIPT, { AEGIS_SCAN_NET_ACCOUNT: account, AEGIS_SCAN_NET_SECRET: password });
    if (r && r.ok === true) return { ok: true };
    if (r && Number.isInteger(r.win32)) return { ok: false, code: 'EBADCRED', reason: LOGON_ERRORS[r.win32] || 'win32_' + r.win32 };
    return { ok: false, code: 'EVERIFY', reason: 'check_failed' };
}

// --- Wrong-password lockout ---------------------------------------------------

const LOCK_MAX = 5;
const LOCK_WINDOW_MS = 10 * 60 * 1000;
const failures = new Map();   // slug -> [timestamps]

function recent(slug, now) {
    return (failures.get(slug) || []).filter((t) => now - t < LOCK_WINDOW_MS);
}
function isLocked(slug, now = Date.now()) { return recent(slug, now).length >= LOCK_MAX; }
function recordFailure(slug, now = Date.now()) { failures.set(slug, recent(slug, now).concat(now)); }
function resetFailures(slug) { failures.delete(slug); }

// --- Launch -----------------------------------------------------------------

const LAUNCHER_PATH = path.join(__dirname, 'scan', 'Start-NetOnly.ps1');

/** Start-NetOnly.ps1's exit code when Windows refused to start the scan. */
const START_FAILED_EXIT = 3;

/**
 * argv and environment for a scan run as `creds`. The password travels in the
 * environment only; the launcher removes it before starting anything.
 */
function launch(creds, { domain, probeOnly, dhcpServers } = {}) {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', LAUNCHER_PATH];
    if (domain) args.push('-Domain', domain);
    if (probeOnly) args.push('-ProbeOnly');
    if (dhcpServers && dhcpServers.length) args.push('-DhcpServer', dhcpServers.join(','));
    const env = powerShellEnv({ AEGIS_SCAN_NET_ACCOUNT: creds.account, AEGIS_SCAN_NET_SECRET: creds.password });
    return { file: 'powershell.exe', args, env };
}

/** `NETONLY_ERROR:<win32>:<message>` from the launcher's stderr, or null. */
function launcherError(stderrText) {
    const m = /NETONLY_ERROR:(\d+):(.*)/.exec(String(stderrText || ''));
    return m ? { win32: parseInt(m[1], 10), message: m[2].trim() } : null;
}

/** The identity the scan uses without an account: this process's own. */
function serviceIdentity() {
    const user = process.env.USERNAME || '';
    const domain = process.env.USERDOMAIN || '';
    return domain ? domain + BS + user : user;
}

module.exports = {
    normalize, verify, describe, credentials, save, clear,
    isLocked, recordFailure, resetFailures,
    launch, launcherError, serviceIdentity,
    SCAN_DOMAIN, LAUNCHER_PATH, START_FAILED_EXIT, LOCK_MAX,
    // Tests only.
    _setRunner(fn) { runner = fn || defaultRunner; },
    _encrypt: encrypt, _decrypt: decrypt, _storeFile: storeFile, _failures: failures
};
