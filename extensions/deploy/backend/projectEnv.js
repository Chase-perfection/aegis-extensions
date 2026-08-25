/**
 * Environment variables a project's build can read.
 *
 * They sit on the project record rather than in a table of their own. Plan
 * 0001 draws a `project_env` table and it does not earn itself yet: a handful
 * of rows per project, read once per deployment, written by hand. What the
 * record cannot do is hold them in clear, because `projects.json` lives in a
 * tenant folder inside a tree OneDrive synchronises, so every value goes
 * through `machineStore.encrypt` under the same key the GitHub App private key
 * uses.
 *
 * Write-only, deliberately. `list` returns key, target and a timestamp, and
 * there is no route anywhere that decrypts a value back to a browser. Vercel
 * lets an operator reveal one; an audit server should not grow an endpoint
 * whose whole job is handing back secrets, and replacing a value someone forgot
 * costs one paste.
 *
 * `target` is `all`, `production` or `preview`. Previews do not exist yet
 * (tranche 3 of docs/plans/0002-deploy-vercel-parity.md); the field is here now
 * so they arrive without a migration of every stored record.
 */

'use strict';

const machineStore = require('./machineStore');

/** What a process on Windows will accept as a name, which is also what cmd expands. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Names a project may not take.
 *
 * The first group is the baseline `build/launcher.js` hands the sandbox: a
 * project that could set `PATH` or `ComSpec` chooses which binary the build
 * command actually runs, which is the restriction the sandbox exists to impose.
 * The second is Aegis's own prefix, which carries the build account password
 * and the values `forBuild` sets below.
 */
const RESERVED = new Set(['PATH', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP',
    'PSMODULEPATH', 'PROGRAMDATA', 'USERNAME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA']);

const RESERVED_PREFIX = 'AEGIS_';

const TARGETS = new Set(['all', 'production', 'preview']);

/**
 * Caps. The whole set is passed to a child process as one environment block,
 * which Windows limits to 32 KB including everything the block already carries,
 * so 50 keys of 4 KB is already past what will fit and these are a refusal the
 * operator can read rather than a build that dies on `CreateProcess`.
 */
const MAX_KEYS = 50;
const MAX_VALUE_LENGTH = 4096;

function refuse(code, message) {
    return Object.assign(new Error(message), { code });
}

function assertKey(key) {
    if (!KEY_RE.test(String(key || ''))) {
        throw refuse('bad_env_key',
            `${key || '(empty)'} is not a variable name: letters, digits and _ , not starting with a digit`);
    }
    const upper = String(key).toUpperCase();
    if (RESERVED.has(upper) || upper.startsWith(RESERVED_PREFIX)) {
        throw refuse('reserved_env_key', `${key} is set by Aegis or by the build sandbox and cannot be overridden`);
    }
}

function normaliseTarget(target) {
    const value = String(target || 'all').toLowerCase();
    if (!TARGETS.has(value)) throw refuse('bad_env_target', `${target} is not one of all, production, preview`);
    return value;
}

function currentEnv(project) {
    return Array.isArray(project && project.env) ? project.env : [];
}

/**
 * Upserts `entries` into the project's set and returns the new array.
 *
 * Pure: stores nothing. The caller saves the project, so a refusal leaves the
 * record it was given untouched and a half-applied batch cannot reach disk.
 */
function setMany(project, entries) {
    const incoming = Array.isArray(entries) ? entries : [entries];
    const next = currentEnv(project).slice();

    for (const entry of incoming) {
        assertKey(entry && entry.key);
        const target = normaliseTarget(entry.target);
        const value = entry.value === undefined || entry.value === null ? '' : String(entry.value);
        if (value.length > MAX_VALUE_LENGTH) {
            throw refuse('env_value_too_long', `${entry.key} is longer than ${MAX_VALUE_LENGTH} characters`);
        }

        const record = {
            key: entry.key,
            valueEnc: machineStore.encrypt(value),
            target,
            updatedAt: Date.now()
        };
        const at = next.findIndex((e) => e.key === entry.key);
        if (at === -1) next.push(record); else next[at] = record;
    }

    if (next.length > MAX_KEYS) {
        throw refuse('env_too_many', `a project holds at most ${MAX_KEYS} variables`);
    }
    return next;
}

/** Drops one key. `removed` is false when it was not there, which is not an error. */
function remove(project, key) {
    const env = currentEnv(project);
    const next = env.filter((e) => e.key !== key);
    return { env: next, removed: next.length !== env.length };
}

/** What a browser may see: the names and where they apply, never the values. */
function list(project) {
    return currentEnv(project)
        .map((e) => ({ key: e.key, target: e.target || 'all', updatedAt: e.updatedAt || null }))
        .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The variables one build gets, decrypted, as a plain object.
 *
 * The five Aegis sets first so a project can override `CI`: Create React App
 * turns warnings into errors when it is set, and `CI=false` is the documented
 * way out of that. The `AEGIS_` ones cannot be overridden because `assertKey`
 * refuses the prefix on the way in.
 *
 * A value that will not decrypt is dropped rather than passed on. That happens
 * when the machine key file was replaced, and a build reading an empty string
 * where a token should be fails in a way nobody can diagnose; a missing
 * variable at least reads as missing.
 */
function forBuild(project, { target = 'production', sha = '', branch = '' } = {}) {
    const out = {
        CI: '1',
        AEGIS_DEPLOY: '1',
        AEGIS_ENV: target,
        AEGIS_GIT_COMMIT_SHA: sha || '',
        AEGIS_GIT_BRANCH: branch || ''
    };

    for (const entry of currentEnv(project)) {
        const scope = entry.target || 'all';
        if (scope !== 'all' && scope !== target) continue;
        const value = machineStore.decrypt(entry.valueEnc);
        if (value === null) {
            console.warn(`[Deploy] ${entry.key} could not be decrypted and was left out of the build`);
            continue;
        }
        out[entry.key] = value;
    }
    return out;
}

module.exports = { setMany, remove, list, forBuild, MAX_KEYS, MAX_VALUE_LENGTH, KEY_RE };
