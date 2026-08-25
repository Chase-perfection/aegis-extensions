/**
 * Tier 3 -- the Deploy extension's project detail view: the tab strip driven
 * by PROJECT_TABS, the preview exclusion rule, each tab's own panel, the
 * unknown-tab fallback, and the shared metaRow() row builder.
 *
 * extensions/deploy/frontend/src/js/deploy.js had zero test coverage before
 * this file, and four refactors landed in it verified only by agents reading
 * diffs. The one this suite is built to catch is a PROJECT_TABS entry whose
 * `render` field points at the wrong function: a reviewer reading the array
 * cannot rule that out, a panel that is actually opened can.
 *
 * The network is stubbed by helpers/browser.js, so this needs no backend and
 * no database. The project fixtures below carry every field
 * extensions/deploy/backend/routes.js's projectView() puts on a project
 * (routes.js:650-696), not an invented shape.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

// The harness is core's and stays there: these tests render the page inside
// core's shell, so they need core's frontend on disk. `harness.js` resolves it
// through AEGIS_TREE and says why when it cannot. Skipped rather than failed,
// and never silently: this file cannot run in CI, which has no Aegis checkout.
const harness = require('./harness');
if (!harness.available) {
  test('the Deploy project detail view, inside the Aegis shell', { skip: harness.why }, () => {});
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

// What load() in deploy.js needs from /api/deploy/status before it will call
// loadProjects() at all: the host opted in, and a GitHub App is connected.
// See extensions/deploy/backend/routes.js:469 for the real response shape.
const STATUS_STUB = {
  success: true,
  enabled: true,
  detection: 'manual',
  github: { connected: true, slug: 'aegis-deploy' },
  capabilities: { projects: true, builds: true, runtimes: false }
};

// Every field projectView() puts on a project (routes.js:650-696), for an
// ordinary, non-preview project with enough history, releases and branches
// to exercise every tab. rootDir is left null on purpose, it is what the
// metaRow test uses to prove a falsy value renders no row at all.
const PROJECT = {
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
  history: [
    { sha: 'abcdef1234567890', trigger: 'push', actor: 'paul', error: null, at: Date.now() - 60000, status: 'ready' }
  ],
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
  releases: [{ sha: 'abc1234598765', at: Date.now() - 120000 }],
  runtime: 'static',
  startCmd: null,
  running: null,
  parentId: null,
  previews: []
};

// A preview deployment: same shape, parentId set. The real backend never
// puts a preview at the top level of the /api/deploy/projects response (it
// nests it under its parent's `previews`), but projectById() only ever
// searches the flat list deploy.js keeps in memory (deploy.js:1033), and that
// flat list is all this test exercises: whether the tab strip hides Previews
// and Domains for a record whose parentId is set, wherever that record came
// from.
const PREVIEW = Object.assign({}, PROJECT, {
  id: 'site-a-preview',
  name: 'Site A (feat/x)',
  branch: 'feat/x',
  port: 4002,
  url: 'http://127.0.0.1:4002/',
  history: [],
  releases: [],
  parentId: 'site-a'
});

function stubs(projects) {
  return {
    '/api/deploy/status': STATUS_STUB,
    '/api/deploy/projects': { success: true, projects: projects }
  };
}

function detailUrl(hash) {
  return server.url + '/pages/deploy.html#' + hash;
}

function readTabs(page) {
  return page.evaluate(function () {
    return Array.prototype.slice.call(document.querySelectorAll('#deploy-detail-body .dep-tab')).map(function (a) {
      return { text: a.textContent.trim(), href: a.getAttribute('href'), current: a.getAttribute('aria-current') };
    });
  });
}

/** The panel's own first heading, or null if the panel has none yet. */
function firstHeading(page) {
  return page.evaluate(function () {
    var h = document.querySelector('#deploy-detail-body h2.dep-subtitle');
    return h ? h.textContent.trim() : null;
  });
}

test('the tab strip lists all seven tabs, in order, each linking to its own hash, with one aria-current', async () => {
  const { page, close } = await openPage(browser, detailUrl('project/site-a/deployments'), stubs([PROJECT]));
  try {
    const expected = [
      ['overview', 'Overview'],
      ['deployments', 'Deployments'],
      ['previews', 'Previews'],
      ['env', 'Variables'],
      ['data', 'Data'],
      ['domains', 'Domains'],
      ['settings', 'Settings']
    ];
    const tabs = await readTabs(page);
    assert.strictEqual(tabs.length, 7, 'expected exactly seven tabs, got ' + tabs.length);
    tabs.forEach((tab, i) => {
      assert.strictEqual(tab.text, expected[i][1], 'tab ' + i + ' label');
      assert.strictEqual(tab.href, '#project/site-a/' + expected[i][0], 'tab ' + i + ' href');
    });

    const current = tabs.filter((t) => t.current === 'page');
    assert.strictEqual(current.length, 1, 'expected exactly one aria-current tab, got ' + current.length);
    assert.strictEqual(current[0].href, '#project/site-a/deployments');
  } finally {
    await close();
  }
});

test('a preview (parentId set) does not render the Previews or Domains tabs', async () => {
  const { page, close } = await openPage(browser, detailUrl('project/site-a-preview/overview'), stubs([PROJECT, PREVIEW]));
  try {
    const tabs = await readTabs(page);
    assert.deepStrictEqual(tabs.map((t) => t.text), ['Overview', 'Deployments', 'Variables', 'Data', 'Settings']);
    tabs.forEach((t) => assert.ok(t.href.startsWith('#project/site-a-preview/'), t.href));
  } finally {
    await close();
  }
});

// One id per PROJECT_TABS entry, mapped to the text of that panel's own
// first heading (verified by reading each render function). If a registry
// entry's `render` field got swapped for another tab's, this is what would
// show it: the hash for one tab would render another tab's first heading.
const PANEL_HEADING = {
  overview: 'Production deployment',
  deployments: 'Deployments',
  previews: 'Preview deployments',
  env: 'Environment variables',
  data: 'Data',
  domains: 'Host name',
  settings: 'Unknown paths'
};

test('each tab id renders its own panel', async () => {
  const { page, close } = await openPage(browser, detailUrl('project/site-a/overview'), stubs([PROJECT]));
  try {
    for (const id of Object.keys(PANEL_HEADING)) {
      await page.evaluate((tabId) => { window.location.hash = '#project/site-a/' + tabId; }, id);
      await page.waitForFunction((needle) => {
        var h = document.querySelector('#deploy-detail-body h2.dep-subtitle');
        return !!h && h.textContent.trim() === needle;
      }, { timeout: 5000 }, PANEL_HEADING[id]);

      const heading = await firstHeading(page);
      assert.strictEqual(heading, PANEL_HEADING[id], id + ' did not render its own panel');
    }
  } finally {
    await close();
  }
});

test('an unknown sub-tab falls back to Overview, with no console or page error', async () => {
  const { page, close, consoleErrors, pageErrors } = await openPage(browser, detailUrl('project/site-a/nonsense'), stubs([PROJECT]));
  try {
    const tabs = await readTabs(page);
    const current = tabs.filter((t) => t.current === 'page');
    assert.strictEqual(current.length, 1, 'expected exactly one active tab');
    assert.strictEqual(current[0].text, 'Overview');

    const heading = await firstHeading(page);
    assert.strictEqual(heading, PANEL_HEADING.overview);

    assert.deepStrictEqual(consoleErrors, []);
    assert.deepStrictEqual(pageErrors, []);
  } finally {
    await close();
  }
});

test('metaRow builds a key/value row, skips a falsy value entirely, and passes through a non-string node as-is', async () => {
  const { page, close } = await openPage(browser, detailUrl('project/site-a/settings'), stubs([PROJECT]));
  try {
    // The settings panel's Build and deployment block runs seven metaRow()
    // calls, one of them (Subfolder, from project.rootDir) on a fixture value
    // that is null.
    const settingsRows = await page.evaluate(function () {
      return Array.prototype.slice.call(document.querySelectorAll('#deploy-detail-body .dep-meta-row')).map(function (row) {
        var key = row.querySelector('.dep-meta-key');
        var value = row.querySelector('.dep-meta-value');
        return { className: row.className, key: key && key.textContent.trim(), value: value && value.textContent.trim() };
      });
    });

    const repoRow = settingsRows.find((r) => r.key === 'Repository');
    assert.ok(repoRow, 'no Repository row rendered in settings');
    assert.strictEqual(repoRow.className, 'dep-meta-row');
    assert.strictEqual(repoRow.value, PROJECT.repoFullName);

    assert.ok(!settingsRows.some((r) => r.key === 'Subfolder'),
      'project.rootDir is null on the fixture, metaRow should not have rendered a Subfolder row at all');

    // The overview tab's Status row passes a pill span (a real node) as the
    // value, not a string, so metaRow must append it as-is rather than
    // wrapping it in a .dep-meta-value span.
    await page.evaluate(function () { window.location.hash = '#project/site-a/overview'; });
    await page.waitForFunction(function () {
      return !!document.querySelector('#deploy-detail-body .dep-prod-fact .dep-pill');
    }, { timeout: 5000 });

    const statusRow = await page.evaluate(function () {
      var rows = Array.prototype.slice.call(document.querySelectorAll('#deploy-detail-body .dep-prod-fact'));
      var row = rows.filter(function (r) {
        var key = r.querySelector('.dep-meta-key');
        return key && key.textContent.trim() === 'Status';
      })[0];
      if (!row) return null;
      return {
        className: row.className,
        hasValueSpan: !!row.querySelector('.dep-meta-value'),
        hasPill: !!row.querySelector('.dep-pill')
      };
    });
    assert.ok(statusRow, 'no Status row rendered in overview');
    assert.strictEqual(statusRow.className, 'dep-prod-fact');
    assert.strictEqual(statusRow.hasValueSpan, false, 'the pill node got wrapped in .dep-meta-value instead of appended as-is');
    assert.ok(statusRow.hasPill, 'the pill node was not appended to the row');
  } finally {
    await close();
  }
});

// The branch a project tracks used to be a read-only metaRow in the Build and
// deployment block: the backend accepted a branch at creation and nothing on
// the page could change it afterwards. It is a form now, and a preview still
// refuses because its branch is its identity.

test('settings offers the tracked branch as a field, prefilled, with its suggestion list', async () => {
  const { page, close } = await openPage(browser, detailUrl('project/site-a/settings'), stubs([PROJECT]));
  try {
    const form = await page.evaluate(function () {
      var box = document.querySelector('#deploy-detail-body .dep-branch-form');
      if (!box) return null;
      var input = box.querySelector('.dep-input');
      var list = box.querySelector('datalist');
      var btn = box.querySelector('button');
      return {
        value: input && input.value,
        listAttr: input && input.getAttribute('list'),
        listId: list && list.id,
        button: btn && btn.textContent.trim()
      };
    });

    assert.ok(form, 'the settings panel rendered no branch form at all');
    assert.strictEqual(form.value, PROJECT.branch, 'the field does not start on the branch being served');
    assert.ok(form.listAttr, 'the field is not wired to a datalist');
    assert.strictEqual(form.listAttr, form.listId, 'the list attribute names a datalist that is not the one rendered');
    assert.strictEqual(form.button, 'Change and deploy');

    // It moved out of the read-only block rather than being duplicated into
    // both: a value shown twice, once editable and once not, is the shape that
    // goes stale.
    const keys = await page.evaluate(function () {
      return Array.prototype.slice.call(document.querySelectorAll('#deploy-detail-body .dep-meta-row .dep-meta-key'))
        .map(function (k) { return k.textContent.trim(); });
    });
    assert.ok(!keys.includes('Branch'), 'the branch is still a read-only row as well as a field');
  } finally {
    await close();
  }
});

test('a preview gets the sentence and no branch field: its branch is what it is', async () => {
  const { page, close } = await openPage(browser, detailUrl('project/site-a-preview/settings'), stubs([PREVIEW]));
  try {
    const seen = await page.evaluate(function () {
      var body = document.getElementById('deploy-detail-body');
      return {
        form: !!body.querySelector('.dep-branch-form'),
        text: body.textContent
      };
    });
    assert.strictEqual(seen.form, false, 'a preview was offered a branch field');
    assert.ok(seen.text.indexOf('A preview is its branch') !== -1,
      'a preview was given no reason why it has no branch field');
  } finally {
    await close();
  }
});

// The repository picker deployed r.defaultBranch and offered nothing else, so
// the only branch reachable from the list was the default one. Each row carries
// a field now: still one option and one click for the operator who wants the
// default, and the rest of the branches fetched the first time the field is
// reached rather than once per row on render.

const GITHUB_STUBS = {
  '/api/deploy/status': STATUS_STUB,
  '/api/deploy/projects': { success: true, projects: [] },
  '/api/deploy/github/installations': {
    success: true,
    installations: [{ installationId: 11, accountLogin: 'acme', accountType: 'Organization' }]
  },
  '/api/deploy/github/repos': {
    success: true,
    repos: [{ id: 1, fullName: 'acme/site', private: false, defaultBranch: 'main' }]
  },
  '/api/deploy/github/branches': {
    success: true,
    repoFullName: 'acme/site',
    defaultBranch: 'main',
    branches: [
      { name: 'main', sha: 'a', protected: true },
      { name: 'release/2', sha: 'b', protected: false },
      { name: 'feat/x', sha: 'c', protected: false }
    ]
  }
};

test('a repository row starts on its default branch and fills the rest when the field is reached', async () => {
  const { page, close } = await openPage(browser, server.url + '/pages/deploy.html#github', GITHUB_STUBS);
  try {
    await page.waitForFunction(function () {
      return !!document.querySelector('#deploy-repo-list .dep-listrow .dep-branch');
    }, { timeout: 5000 });

    const before = await page.evaluate(function () {
      var sel = document.querySelector('#deploy-repo-list .dep-branch');
      return { count: sel.options.length, value: sel.value };
    });
    assert.strictEqual(before.count, 1, 'the row asked GitHub for branches before anyone opened the field');
    assert.strictEqual(before.value, 'main', 'the row does not start on the default branch');

    await page.evaluate(function () {
      document.querySelector('#deploy-repo-list .dep-branch')
        .dispatchEvent(new MouseEvent('mouseenter'));
    });
    await page.waitForFunction(function () {
      return document.querySelector('#deploy-repo-list .dep-branch').options.length === 3;
    }, { timeout: 5000 });

    const after = await page.evaluate(function () {
      var sel = document.querySelector('#deploy-repo-list .dep-branch');
      return {
        names: Array.prototype.map.call(sel.options, function (o) { return o.value; }),
        value: sel.value
      };
    });
    assert.deepStrictEqual(after.names, ['main', 'release/2', 'feat/x']);
    assert.strictEqual(after.value, 'main', 'filling the list moved the selection off what was showing');
  } finally {
    await close();
  }
});

// The Data tab. Three levels that replace each other, and the two cells that
// cannot be sent whole. The backend tags a blob and a cut string rather than
// turning them into a sentence, because a column of real text could otherwise
// hold something indistinguishable from the sentence; this is the half of that
// decision that has to render it.

// Full paths, not '/data'. stubFor() matches on `pathname.includes(key)` and
// lets the longest key win, and '/api/deploy/projects' is a substring of every
// one of these: a short key here silently loses to the project list and the
// panel renders its empty state from a payload that was never meant for it.
function dataStubs(folder, tables, rows) {
  return Object.assign(stubs([PROJECT]), {
    '/api/deploy/projects/site-a/data': folder,
    '/api/deploy/projects/site-a/data/app.db': tables,
    '/api/deploy/projects/site-a/data/app.db/rows': rows
  });
}

const TABLES_STUB = {
  success: true,
  file: 'app.db',
  tables: [{
    name: 'commandes',
    type: 'table',
    rows: 2,
    columns: [{ name: 'id', type: 'INTEGER', pk: true }, { name: 'client', type: 'TEXT' }]
  }]
};

const ROWS_STUB = {
  success: true,
  file: 'app.db',
  table: 'commandes',
  type: 'table',
  columns: ['id', 'client', 'note', 'photo'],
  rows: [
    [1, 'Alice', { aegis: 'text', shown: 'aaa', length: 700 }, { aegis: 'blob', bytes: 1234 }],
    [2, 'Bob', null, null]
  ],
  total: 2,
  limit: 50,
  offset: 0
};

test('a project that runs no process is told why its data folder is empty', async () => {
  const { page, close } = await openPage(browser, detailUrl('project/site-a/data'),
    dataStubs({ success: true, files: [], writable: false, variable: 'AEGIS_DATA_DIR' }, {}, {}));
  try {
    await page.waitForFunction(function () {
      var e = document.querySelector('#deploy-detail-body .dep-empty');
      return e && e.textContent.indexOf('AEGIS_DATA_DIR') !== -1;
    }, { timeout: 5000 });

    const text = await page.evaluate(function () {
      return document.querySelector('#deploy-detail-body .dep-empty').textContent;
    });
    assert.ok(text.indexOf('runs no process') !== -1,
      'a static project was not told why nothing can write there: ' + text);
  } finally {
    await close();
  }
});

test('the data tab walks files to tables to rows, and renders each kind of cell', async () => {
  const { page, close } = await openPage(browser, detailUrl('project/site-a/data'),
    dataStubs({
      success: true,
      writable: true,
      variable: 'AEGIS_DATA_DIR',
      files: [
        { name: 'app.db', bytes: 8192, modified: Date.now() - 1000, isDatabase: true },
        { name: 'app.db.tmp', bytes: 12, modified: Date.now() - 1000, isDatabase: false }
      ]
    }, TABLES_STUB, ROWS_STUB));
  try {
    // Level 1: both files listed, and only the database is openable.
    await page.waitForFunction(function () {
      return document.querySelectorAll('#deploy-detail-body .dep-listrow').length === 2;
    }, { timeout: 5000 });

    const files = await page.evaluate(function () {
      return Array.prototype.slice.call(document.querySelectorAll('#deploy-detail-body .dep-listrow'))
        .map(function (row) {
          return {
            name: row.querySelector('.dep-listrow-name').textContent,
            openable: !!row.querySelector('button')
          };
        });
    });
    assert.deepStrictEqual(files, [
      { name: 'app.db', openable: true },
      { name: 'app.db.tmp', openable: false }
    ]);

    // Level 2: the tables of that file, reached by the row's own button.
    await page.evaluate(function () {
      document.querySelector('#deploy-detail-body .dep-listrow button').click();
    });
    await page.waitForFunction(function () {
      var n = document.querySelector('#deploy-detail-body .dep-listrow .dep-listrow-name');
      return n && n.textContent === 'commandes';
    }, { timeout: 5000 });

    const crumbs = await page.evaluate(function () {
      return Array.prototype.slice.call(document.querySelectorAll('#deploy-detail-body .dep-data-crumb'))
        .map(function (c) { return c.textContent; });
    });
    assert.deepStrictEqual(crumbs, ['Files'], 'no way back up from the tables of one file');

    // Level 3: the grid.
    await page.evaluate(function () {
      document.querySelector('#deploy-detail-body .dep-listrow button').click();
    });
    await page.waitForFunction(function () {
      return !!document.querySelector('#deploy-detail-body .dep-data-table tbody tr');
    }, { timeout: 5000 });

    const grid = await page.evaluate(function () {
      var body = document.getElementById('deploy-detail-body');
      var heads = Array.prototype.slice.call(body.querySelectorAll('.dep-data-table thead th'))
        .map(function (th) { return th.textContent.replace(/[▴▾]/g, '').trim(); });
      var cells = Array.prototype.slice.call(body.querySelectorAll('.dep-data-table tbody tr'))
        .map(function (tr) {
          return Array.prototype.slice.call(tr.children).map(function (td) {
            return {
              text: td.textContent,
              kind: td.firstChild && td.firstChild.className ? td.firstChild.className : ''
            };
          });
        });
      return {
        heads: heads,
        cells: cells,
        crumbs: Array.prototype.slice.call(body.querySelectorAll('.dep-data-crumb'))
          .map(function (c) { return c.textContent; }),
        pager: body.querySelector('.dep-data-count').textContent
      };
    });

    assert.deepStrictEqual(grid.heads, ['id', 'client', 'note', 'photo']);
    assert.deepStrictEqual(grid.crumbs, ['Files', 'app.db'],
      'the trail back through the two levels above is not there');

    // A blob shows its size, never its bytes.
    assert.strictEqual(grid.cells[0][3].kind, 'dep-data-blob');
    assert.ok(grid.cells[0][3].text.indexOf('1.2 kB') !== -1, grid.cells[0][3].text);

    // Cut text keeps what it has and says what it is missing.
    assert.strictEqual(grid.cells[0][2].text.indexOf('aaa'), 0);
    assert.ok(grid.cells[0][2].text.indexOf('700') !== -1,
      'the cut cell does not say how much it is not showing');

    // null is not an empty cell: in a table of data the difference is usually
    // the thing being looked for.
    assert.strictEqual(grid.cells[1][2].kind, 'dep-data-null');
    assert.strictEqual(grid.cells[1][2].text, 'null');

    assert.ok(grid.pager.indexOf('2 rows') !== -1, grid.pager);
  } finally {
    await close();
  }
});
