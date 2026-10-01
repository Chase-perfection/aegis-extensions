/**
 * Tier 3: the "Arbre des comptes" page inside the Aegis shell, in a real
 * browser, against the model the real backend produced (fixtures/model.json).
 *
 * Covered: the three views, the matrix filter, the inverted tree, the no-rules
 * banner in both states, the remediation dialog and its POST, the rules dialog
 * and its inline 400, the manual correction, the empty and error cards, the
 * scan-running state, and the writing rules (no em dash, no raw key).
 *
 * Every assertion first checks that the element it measures exists, so a
 * renamed id fails the test instead of passing on an empty read.
 *
 * Not covered: pointer drag and wheel zoom gestures (the zoom buttons and fit
 * are driven instead), the clipboard, and the 2 s polling loop itself.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const harness = require('./harness');
if (!harness.available) {
    test('the Arbre des comptes page, inside the Aegis shell', { skip: harness.why }, () => {});
    return;
}
const { serveFrontend, launchBrowser, openPage } = harness;
const fixture = require('./fixtures/model.json');

const PAGE = '/pages/account-tiering.html';
const API = '/api/account-tiering';
const SID = (rid) => `S-1-5-21-1000-2000-3000-${rid}`;

let server;
let browser;

before(async () => {
    server = await serveFrontend();
    browser = await launchBrowser();
});

after(async () => {
    if (browser) await browser.close();
    if (server) await server.close();
});

const OK_SCAN = { id: 's1', started_at: '2026-09-30T08:10:00Z', finished_at: '2026-09-30T08:12:00Z', status: 'ok', error_code: null, domain: null };

function stubs(over) {
    return {
        [`${API}/model`]: { success: true, model: fixture.model },
        [`${API}/settings`]: { success: true, settings: fixture.settings },
        [`${API}/scan/status`]: { success: true, scan: OK_SCAN },
        [`${API}/rules`]: { success: true, rules: fixture.rules },
        [`${API}/remediations/`]: { success: true },
        [`${API}/overrides/`]: { success: true },
        ...over
    };
}

/** Opens the page at a desktop width and waits until the first load has settled. */
async function open(over) {
    const map = stubs(over);
    const opened = await openPage(browser, `${server.url}${PAGE}`, map);
    const requests = [];
    opened.page.on('request', (r) => requests.push({ method: r.method(), url: r.url(), body: r.postData() }));
    await opened.page.setViewport({ width: 1680, height: 1000 });
    await opened.page.waitForFunction(() => window.AccountTiering && window.AccountTiering.app
        && window.AccountTiering.app.state.loading === false, { timeout: 10000 });
    return { ...opened, requests, map };
}

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60))));
const count = (page, sel) => page.$$eval(sel, (els) => els.length);
const text = (page, sel) => page.$eval(sel, (el) => el.textContent.trim());

async function click(page, sel) {
    assert.ok(await page.$(sel), `${sel} exists`);
    await page.click(sel);
    await settle(page);
}

test('the tree renders the first account in gap: nodes, edges, and the "why" panel', async () => {
    const { page, close, pageErrors } = await open();
    assert.ok(await page.$('#at-layer'), 'the tree layer exists');
    const titles = await page.$$eval('.at-node .at-node-title', (els) => els.map((e) => e.textContent));
    assert.ok(titles.includes('Alice Martin'), titles.join(' | '));
    assert.ok(titles.includes('GG-IT-Admins'));
    assert.ok(titles.includes('Admins du domaine'));
    assert.ok(titles.includes('Tier 0 · domaine'));
    assert.ok(await count(page, '.at-edge') >= 4, 'account, group, mechanism, tier and the ghost are linked');
    assert.strictEqual(await count(page, '.at-edge.is-hl'), 3, 'the path to Tier 0 is highlighted, the ghost edge is not');
    assert.strictEqual(await text(page, '#at-panel-title'), 'Pourquoi Tier 0 ?');
    assert.strictEqual(await count(page, '#at-panel .at-chain .at-chip'), 3);
    assert.match(await text(page, '#at-meta'), /corp\.local/);
    assert.strictEqual(await page.$eval('.at-node[aria-pressed="true"]', (el) => el.dataset.node), 't:0');
    await close();
    assert.deepStrictEqual(pageErrors, []);
});

test('at 1680px the three columns sit side by side and the tree fits its stage', async () => {
    const { page, close } = await open();
    const box = await page.evaluate(() => {
        // toJSON: a DOMRect does not survive the trip out of the page as is.
        const r = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
        const nodes = [...document.querySelectorAll('.at-node')].map((n) => n.getBoundingClientRect());
        return { left: r('at-left'), centre: r('at-centre'), panel: r('at-panel'), stage: r('at-stage'), nodes: nodes.map((n) => ({ l: n.left, r: n.right, t: n.top, b: n.bottom })), scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth };
    });
    assert.ok(box.left.right <= box.centre.left + 1 && box.centre.right <= box.panel.left + 1, 'left, centre, panel in a row');
    assert.strictEqual(Math.round(box.left.width), 320);
    assert.strictEqual(Math.round(box.panel.width), 380);
    assert.ok(box.stage.height > 400, `the stage has a real height (${box.stage.height})`);
    assert.ok(box.nodes.length > 0);
    for (const n of box.nodes) assert.ok(n.l >= box.stage.left && n.r <= box.stage.right && n.t >= box.stage.top && n.b <= box.stage.bottom, 'every node is inside the stage after the fit');
    assert.ok(box.scrollW <= box.innerW, 'no horizontal overflow');
    await close();
});

test('below 1280px the panel drops under the tree', async () => {
    const { page, close } = await open();
    await page.setViewport({ width: 1100, height: 900 });
    await settle(page);
    const box = await page.evaluate(() => {
        const r = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
        return { centre: r('at-centre'), panel: r('at-panel') };
    });
    assert.ok(box.panel.top >= box.centre.bottom - 1, 'the panel is under the centre');
    assert.strictEqual(Math.round(box.centre.height), 640);
    assert.ok(box.panel.height > 300, `the panel has its full height, not a clamped strip (${box.panel.height})`);
    assert.strictEqual(Math.round(box.panel.left), Math.round(box.centre.left), 'and it is aligned with the centre column');
    await close();
});

test('Liste shows one row per path, Vue d\'ensemble shows the figures and the matrix', async () => {
    const { page, close, pageErrors } = await open();
    await click(page, '[data-viewbtn="list"]');
    assert.strictEqual(await count(page, '#at-list .at-lrow'), 1, 'Alice has one path');
    assert.match(await text(page, '#at-list .at-lrow'), /GG-IT-Admins/);
    await click(page, '[data-viewbtn="overview"]');
    const kpis = await page.$$eval('.at-kpi', (els) => els.map((e) => [e.dataset.kpi, e.querySelector('.at-kpi-value').textContent]));
    assert.deepStrictEqual(kpis, [['accounts', '15'], ['gaps', '9'], ['t0', '6'], ['points', '13']]);
    const cells = await page.$$eval('.at-mx-cell', (els) => els.map((e) => e.querySelector('.at-mx-count').textContent));
    assert.deepStrictEqual(cells, ['1', '0', '1', '0', '2', '0', '6', '3', '422']);
    assert.strictEqual(await count(page, '#at-points .at-point'), 6, 'the top six points');
    assert.strictEqual(await count(page, '#at-layer'), 0, 'the tree is gone in the overview');
    await close();
    assert.deepStrictEqual(pageErrors, []);
});

test('clicking a matrix cell filters the left list to that cell', async () => {
    const { page, close } = await open();
    const before = await count(page, '#at-left-dyn .at-arow');
    await click(page, '[data-viewbtn="overview"]');
    await click(page, '[data-cell="2-0"]');
    assert.ok(await page.$('#at-cellchip'), 'the filter chip shows');
    const rows = await page.$$eval('#at-left-dyn .at-arow', (els) => els.map((e) => e.dataset.account));
    assert.strictEqual(rows.length, 6);
    assert.notStrictEqual(rows.length, before, 'the list changed');
    assert.ok(rows.includes(SID(2001)) && !rows.includes(SID(2002)), 'gaps to Tier 0 only, not the legitimate admin');
    assert.strictEqual(await page.$eval('[data-cell="2-0"]', (el) => el.getAttribute('aria-pressed')), 'true');
    await click(page, '#at-cell-clear');
    assert.strictEqual(await page.$('#at-cellchip'), null);
    await close();
});

test('the inverted tree opens on Tier 0 with every account that reaches it', async () => {
    const { page, close } = await open();
    await click(page, '#at-inverse');
    const heads = await page.$$eval('.at-colhead', (els) => els.map((e) => e.textContent));
    assert.deepStrictEqual(heads, ['Comptes', 'Groupes', 'Mécanismes', 'Cible']);
    assert.strictEqual(await text(page, '#at-panel-title'), 'Qui atteint le Tier 0 ?');
    assert.strictEqual(await count(page, '.at-node[data-node^="a:"]'), 7, 'seven accounts are Tier 0');
    assert.strictEqual(await count(page, '#at-panel .at-prow'), 7);
    assert.match(await text(page, '#at-inverse'), /Retour au compte/);
    // A chokepoint opens the same tree on its own node.
    await click(page, '[data-viewbtn="overview"]');
    await click(page, '#at-points .at-point:nth-child(2)');
    assert.ok(await page.$('#at-layer'), 'back on the tree');
    assert.strictEqual(await page.$eval('.at-node[aria-pressed="true"]', (el) => el.dataset.node), `g:${SID(512)}`);
    assert.strictEqual(await page.$eval('#at-ecart', (el) => el.checked), true, 'a point opens on the gaps only');
    await close();
});

test('an account with more than eight groups folds them, and unfolds on click', async () => {
    const { page, close } = await open();
    assert.strictEqual(await page.$(`[data-account="${SID(2007)}"]`), null, 'only the first three gaps show at first');
    await click(page, '#at-more');
    await click(page, `[data-account="${SID(2007)}"]`);
    assert.strictEqual(await count(page, '.at-node[data-node^="g:"]'), 7);
    assert.ok(await page.$('[data-node="cl:g"]'), 'the fold node');
    assert.ok(await page.$('[data-node="ghost"]'), 'the unprivileged groups node');
    await click(page, '[data-node="cl:g"]');
    assert.strictEqual(await count(page, '.at-node[data-node^="g:"]'), 10);
    assert.ok(await page.$('[data-node="fold"]'));
    await page.click('#at-ghost');
    await settle(page);
    assert.strictEqual(await page.$('[data-node="ghost"]'), null, 'Masquer non-privilégiés removes the ghost');
    await close();
});

test('zoom buttons change the zoom label, and fit restores it', async () => {
    const { page, close } = await open();
    // The 980px stage is narrower than the 1120px tree, so the fit lands on 85 %.
    assert.strictEqual(await text(page, '#at-zoom-label'), '85 %');
    await click(page, '#at-zoom-in');
    assert.strictEqual(await text(page, '#at-zoom-label'), '100 %', 'steps snap to tenths: 0.85 + 0.1 rounds to 1.0');
    assert.match(await page.$eval('#at-layer', (el) => el.style.transform), /scale\(1\)/);
    await click(page, '#at-zoom-out');
    assert.strictEqual(await text(page, '#at-zoom-label'), '90 %');
    await click(page, '#at-fit');
    assert.strictEqual(await text(page, '#at-zoom-label'), '85 %');
    // The mini-map recentres on a pointer click.
    const before = await page.$eval('#at-layer', (el) => el.style.transform);
    await page.mouse.click(...(await page.$eval('#at-mini', (el) => { const r = el.getBoundingClientRect(); return [r.left + 150, r.top + 100]; })));
    assert.notStrictEqual(await page.$eval('#at-layer', (el) => el.style.transform), before);
    assert.strictEqual(await page.$eval('#at-zoom-label', (el) => el.getAttribute('aria-live')), 'polite');
    await close();
});

test('the no-rules banner shows when rulesCount is 0, opens the rules dialog, and is absent otherwise', async () => {
    const withRules = await open();
    assert.strictEqual(await withRules.page.$('#at-banner-norules'), null);
    assert.ok(await withRules.page.$('#at-banner-unreadable'), 'the unreadable notice shows for the fixture');
    await withRules.close();

    const none = await open({ [`${API}/model`]: { success: true, model: { ...fixture.model, rulesCount: 0 } }, [`${API}/rules`]: { success: true, rules: [] } });
    assert.match(await text(none.page, '#at-banner-norules'), /Aucune règle de tiering : tous les comptes sont considérés Tier 2/);
    await click(none.page, '#at-banner-norules [data-act="rules-open"]');
    assert.ok(await none.page.$('#at-rules-dialog[role="dialog"][aria-modal="true"]'));
    await none.page.keyboard.press('Escape');
    await settle(none.page);
    assert.strictEqual(await none.page.$('#at-rules-dialog'), null, 'Escape closes the dialog');
    await none.close();
});

test('the remediation dialog lists the steps and its confirm POSTs the marker', async () => {
    const { page, close, requests } = await open();
    await click(page, '#at-fix-open');
    assert.ok(await page.$('#at-fix-dialog[role="dialog"][aria-modal="true"]'));
    const cmds = await page.$$eval('#at-fix-dialog .at-code-text', (els) => els.map((e) => e.textContent));
    assert.deepStrictEqual(cmds, ["Remove-ADGroupMember -Identity 'GG-IT-Admins' -Members 'a.martin'", "Remove-ADGroupMember -Identity 'Admins du domaine' -Members 'GG-IT-Admins'"]);
    assert.ok(await page.evaluate(() => document.getElementById('at-fix-dialog').contains(document.activeElement)), 'focus moved into the dialog');
    await click(page, '#at-fix-confirm');
    const post = requests.find((r) => r.method === 'POST' && r.url.includes(`${API}/remediations/`));
    assert.ok(post, 'a POST went to /remediations/:sid');
    assert.ok(post.url.endsWith(`${API}/remediations/${SID(2001)}`), post.url);
    assert.strictEqual(await page.$('#at-fix-dialog'), null, 'the dialog closed');
    // The badge is read from the model, not kept in the page.
    await click(page, '[data-tierf="0"]');
    await click(page, '#at-more');
    await click(page, `[data-account="${SID(2014)}"]`);
    assert.match(await text(page, '#at-fix-badge'), /Remédiation proposée/);
    assert.strictEqual(await page.$('#at-fix-open'), null);
    await close();
});

test('the rules dialog edits the ordered list, sends it, and shows invalid_rules inline', async () => {
    const { page, close, requests, map } = await open();
    await click(page, '#at-rules-open');
    assert.strictEqual(await count(page, '#at-rule-rows .at-rule'), 3);
    await click(page, '#at-rule-add');
    assert.strictEqual(await count(page, '#at-rule-rows .at-rule'), 4);
    await page.type('[data-key="rule-pattern:3"]', '*-adm');
    await click(page, '[data-key="rule-up:3"]');
    await click(page, '[data-key="rule-del:0"]');
    map[`${API}/rules`] = { success: false, error: 'invalid_rules' };
    await click(page, '#at-rules-save');
    const put = requests.find((r) => r.method === 'PUT' && r.url.endsWith(`${API}/rules`));
    assert.ok(put, 'a PUT went to /rules');
    assert.deepStrictEqual(JSON.parse(put.body).rules, [
        { kind: 'ou', pattern: 'OU=Admins-T1,DC=corp,DC=local', tier: 1 },
        { kind: 'ou', pattern: '*-adm', tier: 0 },
        { kind: 'name', pattern: 'gmsa-*', tier: 2 }
    ]);
    assert.match(await text(page, '#at-rules-error'), /Une règle est invalide/);
    assert.ok(await page.$('#at-rules-dialog'), 'the dialog stays open on a refusal');
    // The scan settings always go out as both fields.
    map[`${API}/settings`] = { success: true, settings: { domain: 'lab.corp.local', passes: 4 } };
    await click(page, '#at-tab-scan');
    await page.type('#at-set-domain', 'lab.corp.local');
    await page.$eval('#at-set-passes', (el) => { el.value = '4'; });
    await click(page, '#at-set-save');
    const putSet = requests.find((r) => r.method === 'PUT' && r.url.endsWith(`${API}/settings`));
    assert.deepStrictEqual(JSON.parse(putSet.body), { domain: 'lab.corp.local', passes: 4 });
    await close();
});

test('the manual correction needs a reason, then PUTs the override; an override can be removed', async () => {
    const { page, close, requests } = await open();
    await click(page, '[data-node^="a:"]');
    assert.match(await text(page, '#at-planned-source'), /Tier 2 par défaut/);
    assert.strictEqual(await page.$('#at-override-shown'), null, 'no correction on this account, so no reason to show');
    await click(page, '[data-act="override-open"]');
    await click(page, '[data-key="override-save"]');
    assert.match(await text(page, '#at-override-error'), /motif/);
    assert.ok(!requests.some((r) => r.method === 'PUT' && r.url.includes('/overrides/')), 'nothing is sent without a reason');
    await page.select('#at-override-tier', '0');
    await page.type('#at-override-reason', 'Administratrice du domaine');
    await click(page, '[data-key="override-save"]');
    const put = requests.find((r) => r.method === 'PUT' && r.url.includes('/overrides/'));
    assert.ok(put && put.url.endsWith(`/overrides/${SID(2001)}`));
    assert.deepStrictEqual(JSON.parse(put.body), { tier: 0, reason: 'Administratrice du domaine' });
    await click(page, '[data-tierf="1"]');
    await click(page, `[data-account="${SID(2013)}"]`);
    await click(page, '[data-node^="a:"]');
    assert.strictEqual(await text(page, '#at-planned-source'), 'Correction manuelle');
    // Why, by whom and when: read from the model, the date through the page's own helper.
    assert.strictEqual(await text(page, '#at-override-why'), 'Opératrice serveurs, validé par le RSSI');
    const when = await page.evaluate(() => window.AccountTiering.ui.dateText('2026-09-29T11:00:00Z'));
    assert.match(when, /^29\/09\/2026 à \d{2}:\d{2}$/);
    assert.strictEqual(await text(page, '#at-override-meta'), `Corrigé par admin@corp.local, le ${when}`);
    assert.ok(await page.$('#at-planned #at-override-shown'), 'inside the planned-tier block');
    await click(page, '[data-act="override-remove"]');
    assert.ok(requests.some((r) => r.method === 'DELETE' && r.url.endsWith(`/overrides/${SID(2013)}`)));
    await close();
});

test('the reason of a correction renders as text, and a correction with no author still reads', async () => {
    const model = JSON.parse(JSON.stringify(fixture.model));
    const acc = model.accounts.find((a) => a.sid === SID(2013));
    assert.ok(acc && acc.override, 'the fixture carries the override details');
    const openOn = async (override) => {
        acc.override = override;
        const opened = await open({ [`${API}/model`]: { success: true, model } });
        await click(opened.page, '[data-tierf="1"]');
        await click(opened.page, `[data-account="${SID(2013)}"]`);
        await click(opened.page, '[data-node^="a:"]');
        return opened;
    };
    const hostile = await openOn({ reason: '<b id="at-xss">gras</b>', setBy: null, setAt: '2026-09-29T11:00:00Z' });
    assert.strictEqual(await hostile.page.$('#at-xss'), null, 'the reason is not parsed as markup');
    assert.strictEqual(await text(hostile.page, '#at-override-why'), '<b id="at-xss">gras</b>');
    assert.match(await text(hostile.page, '#at-override-meta'), /^Corrigé le 29\/09\/2026 à \d{2}:\d{2}$/);
    await hostile.close();
    assert.deepStrictEqual(hostile.pageErrors, []);

    // An unreadable date leaves a whole sentence, not "le" with nothing after.
    const undated = await openOn({ reason: 'Validé', setBy: 'admin@corp.local', setAt: 'hier' });
    assert.strictEqual(await text(undated.page, '#at-override-meta'), 'Corrigé par admin@corp.local');
    await undated.close();
});

test('no scan yet: the empty card invites to run the first analysis', async () => {
    const { page, close, requests, pageErrors } = await open({
        [`${API}/model`]: { success: false, error: 'no_scan_yet' }, [`${API}/scan/status`]: { success: true, scan: null }
    });
    assert.match(await text(page, '#at-empty-noscan'), /Lancez une analyse/);
    assert.strictEqual(await page.$eval('#at-body', (el) => el.hidden), true);
    assert.strictEqual(await page.$eval('#at-export-wrap', (el) => el.hidden), true, 'nothing to export');
    await click(page, '#at-empty-noscan [data-act="scan"]');
    assert.ok(requests.some((r) => r.method === 'POST' && r.url.endsWith(`${API}/scan`)));
    assert.match(await text(page, '#at-scan'), /Analyse en cours/);
    assert.strictEqual(await page.$eval('#at-scan', (el) => el.disabled), true);
    await close();
    assert.deepStrictEqual(pageErrors, []);
});

test('an error code from the backend shows translated in the error card', async () => {
    for (const [code, expected] of [['store_unavailable', /stockage aux extensions/], ['facts_schema', /format/]]) {
        const { page, close } = await open({ [`${API}/model`]: { success: false, error: code } });
        assert.strictEqual(await page.$eval('#at-error-card', (el) => el.dataset.code), code);
        assert.match(await text(page, '#at-error-card'), expected);
        await close();
    }
    const net = await open({ [`${API}/model`]: null });
    assert.strictEqual(await net.page.$eval('#at-error-card', (el) => el.dataset.code), 'network');
    await net.close();
});

test('a running scan disables the button; a failed one shows its translated code; a truncated one says so', async () => {
    const running = await open({ [`${API}/scan/status`]: { success: true, scan: { ...OK_SCAN, status: 'running', finished_at: null } } });
    assert.strictEqual(await running.page.$eval('#at-scan', (el) => el.disabled), true);
    assert.ok(await running.page.$('#at-banner-scanning'));
    await running.close();

    const failed = await open({
        [`${API}/scan/status`]: { success: true, scan: { ...OK_SCAN, status: 'failed', error_code: 'collector_blocked' } },
        [`${API}/model`]: { success: true, model: { ...fixture.model, scan: { ...fixture.model.scan, truncated: true } } }
    });
    assert.match(await text(failed.page, '#at-banner-scanfail'), /antivirus a bloqué/);
    assert.match(await text(failed.page, '#at-banner-truncated'), /Chaîne tronquée à 3 niveaux/);
    await failed.close();
});

test('exports are plain links to the two routes', async () => {
    const { page, close } = await open();
    await click(page, '#at-export');
    assert.strictEqual(await page.$eval('#at-export', (el) => el.getAttribute('aria-expanded')), 'true');
    assert.ok((await page.$eval('#at-export-csv', (el) => el.href)).endsWith(`/t/test${API}/export.csv`));
    assert.ok((await page.$eval('#at-export-json', (el) => el.href)).endsWith(`/t/test${API}/export.json`));
    await close();
});

test('no em dash, no raw translation key and no unescaped name anywhere in the page', async () => {
    const { page, close } = await open();
    const seen = [];
    const grab = async () => seen.push(await page.$eval('#at-view', (el) => el.innerText + ' ' + [...el.querySelectorAll('[aria-label],[title],[placeholder]')].map((e) => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('placeholder')].join(' ')).join(' ')));
    await grab();
    await click(page, '#at-fix-open');
    await grab();
    await page.keyboard.press('Escape');
    await click(page, '#at-rules-open');
    await grab();
    await page.keyboard.press('Escape');
    await click(page, '[data-viewbtn="list"]');
    await grab();
    await click(page, '#at-inverse');
    await grab();
    await click(page, '[data-viewbtn="overview"]');
    await grab();
    const all = seen.join('\n');
    assert.ok(all.length > 2000, 'the views were actually read');
    assert.ok(!all.includes('—'), 'no em dash');
    assert.ok(!/\bat_[a-z0-9_]+\b/.test(all), 'no raw at_ key');
    assert.ok(!/\{[a-z]+\}/.test(all), 'no unfilled parameter');
    // An AD name with an apostrophe renders as text, not as markup.
    await click(page, '[data-tierf="0"]');
    await click(page, '#at-more');
    assert.ok((await page.$eval('#at-left-dyn', (el) => el.innerText)).includes("Xavier O'Garnier"));
    await close();
});
