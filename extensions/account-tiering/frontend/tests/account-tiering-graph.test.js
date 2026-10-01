/**
 * Unit tests for the tree layout, on the view model of the real-backend fixture.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildViewModel } = require('../src/js/account-tiering-model.js');
const G = require('../src/js/account-tiering-graph.js');
const fixture = require('./fixtures/model.json');

const vm = buildViewModel(fixture.model, { rules: fixture.rules });
const acc = (sam) => vm.accounts.find((a) => a.sam === sam);

test('one account: four columns, account to group to mechanism to tier', () => {
    const g = G.buildGraph([acc('a.martin')], { ghost: true });
    const ids = Object.keys(g.y);
    assert.deepStrictEqual(ids.map(G.colOf).sort(), [0, 1, 1, 2, 3]);
    assert.ok(ids.includes('ghost'), 'the unprivileged group is the ghost node');
    assert.ok(g.edges.some((e) => e.from.startsWith('a:') && e.to.startsWith('g:')));
    assert.ok(g.edges.some((e) => e.to === 't:0'));
});

test('more than GMAX groups fold into a soft node, and expand on demand with a fold-back node', () => {
    const folded = G.buildGraph([acc('svc-sccm')], {});
    const col1 = Object.keys(folded.y).filter((id) => G.colOf(id) === 1);
    assert.strictEqual(col1.length, G.GMAX);
    assert.ok(col1.includes('cl:g'));
    assert.strictEqual(folded.colG.length, 10 - (G.GMAX - 1));
    const open = G.buildGraph([acc('svc-sccm')], { expandG: true });
    const col1Open = Object.keys(open.y).filter((id) => G.colOf(id) === 1);
    assert.strictEqual(col1Open.length, 11, 'ten groups plus the fold-back node');
    assert.ok(col1Open.includes('fold'));
});

test('a selected group inside the fold stays visible', () => {
    const last = acc('svc-sccm').groups[9].key;
    const g = G.buildGraph([acc('svc-sccm')], { keepG: last });
    assert.ok(g.y['g:' + last] != null);
});

test('rows never overlap inside a column', () => {
    const g = G.buildGraph(vm.accounts, { inverse: true, tier: 0, expandA: true, expandG: true });
    for (const c of [0, 1, 2, 3]) {
        const ys = Object.keys(g.y).filter((id) => G.colOf(id) === c).map((id) => g.y[id]).sort((a, b) => a - b);
        for (let i = 1; i < ys.length; i += 1) assert.ok(ys[i] - ys[i - 1] >= G.ROW, `column ${c}`);
    }
});

test('inverted tree at Tier 0 lists only Tier 0 mechanisms; ecartOnly drops the compliant admin', () => {
    const all = G.buildGraph(vm.accounts, { inverse: true, tier: 0 });
    assert.ok(Object.values(all.Mm).every((M) => M.m.tier === 0));
    assert.ok(all.A.some((e) => e.acc.sam === 'adm-t0-rdubois'));
    const gaps = G.buildGraph(vm.accounts, { inverse: true, tier: 0, ecartOnly: true });
    assert.ok(!gaps.A.some((e) => e.acc.sam === 'adm-t0-rdubois'));
});

test('highlight walks both directions from the selection', () => {
    const g = G.buildGraph([acc('h.dupont')], {});
    const H = G.highlight(g.edges, 't:0');
    assert.ok(H['a:' + acc('h.dupont').id]);
});

test('fit never zooms past 100 % and shrinks a tall tree', () => {
    assert.strictEqual(G.fitFor(300, 1400, 900).z, 1);
    const tall = G.fitFor(3000, 1000, 700);
    assert.ok(tall.z < 1 && tall.z >= G.ZMIN);
    assert.strictEqual(Math.round(tall.z * 20), tall.z * 20, 'a 5 % step');
});
