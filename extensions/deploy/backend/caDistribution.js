/**
 * Puts the tenant's certificate authorities on every domain machine, by group
 * policy, and keeps them in step through a rotation.
 *
 * Off until a tenant administrator turns it on: trusting an authority on every
 * machine of the domain is a decision, because whoever holds its key can then
 * stand in for any web site on those machines. Once on, it is automatic:
 * `publish` hands the trust bundle (`selfSignedCert.trustBundle`) to core's
 * `trustedRoot` capability, which queues one signed task for the agent of a
 * domain controller; that task makes the GPO SEC-TrustedRoot-DeployCA hold
 * exactly those authorities and links it at the domain root.
 *
 * The record (`certs/ca/distribution.json`) remembers when each authority was
 * first confirmed in the GPO. The rotation waits on that (`overlapSince`): a
 * successor signs nothing until machines have had time to apply the policy.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const selfSignedCert = require('./selfSignedCert');

/** The GPO is SEC-TrustedRoot-<TOPIC>. */
const TOPIC = 'DeployCA';
/** An unchanged bundle is published again this often, to repair a hand edit. */
const REPUBLISH_MS = 7 * 24 * 3600 * 1000;
const THUMB_RE = /^[0-9A-F]{40}$/;

function file(tenantPaths) {
    return path.join(selfSignedCert.certsDir(tenantPaths), 'ca', 'distribution.json');
}

function read(tenantPaths) {
    try {
        const s = JSON.parse(fs.readFileSync(file(tenantPaths), 'utf8'));
        if (s && typeof s === 'object') {
            s.confirmed = s.confirmed && typeof s.confirmed === 'object' ? s.confirmed : {};
            s.published = Array.isArray(s.published) ? s.published : [];
            return s;
        }
    } catch (_) { /* none yet */ }
    return { enabled: false, confirmed: {}, published: [] };
}

function write(tenantPaths, s) {
    fs.mkdirSync(path.dirname(file(tenantPaths)), { recursive: true });
    fs.writeFileSync(file(tenantPaths), JSON.stringify(s, null, 2), 'utf8');
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Records the outcome of the run last queued, when it has one. A run the
 * agent completed confirms its authorities; `confirmed` keeps the first time
 * each one was seen in the GPO and forgets the ones no longer there.
 */
function refresh(slug, tenantPaths, trustedRoot, now = Date.now()) {
    const s = read(tenantPaths);
    if (!trustedRoot || !s.lastRunId || s.lastStatus !== 'queued') return s;
    const st = trustedRoot.status(slug, s.lastRunId);
    if (st.status === 'queued') return s;
    if (st.status === 'done') {
        s.lastStatus = 'done';
        s.lastMessage = null;
        s.published = (s.lastThumbs || []).slice();
        s.publishedAt = now;
        const confirmed = {};
        for (const t of s.published) confirmed[t] = s.confirmed[t] || now;
        s.confirmed = confirmed;
    } else {
        s.lastStatus = st.status === 'failed' ? 'failed' : 'lost';
        s.lastMessage = st.message || null;
    }
    write(tenantPaths, s);
    return s;
}

/**
 * Publishes the trust bundle when it changed, when the last run did not
 * succeed, when `force`, or once a week. Resolves the record's view.
 */
async function publish(slug, tenantPaths, trustedRoot, { now = Date.now(), force = false } = {}) {
    const s = refresh(slug, tenantPaths, trustedRoot, now);
    if (!s.enabled || !trustedRoot) return view(tenantPaths, trustedRoot, now);
    if (s.lastStatus === 'queued') return view(tenantPaths, trustedRoot, now);

    const bundle = selfSignedCert.trustBundle(tenantPaths, now);
    const thumbs = bundle.map((c) => c.thumbprint);
    const fresh = s.lastStatus === 'done' && sameSet(thumbs, s.published) && now - (s.publishedAt || 0) < REPUBLISH_MS;
    if (fresh && !force) return view(tenantPaths, trustedRoot, now);

    const forget = [...new Set([...(s.published || []), ...(s.lastThumbs || [])])]
        .filter((t) => THUMB_RE.test(t) && !thumbs.includes(t));
    const r = await trustedRoot.publish(slug, {
        topic: TOPIC,
        certificates: bundle.map((c) => ({ der: c.der, thumbprint: c.thumbprint })),
        forget
    });
    s.lastAttemptAt = now;
    if (r.status === 'queued' || r.status === 'pending') {
        s.lastRunId = r.runId;
        s.lastStatus = 'queued';
        s.lastThumbs = thumbs;
        s.lastHost = r.host || null;
        s.lastMessage = null;
    } else {
        s.lastStatus = r.status;
        s.lastMessage = r.error || null;
    }
    write(tenantPaths, s);
    return view(tenantPaths, trustedRoot, now);
}

/** Turns distribution on or off. Turning it off leaves the GPO as it is. */
function setEnabled(tenantPaths, enabled, by, now = Date.now()) {
    const s = read(tenantPaths);
    s.enabled = enabled === true;
    s.changedBy = by || null;
    s.changedAt = now;
    write(tenantPaths, s);
    return s;
}

/**
 * For the rotation: when the authority `thumbprint` was first confirmed in
 * the GPO. `undefined` while distribution is off (the rotation then counts
 * from when the successor was made), `Infinity` while it is on and unconfirmed.
 */
function overlapSince(tenantPaths) {
    const s = read(tenantPaths);
    if (!s.enabled) return undefined;
    return (thumbprint) => (s.confirmed[thumbprint] || Infinity);
}

/** What the page shows. */
function view(tenantPaths, trustedRoot, now = Date.now()) {
    const s = read(tenantPaths);
    return {
        available: !!trustedRoot,
        enabled: !!s.enabled,
        gpoName: `SEC-TrustedRoot-${TOPIC}`,
        status: s.lastStatus || null,
        message: s.lastMessage || null,
        host: s.lastHost || null,
        attemptedAt: s.lastAttemptAt ? new Date(s.lastAttemptAt).toISOString() : null,
        publishedAt: s.publishedAt ? new Date(s.publishedAt).toISOString() : null,
        published: s.published,
        confirmed: Object.fromEntries(Object.entries(s.confirmed).map(([t, at]) => [t, new Date(at).toISOString()])),
        authorities: selfSignedCert.trustBundle(tenantPaths, now).map(({ der, ...rest }) => rest)
    };
}

module.exports = { publish, refresh, setEnabled, overlapSince, view, read, TOPIC, REPUBLISH_MS };
