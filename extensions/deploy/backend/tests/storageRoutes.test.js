/**
 * The storage routes.
 *
 * Driven through a router that collects handlers, with a real project store in
 * a temporary tenant folder and fakes for what core lends. Three properties are
 * the reason this file exists: no answer ever carries the database password, a
 * password is kept only once the database accepted it, and the switch asks for
 * the administrator's password before it touches anything.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-storage-routes-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;

const test = require('node:test');
const assert = require('node:assert');

const storageRoutes = require('../storageRoutes');
const projectStore = require('../projectStore');
const projectStorage = require('../projectStorage');
const runtime = require('../runtime');
const deployService = require('../deployService');
const storageNetwork = require('../storageNetwork');
const { fakeDatabase, fakeReader } = require('./helpers/fakePg');

console.log = () => { };
console.warn = () => { };
console.error = () => { };

const TARGET = { kind: 'supabase', host: '10.0.0.10', port: 5432, database: 'postgres', user: 'postgres.acme', ssl: false, consoleUrl: 'http://10.0.0.10:8000' };
const SECRET = 'db-p@ssw0rd-typed-once';

/** Collects what `register` mounts, and runs one route's chain like Express would. */
function fakeRouter() {
    const routes = [];
    const router = {};
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        router[method] = (route, ...handlers) => routes.push({ method, route, handlers });
    }
    router.routes = routes;
    router.call = async (method, route, req) => {
        const found = routes.find((r) => r.method === method && r.route === route);
        assert.ok(found, `no route ${method} ${route}`);
        const res = {
            statusCode: 200, body: null,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
        for (const handler of found.handlers) {
            let went = false;
            await handler(req, res, () => { went = true; });
            if (!went) break;
        }
        return res;
    };
    return router;
}

/** A tenant with one published process project, and a host that runs processes. */
function world(over) {
    const slug = `t${Math.random().toString(36).slice(2, 8)}`;
    const root = path.join(DATA_ROOT, 'tenants', slug);
    const tenantPaths = { root, deploy: path.join(root, 'deploy') };

    const project = Object.assign({ id: 'site', name: 'Site', runtime: 'node', startCmd: 'python app.py', port: 3150, lastSha: 'abc123', branch: 'main' }, (over && over.project) || {});
    projectStore.saveProject(tenantPaths, project);

    // The version on the port, with its Postgres migrations.
    const current = projectStore.currentDir(tenantPaths, project.id);
    fs.mkdirSync(path.join(current, 'migrations', 'postgres'), { recursive: true });
    fs.writeFileSync(path.join(current, 'migrations', 'postgres', '0001_init.sql'), 'CREATE TABLE sites');

    const w = {
        slug, tenantPaths,
        db: { tables: {}, migrate(sql, d) { d.tables.sites = { columns: [{ name: 'id' }, { name: 'name' }], rows: [] }; } },
        connects: [],
        asked: []
    };
    w.router = fakeRouter();
    const caps = Object.assign({
        postgres: {
            connect: async (opts) => {
                w.connects.push(opts);
                if (opts.password !== SECRET) throw new Error('password authentication failed');
                const client = fakeDatabase(w.db);
                const query = client.query;
                let snap = null;
                client.query = async (sql, params) => {
                    if (sql === 'SHOW server_version_num') return { rows: [{ v: '150004' }] };
                    if (sql.startsWith('CREATE TABLE aegis_probe_')) return { rows: [] };
                    if (sql === 'BEGIN') snap = JSON.stringify({ tables: w.db.tables, ledger: w.db.ledger });
                    if (sql === 'ROLLBACK' && snap) { const s = JSON.parse(snap); w.db.tables = s.tables; w.db.ledger = s.ledger; }
                    return query(sql, params);
                };
                return client;
            }
        },
        reauthenticate: async (req) => {
            w.asked.push(req.body && req.body.password);
            return req.body && req.body.password === 'admin-password' ? { email: 'admin@acme.test' } : null;
        },
        readOnlyDb: fakeReader({ sites: { columns: ['id', 'name'], rows: [[1, 'Plant A']] } })
    }, (over && over.caps) || {});

    storageRoutes.register(w.router, Object.assign({
        tcp: async () => ({ ok: true, why: '' }),
        settleMs: 0,
        requireOptIn: (req, res, next) => next(),
        requireRole: (role) => (req, res, next) => (req.role === role ? next() : res.status(403).json({ success: false, error: 'forbidden' })),
        projectOr404: (req, res) => {
            const p = projectStore.getProject(req.tenantPaths, req.params.id);
            if (!p) { res.status(404).json({ success: false, error: 'unknown_project' }); return null; }
            return p;
        }
    }, caps));

    w.req = (body, role) => ({
        role: role || 'admin', body: body || {}, params: { id: 'site' },
        tenant: { slug }, tenantPaths, user: { email: 'admin@acme.test' }
    });
    w.project = () => projectStore.getProject(tenantPaths, 'site');
    return w;
}

function approve(text) {
    fs.mkdirSync(path.dirname(projectStorage.targetsFile()), { recursive: true });
    fs.writeFileSync(projectStorage.targetsFile(), text);
}

/** The host runs processes, and the start of one is replaced by a record of it. */
async function onHost(fn) {
    const before = [process.env.AEGIS_DEPLOY_RUNTIME, process.env.AEGIS_RUNTIME_ACCOUNTS];
    process.env.AEGIS_DEPLOY_RUNTIME = '1';
    process.env.AEGIS_RUNTIME_ACCOUNTS = 'run-a';
    const real = { start: deployService.startCurrent, stop: runtime.stop, inspect: storageNetwork.inspect };
    const events = [];
    deployService.startCurrent = async ({ project }) => { events.push(`start ${projectStorage.mode(project)}`); return { port: 3400 }; };
    runtime.stop = () => { events.push('stop'); return true; };
    storageNetwork.inspect = async () => ({ ok: true, blocked: false, managed: false });
    try {
        return await fn(events);
    } finally {
        deployService.startCurrent = real.start;
        runtime.stop = real.stop;
        storageNetwork.inspect = real.inspect;
        if (before[0] === undefined) delete process.env.AEGIS_DEPLOY_RUNTIME; else process.env.AEGIS_DEPLOY_RUNTIME = before[0];
        if (before[1] === undefined) delete process.env.AEGIS_RUNTIME_ACCOUNTS; else process.env.AEGIS_RUNTIME_ACCOUNTS = before[1];
    }
}

const BASE = '/api/deploy/projects/:id/storage';

test('every storage route is mounted behind the opt-in and the admin role', async () => {
    const w = world();
    assert.deepStrictEqual(w.router.routes.map((r) => `${r.method} ${r.route}`).sort(), [
        `get ${BASE}`, `get ${BASE}/summary`, `post ${BASE}/check`, `post ${BASE}/preview`, `post ${BASE}/switch`
    ]);
    for (const r of w.router.routes) {
        assert.strictEqual(r.handlers.length, 3, `${r.route} is not opt-in + role + handler`);
        const res = await w.router.call(r.method, r.route, w.req({}, 'member'));
        assert.strictEqual(res.statusCode, 403, `${r.method} ${r.route} answered a member`);
    }
});

test('the source takes no SQL from a request and never names a decrypted password in an answer', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'storageRoutes.js'), 'utf8');
    assert.doesNotMatch(src, /body\.sql|query\.sql|execScript/);
    // `passwordOf` is read to connect. It must never sit inside a res.json(...).
    for (const m of src.matchAll(/res\.json\(([\s\S]*?)\);/g)) {
        assert.doesNotMatch(m[1], /passwordOf|password:/, 'an answer names the database password');
    }
});

test('the first route says what the gear can offer, and why not', async () => {
    await onHost(async () => {
        const w = world();
        const res = await w.router.call('get', BASE, w.req());
        assert.deepStrictEqual(res.body, {
            success: true, available: true, reason: null, capable: true,
            dbFile: 'app.db', migrationsDir: 'migrations/postgres', variable: 'DATABASE_URL',
            storage: { mode: 'local', target: null, hasPassword: false, canReplace: false, switchedAt: null, switchedBy: null },
            approved: null, approveCommand: null
        });

        const stat = world({ project: { runtime: 'static' } });
        assert.deepStrictEqual((await stat.router.call('get', BASE, stat.req())).body.reason, 'static_project');
        const prev = world({ project: { parentId: 'parent' } });
        assert.deepStrictEqual((await prev.router.call('get', BASE, prev.req())).body.reason, 'preview');
        const old = world({ caps: { postgres: undefined } });
        assert.strictEqual((await old.router.call('get', BASE, old.req())).body.capable, false);
    });
    const off = world();
    const res = await off.router.call('get', BASE, off.req());
    assert.deepStrictEqual([res.body.available, res.body.reason], [false, 'runtime_off']);
});

test('check: a bad field is a 400 by name and nothing is saved', async () => {
    await onHost(async () => {
        const w = world();
        const res = await w.router.call('post', `${BASE}/check`, w.req({ target: Object.assign({}, TARGET, { host: 'http://db' }) }));
        assert.deepStrictEqual([res.statusCode, res.body.error], [400, 'bad_host']);
        assert.strictEqual(w.project().storage, undefined);
    });
});

test('check: an unapproved address answers with the command, and is never contacted', async () => {
    await onHost(async () => {
        approve('');
        const w = world();
        const res = await w.router.call('post', `${BASE}/check`, w.req({ target: TARGET, password: SECRET }));

        assert.strictEqual(res.body.ok, false);
        assert.strictEqual(res.body.approved, false);
        assert.strictEqual(res.body.checks.find((c) => c.id === 'approved').command, res.body.approveCommand);
        assert.match(res.body.approveCommand, /-Value '10\.0\.0\.10:5432'$/);
        assert.strictEqual(w.connects.length, 0);
        assert.strictEqual(w.project().storage.host, '10.0.0.10', 'the target is saved so the page can come back to it');
        assert.strictEqual(res.body.storage.hasPassword, false, 'a password nobody verified was kept');
    });
});

test('check: a password is kept only once the database accepted it, and no answer carries it', async () => {
    await onHost(async () => {
        approve('10.0.0.10:5432\n');
        const w = world();

        const wrong = await w.router.call('post', `${BASE}/check`, w.req({ target: TARGET, password: 'typo' }));
        assert.strictEqual(wrong.body.checks.find((c) => c.id === 'login').code, 'refused');
        assert.strictEqual(wrong.body.storage.hasPassword, false, 'a typo was stored');

        const right = await w.router.call('post', `${BASE}/check`, w.req({ target: TARGET, password: SECRET }));
        assert.strictEqual(right.body.ok, true, JSON.stringify(right.body.checks));
        assert.strictEqual(right.body.storage.hasPassword, true);
        assert.strictEqual(right.body.storage.mode, 'local', 'checking is not switching');
        assert.ok(!JSON.stringify(right.body).includes(SECRET));
        assert.ok(!fs.readFileSync(path.join(w.tenantPaths.deploy, 'projects.json'), 'utf8').includes(SECRET), 'the password is in clear on disk');

        // A blank password field now means the one that was kept.
        const blank = await w.router.call('post', `${BASE}/check`, w.req({ target: TARGET, password: '' }));
        assert.strictEqual(blank.body.ok, true);
        assert.strictEqual(w.connects[w.connects.length - 1].password, SECRET);
    });
});

test('preview: rehearses the copy and leaves the database as it was', async () => {
    await onHost(async () => {
        approve('10.0.0.10:5432\n');
        const w = world();
        await w.router.call('post', `${BASE}/check`, w.req({ target: TARGET, password: SECRET }));

        const res = await w.router.call('post', `${BASE}/preview`, w.req());
        assert.strictEqual(res.body.ok, true);
        assert.deepStrictEqual(res.body.tables, [{ name: 'sites', rows: 1, state: 'ok', missingColumns: [], copied: 1, replaced: 0 }]);
        assert.deepStrictEqual(res.body.migrations, ['0001_init.sql']);
        assert.deepStrictEqual(res.body.withoutRls, ['sites'], 'a Supabase target is told which tables its API would serve');
        assert.deepStrictEqual(w.db.tables, {}, 'the rehearsal left something in the database');

        approve('');
        const gone = await w.router.call('post', `${BASE}/preview`, w.req());
        assert.deepStrictEqual([gone.statusCode, gone.body.error], [409, 'not_approved']);
    });
});

test('switch: the administrator\'s password comes first, and a wrong one touches nothing', async () => {
    await onHost(async (events) => {
        approve('10.0.0.10:5432\n');
        const w = world();
        await w.router.call('post', `${BASE}/check`, w.req({ target: TARGET, password: SECRET }));
        const before = w.connects.length;

        const res = await w.router.call('post', `${BASE}/switch`, w.req({ to: 'postgres', password: 'not-it' }));
        assert.deepStrictEqual([res.statusCode, res.body.error], [403, 'password']);
        assert.deepStrictEqual(events, []);
        assert.strictEqual(w.connects.length, before);
        assert.strictEqual(projectStorage.mode(w.project()), 'local');

        assert.strictEqual((await w.router.call('post', `${BASE}/switch`, w.req({ to: 'sideways', password: 'admin-password' }))).body.error, 'bad_mode');
    });
});

test('switch: there and back, with the summary in between', async () => {
    await onHost(async (events) => {
        approve('10.0.0.10:5432\n');
        const w = world();
        await w.router.call('post', `${BASE}/check`, w.req({ target: TARGET, password: SECRET }));

        const there = await w.router.call('post', `${BASE}/switch`, w.req({ to: 'postgres', password: 'admin-password' }));
        assert.strictEqual(there.body.ok, true, JSON.stringify(there.body.steps));
        assert.deepStrictEqual(events, ['stop', 'start postgres']);
        assert.strictEqual(there.body.storage.mode, 'postgres');
        assert.strictEqual(there.body.storage.switchedBy, 'admin@acme.test');
        assert.deepStrictEqual(w.db.tables.sites.rows, [{ id: 1, name: 'Plant A' }]);
        assert.ok(!JSON.stringify(there.body).includes(SECRET));
        assert.strictEqual(deployService.isDeploying(w.slug, 'site'), false, 'the project stayed locked');

        const summary = await w.router.call('get', `${BASE}/summary`, w.req());
        assert.deepStrictEqual(summary.body, {
            success: true,
            target: { host: '10.0.0.10', port: 5432, database: 'postgres', kind: 'supabase' },
            consoleUrl: 'http://10.0.0.10:8000/',
            healthy: true, tables: [{ name: 'sites', rows: 1 }], more: false
        });

        // Asking for the switch again is refused before anything is read or stopped.
        const twice = await w.router.call('post', `${BASE}/switch`, w.req({ to: 'postgres', password: 'admin-password', replace: true }));
        assert.deepStrictEqual([twice.statusCode, twice.body.error], [409, 'already_on_postgres']);
        assert.deepStrictEqual(events, ['stop', 'start postgres'], 'a second switch stopped the site');

        // An address taken off the list is not contacted for the Data tab either.
        approve('');
        const offList = await w.router.call('get', `${BASE}/summary`, w.req());
        assert.deepStrictEqual([offList.body.healthy, offList.body.error], [false, 'not_approved']);
        approve('10.0.0.10:5432\n');

        // Live on one database: moving to another by editing a field is refused.
        const moved = await w.router.call('post', `${BASE}/check`, w.req({ target: Object.assign({}, TARGET, { database: 'other' }) }));
        assert.deepStrictEqual([moved.statusCode, moved.body.error], [409, 'switch_back_first']);

        const back = await w.router.call('post', `${BASE}/switch`, w.req({ to: 'local', password: 'admin-password' }));
        assert.strictEqual(back.body.ok, true);
        assert.strictEqual(back.body.storage.mode, 'local');
        assert.strictEqual(back.body.storage.hasPassword, true, 'the connection is kept for a later switch');
        assert.strictEqual(events[events.length - 1], 'start local');

        const none = await w.router.call('get', `${BASE}/summary`, w.req());
        assert.deepStrictEqual([none.statusCode, none.body.error], [409, 'not_on_postgres']);

        // Switching again. The database holds the rows of the first switch, so
        // the rehearsal refuses, and the record says a replace may be asked for.
        assert.strictEqual(back.body.storage.canReplace, true);
        const refused = await w.router.call('post', `${BASE}/preview`, w.req());
        assert.deepStrictEqual([refused.body.ok, refused.body.tables[0].state], [false, 'not_empty']);
        const replaced = await w.router.call('post', `${BASE}/preview`, w.req({ replace: true }));
        assert.deepStrictEqual([replaced.body.ok, replaced.body.tables[0].state, replaced.body.tables[0].replaced], [true, 'ok', 1]);

        // An internal network access set on the Settings tab is another
        // decision: it neither stops the switch nor is undone by it.
        const egress = { host: '192.0.2.98', port: 1433 };
        projectStore.saveProject(w.tenantPaths, Object.assign({}, w.project(), { egress }), { egress: true });

        const again = await w.router.call('post', `${BASE}/switch`, w.req({ to: 'postgres', password: 'admin-password', replace: true }));
        assert.strictEqual(again.body.ok, true, JSON.stringify(again.body.steps));
        assert.deepStrictEqual(w.db.tables.sites.rows, [{ id: 1, name: 'Plant A' }], 'the rows were doubled or lost');
        assert.deepStrictEqual(w.project().egress, egress, 'the switch took the network access off the record');
    });
});

test('switch: refused while a deployment holds the project', async () => {
    await onHost(async (events) => {
        approve('10.0.0.10:5432\n');
        const w = world();
        await w.router.call('post', `${BASE}/check`, w.req({ target: TARGET, password: SECRET }));

        let release;
        const holding = deployService.exclusive(w.slug, 'site', () => new Promise((r) => { release = r; }));
        const res = await w.router.call('post', `${BASE}/switch`, w.req({ to: 'postgres', password: 'admin-password' }));
        release();
        await holding;

        assert.deepStrictEqual([res.statusCode, res.body.error], [409, 'deploy_in_progress']);
        assert.deepStrictEqual(events, []);
    });
});

test('summary: a database that does not answer is an answer, not a 500', async () => {
    await onHost(async () => {
        approve('10.0.0.10:5432\n');
        const w = world();
        await w.router.call('post', `${BASE}/check`, w.req({ target: TARGET, password: SECRET }));
        await w.router.call('post', `${BASE}/switch`, w.req({ to: 'postgres', password: 'admin-password' }));

        const p = w.project();
        p.storage.passwordEnc = projectStorage.withTarget({ id: 'x' }, projectStorage.normalise(TARGET), 'rotated-elsewhere').passwordEnc;
        projectStore.saveProject(w.tenantPaths, p, { storage: true });

        const res = await w.router.call('get', `${BASE}/summary`, w.req());
        assert.deepStrictEqual([res.statusCode, res.body.healthy, res.body.detail], [200, false, 'password authentication failed']);
    });
});

test('an Aegis without the capabilities refuses the routes that would need them', async () => {
    await onHost(async () => {
        const w = world({ caps: { reauthenticate: undefined } });
        for (const route of [`${BASE}/preview`, `${BASE}/switch`]) {
            const res = await w.router.call('post', route, w.req({ to: 'postgres', password: 'admin-password' }));
            assert.deepStrictEqual([res.statusCode, res.body.error], [501, 'core_too_old'], route);
        }
    });
});

test('replace is ignored for a database this project never filled', async () => {
    await onHost(async () => {
        approve('10.0.0.10:5432\n');
        const w = world();
        // Somebody else's rows, in a table of the same name.
        w.db.tables.sites = { columns: [{ name: 'id' }, { name: 'name' }], rows: [{ id: 99, name: 'somebody else' }] };
        w.db.migrate = () => { };
        await w.router.call('post', `${BASE}/check`, w.req({ target: TARGET, password: SECRET }));

        const res = await w.router.call('post', `${BASE}/preview`, w.req({ replace: true }));
        assert.deepStrictEqual([res.body.ok, res.body.tables[0].state], [false, 'not_empty']);

        const sw = await w.router.call('post', `${BASE}/switch`, w.req({ to: 'postgres', password: 'admin-password', replace: true }));
        assert.deepStrictEqual([sw.body.ok, sw.body.failed], [false, 'rehearsal']);
        assert.deepStrictEqual(w.db.tables.sites.rows, [{ id: 99, name: 'somebody else' }]);
    });
});

test('a save by anything else leaves the storage of a switched project as it is', async () => {
    await onHost(async () => {
        approve('10.0.0.10:5432\n');
        const w = world();
        const stale = w.project();        // what a poller sweep read before the switch
        await w.router.call('post', `${BASE}/check`, w.req({ target: TARGET, password: SECRET }));
        await w.router.call('post', `${BASE}/switch`, w.req({ to: 'postgres', password: 'admin-password' }));
        assert.strictEqual(projectStorage.mode(w.project()), 'postgres');

        // The sweep reaches this project minutes later and records a commit.
        const stored = projectStore.saveProject(w.tenantPaths, Object.assign({}, stale, { lastSeenSha: 'feedface' }));
        assert.strictEqual(stored.lastSeenSha, 'feedface');
        assert.strictEqual(projectStorage.mode(w.project()), 'postgres', 'a stale save put the project back on its old file');
        assert.strictEqual(projectStorage.passwordOf(w.project()), SECRET);
        assert.strictEqual(stale.storage, undefined, 'the caller\'s own object must not be rewritten under it');

        // And a record that never had storage does not gain one from a caller.
        const plain = world();
        projectStore.saveProject(plain.tenantPaths, Object.assign({}, plain.project(), { storage: { mode: 'postgres', host: 'x' } }));
        assert.strictEqual(plain.project().storage, undefined);
    });
});

test('check keeps what a deployment saved while the checks were running', async () => {
    await onHost(async () => {
        approve('10.0.0.10:5432\n');
        const w = world({
            caps: {
                // A deployment finishes in the middle of the checks.
                tcp: async () => {
                    const p = projectStore.getProject(w.tenantPaths, 'site');
                    projectStore.saveProject(w.tenantPaths, Object.assign({}, p, { lastSha: 'newer-commit' }));
                    return { ok: true, why: '' };
                }
            }
        });
        const res = await w.router.call('post', `${BASE}/check`, w.req({ target: TARGET, password: SECRET }));
        assert.strictEqual(res.body.storage.hasPassword, true);
        assert.strictEqual(w.project().lastSha, 'newer-commit', 'the second save of check put the old commit back');
    });
});
