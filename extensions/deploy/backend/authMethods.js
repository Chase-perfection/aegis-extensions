/**
 * How a deployed site decides who is knocking.
 *
 * Before this file the question had one answer and it was a boolean:
 * `project.auth.enabled` meant "ask the tenant's directory", and its absence
 * meant "serve to anyone". That reads well until a second method exists, at
 * which point a boolean has no room to say which one, and every caller has to
 * guess. This module is the room.
 *
 * A closed vocabulary, on purpose. The value travels from a browser, through a
 * route, into a file on disk, and is read back by the guard on every request to
 * a protected site. An open string there would mean the guard one day reads a
 * method it has no handler for, and the only safe thing it could do with it is
 * exactly what it does now: refuse.
 *
 * Two properties this file exists to hold:
 *
 * An unknown method is gated, never public. `methodOf` returns what the record
 * actually says, known or not, and `isGated` treats anything that is not `none`
 * as needing a login. So a record written by a newer Aegis, or edited by hand,
 * turns into a refusal the operator can see rather than into a site quietly
 * served to everyone. The one direction this must never fail in is open.
 *
 * A record from before this file reads correctly. Those carry `enabled` and no
 * `method`, and `enabled: true` meant the directory, so it reads as `ldap`.
 * Nothing has to migrate the file on disk: the first save through the route
 * rewrites it in the new shape, and until then it is read in the old one.
 *
 * `enabled` is still written, as a mirror of the method rather than as the
 * truth. Every reader that predates this file -- the project cards, the poller,
 * the preview branches -- asks that field whether a site shows a lock, and a
 * mirror keeps them right without a sweep through code that has nothing to do
 * with authentication.
 */

'use strict';

/** No gate. The site answers to anyone who can reach its port. */
const NONE = 'none';

/** The tenant's directory, configured once in the Authentication pane. */
const LDAP = 'ldap';

/** Every method this build can actually serve, in the order the page offers them. */
const METHODS = [NONE, LDAP];

/** Is this a method this build knows how to run? */
function isKnown(value) {
    return METHODS.indexOf(String(value)) >= 0;
}

/**
 * The method a project record asks for.
 *
 * Returns the stored string even when this build does not know it. The caller
 * that has to act on it checks `isKnown` and refuses; a caller that silently
 * normalised an unknown method to `none` here would be turning a record it did
 * not understand into a published site.
 */
function methodOf(auth) {
    if (!auth || typeof auth !== 'object') return NONE;
    const stored = auth.method;
    if (stored !== undefined && stored !== null && String(stored) !== '') {
        return String(stored);
    }
    // Predates the selector: the boolean is all there is.
    return auth.enabled === true ? LDAP : NONE;
}

/** Does this record need a login before the files are served? */
function isGated(auth) {
    return methodOf(auth) !== NONE;
}

/**
 * The record to store for a method and its allow list.
 *
 * `enabled` is derived here and nowhere else, so the mirror cannot drift from
 * the method it mirrors.
 */
function record(method, allowedGroups) {
    const m = String(method);
    return {
        method: m,
        enabled: m !== NONE,
        allowedGroups: Array.isArray(allowedGroups) ? allowedGroups : []
    };
}

module.exports = { NONE, LDAP, METHODS, isKnown, methodOf, isGated, record };
