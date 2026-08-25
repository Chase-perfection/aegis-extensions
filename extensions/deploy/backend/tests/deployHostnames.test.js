/**
 * Host names for deployed sites, on an install that keeps its ports.
 *
 * The operator said no to 80 and 443 and no to depending on internal DNS, so a
 * site keeps its own port and a host name is an addition: one shared listener
 * routes by `Host` for the projects that declared one. Which makes the lookup
 * the thing that has to be right.
 *
 * Two failures to keep out. A request with a `Host` nobody claimed must answer
 * 404 rather than the first site in the list, because "the wrong site answered"
 * is how a protected page ends up served under a name nobody protected. And a
 * host name that is not a host name must never be stored, since it reaches a
 * comparison against a header a client controls.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    normaliseHostname, hostOf, buildHostIndex
} = require('../siteServer');

test('a host name is lowercased, trimmed, and stripped of its root dot', () => {
    assert.strictEqual(normaliseHostname('  Intranet.Example.LOCAL. '), 'intranet.example.local');
    assert.strictEqual(normaliseHostname('site'), 'site');
    assert.strictEqual(normaliseHostname(''), '');
    assert.strictEqual(normaliseHostname(null), '');
});

test('anything that is not a host name is refused', () => {
    for (const raw of ['http://site.local', 'site.local/path', 'site.local:3080', 'a b',
        '-site.local', 'site-.local', 'site..local', '.site.local', 'x'.repeat(260)]) {
        assert.strictEqual(normaliseHostname(raw), null, `accepted ${raw}`);
    }
});

test('the Host header is read without its port', () => {
    assert.strictEqual(hostOf({ headers: { host: 'Intranet.Local:3080' } }), 'intranet.local');
    assert.strictEqual(hostOf({ headers: { host: 'intranet.local' } }), 'intranet.local');
    assert.strictEqual(hostOf({ headers: {} }), '');
    // An IPv6 literal keeps its brackets: splitting on the colon would leave a
    // fragment that matches nothing, which is right, but by accident.
    assert.strictEqual(hostOf({ headers: { host: '[::1]:3080' } }), '[::1]');
});

test('the index maps a declared host name to its project and nothing else', () => {
    const index = buildHostIndex([
        {
            slug: 'acme', tenantPaths: { root: '/t/acme' },
            projects: [
                { id: 'one', hostname: 'one.acme.local', port: 3081 },
                { id: 'two', port: 3082 }
            ]
        },
        {
            slug: 'other', tenantPaths: { root: '/t/other' },
            projects: [{ id: 'three', hostname: 'three.other.local', port: 3083 }]
        }
    ]);

    assert.strictEqual(index.size, 2);
    assert.strictEqual(index.get('one.acme.local').slug, 'acme');
    assert.strictEqual(index.get('one.acme.local').project.id, 'one');
    assert.strictEqual(index.get('three.other.local').slug, 'other');
    assert.strictEqual(index.get('nobody.local'), undefined);
});

test('a project with no port is not reachable by name either', () => {
    // No port means no listener and nothing published. Routing a name to it
    // would answer 404 from the site rather than from the router, which reads
    // as a deployment problem instead of a configuration one.
    const index = buildHostIndex([{
        slug: 'acme', tenantPaths: { root: '/t/acme' },
        projects: [{ id: 'one', hostname: 'one.acme.local', port: null }]
    }]);

    assert.strictEqual(index.size, 0);
});

test('two projects claiming one name: the first keeps it, the second is dropped', () => {
    const index = buildHostIndex([{
        slug: 'acme', tenantPaths: { root: '/t/acme' },
        projects: [
            { id: 'one', hostname: 'shared.acme.local', port: 3081 },
            { id: 'two', hostname: 'shared.acme.local', port: 3082 }
        ]
    }]);

    assert.strictEqual(index.size, 1);
    assert.strictEqual(index.get('shared.acme.local').project.id, 'one');
});

test('a stored host name that is no longer valid does not reach the index', () => {
    const index = buildHostIndex([{
        slug: 'acme', tenantPaths: { root: '/t/acme' },
        projects: [{ id: 'one', hostname: 'not a host', port: 3081 }]
    }]);

    assert.strictEqual(index.size, 0);
});
