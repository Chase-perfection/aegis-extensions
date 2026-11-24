/**
 * The Audience tab of a project, and its switch on the Settings tab
 * (src/js/deploy-audience.js), rendered inside the Aegis shell.
 *
 * The network is stubbed by core's helpers/browser.js. The report below has
 * the shape audienceStore.report answers (backend/audienceStore.js), and a
 * component name that is markup, which must reach the screen as text.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const harness = require('./harness');
if (!harness.available) {
  test('the Deploy Audience tab, inside the Aegis shell', { skip: harness.why }, () => {});
  return;
}
const { serveFrontend, launchBrowser, openPage } = harness;

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

const STATUS = {
  success: true, enabled: true, detection: 'manual',
  github: { connected: true, slug: 'aegis-deploy' },
  capabilities: { projects: true, builds: true, runtimes: false }
};
const ME_ADMIN = { loggedIn: true, tenant: 'test', userId: 1, email: 'admin@example.com', role: 'admin' };
const ME_VIEWER = Object.assign({}, ME_ADMIN, { role: 'viewer' });

function project(enabled) {
  return {
    id: 'site-a', name: 'Site A', repoFullName: 'acme/site-a', branch: 'main', rootDir: null,
    installCmd: null, buildCmd: null, outputDir: null, lastSha: 'abcdef1234567890', previousSha: null,
    deployedAt: Date.now() - 60000, lastError: null, failureCount: 0, history: [], port: 4001,
    url: 'http://127.0.0.1:4001/', serving: true, protected: false, allowedGroups: [], tls: {},
    envCount: 0, spaFallback: false, hostname: null, hostUrl: null, routerPort: 8080, releases: [],
    runtime: 'static', startCmd: null, running: null, parentId: null, previews: [],
    notices: { inject: true, items: [] }, audience: { enabled }
  };
}

function report(precision) {
  return {
    success: true, enabled: true, from: '2026-10-26', to: '2026-11-24', visitorsPrecision: precision || 'day',
    totals: { visitors: 77, visits: 310, activeMs: 41000000, avgVisitMs: 132000 },
    series: [
      { day: '2026-11-22', visitors: 12, visits: 15, activeMs: 1900000 },
      { day: '2026-11-23', visitors: 0, visits: 0, activeMs: 0 },
      { day: '2026-11-24', visitors: 30, visits: 40, activeMs: 3000000 }
    ],
    pages: [
      { path: '/stock', views: 900, visitors: 60, activeMs: 30000000 },
      { path: '/', views: 410, visitors: 71, activeMs: 4920000 }
    ],
    components: [
      { path: '/stock', name: 'button: Actualiser', clicks: 640, visitors: 51 },
      { path: '/', name: 'button: <img src=x onerror="window.__xss=1">', clicks: 12, visitors: 3 },
      { path: '/__aegis/login', name: 'aegis: Connexion', clicks: 77, visitors: 77 }
    ]
  };
}

function stubs(enabled, me, extra) {
  return Object.assign({
    '/api/deploy/status': STATUS,
    '/api/deploy/projects': { success: true, projects: [project(enabled)] },
    '/api/deploy/projects/site-a/audience': report(),
    '/auth/me': me || ME_ADMIN
  }, extra || {});
}

function url(hash) { return server.url + '/pages/deploy.html#' + hash; }

async function waitFor(page, fn) {
  await page.waitForFunction(fn, { timeout: 5000 });
}

test('the Audience tab sits after Overview', async () => {
  const { page, close } = await openPage(browser, url('project/site-a/overview'), stubs(true));
  try {
    const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('#deploy-detail-body .dep-tab')).map((a) => a.getAttribute('href')));
    assert.strictEqual(tabs[0], '#project/site-a/overview');
    assert.strictEqual(tabs[1], '#project/site-a/audience');
  } finally { await close(); }
});

test('audience off shows the link to Settings', async () => {
  const { page, close } = await openPage(browser, url('project/site-a/audience'), stubs(false));
  try {
    await waitFor(page, () => document.querySelector('.dep-aud-off a'));
    const href = await page.$eval('.dep-aud-off a', (a) => a.getAttribute('href'));
    assert.strictEqual(href, '#project/site-a/settings');
  } finally { await close(); }
});

test('KPIs read the totals of the stubbed report', async () => {
  const { page, close, pageErrors } = await openPage(browser, url('project/site-a/audience'), stubs(true));
  try {
    await waitFor(page, () => document.querySelectorAll('.dep-aud-kpi dd').length === 4);
    const values = await page.$$eval('.dep-aud-kpi dd', (n) => n.map((d) => d.textContent.trim()));
    assert.strictEqual(values[0], '77');
    assert.strictEqual(values[1], '310');
    assert.strictEqual(values[2], '2 min 12 s');
    assert.strictEqual(values[3], '11 h 23 min');
    const bars = await page.$$eval('.dep-aud-chart rect', (n) => n.length);
    assert.strictEqual(bars, 3);
    assert.deepStrictEqual(pageErrors, []);
  } finally { await close(); }
});

test('a component name with <img onerror> is shown as text', async () => {
  const { page, close } = await openPage(browser, url('project/site-a/audience'), stubs(true));
  try {
    await waitFor(page, () => document.querySelectorAll('.dep-aud-components tbody tr').length === 3);
    const shown = await page.$$eval('.dep-aud-components tbody tr td:first-child', (n) => n.map((d) => d.textContent));
    assert.ok(shown.some((t) => t.includes('<img src=x')));
    assert.strictEqual(await page.evaluate(() => window.__xss), undefined);
    assert.strictEqual(await page.$('.dep-aud-components img'), null);
  } finally { await close(); }
});

test('clicking a page filters the components, clicking again shows them all', async () => {
  const { page, close } = await openPage(browser, url('project/site-a/audience'), stubs(true));
  try {
    await waitFor(page, () => document.querySelectorAll('.dep-aud-pages tbody button').length === 2);
    await page.click('.dep-aud-pages tbody tr:first-child button');
    let rows = await page.$$eval('.dep-aud-components tbody tr', (n) => n.length);
    assert.strictEqual(rows, 1);
    assert.strictEqual(await page.$eval('.dep-aud-pages tbody tr:first-child button', (b) => b.getAttribute('aria-pressed')), 'true');
    await page.click('.dep-aud-pages tbody tr:first-child button');
    rows = await page.$$eval('.dep-aud-components tbody tr', (n) => n.length);
    assert.strictEqual(rows, 3);
  } finally { await close(); }
});

test('the estimate note shows past 90 days, and the period asks the right range', async () => {
  const asked = [];
  const { page, close } = await openPage(browser, url('project/site-a/audience'), stubs(true, ME_ADMIN, {
    '/api/deploy/projects/site-a/audience': (r) => { asked.push(r.url); return report(r.url.includes('from=') && asked.length > 1 ? 'estimate' : 'day'); }
  }));
  try {
    await waitFor(page, () => document.querySelectorAll('.dep-aud-kpi dd').length === 4);
    assert.strictEqual(await page.$('.dep-aud-estimate'), null);
    await page.click('.dep-aud-periods button[data-days="365"]');
    await waitFor(page, () => document.querySelector('.dep-aud-estimate'));
    const last = new URL(asked[asked.length - 1]);
    const from = new Date(last.searchParams.get('from'));
    const to = new Date(last.searchParams.get('to'));
    assert.strictEqual(Math.round((to - from) / 86400000), 364);
  } finally { await close(); }
});

test('the switch is disabled for a non-admin', async () => {
  const { page, close } = await openPage(browser, url('project/site-a/settings'), stubs(true, ME_VIEWER));
  try {
    await waitFor(page, () => document.querySelector('.dep-aud-section input[type=checkbox]'));
    assert.strictEqual(await page.$eval('.dep-aud-section input[type=checkbox]', (i) => i.disabled), true);
  } finally { await close(); }
});

test('the switch saves { audience: { enabled } } on the settings route', async () => {
  const posted = [];
  const { page, close } = await openPage(browser, url('project/site-a/settings'), stubs(false, ME_ADMIN, {
    '/api/deploy/projects/site-a/settings': (r) => { posted.push(r.body); return { success: true, audience: { enabled: true } }; }
  }));
  try {
    await waitFor(page, () => {
      const i = document.querySelector('.dep-aud-section input[type=checkbox]');
      return i && !i.disabled;
    });
    await page.click('.dep-aud-section input[type=checkbox]');
    await waitFor(page, () => document.querySelector('.dep-aud-section .dep-note:not([hidden])'));
    assert.deepStrictEqual(JSON.parse(posted[0]), { audience: { enabled: true } });
  } finally { await close(); }
});

test('erase asks first, then calls DELETE', async () => {
  const calls = [];
  const { page, close } = await openPage(browser, url('project/site-a/settings'), stubs(true, ME_ADMIN, {
    '/api/deploy/projects/site-a/audience': (r) => { calls.push(r.method); return { success: true }; }
  }));
  try {
    await waitFor(page, () => {
      const b = document.querySelector('.dep-aud-erase');
      return b && !b.disabled;
    });
    let asked = '';
    page.once('dialog', async (d) => { asked = d.message(); await d.dismiss(); });
    await page.click('.dep-aud-erase');
    assert.ok(asked.includes('Site A'), asked);
    assert.deepStrictEqual(calls, []);
    page.once('dialog', (d) => d.accept());
    await page.click('.dep-aud-erase');
    await waitFor(page, () => document.querySelector('.dep-aud-section .dep-note:not([hidden])'));
    assert.deepStrictEqual(calls, ['DELETE']);
  } finally { await close(); }
});

test('no element on the tab has an animation or transition', async () => {
  const { page, close } = await openPage(browser, url('project/site-a/audience'), stubs(true));
  try {
    await waitFor(page, () => document.querySelectorAll('.dep-aud-kpi dd').length === 4);
    const moving = await page.evaluate(() => Array.from(document.querySelectorAll('.dep-aud *')).filter((n) => {
      const s = getComputedStyle(n);
      return (s.animationName && s.animationName !== 'none') || parseFloat(s.transitionDuration) > 0;
    }).map((n) => n.className));
    assert.deepStrictEqual(moving, []);
  } finally { await close(); }
});
