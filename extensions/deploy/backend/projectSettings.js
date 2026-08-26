/**
 * Turning what a browser sent into the two settings a project keeps.
 *
 * `dbFile` and `migrationsDir` are settings a project owns because it is the
 * application, not Aegis, that chooses them: the first is the file it opens
 * under its data folder, the second a path inside its own clone. Aegis only
 * has to make sure neither one escapes the folder it belongs to.
 *
 * No filesystem, no network, no database: the two checks below only look at
 * the string a request sent. That is what makes them testable without a
 * fixture and safe to call before the run has anything else to show.
 *
 * A caller cannot forget the refusal, because there is nothing else to do
 * with the result: each function either returns the settled value or throws
 * an error carrying a `code`, the same shape `projectData.js` already uses
 * for its own refusals.
 */

'use strict';

const projectData = require('./projectData');
const migrations = require('./migrations');

function fail(code, message) {
    return Object.assign(new Error(message), { code });
}

/**
 * The database file name a project will open, or a throw with code
 * `bad_db_file`.
 *
 * Checked with the same two rules `projectData.resolveFile` applies later,
 * and not with a rule written for this occasion: a name accepted at creation
 * and refused at open time would be a project that cannot reach its own
 * database.
 */
function resolveDbFile(raw) {
    const dbFile = raw ? String(raw).trim() : migrations.DEFAULT_DB;
    if (!projectData.FILE_RE.test(dbFile) || !projectData.looksLikeDb(dbFile)) {
        throw fail('bad_db_file', `not a database file name: ${dbFile}`);
    }
    return dbFile;
}

/**
 * What a migrations folder inside a clone may be called, or a throw with
 * code `bad_migrations_dir`.
 *
 * Trailing slashes are stripped before the check, since `migrations/` and
 * `migrations` name the same folder and only one of them should have to be
 * typed correctly. No segment may be `..`, empty, or start with a dot: a
 * single pattern cannot see across `/`-joined segments, so climbing out is
 * ruled out by walking the split path rather than by the regular expression
 * alone.
 */
function resolveMigrationsDir(raw) {
    const migrationsDir = raw
        ? String(raw).trim().replace(/[\\/]+$/, '')
        : migrations.DEFAULT_DIR;
    const ok = /^[A-Za-z0-9][A-Za-z0-9._\\/-]{0,119}$/.test(migrationsDir) &&
        !migrationsDir.split(/[\\/]/).some((s) => s === '..' || s === '' || s.startsWith('.'));
    if (!ok) {
        throw fail('bad_migrations_dir', `not a migrations folder: ${migrationsDir}`);
    }
    return migrationsDir;
}

module.exports = { resolveDbFile, resolveMigrationsDir };
