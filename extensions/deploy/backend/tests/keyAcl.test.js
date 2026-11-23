'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const keyAcl = require('../keyAcl');

function fakeRun({ sid = 'S-1-5-21-111-222-333-1001', failIcacls = false } = {}) {
    const calls = [];
    const run = (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === 'whoami') return `"host\\svc","${sid}"\r\n`;
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
    assert.strictEqual(icacls.length, 1);
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
