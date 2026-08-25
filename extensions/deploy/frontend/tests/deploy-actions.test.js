/**
 * Tier 3 — the shared action every deploy button repeats.
 *
 * `deployAction()` in extensions/deploy/frontend/src/js/deploy.js mints a run
 * id, jumps to the build console for it, POSTs, and on a refusal turns
 * `data.error` into a message through the caller's own error table. Three
 * call sites use it: `deployFrom()` (the new-project form), `redeploy()`
 * (the project card and the overview tab), and `previewsPanel()`'s `create()`.
 *
 * This file exists because a planned change merges seven overlapping error
 * tables into one, and nothing today catches that change silently moving a
 * message an operator reads when a deployment is refused. So the weight of
 * this file is on requirement 3: pinning every code each call site can
 * receive to the exact text it shows now, not on the request mechanics,
 * which get one test each.
 *
 * The two literal tables below (DEPLOY_ERROR_TEXT, REFUSAL_REFERENCE) are
 * copied from deploy.js's DEPLOY_ERRORS — its sentences and its short labels,
 * which used to be a second table — rather than required from it: the file is
 * an IIFE with no exports, and hand-copying makes a change to either column a
 * visible diff in this file too. Both were
 * cross-checked against frontend/src/js/translations.js's English strings for
 * the same keys, and every one matches now. `no_free_port` under previewError
 * did not, which is the defect that check was written to find; it has its own
 * key today and its row is pinned where the preview loop uses it.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

// The harness is core's and stays there: these tests render the page inside
// core's shell, so they need core's frontend on disk. `harness.js` resolves it
// through AEGIS_TREE and says why when it cannot. Skipped rather than failed,
// and never silently: this file cannot run in CI, which has no Aegis checkout.
const harness = require('./harness');
if (!harness.available) {
  test('the Deploy page actions, inside the Aegis shell', { skip: harness.why }, () => {});
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

// --- Fixtures ------------------------------------------------------------

const PROJECT_ID = 'proj1';

/** One project the way GET /api/deploy/projects sends it (routes.js projectView). */
function project(overrides) {
    return Object.assign({
        id: PROJECT_ID,
        name: 'Acme site',
        repoFullName: 'acme/site',
        branch: 'main',
        rootDir: null,
        installCmd: null,
        buildCmd: null,
        outputDir: null,
        lastSha: 'abcdef0123456789',
        previousSha: null,
        deployedAt: Date.now() - 60000,
        lastError: null,
        failureCount: 0,
        history: [],
        port: 4100,
        url: 'http://127.0.0.1:4100/',
        serving: true,
        protected: false,
        allowedGroups: [],
        tls: { enabled: false },
        envCount: 0,
        spaFallback: false,
        hostname: null,
        hostUrl: null,
        routerPort: null,
        releases: [],
        runtime: 'static',
        startCmd: null,
        running: null,
        parentId: null,
        previews: []
    }, overrides || {});
}

const STATUS_OK = {
    success: true,
    enabled: true,
    github: { connected: true, appId: 1, slug: 'acme' },
    detection: 'webhook',
    webhookUrl: null,
    capabilities: { projects: true, builds: true, runtimes: true }
};

// The shape /auth/me really answers (server.js), not helpers/browser.js's
// default body: role sits at the top level, not under a nested `user`.
const ME_ADMIN = { loggedIn: true, tenant: 'test', userId: 1, email: 'admin@example.com', role: 'admin' };

/**
 * A run stuck at "running" with no error, for every /api/deploy/runs/<id>
 * poll the console fires the moment it opens. Without this the poll falls
 * through to helpers/browser.js's default body (success:true, no `run`),
 * pollRun's own `.catch` fires, and it overwrites the refusal message this
 * file is trying to read with "Aegis stopped answering...". Keeping the run
 * "running" means pollRun never touches the note at all.
 */
function runningRun(projectId) {
    return {
        success: true,
        run: {
            cursor: 1,
            projectId,
            projectName: 'Acme site',
            branch: 'main',
            sha: 'abcdef01',
            trigger: 'manual',
            actor: 'tester',
            status: 'running',
            error: null,
            startedAt: Date.now(),
            endedAt: null,
            stages: [{ key: 'clone', status: 'running', startedAt: Date.now(), endedAt: null, detail: null }],
            lines: [],
            resync: false
        }
    };
}

/**
 * Stub keys are matched by "pathname includes this key, longest wins"
 * (helpers/browser.js's stubFor). The create/redeploy/preview POSTs share a
 * URL prefix with the project list GET, so their keys have to be the full
 * project-scoped suffix or the shorter 'deploy/projects' key would win the
 * match instead.
 */
function baseStubs(list) {
    return {
        'deploy/status': STATUS_OK,
        'auth/me': ME_ADMIN,
        'deploy/projects': { success: true, projects: list },
        'deploy/runs/': runningRun(PROJECT_ID)
    };
}

/** Clicks the DOM node directly rather than through Puppeteer's hit-testing,
 * because every one of these buttons hides its own pane the moment it is
 * clicked (deployAction navigates to #console/<runId>), which would fail a
 * real mouse click on every iteration after the first. */
function clickByText(page, selector, text) {
    return page.evaluate((sel, wanted) => {
        const btn = [...document.querySelectorAll(sel)].find((b) => b.textContent.trim() === wanted);
        if (!btn) throw new Error('button not found: ' + wanted);
        btn.click();
    }, selector, text);
}

/** Resets a note node to a sentinel, then waits until it is anything else. */
async function nextNote(page, selector) {
    await page.evaluate((sel) => { document.querySelector(sel).textContent = '￿'; }, selector);
}

async function waitForNoteChange(page, selector) {
    await page.waitForFunction(
        // Not "anything but the sentinel". Each of these panes blanks its note
        // when the request goes out and fills it when the answer lands, so a
        // poll that accepts any change catches the blank in between and asserts
        // against ''. It passes whenever the machine is quick enough to miss
        // that window, which is the worst way for a test to be right. Waiting
        // for text rules it out: no refusal in this file is the empty string.
        (sel) => {
            const text = document.querySelector(sel).textContent.trim();
            return text !== '￿' && text !== '';
        },
        { timeout: 5000 },
        selector
    );
    return page.$eval(selector, (n) => n.textContent.trim());
}

// --- The refusal text, copied verbatim from DEPLOY_ERRORS in deploy.js -----

const DEPLOY_ERROR_TEXT = {
    bad_repo_url: 'That is not a GitHub repository URL. Paste something like https://github.com/owner/repo.',
    repo_not_found: 'GitHub has no such repository, or the App cannot see it.',
    no_free_port: 'Every site port is taken. Delete a project or widen the range with AEGIS_SITES_PORT_BASE.',
    github_unreachable: 'Aegis could not reach github.com. Check outbound HTTPS from this server.',
    needs_build: 'That branch holds source, not a built site. Fill in an install and build command above, or publish the build output to a branch or a subfolder whose root has index.html, then point Aegis at it.',
    no_index: 'No index.html at the root of that branch. Point the subfolder field at the folder holding it.',
    no_root_dir: 'That subfolder does not exist in this branch.',
    bad_root_dir: 'That subfolder leaves the repository.',
    unsafe_symlink: 'The site content contains a symlink or junction, which Aegis refuses to serve. Remove it from the build output.',
    bad_site_config: 'The vercel.json in that branch could not be read. Aegis refuses the deployment rather than serve a site whose config it ignored.',
    runtime_disabled: 'This server does not run application processes. Set AEGIS_DEPLOY_RUNTIME=1 and the runtime accounts on the host, or leave the start command empty and deploy a built site.',
    no_start_cmd: 'Name the command that starts the application.',
    start_failed: 'The start command stopped before it answered. What it printed is in the console above.',
    unhealthy: 'The application never answered on its port. The version that was running is still serving.',
    no_runtime_account: 'Every runtime account on this server is in use. Add one with Create-BuildAccounts.ps1, or remove a project that runs a process.',
    bad_repo: 'Pick a repository from the list.',
    bad_branch: 'That branch name is not one Aegis will pass to git.',
    bad_installation: 'Pick an account above first.',
    github_not_connected: 'No GitHub App is connected on this server.',
    deploy_failed: 'The clone failed. Check that the branch exists and that this server reaches github.com.',
    build_failed: 'The build command failed. What it printed is in the console above.',
    build_account_unconfigured: 'The build sandbox accounts do not exist on this server. Run Create-BuildAccounts.ps1 on the host, or deploy a branch that needs no build.',
    tool_missing: 'This server could not start git or pwsh. Check both are on the PATH of the account Aegis runs as.',
    github_auth_failed: 'GitHub refused the App credentials. Reconnect the App, or check it is still installed on that repository.',
    busy: 'This project is already deploying. Wait for the deployment in progress to finish.',
    needs_install: 'Aegis cannot see that repository. If it is private, install the GitHub App on it; if the URL is wrong, check it.',
    cancelled: 'You stopped this deployment. Nothing changed on the port.',
    branch_gone: 'That branch or repository is gone from GitHub. Check the App still has access to it.',
    poll_failed: 'Aegis could not ask GitHub about this branch. Check outbound HTTPS from this server.',
    unknown_project: 'That site no longer exists. Reload the page.',
    id_unavailable: 'Ninety-nine projects here already share a name like that. Pick a different name.'
};

test('the pinned error table covers the whole of DEPLOY_ERRORS', () => {
    assert.ok(Object.keys(DEPLOY_ERROR_TEXT).length >= 31,
        'expected 31+ codes, got ' + Object.keys(DEPLOY_ERROR_TEXT).length);
});

// --- 1 & 2: request shape and navigation ----------------------------------

test('redeploy sends a POST carrying a fresh runId, and the console is already open on it', async () => {
    const stubs = baseStubs([project()]);
    stubs['projects/proj1/redeploy'] = { success: false, error: 'busy' };
    const { page, close } = await openPage(browser, `${server.url}/pages/deploy.html#projects`, stubs);
    try {
        const seen = [];
        page.on('request', (req) => {
            if (req.method() === 'POST' && req.url().includes('/redeploy')) {
                seen.push({ url: req.url(), postData: req.postData() });
            }
        });

        await clickByText(page, '#deploy-project-list button', 'Deploy latest commit');
        const hashRightAfterClick = await page.evaluate(() => location.hash);
        await waitForNoteChange(page, '#deploy-run-note');

        assert.strictEqual(seen.length, 1, 'expected exactly one redeploy POST');
        assert.ok(seen[0].url.endsWith('/api/deploy/projects/proj1/redeploy'), seen[0].url);
        const body = JSON.parse(seen[0].postData);
        assert.ok(/^[0-9a-f]{24}$/.test(body.runId), 'runId should be 24 hex chars: ' + body.runId);
        assert.deepStrictEqual(Object.keys(body), ['runId']);

        // goTo() runs before deployAction ever calls window.api, so the hash
        // read straight after the synchronous click handler already carries
        // this run's id — well before the stubbed POST could have answered.
        assert.strictEqual(hashRightAfterClick, '#console/' + body.runId);
    } finally {
        await close();
    }
});

test('creating a preview sends the branch with a fresh runId, and opens its console immediately', async () => {
    const stubs = baseStubs([project()]);
    stubs['projects/proj1/previews'] = { success: false, error: 'preview_exists' };
    const { page, close } = await openPage(
        browser, `${server.url}/pages/deploy.html#project/${PROJECT_ID}/previews`, stubs
    );
    try {
        const seen = [];
        page.on('request', (req) => {
            if (req.method() === 'POST' && req.url().includes('/previews')) {
                seen.push({ url: req.url(), postData: req.postData() });
            }
        });

        await page.waitForSelector('input[aria-label="Branch"]');
        await page.type('input[aria-label="Branch"]', 'feature-x');
        await clickByText(page, 'button', 'Deploy this branch');
        const hashRightAfterClick = await page.evaluate(() => location.hash);
        await waitForNoteChange(page, '#deploy-run-note');

        assert.strictEqual(seen.length, 1, 'expected exactly one preview POST');
        assert.ok(seen[0].url.endsWith(`/api/deploy/projects/${PROJECT_ID}/previews`), seen[0].url);
        const body = JSON.parse(seen[0].postData);
        assert.deepStrictEqual(Object.keys(body), ['runId', 'branch']);
        assert.ok(/^[0-9a-f]{24}$/.test(body.runId), 'runId should be 24 hex chars: ' + body.runId);
        assert.strictEqual(body.branch, 'feature-x');

        assert.strictEqual(hashRightAfterClick, '#console/' + body.runId);
    } finally {
        await close();
    }
});

// --- 3: every refusal code, per call site ---------------------------------

test('redeploy maps every refusal code to the message it shows today', async () => {
    const stubs = baseStubs([project()]);
    stubs['projects/proj1/redeploy'] = { success: false, error: 'busy' };
    const { page, close } = await openPage(browser, `${server.url}/pages/deploy.html#projects`, stubs);
    try {
        const rows = Object.keys(DEPLOY_ERROR_TEXT).map((code) => ({ code, expected: DEPLOY_ERROR_TEXT[code] }));
        // redeploy's own errorFor is `DEPLOY_ERRORS[code] || ['deploy_redeploy_busy', 'That
        // project is already deploying.']`, so any code the shared table does not carry
        // reads as "already deploying". unknown_project is a code this route really answers
        // (routes.js:976, the project vanished between page load and click) and used to hit
        // that fallback; it is in the shared table now, so the loop above covers it and the
        // fallback is left for a code nobody has named yet.

        for (const { code, expected } of rows) {
            stubs['projects/proj1/redeploy'] = { success: false, error: code };
            await nextNote(page, '#deploy-run-note');
            await clickByText(page, '#deploy-project-list button', 'Deploy latest commit');
            const text = await waitForNoteChange(page, '#deploy-run-note');
            assert.strictEqual(text, expected, 'code ' + code);
        }
    } finally {
        await close();
    }
});

test('creating a project maps every refusal code to the message it shows today', async () => {
    const stubs = baseStubs([]);
    const { page, close } = await openPage(browser, `${server.url}/pages/deploy.html#new`, stubs);
    try {
        await page.type('#deploy-new-url', 'https://github.com/acme/site');
        await page.type('#deploy-new-branch', 'main');

        // needs_install is deployFrom's own special case (a grant link, not a
        // table lookup) and is tested on its own below.
        const rows = Object.keys(DEPLOY_ERROR_TEXT)
            .filter((code) => code !== 'needs_install')
            .map((code) => ({ code, expected: DEPLOY_ERROR_TEXT[code] }));

        for (const { code, expected } of rows) {
            stubs['deploy/projects'] = { success: false, error: code };
            await nextNote(page, '#deploy-new-note');
            await page.evaluate(() => document.getElementById('deploy-new-btn').click());
            const text = await waitForNoteChange(page, '#deploy-new-note');
            assert.strictEqual(text, expected, 'code ' + code);
        }

        // A code neither DEPLOY_ERRORS nor the 403 branch knows: the generic
        // fallback, naming the code so the operator has something to search
        // the backend log for.
        stubs['deploy/projects'] = { success: false, error: 'totally_unknown_code' };
        await nextNote(page, '#deploy-new-note');
        await page.evaluate(() => document.getElementById('deploy-new-btn').click());
        let text = await waitForNoteChange(page, '#deploy-new-note');
        assert.strictEqual(text,
            'Aegis refused this deployment for a reason this page does not know: ' +
            'totally_unknown_code. The backend log has the detail.');

        // needs_install is special-cased so it can offer a working grant
        // link. It must still show the same wording as the table entry, plus
        // the link the plain table lookup never adds.
        stubs['deploy/projects'] = {
            success: false, error: 'needs_install',
            installUrl: 'https://github.com/apps/aegis-deploy/installations/new'
        };
        await nextNote(page, '#deploy-new-note');
        await page.evaluate(() => document.getElementById('deploy-new-btn').click());
        text = await waitForNoteChange(page, '#deploy-new-note');
        assert.strictEqual(text, DEPLOY_ERROR_TEXT.needs_install);
        const link = await page.$eval('#deploy-new a.dep-btn-link', (a) => ({
            text: a.textContent.trim(), href: a.getAttribute('href')
        }));
        assert.strictEqual(link.text, 'Install the App on GitHub');
        assert.strictEqual(link.href, 'https://github.com/apps/aegis-deploy/installations/new');
    } finally {
        await close();
    }
});

test('creating a preview maps every refusal code to the message it shows today', async () => {
    const stubs = baseStubs([project()]);
    const { page, close } = await openPage(
        browser, `${server.url}/pages/deploy.html#project/${PROJECT_ID}/previews`, stubs
    );
    try {
        await page.waitForSelector('input[aria-label="Branch"]');
        await page.type('input[aria-label="Branch"]', 'feature-x');

        const ownText = {
            branch_is_production: 'That is the branch this project already serves.',
            preview_exists: 'That branch is already deployed here.',
            already_preview: 'A preview cannot have previews of its own.'
        };

        const rows = Object.keys(ownText).map((code) => ({ code, expected: ownText[code] }));
        // previewError overrides no_free_port with a sentence naming previews as
        // something to delete. It used to reuse deploy_new_no_port, the project key, so
        // tr() returned the project wording and the preview sentence never rendered in
        // either language. It has its own key now, which is what this row pins.
        const PREVIEW_NO_PORT = 'Every site port is taken. Delete a project or a preview, ' +
            'or widen the range with AEGIS_SITES_PORT_BASE.';
        for (const code of Object.keys(DEPLOY_ERROR_TEXT)) {
            rows.push({
                code,
                expected: code === 'no_free_port' ? PREVIEW_NO_PORT : DEPLOY_ERROR_TEXT[code]
            });
        }
        rows.push({ code: 'something_new', expected: 'Aegis could not deploy that branch.' });

        for (const { code, expected } of rows) {
            stubs['projects/proj1/previews'] = { success: false, error: code };
            await nextNote(page, '#deploy-run-note');
            await clickByText(page, 'button', 'Deploy this branch');
            const text = await waitForNoteChange(page, '#deploy-run-note');
            assert.strictEqual(text, expected, 'code ' + code);
        }
    } finally {
        await close();
    }
});

test('deployFrom: a 403 with a code neither table knows names only the admin-only refusal', async () => {
    // The one scenario helpers/browser.js's openPage cannot express: an HTTP
    // status other than 200. Reduced to exactly what this page needs — no
    // third-party script on deploy.html, so no CDN shim required.
    const stubs = baseStubs([]);
    stubs['deploy/projects'] = { status: 403, body: { success: false, error: 'forbidden' } };

    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const { pathname } = new URL(req.url());
        const isApi = pathname.split('/').some((seg) => seg === 'api' || seg === 'auth' || seg === 'admin');
        if (isApi) {
            const match = Object.keys(stubs).filter((k) => pathname.includes(k)).sort((a, b) => b.length - a.length)[0];
            const stub = match ? stubs[match] : { success: true };
            return req.respond({
                status: stub.status || 200,
                contentType: 'application/json; charset=utf-8',
                body: JSON.stringify(stub.body !== undefined ? stub.body : stub)
            });
        }
        if (!req.url().startsWith('http://127.0.0.1')) {
            return req.respond({
                status: 200, contentType: 'text/css',
                headers: { 'access-control-allow-origin': '*' }, body: ''
            });
        }
        return req.continue();
    });

    try {
        await page.goto(`${server.url}/pages/deploy.html#new`, { waitUntil: 'networkidle2', timeout: 20000 });
        await page.type('#deploy-new-url', 'https://github.com/acme/site');
        await page.evaluate(() => document.getElementById('deploy-new-btn').click());
        const text = await waitForNoteChange(page, '#deploy-new-note');
        assert.strictEqual(text, 'Only an administrator can connect GitHub.');
        assert.deepStrictEqual(pageErrors, []);
    } finally {
        await context.close();
    }
});

// --- 4: the refusals reference pane ---------------------------------------

// The rows the pane draws, in order: `REFUSAL_ORDER` in deploy.js names the
// codes, and each short label is element 2 and 3 of that code's DEPLOY_ERRORS
// entry. Both columns therefore come from one table now, which is why the
// "fix" column below is always DEPLOY_ERROR_TEXT[code] and never the "no fix
// on record" empty case. The order is asserted, not just the set.
const REFUSAL_REFERENCE = [
    { code: 'bad_repo_url', name: 'Not a github.com repository URL' },
    { code: 'needs_install', name: 'Aegis cannot see the repository' },
    { code: 'repo_not_found', name: 'GitHub has no such repository' },
    { code: 'bad_branch', name: 'A branch name Aegis will not pass to git' },
    { code: 'needs_build', name: 'The branch holds source, not a site' },
    { code: 'no_index', name: 'No index.html in the served directory' },
    { code: 'no_root_dir', name: 'That subfolder is not in this branch' },
    { code: 'bad_root_dir', name: 'The subfolder path leaves the repository' },
    { code: 'unsafe_symlink', name: 'A symlink or junction in what would be served' },
    { code: 'bad_site_config', name: 'The vercel.json in that branch will not parse' },
    { code: 'no_free_port', name: 'All 100 site ports are taken' },
    { code: 'deploy_failed', name: 'The clone itself failed' },
    { code: 'build_failed', name: 'The install or build command exited non-zero' },
    { code: 'build_account_unconfigured', name: 'The build sandbox accounts are missing on the host' },
    { code: 'tool_missing', name: 'git or pwsh could not be started' },
    { code: 'github_auth_failed', name: 'GitHub refused the App credentials' },
    { code: 'github_unreachable', name: 'Aegis could not reach github.com' },
    { code: 'busy', name: 'A deployment of this project is already running' },
    { code: 'branch_gone', name: 'The branch or repository disappeared' }
];

test('the refusals reference pane renders the pinned table of codes and meanings', async () => {
    const stubs = baseStubs([project()]);
    const { page, close } = await openPage(browser, `${server.url}/pages/deploy.html#refusals`, stubs);
    try {
        const rows = await page.$$eval('#deploy-refusal-list .dep-listrow', (nodes) => nodes.map((n) => ({
            code: n.querySelector('code').textContent.trim(),
            name: n.querySelector('.dep-listrow-name').textContent.trim(),
            fix: n.querySelector('.dep-listrow-sub') ? n.querySelector('.dep-listrow-sub').textContent.trim() : null
        })));

        const expected = REFUSAL_REFERENCE.map(({ code, name }) => ({
            code, name, fix: DEPLOY_ERROR_TEXT[code]
        }));

        assert.deepStrictEqual(rows, expected);
    } finally {
        await close();
    }
});
