'use strict';

/**
 * What a branch needs run, worked out from what is in it.
 *
 * The third and last answer to eight fields in a form, under `aegis.deploy.json`
 * and under whatever the operator typed. This one reads no declaration at all:
 * it looks at the root of the branch the way Vercel does, and every rule below
 * rests on a signal that says one thing only.
 *
 * A lockfile names its package manager: `pnpm-lock.yaml` is pnpm and cannot be
 * anything else. `package.json` names its own build script, so the build command
 * is read rather than inferred. Nothing here maps a framework to an output
 * directory, because that mapping is where a wrong answer serves the source of a
 * site instead of the site; the output is found after the build instead, in
 * `build/builder.js`, by looking for the directory the build just wrote.
 *
 * A start command is never detected. Outside `package.json` there is no
 * convention for it, and starting the wrong process on a server holding
 * directory audit data is worse than asking. A branch that wants one declares it
 * in `aegis.deploy.json`.
 */

/** Lockfile to package manager, most specific first. */
const LOCKFILES = [
    { file: 'pnpm-lock.yaml', install: 'pnpm install --frozen-lockfile', run: 'pnpm run build', name: 'pnpm' },
    { file: 'yarn.lock', install: 'yarn install --frozen-lockfile', run: 'yarn build', name: 'Yarn' },
    { file: 'bun.lockb', install: 'bun install --frozen-lockfile', run: 'bun run build', name: 'Bun' },
    { file: 'package-lock.json', install: 'npm ci', run: 'npm run build', name: 'npm' }
];

/** No lockfile, but a package.json: install without one rather than refuse. */
const NPM_NO_LOCK = { install: 'npm install', run: 'npm run build', name: 'npm' };

const PY_REQUIREMENTS = 'requirements.txt';

function has(names, file) {
    return names.some((n) => n === file);
}

/**
 * Reads the root of a branch and proposes an install and a build command.
 *
 * `names` is the list of entries at the root of the branch. `packageJson` is
 * that file already parsed, or null when there is none or it will not parse: a
 * `package.json` nobody can read is a repository that detection stays out of,
 * not a reason to refuse a deployment somebody may have configured by hand.
 *
 * Returns the two commands and a line for the console saying what was read and
 * why, because a command that appears without explanation is worse than a field
 * somebody filled in.
 */
function detect(names, packageJson) {
    const entries = Array.isArray(names) ? names.map(String) : [];
    const out = { installCmd: '', buildCmd: '', why: null };

    if (packageJson && typeof packageJson === 'object') {
        const found = LOCKFILES.find((l) => has(entries, l.file));
        const manager = found || NPM_NO_LOCK;
        out.installCmd = manager.install;

        const scripts = packageJson.scripts;
        const hasBuild = !!(scripts && typeof scripts === 'object'
            && typeof scripts.build === 'string' && scripts.build.trim());
        if (hasBuild) out.buildCmd = manager.run;

        out.why = found
            ? `${found.file} names ${manager.name}`
            : 'package.json with no lockfile, so npm without one';
        if (hasBuild) out.why += ', and package.json declares a build script';
        else out.why += ', and package.json declares no build script';
        return out;
    }

    if (has(entries, PY_REQUIREMENTS)) {
        // `--target .` for the same reason the KPI project uses it: the sandbox
        // account has no site-packages of its own to install into.
        out.installCmd = `pip install --no-cache-dir -r ${PY_REQUIREMENTS} --target .`;
        out.why = `${PY_REQUIREMENTS} at the root, so pip. No build step is implied, `
            + 'and a start command is never detected: declare one in aegis.deploy.json';
        return out;
    }

    return out;
}

/** Same precedence rule as the manifest: anything already set is left alone. */
function merge(typed, detected) {
    const out = Object.assign({}, typed);
    const from = [];
    for (const key of ['installCmd', 'buildCmd']) {
        const given = typeof typed[key] === 'string' ? typed[key].trim() : '';
        if (given || !detected[key]) continue;
        out[key] = detected[key];
        from.push(key);
    }
    return { values: out, from };
}

module.exports = { detect, merge, LOCKFILES, PY_REQUIREMENTS };
