/**
 * Lets one sandbox account reach the addresses its project was given, and
 * nothing else on its network.
 *
 * `Create-BuildAccounts.ps1` denies every sandbox account the subnets the
 * directory lives on, with one outbound block rule per subnet, named
 * `AegisBuild-<account>-DenyDomain-<subnet>`. A project whose database sits on
 * one of those subnets cannot connect, which is the rule doing its job.
 *
 * Windows applies a block rule over any allow rule, so an exception cannot be
 * added beside the block. The block itself has to be narrowed. For one account
 * and each `address:port` it may reach:
 *
 *   - each deny rule keeps its name and blocks its subnet minus the addresses;
 *   - three more rules per address block it again on every TCP port but the
 *     ones opened, on UDP and on ICMPv4.
 *
 * What the account gains is one TCP port on one machine, per target. This
 * module takes a list and has no opinion on its length. The callers do: a
 * project has at most its database (`projectStorage.js`) and one internal
 * service (`projectEgress.js`), each decided by an administrator, each
 * approved on the host.
 *
 * The subnet a deny rule started with is in its name, so the desired state is
 * computed from the names and never from what the rule holds today. That makes
 * the operation idempotent, and reversible without remembering anything: a
 * `null` target puts every rule back to its whole subnet.
 *
 * It runs at every process start, from `runtime.restart`. An account is chosen
 * when a process starts and can differ after a service restart, so rules left
 * from the project that held the account before have to be replaced by the
 * ones this project needs, including none.
 *
 * Off unless `AEGIS_DEPLOY_FIREWALL=1`, the switch `firewall.js` reads, for the
 * reason that file gives: touching the host firewall is a decision taken on the
 * host. And the address is one an administrator approved there
 * (`projectStorage.isApproved`), which the callers check before they get here.
 *
 * Never throws. A start is not failed by a firewall call: a process that cannot
 * reach its database stops at boot, the health check sees it, and the version
 * that was serving keeps serving.
 *
 * ponytail: IPv4 only. Nothing probes the path as
 * the account either; the application booting on the database is the proof. A
 * live probe needs the sandbox launcher and a Windows runner to test it on.
 */

'use strict';

const dns = require('dns');
const { execFile } = require('child_process');

/** The group of the per-address rules. The deny rules are setup's and keep theirs. */
const GROUP = 'Aegis Deploy data';

/** A local Windows account name, as setup creates them. No quote, no space. */
const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/;

const TIMEOUT_MS = 30000;

/** Replaced only by `_setRunner`, only by the suite. */
let runner = null;

function _setRunner(fn) { runner = typeof fn === 'function' ? fn : null; }

function supported() {
    return runner !== null || process.platform === 'win32';
}

function enabled() {
    return supported() && process.env.AEGIS_DEPLOY_FIREWALL === '1';
}

/** Windows PowerShell, for the reason `firewall.js` gives: objects, not localised text. */
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

/* ------------------------------------------------------------------ */
/* addresses                                                           */
/* ------------------------------------------------------------------ */

/** A dotted quad as a number, or null. */
function ipToInt(ip) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
    if (!m) return null;
    const parts = m.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return null;
    return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

function intToIp(n) {
    return [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join('.');
}

/** `[first, last]` of a CIDR block, or null. */
function cidrRange(cidr) {
    const m = /^([0-9.]+)\/(\d{1,2})$/.exec(String(cidr || '').trim());
    if (!m) return null;
    const base = ipToInt(m[1]);
    const len = Number(m[2]);
    if (base === null || len > 32) return null;
    const size = Math.pow(2, 32 - len);
    const first = Math.floor(base / size) * size;
    return [first, first + size - 1];
}

function contains(cidr, ip) {
    const range = cidrRange(cidr);
    const at = ipToInt(ip);
    return !!range && at !== null && at >= range[0] && at <= range[1];
}

function rangeText(first, last) {
    return first === last ? intToIp(first) : `${intToIp(first)}-${intToIp(last)}`;
}

/**
 * A subnet without one address, as what `-RemoteAddress` takes.
 *
 * Two ranges at most. The whole block comes back unchanged for an address that
 * is not in it, and nothing at all for a /32 that is the address.
 */
function subtract(cidr, ip) {
    const range = cidrRange(cidr);
    if (!range) return null;
    const at = ipToInt(ip);
    if (at === null || at < range[0] || at > range[1]) return [String(cidr).trim()];
    const out = [];
    if (at > range[0]) out.push(rangeText(range[0], at - 1));
    if (at < range[1]) out.push(rangeText(at + 1, range[1]));
    return out;
}

/**
 * One entry of a rule's remote address, as Windows gives it back: an address, a
 * block with a prefix length or with a mask, or a range. Null for anything else.
 */
function entryRange(entry) {
    const text = String(entry || '').trim();
    const single = ipToInt(text);
    if (single !== null) return [single, single];

    const dash = text.split('-');
    if (dash.length === 2) {
        const a = ipToInt(dash[0]);
        const b = ipToInt(dash[1]);
        return a !== null && b !== null && a <= b ? [a, b] : null;
    }

    const slash = text.split('/');
    if (slash.length !== 2) return null;
    if (/^\d{1,2}$/.test(slash[1])) return cidrRange(text);
    const mask = ipToInt(slash[1]);
    const base = ipToInt(slash[0]);
    if (mask === null || base === null) return null;
    const size = 4294967296 - mask;
    // A mask is contiguous ones, so its complement plus one is a power of two.
    if (size < 1 || Math.log2(size) % 1 !== 0) return null;
    const first = Math.floor(base / size) * size;
    return [first, first + size - 1];
}

/** Whether a rule already blocks exactly the wanted entries, in whatever form Windows wrote them. */
function sameAddresses(current, wanted) {
    const norm = (list) => {
        const ranges = list.map(entryRange);
        if (ranges.some((r) => !r)) return null;
        return ranges.sort((a, b) => a[0] - b[0]).map((r) => `${r[0]}-${r[1]}`).join(',');
    };
    const a = norm(current);
    const b = norm(wanted);
    return a !== null && a === b;
}

/**
 * A subnet without several addresses: what is left blocked when more than one
 * machine of it is opened. `subtract` once per address, on ranges.
 */
function subtractAll(cidr, ips) {
    const range = cidrRange(cidr);
    if (!range) return null;
    const holes = Array.from(new Set((ips || []).map(ipToInt)))
        .filter((at) => at !== null && at >= range[0] && at <= range[1])
        .sort((a, b) => a - b);
    if (!holes.length) return [String(cidr).trim()];
    const out = [];
    let from = range[0];
    for (const at of holes) {
        if (at > from) out.push(rangeText(from, at - 1));
        from = at + 1;
    }
    if (from <= range[1]) out.push(rangeText(from, range[1]));
    return out;
}

/**
 * The TCP ports that stay blocked on an opened machine: all of them but the
 * ones asked for. One port is the usual case; two targets on the same machine
 * give two.
 */
function otherPorts(ports) {
    const open = Array.from(new Set([].concat(ports).map(Number))).sort((a, b) => a - b);
    const out = [];
    let from = 1;
    for (const port of open) {
        if (port > from) out.push(port - 1 === from ? String(from) : `${from}-${port - 1}`);
        from = port + 1;
    }
    if (from <= 65535) out.push(from === 65535 ? '65535' : `${from}-65535`);
    return out;
}

/* ------------------------------------------------------------------ */
/* rules                                                               */
/* ------------------------------------------------------------------ */

function denyPrefix(account) {
    return `AegisBuild-${account}-DenyDomain-`;
}

/**
 * The subnet a deny rule was created for, read back from its name.
 *
 * Setup names the rule after the subnet with `/` and `.` turned into `_`, so
 * `10_0_0_0_8` is `10.0.0.0/8`. A name that does not parse is not one of ours
 * and is left alone.
 */
function subnetFromRuleName(name, account) {
    const prefix = denyPrefix(account);
    const text = String(name || '');
    if (!text.startsWith(prefix)) return null;
    const m = /^(\d{1,3})_(\d{1,3})_(\d{1,3})_(\d{1,3})_(\d{1,2})$/.exec(text.slice(prefix.length));
    if (!m) return null;
    const cidr = `${m[1]}.${m[2]}.${m[3]}.${m[4]}/${m[5]}`;
    return cidrRange(cidr) ? cidr : null;
}

const KINDS = ['tcp', 'udp', 'icmp'];

/** The rule that confines one opened address, for one protocol. */
function dataRuleName(account, what, ip) {
    return `${GROUP}: ${account} ${what} ${ip}`;
}

/**
 * Every per-address rule of one account, whatever address it names.
 *
 * The space before the star is what keeps `run-1` from matching `run-10`. It
 * also matches the rules a version before this one wrote, which carried no
 * address in their name: they are read as rules nobody asked for and replaced.
 */
function dataRulePattern(account) {
    return `${GROUP}: ${account} *`;
}

function asList(value) {
    return value === undefined || value === null ? [] : [].concat(value).map(String);
}

/** What the firewall holds for one account today. */
async function read(account) {
    const res = await run(
        `$d = @(Get-NetFirewallRule -DisplayName '${denyPrefix(account)}*' -ErrorAction SilentlyContinue | ForEach-Object {`
        + ' [pscustomobject]@{ name = $_.DisplayName; enabled = "$($_.Enabled)";'
        + ' remote = @(($_ | Get-NetFirewallAddressFilter).RemoteAddress) } });'
        + ` $x = @(Get-NetFirewallRule -DisplayName '${dataRulePattern(account)}' -ErrorAction SilentlyContinue | ForEach-Object {`
        + ' [pscustomobject]@{ name = $_.DisplayName;'
        + ' remote = @(($_ | Get-NetFirewallAddressFilter).RemoteAddress);'
        + ' ports = @(($_ | Get-NetFirewallPortFilter).RemotePort) } });'
        + ' [pscustomobject]@{ deny = $d; data = $x } | ConvertTo-Json -Compress -Depth 4');
    if (!res.ok) return { ok: false, error: res.error };

    let parsed;
    try {
        parsed = JSON.parse(res.out || '{}');
    } catch (_) {
        return { ok: false, error: 'the firewall answered something that is not JSON' };
    }

    const deny = [];
    for (const row of [].concat(parsed.deny || [])) {
        const subnet = subnetFromRuleName(row && row.name, account);
        if (!subnet) continue;
        deny.push({ name: row.name, subnet, enabled: String(row.enabled) === 'True', remote: asList(row.remote) });
    }
    const data = [].concat(parsed.data || []).filter((row) => row && row.name).map((row) => ({
        name: String(row.name), remote: asList(row.remote), ports: asList(row.ports)
    }));
    return { ok: true, deny, data };
}

/**
 * What the rules should be for these targets, and whether they already are.
 *
 * Pure. `targets` is `[{ ip, port }]`. Empty means a project with nothing to
 * reach: every subnet whole, no per-address rule. A target outside every
 * denied subnet was never blocked and asks for nothing.
 *
 * `open` is one entry per opened machine, with the ports it is opened on. Two
 * targets at the same address are one machine with two ports.
 */
function plan(account, state, targets) {
    const byIp = new Map();
    for (const t of targets || []) {
        if (!state.deny.some((r) => contains(r.subnet, t.ip))) continue;
        if (!byIp.has(t.ip)) byIp.set(t.ip, new Set());
        byIp.get(t.ip).add(t.port);
    }
    const open = Array.from(byIp.keys()).sort((a, b) => ipToInt(a) - ipToInt(b))
        .map((ip) => ({ ip, ports: otherPorts(Array.from(byIp.get(ip))) }));
    const ips = open.map((o) => o.ip);

    const deny = state.deny.map((r) => {
        const wanted = subtractAll(r.subnet, ips);
        const right = wanted.length
            ? r.enabled && sameAddresses(r.remote, wanted)
            : !r.enabled;
        return { name: r.name, subnet: r.subnet, wanted, right };
    });

    // Exactly the rules asked for, and no other. A missing one is a machine
    // opened on every port; an extra one is what another project left on this
    // account, and it goes.
    const held = new Map(state.data.map((r) => [r.name, r]));
    let dataRight = held.size === open.length * KINDS.length;
    for (const o of open) {
        for (const what of KINDS) {
            const rule = held.get(dataRuleName(account, what, o.ip));
            if (!rule || !sameAddresses(rule.remote, [o.ip])) dataRight = false;
            else if (what === 'tcp' && rule.ports.join(',') !== o.ports.join(',')) dataRight = false;
        }
    }

    return { inside: open.length > 0, open, deny, upToDate: dataRight && deny.every((r) => r.right) };
}

/**
 * The script that moves the rules to the plan.
 *
 * The order keeps the account closed at every step. The subnets go back to
 * whole first, the per-address rules are replaced while nothing can pass, and
 * the subnets are narrowed last, once the rules that confine the opening exist.
 *
 * Every interpolated value is a rule name read back and matched against a
 * digits-and-underscore pattern, an account matched against `ACCOUNT_RE`, an
 * address rebuilt from numbers, or a port number. None can carry a quote.
 */
function script(account, wanted) {
    const lines = ["$ErrorActionPreference = 'Stop'"];

    for (const r of wanted.deny) {
        lines.push(`Set-NetFirewallRule -DisplayName '${r.name}' -RemoteAddress ${r.subnet} -Enabled True`);
    }
    lines.push(`Get-NetFirewallRule -DisplayName '${dataRulePattern(account)}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`);

    if (wanted.inside) {
        lines.push(`$sid = (Get-LocalUser -Name '${account}').SID.Value`);
        for (const o of wanted.open) {
            const common = `-Group '${GROUP}' -Direction Outbound -Action Block -RemoteAddress ${o.ip} -Owner $sid`;
            lines.push(`New-NetFirewallRule -DisplayName '${dataRuleName(account, 'tcp', o.ip)}' ${common} -Protocol TCP -RemotePort ${o.ports.join(',')} | Out-Null`);
            lines.push(`New-NetFirewallRule -DisplayName '${dataRuleName(account, 'udp', o.ip)}' ${common} -Protocol UDP | Out-Null`);
            lines.push(`New-NetFirewallRule -DisplayName '${dataRuleName(account, 'icmp', o.ip)}' ${common} -Protocol ICMPv4 | Out-Null`);
        }
        for (const r of wanted.deny) {
            if (r.wanted.length === 1 && r.wanted[0] === r.subnet) continue;
            lines.push(r.wanted.length
                ? `Set-NetFirewallRule -DisplayName '${r.name}' -RemoteAddress ${r.wanted.join(',')}`
                : `Set-NetFirewallRule -DisplayName '${r.name}' -Enabled False`);
        }
    }
    return lines.join('; ');
}

/** The IPv4 address of a host, which is the host itself when it already is one. */
function resolveHost(host, lookup) {
    // Rebuilt from its numbers and not passed on as typed: `010.0.0.5` reads
    // as 10.0.0.5 here, and what reaches the firewall must be what was
    // compared against the subnets.
    if (ipToInt(host) !== null) return Promise.resolve(intToIp(ipToInt(host)));
    const find = lookup || ((name) => dns.promises.lookup(name, { family: 4 }).then((r) => r.address));
    return Promise.resolve(find(host)).then((ip) => (ipToInt(ip) !== null ? intToIp(ipToInt(ip)) : null), () => null);
}

/**
 * Makes one account's rules match its targets, or no target.
 *
 * `targets` is `{ host, port }`, a list of them, or null. Answers
 * `{ ok, changed }`, with `managed: false` when this host does not let Aegis
 * touch its firewall and `error` when a call failed. Never throws.
 *
 * All or nothing: one target that is not an address and a port, or does not
 * resolve, and no rule is touched. Opening the others would leave the process
 * half connected, which looks like a fault of the service it cannot reach.
 */
async function ensureFor(account, targets, options) {
    if (!enabled()) return { ok: true, changed: false, managed: false };
    if (!ACCOUNT_RE.test(String(account || ''))) return { ok: false, changed: false, managed: true, error: 'not an account name' };

    const asked = [];
    for (const target of [].concat(targets || []).filter(Boolean)) {
        const port = Number(target.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return { ok: false, changed: false, managed: true, error: 'not a port' };
        }
        const ip = await resolveHost(target.host, options && options.lookup);
        if (!ip) return { ok: false, changed: false, managed: true, error: `${target.host} does not resolve to an IPv4 address` };
        asked.push({ ip, port });
    }

    const state = await read(account);
    if (!state.ok) return { ok: false, changed: false, managed: true, error: state.error };

    const wanted = plan(account, state, asked);
    if (wanted.upToDate) return { ok: true, changed: false, managed: true, inside: wanted.inside };

    const res = await run(script(account, wanted));
    if (!res.ok) {
        console.warn(`[Deploy] network path: could not set the firewall rules of ${account}: ${res.error}`);
        return { ok: false, changed: false, managed: true, error: res.error };
    }
    const reach = asked.filter((t) => wanted.open.some((o) => o.ip === t.ip)).map((t) => `${t.ip} on TCP ${t.port}`);
    console.log(wanted.inside
        ? `[Deploy] network path: ${account} may reach ${reach.join(' and ')}, and nothing else there`
        : `[Deploy] network path: ${account} is back to its whole deny rules`);
    return { ok: true, changed: true, managed: true, inside: wanted.inside };
}

/**
 * Whether a target is behind the deny rules of any of these accounts.
 *
 * Read-only, for the check the guided setup shows before anything moves.
 * `blocked` says a rule of setup's covers the address; `managed` says whether
 * the switch will be allowed to narrow it.
 */
async function inspect(accounts, target, options) {
    if (!supported()) return { ok: true, blocked: false, managed: false };
    const ip = await resolveHost(target.host, options && options.lookup);
    if (!ip) return { ok: false, error: `${target.host} does not resolve to an IPv4 address` };

    for (const account of accounts || []) {
        if (!ACCOUNT_RE.test(String(account))) continue;
        const state = await read(account);
        if (!state.ok) return { ok: false, error: state.error };
        if (state.deny.some((r) => contains(r.subnet, ip))) {
            return { ok: true, blocked: true, managed: enabled(), ip };
        }
    }
    return { ok: true, blocked: false, managed: enabled(), ip };
}

module.exports = {
    enabled, supported, ensureFor, inspect,
    subtract, subtractAll, contains, subnetFromRuleName, otherPorts,
    GROUP,
    // Test seams.
    _setRunner,
    _plan: plan,
    _entryRange: entryRange,
    _sameAddresses: sameAddresses
};
