/**
 * What a manifest in the clone may change under a project that already exists.
 *
 * Split deliberately. The build keys take effect on the next deployment and
 * nothing else moves. The runtime keys move a database or turn a static site
 * into a process, so they are reported here and applied only through the
 * settings route, where an operator is looking at the consequence.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const live = require('../manifestLive');

const PROJECT = {
    id: 'site-a',
    runtime: 'static',
    installCmd: 'npm ci',
    buildCmd: null,
    outputDir: null,
    rootDir: null,
    startCmd: null,
    dbFile: null,
    migrationsDir: null
};

test('a build key the branch changed is applied', () => {
    const r = live.apply(PROJECT, { buildCmd: 'npm run build' });
    assert.strictEqual(r.changed.buildCmd, 'npm run build');
    assert.deepStrictEqual(r.applied, ['buildCmd']);
    assert.deepStrictEqual(r.reported, []);
});

test('a build key that matches the record changes nothing', () => {
    const r = live.apply(PROJECT, { installCmd: 'npm ci' });
    assert.deepStrictEqual(r.applied, []);
    assert.deepStrictEqual(r.changed, {});
});

test('a runtime key is reported, never applied behind a running project', () => {
    const r = live.apply(PROJECT, { startCmd: 'node server.js' });
    assert.deepStrictEqual(r.applied, []);
    assert.deepStrictEqual(r.reported, ['startCmd']);
    assert.deepStrictEqual(r.changed, {},
        'a static project was turned into a process by a file in a branch');
});

test('a manifest that declares nothing changes nothing', () => {
    const r = live.apply(PROJECT, {});
    assert.deepStrictEqual(r.applied, []);
    assert.deepStrictEqual(r.reported, []);
});

test('the sentence for the console names the keys and where they came from', () => {
    const r = live.apply(PROJECT, { buildCmd: 'npm run build', startCmd: 'node s.js' });
    assert.match(r.say, /buildCmd/);
    assert.match(r.say, /startCmd/);
    assert.match(r.say, /Settings/, 'the operator is not told where to act on the rest');
});

const fs = require('fs');
const os = require('os');
const path = require('path');

test('read() takes the manifest out of a clone, and refuses a broken one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-live-'));
    assert.deepStrictEqual(live.read(dir), { ok: true, config: {}, error: null },
        'a branch with no manifest is not a fault');

    fs.writeFileSync(path.join(dir, 'aegis.deploy.json'),
        JSON.stringify({ buildCmd: 'npm run build' }));
    assert.deepStrictEqual(live.read(dir).config, { buildCmd: 'npm run build' });

    fs.writeFileSync(path.join(dir, 'aegis.deploy.json'), '{ broken');
    const bad = live.read(dir);
    assert.strictEqual(bad.ok, false);
    assert.ok(bad.error, 'a refusal with no reason');
});
