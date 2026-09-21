const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeIp } = require('../inventoryService');

test('normalizeIp carries the evidence object through with coerced booleans', () => {
  const out = normalizeIp({
    ip: '10.0.0.5', status: 'used',
    evidence: { pingAlive: true, rttMs: 3, hasArp: 1, arpStale: 0,
                hasDnsA: true, hasDnsPtr: false, hasDhcpLease: 1 }
  });
  assert.deepStrictEqual(out.evidence, {
    pingAlive: true, rttMs: 3, hasArp: true, arpStale: false,
    hasDnsA: true, hasDnsPtr: false, hasDhcpLease: true
  });
});

test('normalizeIp defaults evidence to null when the scan did not provide it', () => {
  const out = normalizeIp({ ip: '10.0.0.6', status: 'used' });
  assert.strictEqual(out.evidence, null);
});

test('normalizeIp derives vendor from the MAC, null when unknown/absent', () => {
  assert.strictEqual(normalizeIp({ ip: '10.0.0.7', mac: '00:50:56:11:22:33' }).vendor, 'VMware');
  assert.strictEqual(normalizeIp({ ip: '10.0.0.8', mac: 'AA:BB:CC:11:22:33' }).vendor, null);
  assert.strictEqual(normalizeIp({ ip: '10.0.0.9' }).vendor, null);
});

const os = require('os');
const path = require('path');
const fs = require('fs');
const { updateInventory } = require('../inventoryService');

function tmpFile() {
  return path.join(os.tmpdir(), `inv-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
}

test('updateInventory accumulates scanCount/totalScans and pins firstSeen', () => {
  const f = tmpFile();
  try {
    updateInventory({ ips: [{ ip: '10.0.0.5', status: 'used' }], subnets: [] }, f);
    updateInventory({ ips: [{ ip: '10.0.0.5', status: 'used' }], subnets: [] }, f);
    const store = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.strictEqual(store.totalScans, 2);
    const rec = store.ips.find(i => i.ip === '10.0.0.5');
    assert.strictEqual(rec.scanCount, 2);
    assert.ok(rec.firstSeen, 'firstSeen is set');
  } finally { fs.rmSync(f, { force: true }); }
});

test('updateInventory does not count a free IP and keeps its firstSeen empty', () => {
  const f = tmpFile();
  try {
    updateInventory({ ips: [{ ip: '10.0.0.9', status: 'free' }], subnets: [] }, f);
    const store = JSON.parse(fs.readFileSync(f, 'utf8'));
    const rec = store.ips.find(i => i.ip === '10.0.0.9');
    assert.strictEqual(rec.scanCount, 0);
    assert.strictEqual(rec.firstSeen, null);
  } finally { fs.rmSync(f, { force: true }); }
});

test('normalizeIp carries firstSeen and scanCount (defaulted)', () => {
  const withVals = normalizeIp({ ip: '10.0.0.5', status: 'used', firstSeen: '2026-07-01T00:00:00Z', scanCount: 5 });
  assert.strictEqual(withVals.firstSeen, '2026-07-01T00:00:00Z');
  assert.strictEqual(withVals.scanCount, 5);
  const bare = normalizeIp({ ip: '10.0.0.6', status: 'used' });
  assert.strictEqual(bare.firstSeen, null);
  assert.strictEqual(bare.scanCount, 0);
});

test('buildResponse exposes totalScans from the store', () => {
  const { buildResponse } = require('../inventoryService');
  const out = buildResponse({ ips: [], subnets: [], scannedAt: null, totalScans: 7 });
  assert.strictEqual(out.totalScans, 7);
});

// ── Subnets keyed by their real prefix, not by an assumed /24 ──

test('parseCidr reads bounds, and refuses what is not a CIDR', () => {
  const { parseCidr } = require('../inventoryService');
  const c = parseCidr('10.0.0.0/22');
  assert.strictEqual(c.prefix, 22);
  assert.strictEqual(c.size, 1024);
  assert.strictEqual(c.base, 167772160);
  assert.strictEqual(parseCidr('10.0.0.0'), null);
  assert.strictEqual(parseCidr('10.0.0.0/33'), null);
  assert.strictEqual(parseCidr('10.0.0.300/24'), null);
  assert.strictEqual(parseCidr(''), null);
});

test('networkForIp files an address into the longest declared prefix', () => {
  const { subnetIndex, networkForIp } = require('../inventoryService');
  const idx = subnetIndex([
    { cidr: '10.0.0.0/22' }, { cidr: '10.0.2.0/25' }, { cidr: '192.168.1.0/24' }
  ]);
  assert.strictEqual(networkForIp('10.0.0.1', idx), '10.0.0.0/22');
  assert.strictEqual(networkForIp('10.0.3.254', idx), '10.0.0.0/22');
  assert.strictEqual(networkForIp('10.0.2.10', idx), '10.0.2.0/25');   // narrower wins
  assert.strictEqual(networkForIp('10.0.2.200', idx), '10.0.0.0/22');  // past the /25
  assert.strictEqual(networkForIp('10.0.4.1', idx), '10.0.4.0/24');    // undeclared
  assert.strictEqual(networkForIp('192.168.1.7', idx), '192.168.1.0/24');
});

test('buildResponse groups a /22 DHCP scope as one subnet, not four /24s', () => {
  const { buildResponse } = require('../inventoryService');
  const out = buildResponse({
    subnets: [{
      cidr: '10.0.0.0/22', network: '10.0.0.0', prefix: 22, mask: '255.255.252.0',
      label: 'Sieges', vlan: 20,
      dhcp: { server: 'srvdhcp01', rangeStart: '10.0.1.50', rangeEnd: '10.0.3.200', utilization: 79 }
    }],
    // Addresses spread across all four /24s of the scope, as a real scan returns.
    ips: [
      { ip: '10.0.0.5', status: 'used', network: '10.0.0.0/24' },
      { ip: '10.0.1.60', status: 'used', network: '10.0.1.0/24' },
      { ip: '10.0.2.7', status: 'used', network: '10.0.2.0/24' },
      { ip: '10.0.3.199', status: 'free', network: '10.0.3.0/24' }
    ]
  });

  assert.strictEqual(out.subnets.length, 1, 'the scope must not split into /24s');
  const s = out.subnets[0];
  assert.strictEqual(s.cidr, '10.0.0.0/22');
  assert.strictEqual(s.usedCount, 3);
  assert.strictEqual(s.totalCount, 1022);
  assert.strictEqual(s.description, 'Sieges · VLAN 20');
  assert.strictEqual(s.dhcp.rangeStart, '10.0.1.50');
  // Every IP re-filed, so the frontend's `ip.network === subnet.cidr` filter matches.
  assert.ok(out.ips.every(i => i.network === '10.0.0.0/22'));
});

test('buildResponse leaves an undeclared address in its /24', () => {
  const { buildResponse } = require('../inventoryService');
  const out = buildResponse({
    subnets: [{ cidr: '10.0.0.0/22', prefix: 22 }],
    ips: [{ ip: '10.0.1.5', status: 'used' }, { ip: '172.16.4.9', status: 'used' }]
  });
  const cidrs = out.subnets.map(s => s.cidr).sort();
  assert.deepStrictEqual(cidrs, ['10.0.0.0/22', '172.16.4.0/24']);
});

// ── Diagnostics ──

test('normalizeDiagnostic keeps an unreadable status rather than dropping the entry', () => {
  const { normalizeDiagnostic } = require('../inventoryService');
  assert.strictEqual(normalizeDiagnostic({ source: 'DHCP', status: 'boom' }).status, 'failed');
  assert.strictEqual(normalizeDiagnostic({ status: 'OK' }).status, 'ok');
  assert.strictEqual(normalizeDiagnostic({ status: 'degraded' }).source, 'Scan');
  assert.strictEqual(normalizeDiagnostic(null), null);
  assert.strictEqual(normalizeDiagnostic('nope'), null);
});

test('summarizeDiagnostics ranks failed over degraded and lists distinct sources', () => {
  const { summarizeDiagnostics } = require('../inventoryService');
  assert.strictEqual(summarizeDiagnostics([{ status: 'ok', source: 'DNS' }]).status, 'ok');

  const mixed = summarizeDiagnostics([
    { status: 'ok', source: 'DNS' },
    { status: 'degraded', source: 'DHCP - SRV01' },
    { status: 'failed', source: 'DHCP' },
    { status: 'degraded', source: 'DHCP' }
  ]);
  assert.strictEqual(mixed.status, 'failed');
  assert.strictEqual(mixed.failed, 1);
  assert.strictEqual(mixed.degraded, 2);
  assert.deepStrictEqual(mixed.sources, ['DHCP', 'DHCP - SRV01']);
  // Split by verdict too: the banner names one severity at a time, so pairing
  // the failed count with the mixed list made it announce one failure and name
  // two sources.
  assert.deepStrictEqual(mixed.failedSources, ['DHCP']);
  assert.deepStrictEqual(mixed.degradedSources, ['DHCP - SRV01', 'DHCP']);

  assert.strictEqual(summarizeDiagnostics([{ status: 'degraded', source: 'X' }]).status, 'degraded');
  assert.strictEqual(summarizeDiagnostics([]).status, 'ok');
});

test('buildResponse surfaces diagnostics and their summary', () => {
  const { buildResponse } = require('../inventoryService');
  const out = buildResponse({
    ips: [], subnets: [],
    diagnostics: [
      { source: 'DHCP', status: 'failed', message: 'module absent', hint: 'RSAT', command: 'Get-DhcpServerInDC' }
    ],
    context: { computerName: 'SRV-AUDIT', elevated: true }
  });
  assert.strictEqual(out.diagnostics.length, 1);
  assert.strictEqual(out.diagnostics[0].command, 'Get-DhcpServerInDC');
  assert.strictEqual(out.diagnosticsSummary.status, 'failed');
  assert.deepStrictEqual(out.diagnosticsSummary.sources, ['DHCP']);
  assert.strictEqual(out.context.computerName, 'SRV-AUDIT');
});

test('buildResponse reports a clean scan with no diagnostics', () => {
  const { buildResponse } = require('../inventoryService');
  const out = buildResponse({ ips: [], subnets: [] });
  assert.deepStrictEqual(out.diagnostics, []);
  assert.strictEqual(out.diagnosticsSummary.status, 'ok');
  assert.strictEqual(out.context, null);
});
