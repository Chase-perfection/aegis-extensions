/**
 * The database files a project keeps, and which of them a request may name.
 *
 * The reading itself is core's (`backend/src/lib/readOnlyDb.js`, handed in by
 * the loader, because `sqlite3` does not resolve from here). What lives in this
 * file is the part that is about Deploy: a project owns exactly one folder that
 * deployments do not touch, and a request must not be able to name anything
 * outside it.
 *
 * Three checks, and each one refuses a different mistake:
 *
 *   - The name is matched against `FILE_RE`. That rules out a path separator, a
 *     leading dot, and anything long enough to be an attack on the joins below.
 *   - The join is resolved and its parent compared with the project's own data
 *     folder. A name that survived the pattern and still points elsewhere is
 *     refused here, so the pattern is a fast filter and not the only guard.
 *   - `lstat` refuses a symlink rather than following it, which is the same
 *     refusal `cloner.js` makes about what it is asked to serve. A link planted
 *     in `data/` by the application would otherwise read any file the Aegis
 *     process can, and the Aegis process runs as SYSTEM.
 *
 * The suffix list is not security, it is honesty: it stops the page offering to
 * open a log file as a database. The three checks above are what make the path
 * safe.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const projectStore = require('./projectStore');

/**
 * What a database file may be called.
 *
 * No slash, no backslash, no leading dot, and bounded. Windows and POSIX
 * separators are both excluded by construction rather than by stripping, which
 * is the version of this check that does not have a bypass.
 */
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/** Recognised on sight. Anything else in the folder is listed as not a database. */
const SUFFIXES = ['.db', '.sqlite', '.sqlite3', '.db3'];

function looksLikeDb(name) {
    const lower = name.toLowerCase();
    return SUFFIXES.some((s) => lower.endsWith(s));
}

function fail(code, message) {
    return Object.assign(new Error(message), { code });
}

/**
 * The absolute path of one file inside one project's data folder, or a throw.
 *
 * Returns the path only. Whether it exists and whether SQLite can read it are
 * separate answers, given by `list` and by core's reader, because "the name is
 * not allowed" and "the file is not there" are different sentences for the
 * operator.
 */
function resolveFile(tenantPaths, projectId, name) {
    if (typeof name !== 'string' || !FILE_RE.test(name)) {
        throw fail('bad_file', `not a database file name: ${name}`);
    }
    const dir = projectStore.dataDir(tenantPaths, projectId);
    const full = path.resolve(dir, name);
    // Compared as directories rather than by prefix: a prefix test says
    // `<dir>-other/x` is inside `<dir>`, and this one does not.
    if (path.dirname(full) !== path.resolve(dir)) {
        throw fail('bad_file', `${name} resolves outside the project data folder`);
    }

    let st;
    try {
        st = fs.lstatSync(full);
    } catch (_) {
        throw fail('unknown_file', `${name} is not in this project's data folder`);
    }
    if (st.isSymbolicLink()) {
        throw fail('bad_file', `${name} is a link, which Aegis will not follow`);
    }
    if (!st.isFile()) {
        throw fail('bad_file', `${name} is not a file`);
    }
    return full;
}

/**
 * Everything in the folder, database or not.
 *
 * Files that are not databases are listed rather than hidden: an operator
 * looking for a table they cannot find is better served by seeing that the
 * application wrote `app.db.tmp` and nothing else than by an empty pane.
 *
 * Not recursive. A folder the application organises into subfolders is its
 * business; this pane is about the databases it keeps, and walking an unbounded
 * tree to find them is a cost with no ceiling.
 */
function list(tenantPaths, projectId) {
    const dir = projectStore.dataDir(tenantPaths, projectId);
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
        // No folder yet is the normal state of a project deployed before this
        // existed, and of every static project. Not an error.
        return [];
    }

    return entries
        .filter((e) => e.isFile() && FILE_RE.test(e.name))
        .map((e) => {
            const full = path.join(dir, e.name);
            let st = null;
            try {
                const raw = fs.lstatSync(full);
                st = { bytes: raw.size, modified: raw.mtimeMs };
            } catch (_) { /* removed between readdir and here */ }
            return {
                name: e.name,
                bytes: st ? st.bytes : null,
                modified: st ? st.modified : null,
                isDatabase: looksLikeDb(e.name)
            };
        })
        .sort((a, b) => {
            if (a.isDatabase !== b.isDatabase) return a.isDatabase ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
}

module.exports = { FILE_RE, SUFFIXES, looksLikeDb, resolveFile, list };
