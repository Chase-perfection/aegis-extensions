/**
 * Audience: what a site's pages may report about their own use, and who sent it.
 *
 * The script the proxy adds to a page (`/__aegis/audience.js`, from
 * `frontend/site-auth/audience.js`) posts batches of three kinds of event to
 * `/__aegis/audience`: a page view, a click on a control, and the active time
 * spent on a view so far. This module is the boundary those batches cross. It
 * decides what is kept from them, how the visitor is named, and how much one
 * visitor or one site may write. It touches no file; audienceStore.js does.
 *
 * What a page sends is the page's claim, and the page may be hostile:
 *   - only known fields survive; the time of an event is the server's;
 *   - a path keeps its path, never its query or fragment, which is where a
 *     search term, a token or a name would ride;
 *   - every text is stripped of control characters and capped;
 *   - an invalid event is dropped and the rest of the batch kept, so one bad
 *     field in a page costs that event and not the visit.
 *
 * The visitor is a pseudonym (Paul's choice, 2026-11-24): an HMAC under a key
 * kept per tenant. On a protected site it is keyed by the username the guard
 * already established, never by anything the page says. On an open site it is
 * keyed by a random cookie Deploy sets, `aegis_aud_<project>`, which the proxy
 * strips before the application on both directions like every `aegis_*`
 * cookie. The project is part of the message, so one person is two unrelated
 * ids on two sites.
 */

'use strict';

const crypto = require('crypto');

const AUDIENCE_PATH = '/__aegis/audience';
const SCRIPT_PATH = '/__aegis/audience.js';

const LIMITS = Object.freeze({
    body: 16 * 1024,
    events: 50,
    path: 200,
    component: 80,
    maxMs: 6 * 3600 * 1000,
    visitorPerMinute: 240,
    sitePerDay: 200000,
    // Time lines of a site per day, apart from views and clicks.
    timePerDay: 400000,
    // A view may report one time line per this much of its age, plus two.
    timeEveryMs: 5 * 1000,
    // A time event may claim at most the view's age plus this much.
    timeSlackMs: 5 * 1000
});

/** 13 months of 30.5 days, never extended: the CNIL exemption's ceiling. */
const COOKIE_MAX_AGE = 396 * 24 * 3600;
const COOKIE_RE = /^[A-Za-z0-9_-]{22}$/;
const PV_RE = /^[a-z0-9]{8,32}$/;
const KINDS = new Set(['view', 'click', 'time']);
const BOT_RE = /bot|crawler|spider|headless|curl|wget|python/i;
// C0, DEL, C1, and the two Unicode line breaks (LS, PS) a log or a cell would
// honour. Built from code points: a literal LS or PS in this source would end
// the line inside a regular expression literal.
const CONTROL_CLASS = '[' + String.fromCharCode(0) + '-' + String.fromCharCode(0x1f)
    + String.fromCharCode(0x7f) + '-' + String.fromCharCode(0x9f) + String.fromCharCode(0x2028, 0x2029) + ']';
const CONTROL_RE = new RegExp(CONTROL_CLASS, 'g');
const HAS_CONTROL_RE = new RegExp(CONTROL_CLASS);

function fail(code, message) {
    return Object.assign(new Error(message), { code });
}

/** A visitor-supplied text, made single-line and bounded. */
function cleanText(raw, max) {
    return String(raw).replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanPath(raw) {
    if (typeof raw !== 'string') return null;
    const p = raw.split('#')[0].split('?')[0];
    if (!p.startsWith('/')) return null;
    if (HAS_CONTROL_RE.test(p)) return null;
    return p.slice(0, LIMITS.path);
}

function cleanEvent(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    if (!KINDS.has(e.k) || typeof e.pv !== 'string' || !PV_RE.test(e.pv)) return null;
    const p = cleanPath(e.p);
    if (!p) return null;
    const out = { k: e.k, pv: e.pv, p };
    if (e.k === 'click') {
        if (typeof e.c !== 'string') return null;
        const c = cleanText(e.c, LIMITS.component);
        if (!c) return null;
        out.c = c;
    }
    if (e.k === 'time') {
        if (!Number.isInteger(e.ms) || e.ms < 0 || e.ms > LIMITS.maxMs) return null;
        out.ms = e.ms;
    }
    return out;
}

/**
 * A request body, made into the events worth keeping, or `{ error }`. The
 * caller reads at most `LIMITS.body + 1` bytes, so a larger body arrives here
 * one byte too long and is refused without being parsed.
 */
function parseBatch(buf) {
    if (!Buffer.isBuffer(buf) || buf.length > LIMITS.body) return { error: 'too_large' };
    let raw;
    try { raw = JSON.parse(buf.toString('utf8')); } catch (_) { return { error: 'bad_json' }; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.events)) return { error: 'bad_json' };
    if (raw.v !== 1) return { error: 'bad_version' };
    if (raw.events.length > LIMITS.events) return { error: 'too_many' };
    return { events: raw.events.map(cleanEvent).filter(Boolean) };
}

function isBot(userAgent) {
    return BOT_RE.test(String(userAgent || ''));
}

/** 16 hex characters naming one visitor of one project. */
function visitorId(key, projectId, who) {
    const message = who && who.username
        ? `u:${projectId}:${String(who.username).toLowerCase()}`
        : `c:${projectId}:${String((who && who.cookie) || '')}`;
    return crypto.createHmac('sha256', key).update(message).digest('hex').slice(0, 16);
}

function newCookieValue() {
    return crypto.randomBytes(16).toString('base64url');
}

function cookieName(projectId) {
    return `aegis_aud_${projectId}`;
}

function cookieHeader(projectId, value, secure) {
    return `${cookieName(projectId)}=${value}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax`
        + (secure ? '; Secure' : '');
}

/** The switch a project keeps, from what a browser sent, or a throw `bad_audience`. */
function normalizeAudience(raw) {
    if (raw === undefined || raw === null) return { enabled: false };
    if (typeof raw !== 'object' || Array.isArray(raw)) throw fail('bad_audience', 'audience is not an object');
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
        throw fail('bad_audience', 'audience.enabled is not a boolean');
    }
    return { enabled: raw.enabled === true };
}

/** The switch a project record holds; off when it holds none or nonsense. */
function configOf(project) {
    try { return normalizeAudience(project ? project.audience : undefined); } catch (_) { return { enabled: false }; }
}

function localDay(t) {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Entries beyond this in any map trigger a sweep of the stale ones. */
const SWEEP_AT = 20000;
/** And at most this often, whatever the size. */
const SWEEP_EVERY_MS = 60 * 1000;
/** A page view's time events are accepted this long after it was seen. */
const PV_TTL_MS = LIMITS.maxMs;

/**
 * The limits, in memory, per process:
 *   - per visitor, `visitorPerMinute` views and clicks in a fixed minute;
 *   - per site, `sitePerDay` views and clicks per local day, with one warning;
 *   - time events, only for a view this process accepted, and only when they
 *     grow: larger than the last one kept for the view, no larger than the
 *     view's age plus `timeSlackMs`. A view keeps at most two time lines plus
 *     one per `timeEveryMs` of its age, and a site `timePerDay` a day. Time
 *     events count in neither of the first two limits, so a visitor at the cap
 *     still gets their duration right, and the last one sent on leaving a page
 *     is kept however soon it follows the previous one.
 * Stale entries are swept at most once per `sweepEveryMs`, so a large map is
 * not walked on every batch. Lost on restart, which forgets a minute of
 * counting and the durations of the views open at that moment.
 */
function createLimiter(opts) {
    const o = opts || {};
    const now = o.now || Date.now;
    const siteCap = o.siteCap || LIMITS.sitePerDay;
    const timeCap = o.timeCap || LIMITS.timePerDay;
    const sweepAt = o.sweepAt || SWEEP_AT;
    const sweepEveryMs = o.sweepEveryMs || SWEEP_EVERY_MS;
    const visitors = new Map();
    const sites = new Map();
    const views = new Map();
    let lastSweep = -Infinity;
    let sweeps = 0;

    function sweepAll(t, minute) {
        if (visitors.size < sweepAt && views.size < sweepAt) return;
        if (t - lastSweep < sweepEveryMs) return;
        lastSweep = t;
        sweeps++;
        for (const [k, v] of visitors) if (v.minute !== minute) visitors.delete(k);
        for (const [k, v] of views) if (t - v.seen > PV_TTL_MS) views.delete(k);
    }

    function admitTime(pv, e, t, today) {
        if (!pv || e.ms <= pv.lastMs || e.ms > t - pv.seen + LIMITS.timeSlackMs) return false;
        if (pv.lines >= 2 + Math.floor((t - pv.seen) / LIMITS.timeEveryMs)) return false;
        if (today.time >= timeCap) return false;
        pv.lastMs = e.ms;
        pv.lines++;
        today.time++;
        return true;
    }

    function admit(slug, projectId, vis, events) {
        const t = now();
        const site = `${slug}/${projectId}`;
        const day = localDay(t);
        const minute = Math.floor(t / 60000);

        sweepAll(t, minute);
        let mine = visitors.get(`${site}/${vis}`);
        if (!mine || mine.minute !== minute) {
            mine = { minute, n: 0 };
            visitors.set(`${site}/${vis}`, mine);
        }
        let today = sites.get(site);
        if (!today || today.day !== day) {
            today = { day, n: 0, time: 0, warned: false };
            sites.set(site, today);
        }

        const kept = [];
        for (const e of events) {
            const pvKey = `${site}/${vis}/${e.pv}`;
            if (e.k === 'time') {
                if (admitTime(views.get(pvKey), e, t, today)) kept.push(e);
                continue;
            }
            if (mine.n >= LIMITS.visitorPerMinute) continue;
            if (today.n >= siteCap) {
                if (!today.warned) {
                    today.warned = true;
                    console.warn(`[Deploy] ${slug}/${projectId}: audience reached ${siteCap} events today; the rest of the day is not counted`);
                }
                continue;
            }
            mine.n++;
            today.n++;
            if (e.k === 'view' && !views.has(pvKey)) views.set(pvKey, { seen: t, lastMs: 0, lines: 0 });
            kept.push(e);
        }
        return kept;
    }

    return { admit, _sweeps: () => sweeps };
}

module.exports = {
    AUDIENCE_PATH, SCRIPT_PATH, LIMITS, COOKIE_RE, COOKIE_MAX_AGE,
    parseBatch, cleanText, isBot, visitorId, newCookieValue, cookieName, cookieHeader,
    normalizeAudience, configOf, createLimiter, localDay
};
