/**
 * What an operator tells the scan about DHCP, one file per tenant.
 *
 * Today that is one list: DHCP servers to read in addition to those the
 * directory authorizes. The directory was the scan's only list, so a server it
 * does not name could not be read at all: a standalone server, or one whose
 * authorization was never recorded. The scan can only say such a server exists
 * once somebody has named it.
 *
 * Where it lives. `<tenantPaths.data>/network-inventory-settings.json`, beside
 * `inventory_history.json`. These are host names, not secrets, so they belong
 * with the tenant's data and travel with its backup. The scan account's
 * password is the opposite case and is kept elsewhere: see scanAccount.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FILE = 'network-inventory-settings.json';

/**
 * What a DNS or NetBIOS host name can carry, and nothing a command line reads
 * as syntax. scan/Start-NetOnly.ps1 and scan/netscan/DhcpView.ps1 hold the same
 * expression: the name ends up as a PowerShell argument on both paths.
 */
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

/** As many as the launcher's own check lets through. */
const MAX_SERVERS = 32;

function settingsFile(dataDir) {
    return path.join(dataDir, FILE);
}

/** Short lowercase host name: how the scan tells two spellings of one server apart. */
function serverKey(name) {
    return String(name).trim().split('.')[0].toLowerCase();
}

/**
 * Sorts an operator's list into names the scan can take and entries it cannot.
 *
 * @param {*} input an array of strings, or one string separated by commas,
 *   semicolons or line breaks
 * @returns {{names: string[], rejected: string[]}} each server once, in the
 *   order given
 */
function normalizeServers(input) {
    const parts = Array.isArray(input)
        ? input
        : (typeof input === 'string' ? input.split(/[,;\r\n]+/) : []);
    const names = [];
    const rejected = [];
    const seen = new Set();
    for (const raw of parts) {
        if (typeof raw !== 'string') continue;
        const name = raw.trim();
        if (!name) continue;
        if (!SERVER_NAME.test(name)) { rejected.push(name); continue; }
        const key = serverKey(name);
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(name);
    }
    return { names, rejected };
}

/**
 * The tenant's settings. A missing or unreadable file reads as no setting: the
 * scan then behaves as it did before this file existed, which is the right
 * answer to a file somebody damaged.
 *
 * @param {string} dataDir the tenant's data folder, from `req.tenantPaths.data`
 * @returns {{dhcpServers: string[]}}
 */
function read(dataDir) {
    try {
        const parsed = JSON.parse(fs.readFileSync(settingsFile(dataDir), 'utf8'));
        // Re-validated on the way out as well as on the way in: this list is
        // handed to a command line, and the file can be edited by hand.
        return { dhcpServers: normalizeServers(parsed && parsed.dhcpServers).names.slice(0, MAX_SERVERS) };
    } catch (_) {
        return { dhcpServers: [] };
    }
}

/**
 * Replaces the declared server list.
 *
 * Written to a temporary file and renamed, so a crash mid-write leaves the old
 * list rather than half a file.
 *
 * @param {string} dataDir
 * @param {string[]} names already normalized
 * @returns {{dhcpServers: string[]}}
 */
function saveServers(dataDir, names) {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const current = read(dataDir);
    const next = { ...current, dhcpServers: names.slice(0, MAX_SERVERS) };
    const file = settingsFile(dataDir);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return next;
}

module.exports = { read, saveServers, normalizeServers, serverKey, SERVER_NAME, MAX_SERVERS };
