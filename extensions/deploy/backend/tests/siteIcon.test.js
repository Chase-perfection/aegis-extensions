/**
 * The site icon is the one file the guard reads out of a protected site before
 * anyone has signed in. These tests hold the lines that keep it an icon: an
 * image type, inside the site, small, and a monogram when there is none.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const siteIcon = require('../siteIcon');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function site(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-site-icon-'));
    for (const [name, body] of Object.entries(files || {})) {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body);
    }
    return root;
}

function fakeRes() {
    const res = { statusCode: 0, headers: {}, body: null };
    res.writeHead = (status, headers) => { res.statusCode = status; Object.assign(res.headers, headers); };
    res.end = (chunk) => { res.body = chunk === undefined ? null : Buffer.from(chunk); };
    return res;
}

test('findIcon: the icon the entry page declares wins over a conventional name', () => {
    const root = site({
        'index.html': '<html><head><link rel="icon" type="image/svg+xml" href="/brand/mark.svg?v=3"></head></html>',
        'brand/mark.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
        'favicon.ico': PNG
    });
    const hit = siteIcon.findIcon(root);
    assert.strictEqual(path.basename(hit.file), 'mark.svg');
    assert.strictEqual(hit.type, 'image/svg+xml');
});

test('findIcon: falls back to favicon.ico, then to the public folder of a server project', () => {
    assert.strictEqual(path.basename(siteIcon.findIcon(site({ 'favicon.ico': PNG })).file), 'favicon.ico');
    const hit = siteIcon.findIcon(site({ 'server.js': 'x', 'public/favicon.png': PNG }));
    assert.strictEqual(hit.type, 'image/png');
});

test('findIcon: a link to another origin, a data URL or a non-image is ignored', () => {
    const root = site({
        'index.html': [
            '<link rel="icon" href="https://cdn.example.com/x.png">',
            '<link rel="icon" href="//cdn.example.com/x.png">',
            '<link rel="icon" href="data:image/png;base64,AAAA">',
            '<link rel="icon" href="/.env">',
            '<link rel="icon" href="/server.js">'
        ].join('\n'),
        '.env': 'SECRET=1',
        'server.js': 'x'
    });
    assert.strictEqual(siteIcon.findIcon(root), null);
});

test('findIcon: a link that climbs out of the site is refused', () => {
    const outside = site({ 'stolen.png': PNG });
    const root = site({
        'index.html': `<link rel="icon" href="/../${path.basename(outside)}/stolen.png">`
            + '<link rel="icon" href="%2e%2e/%2e%2e/stolen.png">'
    });
    assert.strictEqual(siteIcon.findIcon(root), null);
});

test('findIcon: a link committed to the repository that points outside is refused', (t) => {
    const outside = site({ 'secret.png': PNG });
    const root = site({});
    try {
        fs.symlinkSync(path.join(outside, 'secret.png'), path.join(root, 'favicon.png'), 'file');
    } catch (e) {
        // Windows grants symlink creation to administrators and developer mode
        // only. Junctions cover directories; this case needs a file link.
        t.skip(`cannot create a symlink here (${e.code})`);
        return;
    }
    assert.strictEqual(siteIcon.findIcon(root), null);
});

test('findIcon: an empty or oversized file is not an icon', () => {
    assert.strictEqual(siteIcon.findIcon(site({ 'favicon.png': '' })), null);
    assert.strictEqual(siteIcon.findIcon(site({ 'favicon.png': Buffer.alloc(siteIcon.MAX_BYTES + 1) })), null);
});

test('findIcon: no root, or a root that does not exist, is no icon', () => {
    assert.strictEqual(siteIcon.findIcon(undefined), null);
    assert.strictEqual(siteIcon.findIcon(path.join(os.tmpdir(), 'aegis-no-such-site-' + Date.now())), null);
});

test('monogram: the first letter, upper-cased and escaped', () => {
    assert.match(siteIcon.monogram('portail'), />P<\/text>/);
    assert.match(siteIcon.monogram('<script>'), />&lt;<\/text>/);
    assert.match(siteIcon.monogram(''), />\?<\/text>/);
});

test('serve: the site icon, typed by the extension, sandboxed and never sniffed', () => {
    const res = fakeRes();
    siteIcon.serve({ method: 'GET' }, res, { root: site({ 'favicon.png': PNG }), siteName: 'Sales' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['Content-Type'], 'image/png');
    assert.strictEqual(res.headers['X-Content-Type-Options'], 'nosniff');
    assert.match(res.headers['Content-Security-Policy'], /sandbox/);
    assert.ok(res.body.equals(PNG));
});

test('serve: a monogram when the site has no icon, never a 404', () => {
    const res = fakeRes();
    siteIcon.serve({ method: 'GET' }, res, { root: site({}), siteName: 'Sales' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['Content-Type'], 'image/svg+xml');
    assert.match(res.body.toString('utf8'), />S<\/text>/);
});

test('serve: HEAD answers the headers and no body', () => {
    const res = fakeRes();
    siteIcon.serve({ method: 'HEAD' }, res, { root: site({ 'favicon.png': PNG }), siteName: 'Sales' });
    assert.strictEqual(res.headers['Content-Length'], PNG.length);
    assert.strictEqual(res.body, null);
});
