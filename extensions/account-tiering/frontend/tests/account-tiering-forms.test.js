/**
 * Tier 3: what the page does with what the user typed and with requests that
 * go wrong. The manual-correction draft, the scan polling when its status
 * cannot be read, overlapping model loads, and double submits.
 *
 * The polling delay is 2 s in production. The tests shorten it through
 * `data-at-poll-ms` on #at-view, which the page reads each time it schedules a
 * poll, so the retries are exercised for real and not waited for.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const P = require('./page');
if (!P.available) {
    test('the Arbre des comptes page: forms and failing requests', { skip: P.why }, () => {});
    return;
}
const { fixture, API, SID, OK_SCAN, open, settle, pause, count, text, toasts, focused, click, script } = P;

before(P.start);
after(P.stop);

const REASON = '#at-override-reason';
const value = (page, sel) => page.$eval(sel, (el) => el.value);
const sent = (requests, method, part) => requests.filter((r) => r.method === method && r.url.includes(part));
const fastPolling = (page) => page.$eval('#at-view', (el) => { el.dataset.atPollMs = '20'; });

/** Two activations in the same task, before any answer can come back. */
const clickTwice = (page, sel) => page.evaluate((s) => {
    for (let i = 0; i < 2; i += 1) {
        const el = document.querySelector(s);
        if (el) el.click();
    }
}, sel);

async function openCorrection(page) {
    await click(page, '[data-node^="a:"]');
    await click(page, '[data-act="override-open"]');
    assert.ok(await page.$(REASON), 'the correction form is open');
}

test('a refused correction keeps the tier and the reason that were typed, and shows why it was refused', async () => {
    const { page, close, map, requests, pageErrors } = await open();
    await openCorrection(page);
    await page.select('#at-override-tier', '0');
    await page.type(REASON, 'Administratrice du domaine');
    map[`${API}/overrides/`] = { success: false, error: 'invalid_sid' };
    await click(page, '[data-key="override-save"]');
    assert.strictEqual(sent(requests, 'PUT', '/overrides/').length, 1, 'the request went out');
    assert.match(await text(page, '#at-override-error'), /SID valide/);
    assert.strictEqual(await value(page, REASON), 'Administratrice du domaine');
    assert.strictEqual(await value(page, '#at-override-tier'), '0');
    assert.strictEqual(await focused(page), REASON, 'focus goes to the field to correct');
    // Typing resumes at the end of what was there, not at the start.
    await page.keyboard.type(' depuis 2024');
    assert.strictEqual(await value(page, REASON), 'Administratrice du domaine depuis 2024');
    await close();
    assert.deepStrictEqual(pageErrors, []);
});

test('the reason survives every render: a toggle, a search, a language change, a finished scan', async () => {
    const { page, close, map } = await open();
    await openCorrection(page);
    await page.type(REASON, 'Validé par le RSSI');
    await click(page, '#at-ecart');
    assert.strictEqual(await value(page, REASON), 'Validé par le RSSI', 'after "Écarts seulement"');
    await page.type('#at-search', 'ali');
    await pause(300);
    assert.strictEqual(await value(page, REASON), 'Validé par le RSSI', 'after a search');
    await page.evaluate(() => window.setLanguage('fr'));
    await settle(page);
    assert.strictEqual(await value(page, REASON), 'Validé par le RSSI', 'after a language change');
    // A scan that ends reloads the model and redraws the panel under the form.
    await fastPolling(page);
    map[`${API}/scan/status`] = { success: true, scan: { ...OK_SCAN, status: 'running', finished_at: null } };
    await click(page, '#at-scan');
    map[`${API}/scan/status`] = { success: true, scan: OK_SCAN };
    await page.waitForFunction(() => [...document.querySelectorAll('.aegis-toast')].some((e) => /Analyse terminée/.test(e.textContent)), { timeout: 5000 });
    assert.strictEqual(await value(page, REASON), 'Validé par le RSSI', 'after a scan');
    await close();
});

test('the draft is dropped on cancel, on another account, and once the correction is saved', async () => {
    const { page, close } = await open();
    await openCorrection(page);
    await page.type(REASON, 'Brouillon');
    await click(page, '[data-act="override-cancel"]');
    await click(page, '[data-act="override-open"]');
    assert.strictEqual(await value(page, REASON), '', 'cancelled');
    await page.type(REASON, 'Brouillon');
    await click(page, '#at-more');
    await click(page, `[data-account="${SID(2003)}"]`);
    await openCorrection(page);
    assert.strictEqual(await value(page, REASON), '', 'another account starts from nothing');
    await page.type(REASON, 'Compte de sauvegarde');
    await click(page, '[data-key="override-save"]');
    assert.strictEqual(await page.$(REASON), null, 'the form closes on success');
    assert.notStrictEqual(await focused(page), 'BODY', 'and focus stays in the page');
    await click(page, '[data-act="override-open"]');
    assert.strictEqual(await value(page, REASON), '', 'saved');
    await close();
});

test('a scan whose status cannot be read is retried five times, then reported, never announced as finished', async () => {
    const { page, close, map, requests } = await open();
    await fastPolling(page);
    map[`${API}/scan/status`] = { success: false, error: 'internal' };
    const before = sent(requests, 'GET', '/scan/status').length;
    await click(page, '#at-scan');
    await page.waitForSelector('#at-banner-pollfail, .aegis-toast', { timeout: 6000 });
    await pause(200);
    assert.deepStrictEqual((await toasts(page)).filter((t) => /Analyse terminée/.test(t)), [], 'no success toast');
    assert.match(await text(page, '#at-banner-pollfail'), /Le serveur a rencontré une erreur/);
    assert.strictEqual(await page.$eval('#at-banner-pollfail', (el) => el.getAttribute('role')), 'alert');
    assert.strictEqual(sent(requests, 'GET', '/scan/status').length - before, 5, 'five reads, then it stops');
    assert.strictEqual(await page.$eval('#at-scan', (el) => el.disabled), false, 'the button is usable again');
    assert.match(await text(page, '#at-scan'), /Relancer/);
    assert.strictEqual(await page.$('#at-banner-scanning'), null);
    // Relaunching is the way out: the notice goes and the polling resumes.
    map[`${API}/scan/status`] = { success: true, scan: { ...OK_SCAN, status: 'running', finished_at: null } };
    await click(page, '#at-scan');
    assert.strictEqual(await page.$('#at-banner-pollfail'), null);
    assert.ok(await page.$('#at-banner-scanning'));
    await close();
});

test('an HTML error page or a 403 on the status is a failed read too, and a good read in between resets the count', async () => {
    const running = { status: 200, body: { success: true, scan: { ...OK_SCAN, status: 'running', finished_at: null } } };
    const bad = { status: 502, body: '<html><body>Bad Gateway</body></html>' };
    const denied = { status: 403, body: 'Forbidden' };
    const done = { status: 200, body: { success: true, scan: OK_SCAN } };

    const flaky = await open();
    await fastPolling(flaky.page);
    // Four failures, one good read, four more: never five in a row.
    await script(flaky.page, '/scan/status', [bad, denied, bad, bad, running, bad, denied, bad, bad, done]);
    await click(flaky.page, '#at-scan');
    await flaky.page.waitForSelector('#at-banner-pollfail, .aegis-toast', { timeout: 6000 });
    assert.strictEqual(await flaky.page.$('#at-banner-pollfail'), null, 'the scan was followed to its end');
    assert.ok((await toasts(flaky.page)).some((t) => /Analyse terminée/.test(t)));
    await flaky.close();

    const down = await open();
    await fastPolling(down.page);
    await script(down.page, '/scan/status', [bad]);
    await click(down.page, '#at-scan');
    await down.page.waitForSelector('#at-banner-pollfail, .aegis-toast', { timeout: 6000 });
    assert.ok(await down.page.$('#at-banner-pollfail'));
    assert.deepStrictEqual((await toasts(down.page)).filter((t) => /Analyse terminée/.test(t)), []);
    await down.close();
});

test('a scan that ends on a model that cannot be shown announces nothing', async () => {
    const { page, close, map } = await open();
    await fastPolling(page);
    map[`${API}/model`] = { success: false, error: 'facts_schema' };
    await click(page, '#at-scan');
    await page.waitForSelector('#at-error-card', { timeout: 5000 });
    await pause(100);
    assert.deepStrictEqual((await toasts(page)).filter((t) => /Analyse terminée/.test(t)), []);
    await close();
});

test('when two model loads overlap, the answer of the latest one is shown', async () => {
    const { page, close } = await open();
    const named = (domain, delay) => ({ delay, body: { success: true, model: { ...fixture.model, scan: { ...fixture.model.scan, domain } } } });
    // The first request answers last.
    await script(page, `${API}/model`, [named('ancien.corp.local', 400), named('recent.corp.local', 0)]);
    await page.evaluate(() => { const app = window.AccountTiering.app; app.reloadModel(); app.reloadModel(); });
    await pause(700);
    assert.match(await text(page, '#at-meta'), /recent\.corp\.local/);
    await close();
});

test('two fast clicks send one request: correction save and removal, rules, settings', async () => {
    const { page, close, requests } = await open();
    await openCorrection(page);
    await page.type(REASON, 'Administratrice du domaine');
    await clickTwice(page, '[data-key="override-save"]');
    await settle(page);
    assert.strictEqual(sent(requests, 'PUT', '/overrides/').length, 1, 'save');

    await click(page, '[data-tierf="1"]');
    await click(page, `[data-account="${SID(2013)}"]`);
    await click(page, '[data-node^="a:"]');
    await clickTwice(page, '[data-act="override-remove"]');
    await settle(page);
    assert.strictEqual(sent(requests, 'DELETE', '/overrides/').length, 1, 'remove');

    await click(page, '#at-rules-open');
    await clickTwice(page, '#at-rules-save');
    await settle(page);
    assert.strictEqual(sent(requests, 'PUT', `${API}/rules`).length, 1, 'rules');

    await click(page, '#at-rules-open');
    await click(page, '#at-tab-scan');
    await clickTwice(page, '#at-set-save');
    await settle(page);
    assert.strictEqual(sent(requests, 'PUT', `${API}/settings`).length, 1, 'settings');
    assert.strictEqual(await count(page, '#at-rules-dialog'), 0, 'the dialog closed once the save was accepted');
    await close();
});

test('a refused save gives the button back', async () => {
    const { page, close, map, requests } = await open();
    await click(page, '#at-rules-open');
    map[`${API}/rules`] = { success: false, error: 'invalid_rules' };
    await click(page, '#at-rules-save');
    assert.match(await text(page, '#at-rules-error'), /Une règle est invalide/);
    assert.strictEqual(await page.$eval('#at-rules-save', (el) => el.disabled), false);
    map[`${API}/rules`] = { success: true, rules: fixture.rules };
    await click(page, '#at-rules-save');
    assert.strictEqual(sent(requests, 'PUT', `${API}/rules`).length, 2, 'the second try goes out');
    assert.strictEqual(await page.$('#at-rules-dialog'), null);
    await close();
});
