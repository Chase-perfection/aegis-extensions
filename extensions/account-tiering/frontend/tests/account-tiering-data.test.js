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
const { fixture, API, SID, open, loaded, pause, count, text, focused, click, script } = P;
const { bigModel, twoHoldersModel, hostileModel, hostile, sid } = require('./models');

before(P.start);
after(P.stop);

const withModel = (model, rules) => open({ [`${API}/model`]: { success: true, model }, ...(rules ? { [`${API}/rules`]: { success: true, rules } } : {}) });

test('a large domain: the left list draws a bounded number of rows, and more on request', async () => {
    const { page, close, pageErrors } = await withModel(bigModel(2000));
    const counts = await page.$$eval('[data-tierf] .at-mono', (els) => els.map((e) => e.textContent));
    assert.deepStrictEqual(counts, ['2000', '2000', '0', '0'], 'the filter counts are the whole domain');
    assert.match(await text(page, '#at-list-gaps .at-rule-head'), /500/);
    assert.match(await text(page, '#at-list-ok .at-rule-head'), /1500/);
    assert.strictEqual(await count(page, '#at-list-gaps .at-arow'), 3);
    assert.strictEqual(await count(page, '#at-list-ok .at-arow'), 100);
    assert.strictEqual(await count(page, '#at-left-dyn .at-arow'), 103);
    assert.match(await text(page, '#at-more-ok'), /100 comptes de plus/);
    await click(page, '#at-more-ok');
    assert.strictEqual(await count(page, '#at-list-ok .at-arow'), 200);
    assert.strictEqual(await focused(page), '#at-more-ok', 'the control keeps focus, to ask for more again');
    // Unfolding the gaps is bounded the same way.
    await click(page, '#at-more');
    assert.strictEqual(await count(page, '#at-list-gaps .at-arow'), 200);
    assert.ok(await page.$('#at-more-gaps'));
    // A filter starts again from the first hundred, and a short list has no control.
    await click(page, '[data-tierf="0"]');
    assert.strictEqual(await count(page, '#at-list-ok .at-arow'), 100);
    await click(page, '[data-tierf="1"]');
    assert.strictEqual(await count(page, '#at-left-dyn .at-arow'), 0);
    assert.strictEqual(await page.$('#at-more-ok'), null);
    await close();
    assert.deepStrictEqual(pageErrors, []);
});

test('typing in the search redraws once the typing pauses, and keeps focus and caret', async () => {
    const { page, close } = await withModel(bigModel(2000));
    await page.evaluate(() => {
        window.atDraws = 0;
        new MutationObserver(() => { window.atDraws += 1; }).observe(document.getElementById('at-left-dyn'), { childList: true });
    });
    await page.type('#at-search', 'compte-00');
    await pause(450);
    const draws = await page.evaluate(() => window.atDraws);
    assert.ok(draws >= 1 && draws <= 3, `nine keystrokes, ${draws} redraws of the list`);
    assert.strictEqual(await focused(page), '#at-search');
    assert.deepStrictEqual(await page.$eval('#at-search', (el) => [el.value, el.selectionStart]), ['compte-00', 9]);
    // compte-0000 to compte-0099: 25 gaps, 75 compliant.
    assert.strictEqual(await count(page, '#at-list-ok .at-arow'), 75);
    assert.strictEqual(await page.$('#at-more-ok'), null);
    assert.strictEqual(await page.$eval('#at-search-clear', (el) => el.hidden), false);
    // Clearing does not wait.
    await page.click('#at-search-clear');
    assert.strictEqual(await count(page, '#at-list-ok .at-arow'), 100);
    assert.strictEqual(await focused(page), '#at-search');
    await close();
});

test('a large domain: the inverted tree, its panel and its list draw a bounded number of accounts', async () => {
    const { page, close, pageErrors } = await withModel(bigModel(2000));
    await click(page, '#at-inverse');
    assert.strictEqual(await count(page, '.at-node[data-node^="a:"]'), 11, 'folded at first');
    assert.strictEqual(await page.$eval('[data-node="cl:a"]', (el) => el.dataset.nodeAct), 'expand-a');
    assert.ok(await count(page, '#at-panel .at-prow') <= 50, 'the panel lists a bounded number of accounts');
    assert.match(await text(page, '#at-panel-more'), /1950 autres comptes/);
    await click(page, '[data-node="cl:a"]');
    assert.strictEqual(await count(page, '.at-node[data-node^="a:"]'), 200, 'unfolded: two hundred, not two thousand');
    assert.match(await text(page, '[data-node="cl:a"]'), /\+ 1800 comptes\s*200 dessinés au plus/);
    assert.strictEqual(await page.$eval('[data-node="cl:a"]', (el) => el.dataset.nodeAct || null), null, 'the note is not an offer to unfold more');
    await click(page, '[data-viewbtn="list"]');
    assert.strictEqual(await count(page, '#at-list .at-lrow'), 300);
    assert.match(await text(page, '#at-list-more'), /1700 autres chemins/);
    await close();
    assert.deepStrictEqual(pageErrors, []);
});

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

test('a 403 on the model, whatever its body, shows the card reserved to administrators', async () => {
    const { page, close } = await open();
    await script(page, `${API}/model`, [{ status: 403, body: 'Forbidden' }], { onReload: true });
    await page.reload({ waitUntil: 'networkidle2' });
    await loaded(page);
    assert.strictEqual(await page.$eval('#at-error-card', (el) => el.dataset.code), 'forbidden');
    assert.match(await text(page, '#at-error-card'), /réservée aux administrateurs/);
    assert.strictEqual(await page.$eval('#at-export-wrap', (el) => el.hidden), true);
    await close();
});

test('names written to break the markup are shown as text, in every view and both dialogs', async () => {
    const { model, rules } = hostileModel();
    const { page, close, pageErrors } = await withModel(model, rules);
    const seen = [];
    const check = async (where) => {
        const found = await page.evaluate(() => ({
            injected: document.querySelectorAll('#at-view img, #at-view [onerror], img[src="x"]').length,
            ran: window.atInjected || null, text: document.getElementById('at-view').innerText
        }));
        assert.deepStrictEqual([found.injected, found.ran], [0, null], where);
        seen.push(found.text);
    };
    await check('tree');
    // Attributes hold the whole name: the quote did not end them early.
    assert.strictEqual(await page.$eval(`[data-node="a:${SID(2001)}"]`, (el) => el.title), hostile('account'));
    assert.strictEqual(await page.$eval(`[data-account="${SID(2001)}"] .at-strong`, (el) => el.textContent), hostile('account'));
    assert.strictEqual(await page.$eval(`[data-node="g:${SID(1101)}"]`, (el) => el.title), hostile('group'));
    await click(page, `[data-node="a:${SID(2001)}"]`);
    await check('account panel');
    await click(page, '#at-fix-open');
    await check('remediation dialog');
    await page.keyboard.press('Escape');
    await click(page, '#at-rules-open');
    await check('rules dialog');
    assert.strictEqual(await page.$eval('[data-key="rule-pattern:0"]', (el) => el.value), hostile('rule'));
    assert.strictEqual(await page.$eval(`#at-group-sids option[value="${SID(1101)}"]`, (el) => el.textContent), hostile('group'));
    await page.keyboard.press('Escape');
    await click(page, '[data-viewbtn="list"]');
    await check('list');
    // The inherited right (its origin DN) and the GPO (its label).
    await click(page, `[data-account="${SID(2004)}"]`);
    await check('inherited ACL');
    await click(page, '#at-more');
    await click(page, `[data-account="${SID(2005)}"]`);
    await click(page, '[data-viewbtn="tree"]');
    await check('GPO');
    await click(page, '[data-tierf="0"]');
    await click(page, `[data-account="${SID(2002)}"]`);
    await click(page, `[data-node="a:${SID(2002)}"]`);
    await check('rule source');
    await click(page, '#at-inverse');
    await check('inverted tree');
    await click(page, '[data-viewbtn="overview"]');
    await click(page, '[data-act="points-toggle"]');
    await check('overview');
    const all = seen.join('\n');
    for (const tag of ['account', 'sam', 'group', 'gpo', 'origin', 'rule']) assert.ok(all.includes(hostile(tag)), `the ${tag} string was displayed, as text`);
    await close();
    assert.deepStrictEqual(pageErrors, []);
});
