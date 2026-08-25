/**
 * Finds core's browser-test harness, or says in one line why it cannot.
 *
 * The four suites beside this file render `pages/deploy.html` inside the Aegis
 * shell. The nav, the layout CSS, `app.js` and `translations.js` are core's;
 * only the page and `src/js/deploy.js` are the extension's. They test the pair,
 * not the extension alone, so they need both trees on disk.
 *
 * That is why the harness is not copied here. Six files maintained for core's
 * fourteen other pages would drift within a month, and a copy would still be
 * short of core's frontend, which is the half this repository does not have.
 *
 * `AEGIS_TREE` names a checkout of the Aegis repository. Set, this resolves
 * `frontend/tests/helpers/serveFrontend.js` and `browser.js` out of that
 * checkout and hands them through. Unset, every caller skips with the reason and
 * the fix. Not a silent skip and not a failure: a developer with no checkout
 * should read what to set, and a developer with one should not find four red
 * files because of a variable.
 *
 * These suites therefore never run in this repository's CI, which has no
 * checkout to point at and no token to clone a private repository with. That is
 * recorded as an open question in README.md under "Tests".
 *
 * One thing this file is not: a licence to reach into the Aegis tree from
 * anywhere else. `CONTRACT.md` says an extension imports its own files and
 * Node's standard library, and that rule is about code that ships. This is a
 * test harness locator, in a folder the release workflow keeps out of the
 * package, resolving through an environment variable rather than a relative
 * path that would claim the two trees sit in a fixed shape.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TREE = process.env.AEGIS_TREE ? path.resolve(process.env.AEGIS_TREE) : null;

function helper(tree, name) {
    return path.join(tree, 'frontend', 'tests', 'helpers', name);
}

/**
 * Where core's harness looks for an extension frontend.
 *
 * Resolved the way `serveFrontend.dataRoot()` resolves it, which is itself a copy
 * of `extensionLoader.dataRoot()`. That makes three copies across two
 * repositories, and they only work while they agree. A fourth would be one too
 * many: if this ever needs changing again, the rule belongs somewhere core can
 * hand over rather than somewhere each caller repeats.
 */
function dataExtensions() {
    const root = process.env.AEGIS_DATA_ROOT
        ? path.resolve(process.env.AEGIS_DATA_ROOT)
        : (process.platform === 'win32' ? 'C:\\ProgramData\\Aegis' : path.join(TREE || '', 'backend', 'data'));
    return path.join(root, 'extensions');
}

function resolve() {
    if (!TREE) {
        return {
            available: false,
            why: 'set AEGIS_TREE to an Aegis checkout to run this file: it renders deploy.html '
                + "inside core's shell, so it needs core's frontend on disk"
        };
    }

    if (!fs.existsSync(helper(TREE, 'serveFrontend.js'))) {
        return {
            available: false,
            why: `AEGIS_TREE=${TREE} carries no frontend/tests/helpers/serveFrontend.js, `
                + 'so it is not an Aegis checkout'
        };
    }

    // `serveFrontend` overlays core's frontend with the data root's
    // `extensions/*/frontend`. Not `<tree>/extensions`, which is where this
    // extension used to live and no longer does. Without the overlay the server
    // holds core's pages and not `deploy.html`, so every test in the file would
    // fail on a 404 rather than on what it set out to check. Checked here so that
    // reads as a precondition instead of as a bug.
    const overlay = path.join(dataExtensions(), 'deploy', 'frontend');
    if (!fs.existsSync(overlay)) {
        return {
            available: false,
            why: `core's harness serves extensions from ${dataExtensions()}, so junction this `
                + `repository's copy into it: mklink /J "${path.join(dataExtensions(), 'deploy')}" `
                + '"<repo>\\extensions\\deploy"'
        };
    }

    // Named rather than spread, so adding a fourth import from the harness is a
    // visible line here and not a silent widening of what core owes these tests.
    const { serveFrontend } = require(helper(TREE, 'serveFrontend'));
    const { launchBrowser, openPage } = require(helper(TREE, 'browser'));
    return { available: true, why: null, serveFrontend, launchBrowser, openPage };
}

module.exports = resolve();
