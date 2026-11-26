'use strict';

/**
 * The generated certificate: a browser must be able to use it, and the rules
 * for when one is made, kept, renewed or left alone.
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
    return { root, data: root, tenantRoot: root };
}

// keyAcl calls icacls; the unit test only checks the hook is called.
const opts = (extra) => Object.assign({ protectKey: () => { } }, extra);

test('the certificate names the host, its addresses and the extra name, and serves verified TLS', async () => {
    const { cert, key } = ssc.generate(ssc.hostNames(['site.corp.local']));
    const x = new crypto.X509Certificate(cert);
    assert.match(x.subjectAltName, /DNS:localhost/);
    assert.match(x.subjectAltName, /DNS:site\.corp\.local/);
    assert.match(x.subjectAltName, /IP Address:127\.0\.0\.1/);
    assert.ok(x.verify(x.publicKey), 'self-signed');
    assert.strictEqual(x.ca, false);
    const days = (Date.parse(x.validTo) - Date.now()) / 86400000;
    assert.ok(days > ssc.VALID_DAYS - 2 && days <= ssc.VALID_DAYS, `validity ${days}`);

    const server = https.createServer({ cert, key }, (q, r) => r.end('ok'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        const body = await new Promise((resolve, reject) => {
            https.get({ host: '127.0.0.1', port: server.address().port, ca: cert }, (r) => {
                let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve(b));
            }).on('error', reject);
        });
        assert.strictEqual(body, 'ok');
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

test('a protected site with no TLS gets a generated pair under the tenant, key protected', () => {
    const tp = tmpTenant();
    const protectedFiles = [];
    const saved = [];
    const project = { id: 'site-a', auth: { method: 'ldap' } };
    const changed = ssc.ensureFor(tp, project, opts({
        gated: true, protectKey: (f) => protectedFiles.push(f), save: (p) => saved.push(p)
    }));
    assert.strictEqual(changed, true);
    assert.strictEqual(project.tls.enabled, true);
    assert.strictEqual(project.tls.generated, true);
    assert.ok(project.tls.certFile.startsWith(ssc.certsDir(tp)));
    assert.ok(fs.existsSync(project.tls.certFile) && fs.existsSync(project.tls.keyFile));
    assert.deepStrictEqual(protectedFiles, [project.tls.keyFile]);
    assert.strictEqual(saved.length, 1);
});

test('an open site with no TLS is left alone', () => {
    const project = { id: 'site-b' };
    assert.strictEqual(ssc.ensureFor(tmpTenant(), project, opts()), false);
    assert.strictEqual(project.tls, undefined);
});

test('a valid generated pair is kept, and switched back on without a new key', () => {
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

test('a generated pair that is gone or near its end is renewed', () => {
    const tp = tmpTenant();
    const project = { id: 'site-d' };
    ssc.ensureFor(tp, project, opts({ want: true }));
    const first = fs.readFileSync(project.tls.certFile, 'utf8');
    fs.rmSync(project.tls.certFile);
    assert.strictEqual(ssc.ensureFor(tp, project, opts()), true, 'enabled and missing renews');
    assert.notStrictEqual(fs.readFileSync(project.tls.certFile, 'utf8'), first);
    assert.strictEqual(ssc.needsRenewal(project.tls.certFile, Date.now() + (ssc.VALID_DAYS - 10) * 86400000), true);
});

test('the operator\'s own certificate is never replaced, only switched on', () => {
    const tp = tmpTenant();
    const project = { id: 'site-e', tls: { enabled: false, certFile: 'C:\\own\\c.crt', keyFile: 'C:\\own\\c.key' } };
    assert.strictEqual(ssc.ensureFor(tp, project, opts({ gated: true })), true);
    assert.deepStrictEqual(project.tls, { enabled: true, certFile: 'C:\\own\\c.crt', keyFile: 'C:\\own\\c.key' });
    assert.strictEqual(ssc.ensureFor(tp, project, opts({ gated: true })), false);
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
    assert.deepStrictEqual(fs.readdirSync(ssc.certsDir(tp)), []);
});
