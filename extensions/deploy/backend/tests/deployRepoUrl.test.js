/**
 * Parsing what an operator pastes, and handing out ports.
 *
 * `parseRepoUrl` decides which repository gets cloned, so a wrong answer clones
 * something that is not theirs, and a null answer that should have parsed makes
 * the feature look broken for a perfectly ordinary URL.
 *
 * `allocatePort` has to be unique across tenants, because ports are a machine
 * resource while projects are per tenant. Handing the same port to two projects
 * means the second listener fails to bind and one site is silently dead.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseRepoUrl } = require('../github');
const { allocatePort, portBase, PORT_RANGE } = require('../siteServer');

test('every shape an operator is likely to paste resolves to owner/repo', () => {
    const expected = 'Chase-perfection/aegis';
    for (const input of [
        'https://github.com/Chase-perfection/aegis',
        'https://github.com/Chase-perfection/aegis/',
        'https://github.com/Chase-perfection/aegis.git',
        'http://github.com/Chase-perfection/aegis',
        'https://github.com/Chase-perfection/aegis/tree/main/docs',
        'https://github.com/Chase-perfection/aegis/pull/12',
        'git@github.com:Chase-perfection/aegis.git',
        'Chase-perfection/aegis',
        '  https://github.com/Chase-perfection/aegis  '
    ]) {
        const parsed = parseRepoUrl(input);
        assert.ok(parsed, `${input} must parse`);
        assert.strictEqual(parsed.fullName, expected, input);
    }
});

test('anything that is not a GitHub repository is refused', () => {
    for (const input of [
        '', null, undefined,
        'https://gitlab.com/owner/repo',
        'https://github.com/owner',
        'https://example.com/github.com/owner/repo',
        'not a url at all',
        'owner/repo/extra/deep',
        // A host that only looks like GitHub.
        'https://github.com.evil.test/owner/repo'
    ]) {
        assert.strictEqual(parseRepoUrl(input), null, `${input} must be refused`);
    }
});

// `..` in either half would travel into an API path and a clone URL.
test('path segments cannot be traversal', () => {
    assert.strictEqual(parseRepoUrl('https://github.com/../repo'), null);
    assert.strictEqual(parseRepoUrl('../..'), null);
});

function fakeTenants(projectsBySlug) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-ports-'));
    for (const [slug, projects] of Object.entries(projectsBySlug)) {
        const dir = path.join(root, slug, 'deploy');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({ projects }));
    }
    const pathsFor = (slug) => {
        if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('invalid slug');
        return { root: path.join(root, slug), data: path.join(root, slug, 'data') };
    };
    return { tenantsRoot: () => root, pathsFor };
}

test('the first project gets the base port', () => {
    const { tenantsRoot, pathsFor } = fakeTenants({ live: [] });
    assert.strictEqual(allocatePort({ pathsFor, tenantsRoot }), portBase());
});

test('a port in use by another tenant is not handed out again', () => {
    const base = portBase();
    const { tenantsRoot, pathsFor } = fakeTenants({
        live: [{ id: 'a', port: base }],
        other: [{ id: 'b', port: base + 1 }]
    });
    assert.strictEqual(allocatePort({ pathsFor, tenantsRoot }), base + 2,
        'ports are a machine resource, so every tenant counts');
});

test('a gap left by a deleted project is reused', () => {
    const base = portBase();
    const { tenantsRoot, pathsFor } = fakeTenants({
        live: [{ id: 'a', port: base }, { id: 'c', port: base + 2 }]
    });
    assert.strictEqual(allocatePort({ pathsFor, tenantsRoot }), base + 1);
});

test('a full range refuses rather than colliding', () => {
    const base = portBase();
    const projects = [];
    for (let i = 0; i < PORT_RANGE; i++) projects.push({ id: 'p' + i, port: base + i });
    const { tenantsRoot, pathsFor } = fakeTenants({ live: projects });
    assert.throws(() => allocatePort({ pathsFor, tenantsRoot }), (e) => e.code === 'no_free_port');
});
