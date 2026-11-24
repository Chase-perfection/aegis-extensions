/**
 * The audience files of one project: raw lines per day, a summary per closed
 * day, the HMAC key, the purge, and the report the dashboard reads.
 *
 * Every test runs in its own temporary tenant under AEGIS_DATA_ROOT, so the
 * machine key and the files never touch a real install.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.AEGIS_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-deploy-audience-'));

const test = require('node:test');
const assert = require('node:assert');

const store = require('../audienceStore');
const audience = require('../audience');

console.warn = () => {};

const DAY = 24 * 3600 * 1000;
const D0 = new Date(2026, 10, 24, 9).getTime();
let n = 0;

function tenant() {
    n++;
    const root = path.join(process.env.AEGIS_DATA_ROOT, 'tenants', 'dt-plain-' + n);
    fs.mkdirSync(root, { recursive: true });
    return { root };
}

function at(daysAgo, hour) {
    const d = new Date(D0 - daysAgo * DAY);
    d.setHours(hour === undefined ? 9 : hour, 0, 0, 0);
    return d.getTime();
}

const view = (t, vis, pv, p) => ({ t, vis, k: 'view', pv, p: p || '/' });
const day = (daysAgo) => audience.localDay(at(daysAgo));
const TODAY = day(0);

test('the key is created once, stored encrypted, and read back the same', () => {
    const tp = tenant();
    const k1 = store.keyFor(tp);
    assert.strictEqual(k1.length, 32);
    store._forgetKeys();
    const k2 = store.keyFor(tp);
    assert.deepStrictEqual(k1, k2);
    const file = fs.readFileSync(path.join(tp.root, 'deploy', 'audience', 'key.json'), 'utf8');
    assert.ok(!file.includes(k1.toString('hex')));
});

test('two concurrent appends to one day give whole lines', async () => {
    const tp = tenant();
    const a = [];
    const b = [];
    for (let i = 0; i < 200; i++) {
        a.push(view(at(0) + i, 'aaaaaaaaaaaaaaaa', 'pva' + String(i).padStart(5, '0')));
        b.push(view(at(0) + i, 'bbbbbbbbbbbbbbbb', 'pvb' + String(i).padStart(5, '0')));
    }
    await Promise.all([store.append(tp, 'stock', a), store.append(tp, 'stock', b)]);
    const lines = store.readRaw(tp, 'stock', TODAY);
    assert.strictEqual(lines.length, 400);
});

test('a broken raw line is skipped, the others read', async () => {
    const tp = tenant();
    await store.append(tp, 'stock', [view(at(0), 'aaaaaaaaaaaaaaaa', 'pv000001')]);
    fs.appendFileSync(path.join(store.dirFor(tp, 'stock'), 'raw', TODAY + '.jsonl'), '{"t":\n');
    await store.append(tp, 'stock', [view(at(0) + 1, 'aaaaaaaaaaaaaaaa', 'pv000002')]);
    assert.strictEqual(store.readRaw(tp, 'stock', TODAY).length, 2);
});

test('close writes one summary per closed day and none for today', async () => {
    const tp = tenant();
    await store.append(tp, 'stock', [view(at(1), 'aaaaaaaaaaaaaaaa', 'pv000001')]);
    await store.append(tp, 'stock', [view(at(0), 'aaaaaaaaaaaaaaaa', 'pv000002')]);
    assert.strictEqual(store.close(tp, 'stock', TODAY), 1);
    const dir = path.join(store.dirFor(tp, 'stock'), 'days');
    assert.deepStrictEqual(fs.readdirSync(dir), [day(1) + '.json']);
    assert.strictEqual(store.close(tp, 'stock', TODAY), 0);
});

test('close after five silent days catches up every day once', async () => {
    const tp = tenant();
    for (let i = 5; i >= 1; i--) await store.append(tp, 'stock', [view(at(i), 'aaaaaaaaaaaaaaaa', 'pv00000' + i)]);
    assert.strictEqual(store.close(tp, 'stock', TODAY), 5);
    assert.strictEqual(store.close(tp, 'stock', TODAY), 0);
});

test('purge removes raw older than 90 days and summaries older than 760 days', () => {
    const tp = tenant();
    const dir = store.dirFor(tp, 'stock');
    fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'days'), { recursive: true });
    for (const d of [day(89), day(90), day(91)]) fs.writeFileSync(path.join(dir, 'raw', d + '.jsonl'), '');
    for (const d of [day(759), day(760), day(761)]) fs.writeFileSync(path.join(dir, 'days', d + '.json'), '{}');
    fs.writeFileSync(path.join(dir, 'raw', 'notes.txt'), '');
    store.purge(tp, 'stock', TODAY);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'raw')).sort(), [day(89) + '.jsonl', day(90) + '.jsonl', 'notes.txt'].sort());
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'days')).sort(), [day(759) + '.json', day(760) + '.json'].sort());
});

test('report within 90 days is exact, beyond is an estimate', async () => {
    const tp = tenant();
    const vis = 'a1b2c3d4e5f60718';
    await store.append(tp, 'stock', [view(at(2), vis, 'pv000001'), view(at(1), vis, 'pv000002'), view(at(0), vis, 'pv000003')]);
    const exact = store.report(tp, 'stock', day(29), TODAY, TODAY);
    assert.strictEqual(exact.visitorsPrecision, 'day');
    assert.strictEqual(exact.totals.visitors, 1);
    assert.strictEqual(exact.totals.visits, 3);
    const far = store.report(tp, 'stock', day(200), TODAY, TODAY);
    assert.strictEqual(far.visitorsPrecision, 'estimate');
    assert.strictEqual(far.totals.visitors, 1);
    assert.strictEqual(far.totals.visits, 3);
    assert.strictEqual(far.series.length, 201);
});

test('report lists every day of the period, empty ones at zero', () => {
    const tp = tenant();
    const r = store.report(tp, 'stock', day(6), TODAY, TODAY);
    assert.strictEqual(r.series.length, 7);
    assert.deepStrictEqual(r.series[0], { day: day(6), visitors: 0, visits: 0, activeMs: 0 });
    assert.deepStrictEqual(r.totals, { visitors: 0, visits: 0, activeMs: 0, avgVisitMs: 0 });
});

test('a visit that runs past midnight is not counted again on the next day', async () => {
    const tp = tenant();
    const late = at(1, 23) + 50 * 60 * 1000;
    await store.append(tp, 'stock', [view(late, 'aaaaaaaaaaaaaaaa', 'pv000001')]);
    await store.append(tp, 'stock', [{ t: late + 20 * 60 * 1000, vis: 'aaaaaaaaaaaaaaaa', k: 'time', pv: 'pv000001', p: '/', ms: 600000 }]);
    const r = store.report(tp, 'stock', day(1), TODAY, TODAY);
    assert.strictEqual(r.totals.visits, 1);
    assert.strictEqual(r.series[0].activeMs, 600000);
    assert.strictEqual(r.series[1].visits, 0);
});

test('removeProject deletes the project folder and nothing else', async () => {
    const tp = tenant();
    await store.append(tp, 'stock', [view(at(0), 'aaaaaaaaaaaaaaaa', 'pv000001')]);
    await store.append(tp, 'wiki', [view(at(0), 'aaaaaaaaaaaaaaaa', 'pv000001')]);
    store.keyFor(tp);
    store.removeProject(tp, 'stock');
    assert.ok(!fs.existsSync(store.dirFor(tp, 'stock')));
    assert.ok(fs.existsSync(store.dirFor(tp, 'wiki')));
    assert.ok(fs.existsSync(path.join(tp.root, 'deploy', 'audience', 'key.json')));
});

test('a raw file holds no ip, no username and no query', async () => {
    const tp = tenant();
    const key = store.keyFor(tp);
    const vis = audience.visitorId(key, 'stock', { username: 'alice.martin' });
    const parsed = audience.parseBatch(Buffer.from(JSON.stringify({ v: 1, events: [{ k: 'view', pv: 'pv000001', p: '/a?user=alice.martin' }] })));
    await store.append(tp, 'stock', parsed.events.map((e) => Object.assign({ t: at(0), vis }, e)));
    const text = fs.readFileSync(path.join(store.dirFor(tp, 'stock'), 'raw', TODAY + '.jsonl'), 'utf8');
    assert.ok(!text.includes('alice'));
    assert.ok(!text.includes('?'));
    assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(text));
});

test('a project id that could leave the folder is refused', () => {
    assert.throws(() => store.dirFor(tenant(), '../x'));
});
