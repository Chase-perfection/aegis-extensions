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

/** `{ file, type }` for the site under `root`, or null when it has none. */
function findIcon(root) {
    if (!root) return null;
    let realRoot;
    try { realRoot = fs.realpathSync(root); } catch (_) { return null; }

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
    for (const dir of DIRS) {
        for (const name of NAMES) {
            const hit = usable(realRoot, path.join(realRoot, dir, name));
            if (hit) return hit;
        }
    }
    return null;
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
    const found = findIcon(root);
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

module.exports = { findIcon, monogram, serve, MAX_BYTES, TYPES };
