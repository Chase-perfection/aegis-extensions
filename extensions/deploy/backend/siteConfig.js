/**
 * What a repository can say about how its files are served: `vercel.json`.
 *
 * Reading the file Vercel already defines, rather than inventing a second
 * format, because the repositories being deployed here are the ones that were
 * on Vercel or could be. A project that already has the file gets its redirects
 * and headers honoured with nothing to write.
 *
 * Five keys are honoured: `cleanUrls`, `trailingSlash`, `redirects`, `rewrites`,
 * `headers`. Everything else in the file is a service Aegis does not run --
 * functions, crons, regions -- and is reported on the deployment by name
 * (`unsupported`) rather than dropped in silence. Silently ignoring half a
 * config file is how someone spends an afternoon on a rewrite that was never
 * read.
 *
 * Source patterns are the subset that covers what people write: an exact path,
 * or a path with a trailing wildcard. `path-to-regexp` named segments
 * (`/blog/:slug`) are named as unsupported instead of being half-implemented,
 * which would be worse than refusing them.
 *
 * The two invariants that make this safe to read from a repository:
 *
 * Nothing here touches the filesystem. `resolveRequest` is handed a resolver by
 * the site server and every path, including a rewrite destination the repository
 * wrote, goes through it. That resolver is `siteServer.resolveFile`, which
 * refuses anything outside the site.
 *
 * And a header the repository sets cannot switch off a protection this server
 * relies on. `X-Content-Type-Options` is the one that matters: the bytes come
 * from a repository, so a mistyped extension must not let the browser guess
 * something executable.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const projectStore = require('./projectStore');

const CONFIG_FILE = 'vercel.json';

/** Read at most this much. A config file is small; a 200 MB one is an attack. */
const MAX_CONFIG_BYTES = 256 * 1024;

/** Keys this module honours. Anything else in the file is reported by name. */
const HONOURED = ['cleanUrls', 'trailingSlash', 'redirects', 'rewrites', 'headers'];

/**
 * Response headers a repository may not set.
 *
 * `x-content-type-options` is a protection this server depends on, and the
 * other three are the transport's own: a config file that sets
 * `content-length` or `transfer-encoding` produces a response the client cannot
 * read at all.
 */
const HEADER_DENY = new Set(['x-content-type-options', 'content-length', 'transfer-encoding', 'connection']);

/** Caps, so one project's config cannot make every request expensive. */
const MAX_RULES = 100;
const MAX_HEADERS_PER_RULE = 20;

/**
 * How long a config is trusted from cache.
 *
 * Same five seconds as `siteAuth`, for the same reason: a publish swaps the
 * whole folder under a running listener, so the file on disk changes without
 * anything calling in here.
 */
const CACHE_MS = 5000;

/** The three wildcard spellings people use for "everything below this". */
const WILDCARDS = ['/(.*)', '/:path*', '/*'];

function refuse(code, message) {
    return Object.assign(new Error(message), { code });
}

/**
 * Splits a source pattern into a prefix and whether it is a wildcard.
 *
 * Returns null for a pattern outside the subset, which is what puts it in
 * `unsupported` at parse time rather than failing at request time.
 */
function compile(source) {
    if (typeof source !== 'string' || !source.startsWith('/')) return null;

    for (const suffix of WILDCARDS) {
        if (source.endsWith(suffix)) {
            const prefix = source.slice(0, -suffix.length);
            // `/(.*)` on its own: the prefix is empty and everything matches.
            if (prefix.includes(':') || prefix.includes('*') || prefix.includes('(')) return null;
            return { prefix, wildcard: true };
        }
    }
    if (source.includes(':') || source.includes('*') || source.includes('(')) return null;
    return { prefix: source, wildcard: false };
}

/**
 * Whether `pathname` matches `source`, and what the wildcard captured.
 *
 * Exported for the tests and for nothing else: the rules carry their compiled
 * form after `parse`, so the request path does not re-split a string per rule
 * per request.
 */
function match(source, pathname) {
    const compiled = compile(source);
    return compiled ? matchCompiled(compiled, pathname) : null;
}

function matchCompiled(compiled, pathname) {
    if (!compiled.wildcard) {
        return compiled.prefix === pathname ? { rest: '' } : null;
    }
    if (pathname === compiled.prefix) return { rest: '' };
    const prefix = compiled.prefix + '/';
    if (!pathname.startsWith(prefix)) return null;
    return { rest: pathname.slice(prefix.length) };
}

/** `$1`, `:path*` and `:splat` all stand for what the wildcard captured. */
function substitute(destination, rest) {
    return String(destination)
        .replace(/\$1/g, rest)
        .replace(/:path\*/g, rest)
        .replace(/:splat/g, rest);
}

function parseRules(raw, kind, unsupported) {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
        throw refuse('bad_site_config', `${kind} is not a list`);
    }
    const out = [];
    for (const rule of raw.slice(0, MAX_RULES)) {
        if (!rule || typeof rule !== 'object') continue;
        const compiled = compile(rule.source);
        if (!compiled) {
            unsupported.push(`${kind}: ${String(rule.source)}`);
            continue;
        }
        if (kind === 'headers') {
            const headers = Array.isArray(rule.headers) ? rule.headers : [];
            out.push({
                compiled,
                headers: headers.slice(0, MAX_HEADERS_PER_RULE)
                    .filter((h) => h && typeof h.key === 'string' && typeof h.value === 'string')
                    .filter((h) => !HEADER_DENY.has(h.key.toLowerCase()))
                    .map((h) => ({ key: h.key, value: h.value }))
            });
            continue;
        }
        if (typeof rule.destination !== 'string') {
            unsupported.push(`${kind}: ${String(rule.source)}`);
            continue;
        }
        out.push({
            compiled,
            destination: rule.destination,
            // Vercel's default is a permanent redirect, and `permanent: false`
            // is how a config asks for a temporary one. An explicit
            // `statusCode` wins over both.
            status: Number(rule.statusCode) || (rule.permanent === false ? 307 : 308)
        });
    }
    return out;
}

/** The honoured subset of a parsed `vercel.json`, plus what was left out. */
function parse(raw) {
    const unsupported = [];
    const source = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};

    for (const key of Object.keys(source)) {
        if (!HONOURED.includes(key)) unsupported.push(key);
    }

    return {
        cleanUrls: source.cleanUrls === true,
        // Three states, not two: a file that says nothing about trailing
        // slashes must not have one chosen for it.
        trailingSlash: typeof source.trailingSlash === 'boolean' ? source.trailingSlash : null,
        redirects: parseRules(source.redirects, 'redirects', unsupported),
        rewrites: parseRules(source.rewrites, 'rewrites', unsupported),
        headers: parseRules(source.headers, 'headers', unsupported),
        unsupported
    };
}

/**
 * Reads `vercel.json` from a served directory.
 *
 * A file that will not parse throws `bad_site_config`, which refuses the
 * deployment. The alternative is serving a site whose config was ignored, and
 * an operator cannot see that from the outside.
 */
function read(root) {
    const file = path.join(root, CONFIG_FILE);
    let text;
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) return parse(null);
        if (stat.size > MAX_CONFIG_BYTES) {
            throw refuse('bad_site_config', `${CONFIG_FILE} is larger than ${MAX_CONFIG_BYTES} bytes`);
        }
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e.code === 'bad_site_config') throw e;
        return parse(null);          // no file is the normal case
    }

    let raw;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        throw refuse('bad_site_config', `${CONFIG_FILE} is not valid JSON: ${e.message}`);
    }
    return parse(raw);
}

/* ------------------------------------------------------------------ */
/* caches                                                             */
/* ------------------------------------------------------------------ */

/** `root` -> { at, config }. Keyed by path because that is what a request has. */
const configCache = new Map();
/** `slug/projectId` -> { at, settings }. */
const settingsCache = new Map();

function configFor(root) {
    const hit = configCache.get(root);
    if (hit && (Date.now() - hit.at) < CACHE_MS) return hit.config;

    let config;
    try {
        config = read(root);
    } catch (_) {
        // A config file that stopped parsing between the publish that accepted
        // it and now: serve the files rather than take the site down.
        config = parse(null);
    }
    configCache.set(root, { at: Date.now(), config });
    return config;
}

/** The project's own switches, read from the record. Today: the fallback. */
function settingsFor(slug, tenantPaths, projectId) {
    const k = `${slug}/${projectId}`;
    const hit = settingsCache.get(k);
    if (hit && (Date.now() - hit.at) < CACHE_MS) return hit.settings;

    let settings = { spaFallback: false };
    try {
        const project = projectStore.getProject(tenantPaths, projectId);
        settings = { spaFallback: !!(project && project.spaFallback) };
    } catch (_) { /* unreadable record: the default is off */ }
    settingsCache.set(k, { at: Date.now(), settings });
    return settings;
}

/** Forgets one project, or a whole tenant when `projectId` is null. */
function invalidate(slug, projectId) {
    if (projectId) {
        settingsCache.delete(`${slug}/${projectId}`);
        return;
    }
    for (const k of Array.from(settingsCache.keys())) {
        if (k.startsWith(`${slug}/`)) settingsCache.delete(k);
    }
}

/** Forgets a served directory's config. Called when a project is deleted. */
function forgetRoot(root) {
    configCache.delete(root);
}

/* ------------------------------------------------------------------ */
/* one request                                                        */
/* ------------------------------------------------------------------ */

/** Whether the last segment looks like a file rather than a directory. */
function looksLikeFile(pathname) {
    const last = pathname.split('/').pop();
    return last.includes('.');
}

/**
 * What to answer for one path: a redirect, a file, or nothing.
 *
 * The order is Vercel's. Redirects first, because a redirect is about the URL
 * and not about what is on disk. Then the trailing-slash rule, which is a
 * redirect the config asked for without writing one. Then the filesystem. Then
 * rewrites, which exist precisely for the paths the filesystem could not
 * answer. The fallback is last, and it answers only for a path that could be a
 * route: a missing `/assets/app.js` returning HTML is a page that fails with a
 * syntax error rather than a missing file.
 *
 * `resolve` takes a path and returns a file to serve or null. Every path in
 * here, including one a repository wrote, goes through it.
 */
function resolveRequest({ pathname, config, resolve, spaFallback }) {
    const conf = config || parse(null);

    for (const rule of conf.redirects) {
        const hit = matchCompiled(rule.compiled, pathname);
        if (hit) {
            return { kind: 'redirect', status: rule.status, location: substitute(rule.destination, hit.rest) };
        }
    }

    if (conf.trailingSlash === false && pathname.length > 1 && pathname.endsWith('/')) {
        return { kind: 'redirect', status: 308, location: pathname.replace(/\/+$/, '') };
    }
    if (conf.trailingSlash === true && pathname.length > 1 && !pathname.endsWith('/') && !looksLikeFile(pathname)) {
        return { kind: 'redirect', status: 308, location: pathname + '/' };
    }

    let file = resolve(pathname);
    if (!file && conf.cleanUrls && pathname.length > 1 && !looksLikeFile(pathname)) {
        file = resolve(pathname.replace(/\/+$/, '') + '.html');
    }

    if (!file) {
        for (const rule of conf.rewrites) {
            const hit = matchCompiled(rule.compiled, pathname);
            if (!hit) continue;
            file = resolve(substitute(rule.destination, hit.rest));
            if (file) break;
        }
    }

    if (!file && spaFallback && !looksLikeFile(pathname)) {
        file = resolve('/index.html');
    }

    if (!file) return { kind: 'none' };

    const headers = {};
    for (const rule of conf.headers) {
        if (!matchCompiled(rule.compiled, pathname)) continue;
        for (const h of rule.headers) headers[h.key] = h.value;
    }
    return { kind: 'file', file, headers };
}

module.exports = {
    parse, read, match, resolveRequest,
    configFor, settingsFor, invalidate, forgetRoot,
    CONFIG_FILE, HONOURED, HEADER_DENY
};
