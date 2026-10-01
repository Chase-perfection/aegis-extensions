/**
 * Finds core's browser-test harness, or says in one line why it cannot.
 *
 * `account-tiering.test.js` renders `pages/account-tiering.html` inside the
 * Aegis shell. The nav, the layout CSS, `app.js` and `translations.js` are
 * core's; only the page, `src/css/account-tiering.css` and the
 * `src/js/account-tiering*.js` modules belong to this extension. The test
 * covers the pair, so it needs both trees on disk.
 *
 * `AEGIS_TREE` names a checkout of the Aegis repository. Set, this resolves
 * `frontend/tests/helpers/serveFrontend.js` and `browser.js` out of that
 * checkout and hands them through. Unset, the caller skips with the reason and
 * the fix, rather than failing over a variable a fresh clone has no way to
 * guess.
 *
 * This file is a copy of `extensions/network-inventory/frontend/tests/harness.js`
 * with the id and the page changed. The two are kept apart on purpose: each one names
 * the overlay its own suite needs, and a shared copy would have to take the id
 * as an argument to say anything useful in the message a developer reads.
 *
 * The suite therefore never runs in this repository's CI, which has no checkout
 * to point at and no token to clone a private repository with. PUBLISHING.md
 * says to run it locally with `AEGIS_TREE` set before tagging a release.
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

const ID = 'account-tiering';
const TREE = process.env.AEGIS_TREE ? path.resolve(process.env.AEGIS_TREE) : null;

function helper(tree, name) {
    return path.join(tree, 'frontend', 'tests', 'helpers', name);
}

/**
 * Where core's harness looks for an extension frontend.
 *
 * Resolved the way `serveFrontend.dataRoot()` resolves it, which is itself a
 * copy of `extensionLoader.dataRoot()`. Deploy's harness carries the same copy
 * and says the rule belongs somewhere core can hand over. This is the fourth
 * copy it warned about, so treat the warning as owed work rather than as
 * settled.
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
            why: 'set AEGIS_TREE to an Aegis checkout to run this file: it renders '
                + "account-tiering.html inside core's shell, so it needs core's frontend on disk"
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
    // `extensions/*/frontend`. Core's own `frontend/pages/` never held
    // account-tiering.html, so without the overlay the server has every page
    // but this one and the suite fails on a 404 rather than on what it set out
    // to check. Checked here so that reads as a precondition instead of as a
    // bug.
    const overlay = path.join(dataExtensions(), ID, 'frontend');
    if (!fs.existsSync(overlay)) {
        return {
            available: false,
            why: `core's harness serves extensions from ${dataExtensions()}, so junction this `
                + `repository's copy into it: mklink /J "${path.join(dataExtensions(), ID)}" `
                + `"<repo>\\extensions\\${ID}"`
        };
    }

    // Named rather than spread, so adding a fourth import from the harness is a
    // visible line here and not a silent widening of what core owes this test.
    const { serveFrontend } = require(helper(TREE, 'serveFrontend'));
    const { launchBrowser, openPage, DEFAULT_API_BODY } = require(helper(TREE, 'browser'));
    return { available: true, why: null, serveFrontend, launchBrowser, openPage, DEFAULT_API_BODY };
}

module.exports = resolve();
