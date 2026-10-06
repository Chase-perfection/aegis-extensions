/**
 * Where a project keeps its data: its local folder, or a Postgres database
 * somebody else runs.
 *
 * Deploy runs no database. `docs/plans/0008` chose SQLite in the data folder
 * because Postgres is a second service to operate, and that choice stands: a
 * project that wants Postgres brings its own server, and this module holds the
 * address it brought.
 *
 * The settings sit on the project record, like the variables do, and for the
 * same reason the password goes through `machineStore.encrypt`: `projects.json`
 * lives in a tenant folder. Nothing here ever hands the password back. A page
 * that needs to know whether one is kept reads `hasPassword`.
 *
 * Two rules are structural rather than checked.
 *
 * A preview never gets the database. `runtimeEnv` answers nothing for a record
 * with a `parentId`, and a preview has no storage settings of its own to read,
 * so a branch nobody reviewed cannot be handed the live rows by a forgotten
 * condition somewhere else.
 *
 * An address on the internal network is approved before anything reaches it.
 * The list is a text file beside `machine.key`, in a folder only administrators
 * and the service can write. A database address is still added there by hand,
 * on the host. The one opening a project may hold besides its database
 * (`projectEgress.js`) is approved by the tenant administrator who opens it,
 * from the page, after a confirmation: `approve` writes the line and who asked
 * for it. Asking that administrator to run a command on the server stopped
 * people who had every right to decide and no session on the machine.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const machineStore = require('./machineStore');

const KINDS = new Set(['supabase', 'postgres']);

/**
 * A host name or an IPv4 address.
 *
 * ponytail: no IPv6 literal. The firewall arithmetic in `storageNetwork.js` is
 * IPv4, and an address this module accepted and that one could not open would
 * be a setup that passes every check and then cannot connect.
 */
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/** A database or a role. A Supabase pooler names its user `postgres.<tenant>`. */
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.$-]{0,62}$/;

const MAX_PASSWORD = 1024;
const MAX_URL = 512;

const TARGETS_FILE = 'database-targets.txt';

function refuse(code, message) {
    return Object.assign(new Error(message), { code });
}

/**
 * What was typed, checked and reduced to the fields this module stores.
 *
 * Refuses rather than repairs. A port that became 5432 because the field was
 * empty is a connection to a database nobody named.
 */
function normalise(input) {
    const raw = input || {};

    const kind = String(raw.kind || 'postgres').toLowerCase();
    if (!KINDS.has(kind)) throw refuse('bad_kind', `${raw.kind} is not one of supabase, postgres`);

    const host = String(raw.host || '').trim();
    if (!HOST_RE.test(host)) throw refuse('bad_host', 'the host is a name or an IPv4 address, with no scheme and no port');

    const port = Number(raw.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw refuse('bad_port', 'the port is a number from 1 to 65535');

    const database = String(raw.database || '').trim();
    if (!NAME_RE.test(database)) throw refuse('bad_database', 'the database name is letters, digits, _ . $ and -');

    const user = String(raw.user || '').trim();
    if (!NAME_RE.test(user)) throw refuse('bad_user', 'the user is letters, digits, _ . $ and -');

    return {
        kind, host, port, database, user,
        ssl: raw.ssl === true || raw.ssl === 'true',
        consoleUrl: consoleUrl(raw.consoleUrl)
    };
}

/** The address of the database's own console, or an empty string. Optional. */
function consoleUrl(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    let parsed = null;
    try { parsed = new URL(text); } catch (_) { parsed = null; }
    if (!parsed || text.length > MAX_URL || !/^https?:$/.test(parsed.protocol)) {
        throw refuse('bad_console_url', 'the console address starts with http:// or https://');
    }
    return parsed.href;
}

function storageOf(project) {
    const s = project && project.storage;
    return s && typeof s === 'object' ? s : null;
}

/** `postgres` only when the record says so and names a target. Anything else is local. */
function mode(project) {
    const s = storageOf(project);
    return s && s.mode === 'postgres' && s.host ? 'postgres' : 'local';
}

/** The stored target without its password, or null when none was ever saved. */
function targetOf(project) {
    const s = storageOf(project);
    if (!s || !s.host) return null;
    return {
        kind: s.kind, host: s.host, port: s.port, database: s.database,
        user: s.user, ssl: !!s.ssl, consoleUrl: s.consoleUrl || ''
    };
}

/** The stored password in clear, or null. Read by the checks and the switch, never by a route's answer. */
function passwordOf(project) {
    const s = storageOf(project);
    return s && s.passwordEnc ? machineStore.decrypt(s.passwordEnc) : null;
}

/** One database, as the record remembers having filled it. */
function filledKey(target) {
    return `${target.host}:${target.port}/${target.database}`;
}

/**
 * Whether the rows in the saved target are this project's own.
 *
 * True only for the database a successful switch of this project copied into.
 * That is the one case where a later switch may replace what the tables hold:
 * anywhere else, rows in a target table belong to somebody.
 */
function canReplace(project) {
    const s = storageOf(project);
    const t = targetOf(project);
    return !!(s && t && s.filled && s.filled === filledKey(t));
}

/** What a browser may see. */
function publicView(project) {
    const s = storageOf(project);
    return {
        mode: mode(project),
        target: targetOf(project),
        hasPassword: !!(s && s.passwordEnc),
        canReplace: canReplace(project),
        switchedAt: (s && s.switchedAt) || null,
        switchedBy: (s && s.switchedBy) || null
    };
}

/**
 * The record with this target saved on it.
 *
 * Pure: the caller saves the project. An empty password keeps the one already
 * stored, but only for the same host, port and user, so a password typed for
 * one server is never sent to another because a field was left blank.
 */
function withTarget(project, target, password) {
    const before = storageOf(project) || {};
    const sameServer = before.host === target.host && before.port === target.port && before.user === target.user;

    let passwordEnc = sameServer ? (before.passwordEnc || null) : null;
    if (password) {
        if (String(password).length > MAX_PASSWORD) throw refuse('bad_password', `the password is longer than ${MAX_PASSWORD} characters`);
        passwordEnc = machineStore.encrypt(String(password));
    }

    // A project stays live only on the database a switch checked. Renaming
    // the database under it puts the record back on local files, which is
    // the direction that cannot point a site at rows nobody verified.
    const stillLive = before.mode === 'postgres' && sameServer && before.database === target.database;

    return Object.assign({}, before, target, {
        mode: stillLive ? 'postgres' : 'local',
        passwordEnc
    });
}

/** The record's storage with its mode moved, and who moved it. */
function withMode(project, next, actor) {
    if (next !== 'local' && next !== 'postgres') throw refuse('bad_mode', `${next} is not one of local, postgres`);
    return Object.assign({}, storageOf(project) || {}, {
        mode: next, switchedAt: Date.now(), switchedBy: actor || null
    });
}

/**
 * The address an application connects to.
 *
 * The form every Postgres driver reads. User and password are percent-encoded,
 * because a password holding `@` or `/` would otherwise move the host.
 */
function databaseUrl(target, password) {
    const auth = `${encodeURIComponent(target.user)}:${encodeURIComponent(password || '')}`;
    const query = target.ssl ? '?sslmode=require' : '';
    return `postgresql://${auth}@${target.host}:${target.port}/${encodeURIComponent(target.database)}${query}`;
}

/**
 * What a project's process is given on top of its variables.
 *
 * Empty for a project on local files, for a preview, and for a password that no
 * longer decrypts: a process started with half an address fails on its first
 * query, and one started without the variable fails at boot, where the health
 * check sees it.
 */
function runtimeEnv(project) {
    if (!project || project.parentId || mode(project) !== 'postgres') return {};
    const password = passwordOf(project);
    if (password === null) {
        console.warn(`[Deploy] ${project.id}: the database password could not be decrypted, DATABASE_URL left out`);
        return {};
    }
    return { DATABASE_URL: databaseUrl(targetOf(project), password) };
}

/* ------------------------------------------------------------------ */
/* the approved list                                                   */
/* ------------------------------------------------------------------ */

function targetsFile() {
    return path.join(machineStore.storeDir(), TARGETS_FILE);
}

/**
 * Every `host:port` an administrator approved on this server.
 *
 * Read on each call. The file is a few lines, and reading it again is what lets
 * an approval take effect without restarting the service. A line that is not a
 * target is skipped: one typo must not un-approve the lines around it.
 */
function approvedTargets() {
    let text = '';
    try {
        text = fs.readFileSync(targetsFile(), 'utf8');
    } catch (_) {
        return [];        // no file: nothing is approved
    }
    const out = [];
    for (const line of text.split(/\r?\n/)) {
        const entry = line.replace(/^﻿/, '').split('#')[0].trim();
        if (!entry) continue;
        const cut = entry.lastIndexOf(':');
        const host = cut === -1 ? '' : entry.slice(0, cut).trim();
        const port = cut === -1 ? NaN : Number(entry.slice(cut + 1));
        if (!HOST_RE.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) continue;
        out.push({ host: host.toLowerCase(), port });
    }
    return out;
}

function isApproved(host, port) {
    const name = String(host || '').toLowerCase();
    return approvedTargets().some((t) => t.host === name && t.port === Number(port));
}

/**
 * The one line an administrator runs on the server to approve a target.
 *
 * Built only from a host and a port that passed `normalise`, so neither can
 * carry a quote. `Add-Content` creates the file when it is missing.
 */
function approveCommand(host, port) {
    return `Add-Content -Path '${targetsFile()}' -Value '${host}:${port}'`;
}

/**
 * Adds `host:port` to the approved list, with who asked and when.
 *
 * Appends, never rewrites: the lines an administrator typed on the host stay as
 * they are. The comment is the audit trail that survives the log's rotation.
 * `by` is reduced to what cannot break the line or start a second one.
 * Throws when the file cannot be written; the caller then falls back to the
 * command, which is the one thing still possible on such a host.
 */
function approve(host, port, by) {
    if (isApproved(host, port)) return false;
    const who = String(by || 'unknown').replace(/[^A-Za-z0-9@._/() -]/g, '').slice(0, 160) || 'unknown';
    const file = targetsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let lead = '';
    try {
        const text = fs.readFileSync(file, 'utf8');
        if (text && !/\n$/.test(text)) lead = '\n';
    } catch (_) { lead = ''; }
    fs.appendFileSync(file, `${lead}${host}:${port}  # approved from Aegis by ${who}, ${new Date().toISOString()}\n`);
    return true;
}

module.exports = {
    normalise, mode, targetOf, passwordOf, publicView, withTarget, withMode,
    databaseUrl, runtimeEnv, filledKey, canReplace,
    targetsFile, approvedTargets, isApproved, approveCommand, approve,
    KINDS, HOST_RE, NAME_RE
};
