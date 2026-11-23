/**
 * Tests for the deployed-site access guard and the per-tenant directory store.
 *
 * Two things shape this file.
 *
 * `ldap.js` opens sockets to a domain controller, so nothing here touches it.
 * `siteAuth._setVerifier` replaces the verifier with a function that answers
 * from a table, which is what makes the refusal, lockout and success paths
 * testable at all. `siteAuth._setLookup` does the same for the passwordless
 * question the background revalidation asks. The real client has its own tests.
 *
 * `AEGIS_DATA_ROOT` is set before anything is required, so `machineStore`
 * creates its encryption key inside a temporary folder instead of
 * C:\ProgramData\Aegis. Without it these tests would write to the machine.
 *
 * The last two sections leave the fabricated request objects behind and start
 * real listeners, because `siteServer`'s TLS behaviour is only observable from
 * a socket: the question "did a site marked HTTPS come up in clear" cannot be
 * answered by inspecting a return value.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-deploy-data-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const https = require('https');
const { Readable } = require('stream');
const { spawnSync } = require('node:child_process');

const siteAuth = require('../siteAuth');
const authStore = require('../authStore');
const projectStore = require('../projectStore');
const siteServer = require('../siteServer');

// The guard logs refusals on purpose. Muted here so a passing run is readable;
// a failing assertion still reports everything that matters.
console.log = () => {};
console.warn = () => {};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function newTenant() {
    return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-tenant-')) };
}

function fakeReq(method, url, opts) {
    const o = opts || {};
    const req = Readable.from(o.body === undefined ? [] : [Buffer.from(o.body, 'utf8')]);
    req.method = method;
    req.url = url;
    req.headers = Object.assign({}, o.headers);
    // `encrypted` is the only thing `isSecure` looks at, and a real TLS socket
    // is the only thing that sets it. A protected site is served over TLS only,
    // so a request is encrypted unless the test says `secure: false`.
    req.socket = { remoteAddress: o.ip || '10.0.0.1' };
    if (o.secure !== false) req.socket.encrypted = true;
    return req;
}

function fakeRes() {
    const res = { statusCode: 0, headers: {}, body: '', ended: false, headersSent: false };
    res.writeHead = function (status, headers) {
        res.statusCode = status;
        Object.assign(res.headers, headers || {});
        res.headersSent = true;
        return res;
    };
    // Headers set before `writeHead`, as a real response lets a caller do.
    res.setHeader = function (name, value) { res.headers[name] = value; };
    res.end = function (chunk) {
        if (chunk) res.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        res.ended = true;
    };
    return res;
}

function cookieValue(setCookie, name) {
    const m = new RegExp(`(?:^|; )?${name}=([^;]*)`).exec(String(setCookie || ''));
    return m ? m[1] : null;
}

function seed(slug, projectId, project, config) {
    const tenantPaths = newTenant();
    projectStore.saveProject(tenantPaths, Object.assign({ id: projectId, port: 3081 }, project));
    if (config) authStore.writeConfig(tenantPaths, config);
    siteAuth.invalidate(slug, projectId);
    return tenantPaths;
}

const GOOD_CONFIG = {
    url: 'ldap://dc01.corp.local:389',
    baseDn: 'DC=corp,DC=local',
    bindDn: 'CN=svc,DC=corp,DC=local',
    bindPassword: 'service-secret'
};

/* ------------------------------------------------------------------ */
/* group matching (section C)                                          */
/* ------------------------------------------------------------------ */

test('group matching: an empty allow list matches nothing', () => {
    // The inverse of what this function used to return, and the change is the
    // point. "Empty means everyone" moved up to `audience`, where it is a
    // stored choice; leaving it here as well would mean a site whose audience
    // is `listed` and whose lists are both empty opens to the whole directory.
    assert.strictEqual(siteAuth._groupAllowed([], ['CN=Anything,DC=corp,DC=local']), false);
    assert.strictEqual(siteAuth._groupAllowed([], []), false);
});

test('access: the directory audience lets anyone in and still names one admin', () => {
    // The shape an application that manages its own roles asks for: Aegis says
    // who is reading and who may open the console, the application does the
    // rest. Opening the gate and appointing an administrator are two decisions.
    const users = [{ sid: 'S-1-5-21-1-2-3-1103', login: 'AM', name: 'Alice Martin', admin: true }];
    assert.deepStrictEqual(
        siteAuth._accessFor([], users, 'directory', [], 'S-1-5-21-1-2-3-1103'),
        { allowed: true, admin: true });
    assert.deepStrictEqual(
        siteAuth._accessFor([], users, 'directory', [], 'S-1-5-21-1-2-3-9999'),
        { allowed: true, admin: false });
});

test('access: the listed audience refuses a SID that is on no list', () => {
    const users = [{ sid: 'S-1-5-21-1-2-3-1103', login: 'AM', name: 'Alice Martin', admin: true }];
    assert.deepStrictEqual(
        siteAuth._accessFor([], users, 'listed', [], 'S-1-5-21-1-2-3-9999'),
        { allowed: false, admin: false });
    // Either list may open the door.
    assert.deepStrictEqual(
        siteAuth._accessFor(['Domain Admins'], users, 'listed',
            ['CN=Domain Admins,CN=Users,DC=corp,DC=local'], 'S-1-5-21-1-2-3-9999'),
        { allowed: true, admin: false });
});

test('access: listed with both lists empty is closed, not open', () => {
    // The trap the audience field exists to remove. Before it, this shape was
    // indistinguishable from "open to the directory" and served the site.
    assert.deepStrictEqual(
        siteAuth._accessFor([], [], 'listed', ['CN=Anything,DC=corp,DC=local'], 'S-1-5-21-1-2-3-1'),
        { allowed: false, admin: false });
});

test('access: a group can never confer admin', () => {
    // "Whoever is in this group administers the site" is a promotion nobody
    // reviews. Admin is carried by a named person or by no one.
    assert.deepStrictEqual(
        siteAuth._accessFor(['Domain Admins'], [], 'listed',
            ['CN=Domain Admins,CN=Users,DC=corp,DC=local'], 'S-1-5-21-1-2-3-1'),
        { allowed: true, admin: false });
});

test('access: a SID matches whatever case it was stored in', () => {
    // An operator adding the first administrator on a machine with no picker
    // types it by hand, and Windows tools print it in mixed case.
    const users = [{ sid: 's-1-5-21-1-2-3-1103', login: 'AM', name: '', admin: true }];
    assert.deepStrictEqual(
        siteAuth._accessFor([], users, 'listed', [], 'S-1-5-21-1-2-3-1103'),
        { allowed: true, admin: true });
});

test('access: an empty SID matches nobody', () => {
    // The direct-bind path reads the entry best effort, so an absent SID is a
    // real state. It must never collapse onto the first entry in the list.
    const users = [{ sid: 'S-1-5-21-1-2-3-1103', login: 'AM', name: '', admin: true }];
    assert.deepStrictEqual(
        siteAuth._accessFor([], users, 'listed', [], ''),
        { allowed: false, admin: false });
    assert.strictEqual(siteAuth._findUser(users, ''), null);
});

test('group matching: a bare CN matches the full DN it came from', () => {
    const groups = ['CN=Domain Admins,CN=Users,DC=corp,DC=local'];
    assert.strictEqual(siteAuth._groupAllowed(['Domain Admins'], groups), true);
    assert.strictEqual(siteAuth._groupAllowed(['domain admins'], groups), true);
    assert.strictEqual(siteAuth._groupAllowed(['  Domain   Admins  '], groups), true);
});

test('group matching: the full DN matches, case-insensitively', () => {
    const groups = ['CN=Domain Admins,CN=Users,DC=corp,DC=local'];
    assert.strictEqual(
        siteAuth._groupAllowed(['cn=domain admins,cn=users,dc=corp,dc=local'], groups), true);
});

test('group matching: a non-member is refused', () => {
    const groups = ['CN=Helpdesk,OU=Groups,DC=corp,DC=local'];
    assert.strictEqual(siteAuth._groupAllowed(['Domain Admins'], groups), false);
    assert.strictEqual(siteAuth._groupAllowed(['Domain Admins'], []), false);
    // A CN is not a prefix match: "Admins" must not open a site meant for
    // "Domain Admins".
    assert.strictEqual(siteAuth._groupAllowed(['Admins'], groups), false);
});

test('group matching: an escaped comma inside a CN is read as one name', () => {
    assert.strictEqual(siteAuth._firstCn('CN=Ops\\, Paris,OU=Groups,DC=corp,DC=local'), 'Ops, Paris');
    assert.strictEqual(
        siteAuth._groupAllowed(['Ops, Paris'], ['CN=Ops\\, Paris,OU=Groups,DC=corp,DC=local']), true);
});

/* ------------------------------------------------------------------ */
/* the next parameter                                                  */
/* ------------------------------------------------------------------ */

test('next: a scheme-relative path is refused, a real path is kept', () => {
    assert.strictEqual(siteAuth._safeNext('//evil.com'), '/');
    assert.strictEqual(siteAuth._safeNext('//evil.com/path'), '/');
    assert.strictEqual(siteAuth._safeNext('/\\evil.com'), '/');
    assert.strictEqual(siteAuth._safeNext('https://evil.com'), '/');
    assert.strictEqual(siteAuth._safeNext('http://evil.com'), '/');
    assert.strictEqual(siteAuth._safeNext('evil.com'), '/');
    assert.strictEqual(siteAuth._safeNext(''), '/');
    assert.strictEqual(siteAuth._safeNext(null), '/');
    assert.strictEqual(siteAuth._safeNext(undefined), '/');

    assert.strictEqual(siteAuth._safeNext('/a/b'), '/a/b');
    assert.strictEqual(siteAuth._safeNext('/a/b?x=1&y=2'), '/a/b?x=1&y=2');
    assert.strictEqual(siteAuth._safeNext('/'), '/');
});

test('next: control characters and the reserved prefix fall back to the root', () => {
    assert.strictEqual(siteAuth._safeNext('/a\r\nSet-Cookie: x=1'), '/');
    assert.strictEqual(siteAuth._safeNext('/a b'), '/');
    assert.strictEqual(siteAuth._safeNext('/__aegis/login'), '/');
    assert.strictEqual(siteAuth._safeNext('/__aegis'), '/');
});

/* ------------------------------------------------------------------ */
/* lockout                                                             */
/* ------------------------------------------------------------------ */

test('lockout: five failures lock the pair, a success clears it', () => {
    const ip = '192.0.2.77';
    const pid = 'lock-test';
    siteAuth._clearFailures('tenant-lock', pid, ip);

    for (let i = 1; i <= siteAuth.LOCK_THRESHOLD - 1; i++) {
        siteAuth._noteFailure('tenant-lock', pid, ip);
        assert.strictEqual(siteAuth._lockRemaining('tenant-lock', pid, ip), 0, `attempt ${i} must not lock`);
    }

    siteAuth._noteFailure('tenant-lock', pid, ip);
    const left = siteAuth._lockRemaining('tenant-lock', pid, ip);
    assert.ok(left > 0 && left <= siteAuth.LOCK_MS / 1000, `expected a lock, got ${left}`);

    siteAuth._clearFailures('tenant-lock', pid, ip);
    assert.strictEqual(siteAuth._lockRemaining('tenant-lock', pid, ip), 0);
});

test('lockout: counters are per ip and per project', () => {
    const pid = 'lock-scope';
    siteAuth.dropFailures('tenant-lock', pid);
    for (let i = 0; i < siteAuth.LOCK_THRESHOLD; i++) siteAuth._noteFailure('tenant-lock', pid, '198.51.100.1');
    assert.ok(siteAuth._lockRemaining('tenant-lock', pid, '198.51.100.1') > 0);
    assert.strictEqual(siteAuth._lockRemaining('tenant-lock', pid, '198.51.100.2'), 0);
    siteAuth.dropFailures('tenant-lock', pid);
});

/* ------------------------------------------------------------------ */
/* per-user lockout                                                    */
/* ------------------------------------------------------------------ */

const MIN = 60 * 1000;

/** A domain lockout policy as ldap.readLockoutPolicy returns it. */
function adPolicy(threshold, windowMin) {
    return threshold === 0 ? { threshold: 0, windowMs: null } : { threshold, windowMs: windowMin * MIN };
}

/**
 * A protected site whose directory reports `policy` (an object, or a function
 * that throws for "unreadable"), and a verifier that counts binds. Every
 * attempt comes from its own address so the per-address lock never fires:
 * what is measured here is the per-user counter alone.
 */
function userLockSite(t, slug, pid, policy, answer) {
    const tenantPaths = seed(slug, pid, { name: pid, auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const binds = [];
    siteAuth._setThresholdReader(typeof policy === 'function' ? policy : () => policy);
    siteAuth._setVerifier((config, username, password) => {
        binds.push({ username, at: Date.now() });
        return answer ? answer(username, password, binds.length)
            : { ok: false, error: 'ldap_invalid_credentials' };
    });
    t.after(() => {
        siteAuth._setVerifier(null);
        siteAuth._setThresholdReader(null);
        siteAuth.dropFailures(slug, pid);
        siteAuth.dropSessions(slug, pid);
    });
    let n = 0;
    const attempt = (username, password) => {
        n += 1;
        return login(slug, tenantPaths, pid, { username, password: password || 'wrong', next: '/' },
            { ip: `198.18.${(n >> 8) & 255}.${n & 255}` });
    };
    return { tenantPaths, binds, attempt };
}

/**
 * Posts as `username` until `count` binds have reached the directory, waiting
 * out each lock on the fake clock the moment it is announced.
 */
async function bindThrough(site, advance, username, count) {
    for (let guard = 0; site.binds.length < count; guard++) {
        assert.ok(guard < 100, 'the attempts never reached the directory');
        const { res } = await site.attempt(username);
        if (res.statusCode === 429) advance(Number(res.headers['Retry-After']) * 1000);
    }
}

test('per-user lockout: the cap and window follow the domain policy', () => {
    assert.deepStrictEqual(siteAuth._userPolicy(adPolicy(5, 30)), { cap: 3, windowMs: 30 * MIN });
    assert.deepStrictEqual(siteAuth._userPolicy(adPolicy(10, 10)), { cap: 8, windowMs: 10 * MIN });
    assert.strictEqual(siteAuth._userPolicy(adPolicy(2, 30)).cap, 1);
    assert.strictEqual(siteAuth._userPolicy(adPolicy(1, 30)).cap, 1);
    assert.deepStrictEqual(siteAuth._userPolicy(adPolicy(0)), { cap: 5, windowMs: 15 * MIN },
        'AD never locks: five tries per quarter hour');
    assert.deepStrictEqual(siteAuth._userPolicy(null), { cap: 2, windowMs: 30 * MIN },
        'unreadable: the conservative pair');
});

test('per-user lockout: failures from several IPs on one user lock that user for the window', async (t) => {
    const advance = fakeClock(t);
    const site = userLockSite(t, 'tenant-ulock', 'ulock', adPolicy(5, 30));
    await bindThrough(site, advance, 'alice', 3);
    const { res } = await site.attempt('alice');
    assert.strictEqual(res.statusCode, 429, 'threshold 5 caps the user at 3');
    assert.ok(Number(res.headers['Retry-After']) >= 30 * 60, 'no bind until the window has passed');
    assert.strictEqual(site.binds.length, 3);
    const other = await site.attempt('bob');
    assert.strictEqual(other.res.statusCode, 401, 'another user on the same site is not locked');
});

test('per-user lockout: DOMAIN\\Alice, alice@corp.local and ALICE share one counter', async (t) => {
    const advance = fakeClock(t);
    const site = userLockSite(t, 'tenant-uspell', 'uspell', adPolicy(5, 30));
    for (const name of ['CORP\\Alice', 'alice@corp.local', 'ALICE']) {
        await bindThrough(site, advance, name, site.binds.length + 1);
    }
    const { res } = await site.attempt('Alice');
    assert.strictEqual(res.statusCode, 429);
    assert.ok(Number(res.headers['Retry-After']) >= 30 * 60);
});

test('per-user lockout: a locked user is refused before any bind', async (t) => {
    const advance = fakeClock(t);
    const site = userLockSite(t, 'tenant-ubind', 'ubind', adPolicy(5, 30));
    await bindThrough(site, advance, 'alice', 3);
    const { res } = await site.attempt('alice', SECRET);
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(site.binds.length, 3, 'the fourth attempt never reached the directory');
    // The page says what the address lock says, whatever the account.
    const ghost = userLockSite(t, 'tenant-ughost', 'ughost', adPolicy(5, 30),
        () => ({ ok: false, error: 'ldap_user_not_found' }));
    await bindThrough(ghost, advance, 'nobody', 3);
    const locked = await ghost.attempt('nobody');
    assert.strictEqual(locked.res.statusCode, 429, 'an unknown name locks exactly like a real one');
});

test('per-user lockout: parallel attempts on one account put one bind to the directory at a time', async (t) => {
    let release;
    const gateOpen = new Promise((r) => { release = r; });
    const site = userLockSite(t, 'tenant-upar', 'upar', adPolicy(5, 30));
    siteAuth._setVerifier(async (config, username) => {
        site.binds.push({ username, at: Date.now() });
        await gateOpen;
        return { ok: false, error: 'ldap_invalid_credentials' };
    });
    // Ten at once: without a guard, all ten pass the lock check before the
    // first failure is noted, and ten bad passwords reach the directory.
    const burst = [];
    for (let i = 0; i < 10; i++) burst.push(site.attempt('CORP\\Alice'));
    await new Promise((r) => setTimeout(r, 50));
    release();
    const codes = (await Promise.all(burst)).map((a) => a.res.statusCode);
    assert.strictEqual(site.binds.length, 1, `one bind in flight per account, saw ${site.binds.length}`);
    assert.strictEqual(codes.filter((c) => c === 401).length, 1);
    assert.strictEqual(codes.filter((c) => c === 429).length, 9);
});

test('per-user lockout: a refusal while locked does not extend the lock', async (t) => {
    const advance = fakeClock(t);
    const site = userLockSite(t, 'tenant-uspray', 'uspray', adPolicy(5, 30));
    await bindThrough(site, advance, 'alice', 3);
    const first = siteAuth._lockRemaining('tenant-uspray', 'uspray', 'none', 'alice');
    for (let i = 0; i < 20; i++) await site.attempt('alice');
    const later = siteAuth._lockRemaining('tenant-uspray', 'uspray', 'none', 'alice');
    assert.ok(first > 0 && later <= first, `the lock must not grow while locked (${first} then ${later})`);
    assert.strictEqual(site.binds.length, 3);
});

test('per-user lockout: under the cap the delay doubles per failure, capped at 30 min', (t) => {
    const advance = fakeClock(t);
    const slug = 'tenant-udouble';
    const pid = 'udouble';
    t.after(() => siteAuth.dropFailures(slug, pid));
    const policy = { cap: 9, windowMs: 120 * MIN };

    siteAuth._noteUserFailure(slug, pid, 'alice', policy);
    assert.strictEqual(siteAuth._lockRemaining(slug, pid, 'none', 'alice'), 0, 'one typo is free');

    let expected = siteAuth.LOCK_MS / 1000;
    for (let n = 2; n < policy.cap; n++) {
        siteAuth._noteUserFailure(slug, pid, 'alice', policy);
        const left = siteAuth._lockRemaining(slug, pid, 'none', 'alice');
        assert.strictEqual(left, Math.min(expected, 30 * 60), `failure ${n}`);
        expected *= 2;
        advance(left * 1000);
        assert.strictEqual(siteAuth._lockRemaining(slug, pid, 'none', 'alice'), 0, 'the delay ends on time');
    }
    siteAuth._noteUserFailure(slug, pid, 'alice', policy);
    assert.ok(siteAuth._lockRemaining(slug, pid, 'none', 'alice') >= 120 * 60, 'at the cap: the window');
});

/**
 * The directory's own bookkeeping, as AD keeps it: a bad password more than
 * one observation window after the previous one starts the count over. Strict
 * `>`, which is the reading least favourable to the guard.
 */
function adModel(windowMs) {
    const ad = { count: 0, last: -Infinity, peak: 0, times: [] };
    ad.bad = (now) => {
        if (now - ad.last > windowMs) ad.count = 0;
        ad.count += 1;
        ad.last = now;
        ad.times.push(now);
        ad.peak = Math.max(ad.peak, ad.count);
    };
    return ad;
}

for (const [label, read, adThreshold, adWindowMin] of [
    ['threshold 3', adPolicy(3, 30), 3, 30],
    ['threshold 5', adPolicy(5, 30), 5, 30],
    ['threshold 10', adPolicy(10, 10), 10, 10],
    ['unreadable', () => { throw new Error('ldap_search_denied'); }, 3, 30]
]) {
    test(`per-user lockout: ${label}, an attacker retrying the instant each lock ends never reaches AD's threshold`, async (t) => {
        const advance = fakeClock(t);
        const windowMs = adWindowMin * MIN;
        const ad = adModel(windowMs);
        const site = userLockSite(t, `tenant-uad-${label.replace(/\W/g, '')}`, 'uad', read, () => {
            ad.bad(Date.now());
            return { ok: false, error: 'ldap_invalid_credentials' };
        });
        const start = Date.now();
        for (let guard = 0; Date.now() - start < 4 * windowMs; guard++) {
            assert.ok(guard < 1000, 'the attack loop did not move the clock');
            const { res } = await site.attempt('alice');
            advance(res.statusCode === 429 ? Number(res.headers['Retry-After']) * 1000 : 1);
        }
        assert.ok(ad.times.length >= 4, `the attack got binds through (${ad.times.length})`);
        assert.ok(ad.peak < adThreshold, `AD counted ${ad.peak} bad passwords, threshold ${adThreshold}`);
        for (const from of ad.times) {
            const inWindow = ad.times.filter((x) => x >= from && x < from + windowMs).length;
            assert.ok(inWindow < adThreshold, `${inWindow} binds inside one window from ${from - start} ms`);
        }
    });
}

test('per-user lockout: after the window the user can sign in', async (t) => {
    const advance = fakeClock(t);
    const site = userLockSite(t, 'tenant-uafter', 'uafter', adPolicy(5, 30), (u, password) => (password === SECRET
        ? { ok: true, groups: [] }
        : { ok: false, error: 'ldap_invalid_credentials' }));
    await bindThrough(site, advance, 'alice', 3);
    const locked = await site.attempt('alice', SECRET);
    assert.strictEqual(locked.res.statusCode, 429);
    advance(Number(locked.res.headers['Retry-After']) * 1000);
    const { res } = await site.attempt('alice', SECRET);
    assert.strictEqual(res.statusCode, 302, 'the window has passed and the right password opens the site');
});

test('per-user lockout: success clears both ip and user counters', async (t) => {
    const advance = fakeClock(t);
    const slug = 'tenant-uclear';
    const pid = 'uclear';
    const tenantPaths = seed(slug, pid, { name: pid, auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const ip = '192.0.2.200';
    siteAuth._setThresholdReader(() => adPolicy(5, 30));
    siteAuth._setVerifier((config, username, password) => (password === SECRET
        ? { ok: true, groups: [], sid: '' }
        : { ok: false, error: 'ldap_invalid_credentials' }));
    t.after(() => {
        siteAuth._setVerifier(null);
        siteAuth._setThresholdReader(null);
        siteAuth.dropFailures(slug, pid);
        siteAuth.dropSessions(slug, pid);
    });
    const tryAs = (password) => login(slug, tenantPaths, pid, { username: 'alice', password, next: '/' }, { ip });

    // Two below each cap (user 3, address 5), then a success.
    for (let i = 0; i < 2; i++) siteAuth._noteFailure(slug, pid, ip);
    assert.strictEqual((await tryAs('wrong')).res.statusCode, 401);
    assert.strictEqual((await tryAs('wrong')).res.statusCode, 401);
    advance(siteAuth._lockRemaining(slug, pid, ip, 'alice') * 1000);
    assert.strictEqual((await tryAs(SECRET)).res.statusCode, 302);

    // Had either counter survived, two more failures would lock it.
    assert.strictEqual((await tryAs('wrong')).res.statusCode, 401);
    assert.strictEqual(siteAuth._lockRemaining(slug, pid, ip, 'alice'), 0, 'the first failure after a success is free');
});

test('per-user lockout: threshold 0 allows five, an unreadable policy two', async (t) => {
    const advance = fakeClock(t);
    const open = userLockSite(t, 'tenant-uzero', 'uzero', adPolicy(0));
    await bindThrough(open, advance, 'alice', 5);
    const capped = await open.attempt('alice');
    assert.strictEqual(capped.res.statusCode, 429);
    assert.ok(Number(capped.res.headers['Retry-After']) >= 15 * 60);

    const blind = userLockSite(t, 'tenant-ublind', 'ublind', () => { throw new Error('ldap_search_denied'); });
    await bindThrough(blind, advance, 'alice', 2);
    const shut = await blind.attempt('alice');
    assert.strictEqual(shut.res.statusCode, 429);
    assert.ok(Number(shut.res.headers['Retry-After']) >= 30 * 60);
});

test('per-user lockout: empty, blank and prefix-only names are refused before counting', async (t) => {
    const site = userLockSite(t, 'tenant-uempty', 'uempty', adPolicy(5, 30));
    for (const name of ['', '   ', 'CORP\\', '@corp.local', 'CORP\\ ']) {
        for (let i = 0; i < 4; i++) {
            const { res } = await site.attempt(name);
            assert.strictEqual(res.statusCode, 400, `"${name}" is an empty form`);
        }
    }
    assert.strictEqual(site.binds.length, 0, 'nothing reached the directory');
    assert.strictEqual(siteAuth._lockRemaining('tenant-uempty', 'uempty', 'none', ''), 0);
});

test('per-user lockout: a directory fault or a correct but expired password does not count', async (t) => {
    for (const error of ['ldap_unreachable', 'ldap_password_expired', 'ldap_password_must_change']) {
        const site = userLockSite(t, `tenant-unc-${error.replace(/_/g, '-')}`, 'unc', adPolicy(5, 30),
            () => ({ ok: false, error }));
        for (let i = 0; i < 5; i++) assert.notStrictEqual((await site.attempt('alice')).res.statusCode, 429, error);
        assert.strictEqual(site.binds.length, 5, `${error}: every attempt was put to the directory`);
    }
});

test('per-user lockout: two tenants with the same project id and user do not lock or clear each other', async (t) => {
    const advance = fakeClock(t);
    const a = userLockSite(t, 'tenant-iso-a', 'shared', adPolicy(5, 30));
    await bindThrough(a, advance, 'alice', 3);
    assert.ok(siteAuth._lockRemaining('tenant-iso-a', 'shared', 'none', 'alice') > 0);
    assert.strictEqual(siteAuth._lockRemaining('tenant-iso-b', 'shared', 'none', 'alice'), 0);

    const b = userLockSite(t, 'tenant-iso-b', 'shared', adPolicy(5, 30), (u, password) => (password === SECRET
        ? { ok: true, groups: [] } : { ok: false, error: 'ldap_invalid_credentials' }));
    assert.strictEqual((await b.attempt('alice', SECRET)).res.statusCode, 302, 'B never saw A\'s failures');
    siteAuth.dropFailures('tenant-iso-b', 'shared');
    assert.ok(siteAuth._lockRemaining('tenant-iso-a', 'shared', 'none', 'alice') > 0,
        'a success and a drop on B leave A locked');

    for (let i = 0; i < siteAuth.LOCK_THRESHOLD; i++) siteAuth._noteFailure('tenant-iso-a', 'shared', '10.9.9.9');
    assert.strictEqual(siteAuth._lockRemaining('tenant-iso-b', 'shared', '10.9.9.9'), 0, 'address locks too');
});

test('per-user lockout: a spray cannot evict a target\'s count, and a full map fails closed', async (t) => {
    const advance = fakeClock(t);
    const slug = 'tenant-ubound';
    const pid = 'ubound';
    t.after(() => siteAuth.dropFailures(slug, pid));
    const policy = { cap: 3, windowMs: 30 * MIN };
    siteAuth._noteFailure(slug, pid, '10.1.1.1');
    siteAuth._noteUserFailure(slug, pid, 'victim', policy);
    siteAuth._noteUserFailure(slug, pid, 'victim', policy);
    advance(siteAuth._lockRemaining(slug, pid, 'none', 'victim') * 1000);
    assert.strictEqual(siteAuth._lockRemaining(slug, pid, 'none', 'victim'), 0, 'two failures, no lock now');

    for (let i = 0; i < siteAuth.MAX_FAILURE_ENTRIES + 50; i++) {
        siteAuth._noteUserFailure(slug, pid, `spray${i}`, policy);
    }
    assert.ok(siteAuth._failureCount() <= siteAuth.MAX_FAILURE_ENTRIES,
        `the map holds at most ${siteAuth.MAX_FAILURE_ENTRIES}, got ${siteAuth._failureCount()}`);

    // The count survived: one more failure is the third, and locks for the window.
    siteAuth._noteUserFailure(slug, pid, 'victim', policy);
    assert.ok(siteAuth._lockRemaining(slug, pid, 'none', 'victim') >= 30 * 60, 'the victim\'s count was kept');

    // A name the full map cannot track is refused without a bind.
    const site = userLockSite(t, slug, pid, adPolicy(5, 30));
    const { res } = await site.attempt('newcomer');
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(site.binds.length, 0, 'no bind for an account the guard cannot count');
});

test('per-user lockout: the policy is cached, shared by concurrent reads, and a save forgets it', async (t) => {
    const site = userLockSite(t, 'tenant-ucache', 'ucache', adPolicy(5, 30));
    let reads = 0;
    siteAuth._setThresholdReader(async () => {
        reads += 1;
        await new Promise((r) => setTimeout(r, 20));
        return adPolicy(5, 30);
    });
    await Promise.all([site.attempt('alice'), site.attempt('bob'), site.attempt('carol')]);
    assert.strictEqual(reads, 1, 'three first failures, one read');
    await site.attempt('dave');
    assert.strictEqual(reads, 1, 'then served from the cache');
    authStore.writeConfig(site.tenantPaths, { revalidateMinutes: 10 });
    siteAuth.invalidate('tenant-ucache', 'ucache');
    await site.attempt('erin');
    assert.strictEqual(reads, 2, 'a save is a new directory, read again');
    assert.deepStrictEqual(authStore.cachedLockoutPolicy(site.tenantPaths), adPolicy(5, 30));
});

test('per-user lockout: a cached policy expires after 24 h', (t) => {
    const advance = fakeClock(t);
    const tenantPaths = newTenant();
    authStore.rememberLockoutPolicy(tenantPaths, adPolicy(7, 30));
    assert.deepStrictEqual(authStore.cachedLockoutPolicy(tenantPaths), adPolicy(7, 30));
    advance(24 * 60 * 60 * 1000 + 1);
    assert.strictEqual(authStore.cachedLockoutPolicy(tenantPaths), undefined);
});

/* ------------------------------------------------------------------ */
/* the gate                                                            */
/* ------------------------------------------------------------------ */

test('gate: an unprotected project is passed straight through', async () => {
    const slug = 'tenant-open';
    const tenantPaths = seed(slug, 'open-site', { name: 'Open site' }, null);
    const res = fakeRes();
    const handled = await siteAuth.gate(fakeReq('GET', '/index.html'), res, {
        slug, tenantPaths, project: { id: 'open-site', name: 'Open site' }
    });
    assert.strictEqual(handled, false);
    assert.strictEqual(res.headersSent, false, 'the guard must not answer for an open site');
});

test('gate: an auth record with enabled:false is still open', async () => {
    const slug = 'tenant-off';
    const tenantPaths = seed(slug, 'off-site',
        { name: 'Off', auth: { enabled: false, allowedGroups: ['Domain Admins'] } }, GOOD_CONFIG);
    const res = fakeRes();
    const handled = await siteAuth.gate(fakeReq('GET', '/'), res, {
        slug, tenantPaths, project: { id: 'off-site', name: 'Off' }
    });
    assert.strictEqual(handled, false);
});

test('gate: the /__aegis/ prefix is reserved even on an unprotected site', async () => {
    const slug = 'tenant-open2';
    const tenantPaths = seed(slug, 'open2', { name: 'Open' }, null);
    for (const url of ['/__aegis/login', '/__aegis/anything', '/__aegis']) {
        const res = fakeRes();
        const handled = await siteAuth.gate(fakeReq('GET', url), res, {
            slug, tenantPaths, project: { id: 'open2', name: 'Open' }
        });
        assert.strictEqual(handled, true, `${url} must be intercepted`);
        assert.strictEqual(res.statusCode, 404);
    }
});

test('gate: a protected project with no directory configured is refused, not served', async () => {
    const slug = 'tenant-noconf';
    const tenantPaths = seed(slug, 'locked',
        { name: 'Locked', auth: { enabled: true, allowedGroups: [] } }, null);

    for (const url of ['/', '/index.html', '/__aegis/login']) {
        const res = fakeRes();
        const handled = await siteAuth.gate(fakeReq('GET', url), res, {
            slug, tenantPaths, project: { id: 'locked', name: 'Locked' }
        });
        assert.strictEqual(handled, true, `${url} must never reach the file server`);
        assert.strictEqual(res.statusCode, 503, `${url} must fail closed`);
    }

    // A half-written directory record is the same as none.
    authStore.writeConfig(tenantPaths, { url: 'ldap://dc01.corp.local:389', baseDn: '' });
    siteAuth.invalidate(slug, 'locked');
    const res = fakeRes();
    const handled = await siteAuth.gate(fakeReq('GET', '/'), res, {
        slug, tenantPaths, project: { id: 'locked', name: 'Locked' }
    });
    assert.strictEqual(handled, true);
    assert.strictEqual(res.statusCode, 503);
});

test('gate: an anonymous request to a protected site is redirected to the login', async () => {
    const slug = 'tenant-prot';
    const tenantPaths = seed(slug, 'prot',
        { name: 'Prot', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const res = fakeRes();
    const handled = await siteAuth.gate(fakeReq('GET', '/deep/page.html?a=1'), res, {
        slug, tenantPaths, project: { id: 'prot', name: 'Prot' }
    });
    assert.strictEqual(handled, true);
    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.headers.Location,
        '/__aegis/login?next=' + encodeURIComponent('/deep/page.html?a=1'));
});

/* ------------------------------------------------------------------ */
/* template rendering and escaping                                     */
/* ------------------------------------------------------------------ */

test('escaping: all five characters are replaced', () => {
    assert.strictEqual(
        siteAuth._escapeHtml(`<img src="x" onerror='y'>&`),
        '&lt;img src=&quot;x&quot; onerror=&#39;y&#39;&gt;&amp;');
    assert.strictEqual(siteAuth._escapeHtml(null), '');
    assert.strictEqual(siteAuth._escapeHtml(undefined), '');
});

test('escaping: a hostile site name cannot break out of the login template', () => {
    const body = siteAuth._renderLogin({
        lang: 'en',
        siteName: '</title><script>alert(1)</script>',
        next: '/a/b" onload="alert(2)',
        error: '<b>boom</b>',
        csrf: 'tok"en',
        username: `o'brien<`
    });
    assert.ok(body, 'the template must be readable from disk');
    assert.ok(!/<script>/.test(body), 'no raw script tag may survive');
    assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(body.includes('&quot; onload=&quot;alert(2)'));
    assert.ok(body.includes('&lt;b&gt;boom&lt;/b&gt;'));
    assert.ok(body.includes('value="tok&quot;en"'));
    assert.ok(body.includes('o&#39;brien&lt;'));
});

test('login page: it is read from disk and carries no password field value', async () => {
    const slug = 'tenant-page';
    const tenantPaths = seed(slug, 'page',
        { name: '<b>Sales</b>', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const res = fakeRes();
    const handled = await siteAuth.gate(
        fakeReq('GET', '/__aegis/login?next=%2Freports', { headers: { 'accept-language': 'fr-FR,fr;q=0.9' } }),
        res, { slug, tenantPaths, project: { id: 'page', name: '<b>Sales</b>' } });

    assert.strictEqual(handled, true);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.includes('&lt;b&gt;Sales&lt;/b&gt;'), 'the site name must be escaped');
    assert.ok(res.body.includes('Se connecter'), 'Accept-Language fr must select the French block');
    assert.ok(res.body.includes('name="next" value="/reports"'));
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(res.body), 'every placeholder must be substituted');
    assert.ok(/id="password"[^>]*>/.test(res.body));
    assert.ok(!/id="password"[^>]*value=/.test(res.body), 'the password field must never carry a value');
    assert.ok(String(res.headers['Set-Cookie']).includes('aegis_site_csrf='));
});

test('login page: Accept-Language chooses English when French is not asked for', async () => {
    const slug = 'tenant-page-en';
    const tenantPaths = seed(slug, 'pageen',
        { name: 'Sales', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const res = fakeRes();
    await siteAuth.gate(
        fakeReq('GET', '/__aegis/login', { headers: { 'accept-language': 'en-GB,en;q=0.9' } }),
        res, { slug, tenantPaths, project: { id: 'pageen', name: 'Sales' } });
    assert.ok(res.body.includes('Sign in'));
});

/* ------------------------------------------------------------------ */
/* the page's corners and its own files                                */
/* ------------------------------------------------------------------ */

test('login page: the site icon top left, Aegis bottom left, and a CSP that still allows no script', async () => {
    const slug = 'tenant-corners';
    const tenantPaths = seed(slug, 'corners',
        { name: 'Sales', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const res = fakeRes();
    await siteAuth.gate(fakeReq('GET', '/__aegis/login'), res,
        { slug, tenantPaths, project: { id: 'corners', name: 'Sales' } });

    assert.match(res.body, /<header class="auth-site">[\s\S]*src="\/__aegis\/site-icon"[\s\S]*Sales[\s\S]*<\/header>/);
    assert.match(res.body, /<footer class="auth-brand"[\s\S]*src="\/__aegis\/aegis-mark.svg"[\s\S]*Aegis[\s\S]*<\/footer>/);
    const csp = res.headers['Content-Security-Policy'];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /img-src 'self'/);
    assert.match(csp, /font-src 'self'/);
    assert.ok(!/script-src/.test(csp), 'the page runs no script, so the policy names none');
    assert.strictEqual(res.headers['Referrer-Policy'], 'no-referrer');
    assert.ok(!/<script/i.test(res.body));
});

test('assets: the stylesheet, the Aegis mark and the wordmark font, each with its own type', async () => {
    const slug = 'tenant-assets';
    const tenantPaths = seed(slug, 'assets',
        { name: 'Assets', auth: { enabled: true, allowedGroups: [] } }, null);
    const ctx = { slug, tenantPaths, project: { id: 'assets', name: 'Assets' } };
    const want = {
        '/__aegis/login.css': /^text\/css/,
        '/__aegis/aegis-mark.svg': /^image\/svg\+xml$/,
        '/__aegis/nevera.otf': /^font\/otf$/
    };
    for (const [url, type] of Object.entries(want)) {
        const res = fakeRes();
        // No directory configured: the refusal page needs these all the same.
        assert.strictEqual(await siteAuth.gate(fakeReq('GET', url), res, ctx), true);
        assert.strictEqual(res.statusCode, 200, url);
        assert.match(res.headers['Content-Type'], type, url);
        assert.strictEqual(res.headers['X-Content-Type-Options'], 'nosniff', url);
        assert.ok(res.headers['Content-Length'] > 0, url);
    }
});

test('site icon: read from the deployed files before sign-in, a monogram when there are none', async () => {
    const slug = 'tenant-icon';
    const tenantPaths = seed(slug, 'icon',
        { name: 'Sales', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-icon-root-'));
    fs.writeFileSync(path.join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');

    const withIcon = fakeRes();
    await siteAuth.gate(fakeReq('GET', '/__aegis/site-icon'), withIcon,
        { slug, tenantPaths, project: { id: 'icon', name: 'Sales' }, root });
    assert.strictEqual(withIcon.statusCode, 200);
    assert.match(withIcon.body, /<circle/);
    assert.match(withIcon.headers['Content-Security-Policy'], /sandbox/);

    const without = fakeRes();
    await siteAuth.gate(fakeReq('GET', '/__aegis/site-icon'), without,
        { slug, tenantPaths, project: { id: 'icon', name: 'Sales' } });
    assert.strictEqual(without.statusCode, 200);
    assert.match(without.body, />S<\/text>/);
});

test('site icon: an unprotected site keeps the whole prefix reserved', async () => {
    const slug = 'tenant-icon-open';
    const tenantPaths = seed(slug, 'open', { name: 'Open' }, GOOD_CONFIG);
    const res = fakeRes();
    await siteAuth.gate(fakeReq('GET', '/__aegis/site-icon'), res,
        { slug, tenantPaths, project: { id: 'open', name: 'Open' } });
    assert.strictEqual(res.statusCode, 404);
});

test('refusal page: it carries the Aegis mark like the form does', async () => {
    const slug = 'tenant-refusal-brand';
    const tenantPaths = seed(slug, 'refused',
        { name: 'Refused', auth: { enabled: true, allowedGroups: [] } }, null);
    const res = fakeRes();
    await siteAuth.gate(fakeReq('GET', '/'), res,
        { slug, tenantPaths, project: { id: 'refused', name: 'Refused' } });
    assert.strictEqual(res.statusCode, 503);
    assert.match(res.body, /class="auth-brand"[\s\S]*aegis-mark.svg/);
});

/* ------------------------------------------------------------------ */
/* the login exchange, with an injected verifier                       */
/* ------------------------------------------------------------------ */

const SECRET = 'correct-horse-battery';

async function login(slug, tenantPaths, projectId, fields, opts) {
    const o = opts || {};
    // First the form, to obtain the CSRF pair the POST has to present.
    const get = fakeRes();
    await siteAuth.gate(fakeReq('GET', '/__aegis/login', { secure: o.secure }), get,
        { slug, tenantPaths, project: { id: projectId, name: projectId } });
    const csrf = cookieValue(get.headers['Set-Cookie'], 'aegis_site_csrf');

    const body = new URLSearchParams(Object.assign({ csrf }, fields)).toString();
    const res = fakeRes();
    const handled = await siteAuth.gate(fakeReq('POST', '/__aegis/login', {
        body,
        ip: o.ip || '10.0.0.9',
        secure: o.secure,
        headers: {
            cookie: `aegis_site_csrf=${csrf}`,
            'content-type': 'application/x-www-form-urlencoded'
        }
    }), res, { slug, tenantPaths, project: { id: projectId, name: projectId } });
    return { res, handled };
}

test('login: a valid user is given a session and sent to the validated next', async () => {
    const slug = 'tenant-login';
    const tenantPaths = seed(slug, 'app',
        { name: 'App', auth: { enabled: true, allowedGroups: ['Domain Admins'] } }, GOOD_CONFIG);

    let seenPassword = null;
    siteAuth._setVerifier((config, username, password) => {
        seenPassword = password;
        assert.strictEqual(config.bindPassword, 'service-secret',
            'the verifier must receive the decrypted bind password');
        return { ok: true, dn: 'CN=J Doe,DC=corp,DC=local', displayName: 'J Doe',
            groups: ['CN=Domain Admins,CN=Users,DC=corp,DC=local'] };
    });

    try {
        const { res, handled } = await login(slug, tenantPaths, 'app',
            { username: 'jdoe', password: SECRET, next: '/a/b' });

        assert.strictEqual(handled, true);
        assert.strictEqual(res.statusCode, 302);
        assert.strictEqual(res.headers.Location, '/a/b');
        assert.strictEqual(seenPassword, SECRET, 'the verifier is the only consumer of the password');

        const setCookie = String(res.headers['Set-Cookie']);
        assert.ok(setCookie.includes('HttpOnly'));
        assert.ok(setCookie.includes('SameSite=Lax'));
        assert.ok(/;\s*Secure/.test(setCookie), 'a protected site is served over TLS, so the cookie is Secure');
        assert.ok(!(res.body + JSON.stringify(res.headers)).includes(SECRET),
            'the password must not appear anywhere in the response');

        // The session it just minted opens the site.
        const token = cookieValue(setCookie, 'aegis_site');
        const res2 = fakeRes();
        const handled2 = await siteAuth.gate(
            fakeReq('GET', '/a/b', { headers: { cookie: `aegis_site=${token}` } }), res2,
            { slug, tenantPaths, project: { id: 'app', name: 'App' } });
        assert.strictEqual(handled2, false, 'an authenticated request must be served');

        // The same token on another project is not a session there.
        const otherPaths = seed('tenant-other', 'app',
            { name: 'App', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
        const res3 = fakeRes();
        const handled3 = await siteAuth.gate(
            fakeReq('GET', '/', { headers: { cookie: `aegis_site=${token}` } }), res3,
            { slug: 'tenant-other', tenantPaths: otherPaths, project: { id: 'app', name: 'App' } });
        assert.strictEqual(handled3, true);
        assert.strictEqual(res3.statusCode, 302);
    } finally {
        siteAuth._setVerifier(null);
    }
});

test('login: an authenticated user outside the allowed groups is refused', async () => {
    const slug = 'tenant-group';
    const tenantPaths = seed(slug, 'grp',
        { name: 'Grp', auth: { enabled: true, allowedGroups: ['Domain Admins'] } }, GOOD_CONFIG);

    siteAuth._setVerifier(() => ({
        ok: true, dn: 'CN=Temp,DC=corp,DC=local',
        groups: ['CN=Helpdesk,OU=Groups,DC=corp,DC=local']
    }));
    try {
        const { res } = await login(slug, tenantPaths, 'grp',
            { username: 'temp', password: SECRET, next: '/' }, { ip: '10.0.0.31' });
        assert.strictEqual(res.statusCode, 403);
        assert.ok(!res.body.includes(SECRET));
        assert.strictEqual(cookieValue(res.headers['Set-Cookie'], 'aegis_site'), null);
    } finally {
        siteAuth._setVerifier(null);
        siteAuth.dropFailures(slug, 'grp');
    }
});

test('login: bad credentials re-render the form with the username and never the password', async () => {
    const slug = 'tenant-bad';
    const tenantPaths = seed(slug, 'bad',
        { name: 'Bad', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);

    siteAuth._setVerifier(() => ({ ok: false, error: 'ldap_invalid_credentials' }));
    try {
        const { res } = await login(slug, tenantPaths, 'bad',
            { username: 'jdoe', password: SECRET, next: '/' }, { ip: '10.0.0.41' });
        assert.strictEqual(res.statusCode, 401);
        assert.ok(res.body.includes('value="jdoe"'), 'the username is kept for convenience');
        assert.ok(!res.body.includes(SECRET), 'the password is never echoed');
        assert.ok(!res.body.includes('ldap_invalid_credentials'),
            'the machine code stays out of the page');
    } finally {
        siteAuth._setVerifier(null);
        siteAuth.dropFailures(slug, 'bad');
    }
});

test('login: the sixth attempt from one address is answered with 429', async () => {
    const slug = 'tenant-brute';
    const tenantPaths = seed(slug, 'brute',
        { name: 'Brute', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const ip = '203.0.113.9';
    siteAuth.dropFailures(slug, 'brute');

    siteAuth._setVerifier(() => ({ ok: false, error: 'ldap_invalid_credentials' }));
    try {
        // One name per attempt: the per-user counter would otherwise lock
        // first, and this test is about the address.
        for (let i = 0; i < siteAuth.LOCK_THRESHOLD; i++) {
            const { res } = await login(slug, tenantPaths, 'brute',
                { username: `jdoe${i}`, password: 'wrong', next: '/' }, { ip });
            assert.strictEqual(res.statusCode, 401, `attempt ${i + 1} should still be answered`);
        }
        const { res } = await login(slug, tenantPaths, 'brute',
            { username: 'someone-else', password: 'wrong', next: '/' }, { ip });
        assert.strictEqual(res.statusCode, 429);
        assert.ok(Number(res.headers['Retry-After']) > 0);
        assert.ok(/\b\d+\b/.test(res.body), 'the page states how long is left');
        // The form it shows must be one that can be submitted once the wait is
        // over: its token and its cookie have to be the same pair.
        const field = /name="csrf" value="([^"]+)"/.exec(res.body);
        assert.ok(field, 'the locked page still carries a form');
        assert.strictEqual(cookieValue(res.headers['Set-Cookie'], 'aegis_site_csrf'), field[1]);
    } finally {
        siteAuth._setVerifier(null);
        siteAuth.dropFailures(slug, 'brute');
    }
});

test('login: a POST without the matching CSRF cookie is rejected', async () => {
    const slug = 'tenant-csrf';
    const tenantPaths = seed(slug, 'csrf',
        { name: 'Csrf', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);

    let called = false;
    siteAuth._setVerifier(() => { called = true; return { ok: true, groups: [] }; });
    try {
        const res = fakeRes();
        await siteAuth.gate(fakeReq('POST', '/__aegis/login', {
            ip: '10.0.0.51',
            body: 'username=jdoe&password=x&csrf=forged&next=%2F'
        }), res, { slug, tenantPaths, project: { id: 'csrf', name: 'Csrf' } });
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(called, false, 'the directory is not consulted for a forged post');
    } finally {
        siteAuth._setVerifier(null);
        siteAuth.dropFailures(slug, 'csrf');
    }
});

test('login: a body over the cap is rejected without reaching the directory', async () => {
    const slug = 'tenant-big';
    const tenantPaths = seed(slug, 'big',
        { name: 'Big', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);

    let called = false;
    siteAuth._setVerifier(() => { called = true; return { ok: true, groups: [] }; });
    try {
        const res = fakeRes();
        await siteAuth.gate(fakeReq('POST', '/__aegis/login', {
            ip: '10.0.0.61',
            body: 'username=jdoe&password=' + 'a'.repeat(16 * 1024)
        }), res, { slug, tenantPaths, project: { id: 'big', name: 'Big' } });
        assert.ok(res.statusCode === 400, `expected 400, got ${res.statusCode}`);
        assert.strictEqual(called, false);
    } finally {
        siteAuth._setVerifier(null);
        siteAuth.dropFailures(slug, 'big');
    }
});

test('logout: the session is dropped and the cookie expired', async () => {
    const slug = 'tenant-out';
    const tenantPaths = seed(slug, 'out',
        { name: 'Out', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);

    siteAuth._setVerifier(() => ({ ok: true, groups: [] }));
    try {
        const { res } = await login(slug, tenantPaths, 'out',
            { username: 'jdoe', password: SECRET, next: '/' }, { ip: '10.0.0.71' });
        const token = cookieValue(res.headers['Set-Cookie'], 'aegis_site');
        assert.ok(token);

        const out = fakeRes();
        await siteAuth.gate(fakeReq('POST', '/__aegis/logout',
            { headers: { cookie: `aegis_site=${token}` } }), out,
        { slug, tenantPaths, project: { id: 'out', name: 'Out' } });
        assert.strictEqual(out.statusCode, 302);
        assert.ok(String(out.headers['Set-Cookie']).includes('Max-Age=0'));

        const after = fakeRes();
        const handled = await siteAuth.gate(
            fakeReq('GET', '/', { headers: { cookie: `aegis_site=${token}` } }), after,
            { slug, tenantPaths, project: { id: 'out', name: 'Out' } });
        assert.strictEqual(handled, true);
        assert.strictEqual(after.statusCode, 302);
    } finally {
        siteAuth._setVerifier(null);
    }
});

/* ------------------------------------------------------------------ */
/* authStore                                                           */
/* ------------------------------------------------------------------ */

test('authStore: nothing configured reads as null and as configured:false', () => {
    const tenantPaths = newTenant();
    assert.strictEqual(authStore.readConfig(tenantPaths), null);
    const pub = authStore.publicConfig(tenantPaths);
    assert.strictEqual(pub.configured, false);
    assert.strictEqual(pub.hasPassword, false);
    assert.strictEqual(pub.userFilter, authStore.DEFAULT_USER_FILTER);
    assert.strictEqual(pub.groupAttribute, authStore.DEFAULT_GROUP_ATTR);
});

test('authStore: a missing url or base dn fails closed', () => {
    const a = newTenant();
    authStore.writeConfig(a, { url: '', baseDn: 'DC=corp,DC=local' });
    assert.strictEqual(authStore.readConfig(a), null);
    assert.strictEqual(authStore.publicConfig(a).configured, false);

    const b = newTenant();
    authStore.writeConfig(b, { url: 'ldap://dc01:389', baseDn: '   ' });
    assert.strictEqual(authStore.readConfig(b), null);
});

test('authStore: round trip, and the bind password is never stored in clear', () => {
    const tenantPaths = newTenant();
    const pw = 'Tr0ub4dor&3-plain';

    const pub = authStore.writeConfig(tenantPaths, {
        url: 'ldaps://dc01.corp.local:636',
        startTls: false,
        rejectUnauthorized: true,
        bindDn: 'CN=svc-aegis,OU=Services,DC=corp,DC=local',
        bindPassword: pw,
        baseDn: 'DC=corp,DC=local',
        userDnTemplate: '{username}@corp.local'
    });

    assert.strictEqual(pub.configured, true);
    assert.strictEqual(pub.hasPassword, true);
    assert.strictEqual(pub.bindPassword, undefined, 'publicConfig must not carry the password');
    assert.ok(!JSON.stringify(pub).includes(pw));

    const raw = fs.readFileSync(authStore.storeFile(tenantPaths), 'utf8');
    assert.ok(!raw.includes(pw), 'the file on disk must not contain the plaintext password');
    assert.ok(raw.includes('bindPasswordEnc'));

    const cfg = authStore.readConfig(tenantPaths);
    assert.strictEqual(cfg.bindPassword, pw, 'readConfig decrypts it back');
    assert.strictEqual(cfg.url, 'ldaps://dc01.corp.local:636');
    assert.strictEqual(cfg.rejectUnauthorized, true);
    assert.strictEqual(cfg.userFilter, authStore.DEFAULT_USER_FILTER);
    assert.strictEqual(cfg.groupAttribute, authStore.DEFAULT_GROUP_ATTR);
    assert.strictEqual(cfg.userDnTemplate, '{username}@corp.local');
});

test('authStore: an omitted password is kept, an empty one erases it', () => {
    const tenantPaths = newTenant();
    authStore.writeConfig(tenantPaths, {
        url: 'ldap://dc01:389', baseDn: 'DC=corp,DC=local', bindPassword: 'keep-me'
    });

    const kept = authStore.writeConfig(tenantPaths, { bindDn: 'CN=other,DC=corp,DC=local' });
    assert.strictEqual(kept.hasPassword, true);
    assert.strictEqual(authStore.readConfig(tenantPaths).bindPassword, 'keep-me');
    assert.strictEqual(authStore.readConfig(tenantPaths).bindDn, 'CN=other,DC=corp,DC=local');

    const cleared = authStore.writeConfig(tenantPaths, { bindPassword: '' });
    assert.strictEqual(cleared.hasPassword, false);
    assert.strictEqual(authStore.readConfig(tenantPaths).bindPassword, '');
});

test('authStore: clearConfig removes the record and is idempotent', () => {
    const tenantPaths = newTenant();
    authStore.writeConfig(tenantPaths, { url: 'ldap://dc01:389', baseDn: 'DC=corp,DC=local' });
    assert.ok(authStore.readConfig(tenantPaths));
    authStore.clearConfig(tenantPaths);
    assert.strictEqual(authStore.readConfig(tenantPaths), null);
    authStore.clearConfig(tenantPaths);
});

/* ------------------------------------------------------------------ */
/* cache invalidation                                                  */
/* ------------------------------------------------------------------ */

test('invalidate: turning protection on takes effect without waiting for the cache', async () => {
    const slug = 'tenant-inv';
    const tenantPaths = seed(slug, 'inv', { name: 'Inv' }, GOOD_CONFIG);
    assert.strictEqual(siteAuth.isProtected(slug, tenantPaths, 'inv'), false);

    projectStore.saveProject(tenantPaths, {
        id: 'inv', name: 'Inv', port: 3081, auth: { enabled: true, allowedGroups: [] }
    });
    siteAuth.invalidate(slug, 'inv');
    assert.strictEqual(siteAuth.isProtected(slug, tenantPaths, 'inv'), true);

    const res = fakeRes();
    const handled = await siteAuth.gate(fakeReq('GET', '/'), res,
        { slug, tenantPaths, project: { id: 'inv', name: 'Inv' } });
    assert.strictEqual(handled, true);
    assert.strictEqual(res.statusCode, 302);
});

/* ------------------------------------------------------------------ */
/* the Secure cookie flag                                              */
/* ------------------------------------------------------------------ */

test('cookies: a login over a TLS socket gets Secure', async (t) => {
    const slug = 'tenant-secure';
    const tenantPaths = seed(slug, 'secure',
        { name: 'Secure', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);

    siteAuth._setVerifier(() => ({ ok: true, groups: [] }));
    t.after(() => { siteAuth._setVerifier(null); siteAuth.dropSessions(slug, 'secure'); });

    const { res } = await login(slug, tenantPaths, 'secure',
        { username: 'jdoe', password: SECRET, next: '/' }, { ip: '10.0.0.92', secure: true });
    const setCookie = String(res.headers['Set-Cookie']);

    assert.ok(setCookie.startsWith('aegis_site='));
    assert.ok(/;\s*Secure/.test(setCookie), 'an encrypted socket must carry the flag');
    assert.ok(setCookie.includes('HttpOnly'));
    assert.ok(setCookie.includes('SameSite=Lax'));
});

test('cookies: the login page CSRF cookie is Secure', async () => {
    const slug = 'tenant-csrf-flag';
    const tenantPaths = seed(slug, 'csrfflag',
        { name: 'Csrf', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const ctx = { slug, tenantPaths, project: { id: 'csrfflag', name: 'Csrf' } };

    const encrypted = fakeRes();
    await siteAuth.gate(fakeReq('GET', '/__aegis/login'), encrypted, ctx);
    const secureCookie = String(encrypted.headers['Set-Cookie']);
    assert.ok(secureCookie.startsWith('aegis_site_csrf='));
    assert.ok(/;\s*Secure/.test(secureCookie));
});

test('cookies: the logout clear carries the Secure flag too', async (t) => {
    const slug = 'tenant-out-flag';
    const tenantPaths = seed(slug, 'outflag',
        { name: 'Out', auth: { enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const ctx = { slug, tenantPaths, project: { id: 'outflag', name: 'Out' } };

    siteAuth._setVerifier(() => ({ ok: true, groups: [] }));
    t.after(() => { siteAuth._setVerifier(null); siteAuth.dropSessions(slug, 'outflag'); });

    // A clear that lost the flag would leave the old Secure cookie in place on a
    // TLS site, so the expiry has to be written with the same attributes.
    const secureLogin = await login(slug, tenantPaths, 'outflag',
        { username: 'jdoe', password: SECRET, next: '/' }, { ip: '10.0.0.93', secure: true });
    const secureToken = cookieValue(secureLogin.res.headers['Set-Cookie'], 'aegis_site');
    const secureOut = fakeRes();
    await siteAuth.gate(fakeReq('POST', '/__aegis/logout',
        { secure: true, headers: { cookie: `aegis_site=${secureToken}` } }), secureOut, ctx);
    const secureCleared = String(secureOut.headers['Set-Cookie']);
    assert.ok(secureCleared.includes('Max-Age=0'));
    assert.ok(/;\s*Secure/.test(secureCleared));
});

/* ------------------------------------------------------------------ */
/* background revalidation                                             */
/* ------------------------------------------------------------------ */

const VIEWERS_DN = 'CN=Site Viewers,OU=Groups,DC=corp,DC=local';
const HELPDESK_DN = 'CN=Helpdesk,OU=Groups,DC=corp,DC=local';

/**
 * Moves the clock the guard reads, for the body of one test.
 *
 * `nextCheckAt` is an absolute timestamp and `authStore` floors
 * `revalidateMinutes` at one minute, so the only way to reach a re-check
 * without sleeping through it is to move `Date.now` forward under the module.
 */
function fakeClock(t) {
    const real = Date.now;
    let skew = 0;
    Date.now = () => real() + skew;
    t.after(() => { Date.now = real; });
    return (ms) => { skew += ms; };
}

/**
 * Lets the revalidation chain finish.
 *
 * `gate` starts it and returns, so there is no promise to await. The chain is
 * microtasks only when the injected lookup answers without I/O, and each
 * `setImmediate` drains the whole microtask queue behind it.
 */
async function settle() {
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
}

/** One request an authenticated session should be allowed straight through. */
function visit(slug, tenantPaths, projectId, token) {
    const res = fakeRes();
    const handled = siteAuth.gate(
        fakeReq('GET', '/', { headers: { cookie: `aegis_site=${token}` } }), res,
        { slug, tenantPaths, project: { id: projectId, name: projectId } });
    return { res, handled };
}

/** Logs a user in through the real form and hands back the session token. */
async function loginToken(slug, tenantPaths, projectId, ip, groups) {
    siteAuth._setVerifier(() => ({ ok: true, groups: groups || [VIEWERS_DN] }));
    try {
        const { res } = await login(slug, tenantPaths, projectId,
            { username: 'alice', password: SECRET, next: '/' }, { ip });
        return cookieValue(res.headers['Set-Cookie'], 'aegis_site');
    } finally {
        siteAuth._setVerifier(null);
    }
}

/** Collects what the guard warns about, over the file-wide mute. */
function captureWarnings(t) {
    const real = console.warn;
    const lines = [];
    console.warn = (msg) => { lines.push(String(msg)); };
    t.after(() => { console.warn = real; });
    return lines;
}

function revalConfig(minutes) {
    return Object.assign({}, GOOD_CONFIG, { revalidateMinutes: minutes });
}

test('revalidation: a still-entitled session is re-checked once per interval and kept', async (t) => {
    const slug = 'tenant-reval-ok';
    const tenantPaths = seed(slug, 'revalok',
        { name: 'Reval', auth: { enabled: true, allowedGroups: ['Site Viewers'] } },
        revalConfig(10));
    const token = await loginToken(slug, tenantPaths, 'revalok', '10.0.0.81');
    assert.ok(token);

    const advance = fakeClock(t);
    let calls = 0;
    siteAuth._setLookup((config, username) => {
        calls += 1;
        assert.strictEqual(username, 'alice', 'the directory is asked about the session owner');
        assert.strictEqual(config.bindPassword, 'service-secret',
            'the lookup gets the decrypted bind password, same as the verifier');
        return { ok: true, groups: [VIEWERS_DN] };
    });
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions(slug, 'revalok'); });

    // The login has just checked, so the first interval is a whole one away.
    assert.strictEqual(visit(slug, tenantPaths, 'revalok', token).handled, false);
    await settle();
    assert.strictEqual(calls, 0, 'nothing is asked before the interval elapses');

    advance(11 * 60 * 1000);
    assert.strictEqual(visit(slug, tenantPaths, 'revalok', token).handled, false,
        'the request that trips the timer is served with the list it already has');
    await settle();
    assert.strictEqual(calls, 1);

    // Past the retry delay but not past a second full interval. A verdict was
    // reached, so the next check must be an interval away and not a minute.
    advance(2 * 60 * 1000);
    assert.strictEqual(visit(slug, tenantPaths, 'revalok', token).handled, false);
    await settle();
    assert.strictEqual(calls, 1, 'a successful check pushes the next one a full interval away');

    advance(9 * 60 * 1000);
    assert.strictEqual(visit(slug, tenantPaths, 'revalok', token).handled, false);
    await settle();
    assert.strictEqual(calls, 2);
});

test('revalidation: a user taken out of the allowed group loses the session', async (t) => {
    const slug = 'tenant-reval-drop';
    const tenantPaths = seed(slug, 'revaldrop',
        { name: 'Reval', auth: { enabled: true, allowedGroups: ['Site Viewers'] } },
        revalConfig(10));
    const token = await loginToken(slug, tenantPaths, 'revaldrop', '10.0.0.82');

    const warnings = captureWarnings(t);
    const advance = fakeClock(t);
    siteAuth._setLookup(() => ({ ok: true, groups: [HELPDESK_DN] }));
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions(slug, 'revaldrop'); });

    advance(11 * 60 * 1000);
    assert.strictEqual(visit(slug, tenantPaths, 'revaldrop', token).handled, false,
        'the request that trips the check is not the one that pays for it');
    await settle();

    const after = visit(slug, tenantPaths, 'revaldrop', token);
    assert.strictEqual(after.handled, true, 'the dropped session must not open the site again');
    assert.strictEqual(after.res.statusCode, 302);
    assert.ok(String(after.res.headers.Location).startsWith('/__aegis/login'));
    assert.ok(warnings.some((l) => l.includes('session dropped') && l.includes('alice')),
        `the drop must be reported, got ${JSON.stringify(warnings)}`);
});

test('revalidation: a directory that cannot answer keeps the session and retries sooner', async (t) => {
    const slug = 'tenant-reval-down';
    const tenantPaths = seed(slug, 'revaldown',
        { name: 'Reval', auth: { enabled: true, allowedGroups: ['Site Viewers'] } },
        revalConfig(10));
    const token = await loginToken(slug, tenantPaths, 'revaldown', '10.0.0.83');

    const advance = fakeClock(t);
    let calls = 0;
    siteAuth._setLookup(() => { calls += 1; return { ok: false, error: 'ldap_unreachable' }; });
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions(slug, 'revaldown'); });

    advance(11 * 60 * 1000);
    visit(slug, tenantPaths, 'revaldown', token);
    await settle();
    assert.strictEqual(calls, 1);

    // A DC down for a minute must not empty every protected site at once.
    assert.strictEqual(visit(slug, tenantPaths, 'revaldown', token).handled, false,
        'no verdict is not a verdict of no');
    await settle();
    assert.strictEqual(calls, 1, 'the retry delay has not elapsed yet');

    // Sixty-one seconds, well short of the ten-minute interval: an unanswered
    // check has to come back soon after the DC does.
    advance(61 * 1000);
    assert.strictEqual(visit(slug, tenantPaths, 'revaldown', token).handled, false);
    await settle();
    assert.strictEqual(calls, 2, 'a failed check retries after a minute, not after the interval');
});

test('revalidation: a lookup that rejects is treated as no answer, not as a refusal', async (t) => {
    const slug = 'tenant-reval-throw';
    const tenantPaths = seed(slug, 'revalthrow',
        { name: 'Reval', auth: { enabled: true, allowedGroups: ['Site Viewers'] } },
        revalConfig(10));
    const token = await loginToken(slug, tenantPaths, 'revalthrow', '10.0.0.84');

    const advance = fakeClock(t);
    let calls = 0;
    siteAuth._setLookup(() => { calls += 1; return Promise.reject(new Error('socket hang up')); });
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions(slug, 'revalthrow'); });

    advance(11 * 60 * 1000);
    visit(slug, tenantPaths, 'revalthrow', token);
    await settle();
    assert.strictEqual(calls, 1);
    assert.strictEqual(visit(slug, tenantPaths, 'revalthrow', token).handled, false,
        'a thrown lookup must not log the user out');
    await settle();

    // And the in-flight flag was cleared on the rejection path too, so the next
    // window still gets a check instead of the session never being asked about.
    advance(61 * 1000);
    visit(slug, tenantPaths, 'revalthrow', token);
    await settle();
    assert.strictEqual(calls, 2);
});

test('revalidation: revalidateMinutes 0 never consults the directory', async (t) => {
    const slug = 'tenant-reval-off';
    const tenantPaths = seed(slug, 'revaloff',
        { name: 'Reval', auth: { enabled: true, allowedGroups: ['Site Viewers'] } },
        revalConfig(0));
    const token = await loginToken(slug, tenantPaths, 'revaloff', '10.0.0.85');

    const advance = fakeClock(t);
    let calls = 0;
    siteAuth._setLookup(() => { calls += 1; return { ok: true, groups: [VIEWERS_DN] }; });
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions(slug, 'revaloff'); });

    // Almost six hours, comfortably inside the eight-hour session and far past
    // any interval the setting could otherwise have produced. In steps of 25
    // minutes, because a session idle for 30 closes on its own.
    for (let i = 0; i < 14; i++) {
        advance(25 * 60 * 1000);
        assert.strictEqual(visit(slug, tenantPaths, 'revaloff', token).handled, false);
    }
    await settle();
    assert.strictEqual(calls, 0, 'off means off, which is the behaviour before this existed');
});

test('revalidation: concurrent requests start one check, and none of them waits for it', async (t) => {
    const slug = 'tenant-reval-once';
    const tenantPaths = seed(slug, 'revalonce',
        { name: 'Reval', auth: { enabled: true, allowedGroups: ['Site Viewers'] } },
        revalConfig(10));
    const token = await loginToken(slug, tenantPaths, 'revalonce', '10.0.0.86');

    const advance = fakeClock(t);
    let calls = 0;
    let release = null;
    siteAuth._setLookup(() => {
        calls += 1;
        return new Promise((resolve) => {
            release = () => resolve({ ok: true, groups: [VIEWERS_DN] });
        });
    });
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions(slug, 'revalonce'); });

    advance(11 * 60 * 1000);
    for (let i = 0; i < 3; i++) {
        const { handled } = visit(slug, tenantPaths, 'revalonce', token);
        // A boolean and not a promise: the gate answered while the lookup it
        // just started is still outstanding.
        assert.strictEqual(handled, false, `request ${i + 1} must be served without waiting`);
    }
    await settle();
    assert.strictEqual(calls, 1, 'the in-flight flag keeps a slow DC from being asked three times');

    release();
    await settle();
    assert.strictEqual(visit(slug, tenantPaths, 'revalonce', token).handled, false);
    await settle();
    assert.strictEqual(calls, 1, 'the answer pushed the next check a full interval away');
});

/* ------------------------------------------------------------------ */
/* idle timeout, writes, and closing sessions by hand                  */
/* ------------------------------------------------------------------ */

/** A request with a session cookie and any method, awaited either way. */
async function send(slug, tenantPaths, projectId, token, method, url) {
    const res = fakeRes();
    const handled = await siteAuth.gate(
        fakeReq(method, url || '/', { headers: { cookie: `aegis_site=${token}` } }), res,
        { slug, tenantPaths, project: { id: projectId, name: projectId } });
    return { res, handled };
}

function isLoginRedirect(answer) {
    return answer.handled === true && answer.res.statusCode === 302
        && String(answer.res.headers.Location).startsWith('/__aegis/login');
}

test('session closes after 30 min idle, and activity slides it', async (t) => {
    const slug = 'tenant-idle';
    const tenantPaths = seed(slug, 'idle',
        { name: 'Idle', auth: { enabled: true, allowedGroups: ['Site Viewers'] } },
        revalConfig(0));
    const token = await loginToken(slug, tenantPaths, 'idle', '10.0.0.91');
    t.after(() => siteAuth.dropSessions(slug, 'idle'));
    assert.strictEqual(siteAuth.IDLE_MS, 30 * 60 * 1000);

    const advance = fakeClock(t);
    advance(29 * 60 * 1000);
    assert.strictEqual(visit(slug, tenantPaths, 'idle', token).handled, false,
        'twenty-nine minutes of silence is inside the window');
    advance(29 * 60 * 1000);
    assert.strictEqual(visit(slug, tenantPaths, 'idle', token).handled, false,
        'the visit at 29 minutes slid the window, so 58 minutes after login still opens');

    advance(siteAuth.IDLE_MS + 1);
    assert.ok(isLoginRedirect(visit(slug, tenantPaths, 'idle', token)),
        'one millisecond past the idle window lands on the login form');
});

test('absolute 8 h cap still holds despite activity', async (t) => {
    const slug = 'tenant-cap';
    const tenantPaths = seed(slug, 'cap',
        { name: 'Cap', auth: { enabled: true, allowedGroups: ['Site Viewers'] } },
        revalConfig(0));
    const token = await loginToken(slug, tenantPaths, 'cap', '10.0.0.92');
    t.after(() => siteAuth.dropSessions(slug, 'cap'));

    const advance = fakeClock(t);
    // A visit every 25 minutes keeps the idle window open forever. 19 of them
    // is 475 minutes, inside eight hours; the 20th is at 500.
    for (let i = 1; i <= 19; i++) {
        advance(25 * 60 * 1000);
        assert.strictEqual(visit(slug, tenantPaths, 'cap', token).handled, false, `visit ${i}`);
    }
    advance(25 * 60 * 1000);
    assert.ok(isLoginRedirect(visit(slug, tenantPaths, 'cap', token)),
        'activity never carries a session past eight hours from login');
});

test('mutating request rechecks group synchronously', async (t) => {
    const slug = 'tenant-write-drop';
    const tenantPaths = seed(slug, 'wdrop',
        { name: 'Write', auth: { enabled: true, allowedGroups: ['Site Viewers'] } },
        revalConfig(10));
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions(slug, 'wdrop'); });

    let calls = 0;
    let groups = [VIEWERS_DN];
    siteAuth._setLookup(() => { calls += 1; return { ok: true, groups }; });

    // Still entitled: the write goes through, and the directory was asked even
    // though the ten-minute window has not elapsed.
    const kept = await loginToken(slug, tenantPaths, 'wdrop', '10.0.0.93');
    const ok = await send(slug, tenantPaths, 'wdrop', kept, 'POST', '/api/items');
    assert.strictEqual(ok.handled, false, 'an entitled write reaches the application');
    assert.strictEqual(calls, 1, 'the write asked the directory inside the window');

    groups = [HELPDESK_DN];
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const token = await loginToken(slug, tenantPaths, 'wdrop', '10.0.0.94');
        const before = calls;
        // A read inside the window keeps the non-blocking behaviour.
        assert.strictEqual(visit(slug, tenantPaths, 'wdrop', token).handled, false,
            `${method}: a GET inside the window is still served from the list it has`);
        await settle();
        assert.strictEqual(calls, before, `${method}: the GET did not ask the directory`);

        const write = await send(slug, tenantPaths, 'wdrop', token, method, '/api/items/1');
        assert.strictEqual(write.handled, true, `${method}: never reaches the application`);
        assert.strictEqual(write.res.statusCode, 403, `${method}: refused`);
        assert.strictEqual(write.res.headers['Set-Cookie'], undefined,
            `${method}: the refusal sets no cookie`);
        assert.strictEqual(calls, before + 1);
        assert.ok(isLoginRedirect(visit(slug, tenantPaths, 'wdrop', token)),
            `${method}: the session was dropped with the refusal`);
    }
});

test('mutating request with directory unreachable answers 503 and is not proxied', async (t) => {
    const slug = 'tenant-write-down';
    const tenantPaths = seed(slug, 'wdown',
        { name: 'Write', auth: { enabled: true, allowedGroups: ['Site Viewers'] } },
        revalConfig(10));
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions(slug, 'wdown'); });
    const token = await loginToken(slug, tenantPaths, 'wdown', '10.0.0.95');

    siteAuth._setLookup(() => ({ ok: false, error: 'ldap_unreachable' }));
    const down = await send(slug, tenantPaths, 'wdown', token, 'POST', '/api/items');
    assert.strictEqual(down.handled, true, 'no verdict means the write is not proxied');
    assert.strictEqual(down.res.statusCode, 503);
    assert.strictEqual(down.res.headers['Set-Cookie'], undefined);

    siteAuth._setLookup(() => Promise.reject(new Error('socket hang up')));
    const thrown = await send(slug, tenantPaths, 'wdown', token, 'PUT', '/api/items/1');
    assert.strictEqual(thrown.handled, true);
    assert.strictEqual(thrown.res.statusCode, 503, 'a rejected lookup fails closed on a write');

    // The session itself is kept, as on the read path: no answer is not a no.
    assert.strictEqual(visit(slug, tenantPaths, 'wdown', token).handled, false);
});

test('revalidateMinutes 0 still rechecks a write', async (t) => {
    // Zero switches off the timer on reads, and nothing else.
    const tenantPaths = seed('tenant-write-off', 'wskipoff',
        { name: 'Write', auth: { enabled: true, allowedGroups: ['Site Viewers'] } }, revalConfig(0));
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions('tenant-write-off', 'wskipoff'); });
    let calls = 0;
    siteAuth._setLookup(() => { calls += 1; return { ok: true, groups: [HELPDESK_DN] }; });

    const token = await loginToken('tenant-write-off', tenantPaths, 'wskipoff', '10.0.0.96');
    assert.strictEqual(visit('tenant-write-off', tenantPaths, 'wskipoff', token).handled, false);
    await settle();
    assert.strictEqual(calls, 0, 'a read is not checked with the timer off');
    const write = await send('tenant-write-off', tenantPaths, 'wskipoff', token, 'POST', '/api/items');
    assert.strictEqual(calls, 1, 'a write is');
    assert.strictEqual(write.res.statusCode, 403);
});

test('a template-only directory is searched anonymously on a write', async (t) => {
    // No service account is not "cannot search": ldap.lookup binds anonymously
    // with the base DN and the user filter, so the write waits for it.
    const tenantPaths = seed('tenant-write-anon', 'wanon',
        { name: 'Write', auth: { enabled: true, allowedGroups: ['Site Viewers'] } },
        { url: 'ldaps://dc01.corp.local:636', baseDn: 'DC=corp,DC=local',
          userDnTemplate: 'CN={username},OU=Users,DC=corp,DC=local', revalidateMinutes: 10 });
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions('tenant-write-anon', 'wanon'); });
    let calls = 0;
    siteAuth._setLookup(() => { calls += 1; return { ok: false, error: 'ldap_bind_refused' }; });

    const token = await loginToken('tenant-write-anon', tenantPaths, 'wanon', '10.0.0.97');
    const write = await send('tenant-write-anon', tenantPaths, 'wanon', token, 'POST', '/api/items');
    assert.strictEqual(calls, 1);
    assert.strictEqual(write.res.statusCode, 503, 'an anonymous search the DC refuses is no answer');
});

test('a write is not rechecked where ldap.lookup cannot run at all', async (t) => {
    // A bind DN with no password is refused by ldap.lookup before any socket
    // opens. Failing closed there would forbid every write for good, so the
    // write passes and the Authentication panel says so (writeRecheck false).
    const config = { url: 'ldaps://dc01.corp.local:636', baseDn: 'DC=corp,DC=local',
        bindDn: 'CN=svc,DC=corp,DC=local', revalidateMinutes: 10 };
    const tenantPaths = seed('tenant-write-nopw', 'wnopw',
        { name: 'Write', auth: { enabled: true, allowedGroups: ['Site Viewers'] } }, config);
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions('tenant-write-nopw', 'wnopw'); });
    let calls = 0;
    siteAuth._setLookup(() => { calls += 1; return { ok: false, error: 'ldap_bad_config' }; });

    assert.strictEqual(siteAuth.writesRecheckable(authStore.readConfig(tenantPaths)), false);
    assert.strictEqual(siteAuth.writesRecheckable(
        Object.assign({ userFilter: '(sAMAccountName={username})' }, GOOD_CONFIG)), true);
    assert.strictEqual(siteAuth.writesRecheckable(GOOD_CONFIG), false,
        'no user filter is refused by ldap.lookup too (authStore always supplies one)');
    assert.strictEqual(siteAuth.writesRecheckable({ url: 'ldaps://dc01.corp.local:636',
        baseDn: 'DC=corp,DC=local', userFilter: '(sAMAccountName={username})' }), true,
        'anonymous search counts as searchable');

    const token = await loginToken('tenant-write-nopw', tenantPaths, 'wnopw', '10.0.0.98');
    const write = await send('tenant-write-nopw', tenantPaths, 'wnopw', token, 'POST', '/api/items');
    assert.strictEqual(write.handled, false);
    assert.strictEqual(calls, 0);
});

test('a write by a user deleted from the directory is refused and drops the session', async (t) => {
    const tenantPaths = seed('tenant-write-gone', 'wgone',
        { name: 'Write', auth: { enabled: true, allowedGroups: ['Site Viewers'] } }, revalConfig(10));
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions('tenant-write-gone', 'wgone'); });
    siteAuth._setLookup(() => ({ ok: false, error: 'ldap_user_not_found' }));

    const token = await loginToken('tenant-write-gone', tenantPaths, 'wgone', '10.0.0.99');
    const write = await send('tenant-write-gone', tenantPaths, 'wgone', token, 'DELETE', '/api/items/1');
    assert.strictEqual(write.res.statusCode, 403);
    assert.ok(isLoginRedirect(visit('tenant-write-gone', tenantPaths, 'wgone', token)));
});

test('a refused search or an unconfirmed name on a write is a 503, and the session survives', async (t) => {
    const tenantPaths = seed('tenant-write-denied', 'wdenied',
        { name: 'Write', auth: { enabled: true, allowedGroups: ['Site Viewers'] } }, revalConfig(10));
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions('tenant-write-denied', 'wdenied'); });
    const token = await loginToken('tenant-write-denied', tenantPaths, 'wdenied', '10.0.0.101');

    for (const error of ['ldap_search_denied', 'ldap_user_unconfirmed']) {
        siteAuth._setLookup(() => ({ ok: false, error }));
        const write = await send('tenant-write-denied', tenantPaths, 'wdenied', token, 'POST', '/api/items');
        assert.strictEqual(write.res.statusCode, 503, error);
        assert.strictEqual(visit('tenant-write-denied', tenantPaths, 'wdenied', token).handled, false,
            `${error}: the session is kept`);
    }
});

test('a refused or unanswered request does not count as activity', async (t) => {
    const tenantPaths = seed('tenant-idle-refused', 'irefused',
        { name: 'Idle', auth: { enabled: true, allowedGroups: ['Site Viewers'] } }, revalConfig(10));
    t.after(() => { siteAuth._setLookup(null); siteAuth.dropSessions('tenant-idle-refused', 'irefused'); });
    siteAuth._setLookup(() => ({ ok: false, error: 'ldap_unreachable' }));
    const token = await loginToken('tenant-idle-refused', tenantPaths, 'irefused', '10.0.0.100');

    const advance = fakeClock(t);
    advance(20 * 60 * 1000);
    const down = await send('tenant-idle-refused', tenantPaths, 'irefused', token, 'POST', '/api/items');
    assert.strictEqual(down.res.statusCode, 503);
    const reserved = await send('tenant-idle-refused', tenantPaths, 'irefused', token, 'GET', '/__aegis/nothing');
    assert.strictEqual(reserved.res.statusCode, 404);

    advance(11 * 60 * 1000);
    assert.ok(isLoginRedirect(visit('tenant-idle-refused', tenantPaths, 'irefused', token)),
        'thirty-one minutes after the last accepted request, the 503 and the 404 slid nothing');
});

test('normalizeUser: case, a DOMAIN\\ prefix and an @suffix all reduce to one name', () => {
    assert.strictEqual(siteAuth.normalizeUser('Alice'), 'alice');
    assert.strictEqual(siteAuth.normalizeUser('CORP\\Alice'), 'alice');
    assert.strictEqual(siteAuth.normalizeUser('alice@corp.local'), 'alice');
    assert.strictEqual(siteAuth.normalizeUser('  ALICE  '), 'alice');
    assert.strictEqual(siteAuth.normalizeUser(''), '');
    assert.strictEqual(siteAuth.normalizeUser(null), '');
});

test('dropSessionsFor closes only the named user, and listSessions never shows a token', async (t) => {
    const slug = 'tenant-close';
    const tenantPaths = seed(slug, 'close',
        { name: 'Close', auth: { enabled: true, audience: 'directory' } },
        revalConfig(0));
    t.after(() => siteAuth.dropSessions(slug, 'close'));
    const ok = { ok: true, groups: [VIEWERS_DN] };
    const alice = await loginAs(slug, tenantPaths, 'close', 'alice', ok);
    const bob = await loginAs(slug, tenantPaths, 'close', 'bob', ok);
    assert.ok(alice && bob);

    const listed = siteAuth.listSessions(slug, 'close');
    assert.strictEqual(listed.length, 2);
    for (const row of listed) {
        assert.deepStrictEqual(Object.keys(row).sort(),
            ['expiresAt', 'ip', 'lastSeen', 'loginAt', 'username']);
    }
    const text = JSON.stringify(listed);
    assert.ok(!text.includes(alice) && !text.includes(bob), 'no session token in the list');

    assert.strictEqual(siteAuth.dropSessionsFor(slug, 'close', 'CORP\\Alice'), 1);
    assert.ok(isLoginRedirect(visit(slug, tenantPaths, 'close', alice)));
    assert.strictEqual(visit(slug, tenantPaths, 'close', bob).handled, false, 'bob is untouched');

    assert.strictEqual(siteAuth.dropSessionsFor(slug, 'close'), 1, 'no name closes the rest');
    assert.ok(isLoginRedirect(visit(slug, tenantPaths, 'close', bob)));
});

/* ------------------------------------------------------------------ */
/* the TLS listener                                                    */
/* ------------------------------------------------------------------ */

/**
 * A throwaway certificate, written to the system temp directory at run time.
 *
 * Same reasoning and the same command as `tests/ldap.test.js`: no key material
 * belongs in this tree even when gitignored, and `node:crypto` cannot issue an
 * X.509 certificate. When openssl is not on the path the tests that need a
 * handshake skip rather than fail. Paths and not PEM, because `tlsOptionsFor`
 * reads files.
 */
function selfSignedFiles() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-site-tls-'));
    const keyFile = path.join(dir, 'key.pem');
    const certFile = path.join(dir, 'cert.pem');
    const run = spawnSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyFile, '-out', certFile, '-days', '1',
        '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'
    ], { stdio: 'ignore' });
    if (run.status !== 0) {
        fs.rmSync(dir, { recursive: true, force: true });
        return null;
    }
    return { dir, keyFile, certFile };
}

/**
 * A port the operating system just told us is free.
 *
 * Not a number picked out of a range: these tests bind for real, and a
 * collision would fail a test for a reason unrelated to the code under test.
 */
function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

/** Resolves once the listener is up, and gives up rather than hanging. */
function listening(server, ms) {
    return new Promise((resolve) => {
        if (server.listening) return resolve();
        const timer = setTimeout(resolve, ms || 3000);
        server.once('listening', () => { clearTimeout(timer); resolve(); });
    });
}

/** A GET that reports a transport failure instead of throwing. */
function fetchPort(client, port, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
        const req = client.request(Object.assign({
            host: '127.0.0.1', port, path: o.path || '/',
            // No pooling and no keep-alive: a socket left open would hold the
            // port after close() and turn the restart test into a race.
            agent: false, headers: { connection: 'close' }
        }, o.extra || {}), (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                ok: true, status: res.statusCode, body: Buffer.concat(chunks)
            }));
        });
        req.setTimeout(3000, () => req.destroy(new Error('timeout')));
        req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
        req.end();
    });
}

const getHttp = (port, opts) => fetchPort(http, port, opts);
const getHttps = (port, opts) => fetchPort(https, port, Object.assign({
    // Self-signed and generated two lines ago. What is proved here is that the
    // bytes crossed a handshake at all, not who signed the certificate.
    extra: { rejectUnauthorized: false }
}, opts));

/** `startSiteFor` reports a refusal on console.error. Muted per test. */
function muteErrors(t) {
    const real = console.error;
    console.error = () => {};
    t.after(() => { console.error = real; });
}

/** Polls until the port refuses, because close() unbinds asynchronously. */
async function waitRefused(port) {
    let last = { ok: true };
    for (let i = 0; i < 20; i++) {
        last = await getHttp(port);
        if (!last.ok) return last;
        await new Promise((r) => setTimeout(r, 25));
    }
    return last;
}

/**
 * A tenant, a project record with a port, and one file under `current`.
 *
 * The notices script is off: these tests compare the page byte for byte to
 * say which listener answered, and deployNotices.test.js covers the script.
 */
function siteFixture(slug, projectId, extra, contents) {
    const tenantPaths = newTenant();
    const project = Object.assign({ id: projectId, name: projectId, notices: { inject: false } }, extra);
    projectStore.saveProject(tenantPaths, project);
    siteAuth.invalidate(slug, projectId);

    const current = projectStore.currentDir(tenantPaths, projectId);
    fs.mkdirSync(current, { recursive: true });
    const bytes = Buffer.from(contents, 'utf8');
    fs.writeFileSync(path.join(current, 'index.html'), bytes);
    return { tenantPaths, project, current, bytes };
}

/**
 * A certificate and a key that both exist, both read, and neither parses.
 *
 * The state a renewal leaves behind when the file is read mid-write, and the
 * one no fixture built from openssl can produce. Every other bad-TLS case in
 * this file is missing a file, so on its own it only ever proves the ENOENT
 * path and leaves the parse untested.
 */
function garbageCertFiles(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-site-tls-junk-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const certFile = path.join(dir, 'cert.pem');
    const keyFile = path.join(dir, 'key.pem');
    fs.writeFileSync(certFile, 'not a certificate\n', 'utf8');
    fs.writeFileSync(keyFile, 'not a key\n', 'utf8');
    return { certFile, keyFile };
}

/**
 * Settles either way, so a promise that never settles fails one test instead of
 * hanging the runner with no output to read.
 */
function withTimeout(promise, ms) {
    let timer = null;
    const guard = new Promise((resolve) => { timer = setTimeout(() => resolve({ state: 'timeout' }), ms); });
    return Promise.race([
        Promise.resolve(promise).then(
            (value) => ({ state: 'resolved', value }),
            (error) => ({ state: 'rejected', error })),
        guard
    ]).then((outcome) => { clearTimeout(timer); return outcome; });
}

test('tls: a project with no tls record, or one switched off, stays plain http', () => {
    assert.strictEqual(siteServer.tlsOptionsFor({ id: 'a' }), null);
    assert.strictEqual(siteServer.tlsOptionsFor({ id: 'a', tls: null }), null);
    assert.strictEqual(siteServer.tlsOptionsFor({ id: 'a', tls: {} }), null);
    assert.strictEqual(
        siteServer.tlsOptionsFor({ id: 'a', tls: { enabled: false, certFile: 'c', keyFile: 'k' } }),
        null);
    // Only the boolean counts. A truthy string in the record is a typo, not a
    // request for TLS, and reading it as one would try to load 'c' and 'k'.
    assert.strictEqual(
        siteServer.tlsOptionsFor({ id: 'a', tls: { enabled: 'yes', certFile: 'c', keyFile: 'k' } }),
        null);
});

test('tls: an enabled record missing a path is incomplete rather than plain', () => {
    assert.throws(
        () => siteServer.tlsOptionsFor({ tls: { enabled: true, certFile: '', keyFile: 'k.pem' } }),
        (e) => e.code === 'tls_incomplete');
    assert.throws(
        () => siteServer.tlsOptionsFor({ tls: { enabled: true, certFile: 'c.pem', keyFile: '' } }),
        (e) => e.code === 'tls_incomplete');
    assert.throws(
        () => siteServer.tlsOptionsFor({ tls: { enabled: true } }),
        (e) => e.code === 'tls_incomplete');
});

test('tls: a certificate path that is not on disk throws where the operator is looking', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-site-tls-gone-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const certFile = path.join(dir, 'cert.pem');
    const keyFile = path.join(dir, 'key.pem');

    assert.throws(
        () => siteServer.tlsOptionsFor({ tls: { enabled: true, certFile, keyFile } }),
        (e) => e.code === 'ENOENT');

    // A key missing on its own is caught too, not only the pair.
    fs.writeFileSync(certFile, 'not really a certificate', 'utf8');
    assert.throws(
        () => siteServer.tlsOptionsFor({ tls: { enabled: true, certFile, keyFile } }),
        (e) => e.code === 'ENOENT');
});

test('tls: a site whose certificate will not load does not come up in clear', async (t) => {
    muteErrors(t);
    const slug = 'tenant-tls-bad';
    const port = await freePort();
    const missing = path.join(os.tmpdir(), 'aegis-no-such-cert.pem');
    const { tenantPaths, project } = siteFixture(slug, 'tlsbad', {
        port, tls: { enabled: true, certFile: missing, keyFile: missing }
    }, 'this must never be served');
    t.after(() => siteServer.stopSiteFor(slug, 'tlsbad'));

    const server = siteServer.startSiteFor({ slug, tenantPaths, project });
    assert.strictEqual(server, null, 'a broken certificate must stop the site, not downgrade it');

    // The whole point of the branch: a silent downgrade would look like it
    // worked, while the login form on it sent a password across in clear.
    const plain = await getHttp(port);
    assert.strictEqual(plain.ok, false, `nothing may answer on ${port}, got status ${plain.status}`);
    assert.ok(/ECONNREFUSED/.test(plain.error),
        `expected a refused connection, got ${plain.error}`);
});

test('tls: a readable certificate that is not PEM is refused, not handed to the server', (t) => {
    const bad = garbageCertFiles(t);
    // Both files are present and both read. If this test ever passes on an
    // ENOENT the fixture has broken and the parse is going untested again.
    assert.ok(fs.existsSync(bad.certFile) && fs.existsSync(bad.keyFile));

    let thrown = null;
    try {
        siteServer.tlsOptionsFor({ tls: { enabled: true, certFile: bad.certFile, keyFile: bad.keyFile } });
    } catch (e) {
        thrown = e;
    }
    assert.ok(thrown, 'readable is not usable: bytes that will not parse are not a certificate');
    assert.notStrictEqual(thrown.code, 'ENOENT', 'the files exist, so this has to be a parse failure');
    // The message is an OpenSSL string and differs between builds, so what is
    // pinned is that it threw here, where the caller's try/catch is waiting,
    // rather than later inside the https.createServer constructor.
});

test('tls: a readable but unparseable certificate leaves the site down, not in clear', async (t) => {
    muteErrors(t);
    const bad = garbageCertFiles(t);
    const slug = 'tenant-tls-junk';
    const port = await freePort();
    const { tenantPaths, project } = siteFixture(slug, 'tlsjunk', {
        port, tls: { enabled: true, certFile: bad.certFile, keyFile: bad.keyFile }
    }, 'this must never be served');
    t.after(() => siteServer.stopSiteFor(slug, 'tlsjunk'));

    // Not a throw either: an exception escaping here is what took the whole of
    // startAllSites down at boot, one tenant's half-written file at a time.
    const server = siteServer.startSiteFor({ slug, tenantPaths, project });
    assert.strictEqual(server, null, 'PEM that will not parse must stop the site, like a missing file does');

    const plain = await getHttp(port);
    assert.strictEqual(plain.ok, false, `nothing may answer on ${port}, got status ${plain.status}`);
    assert.ok(/ECONNREFUSED/.test(plain.error), `expected a refused connection, got ${plain.error}`);
});

test('tls: a valid certificate serves the site over https and nothing over http', async (t) => {
    const pair = selfSignedFiles();
    if (!pair) return t.skip('openssl is not available to build a test certificate');
    t.after(() => fs.rmSync(pair.dir, { recursive: true, force: true }));
    muteErrors(t);

    const slug = 'tenant-tls-ok';
    const port = await freePort();
    const { tenantPaths, project, bytes } = siteFixture(slug, 'tlsok', {
        port, tls: { enabled: true, certFile: pair.certFile, keyFile: pair.keyFile }
    }, '<h1>served over tls</h1>');
    t.after(() => siteServer.stopSiteFor(slug, 'tlsok'));

    const server = siteServer.startSiteFor({ slug, tenantPaths, project });
    assert.ok(server, 'a readable certificate must start the listener');
    await listening(server);

    const secure = await getHttps(port);
    assert.strictEqual(secure.ok, true, `expected https to answer, got ${secure.error}`);
    assert.strictEqual(secure.status, 200);
    assert.deepStrictEqual(secure.body, bytes, 'the file crossed the handshake unchanged');

    // The same port spoken to in clear. There is no plain answer to fall back
    // to: on an https listener the handshake is the protocol.
    const plain = await getHttp(port);
    assert.strictEqual(plain.ok, false, `a plain request must not be answered, got ${plain.status}`);
});


/* ------------------------------------------------------------------ */
/* restarting a listener                                               */
/* ------------------------------------------------------------------ */

test('restart: the old listener is replaced and the port serves the new one', async (t) => {
    muteErrors(t);
    const slug = 'tenant-restart';
    const port = await freePort();
    const { tenantPaths, project, current } = siteFixture(slug, 'restart', { port }, 'first');
    t.after(() => siteServer.stopSiteFor(slug, 'restart'));

    const first = siteServer.startSiteFor({ slug, tenantPaths, project });
    assert.ok(first);
    await listening(first);
    const before = await getHttp(port);
    assert.strictEqual(before.ok, true, `expected the site to serve, got ${before.error}`);
    assert.strictEqual(before.body.toString('utf8'), 'first');

    fs.writeFileSync(path.join(current, 'index.html'), 'second', 'utf8');
    const second = await siteServer.restartSiteFor({ slug, tenantPaths, project });
    assert.ok(second, 'the site must come back up');
    assert.notStrictEqual(second, first,
        'a restart builds a new listener: TLS is decided when the server is created');
    await listening(second);

    const after = await getHttp(port);
    assert.strictEqual(after.ok, true, `expected the port to serve again, got ${after.error}`);
    assert.strictEqual(after.body.toString('utf8'), 'second');
});

test('restart: a connection held open does not keep the site from coming back', async (t) => {
    muteErrors(t);
    const slug = 'tenant-restart-open';
    const port = await freePort();
    const { tenantPaths, project } = siteFixture(slug, 'restartopen', { port }, 'held open');
    t.after(() => siteServer.stopSiteFor(slug, 'restartopen'));

    const first = siteServer.startSiteFor({ slug, tenantPaths, project });
    await listening(first);
    assert.strictEqual((await getHttp(port)).ok, true);

    // Half a request, deliberately: the socket is neither idle nor finished, so
    // `close()` on its own will never drop it and the port stays bound. This is
    // the shape that made a synchronous restart re-listen into EADDRINUSE, and
    // because `listen` reports that on an event the site just never came back.
    const held = net.connect(port, '127.0.0.1');
    await new Promise((resolve, reject) => {
        held.once('connect', resolve);
        held.once('error', reject);
    });
    held.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n');
    held.on('error', () => {});           // the restart cuts it, which is the point
    t.after(() => held.destroy());
    await new Promise((r) => setTimeout(r, 50));

    const second = await siteServer.restartSiteFor({ slug, tenantPaths, project });
    assert.ok(second, 'an open connection must not cost the site its listener');
    assert.notStrictEqual(second, first);
    await listening(second);

    const after = await getHttp(port);
    assert.strictEqual(after.ok, true, `expected the port to serve again, got ${after.error}`);
    assert.strictEqual(after.body.toString('utf8'), 'held open');
});

test('restart: a site that is not running is simply started', async (t) => {
    muteErrors(t);
    const slug = 'tenant-restart-cold';
    const port = await freePort();
    const { tenantPaths, project } = siteFixture(slug, 'restartcold', { port }, 'cold start');
    t.after(() => siteServer.stopSiteFor(slug, 'restartcold'));

    // The settings page calls this after every save, including on a project
    // whose listener never came up. Nothing to stop is not an error.
    const server = await siteServer.restartSiteFor({ slug, tenantPaths, project });
    assert.ok(server, 'restarting what was never started must start it');
    await listening(server);

    const res = await getHttp(port);
    assert.strictEqual(res.ok, true, `expected the site to serve, got ${res.error}`);
    assert.strictEqual(res.body.toString('utf8'), 'cold start');
});

test('restart: switching a running site to a certificate that will not load stops it', async (t) => {
    muteErrors(t);
    const slug = 'tenant-restart-tls';
    const port = await freePort();
    const { tenantPaths, project } = siteFixture(slug, 'restarttls', { port }, 'plain for now');
    t.after(() => siteServer.stopSiteFor(slug, 'restarttls'));

    const plainServer = siteServer.startSiteFor({ slug, tenantPaths, project });
    await listening(plainServer);
    assert.strictEqual((await getHttp(port)).ok, true);

    // Turning HTTPS on with a path that does not read must leave nothing
    // listening, rather than leave the plain listener up under an https label.
    project.tls = {
        enabled: true,
        certFile: path.join(os.tmpdir(), 'aegis-absent.pem'),
        keyFile: path.join(os.tmpdir(), 'aegis-absent.key')
    };
    const restarted = await siteServer.restartSiteFor({ slug, tenantPaths, project });
    assert.strictEqual(restarted, null);

    const refused = await waitRefused(port);
    assert.strictEqual(refused.ok, false, 'the old plain listener must be gone');
});

test('restart: a running site can be switched from http to https on its port', async (t) => {
    const pair = selfSignedFiles();
    if (!pair) return t.skip('openssl is not available to build a test certificate');
    t.after(() => fs.rmSync(pair.dir, { recursive: true, force: true }));
    muteErrors(t);

    const slug = 'tenant-restart-https';
    const port = await freePort();
    const { tenantPaths, project, bytes } = siteFixture(slug, 'restarthttps', { port }, 'now encrypted');
    t.after(() => siteServer.stopSiteFor(slug, 'restarthttps'));

    const plainServer = siteServer.startSiteFor({ slug, tenantPaths, project });
    await listening(plainServer);
    assert.strictEqual((await getHttp(port)).ok, true, 'the site starts in clear');

    project.tls = { enabled: true, certFile: pair.certFile, keyFile: pair.keyFile };
    const encrypted = await siteServer.restartSiteFor({ slug, tenantPaths, project });
    assert.ok(encrypted, 'the site must come back on TLS');
    assert.notStrictEqual(encrypted, plainServer);
    await listening(encrypted);

    const secure = await getHttps(port);
    assert.strictEqual(secure.ok, true, `expected https to answer, got ${secure.error}`);
    assert.deepStrictEqual(secure.body, bytes);
    assert.strictEqual((await getHttp(port)).ok, false, 'the plain answer is gone with the restart');
});

test('restart: an unparseable new certificate settles the restart instead of hanging it', async (t) => {
    muteErrors(t);
    const bad = garbageCertFiles(t);
    const slug = 'tenant-restart-junk';
    const port = await freePort();
    const { tenantPaths, project } = siteFixture(slug, 'restartjunk', { port }, 'plain for now');
    t.after(() => siteServer.stopSiteFor(slug, 'restartjunk'));

    const plainServer = siteServer.startSiteFor({ slug, tenantPaths, project });
    await listening(plainServer);
    assert.strictEqual((await getHttp(port)).ok, true);

    // The restart starts the new listener inside the close callback, off the
    // chain the caller awaits. A throw there settles nothing: the promise stays
    // pending and the request that asked for the restart is never answered. The
    // timeout turns that into a failed test rather than a hung suite.
    project.tls = { enabled: true, certFile: bad.certFile, keyFile: bad.keyFile };
    const outcome = await withTimeout(siteServer.restartSiteFor({ slug, tenantPaths, project }), 5000);
    assert.notStrictEqual(outcome.state, 'timeout', 'the restart must settle, whatever the certificate is');
    assert.strictEqual(outcome.state, 'resolved',
        `expected a null result, got ${outcome.state} ${outcome.error && outcome.error.message}`);
    assert.strictEqual(outcome.value, null);

    const refused = await waitRefused(port);
    assert.strictEqual(refused.ok, false, 'the site must be left stopped, not left up in clear');
});

/* ------------------------------------------------------------------ */
/* named people, and what the site is told about them                  */
/* ------------------------------------------------------------------ */

const AM_SID = 'S-1-5-21-1-2-3-1103';

/** Signs somebody in and hands back the session cookie, or null if refused. */
async function loginAs(slug, tenantPaths, id, username, result) {
    siteAuth._setVerifier(() => result);
    try {
        const { res } = await login(slug, tenantPaths, id,
            { username, password: SECRET, next: '/' });
        return cookieValue(res.headers['Set-Cookie'], 'aegis_site');
    } finally {
        siteAuth._setVerifier(null);
    }
}

/** GETs a path on a site with a session cookie, and returns the fake response. */
async function getWith(slug, tenantPaths, id, path, token) {
    const res = fakeRes();
    const headers = token ? { cookie: `aegis_site=${token}` } : {};
    const handled = await siteAuth.gate(
        fakeReq('GET', path, { headers }), res,
        { slug, tenantPaths, project: { id, name: id } });
    return { res, handled };
}

test('login: a named person is let in on their SID, with no group anywhere', async () => {
    const slug = 'tenant-named';
    const tenantPaths = seed(slug, 'named', {
        name: 'Named',
        auth: {
            method: 'ldap', enabled: true, audience: 'listed', allowedGroups: [],
            allowedUsers: [{ sid: AM_SID, login: 'AM', name: 'Alice Martin', admin: true }]
        }
    }, GOOD_CONFIG);

    const token = await loginAs(slug, tenantPaths, 'named', 'AM',
        { ok: true, dn: 'AM@corp.local', displayName: 'Alice Martin', groups: [], sid: AM_SID });
    assert.ok(token, 'the SID alone must be enough to open a listed site');

    const { handled } = await getWith(slug, tenantPaths, 'named', '/', token);
    assert.strictEqual(handled, false, 'an authenticated request is served');
});

test('login: a listed site refuses a SID nobody named', async () => {
    const slug = 'tenant-named-no';
    const tenantPaths = seed(slug, 'named', {
        name: 'Named',
        auth: {
            method: 'ldap', enabled: true, audience: 'listed', allowedGroups: [],
            allowedUsers: [{ sid: AM_SID, login: 'AM', name: 'Alice Martin', admin: true }]
        }
    }, GOOD_CONFIG);

    const token = await loginAs(slug, tenantPaths, 'named', 'other',
        { ok: true, dn: 'other@corp.local', groups: [], sid: 'S-1-5-21-1-2-3-9999' });
    assert.strictEqual(token, null);
});

test('login: people are named and the directory returns no SID, so nobody gets in', async () => {
    // The direct-bind path reads the entry best effort. A directory that
    // refuses that read leaves the one field a named person is matched on
    // empty, and an empty field must not fall through to the group rule.
    const slug = 'tenant-nosid';
    const tenantPaths = seed(slug, 'nosid', {
        name: 'NoSid',
        auth: {
            method: 'ldap', enabled: true, audience: 'listed',
            allowedGroups: ['Domain Admins'],
            allowedUsers: [{ sid: AM_SID, login: 'AM', name: 'Alice Martin', admin: true }]
        }
    }, GOOD_CONFIG);

    const token = await loginAs(slug, tenantPaths, 'nosid', 'AM', {
        ok: true, dn: 'AM@corp.local', displayName: 'Alice Martin',
        groups: ['CN=Domain Admins,CN=Users,DC=corp,DC=local']
        // no sid
    });
    assert.strictEqual(token, null,
        'a group match must not stand in for the identity the operator actually named');
});

test('whoami: an administrator is told so, and the answer is never cached', async () => {
    const slug = 'tenant-whoami';
    const tenantPaths = seed(slug, 'app', {
        name: 'App',
        auth: {
            method: 'ldap', enabled: true, audience: 'directory', allowedGroups: [],
            allowedUsers: [{ sid: AM_SID, login: 'AM', name: 'Alice Martin', admin: true }]
        }
    }, GOOD_CONFIG);

    const token = await loginAs(slug, tenantPaths, 'app', 'AM',
        { ok: true, dn: 'AM@corp.local', displayName: 'Alice Martin', groups: [], sid: AM_SID });
    const { res, handled } = await getWith(slug, tenantPaths, 'app', '/__aegis/whoami', token);

    assert.strictEqual(handled, true);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['Cache-Control'], 'no-store',
        'a cached answer is a stale role, and a shared cache would hand it to the next visitor');
    assert.deepStrictEqual(JSON.parse(res.body), {
        authenticated: true, login: 'AM', name: 'Alice Martin', sid: AM_SID, admin: true
    });
});

test('whoami: someone let in by the audience is not an administrator', async () => {
    // The shape the whole feature exists for: open to the directory, one named
    // administrator, everybody else a reader the application can tell apart.
    const slug = 'tenant-whoami-plain';
    const tenantPaths = seed(slug, 'app', {
        name: 'App',
        auth: {
            method: 'ldap', enabled: true, audience: 'directory', allowedGroups: [],
            allowedUsers: [{ sid: AM_SID, login: 'AM', name: 'Alice Martin', admin: true }]
        }
    }, GOOD_CONFIG);

    const token = await loginAs(slug, tenantPaths, 'app', 'jdoe',
        { ok: true, dn: 'jdoe@corp.local', displayName: 'J Doe', groups: [],
          sid: 'S-1-5-21-1-2-3-2000' });
    const { res } = await getWith(slug, tenantPaths, 'app', '/__aegis/whoami', token);

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.authenticated, true);
    assert.strictEqual(body.login, 'jdoe');
    assert.strictEqual(body.admin, false);
});

test('whoami: no session answers 401 and names nobody', async () => {
    const slug = 'tenant-whoami-anon';
    const tenantPaths = seed(slug, 'app',
        { name: 'App', auth: { method: 'ldap', enabled: true, allowedGroups: [] } }, GOOD_CONFIG);

    const { res, handled } = await getWith(slug, tenantPaths, 'app', '/__aegis/whoami', null);
    assert.strictEqual(handled, true);
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(JSON.parse(res.body), { authenticated: false });
});

test('whoami: an unprotected site has no identity to report', async () => {
    // 404 on the whole reserved prefix, which is the honest answer: there is no
    // directory identity behind an unprotected site. An application reads any
    // non-200 as "no Aegis identity here".
    const slug = 'tenant-whoami-open';
    const tenantPaths = seed(slug, 'app', { name: 'App' }, GOOD_CONFIG);

    const { res, handled } = await getWith(slug, tenantPaths, 'app', '/__aegis/whoami', null);
    assert.strictEqual(handled, true);
    assert.strictEqual(res.statusCode, 404);
});

test('whoami: the site cannot serve its own file on that path', async () => {
    // The prefix is reserved before any file is resolved. A repository that
    // contained __aegis/whoami could otherwise answer admin:true itself.
    const slug = 'tenant-whoami-post';
    const tenantPaths = seed(slug, 'app',
        { name: 'App', auth: { method: 'ldap', enabled: true, allowedGroups: [] } }, GOOD_CONFIG);

    const res = fakeRes();
    const handled = await siteAuth.gate(
        fakeReq('POST', '/__aegis/whoami', {}), res,
        { slug, tenantPaths, project: { id: 'app', name: 'App' } });
    assert.strictEqual(handled, true);
    assert.strictEqual(res.statusCode, 404, 'only GET and HEAD answer here');
});

/* ------------------------------------------------------------------ */
/* the access policy: past the door, which rooms                       */
/* ------------------------------------------------------------------ */

/**
 * Writes an access manifest into the folder the project is serving.
 *
 * `siteAuth` reads it from `current/`, so the rules travel with the commit and
 * a rollback restores the rules of the commit it restores.
 */
function writeManifest(tenantPaths, projectId, doc) {
    const dir = projectStore.currentDir(tenantPaths, projectId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'aegis.access.json'), JSON.stringify(doc));
}

/** Signs somebody in and hands back their session cookie. */
async function sessionFor(slug, tenantPaths, projectId, groups, sid) {
    siteAuth._setVerifier(() => ({
        ok: true, dn: 'CN=X,DC=corp,DC=local', displayName: 'X',
        groups: groups || [], sid: sid || 'S-1-5-21-1-2-3-1000'
    }));
    try {
        const { res } = await login(slug, tenantPaths, projectId,
            { username: 'someone', password: SECRET, next: '/' });
        return cookieValue(res.headers['Set-Cookie'], 'aegis_site');
    } finally {
        siteAuth._setVerifier(null);
    }
}

async function knockWith(slug, tenantPaths, projectId, url, token) {
    // `gate` answers synchronously on the authenticated path and with a promise
    // on the ones that reach the directory, so this awaits either.
    const res = fakeRes();
    const handled = await siteAuth.gate(
        fakeReq('GET', url, { headers: { cookie: `aegis_site=${token}` } }), res,
        { slug, tenantPaths, project: { id: projectId, name: projectId } });
    return { handled, res };
}

test('policy: a signed-in visitor with no grant is refused, and the site never serves it', async () => {
    const slug = 'pol-deny';
    const tenantPaths = seed(slug, 'app', {
        name: 'App',
        auth: { method: 'ldap', enabled: true, audience: 'directory', allowedGroups: [], allowedUsers: [], grants: { admin: { groups: ['Site-Admins'], users: [] } } }
    }, GOOD_CONFIG);
    writeManifest(tenantPaths, 'app', { rules: [{ path: '/admin/*', require: 'admin' }] });
    siteAuth.invalidate(slug, 'app');

    const token = await sessionFor(slug, tenantPaths, 'app', ['CN=Domain Users,DC=corp,DC=local']);
    const { handled, res } = await knockWith(slug, tenantPaths, 'app', '/admin/users', token);

    assert.strictEqual(handled, true, 'the guard answers instead of letting the site serve');
    assert.strictEqual(res.statusCode, 403);
});

test('policy: the same visitor is served everything no rule names', async () => {
    const slug = 'pol-open';
    const tenantPaths = seed(slug, 'app', {
        name: 'App',
        auth: { method: 'ldap', enabled: true, audience: 'directory', allowedGroups: [], allowedUsers: [], grants: {} }
    }, GOOD_CONFIG);
    writeManifest(tenantPaths, 'app', { rules: [{ path: '/admin/*', require: 'admin' }] });
    siteAuth.invalidate(slug, 'app');

    const token = await sessionFor(slug, tenantPaths, 'app', []);
    const { handled } = await knockWith(slug, tenantPaths, 'app', '/index.html', token);
    assert.strictEqual(handled, false, 'a path outside every rule is untouched by the policy');
});

test('policy: the group named on the resource opens it', async () => {
    const slug = 'pol-allow';
    const tenantPaths = seed(slug, 'app', {
        name: 'App',
        auth: { method: 'ldap', enabled: true, audience: 'directory', allowedGroups: [], allowedUsers: [], grants: { admin: { groups: ['Site-Admins'], users: [] } } }
    }, GOOD_CONFIG);
    writeManifest(tenantPaths, 'app', { rules: [{ path: '/admin/*', require: 'admin' }] });
    siteAuth.invalidate(slug, 'app');

    const token = await sessionFor(slug, tenantPaths, 'app', ['CN=Site-Admins,CN=Users,DC=corp,DC=local']);
    const { handled } = await knockWith(slug, tenantPaths, 'app', '/admin/users', token);
    assert.strictEqual(handled, false, 'holding the resource is what opens the path');
});

test('policy: a resource nobody is bound to closes the path for everyone', async () => {
    const slug = 'pol-typo';
    const tenantPaths = seed(slug, 'app', {
        name: 'App',
        auth: { method: 'ldap', enabled: true, audience: 'directory', allowedGroups: [], allowedUsers: [], grants: {} }
    }, GOOD_CONFIG);
    writeManifest(tenantPaths, 'app', { rules: [{ path: '/secret/*', require: 'nobody-holds-this' }] });
    siteAuth.invalidate(slug, 'app');

    const token = await sessionFor(slug, tenantPaths, 'app', ['CN=Site-Admins,DC=corp,DC=local']);
    const { res } = await knockWith(slug, tenantPaths, 'app', '/secret/x', token);
    assert.strictEqual(res.statusCode, 403, 'a typo in the manifest locks a door, it does not open one');
});

test('policy: the refusal survives a path spelled to slip past it', async () => {
    // The whole reason the verdict normalises. The file resolver decodes and
    // resolves on a case-insensitive filesystem, so these all reach the same
    // folder and all of them have to be refused.
    const slug = 'pol-spell';
    const tenantPaths = seed(slug, 'app', {
        name: 'App',
        auth: { method: 'ldap', enabled: true, audience: 'directory', allowedGroups: [], allowedUsers: [], grants: { admin: { groups: ['Site-Admins'], users: [] } } }
    }, GOOD_CONFIG);
    writeManifest(tenantPaths, 'app', { rules: [{ path: '/admin/*', require: 'admin' }] });
    siteAuth.invalidate(slug, 'app');

    const token = await sessionFor(slug, tenantPaths, 'app', ['CN=Domain Users,DC=corp,DC=local']);
    for (const url of ['/ADMIN/users', '/%61dmin/users', '/public/../admin/users', '//admin/users']) {
        const { res } = await knockWith(slug, tenantPaths, 'app', url, token);
        assert.strictEqual(res.statusCode, 403, `${url} must be refused`);
    }
});

test('policy: the site administrator holds every resource without being named under it', async () => {
    const slug = 'pol-admin';
    const sid = 'S-1-5-21-1-2-3-1103';
    const tenantPaths = seed(slug, 'app', {
        name: 'App',
        auth: { method: 'ldap', enabled: true, audience: 'directory', allowedGroups: [],
            allowedUsers: [{ sid, login: 'AM', name: 'Alice Martin', admin: true }], grants: {} }
    }, GOOD_CONFIG);
    writeManifest(tenantPaths, 'app', { rules: [
        { path: '/compta/*', require: 'comptabilite' },
        { path: '/prod/*', require: 'production' }] });
    siteAuth.invalidate(slug, 'app');

    const token = await sessionFor(slug, tenantPaths, 'app', [], sid);
    for (const url of ['/compta/x', '/prod/x']) {
        const { handled } = await knockWith(slug, tenantPaths, 'app', url, token);
        assert.strictEqual(handled, false, `${url}: the administrator is not stopped by a resource`);
    }
});

test('policy: a person named on the site without the Administrator tick holds nothing more', async () => {
    const slug = 'pol-named';
    const sid = 'S-1-5-21-1-2-3-1104';
    const tenantPaths = seed(slug, 'app', {
        name: 'App',
        auth: { method: 'ldap', enabled: true, audience: 'directory', allowedGroups: [],
            allowedUsers: [{ sid, login: 'BM', name: 'Bob Martin', admin: false }], grants: {} }
    }, GOOD_CONFIG);
    writeManifest(tenantPaths, 'app', { rules: [{ path: '/compta/*', require: 'comptabilite' }] });
    siteAuth.invalidate(slug, 'app');

    const token = await sessionFor(slug, tenantPaths, 'app', [], sid);
    const { res } = await knockWith(slug, tenantPaths, 'app', '/compta/x', token);
    assert.strictEqual(res.statusCode, 403, 'being let in is not holding a resource');
});

test('policy: a site with no manifest is served exactly as it was before', async () => {
    const slug = 'pol-none';
    const tenantPaths = seed(slug, 'app', {
        name: 'App',
        auth: { method: 'ldap', enabled: true, audience: 'directory', allowedGroups: [], allowedUsers: [] }
    }, GOOD_CONFIG);

    const token = await sessionFor(slug, tenantPaths, 'app', []);
    const { handled } = await knockWith(slug, tenantPaths, 'app', '/admin/users', token);
    assert.strictEqual(handled, false, 'every site deployed before this feature has to keep serving');
});

/* ------------------------------------------------------------------ */
/* HTTPS is mandatory for a protected site                             */
/* ------------------------------------------------------------------ */

test('tls: a protected site answers 503 site_not_tls on a plain socket, with no form and no cookie', async () => {
    const slug = 'tls-plain';
    const tenantPaths = seed(slug, 'app',
        { name: 'App', auth: { method: 'ldap', enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    let verified = 0;
    siteAuth._setVerifier(() => { verified += 1; return { ok: true, groups: [] }; });

    try {
        for (const [verb, url] of [['GET', '/'], ['GET', '/__aegis/login'], ['POST', '/__aegis/login']]) {
            const res = fakeRes();
            const handled = await siteAuth.gate(
                fakeReq(verb, url, { secure: false, body: verb === 'POST' ? 'username=a&password=b' : undefined }),
                res, { slug, tenantPaths, project: { id: 'app', name: 'App' } });
            assert.strictEqual(handled, true, `${verb} ${url}`);
            assert.strictEqual(res.statusCode, 503, `${verb} ${url}`);
            assert.ok(!/<form/i.test(res.body), 'no login form crosses a clear socket');
            assert.strictEqual(res.headers['Set-Cookie'], undefined, 'no cookie either');
        }
        assert.strictEqual(verified, 0, 'the directory is never consulted over a clear socket');
    } finally {
        siteAuth._setVerifier(null);
    }
});

test('tls: an unprotected site is still served on a plain socket', async () => {
    const slug = 'tls-open';
    const tenantPaths = seed(slug, 'open', { name: 'Open' }, null);
    const handled = await siteAuth.gate(fakeReq('GET', '/', { secure: false }), fakeRes(),
        { slug, tenantPaths, project: { id: 'open', name: 'Open' } });
    assert.strictEqual(handled, false);
});

test('tls: HSTS is sent only on a secure request under the project host name', async () => {
    const slug = 'tls-hsts';
    const tenantPaths = seed(slug, 'app',
        { name: 'App', auth: { method: 'ldap', enabled: true, allowedGroups: [] } }, GOOD_CONFIG);
    const project = { id: 'app', name: 'App' };

    const named = fakeRes();
    await siteAuth.gate(fakeReq('GET', '/__aegis/login', { headers: { host: 'app.corp.local' } }), named,
        { slug, tenantPaths, project, viaRouterHostName: 'app.corp.local' });
    assert.strictEqual(named.headers['Strict-Transport-Security'], 'max-age=31536000');

    const byPort = fakeRes();
    await siteAuth.gate(fakeReq('GET', '/__aegis/login', { headers: { host: 'srv.corp.local:3081' } }), byPort,
        { slug, tenantPaths, project });
    assert.strictEqual(byPort.statusCode, 200);
    assert.strictEqual(byPort.headers['Strict-Transport-Security'], undefined,
        'HSTS ignores the port, so a port URL must never send it');

    const clear = fakeRes();
    await siteAuth.gate(fakeReq('GET', '/', { secure: false, headers: { host: 'app.corp.local' } }), clear,
        { slug, tenantPaths, project, viaRouterHostName: 'app.corp.local' });
    assert.strictEqual(clear.headers['Strict-Transport-Security'], undefined,
        'HSTS over a clear socket is ignored by browsers and misleading');
});
