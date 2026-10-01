/**
 * Builds a facts document for one test case.
 *
 * Every test reads as "this domain, plus these few objects". The domain is the
 * invented corp.local and its SID an invented one, so no fixture names a real
 * directory.
 */

'use strict';

const DOMAIN_SID = 'S-1-5-21-1000-2000-3000';
const sid = (rid) => `${DOMAIN_SID}-${rid}`;
const ROOT_DN = 'DC=corp,DC=local';

function user(rid, sam, extra = {}) {
    return { sid: sid(rid), dn: `CN=${sam},OU=Users,${ROOT_DN}`, sam, name: sam, kind: 'user', enabled: true, primaryGroupRid: 513, ...extra };
}

function group(rid, sam, extra = {}) {
    return { sid: sid(rid), dn: `CN=${sam},OU=Groups,${ROOT_DN}`, sam, name: sam, kind: 'group', enabled: true, ...extra };
}

function facts(parts = {}) {
    return {
        schema: 1,
        domain: 'corp.local',
        domainSid: DOMAIN_SID,
        collectedAt: '2026-10-01T08:00:00Z',
        passes: 3,
        truncated: false,
        principals: [group(512, 'Domain Admins'), ...(parts.principals || [])],
        memberships: parts.memberships || [],
        aces: parts.aces || [],
        gpos: parts.gpos || [],
        tier2Totals: parts.tier2Totals || { users: 0, computers: 0 },
        unreadable: parts.unreadable || [],
        ...(parts.extra || {})
    };
}

module.exports = { DOMAIN_SID, ROOT_DN, sid, user, group, facts };
