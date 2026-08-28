/**
 * Tests for the per-site authentication method: the vocabulary, and what the
 * guard does with each value it can read off a project record.
 *
 * The point of this file is one asymmetry. `none` is the only value that may
 * result in a site being served without a login, and every other value -- the
 * one method this build runs, a method a newer Aegis wrote, a word somebody
 * typed into projects.json -- has to stop at the gate. A test suite that only
 * checked "ldap asks for a password" would pass just as happily against a guard
 * that treated every unknown method as open, which is the failure this file
 * exists to catch.
 *
 * `AEGIS_DATA_ROOT` is set before anything is required, for the same reason as
 * in siteAuth.test.js: `machineStore` writes an encryption key on load, and it
 * belongs in a temporary folder rather than in C:\ProgramData\Aegis.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-deploy-methods-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');

const authMethods = require('../authMethods');
const siteAuth = require('../siteAuth');
const authStore = require('../authStore');
const projectStore = require('../projectStore');

// The guard logs every refusal, and half these tests are refusals.
console.log = () => {};
console.warn = () => {};

/* ------------------------------------------------------------------ */
/* helpers, the same shapes siteAuth.test.js uses                       */
/* ------------------------------------------------------------------ */

function fakeReq(method, url) {
    const req = Readable.from([]);
    req.method = method;
    req.url = url;
    req.headers = {};
    req.socket = { remoteAddress: '10.0.0.1' };
    return req;
}

function fakeRes() {
    const res = { statusCode: 0, headers: {}, body: '', ended: false, headersSent: false };
    res.writeHead = function (status, headers) {
        res.statusCode = status;
        Object.assign(res.headers, headers || {});
        res.headersSent = true;
        return res;
    };
    res.end = function (chunk) {
        if (chunk) res.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        res.ended = true;
    };
    return res;
}

function seed(slug, projectId, auth, config) {
    const tenantPaths = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-tenant-')) };
    projectStore.saveProject(tenantPaths, { id: projectId, port: 3081, name: projectId, auth });
    if (config) authStore.writeConfig(tenantPaths, config);
    siteAuth.invalidate(slug, projectId);
    return tenantPaths;
}

const GOOD_CONFIG = {
    url: 'ldap://dc01.corp.local:389',
    baseDn: 'DC=corp,DC=local',
    bindDn: 'CN=svc,DC=corp,DC=local',
    bindPassword: 'service-secret'
};

/** Runs one GET through the gate and reports what the guard decided. */
async function knock(slug, projectId, tenantPaths, url) {
    const res = fakeRes();
    const handled = await siteAuth.gate(fakeReq('GET', url || '/index.html'), res, {
        slug, tenantPaths, project: { id: projectId, name: projectId }
    });
    return { handled, res };
}

/* ------------------------------------------------------------------ */
/* the vocabulary                                                      */
/* ------------------------------------------------------------------ */

test('methods: a record with no auth at all is none', () => {
    assert.strictEqual(authMethods.methodOf(undefined), authMethods.NONE);
    assert.strictEqual(authMethods.methodOf(null), authMethods.NONE);
    assert.strictEqual(authMethods.methodOf({}), authMethods.NONE);
    assert.strictEqual(authMethods.isGated(null), false);
});

test('methods: a record from before the selector reads by its boolean', () => {
    // This is the migration, and it happens on read rather than by rewriting
    // projects.json: every site protected before this feature existed carries
    // exactly this shape.
    assert.strictEqual(authMethods.methodOf({ enabled: true }), authMethods.LDAP);
    assert.strictEqual(authMethods.methodOf({ enabled: false }), authMethods.NONE);
    assert.strictEqual(authMethods.isGated({ enabled: true, allowedGroups: [] }), true);
});

test('methods: an explicit method wins over the boolean beside it', () => {
    // The mirror can only disagree with the method if something wrote the file
    // by hand. The method is the field with the meaning, so it decides.
    assert.strictEqual(authMethods.methodOf({ method: 'none', enabled: true }), authMethods.NONE);
    assert.strictEqual(authMethods.methodOf({ method: 'ldap', enabled: false }), authMethods.LDAP);
});

test('methods: an unknown method is reported as itself and counts as gated', () => {
    // Both halves matter. Reported as itself, so the page can show the operator
    // what is actually stored; gated, so the guard refuses instead of serving.
    assert.strictEqual(authMethods.methodOf({ method: 'saml' }), 'saml');
    assert.strictEqual(authMethods.isGated({ method: 'saml' }), true);
    assert.strictEqual(authMethods.isKnown('saml'), false);
    assert.strictEqual(authMethods.isKnown('ldap'), true);
    assert.strictEqual(authMethods.isKnown('none'), true);
});

test('methods: record() derives the mirror rather than taking one', () => {
    assert.deepStrictEqual(authMethods.record('ldap', ['Domain Admins']),
        { method: 'ldap', enabled: true, audience: 'listed', allowedGroups: ['Domain Admins'], allowedUsers: [] });
    assert.deepStrictEqual(authMethods.record('none', ['Domain Admins']),
        { method: 'none', enabled: false, audience: 'listed', allowedGroups: ['Domain Admins'], allowedUsers: [] });
    // A caller that passes nothing gets an empty list, not undefined: the
    // record goes to JSON and a missing key reads back as "no allow list",
    // which is the widest possible rule.
    assert.deepStrictEqual(authMethods.record('none').allowedGroups, []);
    assert.deepStrictEqual(authMethods.record('none').allowedUsers, []);
});

test('methods: a caller that names no audience gets the pre-audience meaning', () => {
    // The whole back-compatibility promise. A page that predates the field
    // keeps writing two-argument records, and every one has to mean what it
    // meant before: groups named restricts to them, none named opens to the
    // directory.
    assert.strictEqual(authMethods.record('ldap', ['Domain Admins']).audience, 'listed');
    assert.strictEqual(authMethods.record('ldap', []).audience, 'directory');
});

test('methods: audienceOf derives the old rule for a record that predates it', () => {
    assert.strictEqual(authMethods.audienceOf({ method: 'ldap', enabled: true, allowedGroups: [] }), 'directory');
    assert.strictEqual(authMethods.audienceOf({ method: 'ldap', enabled: true, allowedGroups: ['G'] }), 'listed');
    // Stored beats derived, in both directions.
    assert.strictEqual(authMethods.audienceOf({ audience: 'listed', allowedGroups: [] }), 'listed');
    assert.strictEqual(authMethods.audienceOf({ audience: 'directory', allowedGroups: ['G'] }), 'directory');
    // An audience this build has no rule for falls back to the derivation
    // rather than being honoured, for the same reason an unknown method is
    // gated: a value we cannot act on must not decide who gets in.
    assert.strictEqual(authMethods.audienceOf({ audience: 'everyone', allowedGroups: ['G'] }), 'listed');
});

test('methods: usersOf drops a person with no SID', () => {
    // The SID is the only field a login is matched on. An entry without one
    // would show in the panel as an access that can never be exercised.
    const users = authMethods.usersOf({ allowedUsers: [
        { sid: 'S-1-5-21-1-2-3-1103', login: 'PV', name: 'Paul Vue', admin: true },
        { login: 'ghost', name: 'No SID' },
        { sid: '  ', login: 'blank' },
        'not-an-object'
    ] });
    assert.deepStrictEqual(users,
        [{ sid: 'S-1-5-21-1-2-3-1103', login: 'PV', name: 'Paul Vue', admin: true }]);
});

test('methods: admin is a strict boolean, never a truthy value', () => {
    // The flag arrives from a request body. A string promoting somebody is the
    // difference between a reader and the person who runs the site.
    const users = authMethods.usersOf({ allowedUsers: [
        { sid: 'S-1-5-21-1-2-3-1', admin: 'yes' },
        { sid: 'S-1-5-21-1-2-3-2', admin: 1 },
        { sid: 'S-1-5-21-1-2-3-3', admin: true }
    ] });
    assert.deepStrictEqual(users.map((u) => u.admin), [false, false, true]);
});

/* ------------------------------------------------------------------ */
/* what the gate does with each of them                                */
/* ------------------------------------------------------------------ */

test('gate: method none serves the site, directory or no directory', async () => {
    const slug = 'm-none';
    const tenantPaths = seed(slug, 'open', { method: 'none', allowedGroups: [] }, GOOD_CONFIG);
    const { handled, res } = await knock(slug, 'open', tenantPaths);
    assert.strictEqual(handled, false, 'the file server must take over');
    assert.strictEqual(res.headersSent, false);
});

test('gate: method none still reserves the /__aegis/ prefix', async () => {
    // Otherwise a repository could ship __aegis/login.html and paint its own
    // form on the path the browser trusts the moment the site is protected.
    const slug = 'm-none2';
    const tenantPaths = seed(slug, 'open2', { method: 'none', allowedGroups: [] }, null);
    const { handled, res } = await knock(slug, 'open2', tenantPaths, '/__aegis/login');
    assert.strictEqual(handled, true);
    assert.strictEqual(res.statusCode, 404);
});

test('gate: method ldap sends an anonymous visitor to the login', async () => {
    const slug = 'm-ldap';
    const tenantPaths = seed(slug, 'gated', { method: 'ldap', allowedGroups: [] }, GOOD_CONFIG);
    const { handled, res } = await knock(slug, 'gated', tenantPaths);
    assert.strictEqual(handled, true);
    assert.strictEqual(res.statusCode, 302);
    assert.match(String(res.headers.Location || res.headers.location), /^\/__aegis\/login\?next=/);
});

test('gate: method ldap with no directory configured fails closed', async () => {
    const slug = 'm-ldap-noconf';
    const tenantPaths = seed(slug, 'gated2', { method: 'ldap', allowedGroups: [] }, null);
    for (const url of ['/', '/index.html', '/__aegis/login']) {
        const { handled, res } = await knock(slug, 'gated2', tenantPaths, url);
        assert.strictEqual(handled, true, `${url} must never reach the file server`);
        assert.strictEqual(res.statusCode, 503, `${url} must fail closed`);
    }
});

test('gate: a method this build cannot serve is refused, never served', async () => {
    // The record a newer Aegis would write, or a hand edit. The wrong answer
    // here is 200: it would publish the very site somebody asked to protect.
    const slug = 'm-unknown';
    const tenantPaths = seed(slug, 'future', { method: 'saml', allowedGroups: [] }, GOOD_CONFIG);
    for (const url of ['/', '/index.html', '/assets/app.js', '/__aegis/login']) {
        const { handled, res } = await knock(slug, 'future', tenantPaths, url);
        assert.strictEqual(handled, true, `${url} must not reach the file server`);
        assert.strictEqual(res.statusCode, 503, `${url} must fail closed`);
    }
});

test('gate: an empty or malformed method is read as none, not as a gate', async () => {
    // An empty string is what a form posts when nothing was chosen, and a
    // record carrying one has never been protected. Reading it as a gate would
    // take down a site that was working, which is the opposite failure from
    // the one above and just as bad.
    const slug = 'm-empty';
    const tenantPaths = seed(slug, 'blank', { method: '', allowedGroups: [] }, GOOD_CONFIG);
    const { handled } = await knock(slug, 'blank', tenantPaths);
    assert.strictEqual(handled, false);
});

test('gate: the login stylesheet is served under an unknown method too', async () => {
    // The refusal page links it, and a 503 nobody can read is a support call.
    const slug = 'm-unknown-css';
    const tenantPaths = seed(slug, 'future2', { method: 'saml', allowedGroups: [] }, GOOD_CONFIG);
    const { handled, res } = await knock(slug, 'future2', tenantPaths, '/__aegis/login.css');
    assert.strictEqual(handled, true);
    assert.strictEqual(res.statusCode, 200);
    assert.match(String(res.headers['Content-Type']), /^text\/css/);
});

test('gate: switching a record from ldap to none frees the site on the next request', async () => {
    const slug = 'm-switch';
    const tenantPaths = seed(slug, 'site', { method: 'ldap', allowedGroups: [] }, GOOD_CONFIG);
    assert.strictEqual((await knock(slug, 'site', tenantPaths)).handled, true);

    const project = projectStore.getProject(tenantPaths, 'site');
    project.auth = authMethods.record('none', []);
    projectStore.saveProject(tenantPaths, project);
    siteAuth.invalidate(slug, 'site');

    assert.strictEqual((await knock(slug, 'site', tenantPaths)).handled, false);
});
