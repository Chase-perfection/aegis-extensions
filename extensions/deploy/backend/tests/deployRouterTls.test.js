/**
 * What the shared host router does with a protected site when it listens in
 * clear.
 *
 * A protected site is served over TLS only. A plain router has no HTTPS to offer
 * on its own port, so it sends the visitor to the site's own HTTPS port when the
 * project has one, and otherwise lets the gate answer 503 `site_not_tls`. Real
 * listener, real requests: the redirect is only observable from a socket.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-deploy-router-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;
delete process.env.AEGIS_SITES_ROUTER_CERT;
delete process.env.AEGIS_SITES_ROUTER_KEY;

const test = require('node:test');
const assert = require('node:assert');

const projectStore = require('../projectStore');
const siteServer = require('../siteServer');

console.log = () => { };
console.warn = () => { };

const TENANTS_ROOT = path.join(DATA_ROOT, 'tenants');
fs.mkdirSync(TENANTS_ROOT, { recursive: true });

function pathsFor(slug) {
    const root = path.join(TENANTS_ROOT, slug);
    return { root, deploy: path.join(root, 'deploy') };
}

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

function get(port, host, url) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: url, headers: { Host: host } }, (res) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
        });
        req.on('error', reject);
        req.end();
    });
}

test('a plain router sends a protected site with its own HTTPS port there, and 503s one without', async (t) => {
    const auth = { method: 'ldap', enabled: true, audience: 'directory', allowedGroups: [], allowedUsers: [], grants: {} };
    projectStore.saveProject(pathsFor('acme'), {
        id: 'with-tls', name: 'with-tls', port: 4321, hostname: 'app.corp.local', auth,
        tls: { enabled: true, certFile: 'C:\\certs\\site.pem', keyFile: 'C:\\certs\\site.key' }
    });
    projectStore.saveProject(pathsFor('acme'), {
        id: 'no-tls', name: 'no-tls', port: 4322, hostname: 'old.corp.local', auth
    });

    const routerPort = await freePort();
    process.env.AEGIS_SITES_ROUTER_PORT = String(routerPort);
    const router = siteServer.startRouter({ pathsFor, tenantsRoot: () => TENANTS_ROOT });
    assert.ok(router, 'the router started');
    t.after(() => { router.close(); delete process.env.AEGIS_SITES_ROUTER_PORT; });
    await new Promise((resolve) => (router.listening ? resolve() : router.once('listening', resolve)));

    const redirected = await get(routerPort, 'app.corp.local', '/page?x=1');
    assert.equal(redirected.status, 308);
    assert.equal(redirected.headers.location, 'https://app.corp.local:4321/page?x=1');

    const refused = await get(routerPort, 'old.corp.local', '/');
    assert.equal(refused.status, 503, 'no HTTPS to go to: the gate refuses');
    assert.equal(refused.headers.location, undefined);
});
