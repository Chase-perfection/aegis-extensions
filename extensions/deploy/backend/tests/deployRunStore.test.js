/**
 * Deployment history that survives a restart.
 *
 * The build console lives in memory while a deployment runs, which is right: it
 * is watched for two minutes and never again. What was wrong is that a restart
 * took the record with it, so "why did the site stop updating last Thursday"
 * had no answer at all.
 *
 * Two things to keep out. A run id reaches `path.join`, so an id that is not an
 * id must be refused before it gets there. And a tenant's folder must hold only
 * that tenant's runs: the store is handed `tenantPaths` by the caller and never
 * joins a slug into a path itself, which is the rule in the root CLAUDE.md.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runStore = require('../runStore');

function tenant() {
    return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-runstore-')) };
}

function view(over) {
    return Object.assign({
        id: 'abcdef0123456789',
        projectId: 'site',
        projectName: 'site',
        branch: 'main',
        sha: 'aaaaaaa',
        trigger: 'manual',
        actor: 'someone@example.com',
        status: 'ready',
        error: null,
        startedAt: 1000,
        endedAt: 4000,
        stages: [{ key: 'clone', status: 'done', startedAt: 1000, endedAt: 2000, detail: 'git clone' }],
        lines: [{ at: 1500, text: 'first' }, { at: 1600, text: 'second' }]
    }, over || {});
}

test('a finished run is readable after the process that ran it is gone', () => {
    const paths = tenant();
    runStore.save(paths, view());

    const back = runStore.read(paths, 'abcdef0123456789');
    assert.strictEqual(back.status, 'ready');
    assert.strictEqual(back.branch, 'main');
    assert.deepStrictEqual(back.lines.map((l) => l.text), ['first', 'second']);
    assert.strictEqual(back.stages[0].detail, 'git clone');
    // The console polls with a cursor, and a stored run answers the same shape
    // a live one does.
    assert.strictEqual(back.cursor, 2);
    assert.strictEqual(back.resync, false);
});

test('the cursor skips lines the console already has', () => {
    const paths = tenant();
    runStore.save(paths, view());

    assert.deepStrictEqual(runStore.read(paths, 'abcdef0123456789', 1).lines.map((l) => l.text), ['second']);
    assert.deepStrictEqual(runStore.read(paths, 'abcdef0123456789', 9).lines, []);
});

test('an id that is not an id reads and writes nothing', () => {
    const paths = tenant();
    for (const id of ['../../etc/passwd', 'a', '', 'has space', 'x'.repeat(80)]) {
        assert.strictEqual(runStore.read(paths, id), null, `read ${id}`);
        assert.strictEqual(runStore.save(paths, view({ id })), false, `save ${id}`);
    }
    assert.strictEqual(runStore.listRecent(paths).length, 0);
});

test('a run with no id is not a run', () => {
    const paths = tenant();
    assert.strictEqual(runStore.save(paths, null), false);
    assert.strictEqual(runStore.save(paths, {}), false);
});

test('the list is newest first and carries no log lines', () => {
    const paths = tenant();
    runStore.save(paths, view({ id: 'aaaaaaaaaaaaaaaa', startedAt: 1000 }));
    runStore.save(paths, view({ id: 'bbbbbbbbbbbbbbbb', startedAt: 3000 }));
    runStore.save(paths, view({ id: 'cccccccccccccccc', startedAt: 2000 }));

    const list = runStore.listRecent(paths, 10);
    assert.deepStrictEqual(list.map((r) => r.id),
        ['bbbbbbbbbbbbbbbb', 'cccccccccccccccc', 'aaaaaaaaaaaaaaaa']);
    assert.deepStrictEqual(list[0].lines, []);
});

test('one project at a time, when the list is asked for one', () => {
    const paths = tenant();
    runStore.save(paths, view({ id: 'aaaaaaaaaaaaaaaa', projectId: 'one' }));
    runStore.save(paths, view({ id: 'bbbbbbbbbbbbbbbb', projectId: 'two' }));

    assert.deepStrictEqual(runStore.listForProject(paths, 'two').map((r) => r.id), ['bbbbbbbbbbbbbbbb']);
});

test('the oldest runs are dropped past the cap', () => {
    const paths = tenant();
    for (let n = 0; n < runStore.MAX_KEPT + 5; n++) {
        runStore.save(paths, view({ id: String(n).padStart(16, '0'), startedAt: 1000 + n }));
    }

    const list = runStore.listRecent(paths, 1000);
    assert.strictEqual(list.length, runStore.MAX_KEPT);
    assert.strictEqual(list[0].startedAt, 1000 + runStore.MAX_KEPT + 4, 'the newest run was dropped');
    assert.strictEqual(runStore.read(paths, String(0).padStart(16, '0')), null, 'the oldest run was kept');
});

test('a deleted project takes its history with it', () => {
    const paths = tenant();
    runStore.save(paths, view({ id: 'aaaaaaaaaaaaaaaa', projectId: 'one' }));
    runStore.save(paths, view({ id: 'bbbbbbbbbbbbbbbb', projectId: 'two' }));

    runStore.dropProject(paths, 'one');
    assert.deepStrictEqual(runStore.listRecent(paths, 10).map((r) => r.id), ['bbbbbbbbbbbbbbbb']);
    assert.strictEqual(runStore.read(paths, 'aaaaaaaaaaaaaaaa'), null);
});

test('a file that is not a run is ignored rather than fatal', () => {
    const paths = tenant();
    runStore.save(paths, view());
    fs.writeFileSync(path.join(paths.root, 'deploy', 'runs', 'notes.txt'), 'left by hand');
    fs.writeFileSync(path.join(paths.root, 'deploy', 'runs', 'dddddddddddddddd.json'), '{ broken');

    assert.deepStrictEqual(runStore.listRecent(paths, 10).map((r) => r.id), ['abcdef0123456789']);
    assert.strictEqual(runStore.read(paths, 'dddddddddddddddd'), null);
});
