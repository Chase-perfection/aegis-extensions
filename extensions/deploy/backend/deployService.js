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
const pgMigrations = require('./pgMigrations');
const projectStorage = require('./projectStorage');
const storageNetwork = require('./storageNetwork');

/** `<tenant>/<project>` while a deployment is in flight. */
const inFlight = new Set();

/**
 * Runs `fn` while holding a project the way a deployment holds it.
 *
 * For the storage switch, which stops the process, copies its data and starts
 * it again. A push picked up by the poller in the middle of that would start a
 * version on a half-filled database, so the switch takes the same lock a
 * deployment takes, and each refuses while the other runs.
 */
async function exclusive(slug, projectId, fn) {
    const k = key(slug, projectId);
    if (inFlight.has(k)) return { busy: true };
    inFlight.add(k);
    try {
        return { busy: false, value: await fn() };
    } finally {
        inFlight.delete(k);
    }
}

/**
 * Core's Postgres client, injected once at mount like `writableDb` below and
 * for the same reason: every path into `deployNow` then has it or none does.
 * Null on an Aegis that predates the capability.
 */
let postgres = null;

function usePostgres(cap) { postgres = cap || null; }

/**
 * What a project's storage adds to the start of its process.
 *
 * One function for the three places a process starts (a deployment, a promote,
 * the boot) and for the switch, so none of them can start a project on a
 * database without its address, or leave a firewall path open for a project
 * that went back to local files. `prepare` is called by `runtime.restart` with
 * the account it chose.
 */
function runtimeExtras(project) {
    const onPostgres = !project.parentId && projectStorage.mode(project) === 'postgres';
    const saved = onPostgres ? projectStorage.targetOf(project) : null;
    // Read again at every start. An administrator who takes an address off
    // the approved list means the path closed, and the next start closes it.
    const target = saved && projectStorage.isApproved(saved.host, saved.port) ? saved : null;
    return {
        env: projectStorage.runtimeEnv(project),
        prepare: (account) => storageNetwork.ensureFor(account, target)
    };
}

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

/** How long, and how often, `current` is retried while an old process holds it. */
const REPOINT_RETRY_MS = 2000;
const REPOINT_GIVE_UP_MS = 120000;

/**
 * Points `current` at the version that now answers, after it answers.
 *
 * Never a reason to fail the deployment: the proxy already sends traffic to the
 * new process, and `current` only feeds what reads files beside it. The one
 * expected failure is the first deployment after an upgrade, where `current` is
 * still the real folder the old process runs in and cannot be filed until that
 * process has been drained and killed. That case retries on a timer; anything
 * else is logged and the next deployment tries again.
 */
function repointCurrent({ slug, tenantPaths, project, sha, oldSha, report }) {
    const args = {
        projectDir: projectStore.projectDir(tenantPaths, project.id),
        currentDir: projectStore.currentDir(tenantPaths, project.id),
        sha, oldSha
    };
    const busy = (e) => e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES');
    const tidy = () => cloner.pruneReleases(args.projectDir, [sha, oldSha]);
    try {
        cloner.pointCurrent(args);
        tidy();
        return true;
    } catch (e) {
        if (!busy(e)) {
            console.warn(`[Deploy] ${slug}: ${project.id} current/ not repointed: ${e.message}`);
            return false;
        }
    }
    if (report) report.log('current/ is still held by the previous process, repointed once it stops');
    const deadline = Date.now() + REPOINT_GIVE_UP_MS;
    const again = () => {
        try {
            cloner.pointCurrent(args);
            tidy();
            console.log(`[Deploy] ${slug}: ${project.id} current/ now points at ${String(sha).slice(0, 8)}`);
        } catch (e) {
            if (busy(e) && Date.now() < deadline) {
                const t = setTimeout(again, REPOINT_RETRY_MS);
                if (t.unref) t.unref();
                return;
            }
            console.warn(`[Deploy] ${slug}: ${project.id} current/ not repointed: ${e.message}`);
        }
    };
    const t = setTimeout(again, REPOINT_RETRY_MS);
    if (t.unref) t.unref();
    return false;
}

/** Refusals that already name what to change. Kept as they are. */
const NAMED = [
    'needs_build', 'no_index', 'not_a_site', 'no_root_dir', 'bad_root_dir', 'unsafe_symlink',
    'build_failed', 'runtime_missing', 'build_account_unconfigured', 'sandbox_unavailable', 'bad_site_config', 'bad_deploy_manifest',
    'runtime_disabled', 'no_runtime_account', 'start_failed', 'unhealthy', 'bad_site_port',
    'migration_failed', 'migrations_unsupported',
    // The branch declares packages its start command imports and the project
    // has no install command. Carries `needs`, which the page turns into the
    // yes-or-no question.
    'needs_dependencies',
    // An App that cannot get a token for this repository. 401 and 403 are named
    // below, but GitHub answers 404 for an installation that is not this App's,
    // and that landed in deploy_failed, which is the sentence about the branch.
    'needs_install'
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
/**
 * A clone token for this project, resolving the installation again when the
 * stored one is refused.
 *
 * `project.installationId` is written when the project is created and never
 * checked against GitHub afterwards, so it outlives the App that issued it.
 * Registering a new App, or uninstalling and installing again, mints a
 * different installation, and GitHub answers 404 for the old one. That reached
 * the operator as "the clone failed, check the branch exists", which sends them
 * to look at the one thing that was fine.
 *
 * So a refusal costs one more call, the id it finds is written back, and the
 * next deployment is one call again. A project that never had an installation
 * is looked up too, which is what makes installing the App after creating the
 * project work without recreating it.
 *
 * Nothing found and nothing stored means a public repository cloned with no
 * credential, which is the existing behaviour. Nothing found where there used
 * to be something is `needs_install`, because a private repository about to
 * fail on git authentication should say which thing to fix.
 */
async function tokenForProject(app, tenantPaths, project, say) {
    if (!app || !app.privateKey) return null;
    const stored = project.installationId;

    if (stored) {
        try {
            return await github.installationToken(app, stored);
        } catch (e) {
            if (e.status !== 404 && e.status !== 401) throw e;
            github.forgetInstallationToken(stored);
            if (say) {
                say.log(`The GitHub installation this project was created with (${stored}) is not this App's `
                    + 'any more. Looking the repository up again.\n');
            }
        }
    }

    const found = await github.installationForRepo(app, project.repoFullName);

    if (stored && (!found || String(found) === String(stored))) {
        // Either no installation covers the repository now, or GitHub still
        // names the one it just refused. Re-minting would fail identically, and
        // a second 404 explains nothing the first did not.
        throw Object.assign(
            new Error(`no usable App installation for ${project.repoFullName}`),
            { code: 'needs_install' });
    }

    if (String(found || '') !== String(stored || '')) {
        project.installationId = found || null;
        projectStore.saveProject(tenantPaths, project);
    }
    if (!found) return null;
    if (say) say.log(`GitHub installation ${found} covers ${project.repoFullName}.\n`);
    return github.installationToken(app, found);
}

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
        // Where the data lives is read again, now that the project is held.
        // The record a caller passes can be minutes old (the poller's sweep
        // reads every project once), and a storage switch may have completed
        // since. Deploying from the stale one would start the new version on
        // the old file and play the wrong migrations.
        const onDisk = projectStore.getProject(tenantPaths, project.id);
        if (onDisk) {
            if (onDisk.storage === undefined) delete project.storage;
            else project.storage = onDisk.storage;
        }

        // No installation means a public repository, cloned with no credential.
        // `cloneToCurrent` builds a plain https URL when the token is null.
        const token = await tokenForProject(app, tenantPaths, project, report);
        const { sha, manifestChanged, dir } = await cloner.cloneToCurrent({
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
            startCmd: project.startCmd || '',
            report,
            signal: run ? run.controller.signal : undefined
        });

        if (run) run.sha = sha;

        if (manifestChanged && Object.keys(manifestChanged).length) {
            // Written after the clone succeeded, never before: a manifest that
            // broke the build must not leave the record describing a project
            // nobody can deploy.
            Object.assign(project, manifestChanged);
            projectStore.saveProject(tenantPaths, project);
        }

        // Le schema avant le processus. Une version dont le code attend une
        // colonne qui n'existe pas encore repondrait au health check et
        // echouerait a la premiere requete d'un utilisateur, ce qui est la
        // panne la plus chere de la serie : le proxy aurait deja bascule.
        //
        // Et apres `cloner.cloneToCurrent`, parce que les `.sql` sont dans le
        // clone qui vient d'etre publie.
        // `versionDir` est le dossier de CETTE version : `current/` pour un site
        // statique, `releases/<sha>` pour un projet a processus, ou `current`
        // designe encore la version qui sert (voir `cloner.stageRelease`).
        const byProcess = project.runtime === 'node';
        const versionDir = dir || projectStore.currentDir(tenantPaths, project.id);
        const migName = project.migrationsDir || migrations.DEFAULT_DIR;
        const migDir = path.join(versionDir, migName);
        // Lues avant toute autre chose, parce que la reponse a « y a-t-il
        // quelque chose a jouer » decide de tout ce qui suit. Un projet qui
        // n'en a aucune ne merite ni etape, ni ligne de journal : jusqu'a
        // 0.1.3, un site statique sans dossier `migrations/` voyait passer
        // « cette version d Aegis ne sait pas jouer de migration » a chaque
        // deploiement, une phrase alarmante qui ne parlait de rien.
        const found = migrations.list(migDir);

        // A project on an external database gets its Postgres files played
        // there, and its SQLite file is left exactly as the switch froze it:
        // that file is the way back, and a migration applied to it would make
        // it something other than what the operator was told is kept.
        const onPostgres = byProcess && !project.parentId && projectStorage.mode(project) === 'postgres';
        if (onPostgres) {
            const pgDir = pgMigrations.dirFor(versionDir, project);
            const pgFound = pgMigrations.list(pgDir);
            {
                if (report) report.stage('migrate', 'running', `${pgFound.length} in ${migName}/${pgMigrations.SUBDIR}/`);
                // Nothing has moved: the version waits in `releases/` and the
                // previous one is still on the port.
                const stop = (code, message) => {
                    if (report) {
                        report.log(message);
                        report.stage('migrate', 'failed');
                        report.log('the version that was serving is still serving');
                    }
                    throw Object.assign(new Error(message), { code });
                };
                // A version that lost its Postgres files is a version whose
                // code expects the local file again. The switch refused that
                // at its `code` check; a later push must not walk around it.
                // Started with the database address, it would answer its
                // health check and fail on the first page that reads data.
                if (!pgFound.length) {
                    stop('migration_failed',
                        `this project keeps its data in Postgres and this version has no file in ${migName}/${pgMigrations.SUBDIR}/: its code cannot use the database`);
                }
                if (!postgres || typeof postgres.connect !== 'function') {
                    stop('migrations_unsupported',
                        `${migName}/${pgMigrations.SUBDIR}/ holds ${pgFound.length} migration(s) and this Aegis cannot reach a Postgres database: update Aegis on this host`);
                }
                const target = projectStorage.targetOf(project);
                // The service is not behind the sandbox's firewall rules, so
                // the approved list is checked here too, every time: nothing
                // in this extension connects to an address that is not on it.
                if (!projectStorage.isApproved(target.host, target.port)) {
                    stop('migration_failed',
                        `${target.host}:${target.port} is no longer approved on this server, so its migrations cannot be played`);
                }
                let m;
                let client = null;
                try {
                    client = await postgres.connect(Object.assign({}, target, { password: projectStorage.passwordOf(project) }));
                    m = await pgMigrations.run({ client, dir: pgDir, sha });
                } catch (e) {
                    stop('migration_failed', `migration refused: ${e.message}`);
                } finally {
                    if (client) await client.end().catch(() => { });
                }
                if (report) {
                    m.applied.forEach((n) => report.log(`migration applied: ${n}`));
                    if (!m.applied.length) report.log(`${pgFound.length} migration(s) already applied, the schema is up to date`);
                    report.stage('migrate', 'done');
                }
            }
        }

        if (!onPostgres && found.length) {
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
                // Un projet a processus n'a rien deplace : sa version attend
                // dans `releases/`, la precedente sert toujours.
                if (byProcess) {
                    if (report) report.log('la version qui sert n a pas bouge');
                    throw Object.assign(new Error(message), { code });
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

        // A project served by a process: the version is in its own folder, and
        // now it has to answer. `restart` starts it there, on the slot the
        // running one is not using, and only moves the proxy once it answers,
        // so a version that crashes on boot leaves the previous one serving
        // with nothing on disk to put back. `current` is repointed after.
        if (byProcess) {
            if (report) report.stage('publish', 'running', project.startCmd || '');
            try {
                const extras = runtimeExtras(project);
                const started = await runtime.restart({
                    slug,
                    project,
                    dir: versionDir,
                    // Created here rather than assumed: a project deployed
                    // before this folder existed has none, and the first push
                    // after the upgrade is when it should get one.
                    dataDir: projectStore.ensureDataDir(tenantPaths, project.id),
                    startCmd: project.startCmd || '',
                    // The storage address last, so a variable of the same name
                    // typed in the Variables tab cannot point a switched
                    // project at another database than the one that was checked.
                    env: Object.assign(projectEnv.forBuild(
                        project.parentId
                            ? (projectStore.getProject(tenantPaths, project.parentId) || project)
                            : project,
                        { target: project.parentId ? 'preview' : 'production', sha, branch: project.branch }
                    ), extras.env),
                    prepare: extras.prepare,
                    report
                });
                if (report) report.log(`application answering on 127.0.0.1:${started.port}`);
            } catch (e) {
                // Nothing moved on disk: the version that was serving still is.
                if (report) report.log('the version that was serving is still serving');
                throw e;
            }
            repointCurrent({ slug, tenantPaths, project, sha, oldSha: project.lastSha || null, report });
        } else {
            // The record says static and something may still be running from
            // when it did not. Stopping here and not in the route keeps one
            // path into the runtime. `stop` returns false when nothing was
            // running, which is the ordinary case: every static deployment
            // reaches this line.
            runtime.stop(slug, project.id);
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
            // Answered, or no longer asked: the question leaves the card.
            needs: null,
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

        // The question the page asks, kept on the record because a push
        // deploys with nobody watching: the card is where the operator meets
        // it. A preview cannot answer it, its settings are its parent's.
        const needs = reason === 'needs_dependencies' && e.needs
            ? Object.assign({}, e.needs, { preview: !!project.parentId })
            : null;
        if (run && needs) run.needs = needs;

        projectStore.saveProject(tenantPaths, Object.assign({}, project, {
            failureCount: (project.failureCount || 0) + 1,
            lastError: reason,
            needs,
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
        // A project served by a process: nothing is renamed. The kept version
        // starts in its own folder, takes the port once it answers, and
        // `current` follows -- the same three steps as a deployment, minus the
        // build.
        if (project.runtime === 'node') {
            const found = cloner.findRelease({
                projectDir, sha,
                currentSha: project.lastSha || null,
                previousSha: project.previousSha || null
            });
            const extras = runtimeExtras(project);
            await runtime.restart({
                slug,
                project,
                dir: found.dir,
                dataDir: projectStore.ensureDataDir(tenantPaths, project.id),
                startCmd: project.startCmd || '',
                env: Object.assign(projectEnv.forBuild(project, {
                    target: 'production', sha: found.sha, branch: project.branch
                }), extras.env),
                prepare: extras.prepare
            });
            repointCurrent({ slug, tenantPaths, project, sha: found.sha, oldSha: project.lastSha || null });
            return finishPromote({ slug, tenantPaths, project, restored: found.sha, sha, actor });
        }

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

        return finishPromote({ slug, tenantPaths, project, restored, sha, actor });
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

/** Records what a promote or a rollback put on the port. */
function finishPromote({ slug, tenantPaths, project, restored, sha, actor }) {
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
}

/** Every version this project could be put back to, newest first. */
function releasesFor(tenantPaths, project) {
    // A project served by a process keeps the version on the port under
    // `releases/` too; it is not one to put back.
    return cloner.listReleases(projectStore.projectDir(tenantPaths, project.id))
        .filter((r) => r.sha !== project.lastSha);
}

/**
 * Starts the version a project already published, as it is on disk.
 *
 * What the boot does for every project, and what the storage switch does for
 * one after it changed where the data lives. No clone and no migration: the
 * caller knows the version is the one that was serving.
 */
function startCurrent({ slug, tenantPaths, project }) {
    const extras = runtimeExtras(project);
    return runtime.restart({
        slug,
        project,
        // The folder behind the link, not the link: a process started
        // through `current` would hold whatever it points at when the
        // next deployment repoints it.
        dir: cloner.resolveCurrent(projectStore.currentDir(tenantPaths, project.id)),
        dataDir: projectStore.ensureDataDir(tenantPaths, project.id),
        startCmd: project.startCmd || '',
        env: Object.assign(projectEnv.forBuild(project, {
            target: 'production', sha: project.lastSha, branch: project.branch
        }), extras.env),
        prepare: extras.prepare
    });
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
            startCurrent({ slug, tenantPaths, project }).then(({ port }) => {
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
    useWritableDb, usePostgres, exclusive, runtimeExtras, startCurrent,
    // Test seam. Reaching this through deployNow would mean a real clone, a
    // real build and a real runtime for a decision made before any of them.
    _tokenForProject: tokenForProject,
    // Test seam. `inFlight` is what stops a project being deleted while its
    // folders are being renamed, and a test cannot reach that state without a
    // real deployment running. Nothing outside tests/ should touch it.
    _inFlight: inFlight
};
