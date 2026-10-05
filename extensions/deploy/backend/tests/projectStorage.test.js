/**
 * A project's storage settings: what may be typed, what is kept, what a browser
 * sees, what a process is handed, and which addresses the host approved.
 *
 * The failures worth a test here are the quiet ones. A password that reaches a
 * browser, a password kept for one server and sent to another, a preview handed
 * the live database, and an approved list that a typo empties.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** machineStore keeps its key and the approved list under the data root. */
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-storage-root-'));
process.env.AEGIS_DATA_ROOT = dataRoot;

const projectStorage = require('../projectStorage');

const TARGET = { kind: 'supabase', host: '192.0.2.10', port: 5432, database: 'postgres', user: 'postgres.acme', ssl: false, consoleUrl: 'http://192.0.2.10:8000' };

function saved(password, over) {
    const target = projectStorage.normalise(Object.assign({}, TARGET, over));
    return { id: 'site', storage: projectStorage.withTarget({ id: 'site' }, target, password) };
}

function writeTargets(text) {
    fs.mkdirSync(path.dirname(projectStorage.targetsFile()), { recursive: true });
    fs.writeFileSync(projectStorage.targetsFile(), text);
}

test('normalise keeps a valid target and refuses each bad field by name', () => {
    const t = projectStorage.normalise(TARGET);
    assert.deepStrictEqual(t, Object.assign({}, TARGET, { consoleUrl: 'http://192.0.2.10:8000/' }));

    const cases = [
        [{ kind: 'mysql' }, 'bad_kind'],
        [{ host: 'http://db' }, 'bad_host'],
        [{ host: 'db:5432' }, 'bad_host'],
        [{ host: "db' ; rm" }, 'bad_host'],
        [{ host: '' }, 'bad_host'],
        [{ port: '' }, 'bad_port'],
        [{ port: 70000 }, 'bad_port'],
        [{ port: '54a' }, 'bad_port'],
        [{ database: 'a b' }, 'bad_database'],
        [{ user: "o'brien" }, 'bad_user'],
        [{ consoleUrl: 'javascript:alert(1)' }, 'bad_console_url'],
        [{ consoleUrl: 'not a url' }, 'bad_console_url']
    ];
    for (const [over, code] of cases) {
        assert.throws(() => projectStorage.normalise(Object.assign({}, TARGET, over)),
            (e) => e.code === code, `${JSON.stringify(over)} should be ${code}`);
    }
});

test('a host name, a port as text and an absent console address are accepted', () => {
    const t = projectStorage.normalise({ host: 'db.corp.local', port: '6543', database: 'app', user: 'app_rw' });
    assert.strictEqual(t.kind, 'postgres');
    assert.strictEqual(t.port, 6543);
    assert.strictEqual(t.consoleUrl, '');
    assert.strictEqual(t.ssl, false);
});

test('the password is encrypted at rest and no view returns it', () => {
    const project = saved('s3cret/p@ss');

    assert.ok(!JSON.stringify(project).includes('s3cret'), 'plaintext password in the record');
    const view = projectStorage.publicView(project);
    assert.ok(!JSON.stringify(view).includes('s3cret'));
    assert.strictEqual(view.hasPassword, true);
    assert.strictEqual(view.mode, 'local', 'saving a target does not switch the project');
    assert.strictEqual(projectStorage.passwordOf(project), 's3cret/p@ss');
});

test('an empty password keeps the stored one for the same server only', () => {
    const project = saved('first');

    const same = projectStorage.withTarget(project, projectStorage.normalise(TARGET), '');
    assert.strictEqual(projectStorage.passwordOf({ storage: same }), 'first');

    for (const over of [{ host: '192.0.2.11' }, { port: 6543 }, { user: 'someone_else' }]) {
        const moved = projectStorage.withTarget(project, projectStorage.normalise(Object.assign({}, TARGET, over)), '');
        assert.strictEqual(projectStorage.passwordOf({ storage: moved }), null,
            `a password typed for one server was kept for ${JSON.stringify(over)}`);
    }
});

test('editing the target of a switched project to another database puts it back on local', () => {
    const project = saved('pw');
    project.storage = projectStorage.withMode(project, 'postgres', 'admin@acme.test');
    assert.strictEqual(projectStorage.mode(project), 'postgres');

    const sameDb = projectStorage.withTarget(project, projectStorage.normalise(TARGET), '');
    assert.strictEqual(sameDb.mode, 'postgres');

    const otherDb = projectStorage.withTarget(project, projectStorage.normalise(Object.assign({}, TARGET, { database: 'other' })), '');
    assert.strictEqual(otherDb.mode, 'local', 'a project must not be live on a database no switch ever checked');
});

test('databaseUrl percent-encodes what would move the host', () => {
    const url = projectStorage.databaseUrl(
        { host: 'db.corp.local', port: 5432, database: 'app', user: 'postgres.acme', ssl: true }, 'p@ss/w:rd#1');
    assert.strictEqual(url, 'postgresql://postgres.acme:p%40ss%2Fw%3Ard%231@db.corp.local:5432/app?sslmode=require');
    assert.strictEqual(new URL(url).hostname, 'db.corp.local');
    assert.strictEqual(decodeURIComponent(new URL(url).password), 'p@ss/w:rd#1');
});

test('runtimeEnv hands DATABASE_URL to a switched project and to nothing else', () => {
    const project = saved('pw');
    assert.deepStrictEqual(projectStorage.runtimeEnv(project), {}, 'a saved target is not a switch');

    project.storage = projectStorage.withMode(project, 'postgres', 'admin@acme.test');
    assert.deepStrictEqual(projectStorage.runtimeEnv(project),
        { DATABASE_URL: 'postgresql://postgres.acme:pw@192.0.2.10:5432/postgres' });

    const preview = Object.assign({}, project, { id: 'site-pr', parentId: 'site' });
    assert.deepStrictEqual(projectStorage.runtimeEnv(preview), {}, 'a preview was handed the live database');

    const broken = Object.assign({}, project, { storage: Object.assign({}, project.storage, { passwordEnc: 'not.a.cipher' }) });
    assert.deepStrictEqual(projectStorage.runtimeEnv(broken), {}, 'half an address is worse than none');

    assert.deepStrictEqual(projectStorage.runtimeEnv({ id: 'old' }), {});
});

test('the approved list reads targets, skips comments and survives a bad line', () => {
    assert.deepStrictEqual(projectStorage.approvedTargets(), [], 'no file means nothing is approved');
    assert.strictEqual(projectStorage.isApproved('192.0.2.10', 5432), false);

    writeTargets('﻿# databases sites may reach\r\n192.0.2.10:5432\r\n\r\nthis line is a typo\r\nDB.corp.local:6543  # the pooler\r\n192.0.2.10:99999\r\n');
    assert.deepStrictEqual(projectStorage.approvedTargets(), [
        { host: '192.0.2.10', port: 5432 },
        { host: 'db.corp.local', port: 6543 }
    ]);
    assert.strictEqual(projectStorage.isApproved('192.0.2.10', 5432), true);
    assert.strictEqual(projectStorage.isApproved('db.CORP.local', '6543'), true);
    assert.strictEqual(projectStorage.isApproved('192.0.2.10', 5433), false, 'approving a host is not approving its other ports');
    assert.strictEqual(projectStorage.isApproved('192.0.2.11', 5432), false);
});

test('the approve command names the file and the target, and nothing else', () => {
    const cmd = projectStorage.approveCommand('192.0.2.10', 5432);
    assert.strictEqual(cmd, `Add-Content -Path '${projectStorage.targetsFile()}' -Value '192.0.2.10:5432'`);
    assert.ok(projectStorage.targetsFile().startsWith(path.join(dataRoot, 'deploy')));
});
