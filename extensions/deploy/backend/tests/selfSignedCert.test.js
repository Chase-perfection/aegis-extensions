'use strict';

/**
 * Generated certificates: one local authority per tenant signs each site's
 * certificate. A TLS client that trusts only the authority must accept the
 * site, and the rules for when one is made, kept, renewed or left alone.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const ssc = require('../selfSignedCert');

function tmpTenant() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-ssc-'));
    return { root };
}

// keyAcl calls icacls; the unit tests only check the hook is called.
const opts = (extra) => Object.assign({ protectKey: () => { } }, extra);

function get(port, ca, servername) {
    return new Promise((resolve, reject) => {
        https.get({ host: '127.0.0.1', port, ca, servername }, (r) => {
            let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve(b));
        }).on('error', reject);
    });
}

test('a client that trusts only the authority accepts the site, by address and by name', async () => {
    const ca = ssc.generateCa();
    const caX = new crypto.X509Certificate(ca.cert);
    assert.strictEqual(caX.ca, true);
    assert.ok(caX.verify(caX.publicKey), 'the authority is self-signed');

    const { cert, key } = ssc.generate(ssc.hostNames(['site.corp.local']), ca);
    const leaf = new crypto.X509Certificate(cert);
    assert.strictEqual(leaf.ca, false);
    assert.ok(leaf.verify(caX.publicKey), 'signed by the authority');
    assert.strictEqual(leaf.issuer, caX.subject);
    assert.match(leaf.subjectAltName, /DNS:site\.corp\.local/);
    assert.match(leaf.subjectAltName, /IP Address:127\.0\.0\.1/);
    const days = (Date.parse(leaf.validTo) - Date.now()) / 86400000;
    assert.ok(days > ssc.VALID_DAYS - 2 && days <= ssc.VALID_DAYS, `validity ${days}`);

    const server = https.createServer({ cert, key }, (q, r) => r.end('ok'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        const port = server.address().port;
        assert.strictEqual(await get(port, ca.cert), 'ok');
        assert.strictEqual(await get(port, ca.cert, 'site.corp.local'), 'ok');
        await assert.rejects(get(port, ssc.generateCa().cert), /certificate/i,
            'another authority is not trusted');
    } finally {
        server.close();
    }
});

test('hostNames ignores junk and keeps one copy of each name', () => {
    const n = ssc.hostNames(['', null, 'bad name', 'LOCALHOST', '10.0.0.5', '10.0.0.5']);
    assert.ok(!n.dns.includes('bad name'));
    assert.strictEqual(n.dns.filter((d) => d === 'localhost').length, 1);
    assert.strictEqual(n.ips.filter((i) => i === '10.0.0.5').length, 1);
});

test('the authority is made once per tenant and reused', () => {
    const tp = tmpTenant();
    const protectedFiles = [];
    const a = ssc.loadOrCreateCa(tp, { protectKey: (f) => protectedFiles.push(f) });
    const b = ssc.loadOrCreateCa(tp, { protectKey: (f) => protectedFiles.push(f) });
    assert.strictEqual(a.cert, b.cert);
    assert.strictEqual(protectedFiles.length, 1, 'the authority key is protected once');
    assert.strictEqual(ssc.caCertificate(tp).trim(), new crypto.X509Certificate(a.cert).toString().trim());
});

const YEAR = 365 * 86400000;
const DAY = 86400000;
const roles = (tp, now) => ssc.trustBundle(tp, now).map((c) => c.role).join(',');
const thumb = (pem) => new crypto.X509Certificate(pem).fingerprint.replace(/:/g, '');

test('rotation: successor published two years ahead, switch one year ahead, old one kept 30 days', () => {
    const tp = tmpTenant();
    const t0 = Date.now();
    const a = ssc.maintainCa(tp, opts({ now: t0 }));
    assert.strictEqual(a.created, true);
    assert.strictEqual(roles(tp, t0), 'current');

    const tPrep = t0 + 8.1 * YEAR;
    const p = ssc.maintainCa(tp, opts({ now: tPrep }));
    assert.deepStrictEqual([p.created, p.prepared, p.switched], [false, true, false]);
    assert.strictEqual(p.current.cert, a.current.cert, 'the current one still signs');
    const bundle = ssc.trustBundle(tp, tPrep);
    assert.strictEqual(bundle.map((c) => c.role).join(','), 'current,next');
    assert.notStrictEqual(bundle[0].thumbprint, bundle[1].thumbprint);
    assert.match(bundle[1].thumbprint, /^[0-9A-F]{40}$/);
    const nextThumb = bundle[1].thumbprint;

    // Nothing more until a year before the end.
    assert.strictEqual(ssc.maintainCa(tp, opts({ now: tPrep + 100 * DAY })).switched, false);

    const tSwitch = t0 + 9.05 * YEAR;
    const s = ssc.maintainCa(tp, opts({ now: tSwitch }));
    assert.strictEqual(s.switched, true);
    assert.strictEqual(thumb(s.current.cert), nextThumb, 'the published successor signs now');
    assert.strictEqual(roles(tp, tSwitch), 'current,previous');

    // A site signed by the old authority is signed again.
    const leaf = ssc.generate({ dns: ['localhost'], ips: ['127.0.0.1'] }, a.current, new Date(tSwitch - 10 * DAY));
    const leafFile = path.join(tp.root, 'site.crt');
    fs.writeFileSync(leafFile, leaf.cert);
    assert.strictEqual(ssc.needsRenewal(leafFile, s.current.cert, tSwitch), true);

    ssc.maintainCa(tp, opts({ now: tSwitch + 31 * DAY }));
    assert.strictEqual(roles(tp, tSwitch + 31 * DAY), 'current');
});

test('rotation: a successor made late waits for its overlap before it signs', () => {
    const tp = tmpTenant();
    const t0 = Date.now();
    const a = ssc.maintainCa(tp, opts({ now: t0 })).current;
    const late = t0 + 9.5 * YEAR;
    assert.strictEqual(ssc.maintainCa(tp, opts({ now: late })).prepared, true);
    const mid = ssc.maintainCa(tp, opts({ now: late + 10 * DAY }));
    assert.strictEqual(mid.switched, false);
    assert.strictEqual(mid.current.cert, a.cert);
    assert.strictEqual(ssc.maintainCa(tp, opts({ now: late + 31 * DAY })).switched, true);
});

test('rotation: prepare and switch on demand; switch with nothing prepared refuses', () => {
    const tp = tmpTenant();
    const a = ssc.maintainCa(tp, opts()).current;
    assert.strictEqual(ssc.maintainCa(tp, opts({ action: 'switch' })).error, 'no_next');
    assert.strictEqual(ssc.maintainCa(tp, opts({ action: 'prepare' })).prepared, true);
    assert.strictEqual(ssc.maintainCa(tp, opts({ action: 'prepare' })).prepared, false, 'one successor at a time');
    const s = ssc.maintainCa(tp, opts({ action: 'switch' }));
    assert.strictEqual(s.switched, true);
    assert.notStrictEqual(s.current.cert, a.cert);
    assert.strictEqual(roles(tp, Date.now()), 'current,previous');
});

test('rotation: an expired authority gives way to its successor at once', () => {
    const tp = tmpTenant();
    const t0 = Date.now();
    ssc.maintainCa(tp, opts({ now: t0 }));
    assert.strictEqual(ssc.maintainCa(tp, opts({ now: t0 + 8.5 * YEAR })).prepared, true);
    // The host was off from then until after the end.
    const r = ssc.maintainCa(tp, opts({ now: t0 + 10.1 * YEAR }));
    assert.strictEqual(r.switched, true);
    assert.strictEqual(r.created, false);
});

test('a protected site with no TLS gets a certificate signed by the tenant authority', () => {
    const tp = tmpTenant();
    const protectedFiles = [];
    const saved = [];
    const project = { id: 'site-a', auth: { method: 'ldap' } };
    const changed = ssc.ensureFor(tp, project, {
        gated: true, protectKey: (f) => protectedFiles.push(f), save: (p) => saved.push(p)
    });
    assert.strictEqual(changed, true);
    assert.strictEqual(project.tls.enabled, true);
    assert.strictEqual(project.tls.generated, true);
    assert.ok(project.tls.certFile.startsWith(ssc.certsDir(tp)));
    assert.strictEqual(protectedFiles.length, 2, 'authority key and site key');
    assert.ok(protectedFiles.includes(project.tls.keyFile));
    assert.strictEqual(saved.length, 1);
    const leaf = new crypto.X509Certificate(fs.readFileSync(project.tls.certFile));
    assert.ok(leaf.verify(new crypto.X509Certificate(ssc.caCertificate(tp)).publicKey));
});

test('two sites of a tenant share one authority', () => {
    const tp = tmpTenant();
    const a = { id: 'site-1' };
    const b = { id: 'site-2' };
    ssc.ensureFor(tp, a, opts({ want: true }));
    ssc.ensureFor(tp, b, opts({ want: true }));
    const ca = new crypto.X509Certificate(ssc.caCertificate(tp));
    for (const p of [a, b]) {
        assert.ok(new crypto.X509Certificate(fs.readFileSync(p.tls.certFile)).verify(ca.publicKey), p.id);
    }
});

test('an open site with no TLS is left alone', () => {
    const project = { id: 'site-b' };
    assert.strictEqual(ssc.ensureFor(tmpTenant(), project, opts()), false);
    assert.strictEqual(project.tls, undefined);
});

test('a valid generated certificate is kept, and switched back on without a new key', () => {
    const tp = tmpTenant();
    const project = { id: 'site-c' };
    ssc.ensureFor(tp, project, opts({ want: true }));
    const first = fs.readFileSync(project.tls.keyFile, 'utf8');
    assert.strictEqual(ssc.ensureFor(tp, project, opts({ want: true })), false);
    project.tls.enabled = false;
    assert.strictEqual(ssc.ensureFor(tp, project, opts({ want: true })), true);
    assert.strictEqual(project.tls.enabled, true);
    assert.strictEqual(fs.readFileSync(project.tls.keyFile, 'utf8'), first);
});

test('a 0.2.18 self-signed certificate is replaced by one the authority signs', () => {
    const tp = tmpTenant();
    const dir = ssc.certsDir(tp);
    fs.mkdirSync(dir, { recursive: true });
    // What 0.2.18 wrote: a certificate signed by its own key.
    const own = ssc.generate(ssc.hostNames(), ssc.generateCa());
    fs.writeFileSync(path.join(dir, 'site-old.crt'), own.cert);
    fs.writeFileSync(path.join(dir, 'site-old.key'), own.key);
    const project = { id: 'site-old', tls: { enabled: true, generated: true, certFile: path.join(dir, 'site-old.crt'), keyFile: path.join(dir, 'site-old.key') } };
    assert.strictEqual(ssc.ensureFor(tp, project, opts()), true);
    const leaf = new crypto.X509Certificate(fs.readFileSync(project.tls.certFile));
    assert.ok(leaf.verify(new crypto.X509Certificate(ssc.caCertificate(tp)).publicKey));
});

test('a generated certificate that is gone or near its end is renewed', () => {
    const tp = tmpTenant();
    const project = { id: 'site-d' };
    ssc.ensureFor(tp, project, opts({ want: true }));
    const first = fs.readFileSync(project.tls.certFile, 'utf8');
    fs.rmSync(project.tls.certFile);
    assert.strictEqual(ssc.ensureFor(tp, project, opts()), true, 'enabled and missing renews');
    assert.notStrictEqual(fs.readFileSync(project.tls.certFile, 'utf8'), first);
    const ca = ssc.caCertificate(tp);
    assert.strictEqual(ssc.needsRenewal(project.tls.certFile, ca, Date.now() + (ssc.VALID_DAYS - 10) * 86400000), true);
    assert.strictEqual(ssc.needsRenewal(project.tls.certFile, ca), false);
});

test('the operator\'s own certificate is never replaced, only switched on', () => {
    const tp = tmpTenant();
    const project = { id: 'site-e', tls: { enabled: false, certFile: 'C:\\own\\c.crt', keyFile: 'C:\\own\\c.key' } };
    assert.strictEqual(ssc.ensureFor(tp, project, opts({ gated: true })), true);
    assert.deepStrictEqual(project.tls, { enabled: true, certFile: 'C:\\own\\c.crt', keyFile: 'C:\\own\\c.key' });
    assert.strictEqual(ssc.ensureFor(tp, project, opts({ gated: true })), false);
    assert.strictEqual(ssc.caCertificate(tp), null, 'no authority made for an own certificate');
});

test('a key that cannot be protected is removed and nothing is saved', () => {
    const tp = tmpTenant();
    const project = { id: 'site-f' };
    let saved = false;
    assert.throws(() => ssc.ensureFor(tp, project, {
        want: true,
        protectKey: () => { throw new Error('acl'); },
        save: () => { saved = true; }
    }), /acl/);
    assert.strictEqual(saved, false);
    assert.strictEqual(project.tls, undefined);
    const left = fs.existsSync(ssc.certsDir(tp)) ? fs.readdirSync(ssc.certsDir(tp), { recursive: true }) : [];
    assert.ok(!left.some((f) => String(f).endsWith('.key')), `no key left: ${left}`);
});
