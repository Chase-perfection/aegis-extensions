/**
 * Audience arithmetic: raw lines into visits, durations and totals.
 *
 * Pure. No file, no clock: audienceStore.js reads the lines and decides which
 * days a question covers. Two definitions carry everything else, both from the
 * design (docs/superpowers/specs/2026-11-24-deploy-site-audience-design.md):
 *
 *   - a visit is a run of one visitor's events with no gap over 30 minutes. It
 *     belongs to the day of its first event, so a visit that runs past
 *     midnight is counted once, on the day it started;
 *   - a visit lasts the sum, over its page views, of the largest active time
 *     each view reported. The script sends a running total per view, so the
 *     largest is the last one that arrived.
 *
 * Visitors of a day, a page or a component are the distinct visitors with at
 * least one event there. A day summary keeps their count and an anonymous
 * sketch (hll.js), never their ids: it is what survives past 90 days.
 */

'use strict';

const hll = require('./hll');

const VISIT_GAP_MS = 30 * 60 * 1000;
const OTHERS = '(autres)';
const SEP = '\u0000';

function byViewsThenPath(a, b) { return b.views - a.views || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0); }
function byClicksThenName(a, b) { return b.clicks - a.clicks || (a.path + a.name < b.path + b.name ? -1 : 1); }

function newDay(day) {
    return { day, vis: new Set(), visits: 0, activeMs: 0, pages: new Map(), comps: new Map() };
}

function pageOf(agg, path) {
    let p = agg.pages.get(path);
    if (!p) { p = { views: 0, vis: new Set(), activeMs: 0 }; agg.pages.set(path, p); }
    return p;
}

function compOf(agg, key) {
    let c = agg.comps.get(key);
    if (!c) { c = { clicks: 0, vis: new Set() }; agg.comps.set(key, c); }
    return c;
}

/**
 * `lines` may cover more days than the question: the day before (for the
 * visits that started then) and the day after (for those still running at
 * midnight). Only days for which `inRange(day)` is true are counted.
 */
function summarize(lines, { dayOf, inRange }) {
    const sorted = lines.slice().sort((a, b) => a.t - b.t);
    const days = new Map();
    const dayAgg = (d) => { let a = days.get(d); if (!a) { a = newDay(d); days.set(d, a); } return a; };

    // Each page view: the day and path of its first line, its largest time.
    const views = new Map();
    for (const l of sorted) {
        const key = l.vis + SEP + l.pv;
        let pv = views.get(key);
        if (!pv) { pv = { day: dayOf(l.t), path: l.p, t: l.t, ms: 0 }; views.set(key, pv); }
        if (l.k === 'time' && l.ms > pv.ms) pv.ms = l.ms;

        const d = dayOf(l.t);
        if (!inRange(d)) continue;
        const agg = dayAgg(d);
        agg.vis.add(l.vis);
        if (l.k === 'view') {
            const page = pageOf(agg, l.p);
            page.views++;
            page.vis.add(l.vis);
        } else if (l.k === 'click') {
            const comp = compOf(agg, l.p + SEP + l.c);
            comp.clicks++;
            comp.vis.add(l.vis);
        }
    }

    for (const pv of views.values()) {
        if (inRange(pv.day) && pv.ms > 0) pageOf(dayAgg(pv.day), pv.path).activeMs += pv.ms;
    }

    // Visits, per visitor, in time order. A view belongs to the visit its first
    // line falls in.
    const perVisitor = new Map();
    for (const [key, pv] of views) {
        const vis = key.slice(0, key.indexOf(SEP));
        if (!perVisitor.has(vis)) perVisitor.set(vis, []);
        perVisitor.get(vis).push(pv);
    }
    // Every event time of each visitor, in order, to find the gaps.
    const timesOf = new Map();
    for (const l of sorted) {
        if (!timesOf.has(l.vis)) timesOf.set(l.vis, []);
        timesOf.get(l.vis).push(l.t);
    }
    for (const [vis, pvs] of perVisitor) {
        const times = timesOf.get(vis);
        const starts = [times[0]];
        for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > VISIT_GAP_MS) starts.push(times[i]);
        const visits = starts.map((t) => ({ t, ms: 0 }));
        for (const pv of pvs) {
            let at = 0;
            while (at + 1 < visits.length && visits[at + 1].t <= pv.t) at++;
            visits[at].ms += pv.ms;
        }
        for (const visit of visits) {
            const d = dayOf(visit.t);
            if (!inRange(d)) continue;
            const agg = dayAgg(d);
            agg.visits++;
            agg.activeMs += visit.ms;
        }
    }

    return shape(days);
}

function shape(days) {
    const byDay = {};
    const all = new Set();
    const pages = new Map();
    const comps = new Map();
    let visits = 0;
    let activeMs = 0;
    for (const agg of [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1))) {
        const sketch = hll.create();
        for (const v of agg.vis) { hll.add(sketch, v); all.add(v); }
        visits += agg.visits;
        activeMs += agg.activeMs;
        const dayPages = {};
        for (const [path, p] of agg.pages) {
            dayPages[path] = { views: p.views, visitors: p.vis.size, activeMs: p.activeMs };
            const total = pages.get(path) || { views: 0, vis: new Set(), activeMs: 0 };
            total.views += p.views;
            total.activeMs += p.activeMs;
            p.vis.forEach((v) => total.vis.add(v));
            pages.set(path, total);
        }
        const dayComps = {};
        for (const [key, c] of agg.comps) {
            dayComps[key] = { clicks: c.clicks, visitors: c.vis.size };
            const total = comps.get(key) || { clicks: 0, vis: new Set() };
            total.clicks += c.clicks;
            c.vis.forEach((v) => total.vis.add(v));
            comps.set(key, total);
        }
        byDay[agg.day] = {
            day: agg.day, visitors: agg.vis.size, visits: agg.visits, activeMs: agg.activeMs,
            sketch: hll.encode(sketch), pages: dayPages, components: dayComps
        };
    }
    return {
        byDay,
        totals: totalsOf(all.size, visits, activeMs),
        pages: [...pages].map(([path, p]) => ({ path, views: p.views, visitors: p.vis.size, activeMs: p.activeMs })).sort(byViewsThenPath),
        components: [...comps].map(([key, c]) => compRow(key, c.clicks, c.vis.size)).sort(byClicksThenName)
    };
}

function totalsOf(visitors, visits, activeMs) {
    return { visitors, visits, activeMs, avgVisitMs: visits ? Math.round(activeMs / visits) : 0 };
}

function compRow(key, clicks, visitors) {
    const at = key.indexOf(SEP);
    return { path: key.slice(0, at), name: key.slice(at + 1), clicks, visitors };
}

function fold(entries, max, rank, add) {
    if (entries.length <= max) return Object.fromEntries(entries);
    const sorted = entries.slice().sort((a, b) => rank(b[1]) - rank(a[1]));
    const kept = Object.fromEntries(sorted.slice(0, max));
    kept[OTHERS] = sorted.slice(max).reduce((acc, [, v]) => add(acc, v), null);
    return kept;
}

/** A day summary cut to `max` pages and `max` components, the rest under `(autres)`. */
function capDay(summary, max) {
    const sum = (acc, v) => {
        const out = acc || {};
        for (const k of Object.keys(v)) out[k] = (out[k] || 0) + v[k];
        return out;
    };
    return Object.assign({}, summary, {
        pages: fold(Object.entries(summary.pages || {}), max, (v) => v.views, sum),
        components: fold(Object.entries(summary.components || {}), max, (v) => v.clicks, sum)
    });
}

/**
 * Day summaries into one report. Visitors come from the merged sketches, an
 * estimate; the visitors of a page or a component are added up day by day,
 * which counts a person once per day they came.
 */
function combine(summaries) {
    const sketch = hll.create();
    const pages = new Map();
    const comps = new Map();
    let visits = 0;
    let activeMs = 0;
    const series = [];
    for (const s of summaries.slice().sort((a, b) => (a.day < b.day ? -1 : 1))) {
        const one = hll.decode(s.sketch);
        if (one) hll.merge(sketch, one);
        visits += s.visits || 0;
        activeMs += s.activeMs || 0;
        series.push({ day: s.day, visitors: s.visitors || 0, visits: s.visits || 0, activeMs: s.activeMs || 0 });
        for (const [path, p] of Object.entries(s.pages || {})) {
            const t = pages.get(path) || { views: 0, visitors: 0, activeMs: 0 };
            t.views += p.views || 0; t.visitors += p.visitors || 0; t.activeMs += p.activeMs || 0;
            pages.set(path, t);
        }
        for (const [key, c] of Object.entries(s.components || {})) {
            const t = comps.get(key) || { clicks: 0, visitors: 0 };
            t.clicks += c.clicks || 0; t.visitors += c.visitors || 0;
            comps.set(key, t);
        }
    }
    return {
        series,
        totals: totalsOf(hll.count(sketch), visits, activeMs),
        pages: [...pages].map(([path, p]) => Object.assign({ path }, p)).sort(byViewsThenPath),
        components: [...comps].map(([key, c]) => compRow(key, c.clicks, c.visitors)).sort(byClicksThenName)
    };
}

module.exports = { summarize, capDay, combine, VISIT_GAP_MS, OTHERS };
