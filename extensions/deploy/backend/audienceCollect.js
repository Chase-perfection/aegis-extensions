/**
 * `POST /__aegis/audience`: where the audience script of a page posts.
 *
 * Reached from siteServer.serve once the guard let the request through: on a
 * protected site that means the visitor has a session (siteAuth.gate answers
 * 204 to anyone without one). Its own checks, in this order, each answering
 * before anything is read further:
 *
 *   1. audience off for this project: 204, nothing written;
 *   2. not a POST: 405;
 *   3. Origin, or Sec-Fetch-Site, not this site: 403. The same rule as the
 *      sign-in form (siteAuth.fromOwnOrigin), and the reason no CSRF token is
 *      needed: sendBeacon cannot set one;
 *   4. a body over 16 KiB: 413; one that does not parse: 400;
 *   5. a known robot: 204, nothing written;
 *   6. the limits of audience.createLimiter, then the lines are written with
 *      the server's clock and the visitor's pseudonym.
 *
 * The answer is an empty 204 either way the batch went, and never names what
 * was kept: a page has no use for it, and a prober should learn nothing.
 */

'use strict';

const siteAuth = require('./siteAuth');
const siteConfig = require('./siteConfig');
const audience = require('./audience');
const audienceStore = require('./audienceStore');

const limiter = audience.createLimiter();
/** The last day a batch was taken per project, so a new day closes the old. */
const lastDay = new Map();

function answer(res, status, extra) {
    if (res.headersSent) return;
    res.writeHead(status, Object.assign({ 'Cache-Control': 'no-store', 'Content-Length': 0 }, extra || {}));
    res.end();
}

/** The body, or null when it is longer than the limit (the read stops there). */
function readBody(req, max) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        let over = false;
        req.on('data', (c) => {
            if (over) return;
            size += c.length;
            if (size > max) { over = true; resolve(null); return; }
            chunks.push(c);
        });
        req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
        req.on('error', () => { if (!over) { over = true; resolve(null); } });
    });
}

/** A new day for this project: summarise the days that closed, purge the old. */
function closeIfNewDay(ctx, today) {
    const key = `${ctx.slug}/${ctx.project.id}`;
    if (lastDay.get(key) === today) return;
    lastDay.set(key, today);
    try {
        audienceStore.close(ctx.tenantPaths, ctx.project.id, today);
        audienceStore.purge(ctx.tenantPaths, ctx.project.id, today);
    } catch (e) {
        console.warn(`[Deploy] ${ctx.slug}/${ctx.project.id}: audience close failed: ${e.message}`);
    }
}

async function serveAudience(req, res, ctx) {
    const settings = siteConfig.settingsFor(ctx.slug, ctx.tenantPaths, ctx.project.id);
    if (!settings.audience || !settings.audience.enabled) { req.resume(); return answer(res, 204); }
    if (req.method !== 'POST') { req.resume(); return answer(res, 405, { Allow: 'POST' }); }
    if (!siteAuth.fromOwnOrigin(req)) { req.resume(); return answer(res, 403); }

    const body = await readBody(req, audience.LIMITS.body);
    if (body === null) return answer(res, 413);
    const parsed = audience.parseBatch(body);
    if (parsed.error) return answer(res, parsed.error === 'too_large' ? 413 : 400);
    if (audience.isBot(req.headers['user-agent'])) return answer(res, 204);

    const projectId = ctx.project.id;
    let identity = null;
    try { identity = siteAuth.identityFor(req, ctx); } catch (_) { identity = null; }
    let setCookie = null;
    let who;
    if (identity && identity.username) {
        who = { username: identity.username };
    } else {
        let value = siteAuth.readCookie(req, audience.cookieName(projectId));
        if (!value || !audience.COOKIE_RE.test(value)) {
            value = audience.newCookieValue();
            setCookie = audience.cookieHeader(projectId, value, req.socket && req.socket.encrypted === true);
        }
        who = { cookie: value };
    }

    let key;
    try { key = audienceStore.keyFor(ctx.tenantPaths); } catch (e) {
        console.warn(`[Deploy] ${ctx.slug}/${projectId}: audience key unavailable: ${e.message}`);
        return answer(res, 204);
    }
    const vis = audience.visitorId(key, projectId, who);
    const now = Date.now();
    closeIfNewDay(ctx, audience.localDay(now));
    const kept = limiter.admit(ctx.slug, projectId, vis, parsed.events);
    if (kept.length) {
        await audienceStore.append(ctx.tenantPaths, projectId, kept.map((e) => Object.assign({ t: now, vis }, e)));
    }
    return answer(res, 204, setCookie ? { 'Set-Cookie': setCookie } : null);
}

module.exports = { serveAudience };
