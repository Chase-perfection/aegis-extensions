/**
 * The audience script a site's pages run (frontend/site-auth/audience.js).
 *
 * Loaded into a `vm` context with a small fake of the browser: elements with
 * a tag, attributes, a parent and children; a document that takes listeners;
 * a history that can be pushed; a clock and timers the test moves by hand; a
 * sendBeacon that records what it is given. What is under test is what leaves
 * the page: the name a click gets, the views and their time, and that nothing
 * leaves when it must not.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'site-auth', 'audience.js'), 'utf8');

function el(tag, attrs, children, text) {
    const node = {
        tagName: tag.toUpperCase(),
        id: (attrs && attrs.id) || '',
        className: (attrs && attrs.class) || '',
        attrs: Object.assign({}, attrs),
        parentElement: null,
        children: [],
        innerText: text || '',
        textContent: text || '',
        value: (attrs && attrs.value) || '',
        getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
        hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }
    };
    for (const c of children || []) { c.parentElement = node; node.children.push(c); }
    if (!text && children && children.length) {
        node.innerText = children.map((c) => c.innerText).join(' ');
        node.textContent = node.innerText;
    }
    return node;
}

function browser(opts) {
    const o = opts || {};
    const clock = { now: 1764000000000 };
    const timers = [];
    const listeners = {};
    const docListeners = {};
    const beacons = [];
    const loc = { pathname: o.path || '/stock', search: '?q=secret', hash: '#top' };
    const doc = {
        visibilityState: 'visible',
        hidden: false,
        addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
        documentElement: null
    };
    const win = {
        __aegisAudienceTest: true,
        document: doc,
        location: loc,
        navigator: {
            globalPrivacyControl: o.gpc === true,
            sendBeacon: o.throwingBeacon
                ? () => { throw new Error('blocked'); }
                : (url, blob) => { beacons.push({ url, body: JSON.parse(blob.parts.join('')) }); return true; }
        },
        history: {
            pushState(state, title, url) { if (url) loc.pathname = String(url).split('?')[0]; },
            replaceState(state, title, url) { if (url) loc.pathname = String(url).split('?')[0]; }
        },
        Blob: function (parts, options) { this.parts = parts; this.type = options && options.type; },
        Date: { now: () => clock.now },
        Math, JSON, String, Number, Array, Object, RegExp, Error,
        setInterval(fn, ms) { timers.push({ fn, ms }); return timers.length; },
        clearInterval() {},
        setTimeout(fn) { fn(); return 0; },
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }
    };
    win.window = win;
    vm.createContext(win);
    vm.runInContext(SOURCE, win);
    function fire(map, type, ev) { (map[type] || []).forEach((fn) => fn(ev || {})); }
    return {
        win, clock, beacons, loc, doc,
        api: win.__aegisAudience,
        listenerCount: () => Object.keys(listeners).length + Object.keys(docListeners).length,
        tick(ms) {
            // Advances the clock one second at a time, running every interval.
            for (let t = 0; t < ms; t += 1000) {
                clock.now += 1000;
                for (const timer of timers) if (timer.ms === 1000) timer.fn();
            }
        },
        click(target) { fire(docListeners, 'click', { target }); },
        activity() { fire(docListeners, 'pointerdown', {}); },
        hide() { doc.visibilityState = 'hidden'; doc.hidden = true; fire(docListeners, 'visibilitychange'); },
        show() { doc.visibilityState = 'visible'; doc.hidden = false; fire(docListeners, 'visibilitychange'); },
        pagehide() { fire(listeners, 'pagehide'); },
        popstate() { fire(listeners, 'popstate'); },
        events() { return beacons.reduce((all, b) => all.concat(b.body.events), []); }
    };
}

/* ------------------------------------------------------------ the name */

test('data-aegis-track wins over id and text', () => {
    const b = browser();
    const btn = el('button', { 'data-aegis-track': 'refresh-stock', id: 'refresh' }, [], 'Actualiser');
    assert.strictEqual(b.api.nameOf(btn), 'button: refresh-stock');
});

test('an id names the control when there is no data-aegis-track', () => {
    const b = browser();
    assert.strictEqual(b.api.nameOf(el('button', { id: 'refresh' }, [], 'Actualiser')), 'button: #refresh');
});

test('a generated id like btn-8f3a9c21d0 is skipped for aria-label', () => {
    const b = browser();
    const btn = el('button', { id: 'btn-8f3a9c21d0', 'aria-label': 'Fermer' }, [], 'x');
    assert.strictEqual(b.api.nameOf(btn), 'button: Fermer');
    assert.strictEqual(b.api.nameOf(el('button', { id: 'row-2024', 'aria-label': 'Ouvrir' })), 'button: Ouvrir');
});

test('a button with text gives "button: Actualiser"', () => {
    const b = browser();
    assert.strictEqual(b.api.nameOf(el('button', {}, [], '  Actualiser \n ')), 'button: Actualiser');
});

test('a long text is cut to 40 characters', () => {
    const b = browser();
    const name = b.api.nameOf(el('a', {}, [], 'x'.repeat(100)));
    assert.strictEqual(name, 'a: ' + 'x'.repeat(40));
});

test('an input type=submit never exposes its value', () => {
    const b = browser();
    const form = el('form', { id: 'login' }, [el('input', { type: 'submit', value: 'alice.martin' })]);
    const name = b.api.nameOf(form.children[0]);
    assert.ok(!name.includes('alice'), name);
    assert.strictEqual(name, 'input: #login > input:nth-of-type(1)');
});

test('a control with nothing to name it by gets its tag, class and position', () => {
    const b = browser();
    const icon = el('span', { role: 'button', class: 'icon big' });
    el('div', { id: 'toolbar' }, [el('span', {}), icon]);
    assert.strictEqual(b.api.nameOf(icon), 'span: #toolbar > span.icon:nth-of-type(2)');
});

/* ----------------------------------------------------------- the clicks */

test('a click inside a span inside a button names the button', () => {
    const b = browser();
    const inner = el('span', {}, [], 'Actualiser');
    el('button', { id: 'refresh' }, [inner]);
    b.click(inner);
    b.tick(15000);
    const clicks = b.events().filter((e) => e.k === 'click');
    assert.deepStrictEqual(clicks.map((e) => e.c), ['button: #refresh']);
});

test('a click on plain text outside any control sends nothing', () => {
    const b = browser();
    const p = el('p', {}, [], 'hello');
    el('div', {}, [p]);
    b.click(p);
    b.tick(15000);
    assert.strictEqual(b.events().filter((e) => e.k === 'click').length, 0);
});

/* ------------------------------------------------------------ the views */

test('the first batch carries a view of the path, never its query or hash', () => {
    const b = browser({ path: '/stock' });
    b.tick(15000);
    const first = b.beacons[0];
    assert.strictEqual(first.url, '/__aegis/audience');
    assert.strictEqual(first.body.v, 1);
    const view = first.body.events.find((e) => e.k === 'view');
    assert.strictEqual(view.p, '/stock');
    assert.match(view.pv, /^[a-z0-9]{8,32}$/);
    assert.ok(!JSON.stringify(b.beacons).includes('secret'));
    assert.ok(!JSON.stringify(b.beacons).includes('#top'));
});

test('pushState to a new path ends the view and starts another', () => {
    const b = browser({ path: '/stock' });
    b.tick(5000);
    b.win.history.pushState({}, '', '/orders?id=4');
    b.tick(15000);
    const views = b.events().filter((e) => e.k === 'view');
    assert.deepStrictEqual(views.map((e) => e.p), ['/stock', '/orders']);
    assert.notStrictEqual(views[0].pv, views[1].pv);
    const stockTime = b.events().filter((e) => e.k === 'time' && e.pv === views[0].pv);
    assert.strictEqual(stockTime[stockTime.length - 1].ms, 5000);
});

test('replaceState on the same path keeps the view', () => {
    const b = browser({ path: '/stock' });
    b.win.history.replaceState({}, '', '/stock?tab=2');
    b.tick(15000);
    assert.strictEqual(b.events().filter((e) => e.k === 'view').length, 1);
});

test('popstate to another path starts a view', () => {
    const b = browser({ path: '/stock' });
    b.loc.pathname = '/';
    b.popstate();
    b.tick(15000);
    assert.deepStrictEqual(b.events().filter((e) => e.k === 'view').map((e) => e.p), ['/stock', '/']);
});

/* ------------------------------------------------------------- the time */

test('no interaction for 30 s stops the active time', () => {
    const b = browser();
    b.tick(60000);
    const times = b.events().filter((e) => e.k === 'time');
    assert.strictEqual(times[times.length - 1].ms, 30000);
    b.activity();
    b.tick(10000);
    b.pagehide();
    const after = b.events().filter((e) => e.k === 'time');
    assert.strictEqual(after[after.length - 1].ms, 40000);
});

test('a hidden tab does not count time', () => {
    const b = browser();
    b.tick(5000);
    b.hide();
    b.tick(20000);
    b.show();
    b.activity();
    b.tick(5000);
    b.pagehide();
    const times = b.events().filter((e) => e.k === 'time');
    assert.strictEqual(times[times.length - 1].ms, 10000);
});

test('pagehide sends the pending events with sendBeacon', () => {
    const b = browser();
    const btn = el('button', { id: 'refresh' }, [], 'Actualiser');
    b.tick(2000);
    b.click(btn);
    assert.strictEqual(b.beacons.length, 0);
    b.pagehide();
    assert.strictEqual(b.beacons.length, 1);
    assert.deepStrictEqual(b.beacons[0].body.events.map((e) => e.k), ['view', 'click', 'time']);
});

test('a batch never carries more than 50 events', () => {
    const b = browser();
    const btn = el('button', { id: 'refresh' }, [], 'Actualiser');
    for (let i = 0; i < 120; i++) b.click(btn);
    b.pagehide();
    assert.ok(b.beacons.every((x) => x.body.events.length <= 50));
    assert.strictEqual(b.events().filter((e) => e.k === 'click').length, 120);
});

/* -------------------------------------------------------- never harmful */

test('GPC on: no listener and no beacon', () => {
    const b = browser({ gpc: true });
    b.tick(30000);
    b.pagehide();
    assert.strictEqual(b.beacons.length, 0);
    assert.strictEqual(b.listenerCount(), 0);
});

test('a throwing sendBeacon does not throw into the page', () => {
    const b = browser({ throwingBeacon: true });
    assert.doesNotThrow(() => { b.tick(30000); b.pagehide(); });
});

test('the script has no hook for tests unless asked', () => {
    const win = { document: { addEventListener() {} }, location: { pathname: '/' }, navigator: {}, history: {},
        Date, setInterval() {}, addEventListener() {} };
    win.window = win;
    vm.createContext(win);
    vm.runInContext(SOURCE, win);
    assert.strictEqual(win.__aegisAudience, undefined);
});
