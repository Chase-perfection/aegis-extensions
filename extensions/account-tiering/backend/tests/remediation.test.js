'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { remediationFor, psQuote } = require('../remediation');
const { toCsv, csvCell } = require('../exportCsv');
const { ROOT_DN, sid, user, group, facts } = require('./facts');

const F = facts({
    principals: [group(1100, "IT-Admins"), user(1200, "o'brien"), { ...user(1300, 'pc01$'), kind: 'computer' }],
    gpos: [{ guid: '{11111111-1111-1111-1111-111111111111}', name: 'Serveurs - admins', editors: [], links: [], localGroups: [] }]
});

test('a membership link gives Remove-ADGroupMember with both names quoted', () => {
    const r = remediationFor({ from: sid(1200), to: sid(1100), kind: 'membership', detail: { via: 'member' } }, F);
    assert.strictEqual(r.command, "Remove-ADGroupMember -Identity 'IT-Admins' -Members 'o''brien'");
});

test('a primary group link resets primaryGroupID to the default for the kind', () => {
    const u = remediationFor({ from: sid(1200), to: sid(512), kind: 'membership', detail: { via: 'primaryGroup' } }, F);
    assert.match(u.command, /primaryGroupID=513\}$/);
    const c = remediationFor({ from: sid(1300), to: sid(512), kind: 'membership', detail: { via: 'primaryGroup' } }, F);
    assert.match(c.command, /primaryGroupID=515\}$/);
    assert.strictEqual(c.warning, 'primary_group');
});

test('an ACE link gives dsacls on the origin DN, with the warning', () => {
    const r = remediationFor({
        from: sid(1200), to: sid(1100), kind: 'acl',
        detail: { right: 'WriteMember', objectDn: 'CN=x,' + ROOT_DN, originDn: 'OU=Groups,' + ROOT_DN, inherited: true }
    }, F);
    assert.strictEqual(r.command, `dsacls 'OU=Groups,${ROOT_DN}' /R 'CORP\\o''brien'`);
    assert.strictEqual(r.warning, 'removes_all_aces');
});

test('GPO links give a console section, not a command', () => {
    const g = '{11111111-1111-1111-1111-111111111111}';
    assert.deepStrictEqual(
        remediationFor({ from: sid(1200), to: 'gpo:' + g, kind: 'gpoEdit', detail: { gpo: g } }, F),
        { mechanism: 'gpoEdit', gpo: 'Serveurs - admins', section: 'delegation' });
    const local = remediationFor({ from: sid(1200), to: 'gpolocal:' + g, kind: 'gpoLocal', detail: { gpo: g, localGroup: 'S-1-5-32-544', source: 'GroupsXml' } }, F);
    assert.strictEqual(local.section, 'localUsersAndGroups');
});

test('psQuote doubles straight and curly single quotes and leaves the rest alone', () => {
    const cases = [
        ['Admins du domaine', "'Admins du domaine'"],
        ["O'Brien", "'O''Brien'"],
        ['O’Brien', "'O’’Brien'"],
        ['‘x‛', "'‘‘x‛‛'"],
        ['a$b`c"d', "'a$b`c\"d'"],
        ['', "''"]
    ];
    for (const [input, expected] of cases) assert.strictEqual(psQuote(input), expected, input);
});

test('csvCell neutralises formulas, quotes separators, and leaves plain values alone', () => {
    const cases = [
        ['=cmd|calc', "'=cmd|calc"], ['+1', "'+1"], ['-1', "'-1"], ['@x', "'@x"],
        ['a,b', '"a,b"'], ['a;b', '"a;b"'], ['a"b', '"a""b"'], ['CN=x,OU=y', '"CN=x,OU=y"'],
        ['paul', 'paul'], [0, '0'], [null, ''], ['S-1-5-21-1-2-3-4', 'S-1-5-21-1-2-3-4'], ['été', 'été']
    ];
    for (const [input, expected] of cases) assert.strictEqual(csvCell(input), expected, String(input));
});

test('toCsv writes a BOM, a header and one row per account', () => {
    const csv = toCsv({ accounts: [{ sid: sid(1200), sam: '=evil', name: 'x', kind: 'user', enabled: true, planned: 2, effective: 0, status: 'gap', severity: 'critical', path: [{ kind: 'membership', to: sid(512) }], remediationProposed: false }] });
    const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
    assert.ok(csv.startsWith('﻿'));
    assert.strictEqual(lines.length, 2);
    assert.ok(lines[1].includes(",'=evil,"));
});
