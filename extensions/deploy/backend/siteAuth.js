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
 * - The session cookie is `Secure` only on a site that is actually served over
 *   TLS, and the flag is read from the socket rather than from configuration.
 *   Setting it on a plain-HTTP site would not harden anything: the browser
 *   would never send the cookie back and login would stop working. A site
 *   without TLS therefore still sends its credentials and its session token in
 *   clear, and the honest description of it is "keeps colleagues out", not
 *   "secure". `project.tls` in `siteServer.js` is how a site stops being that.
 * - Cookies are scoped by host, not by port. Two protected sites on the same
 *   machine share the `aegis_site` cookie name, so logging into the second one
 *   replaces the session of the first. The session record stores the slug and
 *   project id and is rejected when they do not match, so this is a nuisance
 *   (re-login) and not a way into another site.
 * - The client address comes from the socket. No `X-Forwarded-For` is trusted,
 *   because nothing forwards to this port; behind a reverse proxy every lockout
 *   counter would collapse onto the proxy's address.
 * - Group membership is re-checked on a timer, not on every request, so a user
 *   removed from the allowed group keeps access for up to `revalidateMinutes`.
 *   See `maybeRevalidate` for why the check does not block the request, and for
 *   the one configuration shape it cannot run under.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectStore = require('./projectStore');
const authStore = require('./authStore');
const authMethods = require('./authMethods');

/** Everything under here belongs to the guard and never to the site. */
const PREFIX = '/__aegis/';
const LOGIN_PATH = '/__aegis/login';
const LOGOUT_PATH = '/__aegis/logout';
const CSS_PATH = '/__aegis/login.css';

const SESSION_COOKIE = 'aegis_site';
const CSRF_COOKIE = 'aegis_site_csrf';
const SESSION_MS = 8 * 60 * 60 * 1000;

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
/** `slug` -> { at, config }. `config` is null when the tenant has none. */
const configCache = new Map();

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
        return;
    }
    for (const k of Array.from(projectCache.keys())) {
        if (k.startsWith(`${slug}/`)) projectCache.delete(k);
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
 * Empty `allowedGroups` on an enabled project means "anyone the directory
 * authenticates", which is a deliberate and documented setting, not an
 * accident: it is how you protect a site from the internet at large without
 * maintaining a group for it.
 */
function groupAllowed(allowedGroups, groups) {
    const wanted = (allowedGroups || []).map(normalizeGroup).filter(Boolean);
    if (!wanted.length) return true;

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

/** token -> { slug, projectId, username, user, groups, expiresAt, nextCheckAt }
 *  `username` is what was typed at the form and is what the directory is asked
 *  about again later; `user` is the display name and is only ever printed. */
const sessions = new Map();
/** `ip|projectId` -> { fails, until } */
const failures = new Map();

function newToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function purgeSessions(now) {
    for (const [token, s] of sessions) {
        if (s.expiresAt <= now) sessions.delete(token);
    }
}

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
        errCredentials: 'Incorrect username or password.',
        errPasswordExpired: 'Your password has expired. Change it, then sign in again.',
        errPasswordMustChange: 'Your password must be changed before you can sign in.',
        errAccountDisabled: 'This account is disabled. Ask your administrator.',
        errAccountLocked: 'This account is locked. Try again later, or ask your administrator.',
        errAccountExpired: 'This account has expired. Ask your administrator.',
        errLogonDenied: 'This account cannot sign in at the moment.',
        errForbidden: 'Your account is not allowed to open this site.',
        errDirectory: 'The directory could not be reached. Try again later.',
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
        errCredentials: 'Identifiant ou mot de passe incorrect.',
        errPasswordExpired: 'Votre mot de passe a expiré. Changez-le, puis reconnectez-vous.',
        errPasswordMustChange: 'Votre mot de passe doit être changé avant la connexion.',
        errAccountDisabled: 'Ce compte est désactivé. Voyez avec votre administrateur.',
        errAccountLocked: 'Ce compte est verrouillé. Réessayez plus tard, ou voyez avec votre administrateur.',
        errAccountExpired: 'Ce compte a expiré. Voyez avec votre administrateur.',
        errLogonDenied: 'Ce compte ne peut pas se connecter en ce moment.',
        errForbidden: 'Votre compte n\'est pas autorisé à ouvrir ce site.',
        errDirectory: 'L\'annuaire est injoignable. Réessayez plus tard.',
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

/** The template and the stylesheet, re-read when they change on disk. */
const fileCache = new Map();

function readPageFile(name) {
    const file = path.join(PAGE_DIR, name);
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch (_) { return null; }
    const hit = fileCache.get(name);
    if (hit && hit.mtime === mtime) return hit.body;
    let body;
    try { body = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
    fileCache.set(name, { mtime, body });
    return body;
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
        + '</section>\n</main>\n</body>\n</html>\n';
}

function sendHtml(res, status, body, extraHeaders) {
    const headers = Object.assign({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        // The login page loads its own stylesheet and posts to its own origin.
        // Nothing else, so nothing else is allowed.
        'Content-Security-Policy': "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
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

function serveCss(res) {
    const body = readPageFile('login.css');
    if (body === null) return sendHtml(res, 500, 'stylesheet missing');
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(200, {
        'Content-Type': 'text/css; charset=utf-8',
        'Content-Length': buf.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
    });
    res.end(buf);
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
    return sendHtml(res, status, body, { 'Set-Cookie': csrfCookie(csrf, ctx.secure === true) });
}

/**
 * Intercepts a request to a deployed site.
 *
 * Returns true when the request is finished and the caller must not serve
 * anything, false when it is authenticated and the file server should proceed.
 * Returns a promise on the POST path only; the caller handles both.
 */
function gate(req, res, { slug, tenantPaths, project }) {
    const projectId = project && project.id;
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
        // The prefix is reserved even here, so that turning protection on later
        // cannot be shadowed by a file the repository already contains.
        if (reserved) { notFound(res); return true; }
        return false;
    }

    const lang = pickLang(req);
    const ctx = { slug, tenantPaths, projectId, siteName, lang, secure: isSecure(req) };

    // Served before the directory is consulted: it carries nothing, and the
    // refusal page below needs it to be legible.
    if (pathOnly === CSS_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
        serveCss(res);
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

    if (reserved) { notFound(res); return true; }

    if (session) {
        // Fires at most once per interval and never blocks: see maybeRevalidate.
        maybeRevalidate(session, token, ctx, config);
        return false;            // authenticated: the file server takes over
    }

    // Everything else on a protected site: send them to the form, remembering
    // where they were headed.
    redirect(res, `${LOGIN_PATH}?next=${encodeURIComponent(safeNext(req.url || '/'))}`);
    return true;
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
        const body = renderLogin({
            lang: ctx.lang, siteName: ctx.siteName, next,
            error: tr(ctx.lang, 'errLocked', locked), csrf: newToken(), username
        });
        sendHtml(res, 429, body === null ? 'Too many attempts' : body, { 'Retry-After': String(locked) });
        return true;
    }

    // Double submit: a form posted from another origin cannot read the cookie,
    // so it cannot produce a matching field. Counted as a failure like any
    // other, because a real user never trips it twice.
    if (!sentCsrf || !cookieCsrf || sentCsrf !== cookieCsrf) {
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
    if (!groupAllowed(allowedGroupsFor(ctx.slug, ctx.tenantPaths, ctx.projectId), groups)) {
        // Authenticated but not entitled. Counted, because group probing is a
        // way of enumerating accounts.
        noteFailure(ip, ctx.projectId);
        console.warn(`[Deploy] ${ctx.slug}/${ctx.projectId}: login refused for ${username} (group_not_allowed)`);
        loginPage(res, 403, ctx, { next, error: tr(ctx.lang, 'errForbidden'), username });
        return true;
    }

    clearFailures(ip, ctx.projectId);
    const token = newToken();
    const everyMs = Number(config && config.revalidateMinutes) * 60 * 1000;
    sessions.set(token, {
        slug: ctx.slug,
        projectId: ctx.projectId,
        username,
        user: result.displayName || username,
        groups,
        expiresAt: Date.now() + SESSION_MS,
        // Just checked, by the login itself. The first re-check is a full
        // interval away rather than on the next request.
        nextCheckAt: everyMs > 0 ? Date.now() + everyMs : Infinity
    });
    console.log(`[Deploy] ${ctx.slug}/${ctx.projectId}: site login by ${username}`);
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
 */
function maybeRevalidate(session, token, ctx, config) {
    const everyMs = Number(config && config.revalidateMinutes) * 60 * 1000;
    if (!Number.isFinite(everyMs) || everyMs <= 0) return;
    // A session minted before this code existed has no username to ask about.
    if (!session.username || session.revalidating) return;
    if (Date.now() < (session.nextCheckAt || 0)) return;

    session.revalidating = true;
    Promise.resolve()
        .then(() => lookup(config, session.username))
        .then((result) => {
            if (!result || result.ok !== true) {
                session.nextCheckAt = Date.now() + Math.min(everyMs, REVALIDATE_RETRY_MS);
                return;
            }
            const groups = Array.isArray(result.groups) ? result.groups : [];
            const allowed = allowedGroupsFor(ctx.slug, ctx.tenantPaths, ctx.projectId);
            if (!groupAllowed(allowed, groups)) {
                sessions.delete(token);
                console.warn(`[Deploy] ${ctx.slug}/${ctx.projectId}: session dropped for ${session.username} (no longer in an allowed group)`);
                return;
            }
            session.groups = groups;
            session.nextCheckAt = Date.now() + everyMs;
        })
        .catch(() => {
            session.nextCheckAt = Date.now() + Math.min(everyMs, REVALIDATE_RETRY_MS);
        })
        .then(() => { session.revalidating = false; });
}

/** Drops every session of a project, or of a whole tenant. Used on delete. */
function dropSessions(slug, projectId) {
    for (const [token, s] of sessions) {
        if (s.slug === slug && (!projectId || s.projectId === projectId)) sessions.delete(token);
    }
}

module.exports = {
    gate, isProtected, invalidate, dropSessions, dropFailures,
    PREFIX, LOGIN_PATH, SESSION_COOKIE, LOCK_THRESHOLD, LOCK_MS,
    // Test seams. Not part of the contract's public surface; nothing outside
    // tests/siteAuth.test.js should reach for them.
    _setVerifier, _setLookup,
    _escapeHtml: escapeHtml,
    _safeNext: safeNext,
    _groupAllowed: groupAllowed,
    _firstCn: firstCn,
    _lockRemaining: lockRemaining,
    _noteFailure: noteFailure,
    _clearFailures: clearFailures,
    _pickLang: pickLang,
    _renderLogin: renderLogin
};
