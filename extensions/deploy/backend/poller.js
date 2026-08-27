/**
 * Push to deploy, for an install GitHub cannot reach.
 *
 * The plan puts the webhook and the poller in the same phase behind the same
 * `deployNow()` call, and only the poller is built: manual App registration
 * produces no webhook secret, so `/api/deploy/webhook` refuses every delivery it
 * cannot verify. On a LAN-only server the poller is not a fallback, it is the
 * mechanism.
 *
 * Cost per tick per project is one conditional request. GitHub answers 304 with
 * no body and no rate-limit charge while the branch has not moved, so the steady
 * state of a project nobody is pushing to is close to free. An installation gets
 * 5000 requests an hour; a project polled every 20 seconds spends 180 of them
 * only on the ticks where something actually changed.
 *
 * `setInterval` and not a job queue. One HTTP call and, on a change, one shallow
 * clone: work measured in seconds, on a machine that is also running an audit
 * dashboard. A queue would be machinery around a loop that has nothing to
 * schedule.
 */

'use strict';

const machineStore = require('./machineStore');
const github = require('./github');
const projectStore = require('./projectStore');
const { deployNow, isDeploying } = require('./deployService');
const runs = require('./runs');
const previews = require('./previews');

const DEFAULT_INTERVAL_MS = 20000;

/**
 * Times the sweep redeploys one commit that keeps failing, before it stops.
 *
 * Three, because the first failure is often the network and the second is often
 * the disk, and neither is the commit's fault. The third says it is.
 *
 * Before 0.1.3 there was no such number: a commit that could not build was
 * retried forever, slowed by the backoff to one attempt every five minutes and
 * stopped by nothing. Each attempt cloned the repository, ran the build account,
 * and filed a run -- so a branch pushed on a Friday spent the weekend failing,
 * and the console filled with two hundred identical consoles. The backoff was
 * doing what it was written to do; what was missing is that a build refused for
 * what the repository contains does not become right by being run again.
 *
 * The block is per commit and clears itself: the next push has a different sha,
 * so nothing has to be reset by hand. Redeploying by hand is always allowed --
 * the buttons call `deployNow` and never come through here.
 */
const SAME_SHA_ATTEMPTS = 3;

let timer = null;
let tick = 0;

/**
 * Whether this project should be polled on this tick.
 *
 * Two reasons to skip. A deployment already running means the previous tick is
 * still cloning, and starting a second one would fight it over `current`;
 * skipping is also what gives supersede behaviour for free. Repeated failures
 * back off, so a deleted branch does not fill the log with one identical line
 * every 20 seconds.
 */
function shouldPoll(project, slug, currentTick) {
    if (isDeploying(slug, project.id)) return false;
    const skip = projectStore.skipTicks(project.failureCount);
    if (skip === 0) return true;
    return currentTick % (skip + 1) === 0;
}

/**
 * Decides what a poll result means, without doing any of it.
 *
 * Split out from `pollProject` so the decision is testable without a network or
 * a clone. The three answers are the whole logic of push-to-deploy: GitHub says
 * nothing moved, the head matches what is already published, or there is a new
 * commit to deploy.
 */
function decide(project, head) {
    if (!head.moved) return { action: 'none', reason: 'not_modified' };
    if (!head.sha) return { action: 'none', reason: 'no_head' };
    // Against the last commit seen on the branch, not against the one on the
    // port. Promoting an older release moves the second and leaves the first
    // alone, so a project someone rolled back is not read as "the branch moved"
    // and deployed forward 20 seconds after they clicked. A record written
    // before that field existed falls back to what is serving, which is what it
    // used to compare with.
    const seen = project.lastSeenSha || project.lastSha;
    if (head.sha === seen) return { action: 'none', reason: 'same_sha' };
    // Ce commit a eu ses chances. Rien ici ne dit qu'il est mauvais -- il est
    // seulement refuse pour la meme raison a chaque fois, et la sweep n'a rien
    // de nouveau a lui apporter. La branche repart au prochain commit.
    if (head.sha === project.lastFailedSha &&
        (project.failedShaAttempts || 0) >= SAME_SHA_ATTEMPTS) {
        return { action: 'none', reason: 'sha_failed' };
    }
    return { action: 'deploy', sha: head.sha };
}

async function pollProject(app, slug, tenantPaths, project) {
    let head;
    try {
        head = await github.branchHead(
            app, project.installationId, project.repoFullName, project.branch, project.pollEtag
        );
    } catch (e) {
        // A 404 here is a branch or repository that went away, which is the
        // operator's to fix. Counted as a failure so the backoff applies.
        projectStore.saveProject(tenantPaths, Object.assign({}, project, {
            failureCount: (project.failureCount || 0) + 1,
            lastError: e.status === 404 ? 'branch_gone' : 'poll_failed'
        }));
        console.warn(`[Deploy] ${slug}: ${project.id} poll failed (${e.status || ''} ${e.message})`);
        return;
    }

    const verdict = decide(project, head);

    // The ETag is worth storing even when nothing moved: it is what makes the
    // next tick free.
    if (head.etag && head.etag !== project.pollEtag) {
        projectStore.saveProject(tenantPaths, Object.assign({}, project, { pollEtag: head.etag }));
        project = Object.assign({}, project, { pollEtag: head.etag });
    }

    if (verdict.action !== 'deploy') return;

    console.log(`[Deploy] ${slug}: ${project.id} ${project.branch} moved to ${verdict.sha.slice(0, 8)}`);
    try {
        // Recorded like a deployment someone clicked, so an automatic republish
        // that failed has a console to open. Nobody is watching this one live,
        // and its log is the only place the reason exists once the sweep moves
        // on: the line below says which project failed, not what the build
        // printed.
        await deployNow({
            app, slug, tenantPaths, project, trigger: 'poll',
            // Le commit dont la sweep a decide. `deployNow` ne le connaitrait
            // sinon qu'apres le clone, donc un clone refuse ne saurait pas quel
            // commit compter et le meme serait retente sans fin.
            headSha: verdict.sha,
            run: runs.start({
                slug,
                tenantPaths,
                projectId: project.id,
                projectName: project.name,
                branch: project.branch,
                trigger: 'poll'
            })
        });
    } catch (_) {
        // deployNow already recorded the failure and logged the reason. Swallowed
        // here so one broken project cannot stop the sweep for the others.
    }
}

async function sweep({ pathsFor, tenantsRoot }) {
    if (!machineStore.isEnabled()) return;

    tick += 1;

    // Once a sweep, before the polling: a preview that is about to be removed
    // is not worth a conditional request to GitHub. A week is not a deadline
    // that needs a timer of its own, and this loop already walks every tenant.
    try {
        previews.expireAll({ pathsFor, tenantsRoot });
    } catch (e) {
        console.warn(`[Deploy] preview expiry failed: ${e.message}`);
    }

    for (const { slug, tenantPaths } of projectStore.tenantsWithProjects(tenantsRoot(), pathsFor)) {
        // Resolved per tenant, and inside the loop for that reason: a
        // registration belongs to one tenant, so the sweep cannot hold one App
        // and spend it on every project it walks past. May be null, and that is
        // a normal state: a project on a public repository is polled and cloned
        // with no credential at all, so a missing App stops only the private
        // ones, tenant by tenant.
        const app = machineStore.getGitHubApp(slug);

        for (const project of projectStore.listProjects(tenantPaths)) {
            if (project.installationId && !(app && app.privateKey)) continue;
            if (!shouldPoll(project, slug, tick)) continue;
            // Sequential on purpose: the clone that may follow is disk-bound, and
            // two at once on one server is slower than two in a row.
            await pollProject(app, slug, tenantPaths, project);
        }
    }
}

/**
 * Starts the poll loop once. Called from `register`, which core runs at boot.
 *
 * `unref` so the interval never holds the process open: a backend asked to shut
 * down should not wait 20 seconds for a timer nobody is watching.
 */
function startPoller({ pathsFor, tenantsRoot, intervalMs }) {
    if (timer) return timer;
    const every = Number(intervalMs || process.env.AEGIS_DEPLOY_POLL_MS || DEFAULT_INTERVAL_MS);
    if (every <= 0) {
        console.log('[Deploy] polling disabled (AEGIS_DEPLOY_POLL_MS=0)');
        return null;
    }

    timer = setInterval(() => {
        sweep({ pathsFor, tenantsRoot }).catch((e) => {
            // A throw here would be an unhandled rejection that takes the backend
            // down. The sweep is best-effort by nature.
            console.error('[Deploy] poll sweep failed:', e.message);
        });
    }, every);
    timer.unref();

    console.log(`[Deploy] polling branches every ${Math.round(every / 1000)}s`);
    return timer;
}

module.exports = { startPoller, shouldPoll, decide, DEFAULT_INTERVAL_MS, SAME_SHA_ATTEMPTS };
