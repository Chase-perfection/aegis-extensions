/**
 * Keeps generated certificates alive on a host nobody touches.
 *
 * A certificate is otherwise checked only when its site starts, and a site can
 * run for years without a restart. This sweep runs at boot and twice a day:
 * per tenant that uses a generated certificate, it lets the authority rotate
 * (`selfSignedCert.maintainCa`, which waits for client machines to hold the
 * successor when distribution is on), restarts every site whose certificate
 * must be made again (near its end, or signed by an authority just retired),
 * and publishes the authorities client machines must trust (`caDistribution`).
 * A lighter check every five minutes records the outcome of a queued publish.
 */

'use strict';

const projectStore = require('./projectStore');
const selfSignedCert = require('./selfSignedCert');
const caDistribution = require('./caDistribution');

const EVERY_MS = 12 * 3600 * 1000;
const CHECK_EVERY_MS = 5 * 60 * 1000;
const FIRST_AFTER_MS = 60 * 1000;

let timers = null;

function usesGenerated(project) {
    return !!(project && project.tls && project.tls.generated === true && project.tls.enabled === true);
}

/**
 * One tenant. Also the path of the page's "rotate now" buttons, with `action`.
 * `restartSite({ slug, tenantPaths, project })` restarts a listener (it makes
 * the certificate again on its way up).
 */
async function maintainTenant({ slug, tenantPaths, restartSite, trustedRoot, now = Date.now(), action = null }) {
    const entry = { slug, restarted: [], errors: [] };
    const ca = selfSignedCert.maintainCa(tenantPaths, {
        now, action, overlapSince: caDistribution.overlapSince(tenantPaths)
    });
    entry.ca = { created: ca.created, prepared: ca.prepared, switched: ca.switched, error: ca.error || null };
    for (const project of projectStore.listProjects(tenantPaths).filter(usesGenerated)) {
        if (!selfSignedCert.needsRenewal(project.tls.certFile, ca.current.cert, now)) continue;
        try {
            await restartSite({ slug, tenantPaths, project });
            entry.restarted.push(project.id);
        } catch (e) {
            entry.errors.push(`${project.id}: ${e.message}`);
        }
    }
    try {
        entry.distribution = await caDistribution.publish(slug, tenantPaths, trustedRoot, {
            now, force: !!(ca.created || ca.prepared || ca.switched)
        });
    } catch (e) {
        entry.errors.push(`distribution: ${e.message}`);
    }
    return entry;
}

/** One pass over every tenant. Returns a per-tenant report, for the log and the tests. */
async function sweep({ pathsFor, tenantsRoot, restartSite, trustedRoot, now = Date.now() }) {
    const report = [];
    for (const { slug, tenantPaths } of projectStore.tenantsWithProjects(tenantsRoot(), pathsFor)) {
        const generated = projectStore.listProjects(tenantPaths).some(usesGenerated);
        if (!generated && !caDistribution.read(tenantPaths).enabled) continue;
        let entry;
        try {
            entry = await maintainTenant({ slug, tenantPaths, restartSite, trustedRoot, now });
        } catch (e) {
            entry = { slug, restarted: [], errors: [e.message] };
        }
        report.push(entry);
        const what = [
            entry.ca && entry.ca.created && 'authority created',
            entry.ca && entry.ca.prepared && 'successor prepared',
            entry.ca && entry.ca.switched && 'authority switched',
            entry.restarted.length && `${entry.restarted.length} site(s) renewed`,
            entry.distribution && entry.distribution.status === 'queued' && `trust GPO update queued on ${entry.distribution.host}`
        ].filter(Boolean);
        if (what.length) console.log(`[Deploy] certificates ${slug}: ${what.join(', ')}`);
        for (const err of entry.errors) console.error(`[Deploy] certificates ${slug}: ${err}`);
    }
    return report;
}

/** Records the outcome of queued publishes; nothing else. */
function checkPending({ pathsFor, tenantsRoot, trustedRoot }) {
    if (!trustedRoot) return;
    for (const { slug, tenantPaths } of projectStore.tenantsWithProjects(tenantsRoot(), pathsFor)) {
        try {
            const before = caDistribution.read(tenantPaths);
            if (before.lastStatus !== 'queued') continue;
            const after = caDistribution.refresh(slug, tenantPaths, trustedRoot);
            if (after.lastStatus !== 'queued') {
                console.log(`[Deploy] certificates ${slug}: trust GPO update ${after.lastStatus}${after.lastMessage ? `: ${after.lastMessage}` : ''}`);
            }
        } catch (e) {
            console.error(`[Deploy] certificates ${slug}: ${e.message}`);
        }
    }
}

/** Starts the timers once, from `register`. `unref` so they never hold the process open. */
function startCertMaintenance(deps) {
    if (timers) return timers;
    const run = () => sweep(deps).catch((e) => console.error(`[Deploy] certificate sweep failed: ${e.message}`));
    setTimeout(run, FIRST_AFTER_MS).unref();
    timers = [setInterval(run, EVERY_MS), setInterval(() => checkPending(deps), CHECK_EVERY_MS)];
    for (const t of timers) t.unref();
    return timers;
}

module.exports = { sweep, maintainTenant, checkPending, startCertMaintenance, EVERY_MS };
