/**
 * One machine on the internal network a project's process may reach.
 *
 * The sandbox accounts are denied the directory's subnets, and that is the rule
 * doing its job. A project in Postgres mode gets one `address:port` back for
 * its database (`storageNetwork.js`). Other projects run on local files and
 * still need one internal service, a business system's database, an internal
 * API, which is not their storage and has no business going through the
 * storage switch. This is that opening, for any project, and only that.
 *
 * Three rules hold it narrow, and each one is structural:
 *
 *   - One target, an IPv4 address and a TCP port. Not a host name: a name
 *     resolves to whatever DNS says on the day, and what was approved is an
 *     address. Not a list: one service is the case, and a second one is a
 *     second decision somebody should have to take.
 *   - Set by a tenant administrator through its own route, never read from
 *     `aegis.deploy.json`. A branch does not decide what its process can reach.
 *     `projectStore.saveProject` keeps the field as the disk has it unless the
 *     caller owns it, so no other write can set or clear it either.
 *   - Effective only while `host:port` is in the host's approved list
 *     (`projectStorage.isApproved`). The administrator who opens an address
 *     that is not on it approves it in the same gesture, after a confirmation,
 *     and the list records who did. Read again at every process start: an
 *     address taken off the list closes at the next start.
 *
 * A preview never gets it, for the reason `projectStorage.runtimeEnv` gives.
 *
 * ponytail: a project in Postgres mode cannot also hold one, because
 * `storageNetwork` opens one target per account. The route and the storage
 * switch each refuse the second, and `deployService.runtimeExtras` keeps the
 * database if a record ever has both.
 */

'use strict';

const projectStorage = require('./projectStorage');

function refuse(code, message) {
    return Object.assign(new Error(message), { code });
}

/** A dotted quad rebuilt from its numbers, or null. `010.0.0.5` comes back as `10.0.0.5`. */
function canonicalIp(text) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text || '').trim());
    if (!m) return null;
    const parts = m.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return null;
    return parts.join('.');
}

/**
 * What was typed, checked and reduced to `{ host, port }`.
 *
 * Refuses rather than repairs, for the reason `projectStorage.normalise` gives.
 * The two addresses that would open more than one machine are refused too:
 * nothing to reach at `0.0.0.0`, and the broadcast of a /24 is every machine.
 */
function normalise(input) {
    const raw = input || {};
    const host = canonicalIp(raw.host);
    if (!host) throw refuse('bad_egress_host', 'the address is an IPv4 address such as 192.168.1.98, with no name and no port');
    if (host === '0.0.0.0' || host === '255.255.255.255' || host.split('.')[0] === '127') {
        throw refuse('bad_egress_host', `${host} is not one machine on the network`);
    }

    const port = Number(raw.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw refuse('bad_egress_port', 'the port is a number from 1 to 65535');
    }
    return { host, port };
}

/** The saved target, or null. */
function of(project) {
    const e = project && project.egress;
    if (!e || typeof e !== 'object') return null;
    const host = canonicalIp(e.host);
    const port = Number(e.port);
    return host && Number.isInteger(port) ? { host, port } : null;
}

/**
 * The target the process may reach at this start, or null.
 *
 * Null for a preview, and for a target the host no longer approves.
 */
function targetFor(project) {
    if (!project || project.parentId) return null;
    const t = of(project);
    return t && projectStorage.isApproved(t.host, t.port) ? t : null;
}

/** What a browser may see. */
function publicView(project) {
    const t = of(project);
    if (!t) return null;
    return {
        host: t.host,
        port: t.port,
        approved: projectStorage.isApproved(t.host, t.port),
        setAt: project.egress.setAt || null,
        setBy: project.egress.setBy || null
    };
}

module.exports = { normalise, of, targetFor, publicView };
