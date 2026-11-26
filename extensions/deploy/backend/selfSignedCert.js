/**
 * Certificates for sites, made when the operator turns HTTPS on without naming
 * a certificate of their own.
 *
 * One local certificate authority per tenant (`certs/ca/`), made once, signs a
 * certificate per site. Client machines trust the authority once, by group
 * policy, and from then on every site of the tenant and every renewal is
 * trusted with nothing more to distribute.
 *
 * Node can parse X.509 but not write it, and Deploy ships no dependency, so
 * certificates are encoded here in DER by hand: P-256 keys, one name, and the
 * extensions a browser checks. PowerShell is not an option: an endpoint agent
 * kills node when it spawns one.
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

/** The authority lasts ten years; it is replaced a year before its end. */
const CA_DAYS = 3650;
const CA_RENEW_BEFORE_MS = 365 * 24 * 3600 * 1000;

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

/* ---------- certificates ---------- */

const ECDSA_SHA256 = () => seq(oid('1.2.840.10045.4.3.2'));
const DAY_MS = 24 * 3600 * 1000;

function cnName(cn) {
    return seq(set(seq(oid('2.5.4.3'), utf8(cn))));
}

function pem(der) {
    const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
    return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

/** Reads one DER length at `i` (just past a tag): `{ len, next }`. */
function readLen(buf, i) {
    const first = buf[i];
    if (first < 0x80) return { len: first, next: i + 1 };
    let n = 0;
    for (let k = 1; k <= (first & 0x7f); k++) n = (n << 8) | buf[i + k];
    return { len: n, next: i + 1 + (first & 0x7f) };
}

/**
 * The key identifier RFC 5280 method 1 names: SHA-1 of the subjectPublicKey
 * bits. Ties a site certificate to the authority that signed it, which is how
 * Windows finds the issuer when two certificates share a name.
 */
function keyId(publicKey) {
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    let { next } = readLen(spki, 1);            // into the outer SEQUENCE
    const alg = readLen(spki, next + 1);        // the AlgorithmIdentifier
    next = alg.next + alg.len;                  // past it, at the BIT STRING
    const bitString = readLen(spki, next + 1);
    return crypto.createHash('sha1').update(spki.subarray(bitString.next + 1, bitString.next + bitString.len)).digest();
}

function sign({ subject, issuer, publicKey, signingKey, days, extensions, now }) {
    const serial = crypto.randomBytes(16);
    serial[0] &= 0x7f;
    serial[0] |= 0x01;
    const tbs = seq(
        explicit(0, integer(Buffer.from([2]))),                              // v3
        integer(serial),
        ECDSA_SHA256(),
        issuer,
        seq(time(new Date(now.getTime() - DAY_MS)), time(new Date(now.getTime() + days * DAY_MS))),
        subject,
        publicKey.export({ type: 'spki', format: 'der' }),
        explicit(3, extensions)
    );
    return pem(seq(tbs, ECDSA_SHA256(), bits(crypto.sign('sha256', tbs, signingKey))));
}

/**
 * A new authority: `{ cert, key }` as PEM. Named after the host so an
 * operator who trusts several can tell them apart in the store.
 */
function generateCa(now = new Date()) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const name = cnName(`Aegis Deploy local CA (${os.hostname()})`);
    const cert = sign({
        subject: name, issuer: name, publicKey, signingKey: privateKey, days: CA_DAYS, now,
        extensions: seq(
            extension('2.5.29.19', seq(TRUE), true),                         // CA
            extension('2.5.29.15', bits(Buffer.from([0x06]), 1), true),      // keyCertSign, cRLSign
            extension('2.5.29.14', octets(keyId(publicKey)))                 // subjectKeyIdentifier
        )
    });
    return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

/**
 * A site certificate signed by `ca` (`{ cert, key }` PEM): `{ cert, key }`,
 * where `cert` holds the site certificate followed by the authority, the chain
 * the TLS server sends. `names` is `{ dns: [], ips: [] }`.
 */
function generate(names, ca, now = new Date()) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const caX = new crypto.X509Certificate(ca.cert);
    const cn = names.dns.find((d) => d !== 'localhost') || names.ips[0] || 'localhost';
    const san = Buffer.concat([
        ...names.dns.map((d) => tlv(0x82, Buffer.from(d, 'ascii'))),
        ...names.ips.map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number))))
    ]);
    const leaf = sign({
        subject: cnName(cn),
        issuer: cnName(caX.subject.replace(/^CN=/, '')),
        publicKey,
        signingKey: crypto.createPrivateKey(ca.key),
        days: VALID_DAYS,
        now,
        extensions: seq(
            extension('2.5.29.19', seq(), true),                             // not a CA
            extension('2.5.29.15', bits(Buffer.from([0x80]), 7), true),      // digitalSignature
            extension('2.5.29.37', seq(oid('1.3.6.1.5.5.7.3.1'))),           // serverAuth
            extension('2.5.29.17', seq(san)),                                // subjectAltName
            extension('2.5.29.35', seq(tlv(0x80, keyId(caX.publicKey))))     // authorityKeyIdentifier
        )
    });
    return { cert: leaf + ca.cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

/* ---------- files ---------- */

/** Renewed this long before it expires, so a browser never sees it lapse. */
const RENEW_BEFORE_MS = 30 * DAY_MS;

/** Where a tenant's generated certificates live: beside its projects.json. */
function certsDir(tenantPaths) {
    return path.join(require('./projectStore').deployRoot(tenantPaths), 'certs');
}

function caFiles(tenantPaths) {
    const dir = path.join(certsDir(tenantPaths), 'ca');
    return { dir, certFile: path.join(dir, 'ca.crt'), keyFile: path.join(dir, 'ca.key') };
}

const defaultProtect = (f) => require('./keyAcl').protect(f);

/**
 * Writes `key` to `keyFile` and restricts it before anything else is written.
 * If the restriction fails the key is removed and the error thrown, so no key
 * is ever left readable.
 */
function writeKey(keyFile, key, protectKey) {
    fs.writeFileSync(keyFile, key, { encoding: 'utf8', mode: 0o600 });
    try {
        protectKey(keyFile);
    } catch (e) {
        try { fs.rmSync(keyFile, { force: true }); } catch (_) { /* best effort */ }
        throw e;
    }
}

/** The tenant's authority as `{ cert, key }` PEM, made or replaced when needed. */
function loadOrCreateCa(tenantPaths, { protectKey = defaultProtect, now = Date.now() } = {}) {
    const f = caFiles(tenantPaths);
    try {
        const cert = fs.readFileSync(f.certFile, 'utf8');
        const key = fs.readFileSync(f.keyFile, 'utf8');
        const x = new crypto.X509Certificate(cert);
        const pub = crypto.createPublicKey(crypto.createPrivateKey(key)).export({ type: 'spki', format: 'der' });
        if (x.ca && Date.parse(x.validTo) - now > CA_RENEW_BEFORE_MS
            && pub.equals(x.publicKey.export({ type: 'spki', format: 'der' }))) {
            return { cert, key };
        }
    } catch (_) { /* none yet, or unreadable: made below */ }
    fs.mkdirSync(f.dir, { recursive: true });
    const ca = generateCa(new Date(now));
    writeKey(f.keyFile, ca.key, protectKey);
    fs.writeFileSync(f.certFile, ca.cert, 'utf8');
    return ca;
}

/** The authority's certificate (PEM) for client machines, or null when none was made. */
function caCertificate(tenantPaths) {
    try {
        return new crypto.X509Certificate(fs.readFileSync(caFiles(tenantPaths).certFile)).toString();
    } catch (_) {
        return null;
    }
}

/**
 * Whether the generated site certificate at `certFile` must be made again:
 * missing, unreadable, within 30 days of its end, or not signed by `caCert`
 * (the 0.2.18 self-signed ones, or an authority that was replaced).
 */
function needsRenewal(certFile, caCert, now = Date.now()) {
    try {
        const x = new crypto.X509Certificate(fs.readFileSync(certFile));
        if (Date.parse(x.validTo) - now < RENEW_BEFORE_MS) return true;
        return !caCert || !x.verify(new crypto.X509Certificate(caCert).publicKey);
    } catch (_) {
        return true;
    }
}

/**
 * Gives `project` a working certificate when it needs one, and saves the
 * record. Returns true when it changed `project.tls`.
 *
 * Needs one: HTTPS is on, the site asks for a password (`gated`), or the
 * operator turned HTTPS on without naming files (`want`). A certificate the
 * operator named is only ever switched on, never replaced; one Aegis made is
 * made again when `needsRenewal` says so.
 */
function ensureFor(tenantPaths, project, { gated = false, want = false, extraNames = [], protectKey = defaultProtect, save } = {}) {
    const t = project.tls || {};
    if (t.enabled !== true && !gated && !want) return false;
    const named = !!(t.certFile && t.keyFile);
    if (named && t.generated !== true) {
        if (t.enabled === true) return false;
        project.tls = Object.assign({}, t, { enabled: true });
        if (save) save(project);
        return true;
    }
    const ca = loadOrCreateCa(tenantPaths, { protectKey });
    if (named && !needsRenewal(t.certFile, ca.cert)) {
        if (t.enabled === true) return false;
        project.tls = Object.assign({}, t, { enabled: true });
        if (save) save(project);
        return true;
    }
    const dir = certsDir(tenantPaths);
    fs.mkdirSync(dir, { recursive: true });
    const { cert, key } = generate(hostNames(extraNames), ca);
    const certFile = path.join(dir, `${project.id}.crt`);
    const keyFile = path.join(dir, `${project.id}.key`);
    writeKey(keyFile, key, protectKey);
    fs.writeFileSync(certFile, cert, 'utf8');
    project.tls = { enabled: true, certFile, keyFile, generated: true };
    if (save) save(project);
    return true;
}

module.exports = {
    generate, generateCa, hostNames, ensureFor, needsRenewal, certsDir,
    loadOrCreateCa, caCertificate, VALID_DAYS
};
