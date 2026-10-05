/**
 * What the guided setup asks before it lets a project move to a database.
 *
 * Ten checks, in an order that matters. Each answers passed or failed with a
 * code the page has a sentence for, and the list stops at the first failure:
 * the checks below it are reported as not asked, because nine causes for one
 * fault is nine things to read and eight of them are noise. Core's own storage
 * checks (`lib/storageChecks.js`, ADR 0006) are built the same way, and the
 * operator meets both screens.
 *
 * The order is also a gate. Nothing connects to an address before `approved`
 * has passed. Without that, this route would be a port scanner for the internal
 * network, driven from a browser, run by a service that is not behind the
 * sandbox's firewall rules.
 *
 * A check never writes. The right to create a table is proved by creating one
 * inside a transaction that is rolled back.
 *
 * Everything this module touches is handed in: the Postgres client core lends,
 * the TCP probe, the firewall reader. So the suite runs it with no network, and
 * an Aegis that predates the capability fails one check instead of the load.
 */

'use strict';

const net = require('net');

const pgMigrations = require('./pgMigrations');

/** The oldest release still receiving security fixes, as core's checks put it. */
const MIN_SERVER_VERSION_NUM = 130000;

const ORDER = ['runtime', 'capability', 'approved', 'ssl', 'reachable', 'login', 'version', 'create', 'code', 'path'];

const PRIVATE_HOST = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /\.local$/i,
    /\.internal$/i,
    /\.lan$/i
];

/** Whether an address is one only this network can reach. */
function isPrivateHost(host) {
    const h = String(host || '').trim();
    if (!h) return false;
    // A bare name with no dot is resolved by the local network and nothing else.
    if (!h.includes('.')) return true;
    return PRIVATE_HOST.some((re) => re.test(h));
}

/** Answers whether a TCP port accepts a connection at all. */
function tcpReachable(host, port, timeout = 4000) {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const done = (ok, why) => {
            socket.destroy();
            resolve({ ok, why });
        };
        socket.setTimeout(timeout);
        socket.on('connect', () => done(true, ''));
        socket.on('timeout', () => done(false, `no answer within ${timeout} ms`));
        socket.on('error', (err) => done(false, err.message));
    });
}

const pass = (id, code, detail) => ({ id, ok: true, code: code || 'ok', detail: detail || '' });
const fail = (id, code, detail, extra) => Object.assign({ id, ok: false, code, detail: detail || '' }, extra || {});

/** The checks after a failure, in order, marked as not asked. */
function finish(checks) {
    const done = new Set(checks.map((c) => c.id));
    for (const id of ORDER) {
        if (!done.has(id)) checks.push({ id, ok: null, code: 'not_asked', detail: '' });
    }
    return { ok: checks.every((c) => c.ok === true), checks };
}

/**
 * Runs the checks for one project and one target.
 *
 * `deps` carries what the host can do:
 *   - `runtimeEnabled`, `accounts`: from `runtime.js`
 *   - `postgres`, `reauthenticate`: core's capabilities, or undefined
 *   - `isApproved`, `approveCommand`: from `projectStorage.js`
 *   - `versionDir`: the folder of the version on the port, or null
 *   - `inspectPath`: `storageNetwork.inspect`
 *   - `tcp`: replaces the TCP probe in tests
 */
async function run({ project, target, password, deps }) {
    const checks = [];
    const add = (c) => { checks.push(c); return c.ok; };

    if (project.parentId) return finish([fail('runtime', 'preview')]);
    if (project.runtime !== 'node') return finish([fail('runtime', 'static_project')]);
    if (!deps.runtimeEnabled) return finish([fail('runtime', 'runtime_off')]);
    if (!project.lastSha || !deps.versionDir) return finish([fail('runtime', 'never_deployed')]);
    add(pass('runtime'));

    const hasCore = deps.postgres && typeof deps.postgres.connect === 'function'
        && typeof deps.reauthenticate === 'function'
        && deps.reader && typeof deps.reader.rows === 'function';
    if (!add(hasCore ? pass('capability') : fail('capability', 'core_too_old'))) return finish(checks);

    if (!add(deps.isApproved(target.host, target.port)
        ? pass('approved')
        : fail('approved', 'not_approved', '', { command: deps.approveCommand(target.host, target.port) }))) {
        return finish(checks);
    }

    // Free, and before any byte leaves: an address the whole internet can
    // reach, asked for in the clear.
    const priv = isPrivateHost(target.host);
    if (!add(target.ssl || priv
        ? pass('ssl', target.ssl ? 'ssl_on' : 'private')
        : fail('ssl', 'public_no_ssl'))) return finish(checks);

    const tcp = await (deps.tcp || tcpReachable)(target.host, target.port);
    if (!add(tcp.ok ? pass('reachable') : fail('reachable', 'no_answer', tcp.why))) return finish(checks);

    if (!password) {
        add(fail('login', 'no_password'));
        return finish(checks);
    }
    let client;
    try {
        client = await deps.postgres.connect({
            host: target.host, port: target.port, database: target.database,
            user: target.user, password, ssl: target.ssl
        });
    } catch (e) {
        add(fail('login', 'refused', e.message));
        return finish(checks);
    }
    add(pass('login', 'ok', target.user));

    try {
        if (!add(await versionCheck(client))) return finish(checks);
        if (!add(await createCheck(client))) return finish(checks);
    } finally {
        await client.end().catch(() => { });
    }

    // Whether this version of the project can speak Postgres at all. A site
    // whose code expects a file would boot, answer its health check, and fail
    // on the first page that reads data.
    const dir = pgMigrations.dirFor(deps.versionDir, project);
    const files = pgMigrations.list(dir);
    if (!add(files.length
        ? pass('code', 'ok', String(files.length))
        : fail('code', 'no_migrations', `${project.migrationsDir || 'migrations'}/${pgMigrations.SUBDIR}`))) {
        return finish(checks);
    }

    const path = await deps.inspectPath(deps.accounts, target);
    if (!path.ok) add(fail('path', 'unknown', path.error));
    else if (!path.blocked) add(pass('path', 'not_blocked'));
    else if (path.managed) add(pass('path', 'will_open', `${path.ip}:${target.port}`));
    else add(fail('path', 'blocked_unmanaged', path.ip));

    return finish(checks);
}

async function versionCheck(client) {
    try {
        const res = await client.query('SHOW server_version_num');
        const num = Number(Object.values(res.rows[0] || {})[0]);
        if (!Number.isFinite(num)) return fail('version', 'not_postgres');
        if (num < MIN_SERVER_VERSION_NUM) return fail('version', 'too_old', String(Math.floor(num / 10000)));
        return pass('version', 'ok', String(Math.floor(num / 10000)));
    } catch (e) {
        return fail('version', 'not_postgres', e.message);
    }
}

/** Created and rolled back: the right is proved and nothing is left, not even on an error. */
async function createCheck(client) {
    const name = `aegis_probe_${Date.now().toString(36)}`;
    try {
        await client.query('BEGIN');
        await client.query(`CREATE TABLE ${name} (id integer)`);
        await client.query('ROLLBACK');
        return pass('create');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => { });
        return fail('create', 'no_create', e.message);
    }
}

module.exports = { run, isPrivateHost, ORDER, MIN_SERVER_VERSION_NUM };
