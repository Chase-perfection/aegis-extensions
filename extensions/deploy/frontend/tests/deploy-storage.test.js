/**
 * Tier 3 -- the storage gear, its page, the guided setup and the Data tab of a
 * project that moved to a database, rendered inside the Aegis shell.
 *
 * The backend is a table of stubs, and the table is mutable: the helper reads
 * it at each request, so a test changes an answer between two clicks the way
 * the server's answer changes between two checks.
 *
 * What a page measured at rest hides is what these tests walk into: a gear that
 * appears only once a route answered, callouts whose text follows a select, a
 * Continue button that has to stay disabled, a form that must survive the
 * project list being refetched under it. Each test asserts what it measured
 * (how many callouts, how many check rows), so a selector that stopped matching
 * fails instead of passing over nothing.
 *
 * AEGIS_STORAGE_SHOTS=<folder> writes a screenshot of each state there. Unset,
 * nothing is written.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const harness = require('./harness');
if (!harness.available) {
  test('the Deploy storage page, inside the Aegis shell', { skip: harness.why }, () => {});
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

const STATUS_STUB = {
  success: true,
  enabled: true,
  detection: 'manual',
  github: { connected: true, slug: 'aegis-deploy' },
  capabilities: { projects: true, builds: true, runtimes: true }
};

function projectView(overrides) {
  return Object.assign({
    id: 'site-a', name: 'Site A', repoFullName: 'acme/site-a', branch: 'main',
    rootDir: null, installCmd: 'pip install -r requirements.txt --target .', buildCmd: null, outputDir: null,
    lastSha: 'abcdef1234567890', previousSha: null, deployedAt: Date.now() - 60000,
    lastError: null, failureCount: 0, history: [], port: 4001, url: 'http://127.0.0.1:4001/',
    serving: true, protected: false, allowedGroups: [], tls: {}, envCount: 0, spaFallback: false,
    hostname: null, hostUrl: null, routerPort: 8080, releases: [],
    runtime: 'node', startCmd: 'python app.py', storageMode: 'local', running: true,
    parentId: null, previews: []
  }, overrides || {});
}

const TARGET = { kind: 'supabase', host: '10.0.0.10', port: 5432, database: 'postgres', user: 'postgres.acme', ssl: false, consoleUrl: 'http://10.0.0.10:8000/' };
const COMMAND = "Add-Content -Path 'C:\\ProgramData\\Aegis\\deploy\\database-targets.txt' -Value '10.0.0.10:5432'";
const STORAGE = '/api/deploy/projects/site-a/storage';

function storageInfo(over) {
  return Object.assign({
    success: true, available: true, reason: null, capable: true,
    dbFile: 'app.db', migrationsDir: 'migrations/postgres', variable: 'DATABASE_URL',
    storage: { mode: 'local', target: null, hasPassword: false, canReplace: false, switchedAt: null, switchedBy: null },
    approved: null, approveCommand: null
  }, over || {});
}

const ORDER = ['runtime', 'capability', 'approved', 'ssl', 'reachable', 'login', 'version', 'create', 'code', 'path'];

/** A check answer that fails at `failAt` with `code`, or passes everything. */
function checks(failAt, code, extra) {
  let failed = false;
  const list = ORDER.map((id) => {
    if (failed) return { id, ok: null, code: 'not_asked', detail: '' };
    if (id === failAt) { failed = true; return Object.assign({ id, ok: false, code, detail: '' }, extra || {}); }
    const codes = { ssl: 'private', path: 'will_open' };
    const details = { login: 'postgres.acme', version: '15', code: '2', path: '10.0.0.10:5432' };
    return { id, ok: true, code: codes[id] || 'ok', detail: details[id] || '' };
  });
  return {
    success: true, ok: !failAt, checks: list,
    storage: { mode: 'local', target: TARGET, hasPassword: !failAt, canReplace: false, switchedAt: null, switchedBy: null },
    approved: failAt !== 'approved', approveCommand: COMMAND
  };
}

// The shape /auth/me really answers: the role at the top level. The helper's
// default body nests it under `user`, which the page reads as "not an admin".
const ME_ADMIN = { loggedIn: true, tenant: 'test', userId: 1, email: 'admin@example.com', role: 'admin' };
const ME_MEMBER = Object.assign({}, ME_ADMIN, { role: 'member' });

function stubs(project, extra) {
  return Object.assign({
    'auth/me': ME_ADMIN,
    '/api/deploy/status': STATUS_STUB,
    '/api/deploy/projects': { success: true, projects: [project || projectView()] },
    [STORAGE]: storageInfo()
  }, extra || {});
}

function pageUrl(hash) {
  return server.url + '/pages/deploy.html#' + hash;
}

function waitForProjects(page) {
  return page.waitForFunction(() => !!document.querySelector('#deploy-projects .dep-card'), { timeout: 5000 });
}

async function shot(page, name) {
  if (!process.env.AEGIS_STORAGE_SHOTS) return;
  await page.screenshot({ path: path.join(process.env.AEGIS_STORAGE_SHOTS, name + '.png'), fullPage: true });
}

async function clickButton(page, label) {
  const done = await page.evaluate((text) => {
    const b = [...document.querySelectorAll('#deploy-detail-body button')].find((x) => x.textContent.trim() === text && !x.disabled);
    if (!b) return false;
    b.click();
    return true;
  }, label);
  assert.ok(done, 'no enabled button labelled "' + label + '"');
}

async function fill(page, id, value) {
  await page.evaluate((i, v) => {
    const input = document.getElementById(i);
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, id, value);
}

function waitForStep(page, n) {
  return page.waitForFunction((k) => {
    const cur = document.querySelector('.dep-step.is-current .dep-step-num');
    return cur && cur.textContent.trim() === String(k);
  }, { timeout: 5000 }, n);
}

test('the gear appears once the backend offers it, and only then', async () => {
  const { page, close } = await openPage(browser, pageUrl('project/site-a/overview'), stubs());
  try {
    await waitForProjects(page);
    await page.waitForSelector('#deploy-detail-tools .dep-storage-gear', { timeout: 5000 });
    const gear = await page.evaluate(() => {
      const a = document.querySelector('#deploy-detail-tools .dep-storage-gear');
      const url = document.getElementById('deploy-detail-url').getBoundingClientRect();
      const box = a.getBoundingClientRect();
      return {
        count: document.querySelectorAll('.dep-storage-gear').length,
        href: a.getAttribute('href'), label: a.getAttribute('aria-label'), hasIcon: !!a.querySelector('svg path'),
        rightOfUrl: box.left >= url.right, sameRow: Math.abs((box.top + box.bottom) / 2 - (url.top + url.bottom) / 2) < 12,
        tabs: document.querySelectorAll('#deploy-detail-body .dep-tab').length
      };
    });
    assert.deepStrictEqual(gear, {
      count: 1, href: '#project/site-a/storage', label: 'Data storage', hasIcon: true,
      rightOfUrl: true, sameRow: true, tabs: 8
    }, 'one gear, right of the address, and no ninth tab');
    await shot(page, '1-gear');

    // A tab change repaints the header. The gear must come back once, not twice.
    await page.evaluate(() => { window.location.hash = '#project/site-a/env'; });
    await page.waitForFunction(() => document.querySelector('.dep-tab.is-current').textContent.trim() === 'Variables');
    await page.waitForSelector('#deploy-detail-tools .dep-storage-gear');
    assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.dep-storage-gear').length), 1);
  } finally {
    await close();
  }
});

test('no gear for a member, for a static site, or when the backend declines', async () => {
  const cases = [
    ['a member', stubs(projectView(), { 'auth/me': ME_MEMBER })],
    ['a static site', stubs(projectView({ runtime: 'static', startCmd: null }))],
    ['the backend declined', stubs(projectView(), { [STORAGE]: storageInfo({ available: false, reason: 'runtime_off' }) })],
    ['a backend older than the route', stubs(projectView(), { [STORAGE]: null })]
  ];
  for (const [name, table] of cases) {
    const { page, close } = await openPage(browser, pageUrl('project/site-a/overview'), table);
    try {
      await waitForProjects(page);
      await page.waitForFunction(() => document.getElementById('deploy-detail-name').textContent.trim() === 'Site A');
      // Long enough for the storage route to have answered and been acted on.
      await new Promise((r) => setTimeout(r, 400));
      assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.dep-storage-gear').length), 0, name);
    } finally {
      await close();
    }
  }
});

test('the landing says where the data is and offers the setup', async () => {
  const { page, close } = await openPage(browser, pageUrl('project/site-a/storage'), stubs());
  try {
    await waitForProjects(page);
    await page.waitForSelector('.dep-storage-card', { timeout: 5000 });
    const seen = await page.evaluate(() => ({
      tabs: document.querySelectorAll('#deploy-detail-body .dep-tab').length,
      cards: [...document.querySelectorAll('.dep-storage-card')].map((c) => ({
        title: c.querySelector('.dep-storage-card-title').textContent.trim(),
        active: c.classList.contains('is-active'),
        lines: c.querySelectorAll('li').length
      })),
      state: document.querySelector('.dep-storage .dep-row-label').textContent.trim(),
      buttons: [...document.querySelectorAll('.dep-storage button')].map((b) => b.textContent.trim()),
      back: document.querySelector('.dep-storage .dep-crumb').getAttribute('href')
    }));
    assert.deepStrictEqual(seen, {
      tabs: 0,
      cards: [{ title: 'Local files', active: true, lines: 3 }, { title: 'External database', active: false, lines: 3 }],
      state: 'The data is in local files on this server',
      buttons: ['Set up an external database'],
      back: '#project/site-a/data'
    });
    await shot(page, '2-landing');
  } finally {
    await close();
  }
});

test('step 1: every field has a callout tied to it, the text follows the type, and an unapproved address shows the command', async () => {
  const table = stubs(projectView(), { [STORAGE + '/check']: checks('approved', 'not_approved', { command: COMMAND }) });
  const { page, close } = await openPage(browser, pageUrl('project/site-a/storage'), table);
  try {
    await waitForProjects(page);
    await page.waitForSelector('.dep-storage-card');
    await clickButton(page, 'Set up an external database');
    await waitForStep(page, 1);

    const form = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.dep-guided')];
      return {
        steps: [...document.querySelectorAll('.dep-step-label')].map((s) => s.textContent.trim()),
        fields: rows.map((r) => {
          const input = r.querySelector('input, select');
          const callout = r.querySelector('.dep-callout');
          const a = input.getBoundingClientRect();
          const b = callout.getBoundingClientRect();
          const shaft = getComputedStyle(callout, '::after');
          return {
            id: input.id,
            tied: input.getAttribute('aria-describedby') === callout.id,
            labelled: !!r.querySelector('label[for="' + input.id + '"] .dep-label'),
            hasText: callout.textContent.trim().length > 20,
            besideField: b.left > a.right && b.top < a.bottom && b.bottom > a.top,
            arrow: parseFloat(shaft.width) > 8 && shaft.content !== 'none'
          };
        }),
        host: document.getElementById('dep-storage-host-help').textContent
      };
    });
    assert.deepStrictEqual(form.steps, ['Address', 'Credentials', 'Checks', 'Data', 'Switch']);
    assert.strictEqual(form.fields.length, 6, 'six fields were expected in step 1');
    for (const f of form.fields) {
      assert.deepStrictEqual(f, { id: f.id, tied: true, labelled: true, hasText: true, besideField: true, arrow: true }, f.id);
    }
    assert.match(form.host, /Supabase stack/);
    await shot(page, '3-step-address');

    // The same field is found somewhere else on a plain server.
    await page.select('#dep-storage-kind', 'postgres');
    assert.match(await page.$eval('#dep-storage-host-help', (n) => n.textContent), /Postgres server/);
    await page.select('#dep-storage-kind', 'supabase');

    await fill(page, 'dep-storage-host', '10.0.0.10');
    await fill(page, 'dep-storage-port', '5432');
    await fill(page, 'dep-storage-database', 'postgres');
    await clickButton(page, 'Continue');
    await page.waitForSelector('.dep-approve .dep-row-fix', { timeout: 5000 });
    const approve = await page.evaluate(() => ({
      command: document.querySelector('.dep-approve .dep-row-fix').textContent,
      title: document.querySelector('.dep-approve .dep-row-label').textContent.trim(),
      step: document.querySelector('.dep-step.is-current .dep-step-num').textContent.trim()
    }));
    assert.deepStrictEqual(approve, { command: COMMAND, title: 'This address is not approved on this server yet', step: '1' });
    await shot(page, '4-not-approved');

    // The administrator ran the command. Same button, new answer.
    table[STORAGE + '/check'] = checks('login', 'no_password');
    await clickButton(page, 'Check again');
    await waitForStep(page, 2);
    assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.dep-guided').length), 2);
    assert.strictEqual(await page.$eval('#dep-storage-password', (i) => i.type), 'password');
    await shot(page, '5-step-credentials');
  } finally {
    await close();
  }
});

test('a field the server refuses is marked, named and focused', async () => {
  const table = stubs(projectView(), { [STORAGE + '/check']: { success: false, error: 'bad_host' } });
  const { page, close } = await openPage(browser, pageUrl('project/site-a/storage'), table);
  try {
    await waitForProjects(page);
    await page.waitForSelector('.dep-storage-card');
    await clickButton(page, 'Set up an external database');
    await waitForStep(page, 1);
    await fill(page, 'dep-storage-host', 'http://db');
    await clickButton(page, 'Continue');
    await page.waitForFunction(() => document.getElementById('dep-storage-host').getAttribute('aria-invalid') === 'true');
    const seen = await page.evaluate(() => ({
      error: [...document.querySelectorAll('.dep-field-error')].filter((e) => !e.hidden).map((e) => e.textContent),
      focused: document.activeElement.id,
      step: document.querySelector('.dep-step.is-current .dep-step-num').textContent.trim()
    }));
    assert.deepStrictEqual(seen, {
      error: ['The host is a name or an IPv4 address, with no http:// and no port.'],
      focused: 'dep-storage-host', step: '1'
    });
  } finally {
    await close();
  }
});

test('the whole journey: checks, rehearsal, password, switch, and the form survives a refetch of the projects', async () => {
  const table = stubs(projectView(), { [STORAGE + '/check']: checks('login', 'no_password') });
  const { page, close } = await openPage(browser, pageUrl('project/site-a/storage'), table);
  try {
    await waitForProjects(page);
    await page.waitForSelector('.dep-storage-card');
    await clickButton(page, 'Set up an external database');
    await waitForStep(page, 1);
    await fill(page, 'dep-storage-host', '10.0.0.10');
    await fill(page, 'dep-storage-port', '5432');
    await fill(page, 'dep-storage-database', 'postgres');
    await clickButton(page, 'Continue');
    await waitForStep(page, 2);
    await fill(page, 'dep-storage-user', 'postgres.acme');
    await fill(page, 'dep-storage-password', 'typed-once');

    // The project list is refetched while a form is open: a deployment
    // finished, a colleague saved something. The form must still be there.
    await page.evaluate(() => window.DeployKit.reload());
    assert.strictEqual(await page.$eval('#dep-storage-user', (i) => i.value), 'postgres.acme',
      'the refetch rebuilt the page and emptied the form');

    // Step 3 with a failing check: every row shown, and no way forward.
    table[STORAGE + '/check'] = checks('code', 'no_migrations', { detail: 'migrations/postgres' });
    await clickButton(page, 'Continue');
    await waitForStep(page, 3);
    await page.waitForFunction(() => document.querySelectorAll('.dep-step-body .dep-row').length === 10, { timeout: 5000 });
    const blocked = await page.evaluate(() => ({
      rows: document.querySelectorAll('.dep-step-body .dep-row').length,
      failed: [...document.querySelectorAll('.dep-step-body .dep-row.dep-blocked .dep-row-label')].map((n) => n.textContent.trim()),
      why: document.querySelector('.dep-step-body .dep-row.dep-blocked .dep-row-detail').textContent,
      notAsked: document.querySelectorAll('.dep-step-body .dep-row.dep-todo').length,
      next: [...document.querySelectorAll('.dep-step-foot button')].find((b) => b.textContent.trim() === 'Continue').disabled
    }));
    assert.deepStrictEqual([blocked.rows, blocked.failed, blocked.notAsked, blocked.next],
      [10, ["The project's code can use Postgres"], 1, true]);
    assert.match(blocked.why, /no file in migrations\/postgres/);
    await shot(page, '6-step-checks-refused');

    table[STORAGE + '/check'] = checks(null);
    await clickButton(page, 'Run the checks again');
    await page.waitForFunction(() => document.querySelectorAll('.dep-step-body .dep-row.dep-ok').length === 10, { timeout: 5000 });
    await shot(page, '7-step-checks');

    table[STORAGE + '/preview'] = {
      success: true, ok: true, migrations: ['0001_init.sql'], withoutRls: ['sites'],
      tables: [
        { name: 'sites', rows: 12, state: 'ok', missingColumns: [], copied: 12, replaced: 0 },
        { name: 'drafts', rows: 0, state: 'empty', missingColumns: [], copied: 0, replaced: 0 }
      ]
    };
    await clickButton(page, 'Continue');
    await waitForStep(page, 4);
    await page.waitForFunction(() => document.querySelectorAll('.dep-data-plan .dep-listrow').length === 2, { timeout: 5000 });
    const plan = await page.evaluate(() => ({
      lines: [...document.querySelectorAll('.dep-data-plan .dep-listrow-sub')].map((n) => n.textContent),
      rls: !!document.querySelector('.dep-data-plan .dep-row.dep-todo'),
      note: document.querySelector('.dep-storage-steps > .dep-note').textContent
    }));
    assert.deepStrictEqual(plan.lines, ['12 row(s) in the file · Copied in the rehearsal.', '0 row(s) in the file · Empty. Nothing to copy.']);
    assert.strictEqual(plan.rls, true, 'a Supabase target is told about row level security');
    assert.strictEqual(plan.note, 'The copy works.');
    await shot(page, '8-step-data');

    await clickButton(page, 'Continue');
    await waitForStep(page, 5);
    await shot(page, '9-step-switch');

    // No password, no request: the button does nothing but point at the field.
    await clickButton(page, 'Switch to the external database');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'dep-storage-admin-password');

    table[STORAGE + '/switch'] = { success: false, error: 'password' };
    await fill(page, 'dep-storage-admin-password', 'wrong');
    await clickButton(page, 'Switch to the external database');
    await page.waitForFunction(() => /refused that password/.test(document.querySelector('.dep-storage-steps > .dep-note').textContent));
    assert.strictEqual(await page.$eval('#dep-storage-admin-password', (i) => i.value), '', 'a refused password stayed in the field');

    table[STORAGE + '/switch'] = {
      success: true, ok: true,
      steps: ['checks', 'rehearsal', 'stop', 'copy', 'start'].map((id) => ({ id, ok: true, detail: '' })),
      tables: [{ name: 'sites', rows: 12, state: 'ok', copied: 12 }], migrations: ['0001_init.sql'],
      storage: { mode: 'postgres', target: TARGET, hasPassword: true, canReplace: true, switchedAt: Date.now(), switchedBy: 'tester@example.com' }
    };
    table['/api/deploy/projects'] = { success: true, projects: [projectView({ storageMode: 'postgres' })] };
    await fill(page, 'dep-storage-admin-password', 'right');
    await clickButton(page, 'Switch to the external database');
    await page.waitForFunction(() => {
      const label = document.querySelector('.dep-storage-body > .dep-row .dep-row-label');
      return label && /now runs on the external database/.test(label.textContent);
    }, { timeout: 5000 });
    const result = await page.evaluate(() => ({
      detail: document.querySelector('.dep-storage-body > .dep-row .dep-row-detail').textContent,
      steps: [...document.querySelectorAll('.dep-storage-body .dep-readiness .dep-row-label')].map((n) => n.textContent.trim())
    }));
    assert.deepStrictEqual(result, {
      detail: '12 row(s) copied.',
      steps: ['Checks', 'Rehearsal, with the site running', 'Site stopped', 'Data copied', 'Site started']
    });
    await shot(page, '10-result');

    // Done leads to the landing of a project that is now on its database.
    await clickButton(page, 'Done');
    await page.waitForFunction(() => {
      const active = document.querySelector('.dep-storage-card.is-active .dep-storage-card-title');
      return active && active.textContent.trim() === 'External database';
    }, { timeout: 5000 });
    const live = await page.evaluate(() => ({
      state: document.querySelector('.dep-storage-body > .dep-row .dep-row-detail').textContent,
      console: document.querySelector('.dep-storage-body a.dep-btn').getAttribute('href'),
      buttons: [...document.querySelectorAll('.dep-storage-body button')].map((b) => b.textContent.trim())
    }));
    assert.deepStrictEqual(live, {
      state: '10.0.0.10:5432, database postgres.',
      console: 'http://10.0.0.10:8000/',
      buttons: ['Go back to local files', 'Check and save']
    });
    await shot(page, '11-live');
  } finally {
    await close();
  }
});

test('the Data tab of a switched project shows the summary and the console, not a file list', async () => {
  const table = stubs(projectView({ storageMode: 'postgres' }), {
    [STORAGE]: storageInfo({ storage: { mode: 'postgres', target: TARGET, hasPassword: true, canReplace: true, switchedAt: Date.now(), switchedBy: 'tester@example.com' } }),
    [STORAGE + '/summary']: {
      success: true, healthy: true, more: false, consoleUrl: 'http://10.0.0.10:8000/',
      target: { host: '10.0.0.10', port: 5432, database: 'postgres', kind: 'supabase' },
      tables: [{ name: 'sites', rows: 12 }, { name: 'lines', rows: 340 }]
    },
    '/api/deploy/projects/site-a/data': { success: true, files: [{ name: 'app.db', bytes: 2048, modified: Date.now(), isDatabase: true }], writable: true }
  });
  const { page, close } = await openPage(browser, pageUrl('project/site-a/data'), table);
  try {
    await waitForProjects(page);
    await page.waitForFunction(() => document.querySelectorAll('#deploy-detail-body .dep-listrow').length === 2, { timeout: 5000 });
    const seen = await page.evaluate(() => ({
      tab: document.querySelector('.dep-tab.is-current').textContent.trim(),
      health: document.querySelector('#deploy-detail-body .dep-row-label').textContent.trim(),
      where: document.querySelector('#deploy-detail-body .dep-row-detail').textContent,
      tables: [...document.querySelectorAll('#deploy-detail-body .dep-listrow')].map((r) => r.textContent.trim().replace(/\s+/g, ' ')),
      links: [...document.querySelectorAll('#deploy-detail-body a.dep-btn')].map((a) => [a.textContent.trim(), a.getAttribute('href')]),
      fileButtons: [...document.querySelectorAll('#deploy-detail-body button')].length
    }));
    assert.deepStrictEqual(seen, {
      tab: 'Data',
      health: 'The database answers',
      where: '10.0.0.10:5432, database postgres.',
      tables: ['sites12 row(s)', 'lines340 row(s)'],
      links: [['Open the database console', 'http://10.0.0.10:8000/'], ['Storage settings', '#project/site-a/storage']],
      fileButtons: 0
    });
    await shot(page, '12-data-tab');
  } finally {
    await close();
  }
});

test('on a narrow screen the callout goes under its field', async () => {
  const { page, close } = await openPage(browser, pageUrl('project/site-a/storage'), stubs());
  try {
    await page.setViewport({ width: 700, height: 900 });
    await waitForProjects(page);
    await page.waitForSelector('.dep-storage-card');
    await clickButton(page, 'Set up an external database');
    await waitForStep(page, 1);
    const stacked = await page.evaluate(() => [...document.querySelectorAll('.dep-guided')].map((r) => {
      const a = r.querySelector('input, select').getBoundingClientRect();
      const b = r.querySelector('.dep-callout').getBoundingClientRect();
      return b.top >= a.bottom && b.right <= window.innerWidth;
    }));
    assert.strictEqual(stacked.length, 6);
    assert.ok(stacked.every(Boolean), 'a callout overlaps its field or leaves the screen: ' + JSON.stringify(stacked));
    await shot(page, '13-narrow');
  } finally {
    await close();
  }
});
