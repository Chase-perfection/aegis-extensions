'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const keyAcl = require('../keyAcl');

function fakeRun({ sid = 'S-1-5-21-111-222-333-1001', failIcacls = false, saves = [] } = {}) {
    const calls = [];
    let saved = 0;
    let granted = [];
    const run = (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === 'whoami') return `"host\\svc","${sid}"\r\n`;
        if (cmd === 'icacls' && args[1] === '/inheritance:r') {
            granted = args.slice(3).map((g) => /^\*([^:]+):/.exec(g)[1]);
        }
        if (cmd === 'icacls' && args[1] === '/save' && !failIcacls) {
            // Each /save returns the next SDDL given, then exactly what was granted.
            const sddl = saves[saved++] || `D:PAI${granted.map((g) => `(A;OICI;FA;;;${g})`).join('')}`;
            fs.writeFileSync(args[2], Buffer.from(`﻿x\r\n${sddl}\r\n`, 'utf16le'));
            return '';
        }
        if (failIcacls) {
            const e = new Error('Command failed');
            e.stderr = 'Access is denied.';
            throw e;
        }
        return '';
    };
    return { run, calls };
}

test('protect runs icacls with inheritance removed and grants by SID', () => {
    const { run, calls } = fakeRun();
    keyAcl.protect('C:\\x\\machine.key', { run, platform: 'win32' });
    const whoami = calls.filter((c) => c[0] === 'whoami');
    assert.strictEqual(whoami.length, 1);
    assert.deepStrictEqual(whoami[0][1], ['/user', '/fo', 'csv', '/nh']);
    const icacls = calls.filter((c) => c[0] === 'icacls');
    // The grant, then one read back; a clean ACL needs no removal.
    assert.strictEqual(icacls.length, 2);
    assert.strictEqual(icacls[1][1][1], '/save');
    assert.deepStrictEqual(icacls[0], ['icacls', [
        'C:\\x\\machine.key', '/inheritance:r', '/grant:r',
        '*S-1-5-18:F', '*S-1-5-21-111-222-333-1001:F'
    ]]);
});

test('protect does not grant Administrators', () => {
    const { run, calls } = fakeRun();
    keyAcl.protect('C:\\x\\machine.key', { run, platform: 'win32' });
    assert.ok(!JSON.stringify(calls).includes('S-1-5-32-544'));
});

test('protect grants SYSTEM once when the service runs as SYSTEM', () => {
    const { run, calls } = fakeRun({ sid: 'S-1-5-18' });
    keyAcl.protect('C:\\x\\machine.key', { run, platform: 'win32' });
    const args = calls.find((c) => c[0] === 'icacls')[1];
    assert.deepStrictEqual(args.filter((a) => a.startsWith('*')), ['*S-1-5-18:F']);
});

test('protect throws key_acl_failed with the tool stderr on failure', () => {
    const { run } = fakeRun({ failIcacls: true });
    assert.throws(
        () => keyAcl.protect('C:\\x\\machine.key', { run, platform: 'win32' }),
        (e) => e.code === 'key_acl_failed' && /Access is denied/.test(e.message)
    );
});

test('protect throws key_acl_failed when the SID cannot be read', () => {
    const run = () => 'garbage';
    assert.throws(
        () => keyAcl.protect('C:\\x\\machine.key', { run, platform: 'win32' }),
        (e) => e.code === 'key_acl_failed'
    );
});

test('protectDir grants SYSTEM and the service SID with inheritance to children, inheritance removed', () => {
    const { run, calls } = fakeRun();
    keyAcl.protectDir('C:\\x\\.machine.key.ab12', { run, platform: 'win32' });
    assert.deepStrictEqual(calls.find((c) => c[0] === 'icacls'), ['icacls', [
        'C:\\x\\.machine.key.ab12', '/inheritance:r', '/grant:r',
        '*S-1-5-18:(OI)(CI)F', '*S-1-5-21-111-222-333-1001:(OI)(CI)F'
    ]]);
});

test('protectDir with admins also grants Administrators, for the store folder an elevated script writes', () => {
    const { run, calls } = fakeRun();
    keyAcl.protectDir('C:\\x\\deploy', { run, platform: 'win32', admins: true });
    assert.deepStrictEqual(calls.find((c) => c[0] === 'icacls'), ['icacls', [
        'C:\\x\\deploy', '/inheritance:r', '/grant:r',
        '*S-1-5-18:(OI)(CI)F', '*S-1-5-21-111-222-333-1001:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'
    ]]);
});

test('protectDir throws key_acl_failed with the tool stderr on failure', () => {
    const { run } = fakeRun({ failIcacls: true });
    assert.throws(
        () => keyAcl.protectDir('C:\\x\\d', { run, platform: 'win32' }),
        (e) => e.code === 'key_acl_failed' && /Access is denied/.test(e.message)
    );
});

test('takeOwnership sets the service SID as owner of the folder and everything in it', () => {
    const { run, calls } = fakeRun();
    keyAcl.takeOwnership('C:\\x\\deploy', { run, platform: 'win32' });
    assert.deepStrictEqual(calls.find((c) => c[0] === 'icacls'), ['icacls', [
        'C:\\x\\deploy', '/setowner', '*S-1-5-21-111-222-333-1001', '/T', '/C', '/L', '/Q'
    ]]);
});

test('takeOwnership throws key_acl_failed when an entry cannot be taken', () => {
    const { run } = fakeRun({ failIcacls: true });
    assert.throws(
        () => keyAcl.takeOwnership('C:\\x\\deploy', { run, platform: 'win32' }),
        (e) => e.code === 'key_acl_failed' && /ownership/.test(e.message) && /Access is denied/.test(e.message)
    );
});

test('protectDir removes explicit entries for other principals and every deny entry', () => {
    const svc = 'S-1-5-21-111-222-333-1001';
    const { run, calls } = fakeRun({ saves: [
        `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${svc})(A;OICI;FA;;;BA)(A;OICI;FA;;;BU)(A;;FA;;;S-1-5-21-9-9-9-2001)(D;;WD;;;SY)`,
    ] });
    keyAcl.protectDir('C:\\x\\deploy', { run, platform: 'win32', admins: true });
    assert.deepStrictEqual(calls.filter((c) => c[0] === 'icacls' && /^\/remove/.test(c[1][1])).map((c) => c[1]), [
        ['C:\\x\\deploy', '/remove:g', '*S-1-5-32-545', '*S-1-5-21-9-9-9-2001'],
        ['C:\\x\\deploy', '/remove:d', '*S-1-5-18'],
    ]);
});

test('protect keeps Administrators out of the key: an explicit Administrators entry is removed', () => {
    const svc = 'S-1-5-21-111-222-333-1001';
    const { run, calls } = fakeRun({ saves: [`D:PAI(A;;FA;;;SY)(A;;FA;;;${svc})(A;;FA;;;BA)`] });
    keyAcl.protect('C:\\x\\machine.key', { run, platform: 'win32' });
    assert.ok(calls.some((c) => c[0] === 'icacls' && c[1][1] === '/remove:g' && c[1][2] === '*S-1-5-32-544'));
});

test('an entry still there after the removal throws key_acl_failed', () => {
    const bad = 'D:PAI(A;;FA;;;SY)(A;;FA;;;BU)';
    const { run } = fakeRun({ saves: [bad, bad] });
    assert.throws(() => keyAcl.protect('C:\\x\\machine.key', { run, platform: 'win32' }),
        (e) => e.code === 'key_acl_failed' && /still/.test(e.message));
});

test('an object or unknown entry the removal cannot target throws key_acl_failed', () => {
    const odd = 'D:PAI(A;;FA;;;SY)(OA;;FA;;;S-1-5-21-9-9-9-2001)';
    const { run } = fakeRun({ saves: [odd, odd] });
    assert.throws(() => keyAcl.protect('C:\\x\\machine.key', { run, platform: 'win32' }),
        (e) => e.code === 'key_acl_failed');
});

test('untrustedEntries reads aliases and full SIDs', () => {
    const r = keyAcl.untrustedEntries('D:PAI(A;OICI;FA;;;SY)(A;ID;0x1200a9;;;BU)(D;;FA;;;WD)(A;;FA;;;S-1-5-21-1-2-3-500)',
        new Set(['S-1-5-18']));
    assert.deepStrictEqual(r, { allow: ['S-1-5-32-545', 'S-1-5-21-1-2-3-500'], deny: ['S-1-1-0'], other: 0 });
});

test('untrustedEntries reads the SDDL line only, never a path holding D: and a parenthesis', () => {
    const file = 'D:\\Aegis (old)\\deploy\r\nD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BU)\r\n';
    assert.deepStrictEqual(keyAcl.untrustedEntries(file, new Set(['S-1-5-18'])).allow, ['S-1-5-32-545']);
});

test('untrustedEntries throws when the save holds no DACL', () => {
    assert.throws(() => keyAcl.untrustedEntries('C:\\x\\deploy\r\n', new Set()), (e) => e.code === 'key_acl_failed');
});

test('an entry the pattern cannot read (conditional, nested parentheses) counts as unremovable', () => {
    const r = keyAcl.untrustedEntries('D:PAI(A;;FA;;;SY)(XA;;FA;;;WD;(Member_of {SID(BA)}))', new Set(['S-1-5-18']));
    assert.ok(r.other > 0);
});

test('real icacls: protectDir strips an explicit Users entry it did not grant (Windows)', { skip: process.platform !== 'win32' }, () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-scrub-'));
    const dir = path.join(parent, 'store');
    const aclFile = path.join(parent, 'acl');
    const icacls = path.join(process.env.SystemRoot, 'System32', 'icacls.exe');
    fs.mkdirSync(dir);
    try {
        execFileSync(icacls, [dir, '/grant', '*S-1-5-32-545:(OI)(CI)F']);
        keyAcl.protectDir(dir);
        execFileSync(icacls, [dir, '/save', aclFile]);
        const sddl = fs.readFileSync(aclFile).toString('utf16le');
        assert.ok(!/;BU\)/.test(sddl) && !/S-1-5-32-545/.test(sddl), sddl);
        assert.ok(/D:PAI?\(/.test(sddl), 'inheritance removed');
    } finally {
        try { execFileSync(icacls, [dir, '/reset', '/T', '/C', '/Q']); } catch (_) { /* best effort */ }
        fs.rmSync(parent, { recursive: true, force: true });
    }
});

test('assertNoLinks refuses a junction inside the folder', { skip: process.platform !== 'win32' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-links-'));
    try {
        fs.mkdirSync(path.join(dir, 'store'));
        fs.mkdirSync(path.join(dir, 'other'));
        fs.symlinkSync(path.join(dir, 'other'), path.join(dir, 'store', 'j'), 'junction');
        assert.throws(() => keyAcl.assertNoLinks(path.join(dir, 'store')), (e) => e.code === 'key_acl_failed');
        fs.rmSync(path.join(dir, 'store', 'j'));
        keyAcl.assertNoLinks(path.join(dir, 'store'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('takeOwnership does nothing off Windows', () => {
    let ran = false;
    keyAcl.takeOwnership('/var/lib/aegis/deploy', { run: () => { ran = true; return ''; }, platform: 'linux' });
    assert.strictEqual(ran, false);
});

test('real icacls: takeOwnership succeeds on a folder this account already owns (Windows)', { skip: process.platform !== 'win32' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-own-'));
    try {
        fs.writeFileSync(path.join(dir, 'f'), 'x');
        keyAcl.takeOwnership(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('protect is skipped off Windows: chmod 0600 only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-keyacl-'));
    try {
        const f = path.join(dir, 'machine.key');
        fs.writeFileSync(f, 'k');
        let ran = false;
        keyAcl.protect(f, { run: () => { ran = true; return ''; }, platform: 'linux' });
        assert.strictEqual(ran, false);
        if (process.platform !== 'win32') assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('real icacls on a temp file works for the current user (Windows)', { skip: process.platform !== 'win32' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-keyacl-'));
    try {
        const f = path.join(dir, 'machine.key');
        fs.writeFileSync(f, 'k');
        keyAcl.protect(f);
        assert.strictEqual(fs.readFileSync(f, 'utf8'), 'k');

        // Read the ACL back. Counted, not matched by principal name: the
        // names are localised.
        const sys32 = path.join(process.env.SystemRoot, 'System32');
        const acl = execFileSync(path.join(sys32, 'icacls.exe'), [f], { encoding: 'utf8' });
        assert.ok(!acl.includes('(I)'), 'inheritance is off');
        const who = execFileSync(path.join(sys32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
        const expected = who.includes('"S-1-5-18"') ? 1 : 2;
        assert.strictEqual((acl.match(/:\(/g) || []).length, expected);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('protect refuses to look tools up on PATH when SystemRoot is unset', () => {
    const saved = { SystemRoot: process.env.SystemRoot, windir: process.env.windir };
    try {
        delete process.env.SystemRoot;
        delete process.env.windir;
        // On Windows env names are case-insensitive; deleting both is enough.
        assert.throws(
            () => keyAcl.protect('C:\\x\\machine.key', { platform: 'win32' }),
            (e) => e.code === 'key_acl_failed' && /SystemRoot/.test(e.message)
        );
    } finally {
        for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
});
