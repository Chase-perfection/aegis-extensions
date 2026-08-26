/**
 * Serves deployed sites, one listener per project, each on its own port.
 *
 * Three constraints shaped this file.
 *
 * A port per project rather than a path prefix. A built site references its
 * assets from the root, `/assets/app.js`, and under a prefix like
 * `/live/my-site/` every one of those 404s. Rewriting the HTML to fix that is a
 * worse job than opening a port. This is the plan's phase 4 port allocation
 * arriving early, because static sites turned out to need it too.
 *
 * A port of its own also keeps a page from a repository off the dashboard's
 * origin. Ports do not isolate cookies, so this narrows the exposure rather than
 * closing it; the plan's distinct hostname per site is still the right answer.
 *
 * `node:http` rather than express: an extension cannot resolve the backend's
 * dependencies. `extensions/deploy/backend/` walks up to the repository root
 * looking for `node_modules` and never into `backend/node_modules`, so `express`
 * is unavailable here. The standard library covers a static file server.
 *
 * A site can be served over TLS instead, and that is what makes the guard in
 * `siteAuth.js` worth calling secure: without it the password typed into the
 * login form and the session cookie it returns both cross the network in clear.
 * `project.tls` carries a switch and the paths to a certificate and a key. See
 * `tlsOptionsFor` for why paths and not stored PEM, and `startSiteFor` for why
 * a certificate that will not load stops the site instead of downgrading it.
 *
 * No `Strict-Transport-Security`, and this is not an oversight to correct.
 * HSTS is scoped to a host name and ignores the port (RFC 6797 section 8.1).
 * Every site on this machine shares one host name and differs only by port, so
 * a single HTTPS site sending that header would force HTTPS onto all of them,
 * including the plain-HTTP ones, and take those down in every browser that had
 * seen it. It only becomes safe once each site has a host name of its own.
 */

'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

const projectStore = require('./projectStore');
const siteAuth = require('./siteAuth');
const siteConfig = require('./siteConfig');
const runtime = require('./runtime');

/** First port handed out. Each project takes the next free one above it. */
const DEFAULT_PORT_BASE = 3081;
const PORT_RANGE = 100;

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.pdf': 'application/pdf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.wasm': 'application/wasm'
};

function portBase() {
    return Number(process.env.AEGIS_SITES_PORT_BASE || DEFAULT_PORT_BASE);
}

function send(res, status, body) {
    res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        // The bytes come from a repository, so a mistyped extension must not let
        // the browser guess something executable.
        'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
}

/**
 * The file a request maps to, or null when it maps to nothing servable.
 *
 * Containment is checked after resolution rather than by looking for `..` in the
 * URL, because encodings make that check unreliable and `path.relative` answers
 * the question that matters: is the resolved file inside the site.
 */
function resolveFile(root, rest) {
    const decoded = rest.map((seg) => {
        try { return decodeURIComponent(seg); } catch (_) { return null; }
    });
    if (decoded.some((seg) => seg === null)) return null;

    const target = path.resolve(root, ...decoded);
    const inside = path.relative(root, target);
    if (inside.startsWith('..') || path.isAbsolute(inside)) return null;

    let stat;
    try { stat = fs.statSync(target); } catch (_) { return null; }
    if (stat.isDirectory()) {
        // No directory listings: a site with no index.html at that path has
        // nothing to show, and a listing would publish the tree.
        const index = path.join(target, 'index.html');
        return fs.existsSync(index) ? index : null;
    }
    return stat.isFile() ? target : null;
}


/**
 * Headers that belong to one hop and must not be forwarded to the next.
 *
 * `transfer-encoding` and `content-length` especially: node decides those for
 * the response it is writing, and copying the upstream's produces a body the
 * client cannot read.
 */
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade',
    'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'content-length'];

function withoutHopByHop(headers) {
    const out = {};
    for (const [name, value] of Object.entries(headers || {})) {
        if (!HOP_BY_HOP.includes(name.toLowerCase())) out[name] = value;
    }
    return out;
}

/**
 * The three headers an application behind a protected site receives, and the
 * only public interface this proxy has. Named here once, and in `CONTRACT.md`
 * of aegis-extensions: the day a deployed project reads one of them, the name
 * stops being ours to change.
 */
const IDENTITY_HEADERS = ['X-Aegis-User', 'X-Aegis-Name', 'X-Aegis-Groups'];
const IDENTITY_LOWER = IDENTITY_HEADERS.map((n) => n.toLowerCase());

/**
 * Drops every identity header the client sent, whatever case it used.
 *
 * Unconditional, and that is the whole point. On a protected site ours are
 * written a few lines later and would overwrite these anyway; on an open site
 * nothing overwrites them, and a visitor sending `X-Aegis-User: administrateur`
 * to a site with no gate would hand the application an identity that no gate
 * ever checked. Stripping only when we are about to write would protect the
 * sites that need it least.
 *
 * Node lower-cases the header names it parses off the wire, so on a real
 * request one comparison would do. The loop is for a caller that builds a
 * header bag by hand, which is what a test does and what a future caller of
 * this exported function might.
 */
function stripIdentity(headers) {
    for (const name of Object.keys(headers)) {
        if (IDENTITY_LOWER.includes(name.toLowerCase())) delete headers[name];
    }
}

/**
 * One identity value, in a form a header can actually carry.
 *
 * Percent-encoded UTF-8 rather than the raw string, for a reason that is not
 * cosmetic: a display name or a group name comes from the directory, so in this
 * country it carries accents, and Node refuses a header value holding a
 * character above U+00FF by throwing. Sent raw, one person whose name is
 * spelled outside latin-1 would get a failed request on every page they open,
 * and the log would blame the proxy.
 *
 * Two smaller questions fall to the same stroke. A CR or an LF cannot survive
 * the encoding, so no directory value can inject a header of its own. And a
 * group named `Direction, Finance` encodes its comma, so the comma-separated
 * list cannot be read as two groups.
 *
 * A plain sAMAccountName passes through unchanged, which is the common case and
 * the one an operator reads in a log.
 */
function encodeIdentity(value) {
    try {
        return encodeURIComponent(String(value === undefined || value === null ? '' : value));
    } catch (e) {
        // A lone surrogate is the only input that reaches here. Nothing sane
        // produces one, and dropping the value beats throwing inside a request
        // the visitor has no way to retry differently.
        return '';
    }
}

/**
 * Hands one request to the application process behind this site.
 *
 * Every method, not just GET and HEAD: the point of a runtime is the form post
 * and the API route the static path has nothing to answer with.
 *
 * The `X-Forwarded-*` headers are set because an application generating an
 * absolute URL has no other way to know it is behind anything. They are
 * overwritten rather than appended: whatever a client sent under those names is
 * its claim about itself, and this is the only hop that knows the truth.
 *
 * ponytail: no WebSocket upgrade. `server.on('upgrade')` plus a socket pipe is
 * the addition, and no project needs it yet.
 */
function proxyTo(req, res, port, ctx) {
    const headers = withoutHopByHop(req.headers);
    headers['X-Forwarded-For'] = req.socket.remoteAddress || '';
    headers['X-Forwarded-Proto'] = req.socket.encrypted ? 'https' : 'http';
    headers['X-Forwarded-Host'] = req.headers.host || '';

    // Overwritten, never appended -- see stripIdentity for why this runs even
    // when nothing is about to be written.
    stripIdentity(headers);
    let identity = null;
    try {
        identity = siteAuth.identityFor(req, ctx);
    } catch (e) {
        // The guard already decided this request may pass, so failing to name
        // the visitor must not turn a page that loads into an error. Absent is
        // the safe answer: the client's own headers are gone by now, so the
        // application sees an anonymous request rather than a forged one.
        console.warn(`[Deploy] ${ctx.slug}/${ctx.project.id}: identity unavailable for this request: ${e.message}`);
    }
    if (identity) {
        headers['X-Aegis-User'] = encodeIdentity(identity.username);
        headers['X-Aegis-Name'] = encodeIdentity(identity.user);
        // Joined in the order the session carries them, which is the order the
        // directory answered. A project matching on the first group would
        // otherwise depend on a Map iteration nobody promised.
        headers['X-Aegis-Groups'] = identity.groups.map(encodeIdentity).join(',');
    }

    const upstream = http.request({
        host: '127.0.0.1', port, path: req.url, method: req.method, headers,
        timeout: PROXY_TIMEOUT_MS
    }, (up) => {
        res.writeHead(up.statusCode || 502, withoutHopByHop(up.headers));
        up.pipe(res);
    });

    upstream.on('timeout', () => {
        upstream.destroy();
        if (!res.headersSent) send(res, 504, 'The application did not answer in time');
    });
    upstream.on('error', (e) => {
        console.warn(`[Deploy] ${ctx.slug}/${ctx.project.id}: application on ${port} refused a request: ${e.message}`);
        if (!res.headersSent) send(res, 502, 'The application is not answering');
    });
    req.pipe(upstream);
}

/** How long the application gets to start answering one request. */
const PROXY_TIMEOUT_MS = 30000;

/**
 * One request, after the guard.
 *
 * The path a request asks for is not always the file that answers it: a
 * repository's `vercel.json` can redirect it, rewrite it, or ask for headers on
 * it, and a single-page project can ask for `index.html` on every route it did
 * not build a file for. `siteConfig.resolveRequest` decides which of those
 * applies and this function does what it says.
 *
 * Rules are matched against the path as the browser sent it, percent-encoding
 * included, while `resolveFile` decodes each segment before it touches the
 * disk. A rule written with an escape in it would not match, which is a
 * limitation and not a hole: matching a decoded path against a rule would let
 * `%2e%2e` stand for `..` on the way in.
 */
function serve(req, res, ctx) {
    const root = ctx.root;

    // A project with a process answers from it, whatever the request method. A
    // project that should have one and does not answers 503 and never falls
    // through to the files: `current/` for a server-rendered application is its
    // source, and publishing that is worse than being down.
    if (ctx.runtime === 'node') {
        const port = runtime.targetFor(ctx.slug, ctx.project.id);
        if (!port) return send(res, 503, 'This application is not running');
        return proxyTo(req, res, port, ctx);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (!fs.existsSync(root)) return send(res, 404, 'This site has not been deployed');

    const pathname = (req.url || '/').split('?')[0] || '/';
    const answer = siteConfig.resolveRequest({
        pathname,
        config: siteConfig.configFor(root),
        spaFallback: siteConfig.settingsFor(ctx.slug, ctx.tenantPaths, ctx.project.id).spaFallback,
        // The one path from a URL or a config file to a file on disk, and the
        // one place containment is checked.
        resolve: (candidate) => resolveFile(root, String(candidate).split('?')[0].split('/').filter(Boolean))
    });

    if (answer.kind === 'redirect') {
        res.writeHead(answer.status, { Location: answer.location, 'Content-Length': 0 });
        return res.end();
    }
    if (answer.kind !== 'file') return send(res, 404, 'Not found');

    let stat;
    try { stat = fs.statSync(answer.file); } catch (_) { return send(res, 404, 'Not found'); }

    res.writeHead(200, Object.assign({
        'Content-Type': TYPES[path.extname(answer.file).toLowerCase()] || 'application/octet-stream',
        // A deployment replaces `current` wholesale, so a cached asset can point
        // at a file that is gone. Revalidation keeps that from showing, and a
        // config file that knows better about its own hashed assets overrides
        // it below.
        'Cache-Control': 'no-cache'
    }, answer.headers, {
        // Last, so nothing from a repository can move them. The length is the
        // file being sent and nosniff is why a mistyped extension in a
        // repository cannot become an executable response.
        'Content-Length': stat.size,
        'X-Content-Type-Options': 'nosniff'
    }));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(answer.file).on('error', () => res.destroy()).pipe(res);
}

/**
 * The guard runs before anything is resolved on disk.
 *
 * Order matters more than it looks. `siteAuth` reserves the whole `/__aegis/`
 * prefix, and it can only do that if it is asked first; consulting it after
 * `resolveFile` would let a repository that happens to contain `__aegis/`
 * answer on the path the browser is about to trust with a password.
 *
 * `gate` returns a promise only on the form submission, so the synchronous case
 * stays synchronous and the static path is unchanged for every unprotected
 * site. Either way a guard that fails is a request that is refused: an error
 * here means we do not know whether this site is protected, and serving it
 * would be the one answer we cannot take back.
 */
function handle(req, res, ctx) {
    touchSite(ctx.slug, ctx.project.id);

    let gated;
    try {
        gated = siteAuth.gate(req, res, ctx);
    } catch (e) {
        console.error(`[Deploy] ${ctx.slug}/${ctx.project.id}: access check failed: ${e.message}`);
        if (!res.headersSent) send(res, 503, 'This site is unavailable');
        return;
    }

    if (gated && typeof gated.then === 'function') {
        gated.then((handled) => {
            if (!handled) serve(req, res, ctx);
        }).catch((e) => {
            console.error(`[Deploy] ${ctx.slug}/${ctx.project.id}: access check failed: ${e.message}`);
            if (!res.headersSent) send(res, 503, 'This site is unavailable');
        });
        return;
    }

    if (gated) return;
    serve(req, res, ctx);
}

/**
 * The certificate and key for a project, or null when it asked for plain HTTP.
 *
 * Paths rather than PEM stored in the record. A certificate for a LAN host
 * arrives from certbot or from an internal CA and is renewed by something that
 * rewrites the file in place; pointing at that file means a renewal is picked
 * up by restarting the site rather than by pasting a new certificate into a
 * form. It also keeps a private key out of the tenant's JSON, out of backups of
 * it, and out of every route that reads a project record.
 *
 * Throws rather than returning null when a path will not read, or when what it
 * reads is not a usable certificate and key. The caller turns that into a site
 * that does not start: see `startSiteFor`.
 */
function tlsOptionsFor(project) {
    const t = project && project.tls;
    if (!t || t.enabled !== true) return null;
    if (!t.certFile || !t.keyFile) {
        throw Object.assign(new Error('TLS is on but the certificate or key path is empty'),
            { code: 'tls_incomplete' });
    }
    // Read now, not at first request: a bad path must fail at startup where the
    // operator is looking, not on the first visitor.
    const options = { cert: fs.readFileSync(t.certFile), key: fs.readFileSync(t.keyFile) };

    // Readable is not the same as usable. `https.createServer` parses the PEM in
    // its constructor and throws synchronously on anything malformed, and the
    // two places that call it are both places where a synchronous throw is
    // damaging: inside the `close` callback of a restart, where it would escape
    // the promise, and inside `startAllSites` at boot, where one tenant's
    // half-written certificate would abort startup for every tenant. That is a
    // real state and not a hypothetical, because a renewal rewrites the file in
    // place and can be read mid-write.
    //
    // So parse it here, where the caller's try/catch is already waiting, and let
    // the site fail to start the same way a missing file does.
    tls.createSecureContext(options);
    return options;
}

/** `<tenant>/<project>` to its listener. */
const servers = new Map();

function key(slug, projectId) {
    return `${slug}/${projectId}`;
}

/**
 * When each site last answered a request. In memory, deliberately.
 *
 * `previews.js` reads it to decide whether a preview deployment is still being
 * used by anybody. A disk write per request to a static file is not worth
 * knowing that precisely: a restart forgets the visits, so the expiry clock
 * effectively restarts with the backend, which errs towards keeping a preview
 * rather than deleting one somebody is reading.
 */
const touched = new Map();

function touchSite(slug, projectId) {
    touched.set(key(slug, projectId), Date.now());
}

function lastTouch(slug, projectId) {
    return touched.get(key(slug, projectId)) || 0;
}

/**
 * A port no project on this machine is using.
 *
 * Ports are machine-wide while projects are per tenant, so this reads every
 * tenant's records rather than one. A port already claimed by something outside
 * Aegis is caught at listen time, not here, because only the operating system
 * knows that.
 */
function allocatePort({ pathsFor, tenantsRoot }) {
    const taken = new Set();
    for (const { tenantPaths } of projectStore.tenantsWithProjects(tenantsRoot(), pathsFor)) {
        for (const p of projectStore.listProjects(tenantPaths)) {
            if (p.port) taken.add(Number(p.port));
        }
    }
    const base = portBase();
    for (let port = base; port < base + PORT_RANGE; port++) {
        if (!taken.has(port)) return port;
    }
    throw Object.assign(new Error(`no free port between ${base} and ${base + PORT_RANGE - 1}`),
        { code: 'no_free_port' });
}

/**
 * Whether this project's port is open right now.
 *
 * `listen` reports a port already taken on the 'error' event rather than by
 * throwing, so a site whose bind failed used to be a card that said Live next
 * to a link that answers nothing. The projects route reads this so the page can
 * say which of the two it is.
 */
function isServing(slug, projectId) {
    return servers.has(key(slug, projectId));
}

/**
 * Starts one project's listener, or leaves the running one alone.
 *
 * A deployment replaces the contents of `current` and never the path, so a
 * listener started once keeps serving new versions with no restart.
 */
function startSiteFor({ slug, tenantPaths, project }) {
    if (!project || !project.port) return null;
    const k = key(slug, project.id);
    if (servers.has(k)) return servers.get(k);

    // The closure widens from `root` to the whole context the guard needs.
    // Only the id and the name are captured from the record: whether the site is
    // protected and which groups may open it change while the listener runs, and
    // `siteAuth` re-reads those through its own short-lived cache rather than
    // from a snapshot taken at boot. Capturing the live record here would mean a
    // site stays open until the process restarts.
    const root = projectStore.currentDir(tenantPaths, project.id);
    const ctx = {
        slug,
        tenantPaths,
        project: { id: project.id, name: project.name || project.id },
        // Captured, unlike the protection and the serving config: what a project
        // is served by is decided when it is created and changing it is a new
        // project, so re-reading it per request would buy nothing.
        runtime: project.runtime === 'node' ? 'node' : 'static',
        root
    };
    // Fail closed on TLS. A site the operator marked HTTPS and which then came
    // up in clear would look like it worked -- the page loads -- while sending
    // the login form's password across the network unprotected. Refusing to
    // start is visible; a silent downgrade is not.
    let tlsOptions;
    try {
        tlsOptions = tlsOptionsFor(project);
    } catch (e) {
        console.error(`[Deploy] ${k}: HTTPS is on but the certificate could not be loaded, site not started: ${e.message}`);
        return null;
    }

    const onRequest = (req, res) => {
        try {
            handle(req, res, ctx);
        } catch (e) {
            console.error(`[Deploy] ${k}: request failed: ${e.message}`);
            if (!res.headersSent) send(res, 500, 'Internal error');
        }
    };
    const server = tlsOptions
        ? https.createServer(tlsOptions, onRequest)
        : http.createServer(onRequest);

    if (tlsOptions) {
        // A handshake that fails is one client's problem: a browser refusing a
        // self-signed certificate, or a port scanner. Without this listener the
        // error is unhandled and takes the backend down with it.
        server.on('tlsClientError', (e) => {
            console.warn(`[Deploy] ${k}: TLS handshake failed: ${e.message}`);
        });
    }

    server.on('error', (e) => {
        // One site failing to bind must not touch the dashboard or the others.
        console.error(`[Deploy] ${k}: could not listen on ${project.port}: ${e.message}`);
        servers.delete(k);
    });

    // 0.0.0.0 on purpose: a deployed site is reached from other machines on the
    // network, which is the point of deploying it.
    server.listen(project.port, '0.0.0.0', () => {
        console.log(`[Deploy] ${k}: serving on ${tlsOptions ? 'https' : 'http'}://0.0.0.0:${project.port}/`);
    });
    servers.set(k, server);
    return server;
}

/**
 * Closes a project's listener and frees its port.
 *
 * `close()` and not `closeAllConnections()`: a browser holding the site open
 * keeps a keep-alive socket, and the port stays bound until it drops. Deleting a
 * project is not urgent enough to cut a response in half, and `allocatePort`
 * reads the records rather than the OS, so the next project gets a different
 * number regardless.
 */
function stopSiteFor(slug, projectId) {
    const k = key(slug, projectId);
    const server = servers.get(k);
    if (!server) return false;
    servers.delete(k);
    server.close(() => console.log(`[Deploy] ${k}: stopped`));
    return true;
}

/** Starts a listener for every project that already has a port. */
function startAllSites({ pathsFor, tenantsRoot }) {
    for (const { slug, tenantPaths } of projectStore.tenantsWithProjects(tenantsRoot(), pathsFor)) {
        for (const project of projectStore.listProjects(tenantPaths)) {
            startSiteFor({ slug, tenantPaths, project });
        }
    }
}

/**
 * Stops a site and starts it again on the same port, so a settings change takes
 * effect.
 *
 * TLS is decided when the listener is created: `https.createServer` reads the
 * certificate once and there is no way to turn a running plain server into an
 * encrypted one. Every other project setting is read per request and needs
 * nothing like this.
 *
 * Asynchronous, and it has to be. `stopSiteFor` closes without cutting live
 * connections, on purpose, which means a browser holding the site open keeps
 * the port bound after `close()` returns. Re-listening on that port straight
 * away is EADDRINUSE, and because `listen` reports that on the 'error' event
 * rather than by throwing, the failure would surface as a site that is simply
 * gone, with the record already saved. So this path cuts the sockets, which is
 * the right trade here and not in `stopSiteFor`: the scheme or the certificate
 * just changed, so every open connection is on terms that no longer apply, and
 * the reader gets a reconnect rather than a half-served page.
 */
function restartSiteFor({ slug, tenantPaths, project }) {
    const projectId = project && project.id;
    const k = key(slug, projectId);
    const server = servers.get(k);
    if (!server) return Promise.resolve(startSiteFor({ slug, tenantPaths, project }));

    servers.delete(k);
    return new Promise((resolve, reject) => {
        let settled = false;
        const go = () => {
            if (settled) return;
            settled = true;
            console.log(`[Deploy] ${k}: stopped`);
            // `startSiteFor` runs here inside an I/O callback, not on the chain
            // the caller awaits, so a throw would not become a rejection: it
            // would be an uncaught exception and this promise would never
            // settle, hanging the request that asked for the restart. It should
            // not throw now that `tlsOptionsFor` validates, and this is the net
            // under that.
            try { resolve(startSiteFor({ slug, tenantPaths, project })); }
            catch (e) { reject(e); }
        };
        // Belt and braces: `close` fires its callback only once every connection
        // is gone, and a socket that ignores the destroy would hang the restart
        // and, with it, the request that asked for it.
        const timer = setTimeout(go, 2000);
        if (timer.unref) timer.unref();
        server.close(() => { clearTimeout(timer); go(); });
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
}

/* ------------------------------------------------------------------ */
/* host names                                                          */
/* ------------------------------------------------------------------ */

/**
 * Host names, on an install that keeps a port per site.
 *
 * The operator was asked whether Aegis could take 80 and 443 with internal DNS
 * behind it and said no, so a host name does not replace the port -- it is
 * offered alongside it. One shared listener, off unless `AEGIS_SITES_ROUTER_PORT`
 * is set, answers for every project that declared a name, and each site keeps
 * answering on its own port either way. Add a DNS record or a hosts entry later
 * and the name starts working; add nothing and nothing breaks.
 *
 * A request whose `Host` nobody claimed gets 404 and never the first site in the
 * list. Serving the wrong site under an unclaimed name is how a page ends up
 * published under a name nobody protected.
 *
 * No HSTS here either, for the reason in this file's header: it is scoped to a
 * host name and ignores the port, and these sites still share ports with plain
 * HTTP ones.
 */

/**
 * One DNS name, lowercase, no port and no scheme.
 *
 * Deliberately narrower than the RFC: no underscore, no trailing dot, no
 * absolute-form URL. The value is compared against a header a client controls,
 * so the shapes it can take are worth keeping few.
 */
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * A host name from an operator, or null when it is not one.
 *
 * Three answers, not two: `''` is "this project has no name", `null` is "what
 * you typed is not a name", and the caller has to tell those apart -- one is a
 * saved change and the other is a refusal.
 */
function normaliseHostname(raw) {
    const value = String(raw == null ? '' : raw).trim().toLowerCase().replace(/\.$/, '');
    if (!value) return '';
    return HOSTNAME_RE.test(value) ? value : null;
}

/** The `Host` header without its port. An IPv6 literal keeps its brackets. */
function hostOf(req) {
    const raw = String((req && req.headers && req.headers.host) || '').trim().toLowerCase();
    if (raw.startsWith('[')) {
        const end = raw.indexOf(']');
        return end === -1 ? raw : raw.slice(0, end + 1);
    }
    return raw.split(':')[0];
}

/**
 * Host name -> the project that answers for it.
 *
 * Pure, so the lookup is testable without a tenant on disk. A project with no
 * port is left out: it has no listener and nothing published, and routing a name
 * to it would answer 404 from the site rather than from the router, which reads
 * as a deployment problem instead of a configuration one.
 *
 * The first claim on a name wins and the second is dropped with a line in the
 * log. The route refuses a duplicate at the point somebody types it; this is
 * what happens when two records already disagree, and picking one deterministic
 * answer beats serving whichever tenant was read last.
 */
function buildHostIndex(tenants) {
    const map = new Map();
    for (const { slug, tenantPaths, projects } of tenants || []) {
        for (const project of projects || []) {
            const hostname = normaliseHostname(project && project.hostname);
            if (!hostname || !project.port) continue;
            if (map.has(hostname)) {
                const held = map.get(hostname);
                console.warn(`[Deploy] ${slug}/${project.id} also claims ${hostname}, which ${held.slug}/${held.project.id} already answers for`);
                continue;
            }
            map.set(hostname, { slug, tenantPaths, project });
        }
    }
    return map;
}

/** How long the router trusts its index. Same five seconds as the other caches. */
const INDEX_MS = 5000;

let index = { at: 0, map: new Map() };
let router = null;

/** Reads every tenant's projects, at most once every five seconds. */
function hostIndex({ pathsFor, tenantsRoot }) {
    if (index.map.size && (Date.now() - index.at) < INDEX_MS) return index.map;

    const tenants = projectStore.tenantsWithProjects(tenantsRoot(), pathsFor).map(({ slug, tenantPaths }) => ({
        slug,
        tenantPaths,
        projects: projectStore.listProjects(tenantPaths)
    }));
    index = { at: Date.now(), map: buildHostIndex(tenants) };
    return index.map;
}

/** Forgets the index, so a saved host name answers on the next request. */
function invalidateHostIndex() {
    index = { at: 0, map: new Map() };
}

/**
 * The shared listener. Returns null when this install did not ask for one.
 *
 * TLS is one certificate for the whole listener, from
 * `AEGIS_SITES_ROUTER_CERT` and `AEGIS_SITES_ROUTER_KEY`, which is what a
 * wildcard certificate for an internal domain is for. A certificate per name
 * through SNI is the better answer the day one host needs its own, and it is
 * not this day.
 */
function startRouter({ pathsFor, tenantsRoot }) {
    if (router) return router;

    const port = Number(process.env.AEGIS_SITES_ROUTER_PORT || 0);
    if (!port) return null;

    let tlsOptions = null;
    const cert = process.env.AEGIS_SITES_ROUTER_CERT;
    const keyFile = process.env.AEGIS_SITES_ROUTER_KEY;
    if (cert && keyFile) {
        try {
            tlsOptions = { cert: fs.readFileSync(cert), key: fs.readFileSync(keyFile) };
        } catch (e) {
            // Fail closed, same as a site's own certificate: a listener that
            // came up in clear where HTTPS was configured would look like it
            // worked while sending every login form's password unprotected.
            console.error(`[Deploy] host router not started: certificate could not be read: ${e.message}`);
            return null;
        }
    }

    const onRequest = (req, res) => {
        try {
            const host = hostOf(req);
            const hit = host ? hostIndex({ pathsFor, tenantsRoot }).get(host) : null;
            if (!hit) {
                // Named, and deliberately not a redirect to anything: a name
                // nobody claimed has no right answer.
                return send(res, 404, 'No site is published under this name');
            }
            handle(req, res, {
                slug: hit.slug,
                tenantPaths: hit.tenantPaths,
                project: { id: hit.project.id, name: hit.project.name || hit.project.id },
                runtime: hit.project.runtime === 'node' ? 'node' : 'static',
                root: projectStore.currentDir(hit.tenantPaths, hit.project.id)
            });
        } catch (e) {
            console.error(`[Deploy] host router: request failed: ${e.message}`);
            if (!res.headersSent) send(res, 500, 'Internal error');
        }
    };

    router = tlsOptions ? https.createServer(tlsOptions, onRequest) : http.createServer(onRequest);
    if (tlsOptions) {
        router.on('tlsClientError', (e) => {
            console.warn(`[Deploy] host router: TLS handshake failed: ${e.message}`);
        });
    }
    router.on('error', (e) => {
        console.error(`[Deploy] host router could not listen on ${port}: ${e.message}`);
        router = null;
    });
    router.listen(port, '0.0.0.0', () => {
        console.log(`[Deploy] host router on ${tlsOptions ? 'https' : 'http'}://0.0.0.0:${port}/, routing by Host`);
    });
    return router;
}

/** The port the router answers on, or null. Read by the routes for a site's URL. */
function routerPort() {
    return Number(process.env.AEGIS_SITES_ROUTER_PORT || 0) || null;
}

/** Whether the router is serving TLS, so a URL can name the right scheme. */
function routerIsTls() {
    return !!(process.env.AEGIS_SITES_ROUTER_CERT && process.env.AEGIS_SITES_ROUTER_KEY);
}

module.exports = {
    startSiteFor, stopSiteFor, restartSiteFor, startAllSites, allocatePort,
    resolveFile, tlsOptionsFor,
    startRouter, routerPort, routerIsTls, invalidateHostIndex,
    touchSite, lastTouch, proxyTo, withoutHopByHop,
    IDENTITY_HEADERS, stripIdentity, encodeIdentity,
    normaliseHostname, hostOf, buildHostIndex, HOSTNAME_RE,
    DEFAULT_PORT_BASE, PORT_RANGE, portBase, isServing };
