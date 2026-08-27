/**
 * Tier 3 -- the "N running" pill on the Deployments rail entry.
 *
 * It got stuck. A first deployment showed "1 en cours" next to a console whose
 * every stage was green, and kept showing it for as long as the page stayed
 * open, so the one number on screen that says whether anything is happening
 * said the opposite of the five boxes beside it.
 *
 * Two causes, and the tests below pin one each:
 *
 * - The set was keyed by project id. A first deployment starts recording
 *   before its repository has been parsed, so its `projectId` is empty for the
 *   first polls and becomes the real id a second later: the entry went in
 *   under `''`, the delete looked for the project id, found nothing, and left
 *   it behind. It is keyed by run id now, which never changes.
 * - Only an open console moved the set. Leaving the console mid-build, or
 *   reloading the page while a deployment ran, left the count with nothing to
 *   correct it. The backend already answers the question on
 *   `/api/deploy/runs`, so the page takes the answer instead of accumulating
 *   one.
 *
 * The stub map handed to `openPage` is read per request, so mutating it between
 * assertions is how a deployment finishes here. No backend and no clone.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const harness = require('./harness');
if (!harness.available) {
  test('the Deploy running-count pill', { skip: harness.why }, () => {});
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

const GITHUB = { connected: true, appId: 123, slug: 'aegis-deploy-test' };

/** A run in the shape `/api/deploy/runs` answers with. */
function run(over) {
  return Object.assign({
    id: 'run-aaaaaaaa',
    projectId: 'site',
    projectName: 'Site',
    branch: 'main',
    sha: 'abcdef1234567890',
    trigger: 'create',
    actor: 'tester@example.com',
    status: 'running',
    error: null,
    startedAt: Date.now(),
    endedAt: null,
    stages: [],
    lines: [],
    resync: false,
    cursor: 0
  }, over || {});
}

function stubs(runList, projects) {
  return {
    '/api/deploy/status': {
      success: true,
      enabled: true,
      detection: 'poll',
      github: GITHUB,
      capabilities: { projects: true, builds: true, runtimes: false }
    },
    '/api/deploy/projects': { success: true, projects: projects || [] },
    '/api/deploy/github/installations': { success: true, installations: [] },
    '/api/deploy/runs': { success: true, runs: runList }
  };
}

/** A project in the shape `/api/deploy/projects` answers with. */
function project(over) {
  return Object.assign({
    id: 'pulse-app',
    name: 'Pulse',
    repoFullName: 'acme/pulse',
    branch: 'main',
    lastSha: null,
    previousSha: null,
    deployedAt: null,
    lastError: 'needs_build',
    failureCount: 8,
    pollGaveUp: false,
    history: [],
    port: 3090,
    url: 'http://127.0.0.1:3090/',
    serving: false,
    releases: [],
    runtime: 'static',
    running: null,
    parentId: null,
    hasPreview: false,
    previews: []
  }, over || {});
}

function readCardText(page) {
  return page.evaluate(function () {
    var card = document.querySelector('#deploy-project-list .dep-card');
    return card ? card.textContent : null;
  });
}

/** What the reader sees on the rail. */
function readPill(page) {
  return page.evaluate(function () {
    var pill = document.getElementById('deploy-runs-count');
    return {
      shown: !!(pill && !pill.hidden),
      text: pill ? pill.textContent.trim() : null
    };
  });
}

/** Waits for the pill to reach a shown/hidden state, or fails saying what it held. */
async function waitForPill(page, shown) {
  try {
    await page.waitForFunction(function (want) {
      var pill = document.getElementById('deploy-runs-count');
      return !!(pill && !pill.hidden) === want;
    }, { timeout: 15000, polling: 200 }, shown);
  } catch (e) {
    const held = await readPill(page);
    assert.fail(`the pill never became ${shown ? 'shown' : 'hidden'}; it held `
      + JSON.stringify(held));
  }
}

test('a deployment that is running puts a count on the rail', async () => {
  const map = stubs([run({})]);
  const { page, close } = await openPage(
    browser, server.url + '/pages/deploy.html#runs', map);
  try {
    await waitForPill(page, true);
    const pill = await readPill(page);
    assert.match(pill.text, /1/, 'the pill names how many are running');
  } finally {
    await close();
  }
});

// The regression. Before this, the count came only from an open console's poll,
// so a run that ended anywhere else left it frozen.
test('the count clears itself when the deployment ends', async () => {
  const map = stubs([run({})]);
  const { page, close } = await openPage(
    browser, server.url + '/pages/deploy.html#runs', map);
  try {
    await waitForPill(page, true);

    // The deployment finishes. Nothing on the page is told; the next watch tick
    // is what has to notice.
    map['/api/deploy/runs'] = {
      success: true,
      runs: [run({ status: 'ready', endedAt: Date.now() })]
    };

    await waitForPill(page, false);
  } finally {
    await close();
  }
});

// The exact shape of the stuck badge: a first deployment is recorded before its
// repository has been parsed, so it is briefly a run with no project. Keyed by
// project id, its entry went in under '' and was never removed.
test('a run with no project yet is still counted, and still cleared', async () => {
  const map = stubs([run({ projectId: '', projectName: 'Starting' })]);
  const { page, close } = await openPage(
    browser, server.url + '/pages/deploy.html#runs', map);
  try {
    await waitForPill(page, true);

    // The project id arrives, as it does one poll into a first deployment.
    map['/api/deploy/runs'] = { success: true, runs: [run({ projectId: 'site' })] };
    await new Promise((r) => setTimeout(r, 6000));
    assert.strictEqual((await readPill(page)).shown, true,
      'the run is the same run: naming its project must not drop the count');

    map['/api/deploy/runs'] = {
      success: true,
      runs: [run({ projectId: 'site', status: 'ready', endedAt: Date.now() })]
    };
    await waitForPill(page, false);
  } finally {
    await close();
  }
});

test('two deployments at once are counted as two', async () => {
  const map = stubs([
    run({ id: 'run-aaaaaaaa', projectId: 'one' }),
    run({ id: 'run-bbbbbbbb', projectId: 'two' })
  ]);
  const { page, close } = await openPage(
    browser, server.url + '/pages/deploy.html#runs', map);
  try {
    await waitForPill(page, true);
    assert.match((await readPill(page)).text, /2/);

    // One ends. The pill drops to one rather than to nothing, which is the
    // failure a set keyed by anything shared between runs would produce.
    map['/api/deploy/runs'] = {
      success: true,
      runs: [
        run({ id: 'run-aaaaaaaa', projectId: 'one', status: 'ready', endedAt: Date.now() }),
        run({ id: 'run-bbbbbbbb', projectId: 'two' })
      ]
    };
    await page.waitForFunction(function () {
      var pill = document.getElementById('deploy-runs-count');
      return pill && !pill.hidden && /1/.test(pill.textContent);
    }, { timeout: 15000, polling: 200 });
  } finally {
    await close();
  }
});

test('a page with nothing running shows no pill at all', async () => {
  const map = stubs([run({ status: 'ready', endedAt: Date.now() })]);
  const { page, close } = await openPage(
    browser, server.url + '/pages/deploy.html#runs', map);
  try {
    await waitForPill(page, false);
  } finally {
    await close();
  }
});

/**
 * The screen the bug was actually seen on: the console, open, polling.
 *
 * The slower watch would clear a stale count within five seconds, so this is
 * the window the run-id keying is load-bearing for. The console polls twice a
 * second and is the screen an operator is looking at while they wait, so the
 * pill has to follow that beat -- a badge that contradicts the five green boxes
 * beside it for five seconds is the report that started this.
 *
 * Two seconds is the assertion, which is four console polls and comfortably
 * under one watch tick: passing it means the console cleared the count, not
 * that the watch caught it later.
 */
test('the console clears the count on the poll, not five seconds later', async () => {
  const map = stubs([]);
  // No project yet, exactly as a first deployment is recorded before its
  // repository has been parsed. This is the id the entry was filed under.
  map['/api/deploy/runs/run-aaaaaaaa'] = {
    success: true,
    run: run({ projectId: '', projectName: 'Starting', stages: [] })
  };

  const { page, close } = await openPage(
    browser, server.url + '/pages/deploy.html#console/run-aaaaaaaa', map);
  try {
    await waitForPill(page, true);

    // The project id arrives, then the deployment ends -- both while the
    // console stays open. Keyed by project id, the delete looked for 'site'
    // and the entry sat under '', so the pill kept its count.
    map['/api/deploy/runs/run-aaaaaaaa'] = {
      success: true,
      run: run({ projectId: 'site', status: 'ready', endedAt: Date.now(), stages: [] })
    };

    await page.waitForFunction(function () {
      var pill = document.getElementById('deploy-runs-count');
      return !!pill && pill.hidden;
    }, { timeout: 2000, polling: 100 });
  } finally {
    await close();
  }
});

/**
 * The other half of the loop, on the card.
 *
 * `pulse-app` on the live install had eight consecutive `needs_build` failures
 * and would have had a ninth: the sweep retried a refusal about what the branch
 * holds, which running it again cannot change. The sweep stops now, and a card
 * that has been given up on has to say so -- otherwise it is indistinguishable
 * from one about to be tried again, and the operator waits for a retry that is
 * never coming.
 */
test('a project the sweep has given up on says so on its card', async () => {
  const map = stubs([], [project({ pollGaveUp: true })]);
  const { page, close } = await openPage(
    browser, server.url + '/pages/deploy.html', map);
  try {
    await page.waitForSelector('#deploy-project-list .dep-card', { timeout: 15000 });
    const text = await readCardText(page);
    assert.match(text, /stopped retrying/i,
      'the card must say the sweep has stopped');
    // The refusal itself stays: what is wrong and what Aegis is doing about it
    // are two different sentences.
    assert.match(text, /built/i, 'the needs_build refusal is still shown');
  } finally {
    await close();
  }
});

test('a project still being retried says nothing about giving up', async () => {
  const map = stubs([], [project({ pollGaveUp: false })]);
  const { page, close } = await openPage(
    browser, server.url + '/pages/deploy.html', map);
  try {
    await page.waitForSelector('#deploy-project-list .dep-card', { timeout: 15000 });
    const text = await readCardText(page);
    assert.doesNotMatch(text, /stopped retrying/i);
    assert.match(text, /built/i, 'the refusal is shown either way');
  } finally {
    await close();
  }
});

// A stage the backend knows and this page does not used to throw here, which
// blanked the whole console. The backend is read at boot and the page per
// request, so it is newer than the page for as long as nobody restarts.
test('the console survives a stage name this page has never heard of', async () => {
  const map = stubs([]);
  map['/api/deploy/runs/run-aaaaaaaa'] = {
    success: true,
    run: run({
      status: 'running',
      stages: [
        { key: 'clone', status: 'done', startedAt: 1, endedAt: 2, detail: null },
        { key: 'migrate', status: 'running', startedAt: 2, endedAt: null, detail: '1 dans migrations/' },
        { key: 'invented-later', status: 'running', startedAt: 2, endedAt: null, detail: null }
      ]
    })
  };

  const { page, close } = await openPage(
    browser, server.url + '/pages/deploy.html#console/run-aaaaaaaa', map);
  try {
    await page.waitForFunction(function () {
      var box = document.getElementById('deploy-run-stages');
      return box && box.querySelectorAll('.dep-stage').length >= 3;
    }, { timeout: 15000, polling: 200 });

    const names = await page.evaluate(function () {
      return Array.prototype.map.call(
        document.querySelectorAll('#deploy-run-stages .dep-stage-name'),
        function (n) { return n.textContent.trim(); });
    });
    assert.ok(names.length >= 3, `three stages were painted, got ${JSON.stringify(names)}`);
    assert.ok(names.some(function (n) { return /migration/i.test(n); }),
      `the migrations stage is named, got ${JSON.stringify(names)}`);
    assert.ok(names.indexOf('invented-later') > -1,
      'an unknown stage falls back to its key rather than blanking the console');
  } finally {
    await close();
  }
});
