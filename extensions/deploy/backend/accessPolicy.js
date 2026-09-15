/**
 * Which paths of a deployed site are private, and under what name.
 *
 * The repository owns the vocabulary and Aegis owns the binding. A site
 * declares `aegis.access.json` naming the paths it wants closed and the
 * resource each one needs; an operator binds that resource to directory groups
 * and people in the Authentication tab. Aegis never invents a resource name, so
 * an application that adds a permission changes the application and not Aegis.
 * That division is the whole point: an access panel per deployed application
 * would live here and be edited here every time an application changed its mind
 * about roles.
 *
 * There is deliberately no list of declared resources in the file. The
 * vocabulary is the set of `require` values, and a typo names a resource nobody
 * is bound to, which closes that path. A declaration list would only catch a
 * mistake that already fails towards a locked door.
 *
 * This module decides. It holds no session, reads no directory and caches
 * nothing; `siteAuth` owns all three.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = 'aegis.access.json';
/** Enough for any site, small enough that a generated file cannot flood the gate. */
const MAX_RULES = 200;
const MAX_NAME = 128;

const EMPTY = { ok: true, rules: [], resources: [], error: null };

/** `/admin/*`, `/admin/(.*)` and `/admin/:path*` all mean the same prefix. */
function compile(source) {
    const s = String(source || '').toLowerCase();
    for (const suffix of ['/*', '/(.*)', '/:path*']) {
        if (s.endsWith(suffix)) return { prefix: s.slice(0, -suffix.length), wildcard: true };
    }
    return { prefix: s, wildcard: false };
}

function bad(error) {
    return { ok: false, rules: [], resources: [], error };
}

/**
 * The manifest as the gate will use it, or the reason it was refused.
 *
 * `null` means no file, which is a site with no policy rather than a fault:
 * every site deployed before this existed carries no manifest and has to keep
 * serving exactly as it did.
 */
function parse(raw) {
    if (raw === null || raw === undefined) return EMPTY;

    let doc;
    try {
        doc = JSON.parse(String(raw));
    } catch (e) {
        return bad(`${CONFIG_FILE} does not parse as JSON: ${e.message}`);
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        return bad(`${CONFIG_FILE} must hold a JSON object`);
    }
    if (doc.version !== undefined && doc.version !== 1) {
        return bad(`${CONFIG_FILE} declares version ${doc.version}, and this Aegis serves version 1`);
    }

    const raws = doc.rules === undefined ? [] : doc.rules;
    if (!Array.isArray(raws)) return bad(`${CONFIG_FILE}: rules must be an array`);
    if (raws.length > MAX_RULES) {
        return bad(`${CONFIG_FILE}: ${raws.length} rules, and the cap is ${MAX_RULES}`);
    }

    const rules = [];
    const resources = [];
    for (let i = 0; i < raws.length; i++) {
        const r = raws[i];
        if (!r || typeof r !== 'object') return bad(`${CONFIG_FILE}: rule ${i} is not an object`);

        const p = typeof r.path === 'string' ? r.path.trim() : '';
        const need = typeof r.require === 'string' ? r.require.trim() : '';
        if (!p) return bad(`${CONFIG_FILE}: rule ${i} has no path`);
        if (!need) return bad(`${CONFIG_FILE}: rule ${i} has no require`);
        if (!p.startsWith('/')) return bad(`${CONFIG_FILE}: rule ${i} path must start with /`);
        if (p.length > MAX_NAME || need.length > MAX_NAME) {
            return bad(`${CONFIG_FILE}: rule ${i} is longer than ${MAX_NAME} characters`);
        }

        rules.push({ path: p, require: need, compiled: compile(p) });
        if (!resources.includes(need)) resources.push(need);
    }
    return { ok: true, rules, resources, error: null };
}

/** Reads the manifest out of a served directory. Absent is not an error. */
function read(root) {
    let raw = null;
    try {
        raw = fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8');
    } catch (_) {
        return EMPTY;            // no file: no policy
    }
    return parse(raw);
}

/**
 * The request path as the file server will understand it.
 *
 * `gate` is handed the raw request target, while the resolver percent-decodes
 * each segment and `path.resolve`s them on a case-insensitive filesystem.
 * Comparing a rule against the raw target lets `/ADMIN/x`, `/%61dmin/x` and
 * `/public/../admin/x` walk past a rule written for `/admin/*`. Measured rather
 * than assumed: without this function 7 of the 27 cases in
 * `tests/accessPolicy.test.js` are allowed and every one of them must not be.
 *
 * Returns `null` for a target that cannot be decoded. The resolver refuses that
 * request anyway, and a policy that guessed at what it meant would be guessing
 * in the direction of letting it through.
 */
function normalisePath(rawUrl) {
    const raw = String(rawUrl === null || rawUrl === undefined ? '/' : rawUrl)
        .split('?')[0].split('#')[0];
    const out = [];
    for (const seg of raw.split('/')) {
        if (seg === '' || seg === '.') continue;
        let decoded;
        try {
            decoded = decodeURIComponent(seg);
        } catch (_) {
            return null;
        }
        // An encoded slash decodes into a separator the resolver honours, so one
        // segment can become several.
        for (const part of decoded.split('/')) {
            if (part === '' || part === '.') continue;
            if (part === '..') { out.pop(); continue; }
            out.push(part);
        }
    }
    return '/' + out.join('/').toLowerCase();
}

/** The fallback when no caller supplies one: the name, spelled the same way. */
function exactGroupMatch(wanted, have) {
    return wanted.some(
        (g) => have.some((h) => String(h).toLowerCase() === String(g).toLowerCase()));
}

/**
 * May this visitor have this path.
 *
 * Every rule whose path matches has to be satisfied, so deny wins and holding
 * one resource never opens a path that needs another. A resource nobody is
 * bound to is closed rather than open, which is what makes a typo in the
 * manifest lock a door instead of publishing one.
 *
 * `groupMatches` is handed in rather than written here, and `siteAuth` passes
 * the same `groupAllowed` that decides who may open the site at all. A
 * directory answers group membership as full distinguished names while an
 * operator types a plain name, so the two have to agree about what counts as a
 * match. Two implementations of that rule would agree until one of them was
 * improved. The fallback is an exact comparison, which is what a caller that
 * supplies nothing should get: narrower, never wider.
 */
function verdict({ rules, grants, groups, sid, rawUrl, groupMatches }) {
    const groupsMatch = typeof groupMatches === 'function' ? groupMatches : exactGroupMatch;
    const pathname = normalisePath(rawUrl);
    if (pathname === null) return { allowed: false, resource: null };

    for (const rule of rules || []) {
        const c = rule.compiled;
        const hit = c.wildcard
            ? (pathname === c.prefix || pathname.startsWith(c.prefix + '/'))
            : pathname === c.prefix;
        if (!hit) continue;

        const grant = (grants || {})[rule.require];
        if (!grant) return { allowed: false, resource: rule.require };

        const bySid = Boolean(sid) && (grant.users || []).some(
            (u) => u && u.sid && String(u.sid).toUpperCase() === String(sid).toUpperCase());

        if (!bySid && !groupsMatch(grant.groups || [], groups || [])) {
            return { allowed: false, resource: rule.require };
        }
    }
    return { allowed: true, resource: null };
}

module.exports = {
    parse, read, verdict, normalisePath,
    CONFIG_FILE, MAX_RULES,
    // Test seam only; nothing outside tests/accessPolicy.test.js should use it.
    _compile: compile
};
