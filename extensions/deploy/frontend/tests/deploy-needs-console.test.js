/**
 * Tier 3 — the dependency question, and a console that follows the build.
 *
 * Two things an operator met on the same KPI deployment:
 *
 * - The site needed openpyxl and nothing installed it. The refusal
 *   `needs_dependencies` now carries `needs`, and the card, the overview and
 *   the console ask "<site> needs <packages> to run. Do you want to install
 *   it?" with Yes and No. Yes saves the install command and deploys again.
 * - The console could not be followed: every poll took the log out of the
 *   document and put it back, which reset its scroll to the first line, and a
 *   poll overtaken by the next one painted every line twice.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const harness = require('./harness');
if (!harness.available) {
    test('the dependency question and the console, inside the Aegis shell', { skip: harness.why }, () => {});
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

const STATUS_OK = {
    success: true,
    enabled: true,
    github: { connected: true, appId: 1, slug: 'acme' },
    detection: 'webhook',
    webhookUrl: null,
    capabilities: { projects: true, builds: true, runtimes: true }
};

const ME_ADMIN = { loggedIn: true, tenant: 'test', userId: 1, email: 'admin@example.com', role: 'admin' };

const NEEDS = {
    kind: 'python',
    file: 'packaging/api/requirements.txt',
    packages: ['openpyxl'],
    installCmd: 'python -m pip install --no-cache-dir -r packaging/api/requirements.txt --target .',
    preview: false
};

function kpi(overrides) {
    return Object.assign({
        id: 'kpi-briconord',
        name: 'kpi-briconord',
        repoFullName: 'acme/kpi',
        branch: 'aegis',
        rootDir: null,
        installCmd: null,
        buildCmd: null,
        outputDir: null,
        lastSha: 'abcdef0123456789',
        previousSha: null,
        deployedAt: Date.now() - 60000,
        lastError: 'needs_dependencies',
        needs: NEEDS,
        failureCount: 1,
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
        runtime: 'node',
        startCmd: 'python packaging/api/kpi_api.py',
        running: true,
        parentId: null,
        previews: []
    }, overrides || {});
}

function lines(from, to) {
    const out = [];
    for (let i = from; i < to; i++) out.push({ at: Date.now(), text: `line ${i}` });
    return out;
}

/** A run body as `runs.snapshot` sends it, holding lines [from, to). */
function runBody(from, to, extra) {
    return {
        success: true,
        run: Object.assign({
            id: 'r1',
            cursor: to,
            projectId: 'kpi-briconord',
            projectName: 'kpi-briconord',
            branch: 'aegis',
            sha: 'abcdef01',
            trigger: 'manual',
            actor: 'tester',
            status: 'running',
            error: null,
            needs: null,
            startedAt: Date.now(),
            endedAt: null,
            stages: [{ key: 'clone', status: 'running', startedAt: Date.now(), endedAt: null, detail: null }],
            lines: lines(from, to),
            resync: false
        }, extra || {})
    };
}

function stubs(list) {
    return {
        'deploy/status': STATUS_OK,
        'auth/me': ME_ADMIN,
        'deploy/projects': { success: true, projects: list },
        'deploy/runs/': runBody(0, 0)
    };
}

test('the card asks whether to install what the site needs, by name', async () => {
    const { page, close } = await openPage(browser, `${server.url}/pages/deploy.html#projects`, stubs([kpi()]));
    try {
        await page.waitForSelector('#deploy-project-list .dep-needs');
        const box = await page.$eval('#deploy-project-list .dep-needs', (n) => ({
            question: n.querySelector('.dep-needs-question').textContent.trim(),
            command: n.querySelector('.dep-needs-how code').textContent.trim(),
            buttons: [...n.querySelectorAll('button')].map((b) => b.textContent.trim())
        }));
        assert.strictEqual(box.question, 'kpi-briconord needs openpyxl to run. Do you want to install it?');
        assert.strictEqual(box.command, NEEDS.installCmd);
        assert.deepStrictEqual(box.buttons, ['Yes, install and deploy', 'No']);
    } finally {
        await close();
    }
});

test('Yes saves the install command, then deploys again', async () => {
    const s = stubs([kpi()]);
    s['projects/kpi-briconord/settings'] = { success: true, changed: ['installCmd'] };
    s['projects/kpi-briconord/redeploy'] = { success: false, error: 'busy' };
    const { page, close } = await openPage(browser, `${server.url}/pages/deploy.html#projects`, s);
    try {
        const seen = [];
        page.on('request', (req) => {
            if (req.method() === 'PATCH' || req.method() === 'POST') {
                seen.push({ method: req.method(), path: new URL(req.url()).pathname, body: req.postData() });
            }
        });
        await page.waitForSelector('#deploy-project-list .dep-needs');
        await page.evaluate(() => {
            [...document.querySelectorAll('#deploy-project-list .dep-needs button')]
                .find((b) => b.textContent.trim() === 'Yes, install and deploy').click();
        });
        await page.waitForFunction(() => location.hash.indexOf('#console/') === 0, { timeout: 5000 });

        const patch = seen.find((r) => r.method === 'PATCH');
        assert.ok(patch, 'no PATCH sent');
        assert.match(patch.path, /\/api\/deploy\/projects\/kpi-briconord\/settings$/);
        assert.deepStrictEqual(JSON.parse(patch.body), { installCmd: NEEDS.installCmd });

        const post = seen.find((r) => r.method === 'POST' && /\/redeploy$/.test(r.path));
        assert.ok(post, 'no redeploy after saving');
        assert.ok(seen.indexOf(patch) < seen.indexOf(post), 'deployed before the command was saved');
    } finally {
        await close();
    }
});

test('No changes nothing and says what that means', async () => {
    const { page, close } = await openPage(browser, `${server.url}/pages/deploy.html#projects`, stubs([kpi()]));
    try {
        const writes = [];
        page.on('request', (req) => { if (req.method() !== 'GET') writes.push(req.url()); });
        await page.waitForSelector('#deploy-project-list .dep-needs');
        await page.evaluate(() => {
            [...document.querySelectorAll('#deploy-project-list .dep-needs button')]
                .find((b) => b.textContent.trim() === 'No').click();
        });
        const note = await page.$eval('#deploy-project-list .dep-needs .dep-note', (n) => n.textContent.trim());
        assert.match(note, /^Nothing installed\. .* will not start without openpyxl\./);
        assert.deepStrictEqual(writes, []);
    } finally {
        await close();
    }
});

test('a preview is told where to answer, and offered no buttons', async () => {
    const list = [kpi({ needs: Object.assign({}, NEEDS, { preview: true }) })];
    const { page, close } = await openPage(browser, `${server.url}/pages/deploy.html#projects`, stubs(list));
    try {
        await page.waitForSelector('#deploy-project-list .dep-needs');
        const buttons = await page.$$eval('#deploy-project-list .dep-needs button', (n) => n.length);
        assert.strictEqual(buttons, 0);
    } finally {
        await close();
    }
});

test('the console asks the same question when the run stops on it', async () => {
    const s = stubs([kpi()]);
    s['deploy/runs/'] = runBody(0, 3, {
        status: 'failed', error: 'needs_dependencies', needs: NEEDS, endedAt: Date.now()
    });
    const { page, close } = await openPage(browser, `${server.url}/pages/deploy.html#console/r1`, s);
    try {
        await page.waitForSelector('#deploy-run-needs .dep-needs-question', { timeout: 5000 });
        const q = await page.$eval('#deploy-run-needs .dep-needs-question', (n) => n.textContent.trim());
        assert.strictEqual(q, 'kpi-briconord needs openpyxl to run. Do you want to install it?');
    } finally {
        await close();
    }
});

const logState = () => {
    const log = document.getElementById('deploy-run-log');
    return {
        count: log.querySelectorAll('.dep-log-line:not(.dep-log-wait)').length,
        texts: [...log.querySelectorAll('.dep-log-text')].map((n) => n.textContent),
        atBottom: log.scrollTop + log.clientHeight >= log.scrollHeight - 2,
        scrollTop: log.scrollTop,
        scrollable: log.scrollHeight > log.clientHeight
    };
};

test('the console stays anchored to its last line, poll after poll', async () => {
    const s = stubs([kpi()]);
    s['deploy/runs/'] = runBody(0, 80);
    const { page, close } = await openPage(browser, `${server.url}/pages/deploy.html#console/r1`, s);
    try {
        await page.waitForFunction(() => document.querySelectorAll('#deploy-run-log .dep-log-text').length >= 80,
            { timeout: 5000 });
        // Several polls with nothing new: the old code put the log back at its
        // first line on each of them.
        await new Promise((r) => setTimeout(r, 1600));
        let st = await page.evaluate(logState);
        assert.ok(st.scrollable, 'the fixture does not overflow the log');
        assert.ok(st.atBottom, `left the last line: scrollTop ${st.scrollTop}`);

        // New lines arrive: the view follows them.
        s['deploy/runs/'] = runBody(80, 120);
        await page.waitForFunction(() => document.querySelectorAll('#deploy-run-log .dep-log-text').length >= 120,
            { timeout: 5000 });
        await new Promise((r) => setTimeout(r, 700));
        st = await page.evaluate(logState);
        assert.ok(st.atBottom, 'did not follow the new lines');

        // The reader scrolls up to read something: the next lines do not pull
        // them away from it.
        await page.evaluate(() => {
            const log = document.getElementById('deploy-run-log');
            log.scrollTop = 0;
            log.dispatchEvent(new Event('scroll'));
        });
        s['deploy/runs/'] = runBody(120, 140);
        await page.waitForFunction(() => document.querySelectorAll('#deploy-run-log .dep-log-text').length >= 140,
            { timeout: 5000 });
        await new Promise((r) => setTimeout(r, 700));
        st = await page.evaluate(logState);
        assert.strictEqual(st.scrollTop, 0, 'the reader was snatched back to the bottom');

        // Back at the bottom, it follows again.
        await page.evaluate(() => {
            const log = document.getElementById('deploy-run-log');
            log.scrollTop = log.scrollHeight;
            log.dispatchEvent(new Event('scroll'));
        });
        s['deploy/runs/'] = runBody(140, 160);
        await page.waitForFunction(() => document.querySelectorAll('#deploy-run-log .dep-log-text').length >= 160,
            { timeout: 5000 });
        await new Promise((r) => setTimeout(r, 700));
        st = await page.evaluate(logState);
        assert.ok(st.atBottom, 'did not anchor again once back at the bottom');
    } finally {
        await close();
    }
});

test('an answer repeating lines the console already holds paints none of them twice', async () => {
    const s = stubs([kpi()]);
    // The same body on every poll: what two overlapping polls with one cursor
    // used to receive.
    s['deploy/runs/'] = runBody(0, 5);
    const { page, close } = await openPage(browser, `${server.url}/pages/deploy.html#console/r1`, s);
    try {
        await page.waitForFunction(() => document.querySelectorAll('#deploy-run-log .dep-log-text').length >= 5,
            { timeout: 5000 });
        await new Promise((r) => setTimeout(r, 1600));
        // Overlapping from line 3: only 5 and 6 are new.
        s['deploy/runs/'] = runBody(3, 7);
        await page.waitForFunction(() => document.querySelectorAll('#deploy-run-log .dep-log-text').length >= 7,
            { timeout: 5000 });
        await new Promise((r) => setTimeout(r, 1100));
        const st = await page.evaluate(logState);
        assert.deepStrictEqual(st.texts, ['line 0', 'line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6']);
    } finally {
        await close();
    }
});
