/**
 * GitHub webhook verification.
 *
 * This endpoint is the one part of Aegis that answers unauthenticated POST
 * requests from the internet, on a domain-joined server. Everything here runs
 * before a single field of the payload is parsed, and nothing here trusts a
 * value from the request other than to compare it against a secret we hold.
 *
 * Kept separate from routes.js so it can be tested without an Express app.
 */

'use strict';

const crypto = require('crypto');

/** Bodies above this are refused unread. GitHub push payloads sit well under. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Constant-time check of `X-Hub-Signature-256` over the raw request bytes.
 *
 * The raw bytes matter: `JSON.parse` then `JSON.stringify` does not reproduce
 * them, so a signature computed over a re-serialised object fails for reasons
 * that look random. `server.js` already keeps `req.rawBody` for agent HMAC
 * verification, and this reuses it.
 *
 * `timingSafeEqual` throws on a length mismatch, so the lengths get compared
 * first. That comparison leaks only the length of a hex digest, which is fixed.
 */
function verifySignature(rawBody, signatureHeader, secret) {
    if (!secret || !signatureHeader || !rawBody) return false;
    if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) return false;

    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * Remembers delivery ids so a GitHub redelivery does not build twice.
 *
 * In memory, because a duplicate build after a restart is a wasted build rather
 * than a correctness problem, and a table read on every webhook is a cost paid
 * on the hot path for a case that happens rarely. The plan's
 * `webhook_deliveries` table replaces this when deployments become durable.
 */
function createDeliveryCache({ ttlMs = 24 * 60 * 60 * 1000, max = 5000 } = {}) {
    const seen = new Map();

    function expire(now) {
        for (const [id, ts] of seen) {
            if (now - ts > ttlMs) seen.delete(id);
            else break;  // Map preserves insertion order, so the rest are newer
        }
    }

    return {
        /** True the first time an id is seen, false on a redelivery. */
        claim(deliveryId, now = Date.now()) {
            if (!deliveryId) return true;  // no id to dedup on, let it through
            expire(now);
            if (seen.has(deliveryId)) return false;
            seen.set(deliveryId, now);
            // Capped after the insert, not before: capping first leaves room for
            // exactly one more and the map settles at max + 1.
            while (seen.size > max) seen.delete(seen.keys().next().value);
            return true;
        },
        get size() { return seen.size; }
    };
}

/**
 * Reads the branch and head commit out of a `push` payload.
 *
 * Returns null for anything that is not a branch push with a commit: tag
 * pushes, branch deletions and the zero-sha that accompanies them. A caller
 * getting null should answer 202 and do nothing.
 */
function parsePush(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const ref = typeof payload.ref === 'string' ? payload.ref : '';
    if (!ref.startsWith('refs/heads/')) return null;
    if (payload.deleted === true) return null;

    const sha = typeof payload.after === 'string' ? payload.after : '';
    if (!/^[0-9a-f]{40}$/.test(sha) || /^0{40}$/.test(sha)) return null;

    const head = payload.head_commit || {};
    return {
        branch: ref.slice('refs/heads/'.length),
        sha,
        message: typeof head.message === 'string' ? head.message.split('\n')[0].slice(0, 500) : '',
        author: (head.author && typeof head.author.name === 'string') ? head.author.name : '',
        repoFullName: (payload.repository && typeof payload.repository.full_name === 'string')
            ? payload.repository.full_name : '',
        installationId: (payload.installation && Number.isInteger(payload.installation.id))
            ? payload.installation.id : null
    };
}

module.exports = { MAX_BODY_BYTES, verifySignature, createDeliveryCache, parsePush };
