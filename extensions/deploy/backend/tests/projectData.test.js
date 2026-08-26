/**
 * Which files a request may name inside a project's data folder, and the three
 * routes that read them.
 *
 * The containment check is the whole security of this feature. Aegis runs as
 * SYSTEM on a domain's audit server, so a file name that escapes the project's
 * own folder reads anything on the machine, and the folder it escapes from is
 * one a deployed application writes to. Every escape this file tries is one
 * that has worked somewhere else.
 *
 * Same routing harness as branchRoute.test.js: no express, no network. The
 * reader is a double, passed in the same way `register` receives core's; the
 * note above it says why the real one is not reached from here.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-deploy-data-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;
process.env.AEGIS_DEPLOY_ENABLED = '1';
process.env.AEGIS_DEPLOY_POLL_MS = '0';

const test = require('node:test');
const assert = require('node:assert');

const routes = require('../routes');
const projectStore = require('../projectStore');
const projectData = require('../projectData');

/**
 * A stand-in for the reader core hands to `register`.
 *
 * The real one is `backend/src/lib/readOnlyDb.js` in the Aegis tree, and it is
 * tested where it lives, against real SQLite files, by
 * `backend/tests/readOnlyDb.test.js`. It is deliberately not reached from here.
 * An extension is required from `lib/extensionLoader.js`, so Node resolves its
 * requires against the extension's own folder: from
 * `C:\ProgramData\Aegis\extensions\deploy\` neither that module nor
 * `sqlite3` resolves at all. That constraint is why the reader lives in core,
 * and a test climbing out of this repository to import it would assert against
 * a path production does not have.
 *
 * What is left is the extension's half of the seam, and this double covers all
 * of it: the containment check runs before the reader is touched, the reader's
 * error codes reach the operator as the refusals the page has sentences for,
 * and a core that hands over no reader gets a 501 instead of a crash.
 *
 * It answers from one fixed table and refuses a file whose first bytes are not
 * SQLite's magic, so `not_a_database` still comes from the bytes on disk rather
 * than from a flag a test set.
 */
const MAGIC = Buffer.from('SQLite format 3\u0000', 'latin1');

const FIXTURE = {
    name: 'commandes',
    type: 'table',
    columns: ['id', 'client', 'total'],
    rows: [[1, 'Alice', 12.5], [2, 'Bob', 40]]
};

function readerFail(code) {
    return Object.assign(new Error(code), { code });
}

/** The fixture, or the refusal the bytes on disk earn. */
function openFixture(file) {
    const head = Buffer.alloc(MAGIC.length);
    let fd;
    try {
        fd = fs.openSync(file, 'r');
    } catch (_) {
        throw readerFail('unknown_file');
    }
    try {
        fs.readSync(fd, head, 0, head.length, 0);
    } finally {
        fs.closeSync(fd);
    }
    if (!head.equals(MAGIC)) throw readerFail('not_a_database');
    return FIXTURE;
}

const reader = {
    async describe(file) {
        const t = openFixture(file);
        return [{
            name: t.name,
            type: t.type,
            columns: t.columns.map((name) => ({ name })),
            rows: t.rows.length
        }];
    },

    async page(file, options) {
        const t = openFixture(file);
        const opts = options || {};
        if (opts.table !== t.name) throw readerFail('unknown_table');

        const rows = t.rows.slice();
        if (opts.order) {
            // The check that makes core's interpolation safe, kept here so the
            // route's `bad_order` path is reached by the same input as in
            // production rather than by a stubbed throw.
            const at = t.columns.indexOf(opts.order);
            if (at < 0) throw readerFail('bad_order');
            const sign = String(opts.dir).toLowerCase() === 'desc' ? -1 : 1;
            rows.sort((a, b) => (a[at] < b[at] ? -1 : a[at] > b[at] ? 1 : 0) * sign);
        }

        const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
        const offset = Math.max(Number(opts.offset) || 0, 0);
        return {
            table: t.name,
            type: t.type,
            columns: t.columns,
            rows: rows.slice(offset, offset + limit),
            total: t.rows.length,
            limit,
            offset
        };
    }
};

console.log = () => { };

const TENANTS_ROOT = path.join(DATA_ROOT, 'tenants');
fs.mkdirSync(TENANTS_ROOT, { recursive: true });

function pathsFor(slug) {
    const root = path.join(TENANTS_ROOT, slug);
    return { root, deploy: path.join(root, 'deploy') };
}

function collect(readOnlyDb) {
    const table = new Map();
    const add = (method) => (routePath, ...chain) => table.set(`${method} ${routePath}`, chain);
    const router = {
        get: add('GET'), post: add('POST'), delete: add('DELETE'), put: add('PUT'),
        patch: add('PATCH')
    };

    routes.register(router, {
        requireRole: () => (req, res, next) => next(),
        pathsFor,
        tenantsRoot: () => TENANTS_ROOT,
        readOnlyDb
    });
    return table;
}

const table = collect(reader);

function call(key, req, from) {
    const chain = (from || table).get(key);
    assert.ok(chain, `${key} is not mounted`);

    return new Promise((resolve, reject) => {
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { resolve({ status: this.statusCode, body }); return this; }
        };
        let i = 0;
        const next = () => {
            const handler = chain[i++];
            if (!handler) return reject(new Error(`${key} answered nothing`));
            return Promise.resolve(handler(req, res, next)).catch(reject);
        };
        next();
    });
}

function request(extra) {
    return Object.assign({
        body: {},
        query: {},
        params: {},
        tenant: { slug: 'acme' },
        tenantPaths: pathsFor('acme'),
        user: { email: 'ops@acme.test', role: 'admin' },
        hostname: 'aegis.test',
        protocol: 'http',
        get: () => 'aegis.test'
    }, extra || {});
}

function plant(id, fields) {
    return projectStore.saveProject(pathsFor('acme'), Object.assign({
        id, name: id, repoFullName: 'acme/' + id, branch: 'main',
        installationId: null, port: 3099, runtime: 'node', startCmd: 'node server.js',
        lastSha: 'a'.repeat(40)
    }, fields || {}));
}

/**
 * A file in the project's data folder that reads as a database.
 *
 * SQLite's own header bytes and padding, nothing more. `projectData.list` looks
 * at a name and a size, and the reader double looks at the magic, so writing a
 * real page of records here would mean compiling a driver into a repository with
 * no dependencies, to prove something core already proves.
 *
 * Still a promise, because every caller awaits it.
 */
function seed(id, name) {
    const dir = projectStore.ensureDataDir(pathsFor('acme'), id);
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.concat([MAGIC, Buffer.alloc(80)]));
    return Promise.resolve(file);
}

/* ------------------------------------------------------------------ */
/* the containment check                                               */
/* ------------------------------------------------------------------ */

test('a name that leaves the project folder is refused, in every shape', async () => {
    const id = 'data-escape';
    plant(id);
    await seed(id, 'app.db');
    const paths = pathsFor('acme');

    const escapes = [
        '../../../../../../Windows/System32/config/SAM',
        '..\\..\\projects.json',
        '../projects.json',
        'sub/app.db',
        'sub\\app.db',
        '/etc/passwd',
        'C:\\Windows\\win.ini',
        '.env',
        '.',
        '..',
        ''
    ];
    for (const name of escapes) {
        assert.throws(
            () => projectData.resolveFile(paths, id, name),
            (e) => e.code === 'bad_file' || e.code === 'unknown_file',
            `${JSON.stringify(name)} was not refused`);
    }
});

test('a sibling folder whose name merely starts the same is not inside it', () => {
    // The version of this check written as a string prefix says it is. This one
    // compares parent directories, so it does not.
    const paths = pathsFor('acme');
    plant('data-sib');
    projectStore.ensureDataDir(paths, 'data-sib');
    assert.throws(
        () => projectData.resolveFile(paths, 'data-sib', '..\\data-other\\x.db'),
        (e) => e.code === 'bad_file');
});

test('a name the pattern allows and the folder holds resolves to that file', async () => {
    const id = 'data-ok';
    plant(id);
    const file = await seed(id, 'app.db');
    assert.strictEqual(projectData.resolveFile(pathsFor('acme'), id, 'app.db'), file);
});

test('a name that is fine but is not there is missing, not malformed', () => {
    const id = 'data-absent';
    plant(id);
    projectStore.ensureDataDir(pathsFor('acme'), id);
    assert.throws(
        () => projectData.resolveFile(pathsFor('acme'), id, 'never-written.db'),
        (e) => e.code === 'unknown_file');
});

test('a directory named like a database is not opened as one', () => {
    const id = 'data-dir';
    plant(id);
    const dir = projectStore.ensureDataDir(pathsFor('acme'), id);
    fs.mkdirSync(path.join(dir, 'looks.db'), { recursive: true });
    assert.throws(
        () => projectData.resolveFile(pathsFor('acme'), id, 'looks.db'),
        (e) => e.code === 'bad_file');
});

/* ------------------------------------------------------------------ */
/* listing                                                             */
/* ------------------------------------------------------------------ */

test('the listing marks what is a database and what is only a file next to one', async () => {
    const id = 'data-list';
    plant(id);
    const file = await seed(id, 'app.db');
    fs.writeFileSync(path.join(path.dirname(file), 'app.db.tmp'), 'half a write');

    const listed = projectData.list(pathsFor('acme'), id);
    const byName = Object.fromEntries(listed.map((f) => [f.name, f]));

    assert.strictEqual(byName['app.db'].isDatabase, true);
    assert.ok(byName['app.db'].bytes > 0);
    // Shown rather than hidden: an operator hunting a table they cannot find
    // learns more from seeing this than from an empty pane.
    assert.strictEqual(byName['app.db.tmp'].isDatabase, false);
    assert.strictEqual(listed[0].name, 'app.db', 'databases do not sort first');
});

test('a project with no data folder lists nothing rather than failing', () => {
    plant('data-never');
    assert.deepStrictEqual(projectData.list(pathsFor('acme'), 'data-never'), []);
});

/* ------------------------------------------------------------------ */
/* the routes                                                          */
/* ------------------------------------------------------------------ */

test('the folder route separates what the console can write from what the app can write', async () => {
    plant('data-node');
    plant('data-static', { runtime: 'static', startCmd: null });
    await seed('data-static', 'app.db');

    // A node project with nothing in its data folder yet: the process could
    // write there once it starts, the console has no database to edit yet.
    const node = await call('GET /api/deploy/projects/:id/data',
        request({ params: { id: 'data-node' } }));
    assert.strictEqual(node.body.processWrites, true);
    assert.strictEqual(node.body.writable, false);
    assert.strictEqual(node.body.variable, 'AEGIS_DATA_DIR');

    // A static project has no process to write there, but a database left by
    // an earlier version is still editable from this page.
    const stat = await call('GET /api/deploy/projects/:id/data',
        request({ params: { id: 'data-static' } }));
    assert.strictEqual(stat.body.processWrites, false,
        'a static project has no process, so nothing here can write');
    assert.strictEqual(stat.body.writable, true,
        'a database on disk is editable from the console regardless of runtime');
});

test('the tables route describes the database it is pointed at', async () => {
    const id = 'data-tables';
    plant(id);
    await seed(id, 'app.db');

    const answer = await call('GET /api/deploy/projects/:id/data/:file',
        request({ params: { id, file: 'app.db' } }));

    assert.strictEqual(answer.status, 200);
    assert.strictEqual(answer.body.tables.length, 1);
    assert.strictEqual(answer.body.tables[0].name, 'commandes');
    assert.strictEqual(answer.body.tables[0].rows, 2);
});

test('the rows route pages and sorts, and never takes SQL', async () => {
    const id = 'data-rows';
    plant(id);
    await seed(id, 'app.db');

    const sorted = await call('GET /api/deploy/projects/:id/data/:file/rows',
        request({ params: { id, file: 'app.db' }, query: { table: 'commandes', order: 'client', dir: 'desc' } }));
    assert.deepStrictEqual(sorted.body.rows.map((r) => r[1]), ['Bob', 'Alice']);
    assert.strictEqual(sorted.body.total, 2);

    const injected = await call('GET /api/deploy/projects/:id/data/:file/rows',
        request({ params: { id, file: 'app.db' }, query: { table: 'commandes', order: 'client; DROP TABLE commandes' } }));
    assert.strictEqual(injected.status, 400);
    assert.strictEqual(injected.body.error, 'bad_order');

    const gone = await call('GET /api/deploy/projects/:id/data/:file/rows',
        request({ params: { id, file: 'app.db' }, query: { table: 'no_such_table' } }));
    assert.strictEqual(gone.status, 400);
    assert.strictEqual(gone.body.error, 'unknown_table');

    // The table it was asked to drop is still there.
    const after = await call('GET /api/deploy/projects/:id/data/:file',
        request({ params: { id, file: 'app.db' } }));
    assert.strictEqual(after.body.tables[0].name, 'commandes');
});

test('a route asked for a file outside the folder refuses without reading anything', async () => {
    const id = 'data-route-escape';
    plant(id);
    await seed(id, 'app.db');

    for (const file of ['../projects.json', '..\\..\\projects.json', 'sub/app.db']) {
        const answer = await call('GET /api/deploy/projects/:id/data/:file',
            request({ params: { id, file } }));
        assert.strictEqual(answer.status, 400, `${file} was not refused`);
        assert.ok(['bad_file', 'unknown_file'].includes(answer.body.error), answer.body.error);
    }
});

test('a file SQLite will not open is named as such, not as a broken server', async () => {
    const id = 'data-junk';
    plant(id);
    const dir = projectStore.ensureDataDir(pathsFor('acme'), id);
    fs.writeFileSync(path.join(dir, 'notes.db'), 'a log file somebody named .db');

    const answer = await call('GET /api/deploy/projects/:id/data/:file',
        request({ params: { id, file: 'notes.db' } }));
    assert.strictEqual(answer.status, 400);
    assert.strictEqual(answer.body.error, 'not_a_database');
});

test('a core that hands over no reader refuses the two reading routes', async () => {
    // The capability is the newest thing in the loader's context, so an install
    // whose core predates it is a real state and not a hypothetical. The folder
    // route still answers, because listing files needs no driver.
    // Registered with the host opt-in off for the length of the call, so the
    // second `register` does not re-open the listeners of the projects the
    // earlier tests planted and leave the runner with a port it never closes.
    // `requireOptIn` reads the variable per request, and by then it is back.
    process.env.AEGIS_DEPLOY_ENABLED = '0';
    const without = collect(null);
    process.env.AEGIS_DEPLOY_ENABLED = '1';
    const id = 'data-no-reader';
    plant(id);
    await seed(id, 'app.db');

    const listing = await call('GET /api/deploy/projects/:id/data',
        request({ params: { id } }), without);
    assert.strictEqual(listing.status, 200);

    for (const key of ['GET /api/deploy/projects/:id/data/:file',
        'GET /api/deploy/projects/:id/data/:file/rows']) {
        const answer = await call(key,
            request({ params: { id, file: 'app.db' }, query: { table: 'commandes' } }), without);
        assert.strictEqual(answer.status, 501, key);
        assert.strictEqual(answer.body.error, 'reader_unavailable');
    }
});

test('an unknown project is a 404 on all three routes', async () => {
    for (const key of ['GET /api/deploy/projects/:id/data',
        'GET /api/deploy/projects/:id/data/:file',
        'GET /api/deploy/projects/:id/data/:file/rows']) {
        const answer = await call(key, request({ params: { id: 'never-existed', file: 'app.db' } }));
        assert.strictEqual(answer.status, 404, key);
        assert.strictEqual(answer.body.error, 'unknown_project');
    }
});
