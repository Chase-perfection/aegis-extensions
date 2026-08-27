/**
 * One deployment, however it was triggered.
 *
 * Extracted from the create-project route the moment the poller needed the same
 * sequence. Two copies would drift, and the copy that drifts is the one nobody
 * is watching: a push-triggered deployment that behaves differently from the one
 * an operator clicked is the worst version of this bug.
 *
 * Single-flight per project, which is also the plan's supersede rule at this
 * size. Three pushes in a minute produce one deployment of the newest commit,
 * because a tick that finds a deployment already running skips, and the next
 * tick reads whatever head GitHub reports by then. No SUPERSEDED bookkeeping,
 * because nothing was ever queued.
 */

'use strict';

const path = require('path');
const github = require('./github');
const cloner = require('./cloner');
const projectStore = require('./projectStore');
const runs = require('./runs');
const projectEnv = require('./projectEnv');
const runtime = require('./runtime');
const shots = require('./shots');
const migrations = require('./migrations');

/** `<tenant>/<project>` while a deployment is in flight. */
const inFlight = new Set();

/**
 * Le module d'ecriture du coeur, injecte une fois au montage.
 *
 * Passe en variable de module et non en argument de `deployNow`, parce que
 * `deployNow` a cinq appelants (quatre routes et le sweep du poller) et qu'un
 * sixieme oublierait l'argument sans que rien ne le dise : les migrations
 * seraient alors silencieusement sautees sur ce chemin-la. Ici l'oubli est
 * impossible et l'absence est visible.
 *
 * Reste `null` sur un Aegis anterieur a `writableDb`. Cette extension doit
 * pouvoir tourner sur un coeur plus ancien qu'elle, donc l'absence se traite et
 * ne se suppose pas.
 */
let writableDb = null;

function useWritableDb(mod) { writableDb = mod || null; }

/** Refusals that already name what to change. Kept as they are. */
const NAMED = [
    'needs_build', 'no_index', 'no_root_dir', 'bad_root_dir', 'unsafe_symlink',
    'build_failed', 'build_account_unconfigured', 'bad_site_config',
    'runtime_disabled', 'no_runtime_account', 'start_failed', 'unhealthy', 'bad_site_port',
    'migration_failed', 'migrations_unsupported'
];

/**
 * What to call a failure, from the error that carried it.
 *
 * `deploy_failed` used to be every one of these, and the page says of it that
 * the clone failed and the branch is worth checking. That sentence is true of a
 * git exit code and of nothing else here: a build script that returned 1, a
 * host missing git or pwsh, an installation token GitHub refused. Each of those
 * sent the operator to look at a branch that was never the problem, so each one
 * gets its own name.
 */
function reasonFor(e) {
    if (NAMED.includes(e.code)) return e.code;
    // execFile could not start the program at all: git or pwsh is not on the
    // PATH of the account the backend runs as, which on an installed Aegis is
    // SYSTEM and not the operator's own shell.
    if (e.code === 'ENOENT') return 'tool_missing';
    // github.js throws with an HTTP status and no code.
    if (e.status === 401 || e.status === 403) return 'github_auth_failed';
    if (e.status === 502 || e.status === 504) return 'github_unreachable';
    return 'deploy_failed';
}

function key(slug, projectId) {
    return `${slug}/${projectId}`;
}

function isDeploying(slug, projectId) {
    return inFlight.has(key(slug, projectId));
}

/**
 * Clones the branch and publishes it, then records what happened.
 *
 * Returns `{ deployed: false, reason: 'busy' }` rather than throwing when the
 * project is already deploying, because for the poller that is a normal tick and
 * not an error.
 *
 * A failure leaves `current` untouched: `cloneToCurrent` renames into place only
 * after the clone succeeds, so the previous version keeps serving. That is the
 * plan's "failure never takes the site down", and it is why this function
 * records the failure and returns instead of trying to roll anything back.
 *
 * `headSha` is the commit the caller decided to deploy, for the callers that
 * know it before the clone (the poller does; a button does not). It is what a
 * failure gets filed under, so the sweep can stop redeploying a commit that has
 * already failed its attempts -- see `decide` in poller.js.
 */
async function deployNow({ app, slug, tenantPaths, project, trigger, actor, run, headSha }) {
    const k = key(slug, project.id);
    if (inFlight.has(k)) return { deployed: false, reason: 'busy' };
    inFlight.add(k);

    // Every stage and every line the tools print goes here, and `runs.js` holds
    // it for the console to read. A deployment nobody is watching passes no run
    // and the reporter below is never called.
    const report = run
        ? {
            stage: (name, status, detail) => runs.stage(run, name, status, detail),
            log: (text) => runs.log(run, text)
        }
        : null;

    try {
        // No installation means a public repository, cloned with no credential.
        // `cloneToCurrent` builds a plain https URL when the token is null.
        const token = project.installationId
            ? await github.installationToken(app, project.installationId)
            : null;
        const { sha } = await cloner.cloneToCurrent({
            token,
            repoFullName: project.repoFullName,
            branch: project.branch,
            rootDir: project.rootDir || '',
            projectDir: projectStore.projectDir(tenantPaths, project.id),
            currentDir: projectStore.currentDir(tenantPaths, project.id),
            installCmd: project.installCmd || '',
            buildCmd: project.buildCmd || '',
            outputDir: project.outputDir || '',
            // Decrypted here and nowhere earlier: the values exist as
            // plaintext only for the length of one build, and only when the
            // project has a build command at all.
            // A preview reads its parent's variables, and only the ones
            // targeted `preview` or `all`: a branch nobody reviewed must not be
            // handed the values the live site runs on. The parent record is read
            // here rather than copied at creation, so a variable added today
            // reaches a preview created last week.
            buildEnvFor: (sha) => {
                const owner = project.parentId
                    ? (projectStore.getProject(tenantPaths, project.parentId) || project)
                    : project;
                return projectEnv.forBuild(owner, {
                    target: project.parentId ? 'preview' : 'production',
                    sha,
                    branch: project.branch
                });
            },
            // What is on the port and what the last release holds. `publish`
            // needs both: one becomes a release folder, the other is a
            // `previous/` left by an install from before releases existed.
            currentSha: project.lastSha || null,
            previousSha: project.previousSha || null,
            runtime: project.runtime === 'node' ? 'node' : 'static',
            report,
            signal: run ? run.controller.signal : undefined
        });

        if (run) run.sha = sha;

        // Le schema avant le processus. Une version dont le code attend une
        // colonne qui n'existe pas encore repondrait au health check et
        // echouerait a la premiere requete d'un utilisateur, ce qui est la
        // panne la plus chere de la serie : le proxy aurait deja bascule.
        //
        // Et apres `cloner.cloneToCurrent`, parce que les `.sql` sont dans le
        // clone qui vient d'etre publie.
        const migName = project.migrationsDir || migrations.DEFAULT_DIR;
        const migDir = path.join(projectStore.currentDir(tenantPaths, project.id), migName);
        // Lues avant toute autre chose, parce que la reponse a « y a-t-il
        // quelque chose a jouer » decide de tout ce qui suit. Un projet qui
        // n'en a aucune ne merite ni etape, ni ligne de journal : jusqu'a
        // 0.1.3, un site statique sans dossier `migrations/` voyait passer
        // « cette version d Aegis ne sait pas jouer de migration » a chaque
        // deploiement, une phrase alarmante qui ne parlait de rien.
        const found = migrations.list(migDir);

        if (found.length) {
            if (report) {
                report.stage('migrate', 'running',
                    `${found.length} dans ${migName}/`);
            }

            // Un coeur anterieur a `writableDb`. Le deploiement est refuse et
            // pas seulement signale : jusqu'a 0.1.3 cette branche imprimait une
            // ligne et publiait quand meme, donc une version dont le code
            // attend une colonne qui n'existe pas passait toutes les etapes en
            // vert et tombait a la premiere requete d'un utilisateur. Une
            // verification qu'on ne sait pas faire est un echec, pas un
            // commentaire.
            const stop = (code, message) => {
                if (report) {
                    report.log(message);
                    report.stage('migrate', 'failed');
                }
                // Le dossier vient d'etre echange ; la version qui servait
                // repart sur le port, comme apres un demarrage rate.
                try {
                    cloner.rollback({
                        projectDir: projectStore.projectDir(tenantPaths, project.id),
                        currentDir: projectStore.currentDir(tenantPaths, project.id),
                        currentSha: sha,
                        previousSha: project.lastSha || null
                    });
                    if (report) report.log('la version qui servait a ete remise en place');
                } catch (undo) {
                    // Rien a remettre : un premier deploiement qui n'a jamais
                    // servi. Le journal dit pourquoi.
                    console.warn(`[Deploy] ${slug}: ${project.id} pas de version a remettre apres une migration refusee: ${undo.message}`);
                }
                throw Object.assign(new Error(message), { code });
            };

            if (!writableDb) {
                stop('migrations_unsupported',
                    `${migName}/ contient ${found.length} migration(s) et cette version d Aegis ne sait pas les jouer : mettre a jour Aegis sur cet hote`);
            }

            let m;
            try {
                m = await migrations.run({
                    dbFile: path.join(
                        projectStore.ensureDataDir(tenantPaths, project.id),
                        project.dbFile || migrations.DEFAULT_DB),
                    dir: migDir, sha, writableDb
                });
            } catch (e) {
                // `stop` releve, donc `m` n'est jamais lu apres cette branche.
                stop('migration_failed', `migration refusee : ${e.message}`);
            }

            if (report) {
                m.applied.forEach((n) => report.log(`migration appliquee : ${n}`));
                if (!m.applied.length) {
                    report.log(`${found.length} migration(s) deja jouee(s), le schema est a jour`);
                }
                report.stage('migrate', 'done');
            }
        }

        // A project served by a process: the version is on disk, and now it has
        // to answer. `restart` starts it on the slot the running one is not
        // using and only moves the proxy once it answers, so a version that
        // crashes on boot leaves the previous one serving -- but the folder
        // under it has already been swapped, so that has to go back too.
        if (project.runtime === 'node') {
            if (report) report.stage('publish', 'running', project.startCmd || '');
            try {
                const started = await runtime.restart({
                    slug,
                    project,
                    dir: projectStore.currentDir(tenantPaths, project.id),
                    // Created here rather than assumed: a project deployed
                    // before this folder existed has none, and the first push
                    // after the upgrade is when it should get one.
                    dataDir: projectStore.ensureDataDir(tenantPaths, project.id),
                    startCmd: project.startCmd || '',
                    env: projectEnv.forBuild(
                        project.parentId
                            ? (projectStore.getProject(tenantPaths, project.parentId) || project)
                            : project,
                        { target: project.parentId ? 'preview' : 'production', sha, branch: project.branch }
                    ),
                    report
                });
                if (report) report.log(`application answering on 127.0.0.1:${started.port}`);
            } catch (e) {
                try {
                    cloner.rollback({
                        projectDir: projectStore.projectDir(tenantPaths, project.id),
                        currentDir: projectStore.currentDir(tenantPaths, project.id),
                        currentSha: sha,
                        previousSha: project.lastSha || null
                    });
                    if (report) report.log('the version that was serving has been put back');
                } catch (undo) {
                    // Nothing to put back: a first deployment that never
                    // started. The site is down and the log says why.
                    console.warn(`[Deploy] ${slug}: ${project.id} could not be rolled back after a failed start: ${undo.message}`);
                }
                throw e;
            }
        }

        projectStore.saveProject(tenantPaths, Object.assign({}, project, {
            lastSha: sha,
            // Where the branch was when this deployment ran, which is a
            // different question from what is on the port. The poller compares
            // against this one, so promoting an older release does not read as
            // "the branch moved" on the next tick and get undone 20 seconds
            // after the operator clicked.
            lastSeenSha: sha,
            // What `previous/` on disk now holds. Recorded here because this is
            // the only moment both shas are known, and a rollback that cannot
            // name the version it restored is a rollback nobody trusts.
            previousSha: project.lastSha || null,
            deployedAt: Date.now(),
            failureCount: 0,
            lastError: null,
            // Ce commit passe : ce qui avait echoue avant n'a plus a bloquer
            // quoi que ce soit.
            lastFailedSha: null,
            failedShaAttempts: 0,
            history: projectStore.addHistory(project, {
                sha, at: Date.now(), status: 'ready', trigger, actor: actor || null
            })
        }));

        console.log(`[Deploy] ${slug}: ${project.id} ready at ${sha.slice(0, 8)} (${trigger})`);
        if (run) runs.finish(run, 'ready', null);
        // New release on the port means a new first screen. Deliberately not
        // awaited: the deployment is done, and the operator should not wait on
        // a browser starting to take a picture.
        shots.capture({ tenantPaths, project, slug });
        return { deployed: true, sha };
    } catch (e) {
        // An aborted child reports as a killed process, which would otherwise be
        // filed as `deploy_failed` and sent the operator looking for a broken
        // branch. The cancel came from them, so it is named as such.
        const cancelled = !!(run && run.controller.signal.aborted);
        const reason = cancelled ? 'cancelled' : reasonFor(e);

        // Quel commit vient d'echouer. `run.sha` existe des que le clone a
        // abouti ; avant cela seul l'appelant qui a decide du deploiement le
        // connait. Un abandon demande par l'operateur ne compte pas : le commit
        // n'a pas ete juge, il a ete interrompu.
        const failedSha = cancelled ? null : ((run && run.sha) || headSha || null);
        const repeat = !!failedSha && failedSha === project.lastFailedSha;

        projectStore.saveProject(tenantPaths, Object.assign({}, project, {
            failureCount: (project.failureCount || 0) + 1,
            lastError: reason,
            // Compte par commit, a cote de `failureCount` qui compte les echecs
            // consecutifs quels qu'ils soient (un GitHub injoignable en fait
            // partie). C'est celui-ci que `decide` lit, parce que la question
            // qu'il pose est « ce commit-la a-t-il deja eu ses chances », pas
            // « ce projet va-t-il mal ».
            lastFailedSha: failedSha || project.lastFailedSha || null,
            failedShaAttempts: failedSha
                ? (repeat ? (project.failedShaAttempts || 0) + 1 : 1)
                : (project.failedShaAttempts || 0),
            history: projectStore.addHistory(project, {
                sha: failedSha, at: Date.now(), status: cancelled ? 'cancelled' : 'failed',
                error: reason, trigger, actor: actor || null
            })
        }));

        // The tool's own words, redacted because git writes the tokenised clone
        // URL into its failures. Carried on the error so the route can put it in
        // its answer: `deploy_failed` is the catch-all reason, and on its own it
        // sends an operator to check a branch when what actually failed was git
        // missing from the PATH or a rename on a locked folder.
        e.detail = cloner.redact(e.output || e.message || '');

        if (run) {
            runs.log(run, e.detail);
            runs.finish(run, cancelled ? 'cancelled' : 'failed', reason);
        }

        // The token lives in the git URL, so anything git printed gets redacted
        // before it reaches the log.
        console.warn(`[Deploy] ${slug}: ${project.id} failed (${reason}) ${e.detail}`);
        e.reason = reason;
        throw e;
    } finally {
        inFlight.delete(k);
    }
}

/**
 * Puts one kept release back on the port.
 *
 * No clone, no build, no acceptance test: a release is content this project
 * already published, so it passed all three when it was written. That is what
 * makes this the one action here that is instant and cannot be refused for a
 * reason on GitHub's side.
 *
 * `sha` null means the most recent release, which is what the Rollback button
 * asks for: one click, no list to read.
 *
 * Shares `inFlight` with `deployNow` deliberately. Both end by renaming a folder
 * onto `current`, and two of those at once on the same project is how a site
 * ends up serving half of each version.
 */
async function promoteNow({ slug, tenantPaths, project, sha, actor }) {
    const k = key(slug, project.id);
    if (inFlight.has(k)) return { promoted: false, reason: 'busy' };
    inFlight.add(k);

    const projectDir = projectStore.projectDir(tenantPaths, project.id);
    const currentDir = projectStore.currentDir(tenantPaths, project.id);

    try {
        let restored = sha || null;
        if (restored) {
            cloner.promote({
                projectDir, currentDir, sha: restored,
                currentSha: project.lastSha || null,
                previousSha: project.previousSha || null
            });
        } else {
            restored = cloner.rollback({
                projectDir, currentDir,
                currentSha: project.lastSha || null,
                previousSha: project.previousSha || null
            });
        }

        // A project served by a process is now pointing at other files, and the
        // process is still running the ones that were there a moment ago. It has
        // to be restarted or the promote changed nothing anybody can see.
        if (project.runtime === 'node') {
            await runtime.restart({
                slug,
                project,
                dir: currentDir,
                dataDir: projectStore.ensureDataDir(tenantPaths, project.id),
                startCmd: project.startCmd || '',
                env: projectEnv.forBuild(project, {
                    target: 'production', sha: restored || '', branch: project.branch
                })
            });
        }

        // `lastSha` follows the port and `lastSeenSha` does not: the branch is
        // still wherever it was, and the next push is what should deploy
        // forward again.
        projectStore.saveProject(tenantPaths, Object.assign({}, project, {
            lastSha: restored,
            previousSha: project.lastSha || null,
            deployedAt: Date.now(),
            failureCount: 0,
            lastError: null,
            history: projectStore.addHistory(project, {
                sha: restored, at: Date.now(), status: 'ready',
                trigger: sha ? 'promote' : 'rollback', actor: actor || null
            })
        }));

        console.log(`[Deploy] ${slug}: ${project.id} now serving ${String(restored).slice(0, 8)} (${sha ? 'promote' : 'rollback'})`);
        // A promote or a rollback changes what is on the port just as much as a
        // deploy does, so the thumbnail is refreshed here too. Without this the
        // card would show the release the operator just moved away from.
        shots.capture({ tenantPaths, project, slug });
        return { promoted: true, sha: restored };
    } catch (e) {
        if (e.code === 'no_previous' || e.code === 'unknown_release' || e.code === 'bad_release') {
            return { promoted: false, reason: e.code };
        }
        // The folders swapped and the application would not start on them. Named
        // rather than filed as a failed rename, because what to do about it is
        // in the console and not on the disk.
        if (e.code === 'start_failed' || e.code === 'unhealthy' ||
            e.code === 'runtime_disabled' || e.code === 'no_runtime_account' ||
            e.code === 'runtime_acl_failed') {
            return { promoted: false, reason: e.code };
        }
        console.warn(`[Deploy] ${slug}: ${project.id} promote failed: ${e.message}`);
        return { promoted: false, reason: 'rollback_failed' };
    } finally {
        inFlight.delete(k);
    }
}

/** Every version this project could be put back to, newest first. */
function releasesFor(tenantPaths, project) {
    return cloner.listReleases(projectStore.projectDir(tenantPaths, project.id));
}

/**
 * Starts the process for every project that is served by one.
 *
 * Called at boot, next to `startAllSites`. A backend restart otherwise leaves
 * every node project answering 503 from its own port until somebody clicked
 * Deploy on each one.
 *
 * Sequential and awaited nowhere: each application takes seconds to boot and the
 * backend must not wait on them to finish starting. A failure is logged and the
 * project's port answers 503 until the next deployment, which is what it would
 * have done anyway.
 */
function startAllRuntimes({ pathsFor, tenantsRoot }) {
    if (!runtime.isEnabled()) return 0;

    let started = 0;
    for (const { slug, tenantPaths } of projectStore.tenantsWithProjects(tenantsRoot(), pathsFor)) {
        for (const project of projectStore.listProjects(tenantPaths)) {
            if (project.runtime !== 'node' || !project.lastSha || !project.port) continue;
            started += 1;
            runtime.restart({
                slug,
                project,
                dir: projectStore.currentDir(tenantPaths, project.id),
                dataDir: projectStore.ensureDataDir(tenantPaths, project.id),
                startCmd: project.startCmd || '',
                env: projectEnv.forBuild(project, {
                    target: 'production', sha: project.lastSha, branch: project.branch
                })
            }).then(({ port }) => {
                console.log(`[Deploy] ${slug}: ${project.id} application answering on 127.0.0.1:${port}`);
            }).catch((e) => {
                console.error(`[Deploy] ${slug}: ${project.id} did not start (${e.code || 'error'}): ${e.message}`);
            });
        }
    }
    return started;
}

module.exports = {
    deployNow, promoteNow, releasesFor, isDeploying, reasonFor, startAllRuntimes,
    useWritableDb,
    // Test seam. `inFlight` is what stops a project being deleted while its
    // folders are being renamed, and a test cannot reach that state without a
    // real deployment running. Nothing outside tests/ should touch it.
    _inFlight: inFlight
};
