'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { analyze } = require('../analyze');
const { ROOT_DN, sid, user, group, facts } = require('./facts');

const NO_PLAN = new Map();
const account = (model, rid) => model.accounts.find((a) => a.sid === sid(rid));

test('a member of a group nested in Domain Admins is Tier 0, and the path shows the middle group', () => {
    const model = analyze(facts({
        principals: [group(1100, 'IT-Admins'), user(1200, 'alice')],
        memberships: [
            { group: sid(512), member: sid(1100), via: 'member' },
            { group: sid(1100), member: sid(1200), via: 'member' }
        ]
    }), NO_PLAN);
    const alice = account(model, 1200);
    assert.strictEqual(alice.effective, 0);
    assert.deepStrictEqual(alice.path.map((e) => e.to), [sid(1100), sid(512)]);
    assert.strictEqual(alice.status, 'gap');
    assert.strictEqual(alice.severity, 'critical');
});

test('a primary group membership counts like a member entry', () => {
    const model = analyze(facts({
        principals: [user(1200, 'alice', { primaryGroupRid: 512 })],
        memberships: [{ group: sid(512), member: sid(1200), via: 'primaryGroup' }]
    }), NO_PLAN);
    assert.strictEqual(account(model, 1200).effective, 0);
    assert.strictEqual(account(model, 1200).path[0].detail.via, 'primaryGroup');
});

test('a password reset inherited from an OU on a Tier 0 account makes the trustee Tier 0, origin kept', () => {
    const model = analyze(facts({
        principals: [user(1200, 'alice'), user(1300, 'helpdesk')],
        memberships: [{ group: sid(512), member: sid(1200), via: 'member' }],
        aces: [{
            objectDn: `CN=alice,OU=Users,${ROOT_DN}`, objectSid: sid(1200), objectKind: 'account',
            originDn: `OU=Users,${ROOT_DN}`, trustee: sid(1300), right: 'ResetPassword', inherited: true, pass: 2
        }]
    }), NO_PLAN);
    const helpdesk = account(model, 1300);
    assert.strictEqual(helpdesk.effective, 0);
    assert.strictEqual(helpdesk.path[0].detail.originDn, `OU=Users,${ROOT_DN}`);
});

test('DCSync needs both halves on the root for the same trustee', () => {
    const half = (trustee, right) => ({
        objectDn: ROOT_DN, objectSid: null, objectKind: 'domainRoot', originDn: ROOT_DN,
        trustee, right, inherited: false, pass: 1
    });
    const model = analyze(facts({
        principals: [user(1200, 'full'), user(1300, 'half')],
        aces: [
            half(sid(1200), 'DCSyncGetChanges'), half(sid(1200), 'DCSyncGetChangesAll'),
            half(sid(1300), 'DCSyncGetChanges')
        ]
    }), NO_PLAN);
    assert.strictEqual(account(model, 1200).effective, 0);
    assert.strictEqual(account(model, 1200).path[0].detail.right, 'DCSync');
    assert.strictEqual(account(model, 1300).effective, 2);
});

test('GenericWrite on the root alone gives nothing; GenericAll does', () => {
    const ace = (rid, right) => ({
        objectDn: ROOT_DN, objectSid: null, objectKind: 'domainRoot', originDn: ROOT_DN,
        trustee: sid(rid), right, inherited: false, pass: 1
    });
    const model = analyze(facts({
        principals: [user(1200, 'writer'), user(1300, 'owner')],
        aces: [ace(1200, 'GenericWrite'), ace(1300, 'GenericAll')]
    }), NO_PLAN);
    assert.strictEqual(account(model, 1200).effective, 2);
    assert.strictEqual(account(model, 1300).effective, 0);
});

function gpo(guid, links, localGroups = [], editors = []) {
    return { guid, name: 'GPO ' + guid.slice(1, 5), editors, links, localGroups };
}
const G1 = '{11111111-1111-1111-1111-111111111111}';
const serversLink = { somDn: `OU=Servers,${ROOT_DN}`, enforced: false, computers: { dc: 0, server: 4, workstation: 0 } };
const stationsLink = { somDn: `OU=Stations,${ROOT_DN}`, enforced: false, computers: { dc: 0, server: 0, workstation: 90 } };
const dcLink = { somDn: `OU=Domain Controllers,${ROOT_DN}`, enforced: false, computers: { dc: 2, server: 0, workstation: 0 } };
const admins = (rid) => [{ localGroup: 'S-1-5-32-544', members: [sid(rid)], source: 'GptTmpl' }];

test('a GPO local group on servers is Tier 1, on workstations Tier 2, on a DC Tier 0', () => {
    for (const [link, expected] of [[serversLink, 1], [stationsLink, 2], [dcLink, 0]]) {
        const model = analyze(facts({ principals: [user(1200, 'alice')], gpos: [gpo(G1, [link], admins(1200))] }), NO_PLAN);
        assert.strictEqual(account(model, 1200).effective, expected, link.somDn);
        assert.strictEqual(account(model, 1200).path[0].kind, 'gpoLocal');
    }
});

test('editing a GPO linked to the Domain Controllers OU is Tier 0', () => {
    const model = analyze(facts({ principals: [user(1200, 'editor')], gpos: [gpo(G1, [dcLink], [], [sid(1200)])] }), NO_PLAN);
    assert.strictEqual(account(model, 1200).effective, 0);
    assert.strictEqual(account(model, 1200).path[0].kind, 'gpoEdit');
});

test('a broad trustee is a chokepoint listed first, and is not pushed onto accounts', () => {
    const model = analyze(facts({
        principals: [user(1200, 'alice'), group(1100, 'IT-Admins')],
        memberships: [{ group: sid(512), member: sid(1100), via: 'member' }, { group: sid(1100), member: sid(1200), via: 'member' }],
        aces: [{
            objectDn: 'CN=AdminSDHolder,CN=System,' + ROOT_DN, objectSid: null, objectKind: 'adminSdHolder',
            originDn: 'CN=AdminSDHolder,CN=System,' + ROOT_DN, trustee: 'S-1-5-11', right: 'WriteDacl', inherited: false, pass: 1
        }]
    }), NO_PLAN);
    assert.strictEqual(model.chokepoints[0].broad, true);
    assert.strictEqual(model.chokepoints[0].from, 'S-1-5-11');
    assert.ok(model.accounts.every((a) => a.path.every((e) => e.from !== 'S-1-5-11')));
});

test('a three-link chain: ACE on a Tier 1 group held by a member of another group', () => {
    const model = analyze(facts({
        principals: [group(1100, 'ServerAdmins'), group(1101, 'Delegates'), user(1200, 'bob')],
        memberships: [{ group: sid(1101), member: sid(1200), via: 'member' }],
        aces: [{
            objectDn: `CN=ServerAdmins,OU=Groups,${ROOT_DN}`, objectSid: sid(1100), objectKind: 'group',
            originDn: `CN=ServerAdmins,OU=Groups,${ROOT_DN}`, trustee: sid(1101), right: 'WriteMember', inherited: false, pass: 2
        }],
        gpos: [gpo(G1, [serversLink], [{ localGroup: 'S-1-5-32-544', members: [sid(1100)], source: 'GroupsXml' }])]
    }), NO_PLAN);
    const bob = account(model, 1200);
    assert.strictEqual(bob.effective, 1);
    assert.deepStrictEqual(bob.path.map((e) => e.kind), ['membership', 'acl', 'gpoLocal']);
    assert.strictEqual(bob.severity, 'high');
});

test('a truncated scan is reported as such', () => {
    const model = analyze(facts({ extra: { truncated: true } }), NO_PLAN);
    assert.strictEqual(model.scan.truncated, true);
});

test('ignored trustees and Tier 0 members leave no ACE behind', () => {
    const model = analyze(facts({
        principals: [user(1200, 'da')],
        memberships: [{ group: sid(512), member: sid(1200), via: 'member' }],
        aces: [
            { objectDn: ROOT_DN, objectSid: null, objectKind: 'domainRoot', originDn: ROOT_DN, trustee: 'S-1-5-18', right: 'GenericAll', inherited: false, pass: 1 },
            { objectDn: ROOT_DN, objectSid: null, objectKind: 'domainRoot', originDn: ROOT_DN, trustee: sid(512), right: 'GenericAll', inherited: false, pass: 1 },
            { objectDn: ROOT_DN, objectSid: null, objectKind: 'domainRoot', originDn: ROOT_DN, trustee: sid(1200), right: 'WriteDacl', inherited: false, pass: 1 }
        ]
    }), NO_PLAN);
    assert.strictEqual(model.links.filter((l) => l.type === 'acl').length, 0);
    assert.strictEqual(account(model, 1200).path[0].kind, 'membership');
});

test('a membership cycle ends', () => {
    const model = analyze(facts({
        principals: [group(1100, 'A'), group(1101, 'B'), user(1200, 'carol')],
        memberships: [
            { group: sid(1100), member: sid(1101), via: 'member' },
            { group: sid(1101), member: sid(1100), via: 'member' },
            { group: sid(1100), member: sid(1200), via: 'member' }
        ]
    }), NO_PLAN);
    assert.strictEqual(account(model, 1200).effective, 2);
    assert.deepStrictEqual(account(model, 1200).path, []);
});

test('DnsAdmins is a Tier 0 target, found by name', () => {
    const model = analyze(facts({
        principals: [group(1101, 'DnsAdmins'), user(1200, 'dns')],
        memberships: [{ group: sid(1101), member: sid(1200), via: 'member' }]
    }), NO_PLAN);
    assert.strictEqual(account(model, 1200).effective, 0);
});

test('planned tier against effective tier: gap, ok, below, matrix and uncollected totals', () => {
    const planned = new Map([
        [sid(1200), { tier: 0, source: { type: 'rule', ruleId: 'r1' } }],
        [sid(1300), { tier: 0, source: { type: 'override' } }]
    ]);
    const model = analyze(facts({
        principals: [user(1200, 'da'), user(1300, 'idle')],
        memberships: [{ group: sid(512), member: sid(1200), via: 'member' }],
        tier2Totals: { users: 10, computers: 5 }
    }), planned);
    assert.strictEqual(account(model, 1200).status, 'ok');
    assert.strictEqual(account(model, 1300).status, 'below');
    assert.deepStrictEqual(model.matrix, [[1, 0, 1], [0, 0, 0], [0, 0, 15]]);
    assert.strictEqual(model.keyFigures.accounts, 17);
    assert.deepStrictEqual(model.keyFigures.byEffective, [1, 0, 16]);
});

test('an unknown schema is refused with facts_schema', () => {
    assert.throws(() => analyze({ schema: 2 }, NO_PLAN), (e) => e.code === 'facts_schema');
});

test('a chokepoint counts the exposed accounts and the gaps through it', () => {
    const model = analyze(facts({
        principals: [group(1100, 'IT-Admins'), user(1200, 'a'), user(1201, 'b')],
        memberships: [
            { group: sid(512), member: sid(1100), via: 'member' },
            { group: sid(1100), member: sid(1200), via: 'member' },
            { group: sid(1100), member: sid(1201), via: 'member' }
        ]
    }), new Map([[sid(1200), { tier: 0, source: { type: 'override' } }]]));
    const point = model.chokepoints.find((p) => p.key === 'group:' + sid(1100));
    assert.strictEqual(point.exposed.length, 2);
    assert.deepStrictEqual(point.gaps, [sid(1201)]);
});

test('the proposed-remediation marker is carried onto the account', () => {
    const model = analyze(facts({ principals: [user(1200, 'a')] }), NO_PLAN, { remediations: new Set([sid(1200)]) });
    assert.strictEqual(account(model, 1200).remediationProposed, true);
});
