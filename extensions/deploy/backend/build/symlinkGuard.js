'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Refuses a directory containing a symlink or Windows junction anywhere in
 * its tree. A git repository can contain a committed symlink, and a
 * malicious build's own output can contain one too (junction creation needs
 * no elevated privilege on Windows) -- either way, if it survives into what
 * gets served, `siteServer.js` follows it (fs.statSync/createReadStream both
 * dereference by default), letting an unauthenticated visitor read whatever
 * the link points at with the backend process's own (SYSTEM) access. Static
 * site content has no legitimate reason to contain one, so refuse outright
 * rather than trying to validate where it points.
 */
function assertNoSymlinks(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
            throw Object.assign(new Error(`contains a symlink or junction at ${full} -- refused`), { code: 'unsafe_symlink' });
        }
        if (entry.isDirectory()) assertNoSymlinks(full);
    }
}

module.exports = { assertNoSymlinks };
