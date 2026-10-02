/**
 * The extension's tables, in the per-tenant database core hands over.
 *
 * `extensionDb.withRequest(req, fn)` gives `fn` a handle with `run`, `get`,
 * `all` and `exec`, opened on `<tenant data>/extensions/account-tiering/
 * extension.db`. Today that is SQLite through the `sqlite3` package. Core runs
 * its own databases on Postgres in tests and may hand an extension Postgres one
 * day, so the SQL here is the subset both accept:
 * - `?` placeholders, which core's Postgres driver rewrites;
 * - ids minted with `crypto.randomUUID()` rather than read back from
 *   `lastID` or `RETURNING`, so no insert depends on the engine;
 * - `TEXT` and `INTEGER` columns only, ISO-8601 timestamps as text;
 * - `INSERT ... ON CONFLICT (...) DO UPDATE`, which both engines know.
 *
 * The schema is created on the first use of each handle. A handle is cached by
 * core and may be evicted and reopened, so "first use" can happen while a scan
 * runs in this process: `activeScans` keeps that scan from being marked as
 * interrupted. A `running` row nobody in this process owns is left over from a
 * service that stopped mid-scan.
 */

'use strict';

const crypto = require('crypto');

const KEEP_SCANS = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scans (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    error_code TEXT,
    domain TEXT,
    facts_json TEXT
);
CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL,
    pattern TEXT NOT NULL,
    tier INTEGER NOT NULL,
    created_by TEXT,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS overrides (
    sid TEXT PRIMARY KEY,
    tier INTEGER NOT NULL,
    reason TEXT NOT NULL,
    set_by TEXT,
    set_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS remediations (
    sid TEXT PRIMARY KEY,
    proposed_by TEXT,
    proposed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
`;

const ready = new WeakMap();
const queues = new WeakMap();
const activeScans = new Set();

const now = () => new Date().toISOString();

/**
 * One piece of work at a time per handle, reads included. The handle is one
 * connection shared by every request of the tenant: a plain statement from
 * another request that ran between BEGIN and COMMIT would be rolled back with
 * the transaction, and a read there would see the rules half replaced.
 */
function serialized(db, work) {
    const previous = queues.get(db) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    queues.set(db, next);
    return next;
}

/** Exports `fn` with its database work behind the handle's queue. */
const queued = (fn) => (db, ...args) => serialized(db, () => fn(db, ...args));

/**
 * Called only from inside a queued function, so it must not queue again: it
 * would wait on itself. A ROLLBACK that fails too is logged, and the error
 * that caused it is the one the caller sees.
 */
async function transaction(db, work) {
    await db.exec('BEGIN');
    try {
        const result = await work();
        await db.exec('COMMIT');
        return result;
    } catch (error) {
        try {
            await db.exec('ROLLBACK');
        } catch (rollbackError) {
            console.error('[account-tiering] rollback', rollbackError);
        }
        throw error;
    }
}

async function setUp(db) {
    await db.exec(SCHEMA);
    const active = [...activeScans];
    const notActive = active.length ? ` AND id NOT IN (${active.map(() => '?').join(', ')})` : '';
    await db.run(
        `UPDATE scans SET status = 'failed', error_code = 'scan_interrupted', finished_at = ? WHERE status = 'running'${notActive}`,
        [now(), ...active]
    );
}

/**
 * The schema, once per handle. The promise is what is kept, so two first
 * requests share one set-up instead of each closing `running` rows with its
 * own, possibly stale, view of `activeScans`. A set-up that fails is forgotten
 * and the next request tries again.
 */
function ensure(db) {
    if (!ready.has(db)) {
        const setting = serialized(db, () => setUp(db));
        ready.set(db, setting);
        setting.catch(() => ready.delete(db));
    }
    return ready.get(db);
}

/**
 * The scan running in this process, if any. `ensure` runs once per handle, so
 * a row left `running` after it (a finish that threw in the background) would
 * otherwise block every later scan until a restart. Any running row this
 * process does not own is therefore closed here, where the question is asked.
 */
async function runningScan(db) {
    const rows = await db.all("SELECT id, started_at, status, domain FROM scans WHERE status = 'running' ORDER BY started_at DESC");
    let owned;
    for (const row of rows) {
        if (activeScans.has(row.id)) {
            if (!owned) owned = row;
        } else {
            await db.run(
                "UPDATE scans SET status = 'failed', error_code = 'scan_interrupted', finished_at = ? WHERE id = ? AND status = 'running'",
                [now(), row.id]
            );
        }
    }
    return owned;
}

/**
 * The id is owned before the row exists: a reopened handle's `ensure` that
 * ran between the INSERT and the `add` would close a scan that is running.
 */
async function startScan(db, domain) {
    const id = crypto.randomUUID();
    activeScans.add(id);
    try {
        await db.run("INSERT INTO scans (id, started_at, status, domain) VALUES (?, ?, 'running', ?)", [id, now(), domain || null]);
    } catch (error) {
        activeScans.delete(id);
        throw error;
    }
    return id;
}

const LATEST_SHOWN = "SELECT id FROM scans WHERE status IN ('ok', 'partial') ORDER BY started_at DESC LIMIT 1";

async function finishScan(db, id, { status, errorCode = null, facts = null }) {
    try {
        await db.run(
            'UPDATE scans SET status = ?, error_code = ?, finished_at = ?, facts_json = ? WHERE id = ?',
            [status, errorCode, now(), facts ? JSON.stringify(facts) : null, id]
        );
        // Keep the newest scans, and the newest one with facts: a run of
        // failures must not delete the only model the page can still show.
        await db.run(
            `DELETE FROM scans WHERE id NOT IN (SELECT id FROM scans ORDER BY started_at DESC LIMIT ${KEEP_SCANS})
             AND id NOT IN (${LATEST_SHOWN})`
        );
        // The facts are the whole directory graph and only the newest shown
        // scan is ever read: older rows keep their status as history.
        await db.run(`UPDATE scans SET facts_json = NULL WHERE facts_json IS NOT NULL AND id NOT IN (${LATEST_SHOWN})`);
    } finally {
        activeScans.delete(id);
    }
}

async function latestScan(db) {
    return db.get('SELECT id, started_at, finished_at, status, error_code, domain FROM scans ORDER BY started_at DESC LIMIT 1');
}

/** The last scan whose facts can be shown: `ok`, or `partial` with some objects unread. */
async function latestFacts(db) {
    const row = await db.get(
        "SELECT id, facts_json FROM scans WHERE status IN ('ok', 'partial') ORDER BY started_at DESC LIMIT 1"
    );
    return row ? { id: row.id, facts: JSON.parse(row.facts_json) } : null;
}

/** The id `latestFacts` would return, without reading or parsing the facts. */
async function latestFactsId(db) {
    const row = await db.get(LATEST_SHOWN);
    return row ? row.id : null;
}

/** That scan's facts, or null once a newer scan has taken them over. */
async function factsById(db, id) {
    const row = await db.get('SELECT facts_json FROM scans WHERE id = ?', [id]);
    return row && row.facts_json ? JSON.parse(row.facts_json) : null;
}

async function getRules(db) {
    return db.all('SELECT id, position, kind, pattern, tier, created_by, updated_at FROM rules ORDER BY position');
}

async function replaceRules(db, rules, by) {
    return transaction(db, async () => {
        await db.run('DELETE FROM rules');
        const at = now();
        for (const [position, rule] of rules.entries()) {
            await db.run(
                'INSERT INTO rules (id, position, kind, pattern, tier, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [crypto.randomUUID(), position, rule.kind, rule.pattern, rule.tier, by || null, at]
            );
        }
    });
}

async function getOverrides(db) {
    return db.all('SELECT sid, tier, reason, set_by, set_at FROM overrides ORDER BY sid');
}

async function setOverride(db, sid, { tier, reason, by }) {
    await db.run(
        `INSERT INTO overrides (sid, tier, reason, set_by, set_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (sid) DO UPDATE SET tier = excluded.tier, reason = excluded.reason, set_by = excluded.set_by, set_at = excluded.set_at`,
        [sid, tier, reason, by || null, now()]
    );
}

async function deleteOverride(db, sid) {
    await db.run('DELETE FROM overrides WHERE sid = ?', [sid]);
}

async function getRemediations(db) {
    return db.all('SELECT sid, proposed_by, proposed_at FROM remediations ORDER BY sid');
}

async function markRemediation(db, sid, by) {
    await db.run(
        `INSERT INTO remediations (sid, proposed_by, proposed_at) VALUES (?, ?, ?)
         ON CONFLICT (sid) DO UPDATE SET proposed_by = excluded.proposed_by, proposed_at = excluded.proposed_at`,
        [sid, by || null, now()]
    );
}

const DEFAULT_SETTINGS = { domain: null, passes: 3 };

async function getSettings(db) {
    const rows = await db.all('SELECT key, value FROM settings');
    const out = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
        if (row.key === 'domain') out.domain = row.value || null;
        if (row.key === 'passes') out.passes = Number(row.value);
    }
    return out;
}

async function putSettings(db, { domain, passes }) {
    return transaction(db, async () => {
        for (const [key, value] of [['domain', domain || ''], ['passes', String(passes)]]) {
            await db.run(
                'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
                [key, value]
            );
        }
    });
}

// Every export goes through the handle's queue; the functions above call one
// another only unqueued, so nothing waits on its own place in the queue.
const exported = {
    runningScan, startScan, finishScan, latestScan, latestFacts, latestFactsId, factsById,
    getRules, replaceRules, getOverrides, setOverride, deleteOverride,
    getRemediations, markRemediation, getSettings, putSettings
};
module.exports = { ensure, KEEP_SCANS };
for (const [name, fn] of Object.entries(exported)) module.exports[name] = queued(fn);
