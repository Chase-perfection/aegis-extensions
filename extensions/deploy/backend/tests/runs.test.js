/**
 * The two pieces of the build console that can be wrong quietly.
 *
 * The ring buffer's cursor is one: a console that splices a hole into a log
 * still looks like a log, and the operator reads a build that never happened.
 * The other is the run that exists before its project has an id, which is how
 * the create route works and how a console can be open on a deployment that has
 * not been accepted yet.
 *
 * The folder swaps that used to be tested here moved to
 * `backend/tests/deployReleases.test.js` when `previous/` became a release
 * folder. That path is the one `npm test` runs on every commit.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runs = require('../runs');

function newRun(projectId) {
    return runs.start({
        slug: 'acme',
        projectId,
        projectName: projectId,
        branch: 'main',
        trigger: 'create',
        actor: 'ops@acme.test'
    });
}

test('a run is only readable by the tenant it belongs to', () => {
    const run = newRun('site-a');
    assert.ok(runs.get('acme', run.id));
    assert.equal(runs.get('other', run.id), null);
});

test('the browser id is used when it looks like one, ignored when it does not', () => {
    const good = runs.start({ id: 'abc123XY_-def', slug: 'acme', projectId: 'site-id-ok' });
    assert.equal(good.id, 'abc123XY_-def');

    const bad = runs.start({ id: 'no', slug: 'acme', projectId: 'site-id-bad' });
    assert.notEqual(bad.id, 'no');

    // A second run claiming a taken id gets its own, or it would take over the
    // console of a deployment already running.
    const clash = runs.start({ id: 'abc123XY_-def', slug: 'acme', projectId: 'site-id-clash' });
    assert.notEqual(clash.id, 'abc123XY_-def');
});

test('the cursor keeps counting past the lines the ring dropped', () => {
    const run = newRun('site-lines');
    for (let i = 0; i < 700; i++) runs.log(run, `line ${i}`);

    const all = runs.snapshot(run, 0);
    assert.equal(all.resync, true, 'a caller at 0 missed the dropped lines');
    assert.equal(all.cursor, 700);
    assert.equal(all.lines[all.lines.length - 1].text, 'line 699');

    // Reading from the cursor returns nothing new and does not ask to resync.
    const caughtUp = runs.snapshot(run, all.cursor);
    assert.equal(caughtUp.lines.length, 0);
    assert.equal(caughtUp.resync, false);

    runs.log(run, 'line 700');
    const next = runs.snapshot(run, all.cursor);
    assert.equal(next.resync, false);
    assert.deepEqual(next.lines.map((l) => l.text), ['line 700']);
    assert.equal(next.cursor, 701);
});

test('multi-line output becomes one entry per line, blanks dropped', () => {
    const run = newRun('site-split');
    runs.log(run, 'first\r\n\r\nsecond   \n');
    assert.deepEqual(runs.snapshot(run, 0).lines.map((l) => l.text), ['first', 'second']);
});

test('finishing a run closes every stage it left open', () => {
    const run = newRun('site-stages');
    runs.stage(run, 'clone', 'done');
    runs.stage(run, 'build', 'running');
    runs.finish(run, 'failed', 'needs_build');

    const byKey = Object.fromEntries(runs.snapshot(run, 0).stages.map((s) => [s.key, s.status]));
    assert.equal(byKey.clone, 'done');
    // Skipped, not pending: the sandbox never ran an install command here.
    assert.equal(byKey.install, 'skipped');
    assert.equal(byKey.build, 'failed');
    assert.equal(byKey.publish, 'skipped');
    assert.equal(runs.snapshot(run, 0).status, 'failed');
});

test('a project keeps only its last few runs, and forgets them all when deleted', () => {
    for (let i = 0; i < 12; i++) newRun('site-many');
    const kept = runs.listForProject('acme', 'site-many');
    assert.equal(kept.length, 8);
    // Evicted runs are gone from the id map too, not just from the list.
    assert.equal(runs.get('acme', kept[kept.length - 1].id).projectId, 'site-many');

    runs.dropProject('acme', 'site-many');
    assert.equal(runs.listForProject('acme', 'site-many').length, 0);
    assert.equal(runs.get('acme', kept[0].id), null);
});

/* ------------------------------------------------------------------ */
/* the run a project only gets a name for halfway through              */
/* ------------------------------------------------------------------ */

test('a run started before the project id is known moves under it', () => {
    // How the create route works: the console is open on the browser's id
    // before the repository URL has even been parsed, so the run exists first
    // and the project id arrives a few lines later.
    const run = runs.start({
        id: 'unattachedrun01', slug: 'acme', projectId: '', trigger: 'create'
    });
    assert.deepEqual(runs.listForProject('acme', 'site-late'), []);

    runs.attach(run, 'site-late', 'Site Late');
    assert.equal(run.projectId, 'site-late');
    assert.equal(run.projectName, 'Site Late');
    assert.deepEqual(runs.listForProject('acme', 'site-late').map((r) => r.id), ['unattachedrun01']);
    // And it is gone from the bucket it was in, or it would be listed twice.
    assert.deepEqual(runs.listForProject('acme', ''), []);

    // Deleting the project forgets it, which is the whole point of re-keying.
    runs.dropProject('acme', 'site-late');
    assert.equal(runs.get('acme', 'unattachedrun01'), null);
});

/* ------------------------------------------------------------------ */
/* publish: the rename that must not leave a site with no folder       */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* what a failure is called                                            */
/* ------------------------------------------------------------------ */

test('a failure is named for what actually failed, not for the clone', () => {
    const { reasonFor } = require('../deployService');

    // git exited non-zero: this one really is the clone.
    assert.equal(reasonFor(Object.assign(new Error('x'), { code: 128 })), 'deploy_failed');
    // The program never started at all.
    assert.equal(reasonFor(Object.assign(new Error('x'), { code: 'ENOENT' })), 'tool_missing');
    // The operator's own build script.
    assert.equal(reasonFor(Object.assign(new Error('x'), { code: 'build_failed' })), 'build_failed');
    assert.equal(
        reasonFor(Object.assign(new Error('x'), { code: 'build_account_unconfigured' })),
        'build_account_unconfigured');
    // GitHub, which github.js reports with a status and no code.
    assert.equal(reasonFor(Object.assign(new Error('x'), { status: 401 })), 'github_auth_failed');
    assert.equal(reasonFor(Object.assign(new Error('x'), { status: 504 })), 'github_unreachable');
    // The refusals that already name what to change are left alone.
    assert.equal(reasonFor(Object.assign(new Error('x'), { code: 'needs_build' })), 'needs_build');
});
