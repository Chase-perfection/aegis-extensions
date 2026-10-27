/**
 * Tier 3 -- what a project card says when a push has to wait.
 *
 * Reported on KPI-BRICONORD- (27/10/2026): a push landed while the previous
 * version still served its visitors. The card's refusal line was appended to
 * the card itself, below its padded body, so it sat flush against the edge and
 * the rounded, clipped corner cut into it; and nothing told the operator that
 * the commit was waiting, then that it went live.
 *
 * - The refusal is written inside `.dep-card-body`, under the buttons.
 * - While the page is open, a commit that starts waiting is said in a toast,
 *   and so is a commit that goes live. The first load says nothing.
 *
 * The watch asks every 20 seconds, the period the backend polls branches at,
 * so the toast tests wait in real time. The stub map handed to `openPage` is
 * read per request: mutating it is how a push arrives here.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const harness = require('./harness');
if (!harness.available) {
  test('the Deploy card on a queued commit', { skip: harness.why }, () => {});
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

const OLD = 'aaaaaaa1111111111111111111111111111111111';
const NEW = 'bbbbbbb2222222222222222222222222222222222';

function project(over) {
  return Object.assign({
    id: 'kpi',
    name: 'KPI',
    repoFullName: 'acme/kpi',
    branch: 'aegis',
    lastSha: OLD,
    previousSha: null,
    deployedAt: Date.now() - 60000,
    lastError: null,
    failureCount: 0,
    pollGaveUp: false,
    history: [],
    port: 3081,
    url: 'http://127.0.0.1:3081/',
    serving: true,
    releases: [],
    runtime: 'node',
    running: null,
    draining: { sha: OLD, lastSeen: Date.now() },
    pendingSha: null,
    parentId: null,
    hasPreview: false,
    previews: []
  }, over || {});
}

function stubs(projects) {
  return {
    '/api/deploy/status': {
      success: true,
      enabled: true,
      detection: 'poll',
      github: { connected: true, appId: 123, slug: 'aegis-deploy-test' },
      capabilities: { projects: true, builds: true, runtimes: true }
    },
    '/api/deploy/projects': { success: true, projects: projects },
    '/api/deploy/github/installations': { success: true, installations: [] },
    '/api/deploy/runs': { success: true, runs: [] },
    // The card's buttons are usable by an administrator only.
    'auth/me': { loggedIn: true, tenant: 'test', userId: 1, email: 'admin@example.com', role: 'admin' }
  };
}

async function waitForCard(page) {
  await page.waitForSelector('#deploy-project-list .dep-card .dep-card-actions', { timeout: 15000 });
}

/** Text of every toast on screen, with its variant. */
function readToasts(page) {
  return page.evaluate(function () {
    return Array.prototype.map.call(document.querySelectorAll('.aegis-toast'), function (t) {
      return { text: t.textContent, cls: t.className };
    });
  });
}

async function waitForToast(page, needle, variant) {
  try {
    await page.waitForFunction(function (args) {
      return Array.prototype.some.call(document.querySelectorAll('.aegis-toast'), function (t) {
        return t.textContent.indexOf(args[0]) !== -1 && t.className.indexOf('aegis-toast--' + args[1]) !== -1;
      });
    }, { timeout: 30000, polling: 250 }, [needle, variant]);
  } catch (e) {
    assert.fail(`no ${variant} toast naming ${needle}; on screen: ` + JSON.stringify(await readToasts(page)));
  }
}

test('a refusal is written inside the card body, under its buttons', async () => {
  const map = stubs([project({})]);
  map['projects/kpi/redeploy'] = { success: false, error: 'queued' };
  const { page, close } = await openPage(browser, server.url + '/pages/deploy.html#projects', map);
  try {
    await waitForCard(page);
    await page.click('#deploy-project-list .dep-card .dep-card-actions button');
    await page.waitForSelector('#deploy-project-list .dep-card .dep-card-error', { timeout: 15000 });
    const where = await page.evaluate(function () {
      var card = document.querySelector('#deploy-project-list .dep-card');
      var line = card.querySelector('.dep-card-error');
      var body = card.querySelector('.dep-card-body');
      return {
        inBody: line.parentNode === body,
        last: body.lastElementChild === line,
        afterActions: !!(line.previousElementSibling && line.previousElementSibling.classList.contains('dep-card-actions')),
        text: line.textContent
      };
    });
    assert.strictEqual(where.inBody, true, 'the line belongs to the padded body, not to the card');
    assert.strictEqual(where.last, true, 'the line closes the body');
    assert.strictEqual(where.afterActions, true, 'the line sits under the buttons');
    assert.ok(where.text.length > 0, 'the line says something');
  } finally {
    await close();
  }
});

test('a commit that starts waiting, then goes live, is said once each', async () => {
  const map = stubs([project({})]);
  const { page, close } = await openPage(browser, server.url + '/pages/deploy.html#projects', map);
  try {
    await waitForCard(page);
    assert.deepStrictEqual(await readToasts(page), [], 'the first load has nothing to compare with');
    // A toast leaves after a few seconds: every one that appears is recorded,
    // so the count below does not depend on timing.
    await page.evaluate(function () {
      window.__toasts = [];
      new MutationObserver(function (records) {
        records.forEach(function (r) {
          Array.prototype.forEach.call(r.addedNodes, function (n) {
            if (n.classList && n.classList.contains('aegis-toast')) window.__toasts.push(n.className);
          });
        });
      }).observe(document.body, { childList: true, subtree: true });
    });

    // A push arrives while the previous version still serves its visitors.
    map['/api/deploy/projects'] = { success: true, projects: [project({ pendingSha: NEW })] };
    await waitForToast(page, NEW.slice(0, 7), 'info');

    // The previous version stops; the waiting commit is deployed.
    map['/api/deploy/projects'] = {
      success: true,
      projects: [project({ lastSha: NEW, pendingSha: null, draining: null })]
    };
    await waitForToast(page, NEW.slice(0, 7), 'success');

    const seen = await page.evaluate(function () { return window.__toasts; });
    assert.deepStrictEqual(seen.map((c) => /aegis-toast--(\w+)/.exec(c)[1]), ['info', 'success'],
      'each change is said once, not at every tick');
  } finally {
    await close();
  }
});
