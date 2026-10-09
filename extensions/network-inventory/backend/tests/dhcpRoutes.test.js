'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const childProcess = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ni-dhcp-'));
process.env.AEGIS_DATA_ROOT = ROOT;

// routes.js takes execFile off child_process when it loads, so the fake goes
// in first, as in accountRoutes.test.js.
const calls = [];
let nextRun = { stdout: '{"ips":[],"subnets":[],"diagnostics":[]}', stderr: '', err: null };
childProcess.execFile = (file, args, options, cb) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => cb(nextRun.err, nextRun.stdout, nextRun.stderr));
    return child;
};

const scanAccount = require('../scanAccount');
const dhcpSettings = require('../dhcpSettings');
const inventoryService = require('../inventoryService');
const routes = require('../routes');

function fakeRouter() {
    const handlers = {};
    const guards = {};
    const add = (method) => (p, ...fns) => {
        handlers[method + ' ' + p] = fns[fns.length - 1];
        guards[method + ' ' + p] = fns.length > 1;
    };
    return { handlers, guards, get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE') };
}

let dataDir;

function call(handlers, key, { body = {}, slug = 'acme' } = {}) {
    return new Promise((resolve) => {
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(payload) { resolve({ status: this.statusCode, body: payload }); }
        };
        handlers[key]({ body, tenant: { slug }, tenantPaths: { data: dataDir } }, res);
    });
}

function mount(context = {}) {
    const router = fakeRouter();
    routes.register(router, {
        requireRole: () => (req, res, next) => next(),
        reauthenticate: async () => ({ email: 'admin@corp.local' }),
        ...context
    });
    return router;
}

beforeEach(() => {
    calls.length = 0;
    nextRun = { stdout: '{"ips":[],"subnets":[],"diagnostics":[]}', stderr: '', err: null };
    fs.rmSync(path.join(ROOT, 'network-inventory'), { recursive: true, force: true });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ni-dhcp-t-'));
});

// ── The declared server list ────────────────────────────────────────────────

test('a list is sorted into host names and what is not one, each server once', () => {
    const r = dhcpSettings.normalizeServers('srv-dhcp-01, SRV-DHCP-01.corp.local;srv-wifi\nbad name,-dash');
    assert.deepStrictEqual(r.names, ['srv-dhcp-01', 'srv-wifi']);
    assert.deepStrictEqual(r.rejected, ['bad name', '-dash']);
    assert.deepStrictEqual(dhcpSettings.normalizeServers(['a', 7, null, ' b ']).names, ['a', 'b']);
    assert.deepStrictEqual(dhcpSettings.normalizeServers(undefined), { names: [], rejected: [] });
});

test('nothing declared reads as an empty list, and so does a damaged file', () => {
    assert.deepStrictEqual(dhcpSettings.read(dataDir), { dhcpServers: [] });
    fs.writeFileSync(path.join(dataDir, 'network-inventory-settings.json'), '{ not json', 'utf8');
    assert.deepStrictEqual(dhcpSettings.read(dataDir), { dhcpServers: [] });
});

test('a settings file edited by hand cannot put a command into the scan arguments', () => {
    fs.writeFileSync(path.join(dataDir, 'network-inventory-settings.json'),
        JSON.stringify({ dhcpServers: ['srv-dhcp-01', 'x; Remove-Item C:', '$(calc)'] }), 'utf8');
    assert.deepStrictEqual(dhcpSettings.read(dataDir).dhcpServers, ['srv-dhcp-01']);
});

test('PUT saves the list, GET reads it back, and the change is recorded', async () => {
    const seen = [];
    const { handlers } = mount({ recordActivity: (req, type, key, meta) => seen.push({ type, key, meta }) });
    const put = await call(handlers, 'PUT /api/inventory/dhcp/servers', { body: { servers: ['srv-dhcp-01', 'srv-wifi.corp.local'] } });
    assert.strictEqual(put.status, 200);
    assert.deepStrictEqual(put.body.servers, ['srv-dhcp-01', 'srv-wifi.corp.local']);
    const get = await call(handlers, 'GET /api/inventory/dhcp/servers');
    assert.deepStrictEqual(get.body.servers, ['srv-dhcp-01', 'srv-wifi.corp.local']);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].key, 'inventory.dhcp.servers');
});

test('PUT refuses the whole list when one name is not a host name', async () => {
    const { handlers } = mount();
    await call(handlers, 'PUT /api/inventory/dhcp/servers', { body: { servers: ['srv-dhcp-01'] } });
    const r = await call(handlers, 'PUT /api/inventory/dhcp/servers', { body: { servers: ['srv-dhcp-02', 'bad name'] } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, 'EBADSERVER');
    assert.deepStrictEqual(r.body.rejected, ['bad name']);
    // The list that was there is still there: half a save would have dropped it.
    assert.deepStrictEqual(dhcpSettings.read(dataDir).dhcpServers, ['srv-dhcp-01']);
});

test('PUT refuses more servers than the launcher accepts', async () => {
    const { handlers } = mount();
    const many = Array.from({ length: dhcpSettings.MAX_SERVERS + 1 }, (_, i) => 'srv-' + i);
    const r = await call(handlers, 'PUT /api/inventory/dhcp/servers', { body: { servers: many } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, 'ETOOMANY');
});

test('changing the list is behind the admin role, reading it is not', () => {
    const { guards } = mount();
    assert.strictEqual(guards['PUT /api/inventory/dhcp/servers'], true);
    assert.strictEqual(guards['GET /api/inventory/dhcp/servers'], false);
});

// ── The list reaches the scan, on both launch paths ─────────────────────────

test('declared servers reach the scan run as the service', async () => {
    dhcpSettings.saveServers(dataDir, ['srv-dhcp-01', 'srv-wifi.corp.local']);
    await call(mount().handlers, 'POST /api/inventory/scan');
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].args.slice(-2), ['-DhcpServer', 'srv-dhcp-01,srv-wifi.corp.local']);
});

test('declared servers reach the scan run as the scan account, through the launcher', async () => {
    scanAccount._setRunner(async () => ({ ok: true }));
    scanAccount.save('acme', 'CORP\\svc-scan', 'pw-scan', null);
    dhcpSettings.saveServers(dataDir, ['srv-dhcp-01']);
    await call(mount().handlers, 'POST /api/inventory/scan');
    assert.ok(calls[0].args.includes(scanAccount.LAUNCHER_PATH));
    assert.deepStrictEqual(calls[0].args.slice(-2), ['-DhcpServer', 'srv-dhcp-01']);
});

test('the access test probes the declared servers too', async () => {
    dhcpSettings.saveServers(dataDir, ['srv-dhcp-01']);
    nextRun.stdout = '{"account":"CORP\\\\svc","diagnostics":[]}';
    await call(mount().handlers, 'POST /api/inventory/account/check');
    assert.ok(calls[0].args.includes('-ProbeOnly'));
    assert.deepStrictEqual(calls[0].args.slice(-2), ['-DhcpServer', 'srv-dhcp-01']);
});

test('with nothing declared the scan arguments are what they were', async () => {
    await call(mount().handlers, 'POST /api/inventory/scan', { body: { domain: 'corp.local' } });
    assert.ok(!calls[0].args.includes('-DhcpServer'));
});

// ── The DHCP block: stored, replaced, and served with the inventory ─────────

const SCAN_DHCP = {
    servers: [
        {
            name: 'srv-dhcp-01', fqdn: 'srv-dhcp-01.corp.local', origin: 'directory', status: 'read',
            filters: { allowEnabled: false, denyEnabled: true, allow: [], deny: { mac: '02-00-00-AA-BB-CC', description: 'refus' } },
            // A lone scope and a lone lease, as PowerShell 5.1 can hand them over: bare objects.
            scopes: {
                scopeId: '10.0.0.0', mask: '255.255.252.0', cidr: '10.0.0.0/22', name: 'Postes', state: 'Active',
                rangeStart: '10.0.1.50', rangeEnd: '10.0.3.200', leaseSeconds: 28800, utilization: null,
                exclusions: { start: '10.0.1.50', end: '10.0.1.59' },
                leases: { ip: '10.0.1.60', mac: '02:00:00:AA:BB:01', hostName: 'poste-a', state: 'Active', expiresAt: '2026-01-01T00:00:00Z' },
                reservations: [],
                failover: null
            }
        },
        { name: 'srv-dhcp-02', fqdn: 'srv-dhcp-02.corp.local', origin: 'declared', status: 'refused', filters: null, scopes: [] },
        { name: 'srv-dhcp-03', fqdn: 'srv-dhcp-03.corp.local', status: 'something-new' }
    ]
};

test('the DHCP block survives PowerShell handing lone items over as bare objects', () => {
    const d = inventoryService.normalizeDhcp(SCAN_DHCP);
    assert.strictEqual(d.servers.length, 3);
    const [a, b, c] = d.servers;
    assert.strictEqual(a.scopes.length, 1);
    assert.strictEqual(a.scopes[0].leases.length, 1);
    assert.strictEqual(a.scopes[0].leases[0].hostName, 'poste-a');
    assert.strictEqual(a.scopes[0].exclusions[0].end, '10.0.1.59');
    assert.strictEqual(a.scopes[0].leaseSeconds, 28800);
    assert.strictEqual(a.scopes[0].utilization, null, 'an unread figure must stay unknown, not become 0');
    assert.strictEqual(a.filters.deny.length, 1);
    assert.strictEqual(a.filters.denyEnabled, true);
    assert.strictEqual(b.origin, 'declared');
    assert.strictEqual(b.status, 'refused');
    assert.strictEqual(b.filters, null);
    // An unknown status must not read as a server that answered.
    assert.strictEqual(c.status, 'unreachable');
    assert.strictEqual(c.origin, 'directory');
});

test('a scan with no DHCP block is not the same as a scan whose servers all answered', () => {
    assert.strictEqual(inventoryService.normalizeDhcp(undefined), null);
    assert.strictEqual(inventoryService.normalizeDhcp({}), null);
    assert.deepStrictEqual(inventoryService.normalizeDhcp({ servers: [] }), { servers: [] });
    assert.strictEqual(inventoryService.buildResponse({ ips: [], subnets: [] }).dhcp, null);
});

test('the DHCP block is stored with the inventory and replaced by the next scan', async () => {
    const { handlers } = mount();
    nextRun.stdout = JSON.stringify({ ips: [], subnets: [], diagnostics: [], dhcp: SCAN_DHCP });
    const scan = await call(handlers, 'POST /api/inventory/scan');
    assert.strictEqual(scan.body.dhcp.servers.length, 3);

    const read = await call(handlers, 'GET /api/inventory/network');
    assert.strictEqual(read.body.dhcp.servers[0].scopes[0].name, 'Postes');

    // A later scan that reached one server only: the two others must go, not linger.
    nextRun.stdout = JSON.stringify({ ips: [], subnets: [], diagnostics: [], dhcp: { servers: [SCAN_DHCP.servers[1]] } });
    await call(handlers, 'POST /api/inventory/scan');
    const after = await call(handlers, 'GET /api/inventory/network');
    assert.deepStrictEqual(after.body.dhcp.servers.map(s => s.name), ['srv-dhcp-02']);
});
