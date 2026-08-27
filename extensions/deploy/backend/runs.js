/**
 * What one deployment is doing, while it is doing it.
 *
 * The build console needs three things a project record cannot give it: the
 * stage a deployment has reached, the output the tools printed, and a handle to
 * stop it. None of that belongs in `projects.json` -- it is worthless the moment
 * the backend restarts, and writing every log line to disk would turn a build
 * into a few hundred file writes.
 *
 * So it lives here, in memory, capped. A restart loses the console of a build
 * nobody is watching any more; the project record still says whether it
 * succeeded, which is the part that had to survive.
 *
 * Keyed by tenant slug throughout. `get` refuses a run belonging to another
 * tenant rather than trusting the id to be unguessable, because an id that
 * arrives from a browser is an input like any other.
 */

'use strict';

const crypto = require('crypto');

const runStore = require('./runStore');

/**
 * Lines a run remembers.
 *
 * A webpack build prints thousands. The console shows the tail, and the tail is
 * where the error is: a failure prints its reason last. Older lines are dropped
 * from the front and counted, so the polling cursor below stays correct.
 */
const MAX_LINES = 500;

/** Runs a project remembers, newest first. Enough for the detail view's list. */
const MAX_RUNS_PER_PROJECT = 8;

/** One line is never worth more than this much memory, whatever printed it. */
const MAX_LINE_CHARS = 2000;

/**
 * The id the browser generated, before it is used as a map key.
 *
 * The console is opened by the page the moment the operator clicks Deploy, and
 * the request that starts the deployment has not answered yet -- so the id
 * cannot come from the response. The page mints it instead and sends it along,
 * which is the same trick an idempotency key uses and costs no job queue.
 */
const RUN_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The stages a deployment passes through, in order.
 *
 * `install` and `build` are one sandbox call underneath (one pwsh process runs
 * both commands), but they are two stages here because they fail for different
 * reasons and the operator reads them differently: a failed install is a
 * dependency problem, a failed build is their own code. builder.js tells them
 * apart by which log file the sandbox has started writing.
 *
 * `migrate` is last because that is when it runs: the `.sql` files live in the
 * clone, so the schema moves once the folder is on the port. It was missing
 * from this list until 0.1.3, which meant `stage('migrate', ...)` found no
 * index and returned -- migrations ran, or were skipped, with no box on the
 * console either way. A step nobody can see is a step nobody checks.
 */
const STAGES = ['clone', 'install', 'build', 'check', 'publish', 'migrate'];

/** runId -> run. */
const byId = new Map();

/** `<slug>/<projectId>` -> [run], newest first. */
const byProject = new Map();

function projectKey(slug, projectId) {
    return `${slug}/${projectId}`;
}

function newStages() {
    return STAGES.map((key) => ({
        key,
        status: 'pending',
        startedAt: null,
        endedAt: null,
        detail: null
    }));
}

/**
 * Starts recording a deployment.
 *
 * `id` is the browser's, when it sent one that looks like an id and is not
 * already taken. Anything else gets a server-minted one, which is what the
 * poller and the webhook always take: nobody is watching those, they just want
 * the record to exist so the detail view can show it later.
 */
function start({ id, slug, tenantPaths, projectId, projectName, branch, trigger, actor }) {
    const runId = (RUN_ID_RE.test(String(id || '')) && !byId.has(id))
        ? String(id)
        : crypto.randomBytes(12).toString('hex');

    const run = {
        id: runId,
        slug,
        // Carried, not looked up: this module is keyed by slug and has no way
        // to resolve one into a path. `finish` needs it to write the record,
        // and nothing else here reads it. Never in `snapshot`.
        tenantPaths: tenantPaths || null,
        projectId,
        projectName: projectName || projectId,
        branch: branch || null,
        sha: null,
        trigger: trigger || 'manual',
        actor: actor || null,
        status: 'running',
        error: null,
        startedAt: Date.now(),
        endedAt: null,
        stages: newStages(),
        lines: [],
        // Lines evicted from the front. A cursor is an absolute line number, so
        // a client that fell behind the ring is told to resync instead of being
        // handed the wrong lines.
        dropped: 0,
        controller: new AbortController()
    };

    byId.set(runId, run);
    index(run);

    return run;
}

/** Files a run under its project, evicting the project's oldest. */
function index(run) {
    const key = projectKey(run.slug, run.projectId);
    const list = byProject.get(key) || [];
    list.unshift(run);
    // Evicting from both maps together: a run only in `byId` is a leak that
    // nothing would ever look at again.
    for (const old of list.splice(MAX_RUNS_PER_PROJECT)) byId.delete(old.id);
    byProject.set(key, list);
}

/**
 * Names the project a run belongs to, once the route has worked it out.
 *
 * Creating a project starts its run before the repository URL has been parsed,
 * because the console is open on the browser's id from the moment it was
 * clicked and a run that does not exist yet reads as a blank screen. The
 * project id is derived a few lines later, so the run moves out of the tenant's
 * unattached bucket and into that project's list here -- which is what puts it
 * on the project's detail view and lets `dropProject` forget it with the rest.
 */
function attach(run, projectId, projectName) {
    if (!run || !projectId || run.projectId === projectId) return;

    const from = projectKey(run.slug, run.projectId);
    const list = (byProject.get(from) || []).filter((r) => r !== run);
    if (list.length) byProject.set(from, list); else byProject.delete(from);

    run.projectId = projectId;
    if (projectName) run.projectName = projectName;
    index(run);
}

/** Appends output. Multi-line input becomes one entry per line. */
function log(run, text) {
    if (!run || text == null) return;
    const now = Date.now();
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '');
        if (!line) continue;
        run.lines.push({ at: now, text: line.slice(0, MAX_LINE_CHARS) });
    }
    const over = run.lines.length - MAX_LINES;
    if (over > 0) {
        run.lines.splice(0, over);
        run.dropped += over;
    }
}

/**
 * Moves a stage. `detail` is the command being run, shown under the label.
 *
 * Setting a stage to a terminal state marks every earlier pending stage
 * `skipped`, so a project with no build command does not leave Installation and
 * Construction spinning forever on the console.
 */
function stage(run, key, status, detail) {
    if (!run) return;
    const at = run.stages.findIndex((s) => s.key === key);
    if (at === -1) return;
    const s = run.stages[at];
    if (status === 'running' && !s.startedAt) s.startedAt = Date.now();
    if (status !== 'running' && status !== 'pending') s.endedAt = Date.now();
    s.status = status;
    if (detail !== undefined) s.detail = detail;
    if (status !== 'pending') {
        for (let i = 0; i < at; i++) {
            if (run.stages[i].status === 'pending') run.stages[i].status = 'skipped';
        }
    }
}

/**
 * Ends a run, and writes it where a restart cannot reach it.
 *
 * The write happens here and nowhere else: this is the one moment a deployment
 * is complete, and a run that is still going is worth nothing on disk -- the
 * console reads it from memory while it runs.
 */
function finish(run, status, error) {
    if (!run || run.endedAt) return;
    run.status = status;
    run.error = error || null;
    run.endedAt = Date.now();
    // Whatever the run stopped on is over too. A stage left `running` next to a
    // finished run reads as a build still going.
    for (const s of run.stages) {
        if (s.status === 'running') {
            s.status = status === 'ready' ? 'done' : 'failed';
            s.endedAt = run.endedAt;
        } else if (s.status === 'pending') {
            s.status = 'skipped';
        }
    }

    // Best effort by design. `runStore.save` reports a failure and swallows it:
    // a deployment that worked must not be reported as failed because its
    // history could not be written.
    if (run.tenantPaths) runStore.save(run.tenantPaths, snapshot(run, 0));
}

/** The run, if it belongs to this tenant. Slug is checked, never assumed. */
function get(slug, id) {
    const run = byId.get(String(id || ''));
    return run && run.slug === slug ? run : null;
}

function listForProject(slug, projectId) {
    return (byProject.get(projectKey(slug, projectId)) || []).slice();
}

/** Every run this tenant has, newest first. Feeds the Deployments pane. */
function listRecent(slug, limit) {
    const all = [];
    for (const [key, list] of byProject) {
        if (key.startsWith(`${slug}/`)) all.push(...list);
    }
    all.sort((a, b) => b.startedAt - a.startedAt);
    return all.slice(0, limit || 30);
}

/** Forgets a deleted project's runs, so its console cannot be reopened. */
function dropProject(slug, projectId) {
    const key = projectKey(slug, projectId);
    for (const run of byProject.get(key) || []) byId.delete(run.id);
    byProject.delete(key);
}

/**
 * Asks a running deployment to stop.
 *
 * The abort reaches the child process through the signal cloner.js passes to
 * execFile, so git or the sandbox launcher is killed where it stands. The run
 * is not marked cancelled here: `deployNow` is what learns the command died and
 * records it, and marking it here would leave the two disagreeing if the abort
 * arrived a millisecond after the last command finished.
 */
function cancel(run) {
    if (!run || run.endedAt) return false;
    run.controller.abort();
    return true;
}

/**
 * What the browser reads. `after` is the last line number it already has.
 *
 * `resync` says the ring dropped lines the caller never saw, so the console
 * clears and repaints rather than splicing a hole into the middle of a log.
 */
function snapshot(run, after) {
    const from = Number.isFinite(after) ? Math.max(0, after) : 0;
    const resync = from < run.dropped;
    const start = resync ? 0 : from - run.dropped;
    const lines = run.lines.slice(start);

    return {
        id: run.id,
        projectId: run.projectId,
        projectName: run.projectName,
        branch: run.branch,
        sha: run.sha,
        trigger: run.trigger,
        actor: run.actor,
        status: run.status,
        error: run.error,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        stages: run.stages.map((s) => ({
            key: s.key,
            status: s.status,
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            detail: s.detail
        })),
        resync,
        lines,
        cursor: run.dropped + run.lines.length
    };
}

module.exports = {
    STAGES,
    RUN_ID_RE,
    start,
    attach,
    log,
    stage,
    finish,
    get,
    listForProject,
    listRecent,
    dropProject,
    cancel,
    snapshot
};
