import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, createPublicKey } from 'node:crypto';
import { readTag, manifestErrors, signManifest, PUBLIC_KEY_PATH } from '../publish-release.mjs';

test('a tag is <id>-v<semver>, split on the last -v', () => {
    assert.deepEqual(readTag('deploy-v0.2.13'), { id: 'deploy', version: '0.2.13' });
    assert.deepEqual(readTag('network-inventory-v1.0.0'), { id: 'network-inventory', version: '1.0.0' });
    for (const bad of ['deploy', 'deploy-v1.2', 'Deploy-v1.0.0', '-v1.0.0', '']) {
        assert.throws(() => readTag(bad), undefined, bad);
    }
});

test('a manifest must describe the zip beside it and the tag it was built for', () => {
    const zip = Buffer.from('zip bytes');
    const good = {
        id: 'deploy', version: '0.2.13', file: 'deploy-0.2.13.zip',
        size: zip.length, sha256: createHash('sha256').update(zip).digest('hex')
    };
    assert.deepEqual(manifestErrors(good, zip, { id: 'deploy', version: '0.2.13' }), []);
    // Another version is two refusals: the version, and the file name it implies.
    assert.equal(manifestErrors(good, zip, { id: 'deploy', version: '0.2.14' }).length, 2);
    assert.equal(manifestErrors(good, Buffer.from('other bytes'), { id: 'deploy', version: '0.2.13' }).length, 2);
    assert.deepEqual(manifestErrors(null, zip, { id: 'deploy', version: '0.2.13' }), ['the manifest is not a JSON object']);
});

test('a signature is published only when it verifies against the trusted key', () => {
    const bytes = Buffer.from('{"id":"deploy"}\n');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const trusted = publicKey.export({ type: 'spki', format: 'pem' });
    const sig = signManifest(bytes, privateKey, trusted);
    assert.ok(Buffer.from(sig, 'base64').length > 0);
    // Any other key signs fine and is still refused: installs would reject it.
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    assert.throws(() => signManifest(bytes, other, trusted), /does not match/);
});

test('the committed public key is a usable RSA key', () => {
    const key = createPublicKey(readFileSync(PUBLIC_KEY_PATH, 'utf8'));
    assert.equal(key.asymmetricKeyType, 'rsa');
});
