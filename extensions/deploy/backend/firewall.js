/**
 * Opens the host firewall for the port a deployed site listens on.
 *
 * `siteServer` binds `0.0.0.0` because a deployed site is reached from other
 * machines, which is the point of deploying it. On Windows that is not enough:
 * the listener is up and the packets are dropped before they reach it, which
 * shows up in a browser as a timeout rather than as a refusal, and reads like
 * the site being down rather than like a firewall. Aegis opened exactly one
 * port, 3000, in `start-dashboard.ps1`, and nothing ever opened a site's.
 *
 * Four decisions worth stating, because each of them is a way this could have
 * been worse.
 *
 * **Off unless the host says otherwise.** `AEGIS_DEPLOY_FIREWALL=1`, set in the
 * service environment and reachable from no browser, exactly like
 * `AEGIS_DEPLOY_ENABLED` and `AEGIS_DEPLOY_RUNTIME`. Opening a port because a
 * tenant administrator clicked New Project is a privilege the extension would
 * be granting itself, on a machine holding AD audit data. The switch makes it a
 * decision somebody took once, on the host.
 *
 * **One port per project, never a range.** The port is the one `allocatePort`
 * actually handed the project, read from its record. Opening the whole site
 * range would open ninety-nine ports for one site, and would still be wrong the
 * day `AEGIS_SITES_PORT_BASE` moves.
 *
 * **`LocalSubnet` by default, not `Any`.** It is the Windows primitive for "the
 * networks this machine is on", so it needs no subnet arithmetic here and stays
 * correct on a host that is not this one. `AEGIS_DEPLOY_FIREWALL_SCOPE` widens
 * or narrows it for a domain that spans subnets. Profiles are Domain and
 * Private: `Public` is the profile a machine uses on a network it does not
 * trust, and a deployed site has no business following it there.
 *
 * **It never fails a deployment.** Every call returns rather than throws, and a
 * refusal is logged with what to run by hand. A site that is up and unreachable
 * is a problem an operator can see and fix; a deployment rolled back because a
 * firewall call failed is one they cannot.
 *
 * Windows only, and a no-op everywhere else. The same code has to run on a host
 * behind a reverse proxy or a cloud load balancer, where the local firewall is
 * not the door and there is nothing here to do.
 */

'use strict';

const { execFile } = require('child_process');

const projectStore = require('./projectStore');
const machineStore = require('./machineStore');

/** The rule group. Every rule this file owns carries it; nothing else does. */
const GROUP = 'Aegis Deploy';

/** What a rule is called. Parsed back by `reconcile`, so the shape is fixed. */
const NAME_PREFIX = 'Aegis Deploy site: ';

/** Both are `[a-z0-9-]{1,32}`, so a rule name can never carry a metacharacter. */
const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** Windows takes a while to answer when the firewall service is busy. */
const TIMEOUT_MS = 20000;

/** Said once per process, not once per project. */
let announced = false;

/** Replaced only by `_setRunner`, only by the suite. Null everywhere else. */
let runner = null;

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Is there a host firewall here this code knows how to drive?
 *
 * A test runner counts, because it is exactly the platform abstraction this
 * asks about, and the suite runs on Linux in CI. That is not a way in: the
 * switch below still has to be set, in the process environment, and `runner` is
 * null in every build that is not running tests.
 */
function supported() {
    return runner !== null || process.platform === 'win32';
}

function enabled() {
    return supported() && process.env.AEGIS_DEPLOY_FIREWALL === '1';
}

/**
 * The addresses allowed to reach a site.
 *
 * Validated rather than trusted even though it comes from the service
 * environment: it is the one value here that a human types, it ends up in a
 * command that runs as the service account, and a typo that silently became
 * `Any` would expose every site to whatever the machine is plugged into.
 *
 * Accepts what Windows accepts and nothing more: the named scopes, an address,
 * a CIDR block, a range, or a comma-separated list of those. An unusable value
 * is refused back to `LocalSubnet` with a line in the log, because falling back
 * to the narrow answer is the direction that cannot expose anything.
 */
const SCOPE_WORD = /^(LocalSubnet|Any|DNS|DHCP|WINS|DefaultGateway|Internet|Intranet)$/i;
const SCOPE_ADDR = /^[0-9a-f.:]{2,45}(\/\d{1,3})?(-[0-9a-f.:]{2,45})?$/i;

/**
 * Splits and checks a scope, or returns null when it is not one.
 *
 * Exported so the route that saves it refuses at the point the operator can
 * still see the field, rather than storing something that quietly becomes
 * `LocalSubnet` here and leaves the pane showing a value nothing honours.
 */
function parseScope(raw) {
    const parts = String(raw === undefined || raw === null ? '' : raw)
        .split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return null;
    if (!parts.every((p) => SCOPE_WORD.test(p) || SCOPE_ADDR.test(p))) return null;
    return parts;
}

function scope() {
    const raw = machineStore.siteNetwork();
    const parsed = parseScope(raw);
    if (!parsed) {
        console.warn(`[Deploy] firewall: "${raw}" is not a scope Windows takes; using LocalSubnet`);
        return ['LocalSubnet'];
    }
    return parsed;
}

/**
 * The profiles a rule applies to.
 *
 * `Public` is accepted, because a host that genuinely serves a public network
 * exists, but it is never the default and reaching it takes saying so.
 */
const PROFILES = ['Domain', 'Private', 'Public', 'Any'];

function profiles() {
    const raw = String(process.env.AEGIS_DEPLOY_FIREWALL_PROFILE || '').trim();
    if (!raw) return ['Domain', 'Private'];
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const named = parts.map((p) => PROFILES.find((k) => k.toLowerCase() === p.toLowerCase()));
    if (!named.length || named.some((p) => !p)) {
        console.warn(`[Deploy] firewall: AEGIS_DEPLOY_FIREWALL_PROFILE="${raw}" names no profile; using Domain,Private`);
        return ['Domain', 'Private'];
    }
    return named;
}

/* ------------------------------------------------------------------ */
/* running PowerShell                                                  */
/* ------------------------------------------------------------------ */

/**
 * PowerShell rather than `netsh`, for one reason: output.
 *
 * `netsh advfirewall firewall show rule` prints in the display language of the
 * host, so reconciling against it means parsing French on this machine and
 * something else on the next. `Get-NetFirewallRule` gives objects, and
 * `ConvertTo-Json` gives them in one shape everywhere.
 *
 * The script is a string, and every value interpolated into it has already been
 * checked against a character set with no quote, no semicolon, no dollar and no
 * backtick in it: ids and slugs are `[a-z0-9-]`, the port is an integer, and
 * the scope and profiles come from the two validators above. That is what makes
 * the interpolation safe, and it is the reason those validators are strict
 * rather than permissive.
 */
/**
 * Replaces the PowerShell call, for tests.
 *
 * The interesting behaviour here is the diffing, the idempotency and reading an
 * answer back, none of which involve a firewall. Driving them through the real
 * one would mean a test suite that changes the host it runs on.
 */
function _setRunner(fn) { runner = typeof fn === 'function' ? fn : null; }

function run(script) {
    if (runner) return Promise.resolve(runner(script));
    return new Promise((resolve) => {
        execFile('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
            { timeout: TIMEOUT_MS, windowsHide: true },
            (err, stdout, stderr) => {
                if (err) {
                    resolve({ ok: false, error: String((stderr || err.message) || '').trim().split('\n')[0] });
                    return;
                }
                resolve({ ok: true, out: String(stdout || '').trim() });
            });
    });
}

function ruleName(slug, projectId) {
    return `${NAME_PREFIX}${slug}/${projectId}`;
}

function parseRuleName(displayName) {
    const s = String(displayName || '');
    if (!s.startsWith(NAME_PREFIX)) return null;
    const [slug, projectId, ...rest] = s.slice(NAME_PREFIX.length).split('/');
    if (rest.length || !SAFE_ID.test(slug || '') || !SAFE_ID.test(projectId || '')) return null;
    return { slug, projectId };
}

/* ------------------------------------------------------------------ */
/* the three operations                                                */
/* ------------------------------------------------------------------ */

/** Every rule this file owns, as `{ name, slug, projectId, port }`. */
async function list() {
    const res = await run(
        `$r = Get-NetFirewallRule -Group '${GROUP}' -ErrorAction SilentlyContinue;`
        + ' if (-not $r) { "[]" } else {'
        + ' @($r | ForEach-Object { [pscustomobject]@{'
        + ' name = $_.DisplayName;'
        + ' port = ($_ | Get-NetFirewallPortFilter).LocalPort } })'
        + ' | ConvertTo-Json -Compress -Depth 3 }');
    if (!res.ok) return { ok: false, error: res.error, rules: [] };

    let parsed;
    try {
        parsed = JSON.parse(res.out || '[]');
    } catch {
        return { ok: false, error: 'the firewall answered something that is not JSON', rules: [] };
    }
    // One rule comes back as an object, not as a one-element array.
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const rules = [];
    for (const row of rows) {
        const who = parseRuleName(row && row.name);
        if (!who) continue;
        rules.push({ name: row.name, slug: who.slug, projectId: who.projectId, port: Number(row.port) || 0 });
    }
    return { ok: true, rules };
}

/**
 * Makes sure one project's port is open, and only that port.
 *
 * Removes before adding when the port changed rather than trying to edit: a
 * project that moved ports would otherwise keep the old one open, which is a
 * hole nobody would think to look for.
 */
async function ensureFor(slug, projectId, port) {
    if (!enabled()) return false;
    if (!SAFE_ID.test(String(slug)) || !SAFE_ID.test(String(projectId))) return false;
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return false;

    const name = ruleName(slug, projectId);
    const current = await list();
    if (current.ok) {
        const mine = current.rules.find((r) => r.name === name);
        if (mine && mine.port === p) return true;          // already right
        if (mine) await removeFor(slug, projectId, { quiet: true });
    }

    const res = await run(
        `New-NetFirewallRule -DisplayName '${name}' -Group '${GROUP}'`
        + ` -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${p}`
        + ` -Profile ${profiles().join(',')} -RemoteAddress ${scope().join(',')}`
        + ' -ErrorAction Stop | Out-Null');

    if (!res.ok) {
        console.warn(`[Deploy] firewall: could not open TCP ${p} for ${slug}/${projectId}: ${res.error}`);
        console.warn('[Deploy] firewall: the site is listening and will be unreachable from other machines.');
        console.warn(`[Deploy] firewall: to open it by hand, as an administrator: New-NetFirewallRule -DisplayName '${name}' -Group '${GROUP}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${p} -Profile ${profiles().join(',')} -RemoteAddress ${scope().join(',')}`);
        return false;
    }
    console.log(`[Deploy] firewall: TCP ${p} open for ${slug}/${projectId} (${profiles().join(',')}, ${scope().join(',')})`);
    return true;
}

/** Closes one project's port. Absent is success: the desired state is reached. */
async function removeFor(slug, projectId, opts) {
    if (!enabled()) return false;
    if (!SAFE_ID.test(String(slug)) || !SAFE_ID.test(String(projectId))) return false;

    const name = ruleName(slug, projectId);
    const res = await run(
        `Remove-NetFirewallRule -DisplayName '${name}' -ErrorAction SilentlyContinue | Out-Null`);
    if (!res.ok) {
        console.warn(`[Deploy] firewall: could not close the port for ${slug}/${projectId}: ${res.error}`);
        return false;
    }
    if (!(opts && opts.quiet)) console.log(`[Deploy] firewall: port closed for ${slug}/${projectId}`);
    return true;
}

/**
 * Makes the host match the records: opens what should be open, closes what
 * should not.
 *
 * Declarative rather than incremental, and called at boot, because the
 * incremental version drifts. A project deleted while the service was stopped,
 * a rule removed by hand, a port reallocated: none of those produce an event
 * anybody hooked, and all of them leave the host disagreeing with the records.
 * Computing the desired set and applying the difference cannot drift.
 */
async function reconcile({ pathsFor, tenantsRoot }) {
    if (!enabled()) {
        if (!announced) {
            announced = true;
            if (process.platform !== 'win32') {
                console.log('[Deploy] firewall: not Windows, nothing to open here.');
            } else {
                console.log('[Deploy] firewall: AEGIS_DEPLOY_FIREWALL is not 1, so no port is opened.');
                console.log('[Deploy] firewall: sites will be reachable on this machine and nowhere else.');
            }
        }
        return { ok: false, opened: 0, closed: 0 };
    }

    const want = new Map();
    for (const { slug, tenantPaths } of projectStore.tenantsWithProjects(tenantsRoot(), pathsFor)) {
        for (const project of projectStore.listProjects(tenantPaths)) {
            if (project && project.port) want.set(ruleName(slug, project.id), { slug, id: project.id, port: Number(project.port) });
        }
    }

    const have = await list();
    if (!have.ok) {
        console.warn(`[Deploy] firewall: cannot read the current rules: ${have.error}`);
        return { ok: false, opened: 0, closed: 0 };
    }

    let closed = 0;
    for (const rule of have.rules) {
        const wanted = want.get(rule.name);
        if (!wanted) {
            if (await removeFor(rule.slug, rule.projectId, { quiet: true })) closed++;
        }
    }

    let opened = 0;
    for (const [, w] of want) {
        if (await ensureFor(w.slug, w.id, w.port)) opened++;
    }

    console.log(`[Deploy] firewall: ${opened} port(s) open, ${closed} stale rule(s) removed`);
    return { ok: true, opened, closed };
}

module.exports = {
    enabled, supported, ensureFor, removeFor, reconcile, parseScope,
    // Test seams. Nothing outside tests/deployFirewall.test.js reaches for them.
    _setRunner,
    _ruleName: ruleName,
    _parseRuleName: parseRuleName,
    _scope: scope,
    _profiles: profiles,
    GROUP, NAME_PREFIX
};
