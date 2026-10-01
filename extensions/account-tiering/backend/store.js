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

const ready = new WeakSet();
const writing = new WeakMap();
const activeScans = new Set();

const now = () => new Date().toISOString();

async function ensure(db) {
    if (ready.has(db)) return;
    await db.exec(SCHEMA);
    const active = [...activeScans];
    const notActive = active.length ? ` AND id NOT IN (${active.map(() => '?').join(', ')})` : '';
    await db.run(
        `UPDATE scans SET status = 'failed', error_code = 'scan_interrupted', finished_at = ? WHERE status = 'running'${notActive}`,
        [now(), ...active]
    );
    ready.add(db);
}

/**
 * One write transaction at a time per handle. The handle is one connection
 * shared by every request of the tenant, so two interleaved BEGINs would fail
 * and a ROLLBACK could undo the other request's statements.
 */
function serialized(db, work) {
    const previous = writing.get(db) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    writing.set(db, next);
    return next;
}

async function transaction(db, work) {
    return serialized(db, async () => {
        await db.exec('BEGIN');
        try {
            const result = await work();
            await db.exec('COMMIT');
            return result;
        } catch (error) {
            await db.exec('ROLLBACK');
            throw error;
        }
    });
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

async function startScan(db, domain) {
    const id = crypto.randomUUID();
    await db.run("INSERT INTO scans (id, started_at, status, domain) VALUES (?, ?, 'running', ?)", [id, now(), domain || null]);
    activeScans.add(id);
    return id;
}

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
             AND id NOT IN (SELECT id FROM scans WHERE status IN ('ok', 'partial') ORDER BY started_at DESC LIMIT 1)`
        );
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

module.exports = {
    ensure, runningScan, startScan, finishScan, latestScan, latestFacts,
    getRules, replaceRules, getOverrides, setOverride, deleteOverride,
    getRemediations, markRemediation, getSettings, putSettings,
    KEEP_SCANS
};
