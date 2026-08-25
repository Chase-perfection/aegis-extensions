/**
 * Deployment history, on disk, one JSON file per run.
 *
 * `runs.js` holds a deployment while it runs and that is the right place for it:
 * a console is watched for two minutes and never again. What was wrong is that a
 * backend restart took the whole record with it, so "why did the site stop
 * updating last Thursday" had no answer anywhere.
 *
 * A file per run and not the SQLite table plan 0001 draws. Not laziness about
 * schemas: an extension cannot resolve `backend/node_modules`, which is where
 * `sqlite3` lives, and `extensions/deploy/backend/` walks up to the repository
 * root and finds nothing. The same constraint is why `siteServer.js` is
 * `node:http` and not express. The volume here suits files anyway -- sixty runs
 * a tenant, a few hundred lines each, written once when a deployment ends and
 * read when somebody opens one.
 *
 * Every path comes from `tenantPaths`, which core built with `pathsFor(slug)`.
 * Nothing here joins a tenant slug into a path itself.
 *
 * ponytail: write-on-finish, no append-as-you-go. A build that the backend dies
 * during leaves no record, and the project record still says it never
 * succeeded. Streaming to disk would be a few hundred writes per build to save
 * a case that only happens when the process is already gone.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** Same shape `runs.js` accepts from a browser, and it becomes a file name. */
const RUN_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Runs kept per tenant.
 *
 * Enough to cover a few weeks of a handful of projects, and small enough that
 * listing them is one readdir and sixty small reads. The projects themselves
 * keep their own ten-entry summary in `projects.json`, which is what a card
 * reads; this is the one with the log lines in it.
 */
const MAX_KEPT = 60;

function runsDir(tenantPaths) {
    return path.join(tenantPaths.root, 'deploy', 'runs');
}

function fileFor(tenantPaths, id) {
    if (!RUN_ID_RE.test(String(id || ''))) return null;
    return path.join(runsDir(tenantPaths), `${id}.json`);
}

/** Strips what only makes sense while a run is live. */
function stored(view) {
    return {
        id: view.id,
        projectId: view.projectId || null,
        projectName: view.projectName || null,
        branch: view.branch || null,
        sha: view.sha || null,
        trigger: view.trigger || null,
        actor: view.actor || null,
        status: view.status || null,
        error: view.error || null,
        startedAt: view.startedAt || null,
        endedAt: view.endedAt || null,
        stages: Array.isArray(view.stages) ? view.stages : [],
        lines: Array.isArray(view.lines) ? view.lines : []
    };
}

/**
 * Writes one finished run. Returns false for anything that is not one.
 *
 * Write-then-rename, same reason as `projectStore`: a crash mid-write must not
 * leave a truncated file that reads back as a run with no log.
 */
function save(tenantPaths, view) {
    const file = view && fileFor(tenantPaths, view.id);
    if (!file) return false;

    try {
        fs.mkdirSync(runsDir(tenantPaths), { recursive: true });
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(stored(view)), 'utf8');
        fs.renameSync(tmp, file);
    } catch (e) {
        // History is not worth failing a deployment over. The project record
        // already says what happened; this is the detail behind it.
        console.warn(`[Deploy] could not store run ${view.id}: ${e.message}`);
        return false;
    }
    prune(tenantPaths);
    return true;
}

/**
 * One stored run, in the shape the console reads, or null.
 *
 * `after` is the last line number the console already has, and it is applied
 * here so a stored run answers the same request a live one does. `resync` is
 * always false: a file holds every line the run produced, so there is no ring
 * for the caller to have fallen behind.
 */
function read(tenantPaths, id, after) {
    const file = fileFor(tenantPaths, id);
    if (!file) return null;

    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
        return null;
    }
    if (!parsed || parsed.id !== String(id)) return null;

    const from = Number.isFinite(after) ? Math.max(0, after) : 0;
    const lines = (parsed.lines || []).slice(from);
    return Object.assign({}, parsed, {
        lines,
        resync: false,
        cursor: (parsed.lines || []).length
    });
}

/** Every stored run, newest first, without log lines. */
function listRecent(tenantPaths, limit) {
    return all(tenantPaths)
        .slice(0, limit || 30)
        .map((r) => Object.assign({}, r, { lines: [], resync: false, cursor: r.lineCount }));
}

function listForProject(tenantPaths, projectId) {
    return listRecent(tenantPaths, MAX_KEPT).filter((r) => r.projectId === projectId);
}

/**
 * Reads every stored run, newest first, log lines replaced by their count.
 *
 * Sixty JSON reads for one listing, which is the price of not having a table to
 * query. The count comes off the file rather than a stat, because a run's
 * `startedAt` is what the list sorts by and the file's mtime is when it
 * finished.
 */
function all(tenantPaths) {
    let names;
    try {
        names = fs.readdirSync(runsDir(tenantPaths));
    } catch (_) {
        return [];
    }

    const out = [];
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -5);
        if (!RUN_ID_RE.test(id)) continue;
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(path.join(runsDir(tenantPaths), name), 'utf8'));
        } catch (_) {
            continue;                 // a half-written or hand-edited file is not a run
        }
        if (!parsed || parsed.id !== id) continue;
        const lineCount = Array.isArray(parsed.lines) ? parsed.lines.length : 0;
        delete parsed.lines;
        out.push(Object.assign(parsed, { lineCount }));
    }
    return out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

/** Drops the oldest runs past the cap. Called after every write. */
function prune(tenantPaths) {
    for (const run of all(tenantPaths).slice(MAX_KEPT)) {
        const file = fileFor(tenantPaths, run.id);
        if (file) fs.rmSync(file, { force: true });
    }
}

/**
 * Forgets a deleted project's history.
 *
 * The id a project held is free again the moment it is gone, so leaving its runs
 * behind would put another project's deployments on the next project of the same
 * name.
 */
function dropProject(tenantPaths, projectId) {
    for (const run of all(tenantPaths)) {
        if (run.projectId !== projectId) continue;
        const file = fileFor(tenantPaths, run.id);
        if (file) fs.rmSync(file, { force: true });
    }
}

module.exports = { save, read, listRecent, listForProject, dropProject, prune, runsDir, MAX_KEPT, RUN_ID_RE };
