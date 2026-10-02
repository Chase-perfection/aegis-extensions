/**
 * What every browser test of the page shares: one Chrome and one static server
 * per test file, the stub map of the routes, and the small page helpers.
 *
 * Core's `openPage` answers every API call with status 200 and a JSON body read
 * from the stub map at request time, so a test changes an answer by assigning
 * to `map[...]` between two actions. What it cannot do is a real HTTP status,
 * a body that is not JSON, or two answers arriving out of order: `script()`
 * covers those by wrapping `fetch` inside the page.
 */
'use strict';

const assert = require('node:assert');

const harness = require('./harness');
const fixture = require('./fixtures/model.json');

const PAGE = '/pages/account-tiering.html';
const API = '/api/account-tiering';
const SID = (rid) => `S-1-5-21-1000-2000-3000-${rid}`;
const OK_SCAN = { id: 's1', started_at: '2026-09-30T08:10:00Z', finished_at: '2026-09-30T08:12:00Z', status: 'ok', error_code: null, domain: null };

let server;
let browser;

async function start() {
    server = await harness.serveFrontend();
    browser = await harness.launchBrowser();
}

async function stop() {
    if (browser) await browser.close();
    if (server) await server.close();
}

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

const loaded = (page) => page.waitForFunction(() => window.AccountTiering && window.AccountTiering.app
    && window.AccountTiering.app.state.loading === false, { timeout: 10000 });

/**
 * Opens the page at a desktop width and waits until the first load has settled.
 * `wait: false` skips that wait, for the tests whose subject is a load that
 * never settles.
 */
async function open(over, opts) {
    const map = stubs(over);
    const opened = await harness.openPage(browser, `${server.url}${PAGE}`, map);
    const requests = [];
    opened.page.on('request', (r) => requests.push({ method: r.method(), url: r.url(), body: r.postData() }));
    await opened.page.setViewport({ width: 1680, height: 1000 });
    if (!opts || opts.wait !== false) await loaded(opened.page);
    return { ...opened, requests, map };
}

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60))));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (page, sel) => page.$$eval(sel, (els) => els.length);
const text = (page, sel) => page.$eval(sel, (el) => el.textContent.trim());
const toasts = (page) => page.$$eval('.aegis-toast', (els) => els.map((e) => e.textContent.trim()));
/** What has focus, as "#id", "[data-key]" or the tag name: enough to tell a control from the body. */
const focused = (page) => page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    if (el.id) return '#' + el.id;
    return el.dataset && el.dataset.key ? `[${el.dataset.key}]` : el.tagName;
});

async function click(page, sel) {
    assert.ok(await page.$(sel), `${sel} exists`);
    await page.click(sel);
    await settle(page);
}

/**
 * Answers the requests whose URL contains `fragment` from a script, inside the
 * page: one step per request, the last step repeating. A step is
 * `{ status, body, delay }`; `body` is sent as is, so it can be HTML.
 * `onReload: true` installs it for the documents loaded from now on (the next
 * `page.reload()`), which is how a first load gets a real status.
 */
async function script(page, fragment, steps, opts) {
    const install = (frag, list) => {
        const real = window.fetch;
        let n = 0;
        window.fetch = (url, init) => {
            if (!String(url).includes(frag)) return real(url, init);
            const step = list[Math.min(n, list.length - 1)];
            n += 1;
            const body = typeof step.body === 'string' ? step.body : JSON.stringify(step.body);
            const answer = () => new Response(body, { status: step.status || 200 });
            return new Promise((resolve) => { setTimeout(() => resolve(answer()), step.delay || 0); });
        };
    };
    if (opts && opts.onReload) await page.evaluateOnNewDocument(install, fragment, steps);
    else await page.evaluate(install, fragment, steps);
}

module.exports = {
    available: harness.available, why: harness.why, fixture, PAGE, API, SID, OK_SCAN,
    start, stop, open, loaded, settle, pause, count, text, toasts, focused, click, script
};
