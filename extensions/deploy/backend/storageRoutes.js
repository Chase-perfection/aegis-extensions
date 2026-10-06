/**
 * The routes behind the storage gear of a project.
 *
 * Five of them, all for a tenant administrator, and the split follows what each
 * one is allowed to change:
 *
 *   GET  .../storage           reads the record. Changes nothing.
 *   POST .../storage/check     saves the target as typed and runs the checks.
 *                              A saved target is not a switch: the project
 *                              keeps running on its file.
 *   POST .../storage/preview   rehearses the copy in a transaction it rolls
 *                              back. The database is left as it was.
 *   POST .../storage/switch    moves the project, or brings it back. The one
 *                              route that asks for the administrator's password
 *                              again, because it is the one that stops a site.
 *   GET  .../storage/summary   what the database holds, for the Data tab.
 *
 * No route here takes SQL, returns a password, or writes the approved list.
 * A switch holds the project the way a deployment does (`deployService.exclusive`),
 * so the poller cannot deploy a version in the middle of a copy.
 *
 * `postgres`, `reauthenticate` and a reader with `rows` are core's, handed in by
 * the loader. An Aegis that predates them answers the first route with
 * `capable: false`, the page says so, and nothing below can be reached: the
 * `capability` check fails before any connection, and the switch refuses.
 */

'use strict';

const path = require('path');

const projectStore = require('./projectStore');
const projectStorage = require('./projectStorage');
const storageChecks = require('./storageChecks');
const storageNetwork = require('./storageNetwork');
const storageSwitch = require('./storageSwitch');
const pgMigrations = require('./pgMigrations');
const migrations = require('./migrations');
const runtime = require('./runtime');
const cloner = require('./cloner');
const deployService = require('./deployService');

/** How many tables the Data tab counts. A database with more shows the first ones and says so. */
const SUMMARY_TABLES = 200;

function register(router, { requireOptIn, requireRole, projectOr404, postgres, reauthenticate, readOnlyDb, tcp, settleMs }) {
    // `tcp` replaces the reachability probe, and only the suite passes one: a
    // test that opened a socket to an address would wait on a network it does
    // not have. `settleMs` shortens the wait after a stop, for the same suite.
    const admin = requireRole('admin');
    const base = '/api/deploy/projects/:id/storage';

    const capable = () => !!(postgres && typeof postgres.connect === 'function'
        && typeof reauthenticate === 'function'
        && readOnlyDb && typeof readOnlyDb.rows === 'function');

    /** Why the gear has nothing to offer this project, or null when it has. */
    const unavailable = (project) => {
        if (project.parentId) return 'preview';
        if (project.runtime !== 'node') return 'static_project';
        if (!runtime.isEnabled()) return 'runtime_off';
        return null;
    };

    /** The folder of the version on the port, or null for a project that never published. */
    const versionDirOf = (req, project) => {
        if (!project.lastSha) return null;
        try {
            return cloner.resolveCurrent(projectStore.currentDir(req.tenantPaths, project.id));
        } catch (_) {
            return null;
        }
    };

    const checkDeps = (req, project) => ({
        runtimeEnabled: runtime.isEnabled(),
        accounts: runtime.accounts(),
        postgres,
        reauthenticate,
        reader: readOnlyDb,
        isApproved: projectStorage.isApproved,
        approveCommand: projectStorage.approveCommand,
        versionDir: versionDirOf(req, project),
        inspectPath: (accounts, target) => storageNetwork.inspect(accounts, target),
        tcp
    });

    /** What the switch and the rehearsal need, built from this request. */
    const switchDeps = (req, project) => {
        const slug = req.tenant.slug;
        const versionDir = versionDirOf(req, project);
        return {
            runChecks: () => storageChecks.run({
                project,
                target: projectStorage.targetOf(project),
                password: projectStorage.passwordOf(project),
                deps: checkDeps(req, project)
            }),
            connect: (opts) => postgres.connect(opts),
            reader: readOnlyDb,
            file: path.join(projectStore.ensureDataDir(req.tenantPaths, project.id), project.dbFile || migrations.DEFAULT_DB),
            migrationsDir: versionDir ? pgMigrations.dirFor(versionDir, project) : null,
            sha: project.lastSha || null,
            // Stops the process, then waits out the drain. A version replaced
            // by a deployment a moment ago keeps answering for `DRAIN_MS`
            // before it is killed, and it writes to the same file. The copy
            // must not start while anything can still write.
            stop: async () => {
                runtime.stop(slug, project.id);
                await new Promise((resolve) => setTimeout(resolve, settleMs === undefined ? runtime.DRAIN_MS + 1000 : settleMs));
            },
            start: (p) => deployService.startCurrent({ slug, tenantPaths: req.tenantPaths, project: p }),
            getProject: () => projectStore.getProject(req.tenantPaths, project.id) || project,
            // `storage` is this module's to write, and says so: every other
            // save of a project leaves that field as the disk has it.
            save: (p) => projectStore.saveProject(req.tenantPaths, p, { storage: true })
        };
    };

    /** Whether a project serves from a database other than this target. */
    const liveElsewhere = (project, target) => {
        const live = projectStorage.mode(project) === 'postgres' ? projectStorage.targetOf(project) : null;
        return !!live && (live.host !== target.host || live.port !== target.port
            || live.database !== target.database || live.user !== target.user);
    };

    /**
     * Writes a project's `storage`, and nothing else of it.
     *
     * The record is read again at the moment of the write. The checks before
     * the second save of the `check` route take seconds, a deployment may have
     * finished meanwhile, and the copy this request read at its start would
     * put back the commit and the history of before.
     */
    const saveStorage = (req, id, target, password) => {
        const fresh = projectStore.getProject(req.tenantPaths, id);
        if (!fresh) throw Object.assign(new Error('the project is gone'), { code: 'unknown_project' });
        if (liveElsewhere(fresh, target)) throw Object.assign(new Error('live on another database'), { code: 'switch_back_first' });
        return projectStore.saveProject(req.tenantPaths,
            Object.assign({}, fresh, { storage: projectStorage.withTarget(fresh, target, password) }), { storage: true });
    };

    const view = (project) => {
        const storage = projectStorage.publicView(project);
        const t = storage.target;
        return {
            storage,
            approved: t ? projectStorage.isApproved(t.host, t.port) : null,
            approveCommand: t ? projectStorage.approveCommand(t.host, t.port) : null
        };
    };

    router.get(base, requireOptIn, admin, (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return undefined;
        const reason = unavailable(project);
        return res.json(Object.assign({
            success: true,
            available: !reason,
            reason,
            capable: capable(),
            dbFile: project.dbFile || migrations.DEFAULT_DB,
            migrationsDir: `${project.migrationsDir || migrations.DEFAULT_DIR}/${pgMigrations.SUBDIR}`,
            variable: 'DATABASE_URL'
        }, view(project)));
    });

    router.post(`${base}/check`, requireOptIn, admin, async (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return undefined;
        const body = req.body || {};
        // Nothing is saved on a project the gear is not offered to.
        if (unavailable(project)) return res.status(409).json({ success: false, error: unavailable(project) });

        let target;
        try {
            target = projectStorage.normalise(body.target);
        } catch (e) {
            return res.status(400).json({ success: false, error: e.code || 'bad_target' });
        }
        const typed = typeof body.password === 'string' ? body.password : '';

        // A project serving from a database is not moved to another one by
        // editing a field. It goes back to its file first, and then switches,
        // through the copy and the checks. Only its password may change in
        // place, which is what a rotation needs.
        if (liveElsewhere(project, target)) {
            return res.status(409).json({ success: false, error: 'switch_back_first' });
        }

        let draft;
        try {
            // Saved without the typed password first. It is kept only once the
            // database has accepted it, so a typo is never stored.
            draft = saveStorage(req, project.id, target, '');
        } catch (e) {
            if (e.code === 'switch_back_first') return res.status(409).json({ success: false, error: e.code });
            console.error(`[Deploy] ${req.tenant.slug}: ${project.id} storage target write failed: ${e.message}`);
            return res.status(500).json({ success: false, error: 'storage_write_failed' });
        }

        let result;
        try {
            result = await storageChecks.run({
                project: draft, target,
                password: typed || projectStorage.passwordOf(draft) || '',
                deps: checkDeps(req, draft)
            });
        } catch (e) {
            console.error(`[Deploy] ${req.tenant.slug}: ${project.id} storage checks failed: ${e.message}`);
            return res.status(500).json({ success: false, error: 'storage_check_failed' });
        }

        let kept = draft;
        if (typed && result.checks.some((c) => c.id === 'login' && c.ok === true)) {
            try {
                kept = saveStorage(req, project.id, target, typed);
            } catch (e) {
                // The checks still answer; the password is typed again next time.
                console.warn(`[Deploy] ${req.tenant.slug}: ${project.id} could not keep the checked password: ${e.message}`);
                kept = draft;
            }
        }

        return res.json(Object.assign({ success: true, ok: result.ok, checks: result.checks }, view(kept)));
    });

    router.post(`${base}/preview`, requireOptIn, admin, async (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return undefined;
        if (!capable()) return res.status(501).json({ success: false, error: 'core_too_old' });

        const t = projectStorage.targetOf(project);
        if (!t || !projectStorage.isApproved(t.host, t.port)) {
            return res.status(409).json({ success: false, error: 'not_approved' });
        }
        const deps = switchDeps(req, project);
        if (!deps.migrationsDir) return res.status(409).json({ success: false, error: 'never_deployed' });

        try {
            // Honoured only for the database this project filled itself.
            const replace = !!(req.body && req.body.replace === true) && projectStorage.canReplace(project);
            const r = await storageSwitch.rehearse({ project, deps, replace });
            return res.json({
                success: true, ok: r.ok, tables: r.tables, migrations: r.migrations,
                // Only a Supabase stack serves its tables through an API of its own.
                withoutRls: t.kind === 'supabase' ? r.withoutRls : []
            });
        } catch (e) {
            if (e.code === 'no_target') return res.status(409).json({ success: false, error: 'no_target' });
            // What the database or the file refused, in its own words: a type
            // that does not fit, a migration that does not parse.
            return res.json({ success: true, ok: false, tables: [], migrations: [], withoutRls: [], error: e.code || 'rehearsal_failed', detail: e.message });
        }
    });

    router.post(`${base}/switch`, requireOptIn, admin, async (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return undefined;
        if (!capable()) return res.status(501).json({ success: false, error: 'core_too_old' });

        const to = req.body && req.body.to;
        if (to !== 'postgres' && to !== 'local') return res.status(400).json({ success: false, error: 'bad_mode' });
        if (unavailable(project)) return res.status(409).json({ success: false, error: unavailable(project) });
        // Asked before the password, so nobody types one for a request that
        // could only be refused. `toPostgres` refuses this too.
        if (to === projectStorage.mode(project)) {
            return res.status(409).json({ success: false, error: to === 'postgres' ? 'already_on_postgres' : 'already_local' });
        }

        // The administrator, proved again by their password. Core reads
        // `req.body.password`, re-reads the account and its role, and answers
        // null for anything that does not hold.
        let user = null;
        try {
            user = await reauthenticate(req);
        } catch (e) {
            console.error(`[Deploy] ${req.tenant.slug}: password check failed: ${e.message}`);
        }
        if (!user) return res.status(403).json({ success: false, error: 'password' });

        const actor = user.email || (req.user && req.user.email) || null;
        const slug = req.tenant.slug;
        const held = await deployService.exclusive(slug, project.id, () => {
            const fresh = projectStore.getProject(req.tenantPaths, project.id) || project;
            const deps = switchDeps(req, fresh);
            const replace = !!(req.body && req.body.replace === true) && projectStorage.canReplace(fresh);
            return to === 'postgres'
                ? storageSwitch.toPostgres({ project: fresh, actor, deps, replace })
                : storageSwitch.toLocal({ project: fresh, actor, deps });
        }).catch(async (e) => {
            // Nothing in the switch is meant to throw. If something did, the
            // site may be stopped, and the one thing still worth doing is to
            // start it on whatever the record now says.
            console.error(`[Deploy] ${slug}: ${project.id} storage switch crashed: ${e.message}`);
            const steps = [{ id: 'restore', ok: true, detail: '' }];
            try {
                const now = projectStore.getProject(req.tenantPaths, project.id) || project;
                if (!runtime.isRunning(slug, project.id)) {
                    await deployService.startCurrent({ slug, tenantPaths: req.tenantPaths, project: now });
                }
            } catch (again) {
                steps[0] = { id: 'restore', ok: false, detail: again.message };
            }
            return { busy: false, value: { ok: false, steps, failed: 'crash' } };
        });

        if (held.busy) return res.status(409).json({ success: false, error: 'deploy_in_progress' });

        const result = held.value;
        console.log(`[Deploy] ${slug}: ${project.id} storage switch to ${to} by ${actor}: `
            + (result.ok ? 'done' : `refused at ${result.failed}`));
        const after = projectStore.getProject(req.tenantPaths, project.id) || project;
        return res.json(Object.assign({ success: true }, result, view(after)));
    });

    router.get(`${base}/summary`, requireOptIn, admin, async (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return undefined;
        if (projectStorage.mode(project) !== 'postgres') {
            return res.status(409).json({ success: false, error: 'not_on_postgres' });
        }
        const t = projectStorage.targetOf(project);
        const head = { success: true, target: { host: t.host, port: t.port, database: t.database, kind: t.kind }, consoleUrl: t.consoleUrl || '' };
        if (!capable()) return res.json(Object.assign(head, { healthy: null, tables: [], error: 'core_too_old' }));
        // No connection to an address that left the approved list, from this
        // route like from every other.
        if (!projectStorage.isApproved(t.host, t.port)) {
            return res.json(Object.assign(head, { healthy: false, tables: [], error: 'not_approved' }));
        }

        try {
            const tables = await storageSwitch.withClient({ connect: (opts) => postgres.connect(opts) }, t,
                projectStorage.passwordOf(project), async (client) => {
                    const names = await client.query(
                        'SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace '
                        + "WHERE n.nspname = current_schema() AND c.relkind = 'r' ORDER BY c.relname");
                    const out = [];
                    for (const row of names.rows.slice(0, SUMMARY_TABLES)) {
                        if (row.name === pgMigrations.LEDGER) continue;
                        const n = await client.query(`SELECT count(*)::int AS n FROM "${String(row.name).replace(/"/g, '""')}"`);
                        out.push({ name: row.name, rows: Number(n.rows[0].n) });
                    }
                    return { list: out, more: names.rows.length > SUMMARY_TABLES };
                });
            return res.json(Object.assign(head, { healthy: true, tables: tables.list, more: tables.more }));
        } catch (e) {
            // Not a 500: the page's whole job here is to say whether the
            // database answers, and "it does not" is an answer.
            return res.json(Object.assign(head, { healthy: false, tables: [], detail: e.message }));
        }
    });
}

module.exports = { register, SUMMARY_TABLES };
