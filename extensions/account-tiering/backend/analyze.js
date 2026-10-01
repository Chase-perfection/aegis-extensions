/**
 * Facts plus planned tiers in, the model the page draws out.
 *
 * The facts are a graph. Every mechanism is an edge from the principal that
 * holds it to the thing it controls: a member to its group, an ACE trustee to
 * the object, a GPO editor to the GPO, a GPO's local-group member to the
 * machines it lands on. A few nodes start with a tier (the Tier 0 groups, the
 * domain root, AdminSDHolder, the Domain Controllers OU, each GPO by where it
 * is linked). Then the rule "whoever controls a tier-N thing is tier N" runs to
 * a fixed point. Tiers only go down and there are three, so it ends fast.
 *
 * For each node the edge that last lowered its tier is kept. Following those
 * edges from an account back to a seed is the "why Tier N" path the page shows,
 * intermediate groups included.
 *
 * Two families of trustee get special handling:
 * - ignored (SYSTEM, Enterprise DCs, SELF, CREATOR OWNER), and any trustee
 *   already Tier 0 by membership alone: their ACEs are dropped, otherwise every
 *   path would run through Domain Admins' own rights;
 * - broad (Everyone, Authenticated Users, Domain Users...): kept as one node
 *   each and listed first among the chokepoints, never pushed onto accounts,
 *   because the collector does not read the unprivileged accounts they cover.
 *
 * Nothing here reads a clock, a file or the network: same input, same model.
 */

'use strict';

const { targetSids, broadSids, IGNORED, LOCAL_GROUPS } = require('./sids');

const SCHEMA = 1;
const INF = 3;

const ACL_RIGHTS = new Set(['GenericAll', 'GenericWrite', 'WriteDacl', 'WriteOwner', 'ResetPassword', 'WriteMember']);
const ROOT_RIGHTS = new Set(['GenericAll', 'WriteDacl', 'WriteOwner']);
const DCSYNC_HALVES = ['DCSyncGetChanges', 'DCSyncGetChangesAll'];

const ACCOUNT_KINDS = new Set(['user', 'computer', 'gmsa']);

function factsError(message) {
    const error = new Error(message);
    error.code = 'facts_schema';
    return error;
}

function rootDnOf(domain) {
    return 'DC=' + String(domain).split('.').join(',DC=');
}

function sameDn(a, b) {
    return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function guidFromDn(dn) {
    const match = /CN=(\{[0-9a-f-]{36}\})/i.exec(String(dn || ''));
    return match ? match[1].toLowerCase() : null;
}

/** Most privileged class of machine a link reaches: DC 0, server 1, workstation 2. */
function linkTier(link) {
    const c = link.computers || {};
    if (c.dc > 0) return 0;
    if (c.server > 0) return 1;
    if (c.workstation > 0) return 2;
    return INF;
}

function analyze(facts, planned, options = {}) {
    if (!facts || facts.schema !== SCHEMA) throw factsError(`unknown facts schema ${facts && facts.schema}`);
    const proposed = options.remediations || new Set();

    const principals = new Map((facts.principals || []).map((p) => [p.sid, p]));
    const targets = targetSids(facts.domainSid);
    for (const p of principals.values()) {
        // DnsAdmins has no fixed RID, so the collector finds it by name.
        if (p.kind === 'group' && String(p.sam).toLowerCase() === 'dnsadmins') targets.add(p.sid);
    }
    const broad = broadSids(facts.domainSid);
    const rootDn = rootDnOf(facts.domain);
    const dcOuDn = 'OU=Domain Controllers,' + rootDn;

    const seeds = new Map();
    const labels = new Map([['root', facts.domain], ['adminSdHolder', 'AdminSDHolder'], ['dcOu', 'Domain Controllers']]);
    for (const sid of targets) seeds.set(sid, 0);
    for (const key of ['root', 'adminSdHolder', 'dcOu']) seeds.set(key, 0);

    const gpos = new Map();
    for (const gpo of facts.gpos || []) {
        const guid = String(gpo.guid).toLowerCase();
        gpos.set(guid, gpo);
        const local = Math.min(INF, ...(gpo.links || []).map(linkTier));
        const top = (gpo.links || []).some((l) => sameDn(l.somDn, rootDn) || sameDn(l.somDn, dcOuDn));
        seeds.set('gpo:' + guid, top ? 0 : local);
        seeds.set('gpolocal:' + guid, local);
        labels.set('gpo:' + guid, gpo.name);
        labels.set('gpolocal:' + guid, gpo.name);
    }

    const membershipEdges = (facts.memberships || []).map((m) => ({
        from: m.member, to: m.group, kind: 'membership', detail: { via: m.via }
    }));

    // Tier 0 by membership alone, to know whose ACEs to drop.
    const byMembership = fixedPoint(seeds, membershipEdges).tier;

    const controlEdges = [];
    const dcsync = new Map();
    for (const ace of facts.aces || []) {
        const trustee = ace.trustee;
        if (IGNORED.has(trustee) || byMembership.get(trustee) === 0) continue;
        if (DCSYNC_HALVES.includes(ace.right)) {
            if (ace.objectKind !== 'domainRoot') continue;
            if (!dcsync.has(trustee)) dcsync.set(trustee, new Map());
            dcsync.get(trustee).set(ace.right, ace);
            continue;
        }
        if (!ACL_RIGHTS.has(ace.right)) continue;
        const to = aceTarget(ace);
        if (!to) continue;
        controlEdges.push({ from: trustee, to, kind: 'acl', detail: aceDetail(ace) });
    }
    for (const [trustee, halves] of dcsync) {
        if (DCSYNC_HALVES.every((h) => halves.has(h))) {
            controlEdges.push({
                from: trustee, to: 'root', kind: 'acl',
                detail: { right: 'DCSync', objectDn: rootDn, originDn: rootDn, inherited: false }
            });
        }
    }
    for (const [guid, gpo] of gpos) {
        for (const editor of gpo.editors || []) {
            if (IGNORED.has(editor) || byMembership.get(editor) === 0) continue;
            controlEdges.push({ from: editor, to: 'gpo:' + guid, kind: 'gpoEdit', detail: { gpo: guid } });
        }
        for (const lg of gpo.localGroups || []) {
            if (!LOCAL_GROUPS.has(lg.localGroup)) continue;
            for (const member of lg.members || []) {
                controlEdges.push({
                    from: member, to: 'gpolocal:' + guid, kind: 'gpoLocal',
                    detail: { gpo: guid, localGroup: lg.localGroup, source: lg.source }
                });
            }
        }
    }

    const edges = [...membershipEdges, ...controlEdges];
    const { tier, best } = fixedPoint(seeds, edges);

    const accounts = [];
    for (const p of principals.values()) {
        if (!ACCOUNT_KINDS.has(p.kind)) continue;
        const effective = tier.has(p.sid) && tier.get(p.sid) < INF ? tier.get(p.sid) : 2;
        const plan = planned.get(p.sid) || { tier: 2, source: { type: 'default' } };
        accounts.push({
            sid: p.sid, sam: p.sam, name: p.name, dn: p.dn, kind: p.kind, enabled: p.enabled,
            planned: plan.tier, plannedSource: plan.source, effective,
            ...status(effective, plan.tier),
            path: pathOf(p.sid, best),
            remediationProposed: proposed.has(p.sid)
        });
    }
    accounts.sort((a, b) => a.effective - b.effective || String(a.sam).localeCompare(String(b.sam)));

    const groups = [...principals.values()]
        .filter((p) => p.kind === 'group')
        .map((p) => ({ sid: p.sid, sam: p.sam, name: p.name, dn: p.dn, tier: tierOr(tier, p.sid), broad: broad.has(p.sid) }));

    const objects = [...labels.entries()].map(([key, label]) => ({ key, label, tier: tierOr(tier, key) }));

    const links = edges.map((e) => ({
        from: e.from, to: e.to,
        type: e.kind === 'membership' ? 'membership' : (e.kind === 'acl' ? 'acl' : 'gpo'),
        kind: e.kind, detail: e.detail
    }));

    const tier2 = facts.tier2Totals || { users: 0, computers: 0 };
    const uncollected = (tier2.users || 0) + (tier2.computers || 0);
    const matrix = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const a of accounts) matrix[a.planned][a.effective] += 1;
    matrix[2][2] += uncollected;

    const chokepoints = chokepointsOf(accounts, edges, tier, broad);

    return {
        scan: {
            domain: facts.domain, domainSid: facts.domainSid, collectedAt: facts.collectedAt,
            passes: facts.passes, truncated: Boolean(facts.truncated), unreadable: facts.unreadable || []
        },
        accounts, groups, objects, links, chokepoints, matrix,
        keyFigures: {
            accounts: accounts.length + uncollected,
            byEffective: [0, 1, 2].map((t) => accounts.filter((a) => a.effective === t).length + (t === 2 ? uncollected : 0)),
            gapsCritical: accounts.filter((a) => a.severity === 'critical').length,
            gapsHigh: accounts.filter((a) => a.severity === 'high').length,
            chokepoints: chokepoints.length
        }
    };

    function aceTarget(ace) {
        switch (ace.objectKind) {
            case 'domainRoot': return ROOT_RIGHTS.has(ace.right) ? 'root' : null;
            case 'adminSdHolder': return 'adminSdHolder';
            case 'dcOu': return 'dcOu';
            case 'gpo': {
                const guid = guidFromDn(ace.objectDn);
                return guid && gpos.has(guid) ? 'gpo:' + guid : null;
            }
            case 'group':
            case 'account': return ace.objectSid || null;
            default: return null;
        }
    }
}

function aceDetail(ace) {
    return { right: ace.right, objectDn: ace.objectDn, originDn: ace.originDn || ace.objectDn, inherited: Boolean(ace.inherited) };
}

function tierOr(tier, key) {
    return tier.has(key) && tier.get(key) < INF ? tier.get(key) : null;
}

function status(effective, planned) {
    if (effective < planned) return { status: 'gap', severity: effective === 0 ? 'critical' : 'high' };
    if (effective > planned) return { status: 'below', severity: null };
    return { status: 'ok', severity: null };
}

/** Whoever controls a tier-N node becomes tier N, until nothing moves. */
function fixedPoint(seeds, edges) {
    const tier = new Map(seeds);
    const best = new Map();
    let changed = true;
    while (changed) {
        changed = false;
        for (const edge of edges) {
            const reach = tier.has(edge.to) ? tier.get(edge.to) : INF;
            const own = tier.has(edge.from) ? tier.get(edge.from) : INF;
            if (reach < own) {
                tier.set(edge.from, reach);
                best.set(edge.from, edge);
                changed = true;
            }
        }
    }
    return { tier, best };
}

function pathOf(sid, best) {
    const path = [];
    const seen = new Set([sid]);
    let edge = best.get(sid);
    while (edge && !seen.has(edge.to)) {
        path.push({ from: edge.from, to: edge.to, kind: edge.kind, detail: edge.detail });
        seen.add(edge.to);
        edge = best.get(edge.to);
    }
    return path;
}

function chokepointKey(edge) {
    if (edge.kind === 'membership') return 'group:' + edge.to;
    return `${edge.kind}:${edge.from}:${edge.to}:${edge.detail.right || edge.detail.localGroup || ''}`;
}

function chokepointsOf(accounts, edges, tier, broad) {
    const points = new Map();
    const touch = (edge, broadPoint) => {
        const key = chokepointKey(edge);
        if (!points.has(key)) {
            points.set(key, {
                key, kind: edge.kind, from: edge.from, to: edge.to, detail: edge.detail,
                tier: tierOr(tier, edge.to), broad: broadPoint, exposed: new Set(), gaps: new Set()
            });
        }
        return points.get(key);
    };
    for (const a of accounts) {
        for (const edge of a.path) {
            const point = touch(edge, false);
            point.exposed.add(a.sid);
            if (a.status === 'gap') point.gaps.add(a.sid);
        }
    }
    for (const edge of edges) {
        if (edge.kind !== 'membership' && broad.has(edge.from) && tierOr(tier, edge.to) !== null) touch(edge, true).broad = true;
    }
    return [...points.values()]
        .map((p) => ({ ...p, exposed: [...p.exposed], gaps: [...p.gaps] }))
        .sort((a, b) => (b.broad - a.broad) || (b.gaps.length - a.gaps.length)
            || (b.exposed.length - a.exposed.length) || a.key.localeCompare(b.key));
}

module.exports = { analyze, SCHEMA };
