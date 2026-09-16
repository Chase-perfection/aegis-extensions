/**
 * `aegis.deploy.json`, the file that saves an operator eight fields.
 *
 * The rule it inherits from `vercel.json` and `aegis.access.json` is that a file
 * which will not parse refuses rather than being ignored, because a project
 * whose declared settings were dropped looks exactly like one whose settings
 * were wrong. The rule it adds is that the form wins: the manifest answers only
 * what the operator left empty, so a field somebody is looking at is never
 * overruled from inside the repository.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const manifest = require('../deployManifest');

const KPI = JSON.stringify({
    installCmd: 'pip install --no-cache-dir -r packaging/api/requirements.txt --target .',
    startCmd: 'python packaging/api/kpi_api.py',
    dbFile: 'kpi.db',
    migrationsDir: 'migrations'
});

test('no file is a repository with nothing to declare, not a fault', () => {
    for (const nothing of [null, undefined]) {
        const r = manifest.parse(nothing);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.present, false);
        assert.deepStrictEqual(r.config, {});
    }
});

test('the KPI case: four fields declared by the branch', () => {
    const r = manifest.parse(KPI);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.present, true);
    assert.deepStrictEqual(r.config, {
        installCmd: 'pip install --no-cache-dir -r packaging/api/requirements.txt --target .',
        startCmd: 'python packaging/api/kpi_api.py',
        dbFile: 'kpi.db',
        migrationsDir: 'migrations'
    });
    assert.deepStrictEqual(r.unsupported, []);
});

test('an empty form takes everything from the branch', () => {
    const { values, from } = manifest.merge(
        { installCmd: '', buildCmd: '', startCmd: '', dbFile: '', migrationsDir: '' },
        manifest.parse(KPI).config);
    assert.strictEqual(values.startCmd, 'python packaging/api/kpi_api.py');
    assert.strictEqual(values.dbFile, 'kpi.db');
    assert.deepStrictEqual(from.sort(), ['dbFile', 'installCmd', 'migrationsDir', 'startCmd']);
});

test('what the operator typed is never overruled by the branch', () => {
    const { values, from } = manifest.merge(
        { startCmd: 'python other.py', dbFile: '' },
        manifest.parse(KPI).config);
    assert.strictEqual(values.startCmd, 'python other.py',
        'a field the operator is looking at was changed from inside the repository');
    assert.strictEqual(values.dbFile, 'kpi.db');
    assert.ok(!from.includes('startCmd'));
    assert.ok(from.includes('dbFile'));
});

test('whitespace in the form is not a filled field', () => {
    const { values } = manifest.merge({ startCmd: '   ' }, manifest.parse(KPI).config);
    assert.strictEqual(values.startCmd, 'python packaging/api/kpi_api.py');
});

test('a file that will not parse refuses, it is not ignored', () => {
    for (const bad of ['{', 'not json', '[]', '"a string"', '42']) {
        const r = manifest.parse(bad);
        assert.strictEqual(r.ok, false, `${JSON.stringify(bad)} was accepted`);
        assert.ok(r.error, 'a refusal with no reason');
        assert.deepStrictEqual(r.config, {}, 'a refused file still handed values over');
    }
});

test('a key with the wrong type refuses rather than being coerced', () => {
    const r = manifest.parse(JSON.stringify({ startCmd: ['python', 'x.py'] }));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /startCmd must be a string/);
});

test('a path that leaves the repository refuses', () => {
    for (const evil of ['../secrets', 'a/../../b', '/etc/passwd', 'C:\\Windows', '..\\up']) {
        const r = manifest.parse(JSON.stringify({ migrationsDir: evil }));
        assert.strictEqual(r.ok, false, `${evil} was accepted as a path`);
    }
});

test('an ordinary nested path is accepted', () => {
    const r = manifest.parse(JSON.stringify({ rootDir: 'apps/site/dist', dbFile: 'data/kpi.db' }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.config.rootDir, 'apps/site/dist');
    assert.strictEqual(r.config.dbFile, 'data/kpi.db');
});

test('a command longer than the cap refuses', () => {
    const r = manifest.parse(JSON.stringify({ installCmd: 'x'.repeat(manifest.MAX_CMD + 1) }));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /longer than/);
});

test('a key Aegis does not read is named, not dropped in silence', () => {
    const r = manifest.parse(JSON.stringify({ startCmd: 'node x.js', regions: ['cdg1'], cron: '* * * * *' }));
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.unsupported.sort(), ['cron', 'regions']);
});

test('a declared empty string declares nothing, and does not blank the form', () => {
    const r = manifest.parse(JSON.stringify({ startCmd: '', dbFile: 'kpi.db' }));
    assert.strictEqual(r.ok, true);
    assert.ok(!('startCmd' in r.config));
    const { values } = manifest.merge({ startCmd: 'python keep.py' }, r.config);
    assert.strictEqual(values.startCmd, 'python keep.py');
});
