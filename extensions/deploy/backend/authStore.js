/**
 * The directory a tenant authenticates deployed sites against.
 *
 * One record per tenant, not one per site. An organisation has one Active
 * Directory; asking an operator to retype a domain controller URL and a service
 * account for every site they protect would guarantee that half of them are
 * wrong. Which sites use it is a per-project decision and lives on the project
 * record (`project.auth`), not here.
 *
 * The file sits next to `projects.json` in `<tenant>/deploy/`, because that
 * folder already is the deploy extension's tenant state and the poller already
 * treats its existence as "this tenant uses deploy".
 *
 * The bind password is the one secret in it, and it is encrypted with
 * `machineStore.encrypt()`. That key file lives outside the repository tree by
 * construction, so the ciphertext travelling into a backup or a support bundle
 * carries nothing. It is not protection against someone who already owns the
 * machine, and it is not meant to be.
 *
 * `readConfig` fails closed. A record with no URL or no base DN is not a
 * half-configured directory to try anyway, it is no directory, and the caller
 * must refuse to serve rather than fall back to letting everyone in.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { X509Certificate } = require('node:crypto');

const machineStore = require('./machineStore');
const projectStore = require('./projectStore');

/** What Active Directory answers to, and where group membership is published. */
const DEFAULT_USER_FILTER = '(&(objectClass=user)(sAMAccountName={username}))';
const DEFAULT_GROUP_ATTR = 'memberOf';
/** Minutes between two checks that a logged-in user is still in the group. */
const DEFAULT_REVALIDATE_MINUTES = 10;
const DEFAULT_TIMEOUT_MS = 8000;
/** How many authorities one directory may pin, and how large each may be. */
const MAX_PINNED = 8;
const MAX_PEM_LEN = 16 * 1024;

/**
 * The certificate authorities this tenant pinned for its directory.
 *
 * A pinned authority is the answer to a domain controller whose certificate
 * comes from a CA that is not in this server's Windows store -- the ordinary
 * case when Aegis is not joined to the domain it audits. The alternative on
 * offer before was to stop validating the certificate, on the one connection
 * that carries the service account password, and that is a worse trade than
 * trusting one named authority for one named directory.
 *
 * Stored as PEM and nothing else. Everything shown about a pinned certificate
 * is derived from the bytes on each read, so a record cannot claim a subject or
 * a fingerprint that its certificate does not have.
 */
function cleanPemList(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const raw of value) {
        if (typeof raw !== 'string') continue;
        const pem = raw.trim();
        if (!pem || pem.length > MAX_PEM_LEN) continue;
        if (!pem.startsWith('-----BEGIN CERTIFICATE-----')) continue;
        if (!pem.includes('-----END CERTIFICATE-----')) continue;
        if (out.includes(pem)) continue;
        out.push(pem);
        if (out.length >= MAX_PINNED) break;
    }
    return out;
}

/**
 * A pinned certificate as the settings page shows it.
 *
 * Read from the certificate itself rather than from anything stored alongside
 * it, so the fingerprint on screen is always the fingerprint of the authority
 * actually in use. A PEM that no longer parses is reported as such instead of
 * being hidden: an operator has to be able to see and remove it.
 */
function describePinned(pem) {
    try {
        const cert = new X509Certificate(pem);
        return {
            subject: String(cert.subject || '').replace(/\n/g, ', ').slice(0, 300),
            issuer: String(cert.issuer || '').replace(/\n/g, ', ').slice(0, 300),
            validFrom: cert.validFrom || '',
            validTo: cert.validTo || '',
            fingerprint256: cert.fingerprint256 || '',
            expired: Date.parse(cert.validTo) < Date.now(),
            usable: true
        };
    } catch (_) {
        return { subject: '', issuer: '', validFrom: '', validTo: '', fingerprint256: '', expired: false, usable: false };
    }
}

function storeFile(tenantPaths) {
    return path.join(projectStore.deployRoot(tenantPaths), 'auth.json');
}

function readRaw(tenantPaths) {
    try {
        const parsed = JSON.parse(fs.readFileSync(storeFile(tenantPaths), 'utf8'));
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (_) {
        return {};   // no file yet is the normal unconfigured state
    }
}

function writeRaw(tenantPaths, obj) {
    fs.mkdirSync(projectStore.deployRoot(tenantPaths), { recursive: true });
    // Write-then-rename like machineStore and projectStore: a crash mid-write
    // must not leave a truncated file, which would read back as "no directory"
    // and, on a protected site, turn into a refusal nobody can explain.
    // 0o600 because this file carries the bind password, even encrypted.
    const tmp = storeFile(tenantPaths) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, storeFile(tenantPaths));
}

function str(value, fallback) {
    if (value === undefined || value === null) return fallback === undefined ? '' : fallback;
    return String(value);
}

/**
 * The directory config with the bind password in clear, or null when nothing
 * usable is stored.
 *
 * Only the caller that is about to open a socket should call this. Everything
 * that ends up in a browser goes through `publicConfig`.
 */
function readConfig(tenantPaths) {
    const raw = readRaw(tenantPaths);
    const url = str(raw.url).trim();
    const baseDn = str(raw.baseDn).trim();
    // Fail closed: no URL or no base DN is not a directory, and half of one is
    // worse than none because it looks configured on the settings page.
    if (!url || !baseDn) return null;

    return {
        url,
        startTls: raw.startTls === true,
        rejectUnauthorized: raw.rejectUnauthorized !== false,
        bindDn: str(raw.bindDn).trim(),
        bindPassword: raw.bindPasswordEnc ? (machineStore.decrypt(raw.bindPasswordEnc) || '') : '',
        baseDn,
        userFilter: str(raw.userFilter).trim() || DEFAULT_USER_FILTER,
        userDnTemplate: str(raw.userDnTemplate).trim(),
        groupAttribute: str(raw.groupAttribute).trim() || DEFAULT_GROUP_ATTR,
        nestedGroups: raw.nestedGroups === true,
        trustedCa: cleanPemList(raw.trustedCa),
        revalidateMinutes: revalidateMinutes(raw.revalidateMinutes),
        timeoutMs: Number(raw.timeoutMs) > 0 ? Number(raw.timeoutMs) : DEFAULT_TIMEOUT_MS
    };
}

/**
 * How often a live session is re-checked against the directory, in minutes.
 *
 * 0 is a real setting and means never, which is the behaviour before this
 * existed. The floor of 1 exists because a value like 0.01 would put a search
 * on the DC in front of most requests to the site.
 */
function revalidateMinutes(value) {
    if (value === undefined || value === null || value === '') return DEFAULT_REVALIDATE_MINUTES;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_REVALIDATE_MINUTES;
    if (n === 0) return 0;
    return Math.max(1, Math.min(1440, Math.floor(n)));
}

/**
 * Safe to send to a browser: never the password, only whether one is stored.
 *
 * `configured` answers the question the settings page actually asks, which is
 * "would a login attempt reach a directory", and that is exactly the condition
 * `readConfig` fails closed on.
 */
function publicConfig(tenantPaths) {
    const raw = readRaw(tenantPaths);
    return {
        configured: readConfig(tenantPaths) !== null,
        url: str(raw.url),
        startTls: raw.startTls === true,
        rejectUnauthorized: raw.rejectUnauthorized !== false,
        bindDn: str(raw.bindDn),
        hasPassword: Boolean(raw.bindPasswordEnc),
        baseDn: str(raw.baseDn),
        userFilter: str(raw.userFilter) || DEFAULT_USER_FILTER,
        userDnTemplate: str(raw.userDnTemplate),
        groupAttribute: str(raw.groupAttribute) || DEFAULT_GROUP_ATTR,
        nestedGroups: raw.nestedGroups === true,
        // The PEM itself is not sent. The page only ever needs to name what is
        // trusted and offer to remove it, and a certificate is public but there
        // is no reason for it to travel where it is not read.
        trustedCa: cleanPemList(raw.trustedCa).map(describePinned),
        revalidateMinutes: revalidateMinutes(raw.revalidateMinutes),
        updatedAt: raw.updatedAt || null
    };
}

/**
 * Merges `next` over what is stored and returns the browser-safe view.
 *
 * The password rule follows the SMTP settings precedent in `server.js`: a body
 * that omits `bindPassword` keeps the stored one, because the settings form
 * shows a mask and cannot send back what it never received. An explicit empty
 * string is the only way to erase it, and it has to stay explicit or the
 * operator could never clear a service account.
 */
function writeConfig(tenantPaths, next) {
    const cur = readRaw(tenantPaths);
    const src = next && typeof next === 'object' ? next : {};

    const rec = {
        url: str(src.url, str(cur.url)).trim(),
        startTls: src.startTls === undefined ? cur.startTls === true : src.startTls === true,
        rejectUnauthorized: src.rejectUnauthorized === undefined
            ? cur.rejectUnauthorized !== false
            : src.rejectUnauthorized !== false,
        bindDn: str(src.bindDn, str(cur.bindDn)).trim(),
        bindPasswordEnc: cur.bindPasswordEnc || null,
        baseDn: str(src.baseDn, str(cur.baseDn)).trim(),
        userFilter: str(src.userFilter, str(cur.userFilter)).trim() || DEFAULT_USER_FILTER,
        userDnTemplate: str(src.userDnTemplate, str(cur.userDnTemplate)).trim(),
        groupAttribute: str(src.groupAttribute, str(cur.groupAttribute)).trim() || DEFAULT_GROUP_ATTR,
        // Default off, and it stays off through every write that does not
        // mention it: resolving nesting only adds groups, so switching it on is
        // always a widening of who may open a protected site.
        nestedGroups: src.nestedGroups === undefined
            ? cur.nestedGroups === true
            : src.nestedGroups === true,
        // Kept through every save that does not mention it. The settings form
        // never sends this field, and a saved typo in the base DN must not
        // silently drop the authority that makes the connection work.
        trustedCa: cleanPemList(src.trustedCa === undefined ? cur.trustedCa : src.trustedCa),
        revalidateMinutes: revalidateMinutes(
            src.revalidateMinutes === undefined ? cur.revalidateMinutes : src.revalidateMinutes),
        timeoutMs: Number(src.timeoutMs) > 0 ? Number(src.timeoutMs)
            : (Number(cur.timeoutMs) > 0 ? Number(cur.timeoutMs) : DEFAULT_TIMEOUT_MS),
        updatedAt: Date.now()
    };

    if (src.bindPassword !== undefined) {
        const pw = String(src.bindPassword);
        rec.bindPasswordEnc = pw === '' ? null : machineStore.encrypt(pw);
    }

    writeRaw(tenantPaths, rec);
    return publicConfig(tenantPaths);
}

/**
 * Pins one more authority, and returns the browser-safe view.
 *
 * Idempotent: pinning the same certificate twice leaves one entry, because the
 * operator pressing the button again after a failed test should not fill the
 * store with copies.
 */
function trustAuthority(tenantPaths, pem) {
    const cur = readRaw(tenantPaths);
    const next = cleanPemList([String(pem || '')]);
    if (!next.length) return null;
    return writeConfig(tenantPaths, { trustedCa: cleanPemList(next.concat(cleanPemList(cur.trustedCa))) });
}

/** Un-pins everything. Validation then falls back to the machine trust store. */
function forgetAuthorities(tenantPaths) {
    return writeConfig(tenantPaths, { trustedCa: [] });
}

/** Removes the directory entirely. Any protected site then refuses, by design. */
function clearConfig(tenantPaths) {
    try {
        fs.unlinkSync(storeFile(tenantPaths));
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }
}

module.exports = {
    readConfig, publicConfig, writeConfig, clearConfig,
    trustAuthority, forgetAuthorities, describePinned, cleanPemList,
    DEFAULT_USER_FILTER, DEFAULT_GROUP_ATTR, DEFAULT_REVALIDATE_MINUTES,
    storeFile
};
