/**
 * Two versions side by side: the outgoing one keeps the visitors already on it.
 *
 * A push used to kill the previous process five seconds after the flip, which
 * cut whoever was halfway through a form, so the only safe moment to push was
 * when nobody was using the site. These tests hold the promises that replace
 * that: a visitor whose cookie names the old version stays on it, a poll does
 * not keep it alive, it stops once idle or once held too long, a third version
 * waits instead of starting, and a forced one does not.
 *
 * The poller half is `decide`: a commit pushed while a version drains is queued,
 * a newer one replaces it, and it deploys once the place is free.
 */

'use strict';

process.env.AEGIS_RUNTIME_PORT_BASE = process.env.AEGIS_TEST_RUNTIME_PORT_BASE_DRAIN || '47400';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { EventEmitter } = require('events');

const runtime = require('../runtime');
const { decide } = require('../poller');

function fakeSpawn(body) {
    return ({ port }) => {
        const child = new EventEmitter();
        const server = http.createServer((req, res) => res.end(`${body} ${port}`));
        server.listen(port, '127.0.0.1');
        child.killed = false;
        child.kill = () => { child.killed = true; server.close(); return true; };
        return child;
    };
}

let saved;
function enable() {
    saved = [process.env.AEGIS_DEPLOY_RUNTIME, process.env.AEGIS_RUNTIME_ACCOUNTS];
    process.env.AEGIS_DEPLOY_RUNTIME = '1';
    process.env.AEGIS_RUNTIME_ACCOUNTS = 'run-a,run-b';
}
function restore() {
    if (saved[0] === undefined) delete process.env.AEGIS_DEPLOY_RUNTIME;
    else process.env.AEGIS_DEPLOY_RUNTIME = saved[0];
    if (saved[1] === undefined) delete process.env.AEGIS_RUNTIME_ACCOUNTS;
    else process.env.AEGIS_RUNTIME_ACCOUNTS = saved[1];
}

async function two(slug, project) {
    await runtime.restart({ slug, project, dir: '.', startCmd: 'x', spawn: fakeSpawn('v1'), sha: 'aaaaaaa' });
    await runtime.restart({ slug, project, dir: '.', startCmd: 'x', spawn: fakeSpawn('v2'), sha: 'bbbbbbb', keep: true });
}

test('a visitor on the old version stays on it, everyone else gets the new one', async () => {
    enable();
    const project = { id: 'app', port: 3081 };
    try {
        await two('d1', project);
        assert.deepStrictEqual(runtime.versions('d1', 'app').active, 'bbbbbbb');
        assert.strictEqual(runtime.versions('d1', 'app').draining.sha, 'aaaaaaa');

        const fresh = runtime.targetForRequest('d1', 'app', {});
        assert.strictEqual(fresh.sha, 'bbbbbbb');
        assert.strictEqual(fresh.draining, false);

        const old = runtime.targetForRequest('d1', 'app', { release: 'aaaaaaa' });
        assert.strictEqual(old.sha, 'aaaaaaa');
        assert.strictEqual(old.draining, true);
        assert.notStrictEqual(old.port, fresh.port);
        assert.notStrictEqual(old.proxyKey, fresh.proxyKey);

        // A cookie naming a version that is not running reaches the new one.
        assert.strictEqual(runtime.targetForRequest('d1', 'app', { release: 'ccccccc' }).sha, 'bbbbbbb');
    } finally {
        runtime.stop('d1', 'app');
        restore();
    }
});

test('a poll does not keep the old version alive, a person does', async () => {
    enable();
    const project = { id: 'app', port: 3082 };
    try {
        await two('d2', project);
        const old = runtime._draining.get('d2/app');
        old.lastSeen = 0;
        runtime.targetForRequest('d2', 'app', { release: 'aaaaaaa', background: true });
        assert.strictEqual(old.lastSeen, 0, 'a background poll counted as activity');
        runtime.targetForRequest('d2', 'app', { release: 'aaaaaaa' });
        assert.ok(old.lastSeen > 0, 'a real request did not count');
    } finally {
        runtime.stop('d2', 'app');
        restore();
    }
});

test('the old version stops once idle, or once held too long, and says the place is free', async () => {
    enable();
    const freed = [];
    runtime.onSlotFree((slug, id) => freed.push(`${slug}/${id}`));
    try {
        await two('d3', { id: 'idle', port: 3083 });
        await two('d3', { id: 'busy', port: 3084 });
        const idle = runtime._draining.get('d3/idle');
        const busy = runtime._draining.get('d3/busy');
        const now = Date.now();

        // Used a minute ago: kept. Unused past the idle limit: stopped.
        idle.lastSeen = now - runtime.DRAIN_IDLE_MS - 1;
        busy.lastSeen = now - 60000;
        runtime.reap(now);
        assert.strictEqual(runtime.isDraining('d3', 'idle'), false);
        assert.strictEqual(idle.child.killed, true);
        assert.strictEqual(runtime.isDraining('d3', 'busy'), true);

        // Still used, but past the hard limit: stopped anyway.
        busy.since = now - runtime.DRAIN_MAX_MS - 1;
        runtime.reap(now);
        assert.strictEqual(runtime.isDraining('d3', 'busy'), false);
        assert.deepStrictEqual(freed.filter((k) => k.startsWith('d3/')), ['d3/idle', 'd3/busy']);

        // The new versions are untouched.
        assert.strictEqual(runtime.versions('d3', 'idle').active, 'bbbbbbb');
    } finally {
        runtime.stop('d3', 'idle');
        runtime.stop('d3', 'busy');
        restore();
    }
});

test('a third version waits while one drains, unless forced', async () => {
    enable();
    const project = { id: 'app', port: 3085 };
    try {
        await two('d4', project);
        await assert.rejects(() => runtime.restart({
            slug: 'd4', project, dir: '.', startCmd: 'x', spawn: fakeSpawn('v3'), sha: 'ccccccc', keep: true
        }), { code: 'slot_busy' });
        assert.strictEqual(runtime.versions('d4', 'app').active, 'bbbbbbb', 'a refused version moved the proxy');

        const old = runtime._draining.get('d4/app');
        await runtime.restart({
            slug: 'd4', project, dir: '.', startCmd: 'x', spawn: fakeSpawn('v3'), sha: 'ccccccc', keep: true, force: true
        });
        assert.strictEqual(old.child.killed, true, 'the draining version was not stopped');
        const v = runtime.versions('d4', 'app');
        assert.strictEqual(v.active, 'ccccccc');
        assert.strictEqual(v.draining.sha, 'bbbbbbb');
    } finally {
        runtime.stop('d4', 'app');
        restore();
    }
});

test('stop takes the draining version too', async () => {
    enable();
    try {
        await two('d5', { id: 'app', port: 3086 });
        const old = runtime._draining.get('d5/app');
        runtime.stop('d5', 'app');
        assert.strictEqual(old.child.killed, true);
        assert.strictEqual(runtime.isDraining('d5', 'app'), false);
        assert.strictEqual(runtime.isRunning('d5', 'app'), false);
    } finally {
        restore();
    }
});

test('a push while a version drains is queued, and the newest commit takes the place', () => {
    const project = { lastSeenSha: 'aaaaaaa' };
    assert.deepStrictEqual(decide(project, { moved: true, sha: 'ccccccc' }, { draining: true }),
        { action: 'queue', sha: 'ccccccc' });
    // The fourth commit replaces the third: the queue holds the head.
    const waiting = { lastSeenSha: 'aaaaaaa', pendingSha: 'ccccccc' };
    assert.deepStrictEqual(decide(waiting, { moved: true, sha: 'ddddddd' }, { draining: true }),
        { action: 'queue', sha: 'ddddddd' });
});

test('the waiting commit deploys once the place is free, even with nothing new on GitHub', () => {
    const waiting = { lastSeenSha: 'aaaaaaa', pendingSha: 'ddddddd' };
    assert.deepStrictEqual(decide(waiting, { moved: false }, { draining: true }),
        { action: 'none', reason: 'not_modified' });
    assert.deepStrictEqual(decide(waiting, { moved: false }, { draining: false }),
        { action: 'deploy', sha: 'ddddddd' });
    // Without a draining version nothing changes from before.
    assert.deepStrictEqual(decide({ lastSeenSha: 'aaaaaaa' }, { moved: true, sha: 'bbbbbbb' }),
        { action: 'deploy', sha: 'bbbbbbb' });
});
