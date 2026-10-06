/**
 * The one internal address a project's process may reach.
 *
 * Four properties, each one a way the network opens wider than somebody
 * decided: a target that is not one machine, a record written by something
 * other than the egress routes, an address the host never approved, and a
 * preview or a build handed what the live site was given. The firewall itself
 * is `storageNetwork.test.js`; here it is a runner that records its scripts.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-egress-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;

const test = require('node:test');
const assert = require('node:assert');

const projectEgress = require('../projectEgress');
const projectStore = require('../projectStore');
const projectStorage = require('../projectStorage');
const egressRoutes = require('../egressRoutes');
const deployService = require('../deployService');
const storageNetwork = require('../storageNetwork');
const manifestLive = require('../manifestLive');
const runtime = require('../runtime');

console.log = () => { };
console.warn = () => { };
console.error = () => { };

const BASE = '/api/deploy/projects/:id/egress';

function approve(text) {
    fs.mkdirSync(path.dirname(projectStorage.targetsFile()), { recursive: true });
    fs.writeFileSync(projectStorage.targetsFile(), text);
}

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

function world(over) {
    const slug = `t${Math.random().toString(36).slice(2, 8)}`;
    const root = path.join(DATA_ROOT, 'tenants', slug);
    const tenantPaths = { root, deploy: path.join(root, 'deploy') };
    const project = Object.assign({ id: 'site', name: 'Site', runtime: 'node', startCmd: 'python app.py', port: 3150, branch: 'main' }, over || {});
    projectStore.saveProject(tenantPaths, project);

    const w = { slug, tenantPaths, starts: [] };
    w.router = fakeRouter();
    egressRoutes.register(w.router, {
        requireOptIn: (req, res, next) => next(),
        requireRole: (role) => (req, res, next) => (req.role === role ? next() : res.status(403).json({ success: false, error: 'forbidden' })),
        projectOr404: (req, res) => {
            const p = projectStore.getProject(req.tenantPaths, req.params.id);
            if (!p) { res.status(404).json({ success: false, error: 'unknown_project' }); return null; }
            return p;
        },
        startCurrent: async ({ project: p }) => { w.starts.push(projectEgress.of(p)); return { port: 3400 }; }
    });
    w.req = (body, role) => ({
        role: role || 'admin', body: body || {}, params: { id: 'site' },
        tenant: { slug }, tenantPaths, user: { email: 'admin@acme.test' }
    });
    w.project = () => projectStore.getProject(tenantPaths, 'site');
    return w;
}

test('normalise takes one IPv4 address and one port, and refuses the rest by name', () => {
    assert.deepStrictEqual(projectEgress.normalise({ host: ' 192.0.2.98 ', port: '1433' }), { host: '192.0.2.98', port: 1433 });
    assert.deepStrictEqual(projectEgress.normalise({ host: '010.000.2.5', port: 80 }), { host: '10.0.2.5', port: 80 },
        'the address is rebuilt from its numbers, as the firewall will read it');

    const refused = [
        [{ host: 'db.corp.local', port: 1433 }, 'bad_egress_host'],
        [{ host: '192.0.2.0/24', port: 1433 }, 'bad_egress_host'],
        [{ host: '192.0.2.98:1433', port: 1433 }, 'bad_egress_host'],
        [{ host: '192.0.2.256', port: 1433 }, 'bad_egress_host'],
        [{ host: '0.0.0.0', port: 1433 }, 'bad_egress_host'],
        [{ host: '255.255.255.255', port: 1433 }, 'bad_egress_host'],
        [{ host: '127.0.0.1', port: 1433 }, 'bad_egress_host'],
        [{ host: "192.0.2.1'; calc", port: 1433 }, 'bad_egress_host'],
        [{ host: '192.0.2.98', port: 0 }, 'bad_egress_port'],
        [{ host: '192.0.2.98', port: 65536 }, 'bad_egress_port'],
        [{ host: '192.0.2.98', port: '1433,445' }, 'bad_egress_port'],
        [{ host: '192.0.2.98' }, 'bad_egress_port']
    ];
    for (const [input, code] of refused) {
        assert.throws(() => projectEgress.normalise(input), (e) => e.code === code, JSON.stringify(input));
    }
});

test('only a save that owns the field writes it: a request or a manifest cannot open the network', () => {
    const w = world();
    const egress = { host: '192.0.2.98', port: 1433, setAt: 1, setBy: 'admin@acme.test' };

    // A new record never carries one, whatever it was built from.
    const fresh = projectStore.saveProject(w.tenantPaths, { id: 'other', runtime: 'node', egress });
    assert.strictEqual(fresh.egress, undefined);

    // An ordinary save of a record read before the opening keeps the disk's value...
    const stale = w.project();
    projectStore.saveProject(w.tenantPaths, Object.assign({}, stale, { egress }), { egress: true });
    projectStore.saveProject(w.tenantPaths, Object.assign({}, stale, { lastSha: 'abc' }));
    assert.deepStrictEqual(w.project().egress, egress, 'a save that only meant to record a commit closed the access');

    // ...and one that tries to change it does not.
    projectStore.saveProject(w.tenantPaths, Object.assign({}, w.project(), { egress: { host: '192.0.2.1', port: 445 } }));
    assert.deepStrictEqual(w.project().egress, egress);

    // `storage` is still held the same way.
    projectStore.saveProject(w.tenantPaths, Object.assign({}, w.project(), { storage: { mode: 'postgres', host: 'x' } }));
    assert.strictEqual(w.project().storage, undefined);

    // The manifest has no key for it.
    const live = manifestLive.apply(w.project(), { egress: { host: '192.0.2.1', port: 445 }, buildCmd: 'npm run build' });
    assert.deepStrictEqual(Object.keys(live.changed), ['buildCmd']);
});

test('both routes are mounted behind the opt-in and the admin role', async () => {
    const w = world();
    assert.deepStrictEqual(w.router.routes.map((r) => `${r.method} ${r.route}`).sort(), [`delete ${BASE}`, `post ${BASE}`]);
    for (const r of w.router.routes) {
        assert.strictEqual(r.handlers.length, 3, `${r.route} is not opt-in + role + handler`);
        const res = await w.router.call(r.method, r.route, w.req({ host: '192.0.2.98', port: 1433 }, 'member'));
        assert.strictEqual(res.statusCode, 403, `${r.method} ${r.route} answered a member`);
    }
    assert.strictEqual(w.project().egress, undefined);
});

test('an address never opened here is refused once, so the page can ask', async () => {
    approve('192.0.2.98:5432\n');
    const w = world();
    const res = await w.router.call('post', BASE, w.req({ host: '192.0.2.98', port: 1433 }));
    assert.deepStrictEqual([res.statusCode, res.body.error], [409, 'egress_not_approved'],
        'approving a host is not approving its other ports');
    assert.strictEqual(res.body.approveCommand, undefined, 'nobody is sent to the server for this');
    assert.strictEqual(w.project().egress, undefined);
    assert.strictEqual(projectStorage.isApproved('192.0.2.98', 1433), false, 'a first request approved on its own');

    // `approve` has to be the boolean, not something truthy a form could send.
    const loose = await w.router.call('post', BASE, w.req({ host: '192.0.2.98', port: 1433, approve: 'true' }));
    assert.strictEqual(loose.body.error, 'egress_not_approved');
});

test('confirmed, the administrator approves and opens in one request, and the list says who', async () => {
    approve('# kept by hand\n10.0.0.5:5432');
    const w = world();
    const res = await w.router.call('post', BASE, w.req({ host: '192.0.2.98', port: 1433, approve: true }));
    assert.deepStrictEqual([res.statusCode, res.body.success, res.body.egress.approved], [200, true, true]);
    assert.deepStrictEqual(w.project().egress.host, '192.0.2.98');

    const lines = fs.readFileSync(projectStorage.targetsFile(), 'utf8').split('\n');
    assert.deepStrictEqual(lines.slice(0, 2), ['# kept by hand', '10.0.0.5:5432'], 'the lines typed on the host were rewritten');
    assert.match(lines[2], /^192\.0\.2\.98:1433 {2}# approved from Aegis by admin@acme\.test \(t[a-z0-9]+\/site\), \d{4}-\d\d-\d\dT/);
    assert.strictEqual(projectStorage.isApproved('10.0.0.5', 5432), true);

    // A second opening of the same address adds no second line.
    await w.router.call('post', BASE, w.req({ host: '192.0.2.98', port: 1433, approve: true }));
    assert.strictEqual(fs.readFileSync(projectStorage.targetsFile(), 'utf8').match(/192\.0\.2\.98:1433/g).length, 1);
});

test('a member cannot approve, and a bad address is refused before the list is touched', async () => {
    approve('');
    const w = world();
    const member = await w.router.call('post', BASE, w.req({ host: '192.0.2.98', port: 1433, approve: true }, 'member'));
    assert.strictEqual(member.statusCode, 403);
    const bad = await w.router.call('post', BASE, w.req({ host: '0.0.0.0', port: 1433, approve: true }));
    assert.strictEqual(bad.body.error, 'bad_egress_host');
    assert.strictEqual(fs.readFileSync(projectStorage.targetsFile(), 'utf8'), '');
});

test('what is written beside the address cannot start a second line', () => {
    approve('');
    projectStorage.approve('192.0.2.7', 8080, 'eve@x.test\n10.0.0.1:22 # sneaked');
    const text = fs.readFileSync(projectStorage.targetsFile(), 'utf8');
    assert.strictEqual(text.trim().split('\n').length, 1);
    assert.deepStrictEqual(projectStorage.approvedTargets(), [{ host: '192.0.2.7', port: 8080 }]);
});

test('when the list cannot be written, the command is the way left', async () => {
    approve('');
    const w = world();
    const real = fs.appendFileSync;
    fs.appendFileSync = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
    let res;
    try {
        res = await w.router.call('post', BASE, w.req({ host: '192.0.2.98', port: 1433, approve: true }));
    } finally {
        fs.appendFileSync = real;
    }
    assert.deepStrictEqual([res.statusCode, res.body.error], [500, 'egress_approval_failed']);
    assert.match(res.body.approveCommand, /^Add-Content -Path '.*database-targets\.txt' -Value '192\.0\.2\.98:1433'$/);
    assert.strictEqual(w.project().egress, undefined);
});

test('the refusals: a bad field, a preview', async () => {
    approve('192.0.2.98:1433\n');
    const w = world();
    const bad = await w.router.call('post', BASE, w.req({ host: 'srv-db', port: 1433 }));
    assert.deepStrictEqual([bad.statusCode, bad.body.error], [400, 'bad_egress_host']);

    const preview = world({ parentId: 'site-parent' });
    const pv = await preview.router.call('post', BASE, preview.req({ host: '192.0.2.98', port: 1433 }));
    assert.deepStrictEqual([pv.statusCode, pv.body.error], [400, 'preview_egress']);
});

test('a project on a database opens its internal service too, and the process reaches both', async () => {
    approve('192.0.2.98:1433\n192.0.2.10:5432\n');
    const onDb = world();
    const p = onDb.project();
    p.storage = projectStorage.withTarget(p, projectStorage.normalise({ host: '192.0.2.10', port: 5432, database: 'app', user: 'app' }), 'pw');
    p.storage = projectStorage.withMode(p, 'postgres', 'admin@acme.test');
    projectStore.saveProject(onDb.tenantPaths, p, { storage: true });

    const opened = await onDb.router.call('post', BASE, onDb.req({ host: '192.0.2.98', port: 1433 }));
    assert.deepStrictEqual([opened.statusCode, opened.body.success], [200, true]);
    assert.strictEqual(projectStorage.mode(onDb.project()), 'postgres', 'opening a service moved the data');

    const before = process.env.AEGIS_DEPLOY_FIREWALL;
    process.env.AEGIS_DEPLOY_FIREWALL = '1';
    const scripts = [];
    const deny = { name: 'AegisBuild-run-a-DenyDomain-192_0_2_0_24', enabled: 'True', remote: ['192.0.2.0/24'] };
    storageNetwork._setRunner((script) => {
        scripts.push(script);
        return { ok: true, out: script.includes('ConvertTo-Json') ? JSON.stringify({ deny: [deny], data: null }) : '' };
    });
    try {
        const extras = deployService.runtimeExtras(onDb.project());
        assert.match(extras.env.DATABASE_URL, /@192\.0\.2\.10:5432\/app$/);
        const live = await extras.prepare('run-a');
        assert.deepStrictEqual([live.changed, live.inside], [true, true]);
        const written = scripts[scripts.length - 1];
        assert.ok(written.includes('-RemoteAddress 192.0.2.10 -Owner $sid -Protocol TCP -RemotePort 1-5431,5433-65535'), written);
        assert.ok(written.includes('-RemoteAddress 192.0.2.98 -Owner $sid -Protocol TCP -RemotePort 1-1432,1434-65535'), written);
        assert.ok(written.includes('-RemoteAddress 192.0.2.0-192.0.2.9,192.0.2.11-192.0.2.97,192.0.2.99-192.0.2.255'), written);

        // The service taken off the approved list closes alone: the database stays.
        approve('192.0.2.10:5432\n');
        scripts.length = 0;
        await deployService.runtimeExtras(onDb.project()).prepare('run-a');
        const after = scripts[scripts.length - 1];
        assert.ok(!after.includes('192.0.2.98'), 'an address nobody approves any more was opened');
        assert.ok(after.includes('-RemoteAddress 192.0.2.0-192.0.2.9,192.0.2.11-192.0.2.255'), after);
    } finally {
        storageNetwork._setRunner(null);
        if (before === undefined) delete process.env.AEGIS_DEPLOY_FIREWALL;
        else process.env.AEGIS_DEPLOY_FIREWALL = before;
    }
});

test('open then close: the record follows, and a running site restarts both times', async () => {
    approve('192.0.2.98:1433\n');
    const w = world();

    const idle = await w.router.call('post', BASE, w.req({ host: '192.0.2.98', port: '1433' }));
    assert.strictEqual(idle.statusCode, 200);
    assert.deepStrictEqual(idle.body.egress, { host: '192.0.2.98', port: 1433, approved: true, setAt: idle.body.egress.setAt, setBy: 'admin@acme.test' });
    assert.strictEqual(idle.body.applied, 'next_start', 'nothing runs, so nothing restarts');
    assert.deepStrictEqual(w.starts, []);

    runtime._running.set(`${w.slug}/site`, { slot: 0, port: 3150, account: 'run-a' });
    try {
        const again = await w.router.call('post', BASE, w.req({ host: '192.0.2.98', port: 1433 }));
        assert.strictEqual(again.body.applied, 'restarted');
        assert.deepStrictEqual(w.starts, [{ host: '192.0.2.98', port: 1433 }], 'the restart did not read the new record');

        const closed = await w.router.call('delete', BASE, w.req());
        assert.deepStrictEqual([closed.statusCode, closed.body.egress, closed.body.applied], [200, null, 'restarted']);
        assert.deepStrictEqual(w.starts[1], null, 'the closing waited for the next push');
        assert.strictEqual('egress' in w.project(), false);
    } finally {
        runtime._running.delete(`${w.slug}/site`);
    }

    const none = await w.router.call('delete', BASE, w.req());
    assert.deepStrictEqual([none.statusCode, none.body.error], [404, 'no_egress']);
});

test('runtimeExtras opens the target for the live site only, and only while approved', async () => {
    const before = process.env.AEGIS_DEPLOY_FIREWALL;
    process.env.AEGIS_DEPLOY_FIREWALL = '1';
    const scripts = [];
    const deny = { name: 'AegisBuild-run-a-DenyDomain-192_0_2_0_24', enabled: 'True', remote: ['192.0.2.0/24'] };
    storageNetwork._setRunner((script) => {
        scripts.push(script);
        return { ok: true, out: script.includes('ConvertTo-Json') ? JSON.stringify({ deny: [deny], data: null }) : '' };
    });
    const egress = { egress: { host: '192.0.2.98', port: 1433 } };
    try {
        approve('192.0.2.98:1433\n');
        const live = await deployService.runtimeExtras(Object.assign({ id: 'site', runtime: 'node' }, egress)).prepare('run-a');
        assert.deepStrictEqual([live.changed, live.inside], [true, true]);
        const written = scripts[scripts.length - 1];
        assert.match(written, /-RemoteAddress 192\.0\.2\.98 -Owner \$sid -Protocol TCP -RemotePort 1-1432,1434-65535/);
        assert.ok(written.includes('-RemoteAddress 192.0.2.0-192.0.2.97,192.0.2.99-192.0.2.255'));
        assert.deepStrictEqual(deployService.runtimeExtras(Object.assign({ id: 'site', runtime: 'node' }, egress)).env, {},
            'the address is a firewall rule, not a variable');

        scripts.length = 0;
        const preview = await deployService.runtimeExtras(Object.assign({ id: 'site-pr', parentId: 'site' }, egress)).prepare('run-a');
        assert.strictEqual(preview.inside, false, 'a preview was given the opening');
        assert.ok(!scripts.some((s) => s.includes('New-NetFirewallRule')));

        approve('# taken off by an administrator\n');
        scripts.length = 0;
        const revoked = await deployService.runtimeExtras(Object.assign({ id: 'site', runtime: 'node' }, egress)).prepare('run-a');
        assert.notStrictEqual(revoked.inside, true);
        assert.ok(!scripts.some((s) => s.includes('New-NetFirewallRule')), 'an unapproved address was opened');
    } finally {
        storageNetwork._setRunner(null);
        if (before === undefined) delete process.env.AEGIS_DEPLOY_FIREWALL;
        else process.env.AEGIS_DEPLOY_FIREWALL = before;
    }
});

test('every process start reads forProcess, and the build reads forBuild only', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'deployService.js'), 'utf8');
    assert.strictEqual((src.match(/projectEnv\.forProcess\(/g) || []).length, 3, 'a deployment, a promote and the boot');
    const buildEnvFor = /buildEnvFor:[\s\S]*?\n {12}\},/.exec(src);
    assert.ok(buildEnvFor, 'buildEnvFor moved');
    assert.match(buildEnvFor[0], /projectEnv\.forBuild\(/);
    assert.doesNotMatch(buildEnvFor[0], /forProcess/, 'the install and the build were handed the runtime values');
});
