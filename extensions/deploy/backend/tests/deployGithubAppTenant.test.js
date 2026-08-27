/**
 * A GitHub App registration belongs to one tenant.
 *
 * It used to be stored once per machine, which meant any tenant admin on a
 * shared host could list another tenant's GitHub installations and mint a token
 * for its private repositories. These tests pin the boundary that closed it,
 * and the migration that moves an existing registration across:
 *
 * - a registration saved for one slug is invisible to every other slug
 * - two tenants coexist without overwriting each other
 * - a slug the store will not key is refused rather than silently dropped
 * - the legacy machine-wide record moves to the sole tenant of a single-tenant
 *   host, and is set aside rather than handed out on a multi-tenant one
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** A fresh data root per test, so no case can read what another wrote. */
function withStore(fn) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-ghapp-'));
    const oldRoot = process.env.AEGIS_DATA_ROOT;
    process.env.AEGIS_DATA_ROOT = tempDir;
    delete require.cache[require.resolve('../machineStore')];
    const machineStore = require('../machineStore');
    try {
        return fn(machineStore, tempDir);
    } finally {
        process.env.AEGIS_DATA_ROOT = oldRoot;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function storeJson(tempDir) {
    return JSON.parse(fs.readFileSync(path.join(tempDir, 'deploy', 'machine.json'), 'utf8'));
}

const KEY_A = '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----';
const KEY_B = '-----BEGIN RSA PRIVATE KEY-----\nBBBB\n-----END RSA PRIVATE KEY-----';

test('a registration is readable only by the tenant that made it', () => {
    withStore((machineStore) => {
        machineStore.saveGitHubApp('acme', { appId: 111, slug: 'aegis-deploy-acme', privateKey: KEY_A });

        const mine = machineStore.getGitHubApp('acme');
        assert.strictEqual(mine.appId, 111);
        assert.strictEqual(mine.privateKey, KEY_A);

        assert.strictEqual(machineStore.getGitHubApp('other'), null,
            'another tenant on the same host must not see this registration');
        assert.strictEqual(machineStore.getGitHubApp(''), null);
        assert.strictEqual(machineStore.getGitHubApp(undefined), null);
    });
});

test('two tenants keep separate Apps and separate keys', () => {
    withStore((machineStore, tempDir) => {
        machineStore.saveGitHubApp('acme', { appId: 111, privateKey: KEY_A });
        machineStore.saveGitHubApp('globex', { appId: 222, privateKey: KEY_B });

        assert.strictEqual(machineStore.getGitHubApp('acme').privateKey, KEY_A);
        assert.strictEqual(machineStore.getGitHubApp('globex').privateKey, KEY_B);
        assert.strictEqual(machineStore.getGitHubApp('acme').appId, 111);
        assert.strictEqual(machineStore.getGitHubApp('globex').appId, 222);

        const raw = storeJson(tempDir);
        assert.deepStrictEqual(Object.keys(raw.githubApps).sort(), ['acme', 'globex']);
        assert.ok(!raw.githubApp, 'nothing may be written at the old machine-wide key');
        // The point of the file living outside the tenant tree is that the key
        // is sealed. A plaintext PEM here would defeat it whatever the scoping.
        assert.ok(!JSON.stringify(raw).includes('BEGIN RSA PRIVATE KEY'),
            'private keys must be stored as ciphertext');
    });
});

test('clearGitHubApp forgets one tenant and leaves the other alone', () => {
    withStore((machineStore) => {
        machineStore.saveGitHubApp('acme', { appId: 111, privateKey: KEY_A });
        machineStore.saveGitHubApp('globex', { appId: 222, privateKey: KEY_B });

        assert.strictEqual(machineStore.clearGitHubApp('acme'), true);
        assert.strictEqual(machineStore.getGitHubApp('acme'), null);
        assert.strictEqual(machineStore.getGitHubApp('globex').appId, 222);
        assert.strictEqual(machineStore.clearGitHubApp('acme'), false, 'a second clear is a no-op');
    });
});

test('a slug the store will not key is refused, not silently dropped', () => {
    withStore((machineStore) => {
        for (const bad of ['__proto__', 'Has Spaces', '../escape', 'UPPER', '-leading']) {
            assert.throws(
                () => machineStore.saveGitHubApp(bad, { appId: 1, privateKey: KEY_A }),
                /refusing to store a GitHub App/,
                `${bad} must be refused`
            );
        }
        // The prototype must be untouched by the attempt above.
        assert.strictEqual(machineStore.getGitHubApp('anything'), null);
        assert.strictEqual({}.appId, undefined);
    });
});

test('publicStatus reports connection per tenant and never leaks a secret', () => {
    withStore((machineStore) => {
        machineStore.saveGitHubApp('acme', { appId: 111, slug: 'aegis-deploy-acme', privateKey: KEY_A });

        const mine = machineStore.publicStatus('acme');
        assert.strictEqual(mine.github.connected, true);
        assert.strictEqual(mine.github.appId, 111);
        assert.ok(!('privateKey' in mine.github), 'no key may reach a browser payload');
        assert.ok(!JSON.stringify(mine).includes('PRIVATE KEY'));

        assert.strictEqual(machineStore.publicStatus('globex').github.connected, false);
    });
});

test('a legacy machine-wide App moves to the sole tenant of a single-tenant host', () => {
    withStore((machineStore, tempDir) => {
        // Written the old way: one record at the top level, no owner recorded.
        machineStore.saveGitHubApp('acme', { appId: 111, privateKey: KEY_A });
        const raw = storeJson(tempDir);
        raw.githubApp = raw.githubApps.acme;
        delete raw.githubApps;
        fs.writeFileSync(path.join(tempDir, 'deploy', 'machine.json'), JSON.stringify(raw));

        assert.strictEqual(machineStore.getGitHubApp('acme'), null, 'nothing is readable before the migration');

        assert.strictEqual(machineStore.migrateLegacyGitHubApp(['acme']), 'acme');
        assert.strictEqual(machineStore.getGitHubApp('acme').privateKey, KEY_A,
            'the key must survive the move, still decryptable');
        assert.ok(!storeJson(tempDir).githubApp, 'the legacy key must be gone');

        // Runs at every boot, so a second pass must change nothing.
        assert.strictEqual(machineStore.migrateLegacyGitHubApp(['acme']), null);
        assert.strictEqual(machineStore.getGitHubApp('acme').appId, 111);
    });
});

test('a legacy App on a multi-tenant host is set aside, not handed to anyone', () => {
    withStore((machineStore, tempDir) => {
        machineStore.saveGitHubApp('acme', { appId: 111, privateKey: KEY_A });
        const raw = storeJson(tempDir);
        raw.githubApp = raw.githubApps.acme;
        delete raw.githubApps;
        fs.writeFileSync(path.join(tempDir, 'deploy', 'machine.json'), JSON.stringify(raw));

        assert.strictEqual(machineStore.migrateLegacyGitHubApp(['acme', 'globex']), null);

        assert.strictEqual(machineStore.getGitHubApp('acme'), null,
            'an unattributable registration must not be given to a tenant');
        assert.strictEqual(machineStore.getGitHubApp('globex'), null);

        const after = storeJson(tempDir);
        assert.ok(!after.githubApp, 'the legacy key must not stay readable');
        assert.ok(after.githubAppUnattributed, 'the record is parked, not destroyed');
        assert.strictEqual(after.githubAppUnattributed.appId, 111);
    });
});
