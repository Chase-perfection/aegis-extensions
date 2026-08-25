/**
 * Environment variables for a deployed project: what they may be called, where
 * the value sits when nobody is looking at it, and which build sees it.
 *
 * Three things here fail quietly if they break. A value stored in clear is a
 * secret in a JSON file inside a OneDrive-synchronised tree. A key that
 * shadows the sandbox baseline (`PATH`, `ComSpec`) is a build escaping the
 * restriction it was given. And a preview-only value leaking into a production
 * build is the wrong database in front of the wrong people.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectEnv = require('../projectEnv');
const { buildSafeEnv } = require('../build/launcher');

/**
 * machineStore keeps its key file under the data root, so the tests get their
 * own root and never touch the machine's real one.
 */
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-env-root-'));
process.env.AEGIS_DATA_ROOT = dataRoot;

function withEnv(entries) {
    return projectEnv.setMany({ id: 'site', env: [] }, entries);
}

test('a value is encrypted at rest and list never returns it', () => {
    const env = withEnv([{ key: 'API_TOKEN', value: 'sk-live-42', target: 'all' }]);

    const stored = JSON.stringify(env);
    assert.ok(!stored.includes('sk-live-42'), 'plaintext value found in the stored record');
    assert.ok(env[0].valueEnc && env[0].valueEnc.split('.').length === 3);

    const listed = projectEnv.list({ env });
    assert.deepStrictEqual(Object.keys(listed[0]).sort(), ['key', 'target', 'updatedAt']);
    assert.strictEqual(listed[0].key, 'API_TOKEN');
});

test('setMany upserts one key and leaves the others alone', () => {
    const first = withEnv([
        { key: 'ONE', value: '1', target: 'all' },
        { key: 'TWO', value: '2', target: 'all' }
    ]);
    const second = projectEnv.setMany({ id: 'site', env: first },
        [{ key: 'TWO', value: 'two', target: 'preview' }]);

    assert.strictEqual(second.length, 2);
    const values = projectEnv.forBuild({ env: second }, { target: 'preview' });
    assert.strictEqual(values.ONE, '1');
    assert.strictEqual(values.TWO, 'two');
});

test('a key that is not a plain environment name is refused', () => {
    for (const key of ['', '2FA', 'my-key', 'A B', 'a.b']) {
        assert.throws(() => withEnv([{ key, value: 'x' }]), { code: 'bad_env_key' }, `accepted ${key}`);
    }
});

test('a key that shadows the sandbox baseline or Aegis itself is refused', () => {
    for (const key of ['PATH', 'Path', 'ComSpec', 'SystemRoot', 'TEMP', 'PSModulePath',
        'AEGIS_BUILD_ACCOUNT_SECRET', 'AEGIS_ENV']) {
        assert.throws(() => withEnv([{ key, value: 'x' }]), { code: 'reserved_env_key' }, `accepted ${key}`);
    }
});

test('a value past the cap and a project past the count are refused', () => {
    assert.throws(() => withEnv([{ key: 'BIG', value: 'x'.repeat(4097) }]), { code: 'env_value_too_long' });

    const many = [];
    for (let n = 0; n < 51; n++) many.push({ key: `K${n}`, value: 'v' });
    assert.throws(() => withEnv(many), { code: 'env_too_many' });
});

test('a production build sees all and production, never preview', () => {
    const env = withEnv([
        { key: 'SHARED', value: 's', target: 'all' },
        { key: 'PROD', value: 'p', target: 'production' },
        { key: 'PREV', value: 'q', target: 'preview' }
    ]);

    const production = projectEnv.forBuild({ env }, { target: 'production' });
    assert.strictEqual(production.SHARED, 's');
    assert.strictEqual(production.PROD, 'p');
    assert.strictEqual(production.PREV, undefined);

    const preview = projectEnv.forBuild({ env }, { target: 'preview' });
    assert.strictEqual(preview.PREV, 'q');
    assert.strictEqual(preview.PROD, undefined);
});

test('forBuild sets the built-ins, and a project CI overrides the default', () => {
    const bare = projectEnv.forBuild({ env: [] }, { target: 'production', sha: 'abc123', branch: 'main' });
    assert.strictEqual(bare.CI, '1');
    assert.strictEqual(bare.AEGIS_DEPLOY, '1');
    assert.strictEqual(bare.AEGIS_ENV, 'production');
    assert.strictEqual(bare.AEGIS_GIT_COMMIT_SHA, 'abc123');
    assert.strictEqual(bare.AEGIS_GIT_BRANCH, 'main');

    const overridden = projectEnv.forBuild({ env: withEnv([{ key: 'CI', value: 'false' }]) },
        { target: 'production' });
    assert.strictEqual(overridden.CI, 'false');
});

test('a value that will not decrypt is dropped rather than passed as null', () => {
    const env = [{ key: 'BROKEN', valueEnc: 'not.valid.ciphertext', target: 'all', updatedAt: 1 }];
    const values = projectEnv.forBuild({ env }, { target: 'production' });
    assert.strictEqual('BROKEN' in values, false);
});

test('remove drops one key and reports whether it was there', () => {
    const env = withEnv([{ key: 'ONE', value: '1' }, { key: 'TWO', value: '2' }]);

    const gone = projectEnv.remove({ env }, 'ONE');
    assert.strictEqual(gone.removed, true);
    assert.deepStrictEqual(gone.env.map((e) => e.key), ['TWO']);

    assert.strictEqual(projectEnv.remove({ env: gone.env }, 'ONE').removed, false);
});

test('the launcher carries the build env as one blob and nothing else from the backend', () => {
    process.env.AEGIS_SECRET_NOT_FOR_BUILDS = 'leaked';
    try {
        const env = buildSafeEnv('pw', { API_TOKEN: 'sk-live-42' });
        assert.strictEqual(env.AEGIS_BUILD_ACCOUNT_SECRET, 'pw');
        assert.deepStrictEqual(JSON.parse(env.AEGIS_BUILD_ENV_JSON), { API_TOKEN: 'sk-live-42' });
        assert.strictEqual(env.AEGIS_SECRET_NOT_FOR_BUILDS, undefined);

        assert.strictEqual(buildSafeEnv('pw').AEGIS_BUILD_ENV_JSON, undefined);
        assert.strictEqual(buildSafeEnv('pw', {}).AEGIS_BUILD_ENV_JSON, undefined);
    } finally {
        delete process.env.AEGIS_SECRET_NOT_FOR_BUILDS;
    }
});
