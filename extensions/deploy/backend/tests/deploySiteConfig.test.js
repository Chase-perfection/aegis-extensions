/**
 * `vercel.json`, the subset of it Aegis honours, and the single-page fallback.
 *
 * Three failures to keep out. A rewrite whose destination is built by joining
 * strings serves a file from outside the site, which is the whole reason
 * `resolveRequest` takes a resolver rather than touching the filesystem itself.
 * A header from a repository that switches off `X-Content-Type-Options` undoes
 * the guard that stops a mistyped extension from being executed by the browser.
 * And a config file nobody can parse must refuse the deployment rather than be
 * ignored, because ignored means the operator sees a site that quietly does not
 * do what their file says.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const siteConfig = require('../siteConfig');

function withConfig(body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-siteconfig-'));
    if (body !== undefined) fs.writeFileSync(path.join(dir, 'vercel.json'), body);
    return dir;
}

/** A resolver that knows about a fixed set of files, like a deployed site. */
function resolver(files) {
    return (pathname) => {
        const clean = pathname.split('?')[0];
        return files.includes(clean) ? `/site${clean}` : null;
    };
}

const EMPTY = siteConfig.parse(null);

test('no vercel.json is a valid empty config', () => {
    const config = siteConfig.read(withConfig(undefined));
    assert.strictEqual(config.redirects.length, 0);
    assert.strictEqual(config.rewrites.length, 0);
    assert.strictEqual(config.headers.length, 0);
    assert.deepStrictEqual(config.unsupported, []);
});

test('a vercel.json that will not parse refuses the deployment', () => {
    assert.throws(() => siteConfig.read(withConfig('{ "rewrites": [ ')), { code: 'bad_site_config' });
});

test('keys Aegis does not honour are named rather than ignored', () => {
    const config = siteConfig.read(withConfig(JSON.stringify({
        cleanUrls: true,
        functions: { 'api/x.js': { memory: 1024 } },
        crons: [{ path: '/api/tick', schedule: '0 * * * *' }]
    })));

    assert.strictEqual(config.cleanUrls, true);
    assert.deepStrictEqual(config.unsupported.sort(), ['crons', 'functions']);
});

test('a source pattern outside the supported subset is named too', () => {
    const config = siteConfig.parse({
        redirects: [
            { source: '/old', destination: '/new' },
            { source: '/blog/:slug', destination: '/posts/:slug' }
        ]
    });

    assert.strictEqual(config.redirects.length, 1, 'the unsupported rule was kept');
    assert.ok(config.unsupported.some((u) => u.indexOf('/blog/:slug') !== -1), config.unsupported.join(','));
});

test('an exact source matches only itself, a wildcard matches below it', () => {
    assert.deepStrictEqual(siteConfig.match('/old', '/old'), { rest: '' });
    assert.strictEqual(siteConfig.match('/old', '/older'), null);

    assert.deepStrictEqual(siteConfig.match('/docs/(.*)', '/docs/a/b'), { rest: 'a/b' });
    assert.deepStrictEqual(siteConfig.match('/docs/:path*', '/docs/a/b'), { rest: 'a/b' });
    assert.deepStrictEqual(siteConfig.match('/docs/(.*)', '/docs'), { rest: '' });
    assert.strictEqual(siteConfig.match('/docs/(.*)', '/documents'), null);

    assert.deepStrictEqual(siteConfig.match('/(.*)', '/anything/at/all'), { rest: 'anything/at/all' });
});

test('a redirect answers before the filesystem is touched', () => {
    const config = siteConfig.parse({
        redirects: [
            { source: '/old', destination: '/new' },
            { source: '/temp', destination: '/new', permanent: false },
            { source: '/gone', destination: '/new', statusCode: 302 },
            { source: '/docs/(.*)', destination: '/manual/$1' }
        ]
    });
    const resolve = resolver(['/old']);

    assert.deepStrictEqual(siteConfig.resolveRequest({ pathname: '/old', config, resolve }),
        { kind: 'redirect', status: 308, location: '/new' });
    assert.strictEqual(siteConfig.resolveRequest({ pathname: '/temp', config, resolve }).status, 307);
    assert.strictEqual(siteConfig.resolveRequest({ pathname: '/gone', config, resolve }).status, 302);
    assert.strictEqual(siteConfig.resolveRequest({ pathname: '/docs/a/b', config, resolve }).location,
        '/manual/a/b');
});

test('a file that exists is served, with the headers its rule asks for', () => {
    const config = siteConfig.parse({
        headers: [
            { source: '/(.*)', headers: [{ key: 'X-Frame-Options', value: 'DENY' }] },
            { source: '/assets/(.*)', headers: [{ key: 'Cache-Control', value: 'max-age=31536000' }] }
        ]
    });
    const resolve = resolver(['/index.html', '/assets/app.js']);

    const page = siteConfig.resolveRequest({ pathname: '/index.html', config, resolve });
    assert.strictEqual(page.kind, 'file');
    assert.strictEqual(page.file, '/site/index.html');
    assert.deepStrictEqual(page.headers, { 'X-Frame-Options': 'DENY' });

    const asset = siteConfig.resolveRequest({ pathname: '/assets/app.js', config, resolve });
    assert.deepStrictEqual(asset.headers, {
        'X-Frame-Options': 'DENY',
        'Cache-Control': 'max-age=31536000'
    });
});

test('a header a repository may not set is dropped', () => {
    const config = siteConfig.parse({
        headers: [{
            source: '/(.*)', headers: [
                { key: 'X-Content-Type-Options', value: 'off' },
                { key: 'Content-Length', value: '0' },
                { key: 'Connection', value: 'close' },
                { key: 'X-Ok', value: 'yes' }
            ]
        }]
    });

    const answer = siteConfig.resolveRequest({
        pathname: '/index.html', config, resolve: resolver(['/index.html'])
    });
    assert.deepStrictEqual(answer.headers, { 'X-Ok': 'yes' });
});

test('a rewrite is tried only when no file matched', () => {
    const config = siteConfig.parse({
        rewrites: [{ source: '/(.*)', destination: '/index.html' }]
    });
    const resolve = resolver(['/index.html', '/about.html']);

    const real = siteConfig.resolveRequest({ pathname: '/about.html', config, resolve });
    assert.strictEqual(real.file, '/site/about.html', 'the rewrite took a request a file answered');

    const route = siteConfig.resolveRequest({ pathname: '/dashboard/settings', config, resolve });
    assert.strictEqual(route.kind, 'file');
    assert.strictEqual(route.file, '/site/index.html');
});

test('the fallback switch does what the rewrite does, with no config file', () => {
    const resolve = resolver(['/index.html']);

    const without = siteConfig.resolveRequest({ pathname: '/dashboard', config: EMPTY, resolve });
    assert.strictEqual(without.kind, 'none');

    const with_ = siteConfig.resolveRequest({
        pathname: '/dashboard', config: EMPTY, resolve, spaFallback: true
    });
    assert.strictEqual(with_.file, '/site/index.html');
});

test('the fallback does not answer for a missing asset', () => {
    // A 404 that returns HTML for /assets/app.js is a page that fails with a
    // syntax error instead of a missing file, which is a worse afternoon.
    const answer = siteConfig.resolveRequest({
        pathname: '/assets/app.js', config: EMPTY, resolve: resolver(['/index.html']), spaFallback: true
    });
    assert.strictEqual(answer.kind, 'none');
});

test('cleanUrls serves the .html a bare path names', () => {
    const config = siteConfig.parse({ cleanUrls: true });
    const resolve = resolver(['/about.html']);

    assert.strictEqual(siteConfig.resolveRequest({ pathname: '/about', config, resolve }).file,
        '/site/about.html');
    assert.strictEqual(siteConfig.resolveRequest({ pathname: '/about', config: EMPTY, resolve }).kind,
        'none');
});

test('trailingSlash false redirects a directory path, true adds the slash', () => {
    const off = siteConfig.parse({ trailingSlash: false });
    const on = siteConfig.parse({ trailingSlash: true });
    const resolve = resolver([]);

    assert.deepStrictEqual(siteConfig.resolveRequest({ pathname: '/docs/', config: off, resolve }),
        { kind: 'redirect', status: 308, location: '/docs' });
    assert.deepStrictEqual(siteConfig.resolveRequest({ pathname: '/docs', config: on, resolve }),
        { kind: 'redirect', status: 308, location: '/docs/' });

    // The root is not a directory path anyone can strip, and a file name is not
    // one anyone should add a slash to.
    assert.notStrictEqual(siteConfig.resolveRequest({ pathname: '/', config: off, resolve }).kind, 'redirect');
    assert.notStrictEqual(siteConfig.resolveRequest({ pathname: '/app.js', config: on, resolve }).kind, 'redirect');
});

test('a rewrite destination is resolved, never joined', () => {
    // The destination comes from a repository, so the only thing that decides
    // which file it reaches is the resolver the site server passes in, and that
    // one refuses anything outside the site.
    const seen = [];
    siteConfig.resolveRequest({
        pathname: '/x',
        config: siteConfig.parse({ rewrites: [{ source: '/(.*)', destination: '/../../secrets.json' }] }),
        resolve: (p) => { seen.push(p); return null; }
    });

    assert.ok(seen.includes('/../../secrets.json'), seen.join(','));
});
