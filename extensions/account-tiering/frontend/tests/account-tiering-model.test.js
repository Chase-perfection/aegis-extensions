/**
 * Unit tests for the view-model adapter, in Node, against the model the REAL
 * backend produced (fixtures/model.json, rebuilt by fixtures/build-fixture.js).
 * Each case of the fixture is one AD situation the page has to explain.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildViewModel, sevOf } = require('../src/js/account-tiering-model.js');
const fixture = require('./fixtures/model.json');

const used = new Map();
const recordingT = (key, fallback, params) => {
    used.set(key, fallback);
    let text = String(fallback);
    for (const [k, v] of Object.entries(params || {})) text = text.split('{' + k + '}').join(String(v));
    return text;
};

const vm = buildViewModel(fixture.model, { rules: fixture.rules, t: recordingT });
const bySam = (sam) => {
    const a = vm.accounts.find((x) => x.sam === sam);
    assert.ok(a, `account ${sam} is in the view model`);
    return a;
};

test('severity is derived the way the backend derives it', () => {
    assert.strictEqual(sevOf(2, 0), 'critical');
    assert.strictEqual(sevOf(2, 1), 'high');
    assert.strictEqual(sevOf(1, 1), null);
    assert.strictEqual(sevOf(0, 2), null);
    for (const a of vm.accounts) assert.strictEqual(a.severity, fixture.model.accounts.find((x) => x.sid === a.sid).severity);
});

test('nested Domain Admins: first-hop group, nested relation, full chain and two alternative cuts', () => {
    const a = bySam('a.martin');
    assert.deepStrictEqual(a.groups.map((g) => g.name), ['GG-IT-Admins']);
    assert.strictEqual(a.hidden, 1, 'GG-Projet-A reaches nothing and is folded into the ghost node');
    assert.strictEqual(a.mechs.length, 1);
    const m = a.mechs[0];
    assert.strictEqual(m.rel, 'member');
    assert.strictEqual(m.relTitle, 'Appartenance imbriquée');
    assert.strictEqual(m.tier, 0);
    assert.strictEqual(m.severity, 'critical');
    assert.deepStrictEqual(m.chain, ['a.martin', 'GG-IT-Admins', 'Admins du domaine']);
    assert.match(m.why, /hérite de Admins du domaine/);
    assert.deepStrictEqual(a.steps.map((s) => s.command), [
        "Remove-ADGroupMember -Identity 'GG-IT-Admins' -Members 'a.martin'",
        "Remove-ADGroupMember -Identity 'Admins du domaine' -Members 'GG-IT-Admins'"
    ]);
});

test('DCSync is a direct right, with the dsacls warning translated', () => {
    const a = bySam('svc-backup');
    assert.strictEqual(a.groups.length, 1);
    assert.strictEqual(a.groups[0].direct, true);
    assert.strictEqual(a.mechs[0].name, 'DCSync');
    assert.strictEqual(a.mechs[0].gk, 'direct:' + a.sid);
    assert.match(a.mechs[0].why, /DCSync/);
    assert.strictEqual(a.steps.length, 1);
    assert.strictEqual(a.steps[0].warning, 'removes_all_aces');
    assert.match(a.steps[0].warningText, /toutes les ACE/);
});

test('ResetPassword inherited from an OU names the origin and never proposes demoting the legitimate admin', () => {
    const a = bySam('h.dupont');
    const m = a.mechs[0];
    assert.strictEqual(m.rel, 'acl');
    assert.strictEqual(m.name, 'ResetPassword');
    assert.match(m.why, /hérité de OU=Admins-T0,DC=corp,DC=local/);
    assert.deepStrictEqual(m.chain, ['h.dupont', 'GG-Helpdesk', 'ResetPassword sur adm-t0-rdubois', 'Admins du domaine']);
    assert.strictEqual(a.steps.length, 2);
    assert.ok(a.steps.every((s) => !/adm-t0-rdubois' *$/.test(s.command || '') && !/-Members 'adm-t0-rdubois'/.test(s.command || '')));
});

test('a GPO on servers is Tier 1 high, fixed in GPMC under Restricted Groups', () => {
    const a = bySam('p.leroy');
    assert.strictEqual(a.effective, 1);
    assert.strictEqual(a.severity, 'high');
    assert.strictEqual(a.mechs[0].rel, 'gpo');
    assert.strictEqual(a.mechs[0].name, 'Administrateurs');
    const gpmc = a.steps.find((s) => s.gpmc);
    assert.ok(gpmc, 'one GPMC step');
    assert.match(gpmc.gpmc, /Groupes restreints/);
    assert.strictEqual(gpmc.command, null);
});

test('a GPO on workstations is Tier 2 and compliant for a Tier 2 account: no severity, no step', () => {
    const a = bySam('c.bernard');
    assert.strictEqual(a.mechs[0].tier, 2);
    assert.strictEqual(a.mechs[0].severity, null);
    assert.deepStrictEqual(a.steps, []);
});

test('a broad trustee is listed first among the points, named by its well-known SID', () => {
    const p = vm.points[0];
    assert.strictEqual(p.broad, true);
    assert.strictEqual(p.name, 'WriteDacl sur AdminSDHolder');
    assert.match(p.meta, /Utilisateurs authentifiés/);
    assert.strictEqual(p.pct, 100);
});

test('an account with more than 8 groups keeps every privileged group and one mechanism per group', () => {
    const a = bySam('svc-sccm');
    assert.strictEqual(a.groups.length, 10);
    assert.strictEqual(a.hidden, 2);
    assert.strictEqual(a.mechs.length, 10);
    assert.strictEqual(a.mechs.filter((m) => m.fromPath).length, 1, 'only the backend path is marked as such');
    assert.ok(a.mechs.every((m) => m.tier === 1 && m.severity === 'high'));
    assert.strictEqual(new Set(a.mechs.map((m) => m.gk)).size, 10);
});

test('a compliant Tier 0 admin covered by a rule shows the rule and no remediation', () => {
    const a = bySam('adm-t0-rdubois');
    assert.strictEqual(a.status, 'ok');
    assert.strictEqual(a.sourceLabel, 'Règle 1 : OU=Admins-T0,DC=corp,DC=local');
    assert.strictEqual(a.mechs[0].severity, null);
    assert.deepStrictEqual(a.steps, []);
});

test('planned-tier sources: override, rule, default', () => {
    assert.strictEqual(bySam('s.moreau').sourceLabel, 'Correction manuelle');
    assert.strictEqual(bySam('s.moreau').plannedSource.type, 'override');
    assert.match(bySam('m.petit').sourceLabel, /Tier 2 par défaut/);
});

test('a manual correction carries its reason, author and date; the other accounts carry none', () => {
    assert.deepStrictEqual(bySam('s.moreau').override, {
        reason: 'Opératrice serveurs, validé par le RSSI', setBy: 'admin@corp.local', setAt: '2026-09-29T11:00:00Z'
    });
    for (const a of vm.accounts) if (a.sam !== 's.moreau') assert.strictEqual(a.override, null, a.sam);
    // A model from a backend older than the override details still draws.
    const old = JSON.parse(JSON.stringify(fixture.model));
    for (const a of old.accounts) delete a.override;
    const oldVm = buildViewModel(old, { rules: fixture.rules });
    assert.strictEqual(oldVm.accounts.find((a) => a.sam === 's.moreau').override, null);
});

/**
 * Hand-written, unlike the rest of this file: the fixture has no account with
 * a second chain through a Tier 0 target, and the SIDs here are deliberately
 * NOT the well-known ones, so only `group.target` can stop the chain.
 */
function chainModel(target) {
    const S = (n) => `S-1-5-21-9-9-9-${n}`;
    const g = (n, name, extra) => ({ sid: S(n), sam: name, name, dn: `CN=${name},DC=corp,DC=local`, tier: 0, broad: false, target: false, ...extra });
    const member = (from, to) => ({ from, to, type: 'membership', kind: 'membership', detail: { via: 'member' } });
    const acl = (from, to) => ({ from, to, type: 'acl', kind: 'acl', detail: { right: 'WriteDacl', objectDn: 'x', originDn: 'x', inherited: false } });
    const path = [member(S(1), S(10)), member(S(10), S(20))];
    return {
        scan: { domain: 'corp.local', domainSid: 'S-1-5-21-9-9-9' },
        accounts: [{
            sid: S(1), sam: 'k.durand', name: 'Karim Durand', kind: 'user', enabled: true, planned: 2,
            plannedSource: { type: 'default' }, effective: 0, status: 'gap', severity: 'critical', path, remediationProposed: false
        }],
        groups: [g(10, 'GG-Un'), g(11, 'GG-Deux'), g(12, 'GG-Trois'), g(20, 'GG-Cible', { target }), g(30, 'GG-Au-dela')],
        objects: [{ key: 'adminSdHolder', label: 'AdminSDHolder', tier: 0 }],
        links: [
            ...path, member(S(1), S(11)), member(S(11), S(20)), member(S(20), S(30)),
            member(S(1), S(12)), acl(S(12), 'adminSdHolder'), member('adminSdHolder', S(30))
        ],
        chokepoints: [], matrix: [[0, 0, 0], [0, 0, 0], [1, 0, 0]], keyFigures: { accounts: 1, chokepoints: 0 }
    };
}
const chainVia = (model, group) => buildViewModel(model).accounts[0].mechs.find((m) => m.chain[1] === group).chain;

test('a rebuilt chain stops on the group the backend flags as a target, not on a list kept in the page', () => {
    assert.deepStrictEqual(chainVia(chainModel(true), 'GG-Deux'), ['k.durand', 'GG-Deux', 'GG-Cible']);
    // The same directory with the flag off walks on: the flag is what stops it.
    assert.deepStrictEqual(chainVia(chainModel(false), 'GG-Deux'), ['k.durand', 'GG-Deux', 'GG-Cible', 'GG-Au-dela']);
});

test('a rebuilt chain stops on a directory object that carries a tier', () => {
    assert.deepStrictEqual(chainVia(chainModel(true), 'GG-Trois'), ['k.durand', 'GG-Trois', 'WriteDacl sur AdminSDHolder']);
});

test('the real backend flags its targets, and only them', () => {
    const flagged = fixture.model.groups.filter((g) => g.target).map((g) => g.name);
    assert.deepStrictEqual(flagged, ['Admins du domaine']);
    assert.ok(fixture.model.groups.every((g) => typeof g.target === 'boolean'));
});

test('below the plan and no path: no mechanism, status below', () => {
    const a = bySam('adm-t0-ancien');
    assert.strictEqual(a.status, 'below');
    assert.deepStrictEqual(a.mechs, []);
    assert.deepStrictEqual(a.groups, []);
});

test('a primary group carries its own warning and the persisted remediation marker', () => {
    const a = bySam('x.garnier');
    assert.strictEqual(a.mechs[0].relTitle, 'Groupe principal');
    assert.strictEqual(a.steps[0].warning, 'primary_group');
    assert.strictEqual(a.remediationProposed, true);
    assert.strictEqual(bySam('a.martin').remediationProposed, false);
});

test('a gMSA is a service account', () => {
    assert.strictEqual(bySam('gmsa-sql$').kind, 'service');
    assert.strictEqual(bySam('a.martin').kind, 'user');
});

test('key figures, matrix and uncollected accounts', () => {
    assert.deepStrictEqual(vm.kpis, { accounts: 15, gaps: 9, gapPct: 60, t0Unplanned: 6, points: 13 });
    assert.deepStrictEqual(vm.matrix, fixture.model.matrix);
    assert.strictEqual(vm.uncollected, 420);
    assert.strictEqual(vm.rulesCount, 3);
    assert.strictEqual(vm.unreadable.length, 1);
    assert.strictEqual(vm.domain, 'corp.local');
});

test('the points are the backend\'s chokepoints, one for one, and the figure is its own', () => {
    // The backend keeps only the points to fix (a gap goes through, or the
    // holder is broad), so the page has nothing left to filter.
    assert.ok(fixture.model.chokepoints.every((p) => p.broad || p.gaps.length > 0));
    assert.deepStrictEqual(vm.points.map((p) => p.key), fixture.model.chokepoints.map((p) => p.key));
    assert.strictEqual(vm.kpis.points, fixture.model.keyFigures.chokepoints);
    assert.ok(!vm.points.some((p) => p.name === 'GG-Support-Postes'), 'only compliant accounts go through it');
});

test('the page does not second-guess the backend\'s list of points', () => {
    const model = JSON.parse(JSON.stringify(fixture.model));
    const extra = { ...model.chokepoints[model.chokepoints.length - 1], key: 'group:added-by-the-test', gaps: [], exposed: [], broad: false };
    model.chokepoints.push(extra);
    model.keyFigures.chokepoints = 99;
    const other = buildViewModel(model, { rules: fixture.rules });
    assert.strictEqual(other.points.length, fixture.model.chokepoints.length + 1);
    assert.strictEqual(other.kpis.points, 99);
});

test('every text goes through an at_ key, with its parameters filled and no em dash', () => {
    assert.ok(used.size > 20);
    for (const [key, fallback] of used) {
        assert.match(key, /^at_[a-z0-9_]+$/, key);
        assert.ok(!fallback.includes('—'), key);
    }
    const texts = [];
    for (const a of vm.accounts) {
        texts.push(a.sourceLabel);
        for (const m of a.mechs) texts.push(m.name, m.sub, m.relTitle, m.why, ...m.chain);
        for (const s of a.steps) texts.push(s.title, s.gpmc || '', s.warningText || '');
    }
    for (const p of vm.points) texts.push(p.name, p.meta, p.expoLabel);
    for (const t of texts) assert.ok(!/\{[a-z]+\}/.test(t), `unfilled parameter in: ${t}`);
});

test('a thin or broken model gives an empty view model instead of throwing', () => {
    const empty = buildViewModel({});
    assert.deepStrictEqual(empty.accounts, []);
    assert.deepStrictEqual(empty.points, []);
    assert.strictEqual(empty.kpis.gapPct, 0);
    assert.doesNotThrow(() => buildViewModel(null));
});
