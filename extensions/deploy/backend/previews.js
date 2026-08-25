/**
 * Preview deployments: one branch, its own port, its own copy of the site.
 *
 * A preview is a project record with a `parentId`, and that is the whole design
 * decision. Everything a project already has -- a port, a listener, release
 * folders, a build console, branch polling, the directory guard, the serving
 * config -- applies to it without a second implementation. The parent supplies
 * the repository, the commands and the protection; the preview supplies the
 * branch.
 *
 * Two things a preview does not inherit. It has no host name: names are claimed
 * across the whole install and a branch that lives for a week should not be
 * holding one. And its environment variables come from the parent's `preview`
 * and `all` targets, never `production`, so the branch cannot read the values
 * the live site uses.
 *
 * They expire. The port range is a hundred wide and previews eat it faster than
 * projects do, so one that nobody has pushed to and nobody has opened for seven
 * days is removed: its files, its port, its sessions, its history.
 */

'use strict';

const projectStore = require('./projectStore');
const siteServer = require('./siteServer');
const siteAuth = require('./siteAuth');
const siteConfig = require('./siteConfig');
const runs = require('./runs');
const runStore = require('./runStore');
const runtime = require('./runtime');

/** How long a preview survives with no commit and no visitor. */
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** What a branch may be called before it becomes part of a project id. */
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,255}$/;

function isPreview(project) {
    return !!(project && project.parentId);
}

/**
 * When this preview was last useful to anybody.
 *
 * The later of its last deployment and its last visitor. A branch nobody pushes
 * to but somebody reads every day is being used, and deleting it under them
 * because the commit is old would be wrong.
 *
 * `lastHit` is in memory (`siteServer.lastTouch`) and a restart forgets it, so
 * the clock effectively restarts with the backend. That is the cheap end of the
 * trade: the alternative is a disk write per request to a static file.
 */
function lastUseful(project, lastHit) {
    return Math.max(
        Number(project.deployedAt) || 0,
        Number(project.createdAt) || 0,
        Number(lastHit) || 0
    );
}

/** Whether this record is a preview that has gone quiet for long enough. */
function isExpired(project, now, lastHit) {
    if (!isPreview(project)) return false;
    const at = lastUseful(project, lastHit);
    if (!at) return false;                    // no clock to judge it by: leave it
    return (now - at) > EXPIRY_MS;
}

/**
 * The name and branch of a preview, as the page shows them.
 *
 * The id comes from `projectStore.idFor`, which truncates and de-duplicates, so
 * a branch called `feature/a-very-long-description` does not produce a folder
 * name nobody can read.
 */
function nameFor(parent, branch) {
    return `${parent.name || parent.id} · ${branch}`.slice(0, 80);
}

/**
 * Deletes a preview or a project: listener, record, files, and everything keyed
 * on its id.
 *
 * The same sequence the DELETE route runs, in one place, because the expiry
 * sweep has to run it too and two copies of "and also drop the sessions" is how
 * one of them ends up missing a line. The id a project held is handed to the
 * next project of the same name, so anything left keyed on it would be
 * inherited: a session, a lockout, a cached auth rule, a build console.
 */
function remove({ slug, tenantPaths, projectId }) {
    // The process first. Its files are about to be deleted underneath it, and a
    // node application whose working directory disappeared is a process nobody
    // owns holding a runtime account nothing can hand out again.
    runtime.stop(slug, projectId);
    siteServer.stopSiteFor(slug, projectId);
    const removed = projectStore.deleteProject(tenantPaths, projectId);
    if (!removed) return null;

    siteAuth.invalidate(slug, projectId);
    siteAuth.dropSessions(slug, projectId);
    siteAuth.dropFailures(projectId);
    siteConfig.invalidate(slug, projectId);
    siteConfig.forgetRoot(projectStore.currentDir(tenantPaths, projectId));
    runs.dropProject(slug, projectId);
    runStore.dropProject(tenantPaths, projectId);
    siteServer.invalidateHostIndex();
    return removed;
}

/** Every preview of one project. */
function listFor(tenantPaths, parentId) {
    return projectStore.listProjects(tenantPaths).filter((p) => p.parentId === parentId);
}

/**
 * Removes the previews nobody has used in a week, across every tenant.
 *
 * Called from the poll sweep rather than on a timer of its own: the sweep
 * already walks every tenant's projects every twenty seconds, and a week is not
 * a deadline that needs its own clock.
 */
function expireAll({ pathsFor, tenantsRoot }) {
    const now = Date.now();
    let removed = 0;
    for (const { slug, tenantPaths } of projectStore.tenantsWithProjects(tenantsRoot(), pathsFor)) {
        for (const project of projectStore.listProjects(tenantPaths)) {
            if (!isExpired(project, now, siteServer.lastTouch(slug, project.id))) continue;
            remove({ slug, tenantPaths, projectId: project.id });
            removed += 1;
            console.log(`[Deploy] ${slug}: preview ${project.id} (${project.branch}) expired after ${Math.round(EXPIRY_MS / 86400000)} days unused`);
        }
    }
    return removed;
}

module.exports = {
    EXPIRY_MS, BRANCH_RE,
    isPreview, isExpired, lastUseful, nameFor, remove, listFor, expireAll
};
