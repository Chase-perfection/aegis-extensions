/**
 * Where a site's audience lives on disk, and the report read from it.
 *
 *   <tenant>/deploy/audience/
 *     key.json                    the HMAC key of audience.visitorId, encrypted
 *     <project>/raw/<day>.jsonl   one line per accepted event, kept 90 days
 *     <project>/days/<day>.json   the summary of a closed day, kept 760 days
 *
 * Files per day rather than a table (Paul's choice, 2026-11-24): it is how
 * Deploy already keeps a tenant's state, it needs no schema in core, and
 * removing a project removes one folder. A day is a local calendar day of the
 * server.
 *
 * A raw line is written by appending, through one promise queue per file, so
 * two batches arriving together never interleave half lines. A line that does
 * not parse (a crash mid-write) is skipped on reading, never fatal.
 *
 * The key is 32 random bytes sealed with `machineStore.encrypt`, the way the
 * directory password is. A key that no longer decrypts (machine key rotated)
 * is replaced: every visitor then counts as new, which is the whole cost.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const machineStore = require('./machineStore');
const projectStore = require('./projectStore');
const audience = require('./audience');
const report = require('./audienceReport');

const RAW_DAYS = 90;
const SUMMARY_DAYS = 760;
const EXACT_DAYS = 90;
const LIST_MAX = 100;
const DAY_CAP = 500;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const dayOf = audience.localDay;

function parseDay(day) {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d);
}

function addDays(day, n) {
    const d = parseDay(day);
    d.setDate(d.getDate() + n);
    return dayOf(d.getTime());
}

function daysFrom(from, to) {
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
}

function rootFor(tenantPaths) {
    return path.join(projectStore.deployRoot(tenantPaths), 'audience');
}

function dirFor(tenantPaths, projectId) {
    if (!projectStore.PROJECT_ID_RE.test(String(projectId || ''))) throw new Error('not a project id');
    return path.join(rootFor(tenantPaths), projectId);
}

const keys = new Map();

function keyFor(tenantPaths) {
    const file = path.join(rootFor(tenantPaths), 'key.json');
    const hit = keys.get(file);
    if (hit) return hit;
    let key = null;
    try {
        const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
        const hex = stored && stored.v === 1 ? machineStore.decrypt(stored.key) : null;
        if (hex && /^[0-9a-f]{64}$/.test(hex)) key = Buffer.from(hex, 'hex');
        else console.warn(`[Deploy] ${file} no longer decrypts; a new audience key starts, and every visitor counts as new`);
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[Deploy] ${file} is unreadable (${e.message}); a new audience key starts`);
    }
    if (!key) {
        key = crypto.randomBytes(32);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ v: 1, key: machineStore.encrypt(key.toString('hex')) }));
    }
    keys.set(file, key);
    return key;
}

const queues = new Map();

/** Appends lines to the raw file of the day each one carries. */
function append(tenantPaths, projectId, lines) {
    const dir = path.join(dirFor(tenantPaths, projectId), 'raw');
    const byFile = new Map();
    for (const l of lines) {
        const file = path.join(dir, dayOf(l.t) + '.jsonl');
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file).push(JSON.stringify(l));
    }
    const writes = [...byFile].map(([file, text]) => {
        const prev = queues.get(file) || Promise.resolve();
        const next = prev.then(async () => {
            await fs.promises.mkdir(dir, { recursive: true });
            await fs.promises.appendFile(file, text.join('\n') + '\n');
        }).catch((e) => {
            console.warn(`[Deploy] audience write to ${file} failed: ${e.message}`);
        });
        queues.set(file, next);
        next.then(() => { if (queues.get(file) === next) queues.delete(file); });
        return next;
    });
    return Promise.all(writes).then(() => undefined);
}

function readRaw(tenantPaths, projectId, day) {
    let text;
    try {
        text = fs.readFileSync(path.join(dirFor(tenantPaths, projectId), 'raw', day + '.jsonl'), 'utf8');
    } catch (_) { return []; }
    const out = [];
    for (const line of text.split('\n')) {
        if (!line) continue;
        try {
            const l = JSON.parse(line);
            if (l && typeof l.t === 'number' && typeof l.vis === 'string') out.push(l);
        } catch (_) { /* a half line from a crash */ }
    }
    return out;
}

function listDays(dir, ext) {
    try {
        return fs.readdirSync(dir)
            .filter((f) => f.endsWith(ext) && DAY_RE.test(f.slice(0, -ext.length)))
            .map((f) => f.slice(0, -ext.length))
            .sort();
    } catch (_) { return []; }
}

function emptyDay(day) {
    return { day, visitors: 0, visits: 0, activeMs: 0, sketch: '', pages: {}, components: {} };
}

/** Lines of `day` with the day before and after, which the visit rules need. */
function linesAround(tenantPaths, projectId, from, to) {
    const out = [];
    for (const d of daysFrom(addDays(from, -1), addDays(to, 1))) out.push(...readRaw(tenantPaths, projectId, d));
    return out;
}

/** Writes the summary of every closed day that has raw lines and no summary yet. */
function close(tenantPaths, projectId, today) {
    const dir = dirFor(tenantPaths, projectId);
    const done = new Set(listDays(path.join(dir, 'days'), '.json'));
    let written = 0;
    for (const day of listDays(path.join(dir, 'raw'), '.jsonl')) {
        if (day >= today || done.has(day)) continue;
        const s = report.summarize(linesAround(tenantPaths, projectId, day, day), { dayOf, inRange: (d) => d === day });
        const summary = report.capDay(s.byDay[day] || emptyDay(day), DAY_CAP);
        fs.mkdirSync(path.join(dir, 'days'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'days', day + '.json'), JSON.stringify(summary));
        written++;
    }
    return written;
}

function purge(tenantPaths, projectId, today) {
    const dir = dirFor(tenantPaths, projectId);
    const rawBefore = addDays(today, -RAW_DAYS);
    const daysBefore = addDays(today, -SUMMARY_DAYS);
    for (const d of listDays(path.join(dir, 'raw'), '.jsonl')) {
        if (d < rawBefore) fs.rmSync(path.join(dir, 'raw', d + '.jsonl'), { force: true });
    }
    for (const d of listDays(path.join(dir, 'days'), '.json')) {
        if (d < daysBefore) fs.rmSync(path.join(dir, 'days', d + '.json'), { force: true });
    }
}

function removeProject(tenantPaths, projectId) {
    fs.rmSync(dirFor(tenantPaths, projectId), { recursive: true, force: true });
}

/** The projects of a tenant that have an audience folder. */
function projectsWithData(tenantPaths) {
    try {
        return fs.readdirSync(rootFor(tenantPaths), { withFileTypes: true })
            .filter((e) => e.isDirectory() && projectStore.PROJECT_ID_RE.test(e.name))
            .map((e) => e.name);
    } catch (_) { return []; }
}

function readSummary(dir, day) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'days', day + '.json'), 'utf8')); } catch (_) { return null; }
}

function fillSeries(from, to, rows) {
    const known = new Map(rows.map((r) => [r.day, r]));
    return daysFrom(from, to).map((day) => {
        const r = known.get(day);
        return r
            ? { day, visitors: r.visitors, visits: r.visits, activeMs: r.activeMs }
            : { day, visitors: 0, visits: 0, activeMs: 0 };
    });
}

/**
 * The report for `from`..`to`, both included. Within the last 90 days it is
 * computed from the raw lines and its visitors are exact. Further back it is
 * the day summaries plus today's raw lines, and its visitors are the merged
 * sketches, an estimate.
 */
function rawBytes(tenantPaths, projectId, from, to) {
    const dir = path.join(dirFor(tenantPaths, projectId), 'raw');
    let total = 0;
    for (const d of daysFrom(addDays(from, -1), addDays(to, 1))) {
        try { total += fs.statSync(path.join(dir, d + '.jsonl')).size; } catch (_) { /* no file that day */ }
    }
    return total;
}

/*
 * The raw files are read whole and synchronously. Past this many bytes for one
 * report, the report is built from the day summaries instead, an estimate,
 * rather than holding the request and the memory of a very busy site.
 */
const RAW_BUDGET = 64 * 1024 * 1024;

function report_(tenantPaths, projectId, from, to, today, opts) {
    const budget = (opts && opts.rawBudget) || RAW_BUDGET;
    if (from >= addDays(today, -(EXACT_DAYS - 1)) && rawBytes(tenantPaths, projectId, from, to) <= budget) {
        const s = report.summarize(linesAround(tenantPaths, projectId, from, to), {
            dayOf, inRange: (d) => d >= from && d <= to
        });
        return {
            from, to, visitorsPrecision: 'day', totals: s.totals,
            series: fillSeries(from, to, Object.values(s.byDay)),
            pages: s.pages.slice(0, LIST_MAX), components: s.components.slice(0, LIST_MAX)
        };
    }
    close(tenantPaths, projectId, today);
    const dir = dirFor(tenantPaths, projectId);
    const summaries = [];
    const lastClosed = to < today ? to : addDays(today, -1);
    for (const d of listDays(path.join(dir, 'days'), '.json')) {
        if (d < from || d > lastClosed) continue;
        const s = readSummary(dir, d);
        if (s) summaries.push(s);
    }
    if (to >= today) {
        const live = report.summarize(linesAround(tenantPaths, projectId, today, today), { dayOf, inRange: (d) => d === today });
        if (live.byDay[today]) summaries.push(live.byDay[today]);
    }
    const c = report.combine(summaries);
    return {
        from, to, visitorsPrecision: 'estimate', totals: c.totals,
        series: fillSeries(from, to, c.series),
        pages: c.pages.slice(0, LIST_MAX), components: c.components.slice(0, LIST_MAX)
    };
}

module.exports = {
    RAW_DAYS, SUMMARY_DAYS, EXACT_DAYS,
    dirFor, keyFor, append, readRaw, close, purge, removeProject, projectsWithData,
    report: report_, dayOf, addDays, parseDay,
    _forgetKeys: () => keys.clear()
};
