/**
 * Moves a project's data to its Postgres database, and back.
 *
 * The one operation in this extension that stops a site on purpose. The copy
 * has to see every row, and a row written while it runs would be in the file
 * and not in the database, so the process is down for as long as the copy
 * takes. Everything else here is about making that window short and making
 * every way out of it end with the site serving.
 *
 * Going to Postgres:
 *
 *   1. the checks again, on the server, whatever the page showed;
 *   2. a rehearsal: migrations and copy in a transaction that is rolled back,
 *      with the site still up. A copy that cannot work is refused here, and the
 *      site never stopped;
 *   3. stop the process;
 *   4. the same passage for real, committed only when every count matches;
 *   5. record the mode, start the process on the database, wait for it to
 *      answer.
 *
 * A failure at 4 restarts the site on its file: nothing was committed. A
 * failure at 5 empties the tables that were just filled, puts the record back
 * on local files and restarts there. The SQLite file is read and never written
 * at any step, which is why going back is always possible.
 *
 * Going back to local files is a restart without the address. Rows written to
 * the database since the switch stay there and are not brought back; the page
 * says so before the operator confirms.
 *
 * Every dependency is handed in. The route builds them from core's
 * capabilities and from `deployService`; the suite builds them from fakes, with
 * one test per step that can fail.
 */

'use strict';

const projectStorage = require('./projectStorage');
const storageCopy = require('./storageCopy');

function step(steps, id, ok, detail) {
    steps.push({ id, ok, detail: detail || '' });
    return ok;
}

/** A connection for the length of `work`, closed on every way out. */
async function withClient(deps, target, password, work) {
    const client = await deps.connect({
        host: target.host, port: target.port, database: target.database,
        user: target.user, password, ssl: target.ssl
    });
    try {
        return await work(client);
    } finally {
        await client.end().catch(() => { });
    }
}

/** The whole passage inside one transaction. `keep` false rolls it back whatever happened. */
async function passage(deps, target, password, keep, replace) {
    return withClient(deps, target, password, async (client) => {
        await client.query('BEGIN');
        try {
            const res = await storageCopy.carry({
                client, reader: deps.reader, file: deps.file, dir: deps.migrationsDir, sha: deps.sha,
                replace: !!replace
            });
            await client.query(keep && res.ok ? 'COMMIT' : 'ROLLBACK');
            return res;
        } catch (e) {
            await client.query('ROLLBACK').catch(() => { });
            throw e;
        }
    });
}

/** The first table a plan refused, as one sentence for the log and the page. */
function refusal(res) {
    const t = res.tables.find((x) => ['missing_table', 'missing_columns', 'not_empty', 'unreadable'].includes(x.state));
    if (!t) return 'the database cannot take this copy';
    if (t.state === 'missing_columns') return `${t.name}: ${t.state} (${t.missingColumns.join(', ')})`;
    return `${t.name}: ${t.state}`;
}

/**
 * What the switch would do to the database, shown before anybody commits to it.
 *
 * The same passage as the switch, rolled back, with the site still up. So the
 * tables and counts the operator reads in the guided setup come from a copy
 * that ran, type errors and refused rows included.
 */
function rehearse({ project, deps, replace }) {
    const target = projectStorage.targetOf(project);
    const password = projectStorage.passwordOf(project);
    if (!target || !password) {
        return Promise.reject(Object.assign(new Error('no target saved for this project'), { code: 'no_target' }));
    }
    return passage(deps, target, password, false, replace);
}

/**
 * Switches a project to its saved Postgres target.
 *
 * `deps`: `runChecks()`, `connect(opts)`, `reader`, `file`, `migrationsDir`,
 * `sha`, `stop()`, `start(project)`, `getProject()`, `save(project)`.
 *
 * Resolves `{ ok, steps, tables, migrations, failed, checks }` and does not
 * throw for anything a step can report.
 */
async function toPostgres({ project, actor, deps, replace }) {
    const steps = [];
    const out = (ok, extra) => Object.assign({ ok, steps }, extra || {});

    // A project already on its database has newer rows there than in its
    // file. Running the copy again would stop the site and, with `replace`,
    // put the old file over them. Refused here and not only in the route:
    // this is the function that would do the damage.
    if (projectStorage.mode(project) === 'postgres') {
        step(steps, 'checks', false, 'already_on_postgres');
        return out(false, { failed: 'checks' });
    }

    const target = projectStorage.targetOf(project);
    const password = projectStorage.passwordOf(project);
    if (!target || !password) {
        step(steps, 'checks', false, 'no_target');
        return out(false, { failed: 'checks' });
    }

    const checked = await deps.runChecks();
    if (!step(steps, 'checks', checked.ok)) return out(false, { failed: 'checks', checks: checked.checks });

    // With the site up. What this refuses costs nobody a second of the site.
    let rehearsal;
    try {
        rehearsal = await passage(deps, target, password, false, replace);
    } catch (e) {
        step(steps, 'rehearsal', false, e.message);
        return out(false, { failed: 'rehearsal' });
    }
    if (!step(steps, 'rehearsal', rehearsal.ok, rehearsal.ok ? '' : refusal(rehearsal))) {
        return out(false, { failed: 'rehearsal', tables: rehearsal.tables });
    }

    await deps.stop();
    step(steps, 'stop', true);

    const backOnFile = async (why) => {
        try {
            await deps.start(deps.getProject());
            step(steps, 'restore', true);
        } catch (e) {
            // The site is down and this could not bring it back. Said as it
            // is: the next deployment, or Redeploy, starts it on its file.
            step(steps, 'restore', false, e.message);
            console.error(`[Deploy] ${project.id}: could not restart on local files after a refused switch (${why}): ${e.message}`);
        }
    };

    let carried;
    try {
        carried = await passage(deps, target, password, true, replace);
    } catch (e) {
        step(steps, 'copy', false, e.message);
        await backOnFile('copy');
        return out(false, { failed: 'copy' });
    }
    if (!step(steps, 'copy', carried.ok, carried.ok ? '' : refusal(carried))) {
        await backOnFile('copy');
        return out(false, { failed: 'copy', tables: carried.tables });
    }

    // Recording the mode and starting on it fail the same way: the rows are
    // committed and the site is not serving from them. One `try` for both, so
    // a record that cannot be written is undone like a process that cannot
    // start, instead of escaping with the site stopped.
    try {
        const fresh = deps.getProject();
        // `filled` names the database this project's rows were copied into.
        // It is what later allows a second switch to replace them, and only
        // them.
        const live = Object.assign({}, fresh, {
            storage: Object.assign(projectStorage.withMode(fresh, 'postgres', actor), { filled: projectStorage.filledKey(target) })
        });
        deps.save(live);
        await deps.start(live);
        step(steps, 'start', true);
    } catch (e) {
        step(steps, 'start', false, e.message);

        // The record first: whatever else fails below, the next start of this
        // project must be on its file.
        try {
            const again = deps.getProject();
            deps.save(Object.assign({}, again, { storage: projectStorage.withMode(again, 'local', actor) }));
        } catch (write) {
            console.error(`[Deploy] ${project.id}: could not put the record back on local files: ${write.message}`);
        }
        try {
            await withClient(deps, target, password, (client) => storageCopy.empty({ client, targets: carried.copiedTargets }));
            step(steps, 'undo', true);
        } catch (undo) {
            // The next attempt will find rows and refuse as `not_empty`, with
            // the table named. Nothing is lost: the file holds them all.
            step(steps, 'undo', false, undo.message);
        }
        await backOnFile('start');
        return out(false, { failed: 'start', tables: carried.tables });
    }

    return out(true, { tables: carried.tables, migrations: carried.migrations, withoutRls: carried.withoutRls });
}

/**
 * Puts a project back on its local file.
 *
 * `deps`: `start(project)`, `getProject()`, `save(project)`. A project that
 * will not start on its file is put back on the database it was serving from,
 * so a refused way back does not leave the site down.
 */
async function toLocal({ project, actor, deps }) {
    const steps = [];
    if (projectStorage.mode(project) !== 'postgres') {
        step(steps, 'start', false, 'already_local');
        return { ok: false, steps, failed: 'start' };
    }

    const fresh = deps.getProject();
    const local = Object.assign({}, fresh, { storage: projectStorage.withMode(fresh, 'local', actor) });
    deps.save(local);

    try {
        await deps.start(local);
        step(steps, 'start', true);
        return { ok: true, steps };
    } catch (e) {
        step(steps, 'start', false, e.message);
        // One `try` for the record and the start: a record that cannot be
        // written back must be reported, not thrown past the caller.
        try {
            const again = deps.getProject();
            const back = Object.assign({}, again, { storage: projectStorage.withMode(again, 'postgres', actor) });
            deps.save(back);
            await deps.start(back);
            step(steps, 'restore', true);
        } catch (e2) {
            step(steps, 'restore', false, e2.message);
        }
        return { ok: false, steps, failed: 'start' };
    }
}

module.exports = { toPostgres, toLocal, rehearse, withClient };
