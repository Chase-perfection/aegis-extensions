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

/**
 * Who a gated site opens to, said out loud instead of inferred.
 *
 * Before this, an empty `allowedGroups` meant "anyone the directory
 * authenticates". That reading was documented and deliberate, but it is
 * inferred from the absence of something, and the moment a second list exists
 * -- named people -- the inference breaks: an operator who lists one person to
 * make them the site's administrator has not thereby said that nobody else may
 * enter, and an operator who lists nobody has not said that everybody may.
 *
 * So the two questions are separated. This field answers "who gets in"; the
 * `admin` flag on a named person answers "who runs the place once in". A site
 * can be open to the whole directory and still have exactly one administrator,
 * which is the shape an application that manages its own roles actually wants.
 *
 * Nothing migrates. A record written before this field is read by
 * `audienceOf`, which derives the old meaning from the old fields: groups
 * listed means listed, no groups means the directory. Every existing project
 * therefore keeps the access it has until somebody changes it on purpose.
 */
const DIRECTORY = 'directory';
const LISTED = 'listed';
const AUDIENCES = [DIRECTORY, LISTED];

/**
 * The audience a record asks for, derived when the field predates this build.
 *
 * The derivation is the old rule exactly: a record that named groups meant
 * those groups, a record that named none meant the directory at large.
 */
function audienceOf(auth) {
    if (!auth || typeof auth !== 'object') return DIRECTORY;
    const stored = auth.audience;
    if (AUDIENCES.indexOf(String(stored)) >= 0) return String(stored);
    const groups = Array.isArray(auth.allowedGroups) ? auth.allowedGroups : [];
    return groups.length ? LISTED : DIRECTORY;
}

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
 * The people named on a record, never the raw field.
 *
 * Shape: `{ sid, login, name, admin }`. The SID is the only one of the four
 * that decides anything -- it is what a login is matched against -- and the
 * other three exist so the operator recognises the row they picked. An entry
 * without a SID is dropped here rather than at the guard: it can never match,
 * so keeping it would show an access in the panel that does not exist.
 */
function usersOf(auth) {
    const list = auth && Array.isArray(auth.allowedUsers) ? auth.allowedUsers : [];
    const out = [];
    for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const sid = String(raw.sid || '').trim();
        if (!sid) continue;
        out.push({
            sid,
            login: String(raw.login || ''),
            name: String(raw.name || ''),
            admin: raw.admin === true
        });
    }
    return out;
}

/**
 * The record to store for a method and its allow lists.
 *
 * `enabled` is derived here and nowhere else, so the mirror cannot drift from
 * the method it mirrors.
 *
 * Two allow lists rather than one, because they answer different questions and
 * an operator uses one or the other: a group is a standing rule the directory
 * already maintains, a person is a decision taken here. Either one being
 * satisfied opens the site; `admin` is carried only by a named person, because
 * "whoever is in this group administers the site" is a promotion nobody
 * reviews.
 */
function record(method, allowedGroups, opts) {
    const m = String(method);
    const o = opts && typeof opts === 'object' ? opts : {};
    const groups = Array.isArray(allowedGroups) ? allowedGroups : [];
    const users = usersOf({ allowedUsers: o.allowedUsers });
    // Read through `audienceOf` rather than taken raw, so an absent or unknown
    // value lands on the same derivation every legacy record gets instead of on
    // a third behaviour nobody wrote down.
    const audience = audienceOf({
        audience: o.audience,
        allowedGroups: groups
    });
    return {
        method: m,
        enabled: m !== NONE,
        audience,
        allowedGroups: groups,
        allowedUsers: users
    };
}

module.exports = {
    NONE, LDAP, METHODS, isKnown, methodOf, isGated, record, usersOf,
    DIRECTORY, LISTED, AUDIENCES, audienceOf
};
