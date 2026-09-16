'use strict';

/**
 * What a repository says about how it wants to be deployed: `aegis.deploy.json`.
 *
 * Third of its family, after `vercel.json` (how the files are served) and
 * `aegis.access.json` (who may reach which path), and it follows their rule: the
 * repository declares, Aegis honours, and a file that will not parse refuses
 * rather than being ignored. A project whose configuration was silently dropped
 * looks exactly like a project whose configuration was wrong.
 *
 * It exists because the alternative was eight fields typed by hand into a form,
 * for a repository that already knows what it is. The operator pastes a URL; the
 * branch answers the rest, once, in the repository, reviewed like any other file
 * and the same for everyone who deploys it.
 *
 * Nothing here is guessed. A start command has no reliable convention outside
 * `package.json`, and guessing one wrong starts the wrong process on a server
 * that runs domain audit data. What the repository does not declare stays empty
 * and the operator is asked, which is the old behaviour rather than a new trap.
 *
 * ```json
 * {
 *   "installCmd": "pip install --no-cache-dir -r packaging/api/requirements.txt --target .",
 *   "startCmd": "python packaging/api/kpi_api.py",
 *   "dbFile": "kpi.db",
 *   "migrationsDir": "migrations"
 * }
 * ```
 */

const FILE = 'aegis.deploy.json';

/** Long enough for a real pip or npm line, short enough not to be a payload. */
const MAX_CMD = 500;
const MAX_PATH = 200;

/** Everything a project record takes from the repository, and nothing else. */
const COMMAND_KEYS = ['installCmd', 'buildCmd', 'startCmd'];
const PATH_KEYS = ['rootDir', 'outputDir', 'dbFile', 'migrationsDir'];
const KNOWN = COMMAND_KEYS.concat(PATH_KEYS);

/**
 * A path a repository may name: inside the clone, and no traversal.
 *
 * Checked as text rather than resolved, because this runs before the clone
 * exists. `cloner.js` resolves and re-checks what it is handed, so this is the
 * early refusal that keeps a bad value out of the project record, not the last
 * line of defence.
 */
function badPath(value) {
    if (value.length > MAX_PATH) return 'too long';
    if (value.startsWith('/') || value.startsWith('\\')) return 'must be relative';
    if (/^[A-Za-z]:/.test(value)) return 'must be relative';
    if (value.split(/[\\/]/).some((part) => part === '..')) return 'must not leave the repository';
    return null;
}

/**
 * The manifest as the create route will use it, or the reason it was refused.
 *
 * `null` text means no file, which is a repository with nothing to declare
 * rather than a fault: every project that worked before this existed still
 * works, and that is the point.
 */
function parse(text) {
    if (text === null || text === undefined) {
        return { ok: true, present: false, config: {}, unsupported: [], error: null };
    }

    let raw;
    try {
        raw = JSON.parse(String(text));
    } catch (e) {
        return { ok: false, present: true, config: {}, unsupported: [], error: 'not valid JSON' };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, present: true, config: {}, unsupported: [], error: 'must be a JSON object' };
    }

    const config = {};
    for (const key of KNOWN) {
        if (!(key in raw) || raw[key] === null) continue;
        if (typeof raw[key] !== 'string') {
            return {
                ok: false, present: true, config: {}, unsupported: [],
                error: `${key} must be a string`
            };
        }
        const value = raw[key].trim();
        if (!value) continue;                    // declared empty is declared nothing
        if (COMMAND_KEYS.includes(key) && value.length > MAX_CMD) {
            return {
                ok: false, present: true, config: {}, unsupported: [],
                error: `${key} is longer than ${MAX_CMD} characters`
            };
        }
        if (PATH_KEYS.includes(key)) {
            const why = badPath(value);
            if (why) {
                return {
                    ok: false, present: true, config: {}, unsupported: [],
                    error: `${key} ${why}`
                };
            }
        }
        config[key] = value;
    }

    // Named rather than dropped, the same way vercel.json reports the keys this
    // server does not run. A key nobody reads is a instruction the author thinks
    // was followed.
    const unsupported = Object.keys(raw).filter((k) => !KNOWN.includes(k));

    return { ok: true, present: true, config, unsupported, error: null };
}

/**
 * The values to create the project with: what the operator typed wins, and the
 * manifest answers only what they left empty.
 *
 * That order and not the other one. An operator who filled a field is looking at
 * it, and a file overruling them from inside the repository would be a setting
 * that cannot be seen from the screen it contradicts. The manifest is there to
 * make the empty form work, not to take the form away.
 *
 * Returns the merged values and the list of keys the manifest supplied, so the
 * deployment can say where they came from.
 */
function merge(typed, config) {
    const out = Object.assign({}, typed);
    const from = [];
    for (const key of KNOWN) {
        const given = typeof typed[key] === 'string' ? typed[key].trim() : '';
        if (given) continue;
        if (!config[key]) continue;
        out[key] = config[key];
        from.push(key);
    }
    return { values: out, from };
}

module.exports = { FILE, parse, merge, KNOWN, COMMAND_KEYS, PATH_KEYS, MAX_CMD, MAX_PATH };
