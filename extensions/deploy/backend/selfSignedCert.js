/**
 * A self-signed certificate for a site, made when the operator turns HTTPS on
 * without naming a certificate of their own.
 *
 * Node can parse X.509 but not write it, and Deploy ships no dependency, so
 * the certificate is encoded here in DER by hand: a P-256 key, one name, the
 * extensions a browser checks (SAN, key usage, server auth) and nothing else.
 * PowerShell is not an option: an endpoint agent kills node when it spawns one.
 *
 * Browsers warn on it until its .crt is trusted on the client (GPO, or the
 * Trusted Root store by hand). The page says so and offers the file.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

/**
 * 825 days: the longest validity Apple platforms accept for a TLS certificate
 * from a private root. Others accept more; nobody accepts this one less.
 */
const VALID_DAYS = 825;

/* ---------- DER ---------- */

function len(n) {
    if (n < 0x80) return Buffer.from([n]);
    const bytes = [];
    while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, body) {
    return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
}

const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const octets = (buf) => tlv(0x04, buf);
const bits = (buf, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), buf]));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const explicit = (n, body) => tlv(0xa0 + n, body);
const TRUE = Buffer.from([0x01, 0x01, 0xff]);

function integer(buf) {
    let b = buf;
    while (b.length > 1 && b[0] === 0 && b[1] < 0x80) b = b.subarray(1);
    if (b[0] >= 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return tlv(0x02, b);
}

function oid(dotted) {
    const parts = dotted.split('.').map(Number);
    const out = [40 * parts[0] + parts[1]];
    for (const p of parts.slice(2)) {
        const chunk = [p & 0x7f];
        let v = p >>> 7;
        while (v > 0) { chunk.unshift(0x80 | (v & 0x7f)); v >>>= 7; }
        out.push(...chunk);
    }
    return tlv(0x06, Buffer.from(out));
}

/** UTCTime, good until 2049, which a 825-day certificate never reaches. */
function time(date) {
    const p = (n) => String(n).padStart(2, '0');
    const s = p(date.getUTCFullYear() % 100) + p(date.getUTCMonth() + 1) + p(date.getUTCDate())
        + p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + 'Z';
    return tlv(0x17, Buffer.from(s, 'ascii'));
}

function extension(id, value, critical) {
    return critical ? seq(oid(id), TRUE, octets(value)) : seq(oid(id), octets(value));
}

/* ---------- names ---------- */

/** The DNS names and IPv4 addresses a visitor may type to reach this host. */
function hostNames(extra = []) {
    const dns = new Set(['localhost']);
    const ips = new Set(['127.0.0.1']);
    const add = (value) => {
        const v = String(value || '').trim().toLowerCase();
        if (!v) return;
        if (net.isIPv4(v)) ips.add(v);
        else if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(v) && v.length <= 253) dns.add(v);
    };
    add(os.hostname());
    if (process.env.USERDNSDOMAIN) add(`${os.hostname()}.${process.env.USERDNSDOMAIN}`);
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) if (a.family === 'IPv4' || a.family === 4) add(a.address);
    }
    for (const e of extra) add(e);
    return { dns: [...dns], ips: [...ips] };
}

/* ---------- certificate ---------- */

/**
 * `{ cert, key }` as PEM strings. `names` is `{ dns: [], ips: [] }`; the
 * first DNS name, else the first address, is the subject's common name.
 */
function generate(names, now = new Date()) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const algorithm = seq(oid('1.2.840.10045.4.3.2'));   // ecdsa-with-SHA256
    const cn = names.dns.find((d) => d !== 'localhost') || names.ips[0] || 'localhost';
    const name = seq(set(seq(oid('2.5.4.3'), utf8(cn))));

    const san = Buffer.concat([
        ...names.dns.map((d) => tlv(0x82, Buffer.from(d, 'ascii'))),
        ...names.ips.map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number))))
    ]);
    const extensions = seq(
        extension('2.5.29.19', seq(), true),                                 // not a CA
        extension('2.5.29.15', bits(Buffer.from([0x80]), 7), true),          // digitalSignature
        extension('2.5.29.37', seq(oid('1.3.6.1.5.5.7.3.1'))),               // serverAuth
        extension('2.5.29.17', seq(san))                                     // subjectAltName
    );

    const serial = crypto.randomBytes(16);
    serial[0] &= 0x7f;
    serial[0] |= 0x01;
    const notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
    const notAfter = new Date(now.getTime() + VALID_DAYS * 24 * 3600 * 1000);

    const tbs = seq(
        explicit(0, integer(Buffer.from([2]))),                              // v3
        integer(serial),
        algorithm,
        name,
        seq(time(notBefore), time(notAfter)),
        name,
        publicKey.export({ type: 'spki', format: 'der' }),
        explicit(3, extensions)
    );
    const signature = crypto.sign('sha256', tbs, privateKey);
    const der = seq(tbs, algorithm, bits(signature));

    const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
    return {
        cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
        key: privateKey.export({ type: 'pkcs8', format: 'pem' })
    };
}

/**
 * Writes `<dir>/<id>.crt` and `<dir>/<id>.key` and returns their paths. The
 * key is restricted with `protectKey` before this returns; if that fails both
 * files are removed and the error is thrown, so no key is left readable.
 */
function writeFor(dir, id, { extraNames = [], protectKey } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const { cert, key } = generate(hostNames(extraNames));
    const certFile = path.join(dir, `${id}.crt`);
    const keyFile = path.join(dir, `${id}.key`);
    fs.writeFileSync(keyFile, key, { encoding: 'utf8', mode: 0o600 });
    try {
        if (protectKey) protectKey(keyFile);
    } catch (e) {
        try { fs.rmSync(keyFile, { force: true }); } catch (_) { /* best effort */ }
        throw e;
    }
    fs.writeFileSync(certFile, cert, 'utf8');
    return { certFile, keyFile };
}

/** Renewed this long before it expires, so a browser never sees it lapse. */
const RENEW_BEFORE_MS = 30 * 24 * 3600 * 1000;

/** Where a tenant's generated certificates live: beside its projects.json. */
function certsDir(tenantPaths) {
    return path.join(require('./projectStore').deployRoot(tenantPaths), 'certs');
}

/** Whether the generated certificate at `certFile` is missing, unreadable or near its end. */
function needsRenewal(certFile, now = Date.now()) {
    try {
        const x = new crypto.X509Certificate(fs.readFileSync(certFile));
        return Date.parse(x.validTo) - now < RENEW_BEFORE_MS;
    } catch (_) {
        return true;
    }
}

/**
 * Gives `project` a working certificate when it needs one and has none, and
 * saves the record. Returns true when it changed `project.tls`.
 *
 * Needs one: the site asks for a password (`gated`) or the operator turned
 * HTTPS on without naming files (`want`). A certificate the operator named is
 * never touched; one Aegis generated is renewed 30 days before it expires.
 */
function ensureFor(tenantPaths, project, { gated = false, want = false, extraNames = [], protectKey, save } = {}) {
    const t = project.tls || {};
    if (t.enabled !== true && !gated && !want) return false;
    const named = !!(t.certFile && t.keyFile);
    // The operator's own files are only ever switched on, never replaced; a
    // generated pair is kept while it has more than 30 days to run.
    if (named && (t.generated !== true || !needsRenewal(t.certFile))) {
        if (t.enabled === true) return false;
        project.tls = Object.assign({}, t, { enabled: true });
        if (save) save(project);
        return true;
    }
    const files = writeFor(certsDir(tenantPaths), project.id, {
        extraNames,
        protectKey: protectKey || ((f) => require('./keyAcl').protect(f))
    });
    project.tls = { enabled: true, certFile: files.certFile, keyFile: files.keyFile, generated: true };
    if (save) save(project);
    return true;
}

module.exports = { generate, writeFor, hostNames, ensureFor, needsRenewal, certsDir, VALID_DAYS };
