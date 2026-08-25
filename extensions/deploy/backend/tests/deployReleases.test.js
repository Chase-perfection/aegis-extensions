/**
 * The release folders under a project, and the renames that move one onto the
 * port.
 *
 * Every test here is about a site that must not go down or serve half of two
 * versions. `publish` and `promote` are the same three renames on one volume,
 * through the same `swapOnto`, and the middle rename is the moment the site has
 * no folder at all: if the last one fails there and nothing puts the old version
 * back, the project serves nothing until somebody notices. That restore is the
 * reason this file exists, and it is tested once, through publish, because
 * promote reaches it by the same call.
 *
 * The second reason is the folder name. A release is named after a commit sha
 * and the name reaches `path.join`, so a value that is not a sha has to be
 * refused before it gets there.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cloner = require('../cloner');

/** A project folder with `current` holding one file, plus a staged version. */
function project(currentBody) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-release-'));
    if (currentBody !== undefined) {
        fs.mkdirSync(path.join(dir, 'current'));
        fs.writeFileSync(path.join(dir, 'current', 'index.html'), currentBody);
    }
    return dir;
}

function staged(dir, body) {
    const served = path.join(dir, 'staging');
    fs.rmSync(served, { recursive: true, force: true });
    fs.mkdirSync(served);
    fs.writeFileSync(path.join(served, 'index.html'), body);
    return served;
}

function serving(dir) {
    return fs.readFileSync(path.join(dir, 'current', 'index.html'), 'utf8');
}

function releaseNames(dir) {
    return cloner.listReleases(dir).map((r) => r.sha);
}

/**
 * Gives one release folder an mtime of its own, in the past, ordered by `order`.
 *
 * `listReleases` orders by mtime and `pruneReleases` drops the tail. Seven
 * publishes in a loop land inside one filesystem timestamp tick, so every folder
 * carries the same mtime; `Array.sort` is stable, the order collapses to readdir
 * order, which on NTFS is alphabetical, and the prune then deletes the two newest
 * releases instead of the two oldest. That made the test below fail about two runs
 * in three, alternating between its two assertions.
 *
 * A real project deploys minutes apart and never sees the tie. Stamping the times
 * gives the test the spacing production has, rather than weakening what it checks.
 * Always in the past, so the release filed by the next publish is still the newest
 * and each prune sees a total order.
 */
function stamp(dir, sha, order) {
    const at = Math.floor(Date.now() / 1000) - 100 + order;
    const folder = path.join(dir, 'releases', sha);
    if (fs.existsSync(folder)) fs.utimesSync(folder, at, at);
}

test('publishing files the outgoing version as a release', () => {
    const dir = project('one');
    cloner.publish({
        served: staged(dir, 'two'), currentDir: path.join(dir, 'current'),
        projectDir: dir, currentSha: 'aaaaaaa'
    });

    assert.strictEqual(serving(dir), 'two');
    assert.deepStrictEqual(releaseNames(dir), ['aaaaaaa']);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'releases', 'aaaaaaa', 'index.html'), 'utf8'), 'one');
});

test('a first deployment has nothing to file', () => {
    const dir = project(undefined);
    cloner.publish({
        served: staged(dir, 'one'), currentDir: path.join(dir, 'current'),
        projectDir: dir, currentSha: null
    });

    assert.strictEqual(serving(dir), 'one');
    assert.deepStrictEqual(releaseNames(dir), []);
});

test('five releases are kept and the oldest goes', () => {
    const dir = project('v0');
    for (let n = 1; n <= 7; n++) {
        cloner.publish({
            served: staged(dir, `v${n}`), currentDir: path.join(dir, 'current'),
            projectDir: dir, currentSha: String(n - 1).repeat(7)
        });
        // Stamped after each publish, not once at the end: the prune runs inside
        // `publish`, so by the sixth pass it has already decided what to delete.
        stamp(dir, String(n - 1).repeat(7), n);
    }

    const kept = releaseNames(dir);
    assert.strictEqual(kept.length, 5, `kept ${kept.join(', ')}`);
    assert.ok(kept.includes('6666666'), 'the newest release was dropped');
    assert.ok(!kept.includes('0000000'), 'the oldest release was kept');
});

test('promoting swaps a release onto the port, and twice returns to the start', () => {
    const dir = project('one');
    cloner.publish({
        served: staged(dir, 'two'), currentDir: path.join(dir, 'current'),
        projectDir: dir, currentSha: 'aaaaaaa'
    });

    cloner.promote({ projectDir: dir, currentDir: path.join(dir, 'current'), sha: 'aaaaaaa', currentSha: 'bbbbbbb' });
    assert.strictEqual(serving(dir), 'one');
    assert.deepStrictEqual(releaseNames(dir), ['bbbbbbb']);

    cloner.promote({ projectDir: dir, currentDir: path.join(dir, 'current'), sha: 'bbbbbbb', currentSha: 'aaaaaaa' });
    assert.strictEqual(serving(dir), 'two');
    assert.deepStrictEqual(releaseNames(dir), ['aaaaaaa']);
});

test('a release that is not there, and a name that is not a sha, are both refused', () => {
    const dir = project('one');
    const currentDir = path.join(dir, 'current');

    assert.throws(() => cloner.promote({ projectDir: dir, currentDir, sha: 'ccccccc', currentSha: 'aaaaaaa' }),
        { code: 'unknown_release' });

    for (const sha of ['..', '../../windows', 'not hex', '', 'AAAAAAA/..']) {
        assert.throws(() => cloner.promote({ projectDir: dir, currentDir, sha, currentSha: 'aaaaaaa' }),
            { code: 'bad_release' }, `accepted ${sha}`);
    }
    assert.strictEqual(serving(dir), 'one', 'a refusal moved the live version');
});

test('a previous/ folder from before releases existed is adopted once', () => {
    const dir = project('two');
    fs.mkdirSync(path.join(dir, 'previous'));
    fs.writeFileSync(path.join(dir, 'previous', 'index.html'), 'one');

    cloner.adoptPrevious({ projectDir: dir, previousSha: 'aaaaaaa' });

    assert.deepStrictEqual(releaseNames(dir), ['aaaaaaa']);
    assert.strictEqual(fs.existsSync(path.join(dir, 'previous')), false);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'releases', 'aaaaaaa', 'index.html'), 'utf8'), 'one');

    // Nothing left to adopt, and calling again is not an error.
    cloner.adoptPrevious({ projectDir: dir, previousSha: 'aaaaaaa' });
    assert.deepStrictEqual(releaseNames(dir), ['aaaaaaa']);
});

test('a publish that cannot land puts the version that was serving back', () => {
    const dir = project('one');
    assert.throws(() => cloner.publish({
        served: path.join(dir, 'no-such-staging'),
        currentDir: path.join(dir, 'current'),
        projectDir: dir,
        currentSha: 'aaaaaaa'
    }));

    assert.strictEqual(serving(dir), 'one', 'the site was left with no current/');
    assert.deepStrictEqual(releaseNames(dir), [], 'the restored version was left filed as a release too');
});

test('a release folder that is not a folder is not offered as one', () => {
    const dir = project('one');
    fs.mkdirSync(path.join(dir, 'releases'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'releases', 'notes.txt'), 'left by hand');
    fs.mkdirSync(path.join(dir, 'releases', 'scratch'));       // not a sha

    assert.deepStrictEqual(releaseNames(dir), []);
});
