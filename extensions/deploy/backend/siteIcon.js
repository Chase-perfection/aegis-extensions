/**
 * The deployed site's own icon, for the corner of its login page.
 *
 * The login page is the guard's, but the visitor came for the site, so the top
 * left corner shows the site's favicon: the same mark the browser tab shows once
 * they are in. It is served at `/__aegis/site-icon` BEFORE the visitor signs in,
 * which is the one thing this file has to be careful about. A request that has
 * not been authenticated is reading a file out of a protected site, so:
 *
 * - Only an image leaves. The extension decides the content type and it must be
 *   one of `TYPES`; a link tag pointing at `/.env` or `server.js` is ignored.
 * - Only a file inside the site leaves. Containment is checked on the real path,
 *   after every symlink and junction is resolved, because `path.resolve` alone
 *   happily follows a link committed to the repository out of the tree.
 * - Only a small file leaves. A favicon is a few kilobytes; `MAX_BYTES` keeps a
 *   misnamed archive from being streamed to anyone who asks.
 * - The response carries `sandbox` in its CSP. An SVG opened directly as a
 *   document could otherwise run script on the site's origin; inside the
 *   page's `<img>` it never can.
 *
 * What remains public is the icon itself, which is the point.
 *
 * Where it is looked for, in order: what `index.html` declares at the root or in
 * a public folder; what the site's other pages declare, wherever they sit, for a
 * project served by a process whose pages are not at the root; a conventional
 * name. The dashboard card shows the same icon through its own route.
 *
 * No icon found is not an error: the answer is a monogram, the first letter of
 * the site name on an ink tile, so the page never shows a broken image and the
 * template needs no second element to hide.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TYPES = {
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.gif': 'image/gif',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp'
};

const MAX_BYTES = 512 * 1024;

/** The icon link sits in `<head>`. Reading further only costs time. */
const HTML_SCAN_BYTES = 64 * 1024;

/**
 * Where a site's entry page and its icon usually sit. The root first, which is
 * every static build; then the folders a server-rendered project keeps its
 * public files in, since for those `current/` is the source tree.
 */
const DIRS = ['', 'public', 'static', 'assets'];
const NAMES = ['favicon.svg', 'favicon.png', 'favicon.ico', 'apple-touch-icon.png'];

/**
 * The conventional names are also looked for where an application framework
 * keeps them outside a public folder: `app/favicon.ico` and `app/icon.png` are
 * how a Next.js App Router project declares its icon, with no link tag at all.
 */
const NAME_DIRS = DIRS.concat(['app', 'src/app', 'src', 'www']);
const APP_NAMES = ['icon.svg', 'icon.png', 'icon.ico'];

/**
 * The pages of a site served by a process are wherever its code reads them
 * from, which no fixed list of folders covers: `web/`, `client/`, a folder named
 * after the product. So the tree is walked for HTML files, within these bounds,
 * and skipping what is never a page of the site: dependencies, version control,
 * caches. A name starting with a dot is skipped as well.
 */
const SCAN_DEPTH = 3;
const SCAN_DIRS = 400;
const SCAN_PAGES = 200;
const SKIP_DIRS = new Set([
    'node_modules', 'bower_components', 'jspm_packages', 'vendor',
    '__pycache__', 'site-packages', 'venv', 'env', 'build-output'
]);

/** How long a lookup is reused. A redeploy replaces the folder and its identity. */
const CACHE_MS = 60 * 1000;
const cache = new Map();

/** `ink` and `on-ink` from the Aegis tokens, the pair of the primary pill. */
const MONOGRAM_FILL = '#080808';
const MONOGRAM_TEXT = '#ffffff';

/** The file as an icon worth serving, or null. */
function usable(realRoot, file) {
    const type = TYPES[path.extname(file).toLowerCase()];
    if (!type) return null;
    let real;
    try { real = fs.realpathSync(file); } catch (_) { return null; }
    const inside = path.relative(realRoot, real);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
    // The extension again, on the real name: a `favicon.png` that is a link to
    // `config.json` passes the first check and must not pass this one.
    if (TYPES[path.extname(real).toLowerCase()] !== type) return null;
    let stat;
    try { stat = fs.statSync(real); } catch (_) { return null; }
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES) return null;
    return { file: real, type };
}

function readHead(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(HTML_SCAN_BYTES);
        const n = fs.readSync(fd, buf, 0, HTML_SCAN_BYTES, 0);
        return buf.subarray(0, n).toString('utf8');
    } catch (_) {
        return null;
    } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* nothing to do */ }
    }
}

/**
 * The icon hrefs an entry page declares, best first.
 *
 * `icon` and `shortcut icon` before `apple-touch-icon`, which is a larger tile
 * made for a home screen. `mask-icon` is left out: it is a single-colour
 * silhouette that Safari tints, and drawn as is it renders as a black blot.
 */
function iconHrefs(html) {
    const found = [];
    for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
        const attrs = {};
        const re = /([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
        let m;
        while ((m = re.exec(tag)) !== null) {
            attrs[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
        }
        const rel = String(attrs.rel || '').toLowerCase().split(/\s+/);
        const href = attrs.href;
        if (!href) continue;
        if (rel.includes('icon')) found.push({ rank: 0, href });
        else if (rel.includes('apple-touch-icon')) found.push({ rank: 1, href });
    }
    return found.sort((a, b) => a.rank - b.rank).map((f) => f.href);
}

/**
 * A declared href as a path on disk, or null when it does not point at this
 * site: a scheme (`https:`, `data:`), a scheme-relative `//host`, a backslash.
 * An absolute path is read against the folder of the page that declared it,
 * which is the site root as the browser sees it.
 */
function hrefToFile(dir, href) {
    const raw = String(href).split(/[?#]/)[0].trim();
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//') || raw.includes('\\')) return null;
    let decoded;
    try { decoded = decodeURIComponent(raw); } catch (_) { return null; }
    if (decoded.includes('\0')) return null;
    return path.resolve(dir, decoded.startsWith('/') ? '.' + decoded : decoded);
}

/**
 * The HTML files under `realRoot`, shallowest first, within the scan bounds.
 * A link or a junction is never entered: what it points at is not the site.
 */
function pagesUnder(realRoot) {
    const pages = [];
    let queue = [{ dir: realRoot, depth: 0 }];
    let seen = 0;
    while (queue.length && pages.length < SCAN_PAGES && seen < SCAN_DIRS) {
        const next = [];
        for (const { dir, depth } of queue) {
            if (++seen > SCAN_DIRS) break;
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
            entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            for (const entry of entries) {
                if (entry.isSymbolicLink()) continue;
                const name = entry.name;
                if (entry.isDirectory()) {
                    const lower = name.toLowerCase();
                    if (depth >= SCAN_DEPTH || name.startsWith('.') || SKIP_DIRS.has(lower)
                        || lower.endsWith('.dist-info') || lower.endsWith('.egg-info')) continue;
                    next.push({ dir: path.join(dir, name), depth: depth + 1 });
                } else if (entry.isFile() && /\.html?$/i.test(name) && pages.length < SCAN_PAGES) {
                    pages.push(path.join(dir, name));
                }
            }
        }
        queue = next;
    }
    return pages;
}

/**
 * Where an href declared by `page` lands on disk, every reading of it.
 *
 * A relative href is read against the page's folder, as the browser does. An
 * absolute one is read against each folder from the page's up to the site root,
 * because which of them the application serves as `/` is its own business: a
 * page in `web/` whose server mounts `web/` at the root writes `/logo.png` for
 * `web/logo.png`.
 */
function candidatesFor(realRoot, page, href) {
    const dir = path.dirname(page);
    const raw = String(href).split(/[?#]/)[0].trim();
    if (!raw.startsWith('/')) {
        const file = hrefToFile(dir, href);
        return file ? [file] : [];
    }
    const out = [];
    for (let base = dir; ; base = path.dirname(base)) {
        const file = hrefToFile(base, href);
        if (file) out.push(file);
        const rel = path.relative(realRoot, base);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) break;
    }
    return out;
}

/**
 * The icon most pages of the site declare.
 *
 * Counted rather than first-found: a project served by a process can carry a
 * stray page of a dependency or a tool, and the icon the site's own pages
 * agree on is the one its visitors see in the tab. A tie goes to the
 * shallowest page.
 */
function declaredByPages(realRoot) {
    const votes = new Map();
    for (const page of pagesUnder(realRoot)) {
        const html = readHead(page);
        if (!html) continue;
        let hit = null;
        for (const href of iconHrefs(html)) {
            for (const file of candidatesFor(realRoot, page, href)) {
                hit = usable(realRoot, file);
                if (hit) break;
            }
            if (hit) break;
        }
        if (!hit) continue;
        const held = votes.get(hit.file);
        if (held) held.count += 1;
        else votes.set(hit.file, { hit, count: 1 });
    }
    let best = null;
    for (const vote of votes.values()) {
        if (!best || vote.count > best.count) best = vote;
    }
    return best ? best.hit : null;
}

/** `{ file, type }` for the site under `root`, or null when it has none. */
function findIcon(root) {
    if (!root) return null;
    let realRoot;
    try { realRoot = fs.realpathSync(root); } catch (_) { return null; }

    // The entry page first, where a static build keeps it: what it declares is
    // what the tab shows, whatever the other pages say.
    for (const dir of DIRS) {
        const base = path.join(realRoot, dir);
        const html = readHead(path.join(base, 'index.html'));
        if (html === null) continue;
        for (const href of iconHrefs(html)) {
            const file = hrefToFile(base, href);
            const hit = file && usable(realRoot, file);
            if (hit) return hit;
        }
    }
    const declared = declaredByPages(realRoot);
    if (declared) return declared;
    for (const dir of NAME_DIRS) {
        for (const name of NAMES.concat(APP_NAMES)) {
            const hit = usable(realRoot, path.join(realRoot, dir, name));
            if (hit) return hit;
        }
    }
    return null;
}

/**
 * `findIcon`, reused for `CACHE_MS` while the folder is the same one.
 *
 * The login page asks twice per view (the tab and the corner) and the walk can
 * read a few hundred files. A deployment renames a new folder over `current/`,
 * so its inode and birth time change and the next request looks again.
 */
function findIconCached(root) {
    if (!root) return null;
    let stat;
    try { stat = fs.statSync(root); } catch (_) { return null; }
    const sig = `${stat.ino}:${stat.birthtimeMs}:${stat.mtimeMs}`;
    const now = Date.now();
    const held = cache.get(root);
    if (held && held.sig === sig && now - held.at < CACHE_MS) return held.hit;
    const hit = findIcon(root);
    cache.set(root, { sig, at: now, hit });
    return hit;
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** The first letter of the site name on an ink tile. */
function monogram(siteName) {
    const letter = (Array.from(String(siteName || '').trim())[0] || '?').toUpperCase();
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
        + `<rect width="32" height="32" rx="8" fill="${MONOGRAM_FILL}"/>`
        + `<text x="16" y="16" dy="0.35em" text-anchor="middle" fill="${MONOGRAM_TEXT}"`
        + ' font-family="Segoe UI, -apple-system, Helvetica, Arial, sans-serif" font-size="16" font-weight="600">'
        + `${escapeXml(letter)}</text></svg>`;
}

/** Answers `GET /__aegis/site-icon`. Always 200: an icon or a monogram. */
function serve(req, res, { root, siteName }) {
    let body = null;
    let type = 'image/svg+xml';
    const found = findIconCached(root);
    if (found) {
        try {
            body = fs.readFileSync(found.file);
            type = found.type;
        } catch (_) {
            body = null;
        }
    }
    if (body === null || body.length > MAX_BYTES) {
        body = Buffer.from(monogram(siteName), 'utf8');
        type = 'image/svg+xml';
    }
    res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': body.length,
        // A redeploy can change the icon. Revalidating costs one small request.
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    });
    res.end(req.method === 'HEAD' ? undefined : body);
}

module.exports = { findIcon, findIconCached, monogram, serve, MAX_BYTES, TYPES };
