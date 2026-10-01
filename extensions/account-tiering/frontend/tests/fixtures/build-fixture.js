/**
 * Builds `model.json`, the fixture the page tests run against, by running the
 * REAL account-tiering backend over an invented corp.local directory. The page
 * is therefore tested against the exact shape `GET /api/account-tiering/model`
 * returns, not a hand-written imitation of it.
 *
 * Run: node build-fixture.js   (AT_BACKEND overrides where the backend lives)
 *
 * The model is assembled by `buildModel()` in backend/routes.js, the function
 * the route itself calls: classify, analyze, one remediation per path link,
 * the override details, `rulesCount`. Nothing of that is copied here, so a
 * change in routes.js reaches the fixture on the next run.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BACKEND = process.env.AT_BACKEND || path.join(__dirname, '..', '..', '..', 'backend');

const { buildModel } = require(path.join(BACKEND, 'routes'));

const D = 'S-1-5-21-1000-2000-3000';
const sid = (rid) => `${D}-${rid}`;
const ROOT = 'DC=corp,DC=local';
const OU = {
    users: `OU=Utilisateurs,${ROOT}`,
    t0: `OU=Admins-T0,${ROOT}`,
    t1: `OU=Admins-T1,${ROOT}`,
    svc: `OU=Services,${ROOT}`,
    groups: `OU=Groupes,${ROOT}`
};

function user(rid, sam, name, ou, extra = {}) {
    return { sid: sid(rid), dn: `CN=${name},${ou}`, sam, name, kind: 'user', enabled: true, primaryGroupRid: 513, ...extra };
}
function group(rid, sam) {
    return { sid: sid(rid), dn: `CN=${sam},${OU.groups}`, sam, name: sam, kind: 'group', enabled: true };
}
const member = (g, m, via = 'member') => ({ group: g, member: m, via });

const APP_GROUPS = Array.from({ length: 10 }, (_, i) => 1110 + i);

const principals = [
    { ...group(512, 'Admins du domaine'), dn: `CN=Admins du domaine,CN=Users,${ROOT}` },
    { ...group(513, 'Utilisateurs du domaine'), dn: `CN=Utilisateurs du domaine,CN=Users,${ROOT}` },
    group(1101, 'GG-IT-Admins'),
    group(1102, 'GG-Server-Ops'),
    group(1103, 'GG-Support-Postes'),
    group(1104, 'GG-GPO-Editeurs'),
    group(1105, 'GG-Helpdesk'),
    ...APP_GROUPS.map((rid, i) => group(rid, `GG-App-${String(i + 1).padStart(2, '0')}`)),
    group(1120, 'GG-Projet-A'),
    group(1121, 'GG-Projet-B'),
    group(1122, 'GG-Cantine'),
    user(2001, 'a.martin', 'Alice Martin', OU.users),
    user(2002, 'adm-t0-rdubois', 'Romain Dubois (T0)', OU.t0),
    user(2003, 'svc-backup', 'Sauvegarde', OU.svc),
    user(2004, 'h.dupont', 'Hugo Dupont', OU.users),
    user(2005, 'p.leroy', 'Pierre Leroy', OU.users),
    user(2006, 'c.bernard', 'Claire Bernard', OU.users),
    user(2007, 'svc-sccm', 'Déploiement SCCM', OU.svc),
    user(2008, 'j.roux', 'Julie Roux', OU.users),
    user(2009, 'adm-t1-ngarcia', 'Nina Garcia (T1)', OU.t1),
    user(2010, 'm.petit', 'Marc Petit', OU.users),
    user(2011, 'adm-t0-ancien', 'Ancien admin', OU.t0),
    user(2012, 'l.fontaine', 'Léa Fontaine', OU.users),
    user(2013, 's.moreau', 'Sophie Moreau', OU.users),
    user(2014, 'x.garnier', "Xavier O'Garnier", OU.users, { primaryGroupRid: 512 }),
    { sid: sid(2015), dn: `CN=gmsa-sql,${OU.svc}`, sam: 'gmsa-sql$', name: 'gmsa-sql', kind: 'gmsa', enabled: true, primaryGroupRid: 515 }
];

const memberships = [
    member(sid(512), sid(1101)),             // IT-Admins nested in Domain Admins
    member(sid(1101), sid(2001)),
    member(sid(1120), sid(2001)),            // one unprivileged group for Alice
    member(sid(512), sid(2002)),             // the legitimate Tier 0 admin
    member(sid(1105), sid(2004)),
    member(sid(1105), sid(2012)),
    member(sid(1102), sid(2005)),
    member(sid(1102), sid(2009)),
    member(sid(1102), sid(2013)),
    member(sid(1103), sid(2006)),
    member(sid(1104), sid(2008)),
    ...APP_GROUPS.map((rid) => member(sid(rid), sid(2007))),
    member(sid(1121), sid(2007)),
    member(sid(1122), sid(2007)),
    member(sid(512), sid(2014), 'primaryGroup')
];

const rootAce = (trustee, right) => ({
    objectDn: ROOT, objectSid: null, objectKind: 'domainRoot', originDn: ROOT, trustee, right, inherited: false, pass: 1
});
const holderDn = `CN=AdminSDHolder,CN=System,${ROOT}`;

const aces = [
    rootAce(sid(2003), 'DCSyncGetChanges'),
    rootAce(sid(2003), 'DCSyncGetChangesAll'),
    {
        objectDn: `CN=Romain Dubois (T0),${OU.t0}`, objectSid: sid(2002), objectKind: 'account',
        originDn: OU.t0, trustee: sid(1105), right: 'ResetPassword', inherited: true, pass: 2
    },
    { objectDn: holderDn, objectSid: null, objectKind: 'adminSdHolder', originDn: holderDn, trustee: 'S-1-5-11', right: 'WriteDacl', inherited: false, pass: 1 }
];

const guid = (n) => `{aaaaaaaa-0000-0000-0000-00000000000${n}}`;
const gpos = [
    {
        guid: guid(1), name: 'Politique du domaine', editors: [sid(1104)],
        links: [{ somDn: ROOT, enforced: false, computers: { dc: 2, server: 20, workstation: 300 } }], localGroups: []
    },
    {
        guid: guid(2), name: 'Admins serveurs', editors: [],
        links: [{ somDn: `OU=Serveurs,${ROOT}`, enforced: false, computers: { dc: 0, server: 12, workstation: 0 } }],
        localGroups: [
            { localGroup: 'S-1-5-32-544', members: [sid(1102)], source: 'GptTmpl' },
            { localGroup: 'S-1-5-32-555', members: [sid(2015)], source: 'GroupsXml' }
        ]
    },
    {
        guid: guid(3), name: 'Admins postes', editors: [],
        links: [{ somDn: `OU=Postes,${ROOT}`, enforced: false, computers: { dc: 0, server: 0, workstation: 300 } }],
        localGroups: [{ localGroup: 'S-1-5-32-544', members: [sid(1103)], source: 'GroupsXml' }]
    },
    {
        guid: guid(4), name: 'Serveurs applicatifs', editors: [],
        links: [{ somDn: `OU=Serveurs-Applis,${ROOT}`, enforced: false, computers: { dc: 0, server: 8, workstation: 0 } }],
        localGroups: [{ localGroup: 'S-1-5-32-544', members: APP_GROUPS.map(sid), source: 'GptTmpl' }]
    }
];

const facts = {
    schema: 1, domain: 'corp.local', domainSid: D, netbios: 'CORP',
    collectedAt: '2026-09-30T08:12:00Z', passes: 3, truncated: false,
    principals, memberships, aces, gpos,
    tier2Totals: { users: 240, computers: 180 },
    unreadable: [{ dn: `OU=Archives,${ROOT}`, reason: 'access_denied' }]
};

const rules = [
    { id: 'r1', position: 0, kind: 'ou', pattern: OU.t0, tier: 0, created_by: 'admin@corp.local', updated_at: '2026-09-29T10:00:00Z' },
    { id: 'r2', position: 1, kind: 'ou', pattern: OU.t1, tier: 1, created_by: 'admin@corp.local', updated_at: '2026-09-29T10:00:00Z' },
    { id: 'r3', position: 2, kind: 'name', pattern: 'gmsa-*', tier: 2, created_by: 'admin@corp.local', updated_at: '2026-09-29T10:00:00Z' }
];
const overrides = [
    { sid: sid(2013), tier: 1, reason: 'Opératrice serveurs, validé par le RSSI', set_by: 'admin@corp.local', set_at: '2026-09-29T11:00:00Z' }
];
const remediations = [{ sid: sid(2014), proposed_by: 'admin@corp.local', proposed_at: '2026-09-30T09:00:00Z' }];

// The rows are shaped as store.js returns them, which is what buildModel takes.
const model = buildModel(facts, rules, overrides, remediations);

const out = path.join(__dirname, 'model.json');
fs.writeFileSync(out, JSON.stringify({ model, rules, settings: { domain: null, passes: 3 } }, null, 2) + '\n');
console.log(`wrote ${out}: ${model.accounts.length} accounts, ${model.chokepoints.length} chokepoints`);
