'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The store lives under AEGIS_DATA_ROOT, read at call time: point it at a
// throwaway folder before anything writes.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ni-account-'));
process.env.AEGIS_DATA_ROOT = ROOT;

const scanAccount = require('../scanAccount');

beforeEach(() => {
    fs.rmSync(path.join(ROOT, 'network-inventory'), { recursive: true, force: true });
    scanAccount._failures.clear();
    scanAccount._setRunner(null);
});

test('normalize accepts DOMAIN\\name and a UPN, trimmed', () => {
    assert.strictEqual(scanAccount.normalize('  CORP\\svc-scan '), 'CORP\\svc-scan');
    assert.strictEqual(scanAccount.normalize('svc.scan@corp.local'), 'svc.scan@corp.local');
    assert.strictEqual(scanAccount.normalize('corp.local\\Lecture Réseau'), 'corp.local\\Lecture Réseau');
});

test('normalize refuses what /netonly cannot present', () => {
    for (const bad of ['', 'svc-scan', '.\\localuser', 'CORP\\gmsa$', 'LocalSystem', 'a@nodot',
        'CORP\\"quoted"', 'CORP\\a\\b', null, 42, 'x'.repeat(300)]) {
        assert.strictEqual(scanAccount.normalize(bad), null, String(bad));
    }
});

test('SCAN_DOMAIN holds a domain to characters safe on a command line', () => {
    assert.ok(scanAccount.SCAN_DOMAIN.test('corp.local'));
    assert.ok(scanAccount.SCAN_DOMAIN.test('CORP'));
    for (const bad of ['corp.local" -X', 'a b', '-Domain', 'corp;calc', '']) {
        assert.ok(!scanAccount.SCAN_DOMAIN.test(bad), bad);
    }
});

test('a secret survives the round trip, a tampered one reads as null', () => {
    const packed = scanAccount._encrypt('Pässw0rd!');
    assert.ok(!packed.includes('Pässw0rd'));
    assert.strictEqual(scanAccount._decrypt(packed), 'Pässw0rd!');
    const [iv, tag, data] = packed.split('.');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 1;
    assert.strictEqual(scanAccount._decrypt([iv, tag, flipped.toString('base64')].join('.')), null);
    assert.strictEqual(scanAccount._decrypt('garbage'), null);
});

test('save keeps the password out of the file and out of describe()', () => {
    scanAccount.save('acme', 'CORP\\svc-scan', 'S3cret-value', 'admin@corp.local');
    const raw = fs.readFileSync(scanAccount._storeFile(), 'utf8');
    assert.ok(!raw.includes('S3cret-value'));
    const d = scanAccount.describe('acme');
    assert.deepStrictEqual(Object.keys(d).sort(), ['account', 'updatedAt', 'updatedBy']);
    assert.strictEqual(d.account, 'CORP\\svc-scan');
    assert.deepStrictEqual(scanAccount.credentials('acme'), { account: 'CORP\\svc-scan', password: 'S3cret-value' });
});

test('accounts are kept per tenant', () => {
    scanAccount.save('acme', 'CORP\\svc-a', 'a', null);
    scanAccount.save('globex', 'OTHER\\svc-b', 'b', null);
    assert.strictEqual(scanAccount.describe('acme').account, 'CORP\\svc-a');
    assert.strictEqual(scanAccount.describe('globex').account, 'OTHER\\svc-b');
    assert.strictEqual(scanAccount.clear('acme'), true);
    assert.strictEqual(scanAccount.describe('acme'), null);
    assert.strictEqual(scanAccount.describe('globex').account, 'OTHER\\svc-b');
    assert.strictEqual(scanAccount.clear('acme'), false);
});

test('the store is outside the tenant tree, under the data root', () => {
    scanAccount.save('acme', 'CORP\\svc', 'x', null);
    assert.ok(scanAccount._storeFile().startsWith(path.join(ROOT, 'network-inventory')));
});

test('a password whose key changed reads as null, not as a crash', () => {
    scanAccount.save('acme', 'CORP\\svc', 'x', null);
    fs.writeFileSync(path.join(ROOT, 'network-inventory', 'machine.key'), Buffer.alloc(32, 7));
    assert.deepStrictEqual(scanAccount.credentials('acme'), { account: 'CORP\\svc', password: null });
});

test('verify passes the secret through the environment, never the script', async () => {
    let seen = null;
    scanAccount._setRunner(async (script, vars) => { seen = { script, vars }; return { ok: true }; });
    assert.deepStrictEqual(await scanAccount.verify('CORP\\svc', 'pw-123'), { ok: true });
    assert.strictEqual(seen.vars.AEGIS_SCAN_NET_SECRET, 'pw-123');
    assert.strictEqual(seen.vars.AEGIS_SCAN_NET_ACCOUNT, 'CORP\\svc');
    assert.ok(!seen.script.includes('pw-123'));
    assert.ok(/LogonUser\(user, domain, password, 3,/.test(seen.script), 'a network logon, type 3');
    assert.ok(!seen.script.includes('S-1-5-32-544'), 'no administrator requirement for a scan account');
});

test('verify names the Windows refusal and never calls Windows without a password', async () => {
    let calls = 0;
    scanAccount._setRunner(async () => { calls++; return { ok: false, win32: 1326 }; });
    assert.deepStrictEqual(await scanAccount.verify('CORP\\svc', 'wrong'), { ok: false, code: 'EBADCRED', reason: 'bad_password' });
    assert.deepStrictEqual(await scanAccount.verify('CORP\\svc', ''), { ok: false, code: 'ENOPASSWORD' });
    assert.deepStrictEqual(await scanAccount.verify('CORP\\svc', 'a\nb'), { ok: false, code: 'ENOPASSWORD' });
    assert.strictEqual(calls, 1);
    scanAccount._setRunner(async () => ({ ok: false, detail: 'powershell failed' }));
    assert.strictEqual((await scanAccount.verify('CORP\\svc', 'x')).code, 'EVERIFY');
});

test('five refused passwords lock the tenant for ten minutes', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < scanAccount.LOCK_MAX - 1; i++) scanAccount.recordFailure('acme', t0 + i);
    assert.strictEqual(scanAccount.isLocked('acme', t0 + 10), false);
    scanAccount.recordFailure('acme', t0 + 10);
    assert.strictEqual(scanAccount.isLocked('acme', t0 + 11), true);
    assert.strictEqual(scanAccount.isLocked('globex', t0 + 11), false);
    assert.strictEqual(scanAccount.isLocked('acme', t0 + 10 * 60 * 1000 + 11), false);
});

test('launch puts the password in the environment only', () => {
    const l = scanAccount.launch({ account: 'CORP\\svc', password: 'pw-launch' }, { domain: 'corp.local', probeOnly: true });
    assert.strictEqual(l.file, 'powershell.exe');
    assert.ok(!l.args.some(a => String(a).includes('pw-launch')));
    assert.ok(l.args.includes(scanAccount.LAUNCHER_PATH));
    assert.deepStrictEqual(l.args.slice(-3), ['-Domain', 'corp.local', '-ProbeOnly']);
    assert.strictEqual(l.env.AEGIS_SCAN_NET_SECRET, 'pw-launch');
    assert.strictEqual(l.env.AEGIS_SCAN_NET_ACCOUNT, 'CORP\\svc');
    assert.ok(!Object.keys(l.env).some(k => k.toLowerCase() === 'psmodulepath'));
});

test('launcherError reads the launcher refusal line', () => {
    assert.deepStrictEqual(scanAccount.launcherError('noise\nNETONLY_ERROR:1314:A required privilege is not held\n'),
        { win32: 1314, message: 'A required privilege is not held' });
    assert.strictEqual(scanAccount.launcherError('plain error'), null);
});

// The launcher for real, through powershell.exe. Unelevated, Windows refuses the
// start with 1314 (no SeImpersonatePrivilege), which still proves the C# compiles,
// the /netonly logon opens and the refusal reaches the backend readable.
// Elevated, as the service is, the scan's -SelfTest runs and names the account.
test('the launcher starts the scan as the account, or says Windows refused', { skip: process.platform !== 'win32' }, async () => {
    const { execFile } = require('child_process');
    const l = scanAccount.launch({ account: 'CORP\\nobody', password: 'not-a-password' }, {});
    l.args.push('-SelfTest');
    const r = await new Promise((resolve) => {
        execFile(l.file, l.args, { env: l.env, windowsHide: true, timeout: 120000 }, (err, stdout, stderr) =>
            resolve({ code: err ? err.code : 0, stdout, stderr }));
    });
    const refused = scanAccount.launcherError(r.stderr);
    if (refused) {
        assert.strictEqual(r.code, scanAccount.START_FAILED_EXIT);
        assert.strictEqual(refused.win32, 1314, r.stderr);
        assert.ok(!refused.message.includes(String.fromCharCode(0xFFFD)), 'the Windows message must arrive as UTF-8');
        return;
    }
    assert.strictEqual(r.code, 0, r.stderr);
    const line = r.stdout.trim().split(/\r?\n/).filter(x => x.trim().startsWith('{')).pop();
    assert.strictEqual(JSON.parse(line).context.userName, 'CORP\\nobody');
});
