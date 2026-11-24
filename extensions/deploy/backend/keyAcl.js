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
const ADMINISTRATORS_SID = 'S-1-5-32-544';

/**
 * The native tool from System32, not whatever `PATH` finds first: a PATH can
 * carry a GNU `whoami` that rejects `/user`, or a planted `icacls.exe`.
 */
function defaultRun(cmd, args) {
    const root = process.env.SystemRoot || process.env.windir;
    if (!root) throw fail(`cannot locate ${cmd}.exe: SystemRoot is not set`);
    const exe = path.join(root, 'System32', `${cmd}.exe`);
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
function protect(file, opts = {}) {
    restrict(file, '', 0o600, opts);
}

/**
 * Same for a directory, with the grants inherited by what is created inside it
 * (`(OI)(CI)`), so a file made there never exists under a wider ACL. Off
 * Windows: chmod 0700.
 *
 * `admins: true` grants Administrators too. Only for the store folder itself:
 * it holds files an elevated setup script writes (build account secrets), and
 * the key inside it carries its own ACL without inheritance, so the grant
 * never reaches the key.
 */
function protectDir(dir, opts = {}) {
    restrict(dir, '(OI)(CI)', 0o700, opts);
}

/**
 * Makes the account this process runs as the owner of `dir` and of everything
 * under it (`/T`). Throws `key_acl_failed` when any entry cannot be taken.
 *
 * An owner keeps READ_CONTROL and WRITE_DAC whatever the DACL says, so a local
 * user who created the folder (or a file in it) before the service first
 * restricted it could open its ACL again at any later time. Owning everything
 * first closes that.
 *
 * The owner set is the service account itself, not Administrators or SYSTEM:
 * setting another principal as owner needs SeRestorePrivilege, which only a
 * SYSTEM service holds (icacls answers 1307 otherwise), while taking ownership
 * for oneself needs only WRITE_OWNER or SeTakeOwnershipPrivilege. So the call
 * behaves the same under SYSTEM and under a dedicated service account. An entry
 * the account can neither write the owner of nor take is a sign someone else
 * controls the store, and the store then refuses to start.
 *
 * Windows only: off Windows nothing (the chmod in `protect` is the whole
 * guarantee there).
 */
function takeOwnership(dir, { run = defaultRun, platform = process.platform } = {}) {
    if (platform !== 'win32') return;
    const sid = currentSid(run);
    try {
        run('icacls', [dir, '/setowner', `*${sid}`, '/T', '/C', '/L', '/Q']);
    } catch (e) {
        throw fail(`cannot take ownership of ${dir}`, stderrOf(e));
    }
}

function restrict(target, inherit, mode, { run = defaultRun, platform = process.platform, admins = false } = {}) {
    if (platform !== 'win32') {
        fs.chmodSync(target, mode);
        return;
    }
    const sid = currentSid(run);
    const grants = [`*${SYSTEM_SID}:${inherit}F`];
    if (sid !== SYSTEM_SID) grants.push(`*${sid}:${inherit}F`);
    if (admins) grants.push(`*${ADMINISTRATORS_SID}:${inherit}F`);
    try {
        run('icacls', [target, '/inheritance:r', '/grant:r', ...grants]);
    } catch (e) {
        throw fail(`icacls failed on ${target}`, stderrOf(e));
    }
    const trusted = new Set([SYSTEM_SID, sid]);
    if (admins) trusted.add(ADMINISTRATORS_SID);
    scrub(target, trusted, run);
}

/**
 * Removes every entry `/grant:r` leaves behind. `/inheritance:r` drops only
 * inherited entries and `/grant:r` replaces only the principals it names, so
 * an entry someone else added explicitly (a local user who owned the folder
 * first, say) would survive both. Reads the DACL back as SDDL with `/save`,
 * removes each allow entry for a principal outside `trusted` and every deny
 * entry, then reads it again and throws `key_acl_failed` if anything is left.
 * `/restore` would set the exact DACL in one call but needs SeRestorePrivilege,
 * which only a SYSTEM service holds.
 */
function scrub(target, trusted, run) {
    const { allow, deny, other } = untrustedEntries(saveSddl(target, run), trusted);
    if (allow.length === 0 && deny.length === 0 && other === 0) return;
    try {
        if (allow.length) run('icacls', [target, '/remove:g', ...allow.map((s) => `*${s}`)]);
        if (deny.length) run('icacls', [target, '/remove:d', ...deny.map((s) => `*${s}`)]);
    } catch (e) {
        throw fail(`icacls could not remove foreign entries on ${target}`, stderrOf(e));
    }
    const left = untrustedEntries(saveSddl(target, run), trusted);
    if (left.allow.length || left.deny.length || left.other) {
        throw fail(`${target} still grants or denies principals other than SYSTEM, the service account and Administrators`);
    }
}

/** SDDL aliases icacls writes for well-known principals. Anything else is a full SID. */
const SDDL_ALIASES = {
    SY: 'S-1-5-18', BA: 'S-1-5-32-544', BU: 'S-1-5-32-545', BG: 'S-1-5-32-546', PU: 'S-1-5-32-547',
    WD: 'S-1-1-0', AU: 'S-1-5-11', IU: 'S-1-5-4', NU: 'S-1-5-2', SU: 'S-1-5-6', AN: 'S-1-5-7',
    LS: 'S-1-5-19', NS: 'S-1-5-20', CO: 'S-1-3-0', CG: 'S-1-3-1', OW: 'S-1-3-4', AC: 'S-1-15-2-1',
    RD: 'S-1-5-32-555', RU: 'S-1-5-32-554', BO: 'S-1-5-32-551', PO: 'S-1-5-32-550', SO: 'S-1-5-32-549',
    AO: 'S-1-5-32-548', NO: 'S-1-5-32-556', RC: 'S-1-5-12', PS: 'S-1-5-10', ED: 'S-1-5-9',
};

/**
 * Allow and deny entries of the DACL in `sddl` that are not an allow for a
 * trusted SID. `other` counts entries icacls cannot remove by SID (object or
 * callback types, unknown aliases, or any entry the pattern did not read, such
 * as a conditional one with nested parentheses): the caller treats them as a
 * failure.
 *
 * The file `/save` writes is the path on one line, then the SDDL on the next.
 * Only the SDDL line is read, so a path (on drive D, or holding a
 * parenthesis) is never taken for the DACL; no such line throws.
 */
function untrustedEntries(sddl, trusted) {
    // `D:` then only DACL flags (P, AI, AR, NO_ACCESS_CONTROL) then an entry or
    // the end: an absolute path on drive D has a backslash there.
    const line = String(sddl).split(/\r?\n/).map((l) => l.trim())
        .find((l) => /^D:(?:P|AI|AR|NO_ACCESS_CONTROL)*(?:\(|$)/.test(l));
    if (line === undefined) throw fail('icacls /save returned no DACL');
    const allow = new Set();
    const deny = new Set();
    const entries = [...line.matchAll(/\(([^;)]*);[^;)]*;[^;)]*;[^;)]*;[^;)]*;([^;)]*)[^)]*\)/g)];
    let other = (line.match(/\(/g) || []).length - entries.length;
    for (const m of entries) {
        const sid = /^S-1-[0-9-]+$/.test(m[2]) ? m[2] : SDDL_ALIASES[m[2]];
        if (!sid || (m[1] !== 'A' && m[1] !== 'D')) { other += 1; continue; }
        if (m[1] === 'D') deny.add(sid);
        else if (!trusted.has(sid)) allow.add(sid);
    }
    return { allow: [...allow], deny: [...deny], other };
}

/**
 * The DACL of `target` as SDDL, through `icacls /save` (UTF-16 file) in a
 * fresh folder beside it: the store's parent is the data root, which local
 * users cannot write, where `os.tmpdir()` for SYSTEM is `C:\Windows\Temp`.
 */
function saveSddl(target, run) {
    // The parent of a real target exists; the fallback only serves the unit
    // tests, which name paths that do not.
    const parent = fs.existsSync(path.dirname(target)) ? path.dirname(target) : require('os').tmpdir();
    const dir = fs.mkdtempSync(path.join(parent, '.aegis-acl-'));
    try {
        const file = path.join(dir, 'acl');
        try {
            run('icacls', [target, '/save', file, '/L']);
        } catch (e) {
            throw fail(`icacls could not read the ACL of ${target}`, stderrOf(e));
        }
        return fs.readFileSync(file).toString('utf16le').replace(/^\uFEFF/, '');
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
}

/**
 * Throws `key_acl_failed` when `dir`, or anything under it, is a symbolic link
 * or a junction. Taking ownership and rewriting the ACL as SYSTEM through a
 * link a local user planted would hand that ACL change to whatever it points
 * at. Nothing Deploy writes in its store is a link.
 */
function assertNoLinks(dir) {
    const real = fs.realpathSync.native(dir);
    const expected = path.join(fs.realpathSync.native(path.dirname(dir)), path.basename(dir));
    if (fs.lstatSync(dir).isSymbolicLink() || real.toLowerCase() !== expected.toLowerCase()) {
        throw fail(`${dir} is a link, refusing to take it`);
    }
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isSymbolicLink() || fs.lstatSync(p).isSymbolicLink()) throw fail(`${p} is a link, refusing to take ${dir}`);
            if (e.isDirectory()) walk(p);
        }
    };
    walk(dir);
}

/**
 * Makes every entry under `dir` (not `dir` itself) inherit its ACL again,
 * dropping explicit entries a previous owner set on them. Run after `dir` is
 * restricted, so what they inherit is already the restricted ACL. A key file
 * loses its own ACL here and gets it back from `protect` on the next read.
 */
function resetChildren(dir, { run = defaultRun, platform = process.platform } = {}) {
    if (platform !== 'win32' || fs.readdirSync(dir).length === 0) return;
    try {
        run('icacls', [path.join(dir, '*'), '/reset', '/T', '/C', '/L', '/Q']);
    } catch (e) {
        throw fail(`icacls could not reset the entries under ${dir}`, stderrOf(e));
    }
}

module.exports = { protect, protectDir, takeOwnership, resetChildren, assertNoLinks, SYSTEM_SID, untrustedEntries };
