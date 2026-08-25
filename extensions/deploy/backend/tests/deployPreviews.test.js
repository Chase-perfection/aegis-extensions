/**
 * When a preview deployment is allowed to disappear.
 *
 * The port range is a hundred wide and a preview takes one for a branch, so
 * they have to expire or a busy repository fills the range in a month. Which
 * makes the expiry decision the thing to get right: deleting a preview somebody
 * is still reading is worse than keeping a stale one, so a visitor counts as
 * much as a commit.
 *
 * A record with no clock on it at all is left alone rather than deleted, which
 * is the answer for a preview from before this field existed.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const previews = require('../previews');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const preview = (over) => Object.assign({
    id: 'site-feature', parentId: 'site', branch: 'feature', port: 3082
}, over || {});

test('a project that is not a preview never expires', () => {
    const old = { id: 'site', branch: 'main', deployedAt: NOW - 400 * DAY };
    assert.strictEqual(previews.isExpired(old, NOW, 0), false);
    assert.strictEqual(previews.isPreview(old), false);
});

test('a preview deployed within the week stays', () => {
    assert.strictEqual(previews.isExpired(preview({ deployedAt: NOW - 6 * DAY }), NOW, 0), false);
});

test('a preview nobody pushed to or opened for a week goes', () => {
    assert.strictEqual(previews.isExpired(preview({ deployedAt: NOW - 8 * DAY }), NOW, 0), true);
});

test('a visitor keeps a preview alive as surely as a commit', () => {
    const stale = preview({ deployedAt: NOW - 30 * DAY });
    assert.strictEqual(previews.isExpired(stale, NOW, NOW - 2 * DAY), false);
    assert.strictEqual(previews.isExpired(stale, NOW, NOW - 30 * DAY), true);
});

test('a preview whose first deployment never landed is judged on when it was created', () => {
    assert.strictEqual(previews.isExpired(preview({ createdAt: NOW - 8 * DAY }), NOW, 0), true);
    assert.strictEqual(previews.isExpired(preview({ createdAt: NOW - 1 * DAY }), NOW, 0), false);
});

test('a record with no timestamps at all is left alone', () => {
    // Deleting on a missing field would mean a record written before these
    // fields existed disappearing on the first sweep after an upgrade.
    assert.strictEqual(previews.isExpired(preview(), NOW, 0), false);
});

test('the name a preview carries names its branch', () => {
    const name = previews.nameFor({ id: 'site', name: 'Intranet' }, 'feature/login');
    assert.ok(name.indexOf('Intranet') !== -1 && name.indexOf('feature/login') !== -1, name);
    assert.ok(name.length <= 80);

    const long = previews.nameFor({ id: 'site', name: 'x'.repeat(100) }, 'feature');
    assert.strictEqual(long.length, 80);
});

test('a branch name that is not one is refused before it becomes a folder', () => {
    for (const branch of ['feature/login', 'main', 'release-1.2']) {
        assert.ok(previews.BRANCH_RE.test(branch), branch);
    }
    for (const branch of ['', 'has space', 'quote"', 'semi;colon', 'x'.repeat(300)]) {
        assert.strictEqual(previews.BRANCH_RE.test(branch), false, `accepted ${branch}`);
    }
});
