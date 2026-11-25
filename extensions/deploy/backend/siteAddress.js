/**
 * The host name a deployed site's link is built on.
 *
 * The link follows the host the operator reached the dashboard on: from another
 * machine that is an address the visitors can open too. On the server itself it
 * is 127.0.0.1 or localhost, and a link on that host works for nobody else, so
 * a loopback host is replaced by this machine's network address.
 *
 * Which address: a private one first (RFC 1918), because a LAN install is
 * reached on that; then any other outside IPv4; and with none at all the host
 * as received, which is no worse than before. Link-local (169.254/16) is never
 * picked: it is what Windows assigns when DHCP failed, and nobody reaches a
 * site there.
 */

'use strict';

const os = require('os');

function isLoopback(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function isPrivate(address) {
    return /^10\./.test(address) ||
        /^192\.168\./.test(address) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

/** This machine's outside IPv4 addresses, private ones first. */
function outsideAddresses(interfaces) {
    const found = [];
    for (const list of Object.values(interfaces || {})) {
        for (const ni of list || []) {
            if (!ni || (ni.family !== 'IPv4' && ni.family !== 4) || ni.internal) continue;
            if (/^169\.254\./.test(ni.address) || /^127\./.test(ni.address)) continue;
            found.push(ni.address);
        }
    }
    return found.filter(isPrivate).concat(found.filter((a) => !isPrivate(a)));
}

function shareableHost(hostname, interfaces) {
    if (!isLoopback(hostname)) return hostname;
    let nics = interfaces;
    if (!nics) {
        try { nics = os.networkInterfaces(); } catch (_) { nics = {}; }
    }
    return outsideAddresses(nics)[0] || hostname;
}

module.exports = { shareableHost, isLoopback };
