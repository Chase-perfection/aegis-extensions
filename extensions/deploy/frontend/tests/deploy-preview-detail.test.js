/**
 * Tier 3 -- a preview's own project page, reached the way an operator reaches
 * it, from the response shape the backend really sends.
 *
 * `GET /api/deploy/projects` lists projects only and nests each preview under
 * its parent's `previews` (extensions/deploy/backend/routes.js:707), because a
 * repository with six open branches would otherwise bury the site itself under
 * six cards that are all the same site. The page still addresses a preview by
 * id like any other project: Active branches on the overview and the domains
 * pane both link to `#project/<preview id>/overview`, and every project-scoped
 * route answers on a preview id because a preview is a project record
 * (`projectStore.getProject`). DEPLOY-CONTRACT.md says the page a preview opens
 * is the ordinary tabbed one minus Previews and Domains.
 *
 * So the fixture below sends exactly what the route sends -- one project at the
 * top level, its preview only underneath -- and the tests walk in from the
 * links the page draws rather than from a hash typed by the test. That is the
 * part this file is for: the lookup between a link and a record, which is what
 * the nesting decides. deploy-page.test.js covers the tab strip itself, and
 * puts its preview in the flat list in order to do so.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

// The harness is core's and stays there: these tests render the page inside
// core's shell, so they need core's frontend on disk. `harness.js` resolves it
// through AEGIS_TREE and says why when it cannot. Skipped rather than failed,
// and never silently: this file cannot run in CI, which has no Aegis checkout.
const harness = require('./harness');
if (!harness.available) {
  test('the Deploy preview detail view, inside the Aegis shell', { skip: harness.why }, () => {});
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

// What load() needs from /api/deploy/status before it calls loadProjects at
// all: the host opted in, and a GitHub App is connected (routes.js:469).
const STATUS_STUB = {
  success: true,
  enabled: true,
  detection: 'manual',
  github: { connected: true, slug: 'aegis-deploy' },
  capabilities: { projects: true, builds: true, runtimes: false }
};

/** Every field projectView() puts on a project or a preview (routes.js:650-696). */
function projectView(overrides) {
  return Object.assign({
    id: 'site-a',
    name: 'Site A',
    repoFullName: 'acme/site-a',
    branch: 'main',
    rootDir: null,
    installCmd: 'npm ci',
    buildCmd: 'npm run build',
    outputDir: 'dist',
    lastSha: 'abcdef1234567890',
    previousSha: null,
    deployedAt: Date.now() - 60000,
    lastError: null,
    failureCount: 0,
    history: [],
    port: 4001,
    url: 'http://127.0.0.1:4001/',
    serving: true,
    protected: false,
    allowedGroups: [],
    tls: {},
    envCount: 0,
    spaFallback: false,
    hostname: null,
    hostUrl: null,
    routerPort: 8080,
    releases: [],
    runtime: 'static',
    startCmd: null,
    running: null,
    parentId: null,
    previews: []
  }, overrides || {});
}

// The id and name a preview is really created with: `idFor(parent.id + ' ' +
// branch)` and `nameFor(parent, branch)` (routes.js:1171, previews.js:76).
const PREVIEW = projectView({
  id: 'site-a-feat-x',
  name: 'Site A · feat/x',
  branch: 'feat/x',
  port: 4002,
  url: 'http://127.0.0.1:4002/',
  parentId: 'site-a',
  previews: undefined
});

const PARENT = projectView({ previews: [PREVIEW] });

// One project at the top level, the preview only under it. This is the whole
// point of the fixture: `all.filter((p) => !p.parentId)` never puts a preview
// in the array the page keeps.
function stubs() {
  return {
    '/api/deploy/status': STATUS_STUB,
    '/api/deploy/projects': { success: true, projects: [PARENT] }
  };
}

function pageUrl(hash) {
  return server.url + '/pages/deploy.html#' + hash;
}

/**
 * Waits for the project list to have been fetched and painted.
 *
 * init() routes once before any request has answered, so the detail pane holds
 * the missing-project state until loadProjects repaints it. renderProjects()
 * runs first in that same handler and does not depend on what this file is
 * testing, so a card in the projects pane means the detail render below has
 * already happened -- whether it found its project or not.
 */
function waitForProjects(page) {
  return page.waitForFunction(
    () => !!document.querySelector('#deploy-projects .dep-card'),
    { timeout: 5000 }
  );
}

/** The detail pane's heading, and whether it is showing the missing state. */
function readDetail(page) {
  return page.evaluate(() => {
    const body = document.getElementById('deploy-detail-body');
    const empty = body.querySelector('.dep-empty');
    const heading = body.querySelector('h2.dep-subtitle');
    return {
      name: document.getElementById('deploy-detail-name').textContent.trim(),
      heading: heading ? heading.textContent.trim() : null,
      empty: empty ? empty.textContent.trim() : null,
      tabs: [...body.querySelectorAll('.dep-tab')].map((a) => a.textContent.trim())
    };
  });
}

const GONE = 'That project is not in the list. Reload the page.';

test('a preview id in the hash opens the preview, not the missing-project state', async () => {
  const { page, close } = await openPage(browser, pageUrl('project/site-a-feat-x/overview'), stubs());
  try {
    await waitForProjects(page);
    const detail = await readDetail(page);
    assert.strictEqual(detail.empty, null,
      'the preview is nested under its parent, and the page could not find it: ' + detail.empty);
    assert.strictEqual(detail.name, PREVIEW.name);
    assert.strictEqual(detail.heading, 'Preview deployment');
    // Data is there on a preview too: it writes its own folder, under its own
    // id, and reading what a branch wrote is most of why anyone deploys one.
    assert.deepStrictEqual(detail.tabs, ['Overview', 'Deployments', 'Variables', 'Data', 'Settings']);
  } finally {
    await close();
  }
});

test('the Open link on an Active branches row lands on the preview it names', async () => {
  const { page, close } = await openPage(browser, pageUrl('project/site-a/overview'), stubs());
  try {
    await waitForProjects(page);

    // The row the overview draws for each of the parent's previews. Clicking
    // the node rather than the pixel: the detail pane repaints under the
    // cursor, and the href is the whole of what this test is about anyway.
    const href = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#deploy-detail-body .dep-listrow')];
      const open = rows.map((r) => [...r.querySelectorAll('a')]
        .find((a) => a.textContent.trim() === 'Open')).find(Boolean);
      if (!open) throw new Error('no Open link in the Active branches list');
      const at = open.getAttribute('href');
      open.click();
      return at;
    });
    assert.strictEqual(href, '#project/site-a-feat-x/overview');

    await page.waitForFunction(
      () => window.location.hash === '#project/site-a-feat-x/overview',
      { timeout: 5000 }
    );
    const detail = await readDetail(page);
    assert.strictEqual(detail.empty, null, 'the Open link landed on: ' + detail.empty);
    assert.strictEqual(detail.name, PREVIEW.name);
  } finally {
    await close();
  }
});

test('the domains pane reaches a preview through the same link', async () => {
  const { page, close } = await openPage(browser, pageUrl('domains'), stubs());
  try {
    await waitForProjects(page);

    // The pane flattens the previews into its own list, so the preview has a
    // row of its own there, named and linked.
    const href = await page.evaluate((name) => {
      const link = [...document.querySelectorAll('#deploy-domains-pane .dep-listrow-name')]
        .find((a) => a.textContent.trim() === name);
      if (!link) throw new Error('no domains row for the preview');
      const at = link.getAttribute('href');
      link.click();
      return at;
    }, PREVIEW.name);
    assert.strictEqual(href, '#project/site-a-feat-x/overview');

    await page.waitForFunction(
      () => window.location.hash === '#project/site-a-feat-x/overview',
      { timeout: 5000 }
    );
    const detail = await readDetail(page);
    assert.strictEqual(detail.empty, null, 'the domains row landed on: ' + detail.empty);
    assert.strictEqual(detail.name, PREVIEW.name);
  } finally {
    await close();
  }
});

// Each tab a preview shows, mapped to the text of that panel's own first
// heading. The point is not the tab strip -- deploy-page.test.js pins that --
// but that the four panels a preview offers render on a preview record at all:
// until the lookup found one, none of them had ever been reached with the
// response shape the backend really sends.
const PREVIEW_PANELS = {
  overview: 'Preview deployment',
  deployments: 'Deployments',
  env: 'Environment variables',
  settings: 'Unknown paths'
};

test("every tab a preview offers renders its own panel, with nothing on the console", async () => {
  const { page, close, consoleErrors, pageErrors } = await openPage(
    browser, pageUrl('project/site-a-feat-x/overview'), stubs()
  );
  try {
    await waitForProjects(page);
    for (const id of Object.keys(PREVIEW_PANELS)) {
      await page.evaluate((tab) => { window.location.hash = '#project/site-a-feat-x/' + tab; }, id);
      await page.waitForFunction((wanted) => {
        const h = document.querySelector('#deploy-detail-body h2.dep-subtitle');
        return !!h && h.textContent.trim() === wanted;
      }, { timeout: 5000 }, PREVIEW_PANELS[id]);
    }
    assert.deepStrictEqual(consoleErrors, []);
    assert.deepStrictEqual(pageErrors, []);
  } finally {
    await close();
  }
});

test('an id that is neither a project nor a preview still says the project is missing', async () => {
  const { page, close } = await openPage(browser, pageUrl('project/site-b/overview'), stubs());
  try {
    await waitForProjects(page);
    const detail = await readDetail(page);
    assert.strictEqual(detail.empty, GONE);
    assert.strictEqual(detail.name, '');
    assert.deepStrictEqual(detail.tabs, []);
  } finally {
    await close();
  }
});
