/**
 * What the audience collection point accepts from a page, how it names a
 * visitor, and how much it lets one visitor or one site write.
 *
 * The promises under test: nothing a page sends can carry a query string, a
 * control character or an unbounded text into the files; a username never
 * appears in a visitor id; and the limits cut views and clicks, never the time
 * events that make durations right.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const audience = require('../audience');

const KEY = Buffer.alloc(32, 7);

function batch(events, extra) {
    return Buffer.from(JSON.stringify(Object.assign({ v: 1, events }, extra || {})), 'utf8');
}

const view = (pv, p) => ({ k: 'view', pv: pv || 'aaaaaaaa', p: p || '/' });
const click = (pv, p, c) => ({ k: 'click', pv: pv || 'aaaaaaaa', p: p || '/', c: c || 'button: Actualiser' });
const time = (pv, ms) => ({ k: 'time', pv: pv || 'aaaaaaaa', p: '/', ms: ms === undefined ? 1000 : ms });

test('a valid batch keeps its three kinds', () => {
    const out = audience.parseBatch(batch([view(), click(), time()]));
    assert.deepStrictEqual(out.events.map((e) => e.k), ['view', 'click', 'time']);
});

test('a batch over 16 KiB is too_large', () => {
    const big = Buffer.alloc(audience.LIMITS.body + 1, 0x20);
    assert.deepStrictEqual(audience.parseBatch(big), { error: 'too_large' });
});

test('a batch of 51 events is too_many', () => {
    const events = [];
    for (let i = 0; i < 51; i++) events.push(view());
    assert.deepStrictEqual(audience.parseBatch(batch(events)), { error: 'too_many' });
});

test('v other than 1 is bad_version, broken JSON is bad_json', () => {
    assert.deepStrictEqual(audience.parseBatch(batch([view()], { v: 2 })), { error: 'bad_version' });
    assert.deepStrictEqual(audience.parseBatch(Buffer.from('{"v":1,')), { error: 'bad_json' });
    assert.deepStrictEqual(audience.parseBatch(Buffer.from('[1]')), { error: 'bad_json' });
});

test('an event with a query or fragment keeps the path only', () => {
    const out = audience.parseBatch(batch([view('aaaaaaaa', '/a?x=1#y'), view('bbbbbbbb', '/b#top')]));
    assert.deepStrictEqual(out.events.map((e) => e.p), ['/a', '/b']);
});

test('a path that does not start with / is dropped, the rest kept', () => {
    const out = audience.parseBatch(batch([view('aaaaaaaa', 'https://x.test/a'), view('bbbbbbbb', '/ok')]));
    assert.deepStrictEqual(out.events.map((e) => e.p), ['/ok']);
});

test('a path longer than 200 characters is cut to 200', () => {
    const out = audience.parseBatch(batch([view('aaaaaaaa', '/' + 'a'.repeat(500))]));
    assert.strictEqual(out.events[0].p.length, 200);
});

test('a 10 000 character component is cut to 80', () => {
    const out = audience.parseBatch(batch([click('aaaaaaaa', '/', 'x'.repeat(10000))]));
    assert.strictEqual(out.events[0].c.length, 80);
});

test('control characters in a component become spaces', () => {
    const out = audience.parseBatch(batch([click('aaaaaaaa', '/', 'a\u0000b c\u0085d')]));
    assert.strictEqual(out.events[0].c, 'a b c d');
});

test('a component that is markup stays text, unchanged apart from length', () => {
    const out = audience.parseBatch(batch([click('aaaaaaaa', '/', 'button: <img src=x onerror=alert(1)>')]));
    assert.strictEqual(out.events[0].c, 'button: <img src=x onerror=alert(1)>');
});

test('a click without a component, a bad pv or an unknown kind is dropped', () => {
    const out = audience.parseBatch(batch([
        { k: 'click', pv: 'aaaaaaaa', p: '/' },
        { k: 'view', pv: 'BAD!', p: '/' },
        { k: 'scroll', pv: 'aaaaaaaa', p: '/' },
        view()
    ]));
    assert.strictEqual(out.events.length, 1);
});

test('ms above six hours or negative drops the event', () => {
    const out = audience.parseBatch(batch([time('aaaaaaaa', 21600001), time('aaaaaaaa', -1), time('aaaaaaaa', 1.5), time('aaaaaaaa', 21600000)]));
    assert.deepStrictEqual(out.events.map((e) => e.ms), [21600000]);
});

test('only the known fields of an event are kept', () => {
    const out = audience.parseBatch(batch([Object.assign(view(), { t: 1, ip: '192.0.2.1', vis: 'forged' })]));
    assert.deepStrictEqual(Object.keys(out.events[0]).sort(), ['k', 'p', 'pv']);
});

test('the same username in two cases is the same visitor', () => {
    assert.strictEqual(audience.visitorId(KEY, 'stock', { username: 'Alice.Martin' }),
        audience.visitorId(KEY, 'stock', { username: 'alice.martin' }));
});

test('the same username on two projects is two visitors', () => {
    assert.notStrictEqual(audience.visitorId(KEY, 'stock', { username: 'alice.martin' }),
        audience.visitorId(KEY, 'wiki', { username: 'alice.martin' }));
});

test('a cookie visitor never equals a username visitor of the same text', () => {
    assert.notStrictEqual(audience.visitorId(KEY, 'stock', { cookie: 'alice.martin' }),
        audience.visitorId(KEY, 'stock', { username: 'alice.martin' }));
});

test('the visitor id is 16 hex characters and holds no part of the username', () => {
    const id = audience.visitorId(KEY, 'stock', { username: 'alice' });
    assert.match(id, /^[0-9a-f]{16}$/);
    assert.ok(!id.includes('alice'));
});

test('a new cookie value has the cookie shape', () => {
    const v = audience.newCookieValue();
    assert.match(v, audience.COOKIE_RE);
    assert.notStrictEqual(v, audience.newCookieValue());
});

function limiterAt(clock) {
    return audience.createLimiter({ now: () => clock.t });
}

test('the 241st view in one minute is refused, a time event still passes', () => {
    const clock = { t: 1000 };
    const lim = limiterAt(clock);
    let kept = 0;
    for (let i = 0; i < 241; i++) kept += lim.admit('dt-plain', 'stock', 'v1', [view('aaaaaaaa')]).length;
    assert.strictEqual(kept, 240);
    assert.strictEqual(lim.admit('dt-plain', 'stock', 'v1', [time('aaaaaaaa')]).length, 1);
    clock.t += 61000;
    assert.strictEqual(lim.admit('dt-plain', 'stock', 'v1', [view('aaaaaaaa')]).length, 1);
});

test('a time event for an unknown pv is refused', () => {
    const lim = limiterAt({ t: 0 });
    assert.strictEqual(lim.admit('dt-plain', 'stock', 'v1', [time('zzzzzzzz')]).length, 0);
});

test('a view accepted in the same batch makes its time event known', () => {
    const lim = limiterAt({ t: 0 });
    assert.strictEqual(lim.admit('dt-plain', 'stock', 'v1', [view('cccccccc'), time('cccccccc')]).length, 2);
});

test('a final time event 3 s after the last one is kept', () => {
    const clock = { t: 0 };
    const lim = limiterAt(clock);
    lim.admit('dt-plain', 'stock', 'v1', [view('aaaaaaaa')]);
    clock.t += 15000;
    assert.strictEqual(lim.admit('dt-plain', 'stock', 'v1', [time('aaaaaaaa', 15000)]).length, 1);
    clock.t += 3000;
    assert.strictEqual(lim.admit('dt-plain', 'stock', 'v1', [time('aaaaaaaa', 18000)]).length, 1);
});

test('a time event that does not grow is refused', () => {
    const clock = { t: 0 };
    const lim = limiterAt(clock);
    lim.admit('dt-plain', 'stock', 'v1', [view('aaaaaaaa')]);
    clock.t += 20000;
    assert.strictEqual(lim.admit('dt-plain', 'stock', 'v1', [time('aaaaaaaa', 15000)]).length, 1);
    assert.strictEqual(lim.admit('dt-plain', 'stock', 'v1', [time('aaaaaaaa', 15000)]).length, 0);
    assert.strictEqual(lim.admit('dt-plain', 'stock', 'v1', [time('aaaaaaaa', 9000)]).length, 0);
});

test('a time event larger than the elapsed time plus 5 s is refused', () => {
    const clock = { t: 0 };
    const lim = limiterAt(clock);
    lim.admit('dt-plain', 'stock', 'v1', [view('aaaaaaaa')]);
    clock.t += 10000;
    assert.strictEqual(lim.admit('dt-plain', 'stock', 'v1', [time('aaaaaaaa', 21600000)]).length, 0);
    assert.strictEqual(lim.admit('dt-plain', 'stock', 'v1', [time('aaaaaaaa', 15001)]).length, 0);
    assert.strictEqual(lim.admit('dt-plain', 'stock', 'v1', [time('aaaaaaaa', 15000)]).length, 1);
});

test('time lines of one view are bounded by its age', () => {
    const clock = { t: 0 };
    const lim = limiterAt(clock);
    lim.admit('dt-plain', 'stock', 'v1', [view('aaaaaaaa')]);
    clock.t += 10000;
    let kept = 0;
    for (let ms = 1; ms <= 50; ms++) kept += lim.admit('dt-plain', 'stock', 'v1', [time('aaaaaaaa', ms)]).length;
    // Two to start, plus one per 5 s of age.
    assert.strictEqual(kept, 4);
});

test('time lines of a site stop at their own daily cap', () => {
    const clock = { t: 0 };
    const lim = audience.createLimiter({ now: () => clock.t, siteCap: 10, timeCap: 3 });
    for (let i = 0; i < 5; i++) lim.admit('dt-plain', 'stock', 'v' + i, [view('pv00000' + i)]);
    clock.t += 20000;
    let kept = 0;
    for (let i = 0; i < 5; i++) kept += lim.admit('dt-plain', 'stock', 'v' + i, [time('pv00000' + i, 1000)]).length;
    assert.strictEqual(kept, 3);
});

test('stale limiter entries are swept at most once per sweep interval', () => {
    const clock = { t: 0 };
    const lim = audience.createLimiter({ now: () => clock.t, sweepAt: 5, sweepEveryMs: 60000 });
    for (let i = 0; i < 10; i++) lim.admit('dt-plain', 'stock', 'v' + i, [view('pv00000' + i)]);
    const before = lim._sweeps();
    for (let i = 0; i < 100; i++) lim.admit('dt-plain', 'stock', 'w' + i, [view('pw' + String(i).padStart(6, '0'))]);
    assert.ok(lim._sweeps() - before <= 1, `swept ${lim._sweeps() - before} times`);
    clock.t += 61000;
    lim.admit('dt-plain', 'stock', 'x', [view('px000001')]);
    assert.ok(lim._sweeps() - before <= 2);
});

test('the site cap counts view and click only, and warns once a day', () => {
    const clock = { t: 0 };
    const lim = audience.createLimiter({ now: () => clock.t, siteCap: 3 });
    const warned = [];
    const warn = console.warn;
    console.warn = (m) => warned.push(m);
    try {
        let kept = 0;
        for (let i = 0; i < 5; i++) kept += lim.admit('dt-plain', 'stock', 'v' + i, [view('aaaaaaa' + i)]).length;
        assert.strictEqual(kept, 3);
        assert.strictEqual(lim.admit('dt-plain', 'stock', 'v0', [time('aaaaaaa0')]).length, 1);
        assert.strictEqual(warned.length, 1);
        assert.strictEqual(lim.admit('dt-plain', 'other', 'v9', [view('bbbbbbbb')]).length, 1);
    } finally {
        console.warn = warn;
    }
});

test('curl and HeadlessChrome are bots, a desktop browser is not', () => {
    assert.ok(audience.isBot('curl/8.4.0'));
    assert.ok(audience.isBot('Mozilla/5.0 HeadlessChrome/120.0'));
    assert.ok(audience.isBot('Googlebot/2.1'));
    assert.ok(!audience.isBot('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'));
});

test('the cookie header carries Max-Age=34214400, HttpOnly, SameSite=Lax, and Secure only when asked', () => {
    const plain = audience.cookieHeader('stock', 'v'.repeat(22), false);
    assert.strictEqual(plain, `aegis_aud_stock=${'v'.repeat(22)}; Max-Age=34214400; Path=/; HttpOnly; SameSite=Lax`);
    assert.ok(audience.cookieHeader('stock', 'v'.repeat(22), true).endsWith('; Secure'));
    assert.strictEqual(audience.cookieName('stock'), 'aegis_aud_stock');
});

test('normalizeAudience takes a strict boolean and refuses anything else', () => {
    assert.deepStrictEqual(audience.normalizeAudience(undefined), { enabled: false });
    assert.deepStrictEqual(audience.normalizeAudience({ enabled: true }), { enabled: true });
    assert.throws(() => audience.normalizeAudience({ enabled: 'yes' }), (e) => e.code === 'bad_audience');
    assert.throws(() => audience.normalizeAudience([]), (e) => e.code === 'bad_audience');
    assert.deepStrictEqual(audience.configOf({ audience: { enabled: 'garbage' } }), { enabled: false });
});
