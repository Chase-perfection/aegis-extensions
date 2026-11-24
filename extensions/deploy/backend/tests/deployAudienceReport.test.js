/**
 * How raw audience lines become visits, durations and totals.
 *
 * Pure functions, no files. The cases are the ones a person reading the
 * dashboard would notice if they were wrong: a coffee break that splits or
 * does not split a visit, a visit that runs past midnight, and a person who
 * comes back three days in a row counting once over the three.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const report = require('../audienceReport');
const audience = require('../audience');

const MIN = 60 * 1000;
// Local midnight of 2026-11-24, so day boundaries follow the server clock.
const D0 = new Date(2026, 10, 24).getTime();
const dayOf = audience.localDay;
const onlyDay = (day) => ({ dayOf, inRange: (d) => d === day });
const days = (list) => ({ dayOf, inRange: (d) => list.includes(d) });

function v(t, vis, pv, p) { return { t, vis, k: 'view', pv, p: p || '/' }; }
function c(t, vis, pv, name, p) { return { t, vis, k: 'click', pv, p: p || '/', c: name }; }
function tm(t, vis, pv, ms, p) { return { t, vis, k: 'time', pv, p: p || '/', ms }; }

test('two events 29 min apart are one visit, 31 min apart are two', () => {
    const at = D0 + 9 * 60 * MIN;
    const one = report.summarize([v(at, 'a', 'pv000001'), v(at + 29 * MIN, 'a', 'pv000002')], onlyDay('2026-11-24'));
    assert.strictEqual(one.totals.visits, 1);
    const two = report.summarize([v(at, 'a', 'pv000001'), v(at + 31 * MIN, 'a', 'pv000002')], onlyDay('2026-11-24'));
    assert.strictEqual(two.totals.visits, 2);
    assert.strictEqual(two.totals.visitors, 1);
});

test('a visit lasts the sum of the largest ms of each pv', () => {
    const at = D0 + 10 * 60 * MIN;
    const s = report.summarize([
        v(at, 'a', 'pv000001'), tm(at + 10000, 'a', 'pv000001', 10000), tm(at + 25000, 'a', 'pv000001', 25000),
        v(at + 30000, 'a', 'pv000002', '/stock'), tm(at + 35000, 'a', 'pv000002', 5000, '/stock')
    ], onlyDay('2026-11-24'));
    assert.strictEqual(s.totals.activeMs, 30000);
    assert.strictEqual(s.totals.avgVisitMs, 30000);
    const stock = s.pages.find((p) => p.path === '/stock');
    assert.deepStrictEqual(stock, { path: '/stock', views: 1, visitors: 1, activeMs: 5000 });
});

test('a visit that starts at 23:50 and runs past midnight belongs to its first day and counts once over two days', () => {
    const late = D0 + 23 * 60 * MIN + 50 * MIN;
    const lines = [v(late, 'a', 'pv000001'), tm(late + 20 * MIN, 'a', 'pv000001', 600000)];
    const first = report.summarize(lines, onlyDay('2026-11-24'));
    assert.strictEqual(first.totals.visits, 1);
    assert.strictEqual(first.totals.activeMs, 600000);
    const second = report.summarize(lines, onlyDay('2026-11-25'));
    assert.strictEqual(second.totals.visits, 0);
    const both = report.summarize(lines, days(['2026-11-24', '2026-11-25']));
    assert.strictEqual(both.totals.visits, 1);
    assert.strictEqual(both.byDay['2026-11-24'].visits, 1);
    assert.strictEqual(both.byDay['2026-11-25'].visits, 0);
});

test('page visitors count distinct vis with a view on that page', () => {
    const at = D0 + 8 * 60 * MIN;
    const s = report.summarize([
        v(at, 'a', 'pv000001', '/stock'), v(at + MIN, 'a', 'pv000002', '/stock'), v(at, 'b', 'pv000003', '/stock')
    ], onlyDay('2026-11-24'));
    assert.deepStrictEqual(s.pages, [{ path: '/stock', views: 3, visitors: 2, activeMs: 0 }]);
});

test('component clicks group by path and name', () => {
    const at = D0 + 8 * 60 * MIN;
    const s = report.summarize([
        v(at, 'a', 'pv000001', '/stock'),
        c(at + 1, 'a', 'pv000001', 'button: Actualiser', '/stock'),
        c(at + 2, 'a', 'pv000001', 'button: Actualiser', '/stock'),
        c(at + 3, 'b', 'pv000002', 'button: Actualiser', '/stock'),
        c(at + 4, 'b', 'pv000002', 'button: Actualiser', '/')
    ], onlyDay('2026-11-24'));
    assert.deepStrictEqual(s.components, [
        { path: '/stock', name: 'button: Actualiser', clicks: 3, visitors: 2 },
        { path: '/', name: 'button: Actualiser', clicks: 1, visitors: 1 }
    ]);
});

test('a day summary holds no visitor id', () => {
    const s = report.summarize([v(D0 + MIN, 'a1b2c3d4e5f60718', 'pv000001')], onlyDay('2026-11-24'));
    assert.ok(!JSON.stringify(s.byDay['2026-11-24']).includes('a1b2c3d4e5f60718'));
    assert.strictEqual(typeof s.byDay['2026-11-24'].sketch, 'string');
});

test('capDay keeps 500 pages and folds the rest under (autres)', () => {
    const day = { day: '2026-11-24', visitors: 1, visits: 1, activeMs: 0, sketch: '', pages: {}, components: {} };
    for (let i = 0; i < 600; i++) day.pages['/p' + i] = { views: 1000 - i, visitors: 1, activeMs: 10 };
    const capped = report.capDay(day, 500);
    assert.strictEqual(Object.keys(capped.pages).length, 501);
    assert.deepStrictEqual(capped.pages['(autres)'], { views: 100 * 1000 - (500 + 599) * 100 / 2, visitors: 100, activeMs: 1000 });
    assert.ok(capped.pages['/p0'] && !capped.pages['/p599']);
});

test('combine over three days estimates visitors from the sketches, not by summing', () => {
    const summaries = [];
    for (let i = 0; i < 3; i++) {
        const day = dayOf(D0 + i * 24 * 60 * MIN);
        const s = report.summarize([v(D0 + i * 24 * 60 * MIN + 9 * 60 * MIN, 'a1b2c3d4e5f60718', 'pv00000' + i, '/stock')], onlyDay(day));
        summaries.push(s.byDay[day]);
    }
    const out = report.combine(summaries);
    assert.strictEqual(out.totals.visitors, 1);
    assert.strictEqual(out.totals.visits, 3);
    assert.deepStrictEqual(out.pages, [{ path: '/stock', views: 3, visitors: 3, activeMs: 0 }]);
    assert.strictEqual(out.series.length, 3);
});
