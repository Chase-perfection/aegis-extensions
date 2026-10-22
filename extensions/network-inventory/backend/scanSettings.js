/**
 * The scan's options, one small file per tenant beside its inventory:
 * `<tenantPaths.data>/network-inventory-settings.json`.
 *
 * Tenant data is the right place here because nothing in it is secret, unlike
 * the scan account's password, which scanAccount.js keeps outside the tree.
 *
 * One option today, `tcpProbe`: TCP connect probes after the ping sweep. Off by
 * default and off whenever the file is missing, unreadable or holds anything
 * but `true`, since it is active scanning an IDS may flag, and an operator has
 * to have chosen it.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FILE = 'network-inventory-settings.json';

function fileFor(dataDir) { return path.join(dataDir, FILE); }

/** `{ tcpProbe, updatedAt, updatedBy }`, the defaults when nothing usable is stored. */
function read(dataDir) {
    try {
        const parsed = JSON.parse(fs.readFileSync(fileFor(dataDir), 'utf8'));
        if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
        return {
            tcpProbe: parsed.tcpProbe === true,
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
            updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : null
        };
    } catch (_) {
        return { tcpProbe: false, updatedAt: null, updatedBy: null };
    }
}

/** tmp + rename, as scanAccount.js does: a crash mid-write keeps the previous file. */
function write(dataDir, { tcpProbe }, updatedBy) {
    if (typeof tcpProbe !== 'boolean') throw new TypeError('tcpProbe must be a boolean');
    const value = { tcpProbe, updatedAt: new Date().toISOString(), updatedBy: updatedBy || null };
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = fileFor(dataDir) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, fileFor(dataDir));
    return read(dataDir);
}

module.exports = { read, write, FILE };
