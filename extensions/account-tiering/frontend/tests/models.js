/**
 * Hand-built models for the cases the real-backend fixture does not hold.
 * They follow the shape of `GET /api/account-tiering/model` as
 * fixtures/model.json records it; nothing here is read from a real directory.
 */
'use strict';

const D = 'S-1-5-21-7-7-7';
const sid = (rid) => `${D}-${rid}`;
const member = (from, to) => ({ from, to, type: 'membership', kind: 'membership', detail: { via: 'member' } });
const group = (rid, name, extra) => ({ sid: sid(rid), sam: name, name, dn: `CN=${name},OU=Groupes,DC=corp,DC=local`, tier: 0, broad: false, target: false, ...extra });
const scan = { domain: 'corp.local', domainSid: D, collectedAt: '2026-09-30T08:12:00Z', passes: 3, truncated: false, unreadable: [] };

/**
 * `n` accounts that all reach Tier 0 through one of ten groups nested in
 * Domain Admins. One in four is planned Tier 2, so it is a gap; the others are
 * planned Tier 0 and compliant.
 */
function bigModel(n) {
    const da = sid(512);
    const groups = [group(512, 'Admins du domaine', { target: true })];
    const links = [];
    for (let g = 0; g < 10; g += 1) {
        groups.push(group(1100 + g, `GG-Admins-${String(g).padStart(2, '0')}`));
        links.push(member(sid(1100 + g), da));
    }
    const accounts = [];
    for (let i = 0; i < n; i += 1) {
        const gap = i % 4 === 0;
        const mine = sid(1100 + (i % 10));
        const num = String(i).padStart(4, '0');
        links.push(member(sid(10000 + i), mine));
        accounts.push({
            sid: sid(10000 + i), sam: `compte-${num}`, name: `Compte ${num}`, dn: `CN=Compte ${num},OU=Utilisateurs,DC=corp,DC=local`,
            kind: 'user', enabled: true, planned: gap ? 2 : 0, plannedSource: { type: gap ? 'default' : 'rule', ruleId: 'r1' },
            effective: 0, status: gap ? 'gap' : 'ok', severity: gap ? 'critical' : null,
            path: [member(sid(10000 + i), mine), member(mine, da)], remediationProposed: false
        });
    }
    const gaps = accounts.filter((a) => a.status === 'gap').length;
    return {
        scan, accounts, groups, objects: [], links, chokepoints: [],
        matrix: [[n - gaps, 0, 0], [0, 0, 0], [gaps, 0, 0]], keyFigures: { accounts: n, chokepoints: 0 }, rulesCount: 1
    };
}

/**
 * Two holders of the same right, twice over. Nora Lambert sits in two groups
 * that each hold WriteDacl on AdminSDHolder; Omar Renaud sits in two groups
 * that can each edit the same GPO. Four links to cut, so four mechanisms and
 * four chokepoints, keyed as backend/analyze.js keys them.
 */
function twoHoldersModel() {
    const gpo = 'gpo:{bbbbbbbb-0000-0000-0000-000000000001}';
    const holderDn = 'CN=AdminSDHolder,CN=System,DC=corp,DC=local';
    const acl = (from) => ({ from, to: 'adminSdHolder', type: 'acl', kind: 'acl', detail: { right: 'WriteDacl', objectDn: holderDn, originDn: holderDn, inherited: false } });
    const edit = (from) => ({ from, to: gpo, type: 'gpoEdit', kind: 'gpoEdit', detail: { gpo: '{bbbbbbbb-0000-0000-0000-000000000001}' } });
    const account = (rid, sam, name, first, right) => ({
        sid: sid(rid), sam, name, dn: `CN=${name},OU=Utilisateurs,DC=corp,DC=local`, kind: 'user', enabled: true,
        planned: 2, plannedSource: { type: 'default' }, effective: 0, status: 'gap', severity: 'critical',
        path: [member(sid(rid), first), right], remediationProposed: false
    });
    const rights = [acl(sid(1201)), acl(sid(1202)), edit(sid(1203)), edit(sid(1204))];
    const point = (e, who) => ({
        key: `${e.kind}:${e.from}:${e.to}:${e.detail.right || ''}`, kind: e.kind, from: e.from, to: e.to, detail: e.detail,
        tier: 0, broad: false, exposed: [who], gaps: [who]
    });
    return {
        scan,
        accounts: [account(3001, 'n.lambert', 'Nora Lambert', sid(1201), rights[0]), account(3002, 'o.renaud', 'Omar Renaud', sid(1203), rights[2])],
        groups: [group(1201, 'GG-Exploitation'), group(1202, 'GG-Support-N2'), group(1203, 'GG-GPO-Siege'), group(1204, 'GG-GPO-Agences')],
        objects: [{ key: 'adminSdHolder', label: 'AdminSDHolder', tier: 0 }, { key: gpo, label: 'Politique du domaine', tier: 0 }],
        links: [
            member(sid(3001), sid(1201)), member(sid(3001), sid(1202)), member(sid(3002), sid(1203)), member(sid(3002), sid(1204)), ...rights
        ],
        chokepoints: rights.map((e, i) => point(e, sid(i < 2 ? 3001 : 3002))),
        matrix: [[0, 0, 0], [0, 0, 0], [2, 0, 0]], keyFigures: { accounts: 2, chokepoints: 4 }, rulesCount: 1
    };
}

module.exports = { bigModel, twoHoldersModel, sid };
