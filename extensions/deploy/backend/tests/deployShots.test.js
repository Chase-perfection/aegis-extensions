/**
 * The project card's thumbnail — the parts that hold without a browser.
 *
 * What is deliberately not tested here: the capture itself. It launches a real
 * Chromium against a real port, which is the one thing this suite has no rig
 * for; `pages-smoke.test.js` is the precedent for "a browser test needs a
 * browser". What IS tested is everything the capture depends on being right —
 * where the file lands, that `has()` is honest about a missing or empty one,
 * that a project with no port is refused before a browser is ever launched, and
 * that a failure resolves false instead of throwing into the deployment that
 * called it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const shots = require('../shots');
const projectStore = require('../projectStore');

function tmpTenant() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-shots-'));
    return { root, tenantPaths: { root, deploy: path.join(root, 'deploy') } };
}

test('the shot lands inside the project data folder', () => {
    const { tenantPaths } = tmpTenant();
    const p = shots.shotPath(tenantPaths, 'proj1');
    assert.equal(path.basename(p), 'preview.png');
    assert.equal(path.dirname(p), path.resolve(projectStore.dataDir(tenantPaths, 'proj1')));
});

test('has() is false with no file, and false for an empty one', () => {
    const { tenantPaths } = tmpTenant();
    assert.equal(shots.has(tenantPaths, 'proj1'), false);

    // A zero-byte file is what a crashed write leaves behind. Reporting it as a
    // thumbnail would put a broken image on the card, so it reads as absent.
    const dir = projectStore.ensureDataDir(tenantPaths, 'proj1');
    fs.writeFileSync(path.join(dir, 'preview.png'), '');
    assert.equal(shots.has(tenantPaths, 'proj1'), false);

    fs.writeFileSync(path.join(dir, 'preview.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.equal(shots.has(tenantPaths, 'proj1'), true);
});

test('remove() deletes it and is safe to call twice', () => {
    const { tenantPaths } = tmpTenant();
    const dir = projectStore.ensureDataDir(tenantPaths, 'proj1');
    fs.writeFileSync(path.join(dir, 'preview.png'), Buffer.from([0x89]));
    assert.equal(shots.has(tenantPaths, 'proj1'), true);

    shots.remove(tenantPaths, 'proj1');
    assert.equal(shots.has(tenantPaths, 'proj1'), false);
    assert.doesNotThrow(() => shots.remove(tenantPaths, 'proj1'));
});

test('a project with no port is refused without launching anything', async () => {
    const { tenantPaths } = tmpTenant();
    // No port means nothing is serving, so there is nothing to photograph. This
    // has to short-circuit: a site that never published is the common case, and
    // starting a browser to fail against a closed port on each one would make
    // every deployment on the box slower.
    assert.equal(await shots.capture({ tenantPaths, project: { id: 'proj1' }, slug: 't' }), false);
});

test('a port with no listener open is refused, not photographed', async () => {
    const { tenantPaths } = tmpTenant();
    // Holding a port is not the same as answering on it: `listen` reports a
    // port already taken on its 'error' event rather than by throwing, so a
    // project can carry a port whose bind failed. Nothing is serving here, so
    // the capture gives up on the live check instead of waiting out a
    // navigation timeout against a closed socket.
    const started = Date.now();
    const got = await shots.capture({
        tenantPaths, project: { id: 'proj1', port: 65534 }, slug: 't'
    });
    assert.equal(got, false);
    // It gave up on the serving check (~5s), not on the 15s navigation timeout.
    assert.ok(Date.now() - started < 12000, 'should not have reached a navigation timeout');
});

test('a missing project or tenant resolves false rather than throwing', async () => {
    const { tenantPaths } = tmpTenant();
    // The deployment already succeeded by the time capture runs. Whatever is
    // wrong here, it must not surface as a failed deploy.
    assert.equal(await shots.capture({}), false);
    assert.equal(await shots.capture({ tenantPaths, project: null }), false);
    assert.equal(await shots.capture({ tenantPaths, project: {} }), false);
});

test('captures queue instead of running at once', async () => {
    const { tenantPaths } = tmpTenant();
    // Six projects redeploying together must not mean six Chromiums. Every one
    // of these short-circuits on the missing port, but they still have to come
    // back in order off the one chain rather than racing.
    const order = [];
    await Promise.all([1, 2, 3, 4, 5, 6].map((n) =>
        shots.capture({ tenantPaths, project: { id: 'p' + n }, slug: 't' })
            .then(() => order.push(n))));
    assert.deepEqual(order, [1, 2, 3, 4, 5, 6]);
});
