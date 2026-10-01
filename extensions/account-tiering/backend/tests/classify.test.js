'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { classify, ouMatches, globToRegExp } = require('../classify');
const { ROOT_DN, sid, user, group, facts } = require('./facts');

const F = facts({
    principals: [
        group(1100, 'T0-Admins'), group(1101, 'Nested'),
        { ...user(1200, 'alice-adm'), dn: `CN=alice-adm,OU=Admins-T0,${ROOT_DN}` },
        user(1201, 'bob'), user(1202, 'carol')
    ],
    memberships: [
        { group: sid(1100), member: sid(1101), via: 'member' },
        { group: sid(1101), member: sid(1202), via: 'member' }
    ]
});
const rule = (id, position, kind, pattern, tier) => ({ id, position, kind, pattern, tier });

test('each rule kind matches what it should', () => {
    const out = classify(F, [
        rule('ou', 1, 'ou', `OU=Admins-T0,${ROOT_DN}`, 0),
        rule('grp', 2, 'group', sid(1100), 1),
        rule('nm', 3, 'name', 'bo?', 1)
    ], []);
    assert.deepStrictEqual(out.get(sid(1200)), { tier: 0, source: { type: 'rule', ruleId: 'ou' } });
    assert.deepStrictEqual(out.get(sid(1202)), { tier: 1, source: { type: 'rule', ruleId: 'grp' } });
    assert.deepStrictEqual(out.get(sid(1201)), { tier: 1, source: { type: 'rule', ruleId: 'nm' } });
});

test('the first rule by position wins, whatever the array order', () => {
    const out = classify(F, [rule('late', 2, 'name', '*-adm', 1), rule('early', 1, 'name', 'alice*', 0)], []);
    assert.strictEqual(out.get(sid(1200)).source.ruleId, 'early');
});

test('an override beats every rule', () => {
    const out = classify(F, [rule('ou', 1, 'ou', `OU=Admins-T0,${ROOT_DN}`, 0)], [{ sid: sid(1200), tier: 2, reason: 'test' }]);
    assert.deepStrictEqual(out.get(sid(1200)), { tier: 2, source: { type: 'override' } });
});

test('no rule means Tier 2 by default', () => {
    assert.deepStrictEqual(classify(F, [], []).get(sid(1201)), { tier: 2, source: { type: 'default' } });
});

test('ouMatches only on an RDN boundary, case-insensitive', () => {
    const p = `OU=Admins-T0,${ROOT_DN}`;
    assert.ok(ouMatches(`CN=a,OU=Admins-T0,${ROOT_DN}`, p));
    assert.ok(ouMatches(`CN=a,OU=Sub,OU=Admins-T0,${ROOT_DN}`, p.toLowerCase()));
    assert.ok(!ouMatches(`CN=a,OU=XAdmins-T0,${ROOT_DN}`, p));
    assert.ok(!ouMatches('CN=a,OU=Admins-T0,DC=corp,DC=localhost', p));
    assert.ok(!ouMatches(`CN=a,OU=Users,${ROOT_DN}`, p));
});

test('a name glob treats * and ? as wildcards and every other character literally', () => {
    const yes = [['paul-adm', '*-adm'], ['PAUL-ADM', '*-adm'], ['t0-a', 't0-?'], ['a.b', 'a.b'], ['svc(x)', 'svc(x)']];
    const no = [['paul-adm2', '*-adm'], ['paul.adm', '*-adm'], ['t0-ab', 't0-?'], ['axb', 'a.b'], ['xpaul-adm', 'paul-adm']];
    for (const [sam, glob] of yes) assert.ok(globToRegExp(glob).test(sam), `${glob} should match ${sam}`);
    for (const [sam, glob] of no) assert.ok(!globToRegExp(glob).test(sam), `${glob} should not match ${sam}`);
});
