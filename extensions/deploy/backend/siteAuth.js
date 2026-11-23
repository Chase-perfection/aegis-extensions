/**
 * The access guard in front of a deployed site.
 *
 * `siteServer.js` serves a project's files on its own port, to anyone on the
 * network, which is the point of deploying it. Some sites should not be. This
 * file is the optional gate: a project whose record carries `auth.enabled`
 * gets a login page backed by the tenant's directory, everything else is served
 * exactly as before.
 *
 * This is not the Aegis login. `authDb` and `tenantSession` belong to the
 * dashboard on another port and are not consulted here; a person who can read a
 * deployed site is not thereby an Aegis user, and the reverse is also true.
 *
 * Four properties this file exists to hold, all of them easy to lose:
 *
 * Fail closed. A project marked protected whose tenant has no directory
 * configured is refused with 503, never served. The tempting fallback, "no
 * directory means no check", turns a misconfiguration into a silent publication
 * of the very site someone asked to protect.
 *
 * The whole `/__aegis/` prefix is reserved before any file is resolved, on
 * protected and unprotected sites alike. If a repository happened to contain
 * `__aegis/login.html`, serving it would let the site paint its own login form
 * on the path the browser trusts.
 *
 * The password reaches `ldap.verify` and nothing else. Not a log line, not an
 * error message, not a re-rendered form field. The login page is re-rendered
 * with the username and never the password.
 *
 * Sessions live in memory only. A backend restart logs everyone out, which is
 * accepted: the alternative is a session table on disk, and a stolen session
 * file would outlive every other control here. Purge is lazy, on access.
 *
 * Known limits an operator has to be told about, stated plainly rather than
 * papered over:
 *
 * - A protected site is served over TLS only. `gate` answers 503 `site_not_tls`
 *   on a clear socket before any form or cookie, so a password and a session
 *   token never cross the network in clear. The cookie is `Secure`, and the
 *   flag is read from the socket rather than from configuration. A project that
 *   was protected before this rule and has no TLS is not migrated: it fails
 *   closed until the operator turns TLS on. `project.tls` in `siteServer.js` is
 *   how a site gets there.
 * - `Strict-Transport-Security` goes out only on a secure request routed by the
 *   project's own host name (`ctx.viaRouterHostName`), never on `host:port`:
 *   HSTS ignores the port, so on a shared host name it would reach every other
 *   site on the machine.
 * - Cookies are scoped by host, not by port. Two protected sites on the same
 *   machine share the `aegis_site` cookie name, so logging into the second one
 *   replaces the session of the first. The session record stores the slug and
 *   project id and is rejected when they do not match, so this is a nuisance
 *   (re-login) and not a way into another site.
 * - The client address comes from the socket. No `X-Forwarded-For` is trusted,
 *   because nothing forwards to this port; behind a reverse proxy every lockout
 *   counter would collapse onto the proxy's address.
 * - A session ends eight hours after login whatever happens, and sooner after
 *   thirty minutes with no request (`IDLE_MS`). A tenant administrator can
 *   close them by hand from the dashboard (`dropSessionsFor`).
 * - Group membership is re-checked on a timer for reads, so a user removed from
 *   the allowed group keeps READ access for up to `revalidateMinutes`. A write
 *   (any method but GET, HEAD, OPTIONS) waits for the directory's answer first
 *   and is refused when there is none. See `maybeRevalidate` and `recheckWrite`
 *   for both, and for the one configuration shape neither can run under.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectStore = require('./projectStore');
const authStore = require('./authStore');
const authMethods = require('./authMethods');
const accessPolicy = require('./accessPolicy');
const siteIcon = require('./siteIcon');
const siteNotices = require('./siteNotices');

/** Everything under here belongs to the guard and never to the site. */
const PREFIX = '/__aegis/';
const LOGIN_PATH = '/__aegis/login';
const LOGOUT_PATH = '/__aegis/logout';
const CSS_PATH = '/__aegis/login.css';
const MARK_PATH = '/__aegis/aegis-mark.svg';
const ICON_PATH = '/__aegis/site-icon';
const WHOAMI_PATH = '/__aegis/whoami';

/**
 * The page's own files, by fixed path. A table and not a folder lookup: the URL
 * never chooses a file name, so there is nothing to traverse.
 */
const ASSETS = {
    [CSS_PATH]: { file: 'login.css', type: 'text/css; charset=utf-8' },
    [MARK_PATH]: { file: 'aegis-mark.svg', type: 'image/svg+xml' },
    '/__aegis/nevera.otf': { file: 'Nevera-Regular.otf', type: 'font/otf' },
    // The script the proxy adds to a site's pages. Public on purpose: it holds
    // no text of its own and asks `/__aegis/notices` what to say.
    [siteNotices.SCRIPT_PATH]: { file: 'notices.js', type: 'text/javascript; charset=utf-8' }
};

/*
 * Which version of a site served by a process this visitor is on, and the door
 * to the newest one. Answered by siteServer.js, which knows the processes; the
 * guard only lets them through, and only to a visitor it would let into the
 * site itself. See `isReleasePath`.
 */
const RELEASE_PATH = '/__aegis/release';
const RELEASE_SWITCH_PATH = '/__aegis/release/switch';

function isReleasePath(pathOnly) {
    return pathOnly === RELEASE_PATH || pathOnly === RELEASE_SWITCH_PATH;
}

/**
 * The routes siteServer.js answers under the reserved prefix: the release
 * routes, and what the notices script asks for. Same rule for all of them.
 */
function isSitePath(pathOnly) {
    return isReleasePath(pathOnly) || pathOnly === siteNotices.DATA_PATH;
}

const SESSION_COOKIE = 'aegis_site';
const CSRF_COOKIE = 'aegis_site_csrf';
const SESSION_MS = 8 * 60 * 60 * 1000;
/** Thirty minutes without a request closes a session, inside the 8 h cap. An
 *  unattended browser on a shared desk should not stay signed in all day. */
const IDLE_MS = 30 * 60 * 1000;
/** The methods that read. Every other one is a write and re-checks the
 *  directory before it reaches the application. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A login form is a few hundred bytes. Anything larger is not a login form. */
const BODY_LIMIT = 8 * 1024;

/** Five tries, then a minute of silence. Slow enough to make guessing useless,
 *  short enough that a colleague who fat-fingered their password waits once. */
const LOCK_THRESHOLD = 5;
const LOCK_MS = 60 * 1000;

/** After a revalidation that could not reach a verdict, wait this long rather
 *  than the full interval: a DC that is down comes back, and the session should
 *  be re-checked soon after it does, not an interval later. */
const REVALIDATE_RETRY_MS = 60 * 1000;

/** How long a project record or a directory config is trusted from cache.
 *  Short, because `invalidate()` covers the writes we know about and this
 *  covers the ones we do not (a hand-edited projects.json, another worker). */
const CACHE_MS = 5000;

const PAGE_DIR = path.resolve(__dirname, '../frontend/site-auth');

/* ------------------------------------------------------------------ */
/* the directory client, injectable                                    */
/* ------------------------------------------------------------------ */

/**
 * `ldap.js` is required lazily and can be replaced.
 *
 * Lazily so that loading this module does not drag a socket-opening client into
 * every process that merely serves an unprotected site. Replaceably so that the
 * tests can drive the gate without a domain controller, which is the only way
 * the lockout and refusal paths get covered at all.
 */
let verifier = null;
let looker = null;

function _setVerifier(fn) { verifier = fn; }
function _setLookup(fn) { looker = fn; }

function verify(config, username, password) {
    if (verifier) return Promise.resolve(verifier(config, username, password));
    return require('./ldap').verify(config, username, password);
}

/** The same directory, asked about a user without a password. Never a login. */
function lookup(config, username) {
    if (looker) return Promise.resolve(looker(config, username));
    return require('./ldap').lookup(config, username);
}

/* ------------------------------------------------------------------ */
/* caches                                                              */
/* ------------------------------------------------------------------ */

/** `slug/projectId` -> { at, auth }. `auth` is the project's auth record. */
const projectCache = new Map();
/** `slug/projectId` -> { at, policy }. `policy` is the deployed access manifest. */
const policyCache = new Map();
/** `slug` -> { at, config }. `config` is null when the tenant has none. */
const configCache = new Map();

/**
 * The access manifest of the commit a project is currently serving.
 *
 * Read out of `current/`, so a rollback restores the rules of the commit it
 * restores and there is no second store to keep in step. Cached like the auth
 * record and for the same span: a file read per request on a busy site buys
 * nothing, and `CACHE_MS` is short enough that a deployment takes effect
 * without anybody clearing anything.
 *
 * A manifest that will not parse never reaches here. `cloner` reads it at
 * deployment and refuses the deployment, so what is on disk under `current/`
 * has already been accepted once.
 */
function policyFor(slug, tenantPaths, projectId) {
    const k = `${slug}/${projectId}`;
    const hit = policyCache.get(k);
    if (hit && (Date.now() - hit.at) < CACHE_MS) return hit.policy;

    let policy = { ok: true, rules: [], resources: [], error: null };
    try {
        policy = accessPolicy.read(projectStore.currentDir(tenantPaths, projectId));
    } catch (_) {
        // A folder that cannot be read is a site with no rules rather than a
        // crash. The gate above it has already decided who may be here at all.
        policy = { ok: true, rules: [], resources: [], error: null };
    }
    policyCache.set(k, { at: Date.now(), policy });
    return policy;
}

function authRecordFor(slug, tenantPaths, projectId) {
    const k = `${slug}/${projectId}`;
    const hit = projectCache.get(k);
    if (hit && (Date.now() - hit.at) < CACHE_MS) return hit.auth;

    let auth = null;
    try {
        const project = projectStore.getProject(tenantPaths, projectId);
        auth = (project && project.auth && typeof project.auth === 'object') ? project.auth : null;
    } catch (_) {
        auth = null;
    }
    projectCache.set(k, { at: Date.now(), auth });
    return auth;
}

function configFor(slug, tenantPaths) {
    const hit = configCache.get(slug);
    if (hit && (Date.now() - hit.at) < CACHE_MS) return hit.config;

    let config = null;
    try {
        config = authStore.readConfig(tenantPaths);
    } catch (_) {
        config = null;   // unreadable is unconfigured is refused
    }
    configCache.set(slug, { at: Date.now(), config });
    return config;
}

/** Forgets one project, or a whole tenant when `projectId` is null. */
function invalidate(slug, projectId) {
    configCache.delete(slug);
    if (projectId) {
        projectCache.delete(`${slug}/${projectId}`);
        // The manifest travels with the commit, so a deployment or a rollback
        // changes it under a cache that has no other reason to notice.
        policyCache.delete(`${slug}/${projectId}`);
        return;
    }
    for (const k of Array.from(projectCache.keys())) {
        if (k.startsWith(`${slug}/`)) projectCache.delete(k);
    }
    for (const k of Array.from(policyCache.keys())) {
        if (k.startsWith(`${slug}/`)) policyCache.delete(k);
    }
}

/** Does this project need a login? Absent record means no, as before. */
function isProtected(slug, tenantPaths, projectId) {
    return authMethods.isGated(authRecordFor(slug, tenantPaths, projectId));
}

/**
 * Which method this project asks for, as the record spells it.
 *
 * Not normalised to something this build can serve: `gate` has to be able to
 * tell "no gate" from "a gate I cannot run", because the first serves the site
 * and the second must refuse it.
 */
function methodFor(slug, tenantPaths, projectId) {
    return authMethods.methodOf(authRecordFor(slug, tenantPaths, projectId));
}

function allowedGroupsFor(slug, tenantPaths, projectId) {
    const auth = authRecordFor(slug, tenantPaths, projectId);
    const list = auth && Array.isArray(auth.allowedGroups) ? auth.allowedGroups : [];
    return list.map((g) => String(g)).filter((g) => g.trim() !== '');
}

function allowedUsersFor(slug, tenantPaths, projectId) {
    return authMethods.usersOf(authRecordFor(slug, tenantPaths, projectId));
}

function audienceFor(slug, tenantPaths, projectId) {
    return authMethods.audienceOf(authRecordFor(slug, tenantPaths, projectId));
}

/* ------------------------------------------------------------------ */
/* group matching                                                      */
/* ------------------------------------------------------------------ */

function normalizeGroup(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/**
 * The `CN=` of a DN, unescaped enough to compare.
 *
 * `memberOf` gives full DNs, and no operator wants to paste
 * `CN=Domain Admins,CN=Users,DC=corp,DC=local` into a text field. Accepting the
 * common name alone is the difference between a feature that gets used and one
 * that gets turned off.
 */
function firstCn(dn) {
    const m = /^\s*CN\s*=\s*((?:[^,\\]|\\.)*)/i.exec(String(dn || ''));
    if (!m) return '';
    return m[1].replace(/\\(.)/g, '$1');
}

/**
 * Does any of the user's groups appear on the allow list?
 *
 * An empty allow list matches nothing here, which is the opposite of what this
 * function used to return. The "empty means everyone" rule did not disappear,
 * it moved up one level to `audience`, where it is a stored choice rather than
 * a property of a list being empty. Leaving it here as well would mean a site
 * whose audience is `listed` and whose lists are both empty silently opens to
 * the whole directory -- the exact trap the audience field exists to remove.
 */
/**
 * The named person a SID belongs to, or null.
 *
 * Compared case-insensitively. A SID is canonically upper-case hexadecimal-free
 * decimal text, so this changes nothing on a value `sidToString` produced; it
 * matters for one hand-edited into projects.json, which is a real way an
 * operator adds the first administrator on a machine with no picker.
 */
function findUser(allowedUsers, sid) {
    const want = String(sid || '').trim().toUpperCase();
    if (!want) return null;
    for (const u of (allowedUsers || [])) {
        if (String(u.sid || '').trim().toUpperCase() === want) return u;
    }
    return null;
}

/**
 * Who gets in, and who runs the place once in.
 *
 * Two independent answers, which is the whole point of separating `audience`
 * from the `admin` flag. A site can open to the entire directory and still have
 * exactly one administrator: the application behind it manages its own roles
 * and only needs Aegis to say which visitor is allowed to open that panel.
 *
 * `admin` is only ever carried by a named person. A group cannot confer it,
 * because "whoever is in this group administers the site" is a promotion that
 * happens without anybody reviewing it.
 *
 * Directory audience and an empty list is not a bug: it is how a site is kept
 * off the open network without maintaining a group for it. What changed is that
 * it is now written down in the record rather than inferred from an absence.
 */
function accessFor(allowedGroups, allowedUsers, audience, groups, sid) {
    const named = findUser(allowedUsers, sid);
    const admin = !!(named && named.admin === true);
    if (audience === authMethods.DIRECTORY) return { allowed: true, admin };
    // Listed: either list may open the door, neither being satisfied closes it.
    return { allowed: !!named || groupAllowed(allowedGroups, groups), admin };
}

function groupAllowed(allowedGroups, groups) {
    const wanted = (allowedGroups || []).map(normalizeGroup).filter(Boolean);
    if (!wanted.length) return false;

    const have = new Set();
    for (const raw of (groups || [])) {
        const full = normalizeGroup(raw);
        if (full) have.add(full);
        const cn = normalizeGroup(firstCn(raw));
        if (cn) have.add(cn);
    }
    return wanted.some((w) => have.has(w));
}

/* ------------------------------------------------------------------ */
/* sessions and lockout                                                */
/* ------------------------------------------------------------------ */

/** token -> { slug, projectId, username, login, user, groups, sid, admin, ip,
 *  loginAt, lastSeen, expiresAt, nextCheckAt }
 *  `username` is the submitted identifier used for later lookups; `login` is
 *  the directory's canonical account name; `user` is the display name.
 *  `lastSeen` is the last request on the session, for the idle timeout. */
const sessions = new Map();
/** `ip|projectId` -> { fails, until } */
const failures = new Map();

function newToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function isOver(s, now) {
    if (s.expiresAt <= now) return true;
    return now - (s.lastSeen || now) > IDLE_MS;
}

function purgeSessions(now) {
    for (const [token, s] of sessions) {
        if (isOver(s, now)) sessions.delete(token);
    }
}

/**
 * The live session a cookie names on this site, or null.
 *
 * Reading it is not activity: `served` slides the idle window, and only for a
 * request the guard lets through. A 403, a 503 or a 404 on the reserved prefix
 * must not keep an unattended session alive. The eight-hour cap in `expiresAt`
 * never moves: a visitor active all day still signs in again.
 */
function sessionFor(token, slug, projectId) {
    if (!token) return null;
    const now = Date.now();
    purgeSessions(now);
    const s = sessions.get(token);
    if (!s) return null;
    // Same host, different port: the browser sends a cookie minted for another
    // site. It is a valid token and still not a session here.
    if (s.slug !== slug || s.projectId !== projectId) return null;
    return s;
}

/** Marks an accepted request on a session, and passes the verdict through. */
function served(session, verdict) {
    if (verdict === false) session.lastSeen = Date.now();
    return verdict;
}

/**
 * One spelling per account, for comparing names an operator types with names a
 * visitor typed. Lower case, without a leading `DOMAIN\` and without a trailing
 * `@suffix`: `CORP\Alice`, `alice@corp.local` and `ALICE` are one person.
 */
function normalizeUser(name) {
    let s = String(name === undefined || name === null ? '' : name).trim().toLowerCase();
    const slash = s.indexOf('\\');
    if (slash >= 0) s = s.slice(slash + 1);
    const at = s.indexOf('@');
    if (at >= 0) s = s.slice(0, at);
    return s.trim();
}

/**
 * Who is signed in to one site, for the dashboard. Never the session token,
 * never the CSRF token: a row is something an administrator reads, and a token
 * in it would be a way to become that person.
 */
function listSessions(slug, projectId) {
    const now = Date.now();
    purgeSessions(now);
    const rows = [];
    for (const s of sessions.values()) {
        if (s.slug !== slug || s.projectId !== projectId) continue;
        rows.push({
            username: s.login || s.username || '',
            loginAt: s.loginAt || 0,
            ip: s.ip || '',
            lastSeen: s.lastSeen || 0,
            expiresAt: s.expiresAt
        });
    }
    return rows.sort((a, b) => b.lastSeen - a.lastSeen);
}

/**
 * Closes the sessions of one site, or only those of one person on it. Returns
 * how many were closed. A name that normalises to nothing closes nothing: an
 * empty match must never read as "everyone".
 */
function dropSessionsFor(slug, projectId, username) {
    const named = username !== undefined && username !== null;
    const wanted = named ? normalizeUser(username) : '';
    if (named && !wanted) return 0;
    let closed = 0;
    for (const [token, s] of sessions) {
        if (s.slug !== slug || s.projectId !== projectId) continue;
        if (named && normalizeUser(s.username) !== wanted && normalizeUser(s.login) !== wanted) continue;
        sessions.delete(token);
        closed += 1;
    }
    return closed;
}

function clientIp(req) {
    return (req.socket && (req.socket.remoteAddress || '')) || 'unknown';
}

function lockKey(ip, projectId) {
    return `${ip}|${projectId}`;
}

/** Seconds left on the lock, or 0 when the caller may try. */
function lockRemaining(ip, projectId) {
    const rec = failures.get(lockKey(ip, projectId));
    if (!rec || !rec.until) return 0;
    const left = rec.until - Date.now();
    if (left <= 0) {
        failures.delete(lockKey(ip, projectId));
        return 0;
    }
    return Math.ceil(left / 1000);
}

function noteFailure(ip, projectId) {
    const k = lockKey(ip, projectId);
    const rec = failures.get(k) || { fails: 0, until: 0 };
    rec.fails += 1;
    if (rec.fails >= LOCK_THRESHOLD) {
        rec.until = Date.now() + LOCK_MS;
        rec.fails = 0;   // the lock replaces the count; the next burst starts over
    }
    failures.set(k, rec);
    return rec;
}

function clearFailures(ip, projectId) {
    failures.delete(lockKey(ip, projectId));
}

/**
 * Forgets every lockout recorded against a project.
 *
 * Deleting a project frees its id, and `projectStore.idFor` hands a freed id
 * straight back to the next project of the same name. Without this, a visitor
 * who mistyped a password three times on the site that was deleted arrives at
 * the new one already locked out, for a reason nothing on screen can explain.
 */
function dropFailures(projectId) {
    const suffix = `|${projectId}`;
    for (const k of failures.keys()) {
        if (k.endsWith(suffix)) failures.delete(k);
    }
}

/* ------------------------------------------------------------------ */
/* strings                                                             */
/* ------------------------------------------------------------------ */

/**
 * Two blocks, held here rather than in `translations.js`.
 *
 * That file lives on the dashboard's origin and this page is served from a
 * different port with no network path to it. Nine strings duplicated is the
 * price of the page being able to stand alone.
 */
const STRINGS = {
    en: {
        htmlLang: 'en',
        title: 'Sign in',
        subtitle: 'This site is restricted. Sign in with your directory account.',
        user: 'Username',
        password: 'Password',
        submit: 'Sign in',
        footer: 'Protected by Aegis',
        signedOut: 'You have been signed out.',
        errUnavailable: 'Sign-in is unavailable for this site. Contact the administrator.',
        errUnavailableTitle: 'Sign-in unavailable',
        errNotTls: 'This site requires an encrypted connection. Open it over HTTPS, or contact the administrator.',
        errCredentials: 'Incorrect username or password.',
        errPasswordExpired: 'Your password has expired. Change it, then sign in again.',
        errPasswordMustChange: 'Your password must be changed before you can sign in.',
        errAccountDisabled: 'This account is disabled. Ask your administrator.',
        errAccountLocked: 'This account is locked. Try again later, or ask your administrator.',
        errAccountExpired: 'This account has expired. Ask your administrator.',
        errLogonDenied: 'This account cannot sign in at the moment.',
        errForbidden: 'Your account is not allowed to open this site.',
        errNoGrantTitle: 'Access denied',
        errNoGrant: 'You are signed in, and this page needs an access that has not been granted to you. Ask whoever administers this site for it.',
        errDirectory: 'The directory could not be reached. Try again later.',
        errDirectoryTitle: 'Directory unavailable',
        errEmpty: 'Enter a username and a password.',
        errSession: 'Your session expired. Sign in again.',
        errLocked: 'Too many attempts. Try again in $1 seconds.'
    },
    fr: {
        htmlLang: 'fr',
        title: 'Connexion',
        subtitle: 'Ce site est protégé. Connectez-vous avec votre compte de l\'annuaire.',
        user: 'Identifiant',
        password: 'Mot de passe',
        submit: 'Se connecter',
        footer: 'Protégé par Aegis',
        signedOut: 'Vous avez été déconnecté.',
        errUnavailable: 'La connexion est indisponible pour ce site. Contactez l\'administrateur.',
        errUnavailableTitle: 'Connexion indisponible',
        errNotTls: 'Ce site exige une connexion chiffrée. Ouvrez-le en HTTPS, ou contactez l\'administrateur.',
        errCredentials: 'Identifiant ou mot de passe incorrect.',
        errPasswordExpired: 'Votre mot de passe a expiré. Changez-le, puis reconnectez-vous.',
        errPasswordMustChange: 'Votre mot de passe doit être changé avant la connexion.',
        errAccountDisabled: 'Ce compte est désactivé. Voyez avec votre administrateur.',
        errAccountLocked: 'Ce compte est verrouillé. Réessayez plus tard, ou voyez avec votre administrateur.',
        errAccountExpired: 'Ce compte a expiré. Voyez avec votre administrateur.',
        errLogonDenied: 'Ce compte ne peut pas se connecter en ce moment.',
        errForbidden: 'Votre compte n\'est pas autorisé à ouvrir ce site.',
        errNoGrantTitle: 'Accès refusé',
        errNoGrant: 'Vous êtes connecté, et cette page exige un accès qui ne vous a pas été accordé. Demandez-le à qui administre ce site.',
        errDirectory: 'L\'annuaire est injoignable. Réessayez plus tard.',
        errDirectoryTitle: 'Annuaire injoignable',
        errEmpty: 'Saisissez un identifiant et un mot de passe.',
        errSession: 'Votre session a expiré. Reconnectez-vous.',
        errLocked: 'Trop de tentatives. Réessayez dans $1 secondes.'
    }
};

/**
 * What a refused login tells the visitor.
 *
 * Three answers, and the status code says which. A wrong password and an
 * unknown account are the visitor's own affair: 401, and the same sentence for
 * both, because a form that answers differently to a name that exists is an
 * account enumerator.
 *
 * The account states are equally the visitor's affair and equally 401, but each
 * carries its own sentence. Telling someone whose password expired that their
 * password is wrong sends them to retype a password that was right, and their
 * administrator to look for a fault in Aegis. The directory already said which
 * it was; this passes the answer on.
 *
 * Anything not in the table is the directory or its configuration: 502. That is
 * not something the visitor did or can fix, and it must never read as their
 * mistake. The default is the 502 rather than the 401 on purpose -- a refusal
 * this build does not recognise is a fault on our side of the form, and saying
 * `errCredentials` to it would blame the visitor for it.
 */
const VISITOR_REFUSAL = {
    ldap_invalid_credentials: { status: 401, key: 'errCredentials' },
    ldap_user_not_found: { status: 401, key: 'errCredentials' },
    ldap_password_expired: { status: 401, key: 'errPasswordExpired' },
    ldap_password_must_change: { status: 401, key: 'errPasswordMustChange' },
    ldap_account_disabled: { status: 401, key: 'errAccountDisabled' },
    ldap_account_locked: { status: 401, key: 'errAccountLocked' },
    ldap_account_expired: { status: 401, key: 'errAccountExpired' },
    ldap_logon_denied: { status: 401, key: 'errLogonDenied' }
};

const DIRECTORY_REFUSAL = { status: 502, key: 'errDirectory' };

/** French when the browser asks for it first, English otherwise. */
function pickLang(req) {
    const header = String((req.headers && req.headers['accept-language']) || '');
    for (const part of header.split(',')) {
        const tag = part.split(';')[0].trim().toLowerCase();
        if (!tag) continue;
        if (tag === 'fr' || tag.startsWith('fr-')) return 'fr';
        if (tag === 'en' || tag.startsWith('en-')) return 'en';
    }
    return 'en';
}

function tr(lang, key, arg) {
    const table = STRINGS[lang] || STRINGS.en;
    const raw = table[key] === undefined ? (STRINGS.en[key] || '') : table[key];
    return arg === undefined ? raw : raw.replace('$1', String(arg));
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Every one of `& < > " '`.
 *
 * The site name comes from a project record an operator typed, the username
 * comes from the request body, and the `next` path comes from the URL bar. All
 * three land inside attributes, so the quotes matter as much as the angles.
 */
function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * A `next` that can only ever point back at this site.
 *
 * `//evil.com` and `/\evil.com` are both read as scheme-relative by browsers,
 * so "starts with a slash" alone is an open redirect. Anything that is not
 * plainly a path on this origin becomes `/`.
 */
function safeNext(raw) {
    const value = String(raw === undefined || raw === null ? '' : raw);
    if (!value || value[0] !== '/') return '/';
    if (value[1] === '/' || value[1] === '\\') return '/';
    // Control characters and whitespace in a Location header are a response
    // splitting primitive, and no legitimate path carries them.
    if (/[\x00-\x20\x7f]/.test(value)) return '/';
    if (value.startsWith(PREFIX) || value === '/__aegis') return '/';
    return value;
}

/** The template and the page's assets, re-read when they change on disk. */
const fileCache = new Map();

/** Bytes, because the font is not text. */
function readPageBytes(name) {
    const file = path.join(PAGE_DIR, name);
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch (_) { return null; }
    const hit = fileCache.get(name);
    if (hit && hit.mtime === mtime) return hit.body;
    let body;
    try { body = fs.readFileSync(file); } catch (_) { return null; }
    fileCache.set(name, { mtime, body });
    return body;
}

function readPageFile(name) {
    const body = readPageBytes(name);
    return body === null ? null : body.toString('utf8');
}

function renderLogin({ lang, siteName, next, error, csrf, username }) {
    const template = readPageFile('login.html');
    if (template === null) return null;
    const values = {
        LANG: STRINGS[lang] ? STRINGS[lang].htmlLang : 'en',
        SITE_NAME: siteName,
        NEXT: next,
        ERROR: error || '',
        CSRF: csrf,
        USERNAME: username || '',
        T_TITLE: tr(lang, 'title'),
        T_SUBTITLE: tr(lang, 'subtitle'),
        T_USER: tr(lang, 'user'),
        T_PASSWORD: tr(lang, 'password'),
        T_SUBMIT: tr(lang, 'submit'),
        T_FOOTER: tr(lang, 'footer')
    };
    // Every value is escaped on the way in, so the template needs no filters and
    // a placeholder that lands in an attribute is as safe as one in a text node.
    return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) =>
        (Object.prototype.hasOwnProperty.call(values, key) ? escapeHtml(values[key]) : whole));
}

/**
 * The refusal page.
 *
 * The one piece of markup in this file. It stays here rather than becoming a
 * second template because it is a shell with no form and no state, and it
 * borrows every colour from `login.css` through the same class names, so
 * nothing is hardcoded here either.
 */
function renderError(lang, heading, message) {
    return '<!DOCTYPE html>\n'
        + `<html lang="${escapeHtml(STRINGS[lang] ? STRINGS[lang].htmlLang : 'en')}">\n`
        + '<head>\n<meta charset="utf-8">\n'
        + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        + `<title>${escapeHtml(heading)}</title>\n`
        + `<link rel="stylesheet" href="${CSS_PATH}">\n`
        + '</head>\n<body class="auth-body">\n<main class="auth-shell">\n'
        + '<section class="auth-card">\n'
        + `<h1 class="auth-title">${escapeHtml(heading)}</h1>\n`
        + `<p class="auth-error">${escapeHtml(message)}</p>\n`
        + '</section>\n</main>\n'
        + `<footer class="auth-brand" aria-label="${escapeHtml(tr(lang, 'footer'))}">\n`
        + `<img class="auth-brand-mark" src="${MARK_PATH}" alt="" width="20" height="20">\n`
        + '<span class="auth-brand-word" aria-hidden="true">Aegis</span>\n'
        + '</footer>\n</body>\n</html>\n';
}

function sendHtml(res, status, body, extraHeaders) {
    const headers = Object.assign({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        // The `next` path rides in the URL; no other origin needs to read it.
        'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Opener-Policy': 'same-origin',
        // The login page loads its own stylesheet, font and images, and posts
        // to its own origin. Nothing else, so nothing else is allowed. Still no
        // script-src: the page runs none.
        'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; "
            + "form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    }, extraHeaders || {});
    res.writeHead(status, headers);
    res.end(body);
}

function redirect(res, location, extraHeaders) {
    res.writeHead(302, Object.assign({
        Location: location,
        'Content-Length': 0,
        'Cache-Control': 'no-store'
    }, extraHeaders || {}));
    res.end();
}

/**
 * Whether this request arrived over TLS, taken from the socket.
 *
 * From the socket and not from the project record on purpose. The two can
 * disagree — a record that says TLS while the listener came up plain would put
 * `Secure` on a cookie the browser then refuses to send back, and login would
 * fail with nothing to point at. The socket cannot be wrong about itself.
 *
 * No `X-Forwarded-Proto`, for the same reason the lockout counter ignores
 * `X-Forwarded-For`: nothing forwards to this port, so the header could only
 * arrive from the client, and trusting it would let anyone claim TLS.
 */
function isSecure(req) {
    return Boolean(req && req.socket && req.socket.encrypted);
}

/**
 * `Secure` only when the connection is one, which is what makes it safe to set
 * at all: on a plain-HTTP site the browser would never send the cookie back and
 * login would break outright. See the file header.
 */
function sessionCookie(token, maxAgeSeconds, secure) {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`
        + (secure ? '; Secure' : '');
}

function csrfCookie(token, secure) {
    // Readable by script is irrelevant here: the page runs no script, and the
    // value only has to be something a cross-site form cannot know.
    return `${CSRF_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800`
        + (secure ? '; Secure' : '');
}

/** Equal and non-empty, compared in constant time. */
function sameToken(a, b) {
    const x = Buffer.from(String(a || ''), 'utf8');
    const y = Buffer.from(String(b || ''), 'utf8');
    return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
    const header = (req.headers && req.headers.cookie) || '';
    for (const part of String(header).split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return null;
}

/** The body, or null when it is absent, oversized or unreadable. */
function readBody(req, limit) {
    return new Promise((resolve) => {
        let size = 0;
        let settled = false;
        const chunks = [];
        const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                // A form this big is not a form. Stop reading rather than buffer it.
                finish(null);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
        req.on('error', () => finish(null));
        req.on('aborted', () => finish(null));
    });
}

/* ------------------------------------------------------------------ */
/* the gate                                                            */
/* ------------------------------------------------------------------ */

function serveAsset(req, res, asset) {
    const buf = readPageBytes(asset.file);
    if (buf === null) return sendHtml(res, 500, 'asset missing');
    res.writeHead(200, {
        'Content-Type': asset.type,
        'Content-Length': buf.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin'
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
}

/**
 * A method name, safe to put in a log line.
 *
 * The value comes off disk and the admin route whitelists what it writes, but a
 * hand-edited `projects.json` is exactly the case this log line exists for, so
 * it is quoted and clipped rather than trusted to be a word.
 */
function describeMethod(method) {
    const raw = String(method === undefined || method === null ? '' : method);
    const clipped = raw.slice(0, 40).replace(/[^ -~]/g, '?');
    return JSON.stringify(clipped) + (raw.length > 40 ? ' (clipped)' : '');
}

function notFound(res) {
    const body = 'Not found';
    res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
}

function loginPage(res, status, ctx, opts) {
    const csrf = opts.csrf || newToken();
    const body = renderLogin({
        lang: ctx.lang,
        siteName: ctx.siteName,
        next: opts.next,
        error: opts.error,
        csrf,
        username: opts.username
    });
    if (body === null) {
        // The template is part of the install. Missing it is not a reason to
        // start serving the site.
        return sendHtml(res, 500,
            renderError(ctx.lang, tr(ctx.lang, 'errUnavailableTitle'), tr(ctx.lang, 'errUnavailable')));
    }
    return sendHtml(res, status, body,
        Object.assign({ 'Set-Cookie': csrfCookie(csrf, ctx.secure === true) }, opts.headers));
}

/**
 * Intercepts a request to a deployed site.
 *
 * Returns true when the request is finished and the caller must not serve
 * anything, false when it is authenticated and the file server should proceed.
 * Returns a promise on the login POST and on a signed-in write (any method but
 * GET, HEAD, OPTIONS), which waits for the directory; the caller handles both.
 */
function gate(req, res, { slug, tenantPaths, project, root, viaRouterHostName }) {
    const projectId = project && project.id;
    // One year, no `includeSubDomains`, no `preload`: it binds this host name
    // and nothing under it. Only for a secure request that was routed by the
    // project's own name; see the file header for why never `host:port`.
    if (isSecure(req) && viaRouterHostName && typeof res.setHeader === 'function') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }
    const siteName = (project && (project.name || project.id)) || 'site';
    const pathOnly = String(req.url || '/').split('?')[0];
    const reserved = pathOnly === '/__aegis' || pathOnly.startsWith(PREFIX);

    if (!projectId) {
        // Without an id there is no record to consult, so there is no way to
        // know whether this site is protected. Refuse instead of guessing.
        sendHtml(res, 503, renderError('en', 'Unavailable', 'This site is not configured.'));
        return true;
    }

    const method = methodFor(slug, tenantPaths, projectId);

    if (method === authMethods.NONE) {
        // The release and notices routes are the site server's, and an open
        // site hides nothing behind them that the site itself does not show.
        if (isSitePath(pathOnly)) return false;
        if (pathOnly === siteNotices.SCRIPT_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
            serveAsset(req, res, ASSETS[pathOnly]);
            return true;
        }
        // The prefix is reserved even here, so that turning protection on later
        // cannot be shadowed by a file the repository already contains.
        if (reserved) { notFound(res); return true; }
        return false;
    }

    const lang = pickLang(req);
    const ctx = { slug, tenantPaths, projectId, siteName, lang, secure: isSecure(req) };

    // Served before the directory is consulted: they carry nothing secret, and
    // the refusal page below needs them to be legible. The site icon is the one
    // file read out of the site itself; siteIcon.js says what keeps that to an
    // image inside the site.
    if (req.method === 'GET' || req.method === 'HEAD') {
        if (Object.prototype.hasOwnProperty.call(ASSETS, pathOnly)) {
            serveAsset(req, res, ASSETS[pathOnly]);
            return true;
        }
        if (pathOnly === ICON_PATH) {
            siteIcon.serve(req, res, { root, siteName });
            return true;
        }
    }

    // A protected site is never served over a clear socket. Refused before the
    // directory is consulted and before any form or cookie exists: a password
    // typed into a page loaded in clear is already lost.
    if (!isSecure(req)) {
        const plainLang = pickLang(req);
        console.warn(`[Deploy] ${slug}/${projectId}: refused, site_not_tls: a protected site is served over TLS only`);
        sendHtml(res, 503,
            renderError(plainLang, tr(plainLang, 'errUnavailableTitle'), tr(plainLang, 'errNotTls')));
        return true;
    }

    // Which door this site opens. `none` returned above; every method this
    // build cannot run stops here, before the code that assumes the directory
    // is the one in use. A record naming a method from a newer Aegis, or one
    // typed by hand into projects.json, is a misconfiguration and refusing is
    // the only reading of it that cannot publish the site by accident.
    if (method !== authMethods.LDAP) {
        console.warn(`[Deploy] ${slug}/${projectId}: refused, authentication method ${describeMethod(method)} is not one this build can serve`);
        sendHtml(res, 503,
            renderError(lang, tr(lang, 'errUnavailableTitle'), tr(lang, 'errUnavailable')));
        return true;
    }

    const config = configFor(slug, tenantPaths);
    if (!config) {
        // Fail closed. Marked protected and no directory to check against means
        // nobody gets in, including whoever forgot to configure it.
        console.warn(`[Deploy] ${slug}/${projectId}: refused, site is protected but no directory is configured`);
        sendHtml(res, 503,
            renderError(lang, tr(lang, 'errUnavailableTitle'), tr(lang, 'errUnavailable')));
        return true;
    }

    const token = readCookie(req, SESSION_COOKIE);
    const session = sessionFor(token, slug, projectId);

    if (pathOnly === LOGOUT_PATH) {
        if (token) sessions.delete(token);
        redirect(res, LOGIN_PATH, { 'Set-Cookie': sessionCookie('', 0, ctx.secure) });
        return true;
    }

    if (pathOnly === LOGIN_PATH) {
        if (req.method === 'GET' || req.method === 'HEAD') {
            const next = safeNext(new URLSearchParams(String(req.url || '').split('?')[1] || '').get('next'));
            if (session) { redirect(res, next); return true; }
            loginPage(res, 200, ctx, { next, error: '', username: '' });
            return true;
        }
        if (req.method === 'POST') return handleLogin(req, res, ctx, config);
        notFound(res);
        return true;
    }

    // The one thing core owes an application that manages its own roles: who is
    // reading it, and whether Aegis considers them this site's administrator.
    //
    // This exists so that Aegis does not grow a permissions console per
    // deployed application. The operator names the administrator here; the
    // application asks this endpoint and builds whatever panel it wants. The
    // traffic is one way, as everywhere else in the extension seam: the site
    // reads a fact, and can write nothing back.
    //
    // Only ever served on a protected site. An unprotected one answers 404 on
    // the whole reserved prefix, above, which is the honest answer -- there is
    // no directory identity behind an unprotected site to report. An
    // application should read any non-200 as "no Aegis identity here".
    //
    // `no-store`, because a cached answer is a stale role, and shared caches
    // must never hand one visitor's identity to the next.
    if (pathOnly === WHOAMI_PATH) {
        if (req.method !== 'GET' && req.method !== 'HEAD') { notFound(res); return true; }
        const body = session
            ? {
                authenticated: true,
                login: session.login || session.username || '',
                name: session.user || session.login || session.username || '',
                sid: session.sid || '',
                admin: session.admin === true
            }
            : { authenticated: false };
        const json = JSON.stringify(body);
        res.writeHead(session ? 200 : 401, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(json),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        res.end(req.method === 'HEAD' ? undefined : json);
        if (session) served(session, false);
        return true;
    }

    const write = !READ_METHODS.has(req.method);

    // A write waits for the directory before it goes anywhere, the site's own
    // reserved routes included: see recheckWrite. A read keeps the timer.
    if (session && write && (isSitePath(pathOnly) || !reserved)) {
        return recheckWrite(session, token, ctx, config).then((outcome) => {
            if (outcome === 'refused') {
                sendHtml(res, 403, renderError(lang, tr(lang, 'errNoGrantTitle'), tr(lang, 'errForbidden')));
                return true;
            }
            if (outcome === 'unanswered') {
                sendHtml(res, 503, renderError(lang, tr(lang, 'errDirectoryTitle'), tr(lang, 'errDirectory')));
                return true;
            }
            if (isSitePath(pathOnly)) return served(session, false);
            return served(session, admit(req, res, session, ctx, pathOnly));
        });
    }

    // Past the door only: which commits a protected site runs, and what it
    // says to its visitors, is not for somebody who has not signed in. Without
    // a session it is a reserved path like any other, and answers 404.
    if (session && isSitePath(pathOnly)) return served(session, false);

    if (reserved) { notFound(res); return true; }

    if (session) {
        // Fires at most once per interval and never blocks: see maybeRevalidate.
        maybeRevalidate(session, token, ctx, config);
        return served(session, admit(req, res, session, ctx, pathOnly));
    }

    // Everything else on a protected site: send them to the form, remembering
    // where they were headed.
    redirect(res, `${LOGIN_PATH}?next=${encodeURIComponent(safeNext(req.url || '/'))}`);
    return true;
}

/**
 * The last question for a visitor past the door: the site's own rules. True
 * when the request was refused here, false when the file server takes over.
 */
function admit(req, res, session, ctx, pathOnly) {
    const { slug, tenantPaths, projectId, lang } = ctx;
    // The site's own rules, after the door and before the files. The visitor
    // is past the gate here, so this answers the second question: not "may you
    // be in this building" but "may you have this room".
    //
    // Answered here rather than handed to the application, because an
    // application that forgets the check serves the data and the omission is
    // invisible. This one cannot be forgotten: the request never reaches the
    // application at all.
    const policy = policyFor(slug, tenantPaths, projectId);
    // The site administrator holds every resource the site declares. The tick
    // is carried by a named person and never by a group (`a group can never
    // confer admin`), so this is a decision taken about one person, not a door
    // a group membership opens. Without it, the person Aegis names to run the
    // site would have to be named again under each resource, and would find a
    // room locked the day the site added one. A demotion lands with the
    // revalidation that clears `session.admin`.
    if (policy.rules.length && session.admin !== true) {
        const auth = authRecordFor(slug, tenantPaths, projectId) || {};
        const seen = accessPolicy.verdict({
            rules: policy.rules,
            grants: auth.grants || {},
            groups: session.groups,
            sid: session.sid,
            rawUrl: req.url,
            // The same matcher the site door uses, handed in rather than
            // reimplemented: a directory answers full distinguished names and
            // an operator types a plain one, and the two questions must never
            // disagree about what counts as being in a group.
            groupMatches: groupAllowed
        });
        if (!seen.allowed) {
            // Named in the log and not on the page. The visitor is told which
            // access they lack, because asking an administrator for it is
            // their next move; the log carries who they are, which is the half
            // the page has no business repeating back.
            console.warn(`[Deploy] ${slug}/${projectId}: ${session.username} refused `
                + `${pathOnly} (needs ${seen.resource || 'an unreadable path'})`);
            sendHtml(res, 403, renderError(lang,
                tr(lang, 'errNoGrantTitle'), tr(lang, 'errNoGrant')));
            return true;
        }
    }
    return false;            // authenticated and entitled: the file server takes over
}

/**
 * Who the guard let through, for the one caller that has to tell somebody else.
 *
 * `gate` answers a boolean -- handled, or not -- because that is all the server
 * needs in order to decide whether to keep going. The reverse proxy needs more:
 * an application behind a protected site is served to a person this file has
 * already identified, and until now it had no way to learn who that was. A
 * deployed project with roles of its own had to put a second login in front of
 * one that had already run.
 *
 * A function, and not a field written onto the request context. `siteServer`
 * builds one context per LISTENER and hands the same object to every request
 * (`startSiteFor`), so an identity stored there would be the previous visitor's
 * on the next request -- the worst failure this whole file exists to prevent.
 * Reading the cookie a second time costs a map lookup and cannot be wrong in
 * that direction.
 *
 * Null has exactly one meaning: nobody was authenticated for this request. The
 * site is open, or its record names a method this build refuses, or the session
 * expired between the guard and this call. The caller must then send no
 * identity at all rather than an empty one, because an application reading an
 * empty header as a user is the failure that null is here to avoid.
 */
function identityFor(req, { slug, tenantPaths, project }) {
    const projectId = project && project.id;
    if (!projectId) return null;
    if (methodFor(slug, tenantPaths, projectId) === authMethods.NONE) return null;

    const session = sessionFor(readCookie(req, SESSION_COOKIE), slug, projectId);
    if (!session) return null;

    return {
        username: session.login || session.username || '',
        // The directory does not always answer with a display name. Falling back
        // to the account name keeps the header meaning "a person", never empty.
        user: session.user || session.login || session.username || '',
        groups: Array.isArray(session.groups) ? session.groups : []
    };
}

/**
 * The form submission. Always resolves true: whatever happens, this request is
 * answered here and no file is served.
 */
async function handleLogin(req, res, ctx, config) {
    const ip = clientIp(req);
    const raw = await readBody(req, BODY_LIMIT);
    const form = new URLSearchParams(raw === null ? '' : raw);

    const next = safeNext(form.get('next'));
    const username = String(form.get('username') || '').trim();
    const password = String(form.get('password') || '');
    const sentCsrf = String(form.get('csrf') || '');
    const cookieCsrf = readCookie(req, CSRF_COOKIE) || '';

    // From here on `password` is only ever passed to verify(). It is not logged,
    // not echoed into the form, and not part of any error.

    const locked = lockRemaining(ip, ctx.projectId);
    if (locked > 0) {
        // Through loginPage, so the form's new token and its cookie travel
        // together. Rendered with a token and no cookie, the first try after
        // the wait failed the CSRF check and counted as one more failure.
        loginPage(res, 429, ctx, {
            next, error: tr(ctx.lang, 'errLocked', locked), username,
            headers: { 'Retry-After': String(locked) }
        });
        return true;
    }

    // Double submit: a form posted from another origin cannot read the cookie,
    // so it cannot produce a matching field. Counted as a failure like any
    // other, because a real user never trips it twice.
    if (!sameToken(sentCsrf, cookieCsrf)) {
        noteFailure(ip, ctx.projectId);
        loginPage(res, 400, ctx, { next, error: tr(ctx.lang, 'errSession'), username });
        return true;
    }

    if (!username || !password) {
        // Not counted against the lockout: an empty form is a slip, not a guess.
        loginPage(res, 400, ctx, { next, error: tr(ctx.lang, 'errEmpty'), username });
        return true;
    }

    let result;
    try {
        result = await verify(config, username, password);
    } catch (e) {
        // verify() is documented never to throw. If it does anyway, that is an
        // upstream fault and not a reason to serve the site.
        result = { ok: false, error: 'ldap_protocol_error' };
    }
    result = result && typeof result === 'object' ? result : { ok: false, error: 'ldap_protocol_error' };

    if (!result.ok) {
        noteFailure(ip, ctx.projectId);
        const refusal = VISITOR_REFUSAL[result.error] || DIRECTORY_REFUSAL;
        console.warn(`[Deploy] ${ctx.slug}/${ctx.projectId}: login refused for ${username} (${result.error || 'unknown'})`);
        loginPage(res, refusal.status, ctx, {
            next,
            error: tr(ctx.lang, refusal.key),
            username
        });
        return true;
    }

    const groups = Array.isArray(result.groups) ? result.groups : [];
    const sid = String(result.sid || '');
    const allowedUsers = allowedUsersFor(ctx.slug, ctx.tenantPaths, ctx.projectId);
    const audience = audienceFor(ctx.slug, ctx.tenantPaths, ctx.projectId);

    // No SID, and people are named on this site. The direct-bind path reads the
    // entry best effort, so a directory that refuses that read leaves the one
    // field a named person is matched on empty -- and an empty field must not
    // quietly fall through to the group check and let somebody in on a rule
    // that was not the one the operator wrote. Refused, and logged as its own
    // cause: "not in the list" and "could not read your identity" send an
    // administrator to two very different places.
    if (!sid && allowedUsers.length) {
        noteFailure(ip, ctx.projectId);
        console.warn(`[Deploy] ${ctx.slug}/${ctx.projectId}: login refused for ${username} (no objectSid returned; the service account may not be able to read it)`);
        loginPage(res, 403, ctx, { next, error: tr(ctx.lang, 'errForbidden'), username });
        return true;
    }

    const verdict = accessFor(
        allowedGroupsFor(ctx.slug, ctx.tenantPaths, ctx.projectId),
        allowedUsers, audience, groups, sid);
    if (!verdict.allowed) {
        // Authenticated but not entitled. Counted, because probing a list is a
        // way of enumerating accounts.
        noteFailure(ip, ctx.projectId);
        console.warn(`[Deploy] ${ctx.slug}/${ctx.projectId}: login refused for ${username} (not_allowed)`);
        loginPage(res, 403, ctx, { next, error: tr(ctx.lang, 'errForbidden'), username });
        return true;
    }

    clearFailures(ip, ctx.projectId);
    const token = newToken();
    const everyMs = Number(config && config.revalidateMinutes) * 60 * 1000;
    const login = String(result.login || username);
    const now = Date.now();
    sessions.set(token, {
        slug: ctx.slug,
        projectId: ctx.projectId,
        username,
        login,
        user: result.displayName || login,
        groups,
        sid,
        admin: verdict.admin,
        // For the dashboard's session list only; never a key for anything.
        ip,
        loginAt: now,
        lastSeen: now,
        expiresAt: now + SESSION_MS,
        // Just checked, by the login itself. The first re-check is a full
        // interval away rather than on the next request.
        nextCheckAt: everyMs > 0 ? now + everyMs : Infinity
    });
    console.log(`[Deploy] ${ctx.slug}/${ctx.projectId}: site login by ${username}${verdict.admin ? ' (site administrator)' : ''}`);
    redirect(res, next, { 'Set-Cookie': sessionCookie(token, Math.floor(SESSION_MS / 1000), ctx.secure) });
    return true;
}

/**
 * Asks the directory whether a logged-in user is still entitled, in the
 * background.
 *
 * A session carries the group list from the moment of login and nothing after
 * that notices the user being taken out of the group. Re-checking closes that,
 * but not by making the check part of the request: `gate` is synchronous on
 * every path except the form POST, and that is what keeps the static path
 * unchanged for the sites that are not protected at all. Blocking a page load
 * on a domain controller would be paid by every request to every protected
 * site, to catch a change that happens rarely.
 *
 * So the request that trips the timer goes through with the list it has, and
 * the next ones see the new verdict. The exposure is a few requests, against
 * the whole eight-hour session before this existed.
 *
 * The three outcomes, and why:
 *
 * - The directory answers and the user is no longer in an allowed group: the
 *   session is dropped and the next request lands on the login form.
 * - The directory answers and the user is still entitled: the group list is
 *   refreshed, so a later narrowing of `allowedGroups` is judged on current
 *   membership.
 * - The directory does not answer: the session is KEPT. A domain controller
 *   that is unreachable for a minute must not empty every protected site at
 *   once, and an operator who wants someone out now has the Protect switch and
 *   `dropSessions`, both of which are immediate.
 *
 * `revalidateMinutes: 0` turns this off. A `userDnTemplate`-only directory has
 * no service account to ask with, so `ldap.lookup` refuses and every attempt
 * takes the third branch; that configuration keeps the old behaviour.
 *
 * Reads only. A write does not wait for the timer: see `recheckWrite`.
 */
function maybeRevalidate(session, token, ctx, config) {
    if (!recheckable(session, config)) return;
    if (session.revalidating) return;
    if (Date.now() < (session.nextCheckAt || 0)) return;
    revalidate(session, token, ctx, config);
}

function revalidateEveryMs(config) {
    const everyMs = Number(config && config.revalidateMinutes) * 60 * 1000;
    return Number.isFinite(everyMs) && everyMs > 0 ? everyMs : 0;
}

/**
 * Whether the directory can be asked about this session at all. Off when the
 * operator set `revalidateMinutes: 0`; off for a session minted before
 * usernames were stored, which has nobody to ask about.
 */
function recheckable(session, config) {
    return revalidateEveryMs(config) > 0 && !!session.username;
}

/**
 * Whether a write waits for the directory before it is let through.
 *
 * A read trusts the group list for up to one interval, because blocking every
 * page load on a domain controller is too high a price for a rare change. A
 * write is the other way round: it is what a removed user could still do harm
 * with, and it is rare enough that one directory round trip on it costs little.
 * So a write asks first, whatever `nextCheckAt` says, and three answers follow:
 *
 * - `kept`: still entitled, the write goes on with the refreshed list.
 * - `refused`: no longer entitled, or closed meanwhile by an administrator.
 *   The session is dropped and the write answers 403.
 * - `unanswered`: the directory could not say. The write answers 503 and is
 *   not proxied; the session is KEPT, so reads go on as `maybeRevalidate`
 *   describes and the write can be tried again.
 * - The directory answers that the account no longer exists
 *   (`ldap_user_not_found`): that is a verdict, not a silence, so it is
 *   `refused` too. Only here: on the read timer it stays "no answer", so a
 *   filter mistake cannot empty a site in the background.
 *
 * `revalidateMinutes: 0` turns off the read timer and nothing else: writes are
 * still checked. The one exemption is a directory `ldap.lookup` refuses before
 * opening a socket (`writesRecheckable`): failing closed there would forbid
 * every write on the site for good, which is a configuration fault and not a
 * verdict. The Authentication panel warns about it (`writeRecheck: false`).
 */
function recheckWrite(session, token, ctx, config) {
    if (!session.username || !writesRecheckable(config)) return Promise.resolve('kept');
    return revalidate(session, token, ctx, config).then((outcome) => {
        if (outcome === 'missing') {
            sessions.delete(token);
            console.warn(`[Deploy] ${ctx.slug}/${ctx.projectId}: session dropped for ${session.username} (account not found in the directory)`);
            return 'refused';
        }
        return sessions.get(token) === session ? outcome : 'refused';
    });
}

/**
 * Whether `ldap.lookup` can run on this configuration at all. The same
 * preconditions it checks: a base DN, a user filter, and either a bind DN with
 * its password or no bind DN, which is an anonymous search. A bind DN with no
 * password is refused before any socket opens, so nothing can ever answer.
 */
function writesRecheckable(config) {
    if (!config || !String(config.baseDn || '').trim() || !String(config.userFilter || '').trim()) return false;
    const bindDn = String(config.bindDn || '').trim();
    const bindPassword = config.bindPassword === undefined || config.bindPassword === null ? '' : String(config.bindPassword);
    return !(bindDn && !bindPassword);
}

/**
 * One question to the directory about one session. Resolves `kept`, `refused`,
 * `missing` (the directory says the account does not exist; the session is not
 * touched here) or `unanswered`, and never rejects. At most one is in flight
 * per session: a second caller gets the promise already running.
 */
function revalidate(session, token, ctx, config) {
    if (session.revalidating) return session.revalidating;
    const everyMs = revalidateEveryMs(config);
    const retryMs = everyMs > 0 ? Math.min(everyMs, REVALIDATE_RETRY_MS) : REVALIDATE_RETRY_MS;

    const running = Promise.resolve()
        .then(() => lookup(config, session.username))
        .then((result) => {
            if (!result || result.ok !== true) {
                session.nextCheckAt = Date.now() + retryMs;
                return result && result.error === 'ldap_user_not_found' ? 'missing' : 'unanswered';
            }
            const groups = Array.isArray(result.groups) ? result.groups : [];
            // `lookup` searches rather than binding, so it reads the entry and
            // its SID directly. Falling back to the session's own SID keeps a
            // session minted before this field existed from being dropped for
            // having no identity to re-check.
            const sid = String(result.sid || session.sid || '');
            const verdict = accessFor(
                allowedGroupsFor(ctx.slug, ctx.tenantPaths, ctx.projectId),
                allowedUsersFor(ctx.slug, ctx.tenantPaths, ctx.projectId),
                audienceFor(ctx.slug, ctx.tenantPaths, ctx.projectId),
                groups, sid);
            if (!verdict.allowed) {
                sessions.delete(token);
                console.warn(`[Deploy] ${ctx.slug}/${ctx.projectId}: session dropped for ${session.username} (no longer allowed)`);
                return 'refused';
            }
            session.groups = groups;
            session.sid = sid;
            session.login = String(result.login || session.login || session.username || '');
            // Demotion takes effect on the same timer as removal. An operator
            // who unticks Administrator has said something about now, not about
            // the next eight hours.
            session.admin = verdict.admin;
            session.nextCheckAt = Date.now() + everyMs;
            return 'kept';
        })
        .catch(() => {
            session.nextCheckAt = Date.now() + retryMs;
            return 'unanswered';
        })
        .then((outcome) => { session.revalidating = null; return outcome; });
    session.revalidating = running;
    return running;
}

/** Drops every session of a project, or of a whole tenant. Used on delete. */
function dropSessions(slug, projectId) {
    for (const [token, s] of sessions) {
        if (s.slug === slug && (!projectId || s.projectId === projectId)) sessions.delete(token);
    }
}

module.exports = {
    gate, identityFor, isProtected, invalidate, dropSessions, dropFailures,
    listSessions, dropSessionsFor, normalizeUser, writesRecheckable, IDLE_MS,
    PREFIX, LOGIN_PATH, WHOAMI_PATH, SESSION_COOKIE, LOCK_THRESHOLD, LOCK_MS,
    RELEASE_PATH, RELEASE_SWITCH_PATH, isReleasePath, isSitePath, safeNext, readCookie, pickLang,
    // Test seams. Not part of the contract's public surface; nothing outside
    // tests/siteAuth.test.js should reach for them.
    _setVerifier, _setLookup,
    _escapeHtml: escapeHtml,
    _safeNext: safeNext,
    _groupAllowed: groupAllowed,
    _accessFor: accessFor,
    _findUser: findUser,
    _firstCn: firstCn,
    _lockRemaining: lockRemaining,
    _noteFailure: noteFailure,
    _clearFailures: clearFailures,
    _pickLang: pickLang,
    _renderLogin: renderLogin
};
