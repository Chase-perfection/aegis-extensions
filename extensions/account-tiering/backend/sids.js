/**
 * The SIDs the analysis gives a meaning to, and the one validator every route
 * uses on a SID it receives.
 *
 * Groups are named by SID and never by name: the hosts run French Windows, and
 * "Domain Admins" there is "Admins du domaine". A RID alone (512) is read after
 * the domain SID the facts carry.
 */

'use strict';

/** Domain groups that are Tier 0 by membership, as RIDs under the domain SID. */
const TARGET_RIDS = [512, 516, 518, 519, 520, 526, 527];

/** Builtin groups that are Tier 0 by membership. */
const BUILTIN_TARGETS = ['S-1-5-32-544', 'S-1-5-32-548', 'S-1-5-32-549', 'S-1-5-32-550', 'S-1-5-32-551'];

/** Trustees whose rights say nothing about an account: the system acting on itself. */
const IGNORED = new Set(['S-1-5-18', 'S-1-5-9', 'S-1-5-10', 'S-1-3-0']);

/** Trustees that stand for every account, never expanded into members. */
const BROAD_WELL_KNOWN = ['S-1-1-0', 'S-1-5-11', 'S-1-5-7', 'S-1-5-32-554'];
const BROAD_RIDS = [513, 515];

/** Local groups a GPO can fill that hand control of the machine. */
const LOCAL_GROUPS = new Set(['S-1-5-32-544', 'S-1-5-32-555', 'S-1-5-32-580']);

const WELL_KNOWN = new Set([
    ...BUILTIN_TARGETS, ...IGNORED, ...BROAD_WELL_KNOWN, ...LOCAL_GROUPS
]);

/**
 * A domain SID has exactly four sub-authorities after S-1-5-21. Each part is
 * capped at ten digits because a sub-authority is a 32-bit integer, and the
 * anchors keep a trailing newline or a path out of a route parameter.
 */
const DOMAIN_SID_RE = /^S-1-5-21-\d{1,10}-\d{1,10}-\d{1,10}-\d{1,10}$/;

function isSid(value) {
    return typeof value === 'string' && (DOMAIN_SID_RE.test(value) || WELL_KNOWN.has(value));
}

function targetSids(domainSid) {
    return new Set([...TARGET_RIDS.map((rid) => `${domainSid}-${rid}`), ...BUILTIN_TARGETS]);
}

function broadSids(domainSid) {
    return new Set([...BROAD_WELL_KNOWN, ...BROAD_RIDS.map((rid) => `${domainSid}-${rid}`)]);
}

module.exports = { isSid, targetSids, broadSids, IGNORED, LOCAL_GROUPS };
