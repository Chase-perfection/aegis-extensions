/**
 * Per-tenant project records and the folders their sites live in.
 *
 * A JSON file rather than the `deployDb.js` the plan describes. The plan's
 * schema earns SQLite with deployments, logs and environment variables, none of
 * which exist yet; one static project per row does not. `machineStore.js`
 * already persists this way, so this is the pattern next door rather than a new
 * one. Deployment history is what should force the move to SQL.
 *
 * ponytail: single-process JSON store, no locking. Two simultaneous project
 * creations on one tenant could lose one record. Move to deployDb.js when
 * phase 3 adds deployments, and the concurrency comes free with it.
 *
 * Every path here is derived from `req.tenantPaths`, which core built with
 * `pathsFor(slug)`. Nothing in this file joins a tenant slug into a path
 * itself, which is the rule in the root CLAUDE.md.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * A project id becomes a directory name and a URL segment, so it gets the same
 * shape as a tenant slug. `SLUG_RE` itself lives in core `paths.js` and is about
 * tenants; this is a deliberate copy, matching `EXT_ID_RE` in the loader.
 */
const PROJECT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** `<tenant>/deploy/` holds the record file and every project's files. */
function deployRoot(tenantPaths) {
    return path.join(tenantPaths.root, 'deploy');
}

function storeFile(tenantPaths) {
    return path.join(deployRoot(tenantPaths), 'projects.json');
}

/** Where a project's served files live. `current` is what the site server reads. */
function projectDir(tenantPaths, id) {
    if (!PROJECT_ID_RE.test(id)) throw new Error(`invalid project id: ${id}`);
    return path.join(deployRoot(tenantPaths), 'sites', id);
}

function currentDir(tenantPaths, id) {
    return path.join(projectDir(tenantPaths, id), 'current');
}

/**
 * The one folder of a project that a deployment does not touch.
 *
 * Every other folder under `projectDir` is rebuilt or replaced: `current` is
 * renamed over by each clone, `staging` and `build-output` are cleared before
 * each one, `releases` holds copies of past clones. So an application with
 * anything to remember had nowhere to put it, and this is that place.
 *
 * A sibling and not a subfolder of `current`, which is the whole point: the
 * rename that makes a failed deployment harmless is also what would take a
 * database with it.
 *
 * A preview gets its own, because its id is its own. That is the answer we
 * want and not an accident: a branch nobody reviewed reads the `preview` and
 * `all` environment targets and never `production`, and the same sentence
 * applies to its data.
 */
function dataDir(tenantPaths, id) {
    return path.join(projectDir(tenantPaths, id), 'data');
}

/** Creates it if it is not there. Idempotent, so every caller may just call. */
function ensureDataDir(tenantPaths, id) {
    const dir = dataDir(tenantPaths, id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function readAll(tenantPaths) {
    try {
        const parsed = JSON.parse(fs.readFileSync(storeFile(tenantPaths), 'utf8'));
        return Array.isArray(parsed && parsed.projects) ? parsed.projects : [];
    } catch (_) {
        return [];   // no file yet is the normal first-run state
    }
}

function writeAll(tenantPaths, projects) {
    fs.mkdirSync(deployRoot(tenantPaths), { recursive: true });
    // Write-then-rename, same reason as machineStore: a crash mid-write must not
    // leave a truncated file that reads back as "no projects".
    const tmp = storeFile(tenantPaths) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ projects }, null, 2), 'utf8');
    fs.renameSync(tmp, storeFile(tenantPaths));
}

/**
 * Derives a project id from a name, or from the repository when the name gives
 * nothing usable. Collisions get a numeric suffix rather than an error, because
 * "my site" and "My Site!" both reducing to `my-site` is a reasonable thing for
 * an operator to do and not worth a refusal.
 */
function idFor(tenantPaths, name, repoFullName) {
    const base = String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24)
        || String(repoFullName || '').split('/').pop().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)
        || 'site';
    const taken = new Set(readAll(tenantPaths).map((p) => p.id));
    if (!taken.has(base) && PROJECT_ID_RE.test(base)) return base;
    for (let n = 2; n < 100; n++) {
        const candidate = `${base}-${n}`.slice(0, 31);
        if (!taken.has(candidate) && PROJECT_ID_RE.test(candidate)) return candidate;
    }
    throw new Error('could not derive a free project id');
}

/**
 * How many attempts a project remembers.
 *
 * Enough to answer "why did my site stop updating" without letting a project
 * that fails every 20 seconds grow the file without bound. The plan's SQL
 * schema is where a real history belongs; this is the smallest thing that makes
 * a failing poll visible on the page.
 */
const HISTORY_LIMIT = 10;

/** The project's history with `entry` on top, capped. Pure: stores nothing. */
function addHistory(project, entry) {
    return [entry].concat(Array.isArray(project.history) ? project.history : []).slice(0, HISTORY_LIMIT);
}

/**
 * Ticks to skip before retrying a project that keeps failing.
 *
 * A deleted branch or a repository that lost access fails identically every
 * tick, and at 20 seconds that is 180 log lines an hour saying the same thing.
 * Backoff grows with consecutive failures and stops at 15 ticks, so a project
 * fixed on GitHub still recovers within a few minutes without anyone clicking.
 */
function skipTicks(failureCount) {
    if (!failureCount || failureCount < 2) return 0;
    return Math.min(15, failureCount - 1);
}

function getProject(tenantPaths, id) {
    return readAll(tenantPaths).find((p) => p.id === id) || null;
}

/** Inserts or replaces by id, and returns what was stored. */
function saveProject(tenantPaths, project) {
    if (!PROJECT_ID_RE.test(project.id || '')) throw new Error(`invalid project id: ${project.id}`);
    const projects = readAll(tenantPaths).filter((p) => p.id !== project.id);
    projects.push(project);
    writeAll(tenantPaths, projects);
    return project;
}

/**
 * Forgets a project and deletes the files it was serving.
 *
 * The record goes first. A crash between the two leaves an orphan folder, which
 * costs disk and nothing else; the other order would leave a project on the page
 * whose site is gone.
 */
function deleteProject(tenantPaths, id) {
    const projects = readAll(tenantPaths);
    const project = projects.find((p) => p.id === id);
    if (!project) return null;

    writeAll(tenantPaths, projects.filter((p) => p.id !== id));
    // projectDir asserts the id, so a value that is not a plain slug never
    // reaches rmSync.
    fs.rmSync(projectDir(tenantPaths, id), { recursive: true, force: true });
    return project;
}

/**
 * Every tenant that has a deploy folder, by slug.
 *
 * Read from disk rather than from a registry, because the tenants that matter
 * to the poller are exactly the ones that have created a project, and that is
 * what the folder's existence records. `tenantsRoot` comes from core.
 */
function tenantsWithProjects(tenantsRootDir, pathsFor) {
    return allTenants(tenantsRootDir, pathsFor)
        .filter(({ tenantPaths }) => fs.existsSync(storeFile(tenantPaths)));
}

/**
 * Every tenant on this host, whether or not it has ever used Deploy.
 *
 * `tenantsWithProjects` answers "who is the poller working for"; this answers
 * "how many tenants share this machine", which is a different question and the
 * one the GitHub App migration turns on. A tenant that never opened Deploy still
 * counts there: it is a tenant that could open it tomorrow and must not inherit
 * somebody else's credential when it does.
 */
function allTenants(tenantsRootDir, pathsFor) {
    let slugs;
    try {
        slugs = fs.readdirSync(tenantsRootDir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
            .map((d) => d.name);
    } catch (_) {
        return [];
    }
    const out = [];
    for (const slug of slugs) {
        let tenantPaths;
        try {
            tenantPaths = pathsFor(slug);   // asserts the slug; skips anything odd
        } catch (_) {
            continue;
        }
        out.push({ slug, tenantPaths });
    }
    return out;
}

module.exports = {
    PROJECT_ID_RE, HISTORY_LIMIT,
    deployRoot, projectDir, currentDir, dataDir, ensureDataDir,
    listProjects: readAll, getProject, saveProject, deleteProject, idFor,
    addHistory, skipTicks, tenantsWithProjects, allTenants
};
