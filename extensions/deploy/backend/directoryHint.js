/**
 * What Aegis already knows about the directory, offered to the authentication
 * form so the operator does not retype it.
 *
 * The premise: this product audits an Active Directory domain. By the time
 * somebody protects a deployed site with that same directory, the domain name
 * has already been typed once, into the audit. Asking for it again is asking
 * for a typo -- and a typo in the search base is a refusal with no visible
 * cause.
 *
 * Two sources, in this order:
 *   1. The newest audit of this tenant. It names the domain that was audited,
 *      which is the domain this tenant's users live in.
 *   2. The Aegis host's own domain, from the environment. A domain-joined
 *      server is the normal deployment, and this covers the install where the
 *      first audit has not run yet.
 *
 * Everything returned is a suggestion. Nothing here is written, nothing is
 * saved, and the caller fills empty fields only: an operator who typed a
 * deliberate value never has it overwritten by a guess.
 *
 * Deliberately not derived: the bind account and its password (nobody can guess
 * those), and the two checkboxes. `nestedGroups` decides who gets in, and a
 * scan that quietly widens an access rule is the wrong kind of helpful.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const dns = require('node:dns').promises;

const authStore = require('./authStore');

/** `corp.local` -> `DC=corp,DC=local`. Empty for anything not dotted-name. */
function baseDnFor(domain) {
    const parts = String(domain || '').split('.').filter(Boolean);
    if (!parts.length) return '';
    return parts.map((p) => 'DC=' + p).join(',');
}

/**
 * A DNS domain name, or ''. Kept strict because the value ends up inside an
 * LDAP URL and a distinguished name: only labels, dots between them, at least
 * two labels, and no wildcard of any kind.
 */
function cleanDomain(value) {
    const d = String(value || '').trim().toLowerCase().replace(/\.$/, '');
    if (!d || d.length > 253) return '';
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d) ? d : '';
}

/** The domain named by the newest audit on disk, or ''. */
function auditedDomain(auditsDir) {
    let entries;
    try {
        entries = fs.readdirSync(auditsDir, { withFileTypes: true });
    } catch (_) {
        return '';                       // no audit has ever run here
    }

    const dirs = [];
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const file = path.join(auditsDir, e.name, 'audit_results.json');
        try {
            dirs.push({ file, at: fs.statSync(file).mtimeMs });
        } catch (_) { /* a directory with no report is not an audit */ }
    }
    // By modification time, not by name: the folder name carries a French date
    // (`audit(20.08.2026_15h00)`) that does not sort.
    dirs.sort((a, b) => b.at - a.at);

    for (const d of dirs) {
        let report;
        try {
            // The BOM is Shield's, from PowerShell's UTF-8 writer. JSON.parse
            // refuses it.
            report = JSON.parse(fs.readFileSync(d.file, 'utf8').replace(/^\uFEFF/, ''));
        } catch (_) {
            continue;                    // truncated or mid-write; try the one before
        }
        const named = cleanDomain(
            (report && report.Summary && report.Summary.DomainName)
            || (report && report.Metadata && report.Metadata.TargetDomain)
        );
        if (named) return named;
    }
    return '';
}

/**
 * The fields to offer, or null when nothing is known.
 *
 * `ldaps://` on purpose. A bind password crosses this connection, and the form
 * is the wrong place to learn that plain LDAP was good enough -- an operator
 * whose controller has no certificate finds out from the Test button and
 * downgrades on purpose, which is the right order.
 */
function suggest(tenantPaths) {
    const fromAudit = auditedDomain(tenantPaths.audits);
    const domain = fromAudit || cleanDomain(process.env.USERDNSDOMAIN);
    if (!domain) return null;

    return {
        source: fromAudit ? 'audit' : 'host',
        domain,
        fields: {
            url: 'ldaps://' + domain + ':636',
            baseDn: baseDnFor(domain),
            userDnTemplate: '{username}@' + domain,
            userFilter: authStore.DEFAULT_USER_FILTER,
            groupAttribute: authStore.DEFAULT_GROUP_ATTR
        }
    };
}

/** DNS is not allowed to hold up a form. Past this, the domain name is the answer. */
const SRV_TIMEOUT_MS = 2500;

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            const t = setTimeout(() => reject(new Error('dns timeout')), ms);
            if (typeof t.unref === 'function') t.unref();
        })
    ]);
}

/**
 * The host name of a domain controller, asked of DNS the way a domain member
 * asks.
 *
 * This is the fix for the most common TLS failure on this form, and it is a
 * naming problem rather than a trust one. `ldaps://corp.local:636` reaches a
 * controller -- the domain name resolves to all of them -- but the certificate
 * that controller presents is issued for `dc01.corp.local`, so the handshake
 * fails on the name and the operator is told to go and install a certificate
 * authority, which would not have helped. Every Active Directory publishes
 * `_ldap._tcp.dc._msdcs.<domain>`, so the right name is one query away.
 *
 * Port 636 regardless of what the record says. The SRV record advertises plain
 * LDAP on 389; LDAPS has no record of its own and lives on 636 by convention,
 * and a password crosses this connection.
 *
 * Any failure returns null and the caller keeps the domain name. A form that
 * waited on DNS, or refused to fill itself because a resolver was slow, would
 * be worse than one suggestion that needs correcting.
 */
async function discoverController(domain) {
    const d = cleanDomain(domain);
    if (!d) return null;
    let records;
    try {
        records = await withTimeout(dns.resolveSrv('_ldap._tcp.dc._msdcs.' + d), SRV_TIMEOUT_MS);
    } catch (_) {
        return null;
    }
    if (!Array.isArray(records) || !records.length) return null;

    // RFC 2782 order: lowest priority first, then the heaviest weight. Not a
    // load-balancing decision -- we pick one name and stop -- but taking the
    // record the domain says to prefer beats taking whichever answered first.
    const sorted = records
        .filter((r) => r && typeof r.name === 'string' && cleanDomain(r.name))
        .sort((a, b) => (a.priority - b.priority) || (b.weight - a.weight));
    if (!sorted.length) return null;

    const host = cleanDomain(sorted[0].name);
    return { host, port: 636, count: sorted.length };
}

module.exports = { suggest, baseDnFor, cleanDomain, auditedDomain, discoverController };
