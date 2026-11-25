/**
 * The Domains tab after Save, and the select chevron.
 *
 * Reported on screen (25/11/2026):
 *   - Save on a host name showed nothing: "Saved." went into a note that the
 *     redraw right after replaced, and the row under it still said "no name
 *     set", so it looked like nothing was stored;
 *   - the hint named one environment variable and nothing else, which left the
 *     operator without the steps that make the name answer;
 *   - a select's chevron vanished when the list opened and slid back over the
 *     label when it closed (`background` shorthand on focus, plus core's
 *     `transition: all` on every select).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const harness = require('./harness');
if (!harness.available) {
  test('the Deploy Domains tab', { skip: harness.why }, () => {});
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

const SHA = 'aaaaaaa1111111111111111111111111111111111';

function project(over) {
  return Object.assign({
    id: 'site', name: 'site', repoFullName: 'acme/site', branch: 'main',
    lastSha: SHA, previousSha: null, deployedAt: Date.now() - 60000,
    lastError: null, failureCount: 0, pollGaveUp: false, history: [],
    port: 3081, url: 'http://192.168.10.5:3081/', serving: true,
    releases: [], runtime: 'static', running: null, draining: null,
    pendingSha: null, parentId: null, hasPreview: false, previews: [],
    hostname: null, hostUrl: null, routerPort: null, notices: [], noticeDefaults: {}
  }, over || {});
}

function stubs(state) {
  return {
    '/api/deploy/status': {
      success: true, enabled: true, detection: 'poll',
      github: { connected: true, appId: 123, slug: 'aegis-deploy-test' },
      capabilities: { projects: true, builds: true, runtimes: true }
    },
    '/api/deploy/projects': () => ({ success: true, projects: [state.project] }),
    '/api/deploy/projects/site/settings': (req) => {
      const body = JSON.parse(req.body || '{}');
      state.project = project({ hostname: body.hostname || null });
      return { success: true, hostname: body.hostname || null };
    },
    '/api/deploy/github/installations': { success: true, installations: [] },
    '/api/deploy/runs': { success: true, runs: [] },
    'auth/me': { loggedIn: true, tenant: 'test', userId: 1, email: 'admin@example.com', role: 'admin' }
  };
}

test('Save on a host name says so, and lists what the name still needs', async () => {
  const state = { project: project() };
  const { page, close } = await openPage(browser, server.url + '/pages/deploy.html#project/site/domains', stubs(state));
  try {
    await page.waitForSelector('#deploy-view input[aria-label="Host name"]', { timeout: 15000 });
    await page.type('#deploy-view input[aria-label="Host name"]', 'reports.corp.local');
    await page.evaluate(function () {
      var b = Array.prototype.find.call(document.querySelectorAll('#deploy-view .dep-block .dep-btn'), function (x) { return x.textContent === 'Save'; });
      b.click();
    });
    await page.waitForSelector('.aegis-toast', { timeout: 15000 });
    await page.waitForSelector('#deploy-view .dep-hostname-steps', { timeout: 15000 });
    const seen = await page.evaluate(function () {
      return {
        toasts: Array.prototype.map.call(document.querySelectorAll('.aegis-toast'), function (t) { return t.textContent; }),
        steps: Array.prototype.map.call(document.querySelectorAll('#deploy-view .dep-hostname-steps li'), function (li) { return li.textContent; }),
        // The Domains tab's own rows: other panes of the page carry .dep-rows too.
        rows: document.querySelector('#deploy-view .dep-hostname-steps').parentNode.querySelector('.dep-rows').textContent
      };
    });
    assert.ok(seen.toasts.some((t) => t.indexOf('reports.corp.local') !== -1), 'a toast names the saved name: ' + JSON.stringify(seen.toasts));
    assert.strictEqual(seen.steps.length, 2, 'two steps: the shared listener and name resolution');
    assert.ok(seen.steps[0].indexOf('AEGIS_SITES_ROUTER_PORT') !== -1, 'step 1 says what to set');
    assert.ok(seen.steps[1].indexOf('192.168.10.5') !== -1, 'step 2 names this server address');
    assert.ok(seen.rows.indexOf('reports.corp.local') !== -1, 'the name row shows the saved name, not "no name set"');
  } finally {
    await close();
  }
});

test('a select keeps its chevron in place while it is open', async () => {
  const state = { project: project({ notices: [{ id: 'older-version', trigger: 'older-version', enabled: true, tone: 'warning', title: '', body: '', action: '' }] }) };
  const { page, close } = await openPage(browser, server.url + '/pages/deploy.html#project/site/settings', stubs(state));
  try {
    await page.waitForSelector('#deploy-view select.dep-select', { timeout: 15000 });
    const before = await page.$eval('#deploy-view select.dep-select', function (s) {
      var cs = getComputedStyle(s);
      return { image: cs.backgroundImage, position: cs.backgroundPositionX, transition: cs.transitionProperty };
    });
    await page.focus('#deploy-view select.dep-select');
    const focused = await page.$eval('#deploy-view select.dep-select', function (s) {
      var cs = getComputedStyle(s);
      return { image: cs.backgroundImage, position: cs.backgroundPositionX };
    });
    assert.ok(before.image.indexOf('svg') !== -1, 'the chevron is drawn');
    assert.strictEqual(focused.image, before.image, 'focus keeps the chevron');
    assert.strictEqual(focused.position, before.position, 'and keeps it where it was');
    assert.ok(!/\ball\b|background/.test(before.transition), 'the background is not animated: ' + before.transition);
  } finally {
    await close();
  }
});

// The status chip on the overview met its "Status" label edge to edge.
test('the overview status chip has air under its label', async () => {
  const state = { project: project() };
  const { page, close } = await openPage(browser, server.url + '/pages/deploy.html#project/site/overview', stubs(state));
  try {
    await page.waitForSelector('#deploy-view .dep-prod-fact > .ag-status', { timeout: 15000 });
    const gap = await page.$eval('#deploy-view .dep-prod-fact > .ag-status', function (chip) {
      var key = chip.parentNode.querySelector('.dep-meta-key');
      return chip.getBoundingClientRect().top - key.getBoundingClientRect().bottom;
    });
    assert.ok(gap >= 4, `gap between Status and its chip: ${gap}px`);
  } finally {
    await close();
  }
});
