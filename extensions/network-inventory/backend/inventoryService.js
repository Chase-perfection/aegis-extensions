const fs = require('fs');
const path = require('path');
const { vendorForMac } = require('./ouiVendor');

/**
 * Inventory persistence + shaping for the Network Inventory subnet explorer.
 *
 * On-disk shape (inventory_history.json):
 *   { ips: [ …enriched IP records… ], subnets: [ …scope/zone meta… ], scannedAt: ISO }
 *
 * A legacy history file (a bare array of IP records) is normalized on read, so
 * older tenants keep working without a migration step.
 *
 * The response served to the frontend is built by getConsolidatedInventory():
 *   { subnets: [ …with derived counts + aggregated anomalies… ], ips: [ …normalized… ] }
 */

// --- sort helpers (shared with the scan-side ordering) ---
function networkPriority(ip) {
    const octets = String(ip).split('.').map(Number);
    if (octets[0] === 10) return 1;
    if (octets[0] === 192 && octets[1] === 168) return 2;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return 3;
    return 4;
}
function ipToNum(ip) {
    return String(ip).split('.').reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
}

/**
 * Coerces a value to an array. Windows PowerShell 5.1 (which runs network_scan.ps1)
 * serializes a single-element array as a bare scalar/object, so a lone IP, subnet,
 * or DNS record can arrive un-wrapped — this normalizes it back to an array.
 */
function toArr(v) {
    if (Array.isArray(v)) return v;
    if (v == null) return [];
    return [v];
}

/**
 * /24 CIDR an IP falls into, e.g. 192.168.1.37 -> "192.168.1.0/24".
 * The fallback only: a declared subnet always wins over it, see subnetIndex().
 */
function cidrForIp(ip) {
    const o = String(ip).split('.');
    return `${o[0]}.${o[1]}.${o[2]}.0/24`;
}

/**
 * Parses "10.0.0.0/22" into its numeric bounds, or null when malformed.
 * @returns {{cidr: string, prefix: number, base: number, size: number}|null}
 */
function parseCidr(cidr) {
    const [addr, bits] = String(cidr).split('/');
    const prefix = Number(bits);
    if (!addr || !Number.isInteger(prefix) || prefix < 1 || prefix > 32) return null;
    const parts = addr.split('.');
    if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
    return { cidr: String(cidr), prefix, base: ipToNum(addr), size: Math.pow(2, 32 - prefix) };
}

/**
 * Index of declared subnets, longest prefix first, for filing an IP into the
 * subnet that actually holds it.
 *
 * Without this, every address was filed into an assumed /24. A DHCP scope of
 * 10.0.0.0/22 then produced one subnet row claiming 1022 addresses and holding
 * none, beside four anonymous /24 rows carrying the addresses but neither the
 * scope's label, nor its VLAN, nor its DHCP block.
 */
function subnetIndex(subnets) {
    return toArr(subnets)
        .map(s => (s && s.cidr ? parseCidr(s.cidr) : null))
        .filter(Boolean)
        .sort((a, b) => b.prefix - a.prefix);
}

/** Longest declared prefix containing `ip`; the /24 fallback when none does. */
function networkForIp(ip, index) {
    const num = ipToNum(ip);
    for (const row of index) {
        if (num >= row.base && num < row.base + row.size) return row.cidr;
    }
    return cidrForIp(ip);
}

/**
 * Human, French, coarse relative time from an ISO timestamp.
 * Matches the design copy ("2 min", "1 h", "3 j"). Returns "" for missing input.
 */
function relativeTime(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (secs < 60) return `${secs} s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} h`;
    const days = Math.floor(hours / 24);
    return `${days} j`;
}

/**
 * Loads the persistent inventory from disk, normalizing legacy (bare-array) files.
 * @param {string} historyFile Absolute path to inventory_history.json
 * @returns {{ips: Array, subnets: Array, scannedAt: (string|null)}}
 */
function loadHistory(historyFile) {
    const dir = path.dirname(historyFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(historyFile)) return { ips: [], subnets: [], scannedAt: null };
    try {
        const parsed = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        if (Array.isArray(parsed)) return { ips: parsed, subnets: [], scannedAt: null };
        return {
            ips: Array.isArray(parsed.ips) ? parsed.ips : [],
            subnets: Array.isArray(parsed.subnets) ? parsed.subnets : [],
            scannedAt: parsed.scannedAt || null,
            totalScans: Number(parsed.totalScans) || 0,
            diagnostics: Array.isArray(parsed.diagnostics) ? parsed.diagnostics : [],
            context: parsed.context && typeof parsed.context === 'object' ? parsed.context : null
        };
    } catch (e) {
        console.error('[InventoryService] Failed to load history:', e.message);
        return { ips: [], subnets: [], scannedAt: null };
    }
}

/**
 * Saves the inventory store to disk.
 * @param {{ips: Array, subnets: Array, scannedAt: (string|null)}} store
 * @param {string} historyFile
 */
function saveHistory(store, historyFile) {
    const dir = path.dirname(historyFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try {
        fs.writeFileSync(historyFile, JSON.stringify(store, null, 2), 'utf8');
    } catch (e) {
        console.error('[InventoryService] Failed to save history:', e.message);
    }
}

function numOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

const DIAG_STATUSES = ['ok', 'degraded', 'failed', 'skipped'];

/**
 * Normalizes one diagnostic entry from the scan.
 *
 * These entries are the only thing standing between an operator and a scan that
 * silently returned nothing, so an entry with an unreadable status is kept and
 * marked 'failed' rather than dropped — losing it would restore the silence.
 */
function normalizeDiagnostic(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const status = String(raw.status || '').toLowerCase();
    return {
        source: String(raw.source || 'Scan'),
        status: DIAG_STATUSES.includes(status) ? status : 'failed',
        message: String(raw.message || ''),
        hint: String(raw.hint || ''),
        command: String(raw.command || ''),
        detail: String(raw.detail || ''),
        at: raw.at || null
    };
}

/**
 * Rolls the per-source entries into the one verdict the UI acts on.
 * @returns {{status: string, failed: number, degraded: number, ok: number, sources: string[]}}
 */
function summarizeDiagnostics(entries) {
    const failed = entries.filter(d => d.status === 'failed');
    const degraded = entries.filter(d => d.status === 'degraded');
    return {
        status: failed.length ? 'failed' : (degraded.length ? 'degraded' : 'ok'),
        failed: failed.length,
        degraded: degraded.length,
        ok: entries.filter(d => d.status === 'ok').length,
        // Distinct sources in trouble, for the banner's one-line summary.
        sources: [...new Set(failed.concat(degraded).map(d => d.source))],
        // Split by verdict as well. The banner names one severity at a time, and
        // `sources` mixes both: a scan with three dead DHCP servers and one
        // degraded interface read "3 sources en échec" and then listed four.
        failedSources: [...new Set(failed.map(d => d.source))],
        degradedSources: [...new Set(degraded.map(d => d.source))]
    };
}

/**
 * Normalizes one raw IP record (scan output or legacy history) to the contract.
 * Additive + defensive: any field the scan hasn't populated yet degrades cleanly.
 */
function normalizeIp(raw) {
    const ip = raw.ip || raw.IP;
    if (!ip) return null;

    // Status: legacy scans emit "taken"/"free"; the enriched scan emits the full
    // set. Map "taken" -> "used", and promote a gateway by type when unmarked.
    let status = String(raw.status || 'used').toLowerCase();
    if (status === 'taken') status = 'used';
    const type = String(raw.type || raw.Type || '');
    if (status === 'used' && /passerelle|gateway/i.test(type)) status = 'gateway';

    const anomalies = toArr(raw.anomalies);
    const macCount = Number(raw.macCount) || (raw.mac && raw.mac !== '-' ? 1 : 0);

    return {
        ip,
        network: raw.network || cidrForIp(ip),
        status,
        hostname: raw.hostname || raw.Name || '',
        mac: raw.mac || raw.Mac || '',
        vendor: vendorForMac(raw.mac || raw.Mac || ''),
        macCount,
        dns: toArr(raw.dns),
        dnsRecords: toArr(raw.dnsRecords),
        dhcp: raw.dhcp && typeof raw.dhcp === 'object'
            ? { kind: raw.dhcp.kind || 'none', detail: raw.dhcp.detail || '', expiresAt: raw.dhcp.expiresAt || null }
            : { kind: 'none', detail: '', expiresAt: null },
        lastSeen: raw.lastSeen || null,
        lastSeenLabel: relativeTime(raw.lastSeen),
        firstSeen: raw.firstSeen || null,
        scanCount: Number(raw.scanCount) || 0,
        anomalies,
        history: toArr(raw.history),
        evidence: raw.evidence && typeof raw.evidence === 'object'
            ? {
                pingAlive: !!raw.evidence.pingAlive,
                rttMs: numOrNull(raw.evidence.rttMs),
                hasArp: !!raw.evidence.hasArp,
                arpStale: !!raw.evidence.arpStale,
                hasDnsA: !!raw.evidence.hasDnsA,
                hasDnsPtr: !!raw.evidence.hasDnsPtr,
                hasDhcpLease: !!raw.evidence.hasDhcpLease
              }
            : null
    };
}

/**
 * Total addressable hosts in a prefix (usable, minus network + broadcast).
 * /24 -> 254. Falls back to 254 for missing/degenerate prefixes.
 */
function usableHosts(prefix) {
    const p = Number(prefix);
    if (!p || p < 1 || p > 31) return 254;
    return Math.pow(2, 32 - p) - 2;
}

/**
 * Builds the frontend response from the on-disk store: normalizes IPs, groups
 * them into subnets, merges persisted subnet meta with derived counts, and
 * aggregates anomaly totals from the IPs (single source of truth).
 * @param {{ips: Array, subnets: Array}} store
 * @returns {{subnets: Array, ips: Array}}
 */
// Map one aggregated group ({used,conflicts,...}) to its response subnet object,
// enriched with persisted CIDR meta. Pure helper extracted from buildResponse.
function buildSubnetEntry(cidr, g, metaByCidr) {
    const meta = metaByCidr.get(cidr) || {};
    const network = meta.network || cidr.split('/')[0];
    const prefix = Number(meta.prefix) || Number(cidr.split('/')[1]) || 24;
    const label = meta.label || '';
    const vlan = meta.vlan != null ? meta.vlan : null;
    let description = meta.description || '';
    if (!description) {
        const parts = [];
        if (label) parts.push(label);
        if (vlan != null) parts.push(`VLAN ${vlan}`);
        description = parts.join(' · ');
    }
    const conflicts = g.conflicts, aWithoutPtr = g.aWithoutPtr, orphanPtr = g.orphanPtr;
    return {
        cidr,
        network,
        prefix,
        mask: meta.mask || (prefix === 24 ? '255.255.255.0' : ''),
        label,
        vlan,
        description,
        usedCount: g.used,
        totalCount: usableHosts(prefix),
        dhcp: meta.dhcp || null,
        dns: meta.dns || null,
        anomalies: {
            total: conflicts + aWithoutPtr + orphanPtr,
            conflicts,
            aWithoutPtr,
            orphanPtr
        }
    };
}

function buildResponse(store) {
    const ips = (store.ips || []).map(normalizeIp).filter(Boolean);
    ips.sort((a, b) => {
        const pa = networkPriority(a.ip), pb = networkPriority(b.ip);
        if (pa !== pb) return pa - pb;
        return ipToNum(a.ip) - ipToNum(b.ip);
    });

    // Persisted subnet meta, keyed by CIDR, to enrich the derived groups.
    const metaByCidr = new Map();
    (store.subnets || []).forEach(s => { if (s && s.cidr) metaByCidr.set(s.cidr, s); });

    // Re-file every address into the longest declared prefix that contains it,
    // overriding whatever `network` the record carries. A history written by an
    // older scan holds /24s throughout; this is what folds them back into the
    // etendue they belong to, with no migration step.
    const index = subnetIndex(store.subnets);
    if (index.length) {
        for (const item of ips) item.network = networkForIp(item.ip, index);
    }

    const groups = new Map();
    for (const item of ips) {
        const cidr = item.network || cidrForIp(item.ip);
        if (!groups.has(cidr)) {
            groups.set(cidr, { used: 0, conflicts: 0, aWithoutPtr: 0, orphanPtr: 0 });
        }
        const g = groups.get(cidr);
        if (item.status !== 'free') g.used += 1;
        if (item.macCount > 1 || item.anomalies.includes('conflict')) g.conflicts += 1;
        if (item.anomalies.includes('a_without_ptr')) g.aWithoutPtr += 1;
        if (item.anomalies.includes('orphan_ptr')) g.orphanPtr += 1;
    }

    // Include subnets that have persisted meta but no live IPs yet.
    for (const cidr of metaByCidr.keys()) {
        if (!groups.has(cidr)) groups.set(cidr, { used: 0, conflicts: 0, aWithoutPtr: 0, orphanPtr: 0 });
    }

    const subnets = [...groups.entries()].map(([cidr, g]) => buildSubnetEntry(cidr, g, metaByCidr));

    subnets.sort((a, b) => {
        const pa = networkPriority(a.network), pb = networkPriority(b.network);
        if (pa !== pb) return pa - pb;
        return ipToNum(a.network) - ipToNum(b.network);
    });

    const diagnostics = toArr(store.diagnostics).map(normalizeDiagnostic).filter(Boolean);

    return {
        subnets,
        ips,
        scannedAt: store.scannedAt || null,
        totalScans: Number(store.totalScans) || 0,
        diagnostics,
        diagnosticsSummary: summarizeDiagnostics(diagnostics),
        context: store.context || null
    };
}

/**
 * Merges new scan data into the store and persists it. Accepts either the
 * enriched object ({ips, subnets}) or a legacy flat array of IP records.
 * @param {Array|Object} scanData
 * @param {string} historyFile
 * @returns {{subnets: Array, ips: Array}} the freshly-built response
 */
function updateInventory(scanData, historyFile) {
    let ips = [];
    let subnets = [];
    let diagnostics = [];
    let context = null;
    if (Array.isArray(scanData)) {
        ips = scanData;
    } else if (scanData && typeof scanData === 'object') {
        ips = toArr(scanData.ips);
        subnets = toArr(scanData.subnets);
        diagnostics = toArr(scanData.diagnostics);
        context = scanData.context && typeof scanData.context === 'object' ? scanData.context : null;
    }

    // Prior store drives cross-scan accumulation (firstSeen, scanCount).
    const prev = loadHistory(historyFile) || {};
    const prevById = new Map(toArr(prev.ips).map(i => [i.ip || i.IP, i]));
    const totalScans = (Number(prev.totalScans) || 0) + 1;

    const now = new Date().toISOString();
    ips = ips.map(item => {
        const ip = item.ip || item.IP;
        const status = String(item.status || item.Status || 'used').toLowerCase();
        const isFree = status === 'free';
        const before = prevById.get(ip) || {};
        const seen = isFree ? (item.lastSeen || null) : (item.lastSeen || now);
        const firstSeen = isFree
            ? (before.firstSeen || null)
            : (before.firstSeen || seen || now);
        const scanCount = (Number(before.scanCount) || 0) + (isFree ? 0 : 1);
        return { ...item, lastSeen: seen, firstSeen, scanCount };
    });

    // Diagnostics are replaced, never accumulated: they describe this scan, and a
    // stale "DHCP unreachable" kept from last week would be worse than none.
    const store = { ips, subnets, scannedAt: now, totalScans, diagnostics, context };
    saveHistory(store, historyFile);
    return buildResponse(store);
}

/**
 * Gets the consolidated inventory response from the given history file.
 * @param {string} historyFile
 * @returns {{subnets: Array, ips: Array}}
 */
function getConsolidatedInventory(historyFile) {
    return buildResponse(loadHistory(historyFile));
}

module.exports = {
    updateInventory,
    getConsolidatedInventory,
    loadHistory,
    // exported for tests / reuse
    buildResponse,
    normalizeIp,
    relativeTime,
    cidrForIp,
    parseCidr,
    subnetIndex,
    networkForIp,
    normalizeDiagnostic,
    summarizeDiagnostics
};
