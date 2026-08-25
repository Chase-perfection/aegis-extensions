/**
 * The poller's decisions, without a network or a clone.
 *
 * `decide` and `shouldPoll` are the whole of push-to-deploy: everything else in
 * poller.js is the loop that calls them. They are pure on purpose, because the
 * failures that matter here are quiet ones. A `decide` that returns `deploy` on
 * an unchanged branch re-clones every 20 seconds forever; one that returns
 * `none` on a real push means pushes silently stop shipping.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { decide, shouldPoll } = require('../poller');
const { addHistory, skipTicks, HISTORY_LIMIT } = require('../projectStore');

const project = (over) => Object.assign({ id: 'site', lastSha: 'aaaa1111' }, over || {});

test('a 304 from GitHub deploys nothing', () => {
    assert.deepStrictEqual(
        decide(project(), { moved: false, sha: null, etag: 'W/"x"' }),
        { action: 'none', reason: 'not_modified' }
    );
});

test('the same head as the published one deploys nothing', () => {
    assert.deepStrictEqual(
        decide(project(), { moved: true, sha: 'aaaa1111', etag: 'W/"y"' }),
        { action: 'none', reason: 'same_sha' }
    );
});

test('a new head deploys it', () => {
    assert.deepStrictEqual(
        decide(project(), { moved: true, sha: 'bbbb2222', etag: 'W/"y"' }),
        { action: 'deploy', sha: 'bbbb2222' }
    );
});

test('a branch with no commit deploys nothing', () => {
    assert.deepStrictEqual(
        decide(project(), { moved: true, sha: null, etag: null }),
        { action: 'none', reason: 'no_head' }
    );
});

// A project that has never deployed has no lastSha, and its first poll must
// publish rather than wait for a second push.
test('a project that never deployed treats the current head as new', () => {
    const verdict = decide(project({ lastSha: null }), { moved: true, sha: 'cccc3333' });
    assert.strictEqual(verdict.action, 'deploy');
});

// A promoted release is on the port while the branch has not moved. Comparing
// the head against what is being served would read as a new commit and redeploy
// forward, undoing the promote on the next tick. `lastSeenSha` is the branch,
// `lastSha` is the port.
test('a promoted older release is not undone by the next tick', () => {
    const promoted = project({ lastSha: 'aaaa1111', lastSeenSha: 'bbbb2222' });
    assert.deepStrictEqual(
        decide(promoted, { moved: true, sha: 'bbbb2222', etag: 'W/"y"' }),
        { action: 'none', reason: 'same_sha' }
    );
});

test('a push after a promote deploys forward again', () => {
    const promoted = project({ lastSha: 'aaaa1111', lastSeenSha: 'bbbb2222' });
    assert.deepStrictEqual(
        decide(promoted, { moved: true, sha: 'cccc3333', etag: 'W/"z"' }),
        { action: 'deploy', sha: 'cccc3333' }
    );
});

test('a healthy project is polled on every tick', () => {
    for (let t = 1; t <= 5; t++) {
        assert.ok(shouldPoll(project({ failureCount: 0 }), 'live', t), `tick ${t}`);
    }
});

test('a repeatedly failing project is polled less often, and never stops', () => {
    // One failure still retries immediately: a transient network blip should not
    // delay the next attempt.
    assert.strictEqual(skipTicks(1), 0);

    // Backoff grows, then holds, so a project fixed on GitHub recovers without
    // anyone clicking.
    assert.strictEqual(skipTicks(2), 1);
    assert.strictEqual(skipTicks(9), 8);
    assert.strictEqual(skipTicks(200), 15, 'backoff must be capped');

    const failing = project({ failureCount: 4 });   // every 4th tick
    const polled = [];
    for (let t = 1; t <= 12; t++) if (shouldPoll(failing, 'live', t)) polled.push(t);
    assert.deepStrictEqual(polled, [4, 8, 12]);
    assert.ok(polled.length > 0, 'a failing project must still be retried');
});

test('history keeps the newest attempt first and stops growing', () => {
    let p = project({ history: [] });
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
        p = Object.assign({}, p, { history: addHistory(p, { sha: 's' + i, at: i, status: 'ready' }) });
    }
    assert.strictEqual(p.history.length, HISTORY_LIMIT);
    assert.strictEqual(p.history[0].sha, 's' + (HISTORY_LIMIT + 4), 'newest first');
});

test('history survives a project that has never recorded one', () => {
    assert.deepStrictEqual(
        addHistory({ id: 'site' }, { sha: 'a', at: 1, status: 'ready' }),
        [{ sha: 'a', at: 1, status: 'ready' }]
    );
});
