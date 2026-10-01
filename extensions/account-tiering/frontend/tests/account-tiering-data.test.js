/**
 * Tier 3: the page against models the real-backend fixture does not hold
 * (tests/models.js) and against answers that are not a model at all. Each
 * test names its case.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const P = require('./page');
if (!P.available) {
    test('the Arbre des comptes page: models the fixture does not hold', { skip: P.why }, () => {});
    return;
}
const { fixture, API, open, count, text, click } = P;
const { twoHoldersModel, sid } = require('./models');

before(P.start);
after(P.stop);

const withModel = (model, rules) => open({ [`${API}/model`]: { success: true, model }, ...(rules ? { [`${API}/rules`]: { success: true, rules } } : {}) });

test('two holders of one right are two mechanisms: two nodes, two rows, no shared key', async () => {
    const { page, close } = await withModel(twoHoldersModel());
    const mechs = await page.$$eval('.at-node[data-node^="m:"]', (els) => els.map((e) => e.dataset.node));
    assert.strictEqual(mechs.length, 2, 'one node per holder');
    assert.strictEqual(new Set(mechs).size, 2);
    await click(page, '[data-viewbtn="list"]');
    const rows = await page.$$eval('#at-list .at-lrow', (els) => els.map((e) => [e.dataset.key, e.dataset.node, e.querySelector('.at-lrow-strong').textContent]));
    assert.deepStrictEqual(rows.map((r) => r[2]), ['GG-Exploitation', 'GG-Support-N2']);
    assert.strictEqual(new Set(rows.map((r) => r[0])).size, 2, 'data-key');
    assert.strictEqual(new Set(rows.map((r) => r[1])).size, 2, 'data-node');
    // Each row explains its own holder.
    await click(page, '#at-list .at-lrow:nth-of-type(2)');
    assert.strictEqual(await count(page, '#at-list .at-lrow.is-selected'), 1);
    assert.match(await text(page, '#at-panel .at-path .at-text'), /GG-Support-N2 détient WriteDacl/);
    // And a chokepoint opens on its own holder, not on the first one.
    await click(page, '[data-viewbtn="overview"]');
    await click(page, '#at-points .at-point:nth-child(2)');
    assert.strictEqual(await page.$eval('.at-node[aria-pressed="true"]', (el) => el.dataset.node), `g:${sid(1202)}`);
    await close();
});

test('a model the page cannot digest shows the error card instead of loading forever', async () => {
    const { page, close } = await open({ [`${API}/model`]: { success: true, model: { accounts: [null], links: [null] } } }, { wait: false });
    await page.waitForSelector('#at-error-card', { timeout: 4000 });
    assert.strictEqual(await page.$eval('#at-error-card', (el) => el.dataset.code), 'internal');
    assert.match(await text(page, '#at-error-card'), /Le serveur a rencontré une erreur/);
    assert.strictEqual(await page.evaluate(() => window.AccountTiering.app.state.loading), false);
    assert.strictEqual(await page.$eval('#at-body', (el) => el.hidden), true);
    await close();

    // A model that builds but breaks a later draw ends the same way: here a
    // name that is not a string, which only the search trips over.
    const odd = JSON.parse(JSON.stringify(fixture.model));
    odd.accounts[0].name = 42;
    const later = await withModel(odd);
    assert.ok(await later.page.$('#at-layer'), 'drawn at first');
    await later.page.type('#at-search', 'a');
    await later.page.waitForSelector('#at-error-card', { timeout: 4000 });
    assert.strictEqual(await later.page.$eval('#at-error-card', (el) => el.dataset.code), 'internal');
    assert.strictEqual(await later.page.$eval('#at-body', (el) => el.hidden), true);
    await later.close();
    assert.deepStrictEqual(later.pageErrors, [], 'caught, not left to the console as an exception');
});
