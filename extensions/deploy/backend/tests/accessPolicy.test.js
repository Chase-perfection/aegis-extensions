/**
 * The access manifest a deployed site carries, and the verdict it produces.
 *
 * The case table under `the verdict` is the reason this file exists. The gate
 * is handed the raw request target while the file resolver percent-decodes and
 * resolves it on a case-insensitive filesystem, so a rule compared against the
 * raw target is bypassable. The table runs both directions: every request that
 * must be caught is caught, and every request that must stay public stays
 * public. The second direction is the one nobody writes, and an over-broad rule
 * that closes a stylesheet is as wrong as a leak.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const policy = require('../accessPolicy');

/* ---------------------------------------------------------------- parsing */

test('a manifest with rules parses, and the vocabulary is the required names', () => {
    const p = policy.parse(JSON.stringify({
        version: 1,
        rules: [
            { path: '/admin/*', require: 'admin' },
            { path: '/reports', require: 'finance' }
        ]
    }));
    assert.strictEqual(p.ok, true);
    assert.strictEqual(p.rules.length, 2);
    assert.deepStrictEqual(p.resources, ['admin', 'finance']);
});

test('no file at all is a site with no policy, not an error', () => {
    const p = policy.parse(null);
    assert.strictEqual(p.ok, true);
    assert.deepStrictEqual(p.rules, []);
    assert.deepStrictEqual(p.resources, []);
});

test('a file that does not parse is refused by name', () => {
    const p = policy.parse('{ not json');
    assert.strictEqual(p.ok, false);
    assert.match(p.error, /parse/);
});

test('a rule with no path or no require is refused', () => {
    assert.strictEqual(policy.parse(JSON.stringify({ rules: [{ require: 'a' }] })).ok, false);
    assert.strictEqual(policy.parse(JSON.stringify({ rules: [{ path: '/a' }] })).ok, false);
});

test('a path that is not rooted is refused', () => {
    const p = policy.parse(JSON.stringify({ rules: [{ path: 'admin/*', require: 'a' }] }));
    assert.strictEqual(p.ok, false);
    assert.match(p.error, /must start with/);
});

test('a version this build does not know is refused rather than half-applied', () => {
    const p = policy.parse(JSON.stringify({ version: 99, rules: [] }));
    assert.strictEqual(p.ok, false);
    assert.match(p.error, /version/);
});

test('more rules than the cap is refused', () => {
    const rules = [];
    for (let i = 0; i < 201; i++) rules.push({ path: '/p' + i, require: 'r' });
    assert.strictEqual(policy.parse(JSON.stringify({ rules })).ok, false);
});

test('a JSON array is not a manifest', () => {
    assert.strictEqual(policy.parse('[]').ok, false);
});

/* ------------------------------------------------------------------ on disk */

function tmpSite(contents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-policy-'));
    if (contents !== undefined) {
        fs.writeFileSync(path.join(dir, 'aegis.access.json'), contents);
    }
    return dir;
}

test('read() picks the manifest out of a served directory', () => {
    const p = policy.read(tmpSite(JSON.stringify({
        rules: [{ path: '/admin/*', require: 'admin' }]
    })));
    assert.strictEqual(p.ok, true);
    assert.deepStrictEqual(p.resources, ['admin']);
});

test('read() on a directory with no manifest is a site with no policy', () => {
    const dir = tmpSite(undefined);
    assert.strictEqual(policy.read(dir).ok, true);
    assert.deepStrictEqual(policy.read(dir).rules, []);
});

test('read() reports a manifest that does not parse', () => {
    assert.strictEqual(policy.read(tmpSite('{ broken')).ok, false);
});

/* ------------------------------------------------------------- the verdict */

const RULES = policy.parse(JSON.stringify({
    rules: [
        { path: '/admin/*', require: 'admin' },
        { path: '/api/finance/*', require: 'finance' },
        { path: '/reports', require: 'finance' }
    ]
})).rules;

const GRANTS = {
    admin: { groups: ['Site-Admins'], users: [] },
    finance: { groups: [], users: [{ sid: 'S-1-5-21-1-2-3-1500' }] }
};

const OUTSIDER = { groups: ['Domain Users'], sid: 'S-1-5-21-1-2-3-9999' };
const ADMIN = { groups: ['Site-Admins'], sid: 'S-1-5-21-1-2-3-1000' };
const FINANCE = { groups: ['Domain Users'], sid: 'S-1-5-21-1-2-3-1500' };

const CASES = [
    // 1. what must be caught IS caught, however the request spells it
    ['plain path denied', OUTSIDER, '/admin/users', false],
    ['uppercase, NTFS folds case', OUTSIDER, '/ADMIN/users', false],
    ['mixed case', OUTSIDER, '/AdMiN/users', false],
    ['percent-encoded letter', OUTSIDER, '/%61dmin/users', false],
    ['fully encoded segment', OUTSIDER, '/%61%64%6d%69%6e/users', false],
    ['dot segment detour', OUTSIDER, '/public/../admin/users', false],
    ['double slash', OUTSIDER, '//admin/users', false],
    ['inner dot segment', OUTSIDER, '/admin/./users', false],
    ['encoded slash splits', OUTSIDER, '/admin%2fusers', false],
    ['query string ignored', OUTSIDER, '/admin/users?tab=1', false],
    ['fragment ignored', OUTSIDER, '/admin/users#x', false],
    ['bare prefix with no trailing slash', OUTSIDER, '/admin', false],
    ['exact rule, no wildcard', OUTSIDER, '/reports', false],
    ['malformed escape denied', OUTSIDER, '/admin/%zz', false],
    ['one resource does not open another', ADMIN, '/api/finance/ledger', false],

    // 1b. the right person gets through the same doors
    ['group opens its resource', ADMIN, '/admin/users', true],
    ['group opens it however spelled', ADMIN, '/%41DMIN/users', true],
    ['sid opens its resource', FINANCE, '/api/finance/ledger', true],
    ['sid opens an exact rule', FINANCE, '/reports', true],

    // 2. what must stay public DOES stay public
    ['root untouched', OUTSIDER, '/', true],
    ['asset untouched', OUTSIDER, '/assets/app.css', true],
    ['longer name is not the prefix', OUTSIDER, '/administration/x', true],
    ['sibling name untouched', OUTSIDER, '/admins', true],
    ['exact rule does not cover children', OUTSIDER, '/reports/2026', true],
    ['same word outside the rule path', OUTSIDER, '/finance/public', true],
    ['encoded near-miss stays open', OUTSIDER, '/%61dministration/x', true],
    ['deep public path', OUTSIDER, '/a/b/c/d.html', true]
];

for (const [label, who, rawUrl, expected] of CASES) {
    test(`verdict: ${label} (${rawUrl})`, () => {
        const got = policy.verdict({
            rules: RULES, grants: GRANTS, groups: who.groups, sid: who.sid, rawUrl
        });
        assert.strictEqual(got.allowed, expected,
            `${rawUrl} normalised to ${policy.normalisePath(rawUrl)}`);
    });
}

test('a rule naming a resource nobody is bound to closes the path', () => {
    const rules = policy.parse(JSON.stringify({
        rules: [{ path: '/secret/*', require: 'typo-nobody-has' }]
    })).rules;
    const got = policy.verdict({
        rules, grants: GRANTS, groups: ADMIN.groups, sid: ADMIN.sid, rawUrl: '/secret/x'
    });
    assert.strictEqual(got.allowed, false);
    assert.strictEqual(got.resource, 'typo-nobody-has');
});

test('no rules means no opinion, so nothing is closed', () => {
    const got = policy.verdict({
        rules: [], grants: {}, groups: [], sid: '', rawUrl: '/admin/users'
    });
    assert.strictEqual(got.allowed, true);
});

test('deny wins when two rules cover the same path', () => {
    const rules = policy.parse(JSON.stringify({
        rules: [
            { path: '/both/*', require: 'admin' },
            { path: '/both/*', require: 'finance' }
        ]
    })).rules;
    const got = policy.verdict({
        rules, grants: GRANTS, groups: ADMIN.groups, sid: ADMIN.sid, rawUrl: '/both/x'
    });
    assert.strictEqual(got.allowed, false, 'holding one of the two is not holding both');
    assert.strictEqual(got.resource, 'finance');
});

test('an empty sid never matches a granted user', () => {
    const rules = policy.parse(JSON.stringify({
        rules: [{ path: '/x/*', require: 'r' }]
    })).rules;
    const grants = { r: { groups: [], users: [{ sid: '' }] } };
    const got = policy.verdict({ rules, grants, groups: [], sid: '', rawUrl: '/x/y' });
    assert.strictEqual(got.allowed, false, 'a blank SID on both sides is not a match');
});

test('the group matcher is the caller\'s, so the door and the room agree', () => {
    // siteAuth hands in its own `groupAllowed`, which treats a full
    // distinguished name and its first CN as the same group. Without the seam
    // this module would compare strings and refuse somebody the site door had
    // just let in.
    const rules = policy.parse(JSON.stringify({
        rules: [{ path: '/x/*', require: 'r' }]
    })).rules;
    const grants = { r: { groups: ['Site-Admins'], users: [] } };
    const held = ['CN=Site-Admins,CN=Users,DC=corp,DC=local'];

    assert.strictEqual(
        policy.verdict({ rules, grants, groups: held, sid: '', rawUrl: '/x/y' }).allowed,
        false, 'the fallback compares the name as spelled, and these differ');

    const byCn = (wanted, have) => wanted.some(
        (w) => have.some((h) => new RegExp(`^CN=${w},`, 'i').test(h)));
    assert.strictEqual(
        policy.verdict({ rules, grants, groups: held, sid: '', rawUrl: '/x/y', groupMatches: byCn }).allowed,
        true, 'a supplied matcher decides instead');
});
