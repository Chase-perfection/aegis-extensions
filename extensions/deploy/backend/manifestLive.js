'use strict';

/**
 * What a manifest found in a clone may change under a project that exists.
 *
 * The create route reads `aegis.deploy.json` through the GitHub API, because
 * the runtime and the port are settled before any clone exists. Every later
 * deployment used to ignore the file, so correcting a branch corrected nothing
 * and the operator was left deleting the project. This is the other half.
 *
 * Two sets of keys, and the split is the whole point. BUILD keys describe how
 * the next deployment is built and served, so a new value costs nothing to
 * honour. RUNTIME keys describe a project that is running: `startCmd` decides
 * whether there is a process at all, and `dbFile` names the database its data
 * lives in. A file in a branch must not move either under an operator who is
 * not looking, so they are reported and the console says where to act.
 */

const fs = require('fs');
const path = require('path');
const deployManifest = require('./deployManifest');

const BUILD_KEYS = ['installCmd', 'buildCmd', 'outputDir', 'rootDir'];
const RUNTIME_KEYS = ['startCmd', 'dbFile', 'migrationsDir'];

/** `null` and `''` are the same absence on a project record. */
function same(a, b) {
    return String(a || '') === String(b || '');
}

/**
 * Returns `{ changed, applied, reported, say }`.
 *
 * `changed` is the patch to write onto the record, and is empty when the branch
 * agrees with it. `say` is one line for the build console, or null when there
 * is nothing to say: a deployment that prints a sentence about configuration
 * every twenty seconds trains the operator to stop reading it.
 */
function apply(project, config) {
    const changed = {};
    const applied = [];
    const reported = [];

    for (const key of BUILD_KEYS) {
        if (!config[key] || same(project[key], config[key])) continue;
        changed[key] = config[key];
        applied.push(key);
    }
    for (const key of RUNTIME_KEYS) {
        if (!config[key] || same(project[key], config[key])) continue;
        reported.push(key);
    }

    let say = null;
    if (applied.length || reported.length) {
        const parts = [];
        if (applied.length) parts.push(`took ${applied.join(', ')} from the branch`);
        if (reported.length) {
            parts.push(`${reported.join(', ')} differ from this project and were not `
                + 'changed here: set them on the project Settings tab');
        }
        say = `aegis.deploy.json: ${parts.join('. ')}.`;
    }

    return { changed, applied, reported, say };
}

/**
 * The manifest as the clone holds it. Reading from the clone and not from the
 * API the create route uses: the files are already on disk, and a read that
 * cannot disagree with what is about to be built is worth more than one that
 * costs nothing.
 */
function read(dir) {
    let text = null;
    try {
        text = fs.readFileSync(path.join(dir, deployManifest.FILE), 'utf8');
    } catch {
        return { ok: true, config: {}, error: null };
    }
    const parsed = deployManifest.parse(text);
    return { ok: parsed.ok, config: parsed.config, error: parsed.error };
}

module.exports = { apply, read, BUILD_KEYS, RUNTIME_KEYS };
