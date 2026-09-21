/**
 * Tier 3 — the Network Inventory diagnostic banner and its copyable report.
 *
 * This feature exists entirely to break a silence: the scan reaches DHCP, DNS
 * and the directory over RPC, any of them can refuse, and every refusal used to
 * be swallowed. So the thing worth pinning is not that the report renders — it
 * is that it appears exactly when a source failed and stays out of the way when
 * none did, and that the text it hands over carries the failing command and the
 * real error rather than a pleasantry.
 *
 * Covered: the banner's three states (absent / degraded / failed), the source
 * names it lists, the modal opening from it, one entry per diagnostic with its
 * hint and command, and the plain-text report's contents. Every assertion below
 * first checks the element it measures actually exists, so a renamed id fails
 * the test instead of quietly passing on an empty read.
 *
 * Not covered: the clipboard itself. Chrome's headless permission model makes
 * navigator.clipboard unreliable here, and the fallback path is a textarea
 * selection — the test asserts the textarea holds the right text, which is what
 * both paths copy.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

// Core's harness, located through AEGIS_TREE. Unset, the file skips with the
// reason and the fix rather than failing: see harness.js.
const harness = require('./harness');
if (!harness.available) {
  test('the Network Inventory diagnostic banner, inside the Aegis shell', { skip: harness.why }, () => {});
  return;
}
const { serveFrontend, launchBrowser, openPage, DEFAULT_API_BODY } = harness;

const PAGE = '/pages/network-inventory.html';

let server;
let browser;

before(async () => {
  server = await serveFrontend();
  browser = await launchBrowser();
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

/** One /22 DHCP scope with its addresses, the shape buildResponse() returns. */
function inventory(extra) {
  return {
    ...DEFAULT_API_BODY,
    success: true,
    scannedAt: '2026-09-15T08:30:00.000Z',
    totalScans: 3,
    subnets: [{
      cidr: '10.0.0.0/22', network: '10.0.0.0', prefix: 22, mask: '255.255.252.0',
      label: 'Sieges', vlan: 20, description: 'Sieges · VLAN 20',
      usedCount: 2, totalCount: 1022,
      dhcp: {
        server: 'srvdhcp01', rangeStart: '10.0.1.50', rangeEnd: '10.0.3.200',
        utilization: 79, activeLeases: 812, reservations: 14, leaseDays: 8
      },
      dns: null,
      anomalies: { total: 0, conflicts: 0, aWithoutPtr: 0, orphanPtr: 0 }
    }],
    ips: [
      { ip: '10.0.1.60', network: '10.0.0.0/22', status: 'used', hostname: 'poste-a', mac: '', dns: [], dnsRecords: [], dhcp: { kind: 'lease', detail: 'Bail', expiresAt: null }, anomalies: [], evidence: null },
      { ip: '10.0.3.7', network: '10.0.0.0/22', status: 'used', hostname: '', mac: '', dns: [], dnsRecords: [], dhcp: { kind: 'none', detail: '', expiresAt: null }, anomalies: [], evidence: null }
    ],
    diagnostics: [],
    diagnosticsSummary: { status: 'ok', failed: 0, degraded: 0, ok: 0, sources: [] },
    context: null,
    ...extra
  };
}

const DHCP_FAILURE = {
  source: 'DHCP',
  status: 'failed',
  message: "Le module PowerShell DhcpServer est absent de cette machine.",
  hint: "Installer les outils RSAT DHCP puis relancer le scan.",
  command: 'Get-Module -ListAvailable -Name DhcpServer',
  detail: 'System.Management.Automation.CommandNotFoundException: terme non reconnu',
  at: '2026-09-15T08:30:01.000Z'
};

const DNS_DEGRADED = {
  source: 'DNS',
  status: 'degraded',
  message: "Les enregistrements de la zone corp.local n'ont pas pu etre lus.",
  hint: 'Zone peut-etre deleguee.',
  command: 'Get-DnsServerResourceRecord -ZoneName corp.local',
  detail: 'System.UnauthorizedAccessException: acces refuse',
  at: '2026-09-15T08:30:02.000Z'
};

const SCAN_CONTEXT = {
  computerName: 'SRV-AUDIT', userName: 'CORP\\svc-aegis', elevated: true,
  domain: 'corp.local', pdc: 'dc01.corp.local', psVersion: '5.1.26200.1',
  engine: 'C# Engine', dhcpScopes: 0, sweptSubnets: 1, sweptHosts: 1022
};

async function open(body) {
  const opened = await openPage(browser, `${server.url}${PAGE}`, {
    '/api/inventory/network': body
  });
  await opened.page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
  return opened;
}

/** The banner's rendered state, or null when the element is gone entirely. */
function readBanner() {
  const bar = document.getElementById('ni-diag-banner');
  if (!bar) return null;
  const text = document.getElementById('ni-diag-banner-text');
  return {
    hidden: bar.hidden,
    // hidden is an attribute, not a guarantee: a stylesheet could show it anyway.
    displayed: getComputedStyle(bar).display !== 'none',
    failed: bar.classList.contains('failed'),
    text: text ? text.textContent.trim() : null,
    hasButton: !!document.getElementById('ni-diag-open')
  };
}

test('a clean scan leaves the diagnostic banner out of the way', async () => {
  const { page, close, pageErrors } = await open(inventory());
  const banner = await page.evaluate(readBanner);
  await close();

  assert.deepStrictEqual(pageErrors, []);
  assert.ok(banner, 'the banner element must exist in the page');
  assert.strictEqual(banner.hidden, true);
  assert.strictEqual(banner.displayed, false, 'hidden must actually hide it');
});

test('a failed source raises the banner, names it, and offers the report', async () => {
  const { page, close, pageErrors } = await open(inventory({
    diagnostics: [DHCP_FAILURE],
    diagnosticsSummary: { status: 'failed', failed: 1, degraded: 0, ok: 0, sources: ['DHCP'] },
    context: SCAN_CONTEXT
  }));
  const banner = await page.evaluate(readBanner);
  await close();

  assert.deepStrictEqual(pageErrors, []);
  assert.strictEqual(banner.hidden, false);
  assert.strictEqual(banner.displayed, true);
  assert.strictEqual(banner.failed, true, 'a failure must read as a failure, not a warning');
  assert.match(banner.text, /DHCP/);
  assert.ok(banner.hasButton, 'the banner must offer a way into the report');
});

test('a merely incomplete source warns without claiming a failure', async () => {
  const { page, close } = await open(inventory({
    diagnostics: [DNS_DEGRADED],
    diagnosticsSummary: { status: 'degraded', failed: 0, degraded: 1, ok: 0, sources: ['DNS'] }
  }));
  const banner = await page.evaluate(readBanner);
  await close();

  assert.strictEqual(banner.hidden, false);
  assert.strictEqual(banner.failed, false);
  assert.match(banner.text, /DNS/);
});

test('the banner counts and names the same sources, not one list and another count', async () => {
  // A scan with one dead DHCP server and one degraded read announced "1 source
  // en echec" and then listed two names, the second being the degraded one.
  const { page, close } = await open(inventory({
    diagnostics: [DNS_DEGRADED, DHCP_FAILURE],
    diagnosticsSummary: {
      status: 'failed', failed: 1, degraded: 1, ok: 0,
      sources: ['DHCP', 'DNS'], failedSources: ['DHCP'], degradedSources: ['DNS']
    },
    context: SCAN_CONTEXT
  }));
  const banner = await page.evaluate(readBanner);
  await close();

  assert.match(banner.text, /\b1\b/, 'the count is of the sources it names');
  assert.match(banner.text, /DHCP/);
  assert.doesNotMatch(banner.text, /DNS/, 'a degraded source is not named as a failure');
});

test('the banner is exactly as wide as the blocks it sits between', async () => {
  // It is a sibling of .ni-main-head, not a child, so it does not inherit that
  // block's 32px padding. Without a gutter of its own it ran edge to edge under
  // cards that stop 32px short of both sides. Measured, not eyeballed: there is
  // no screenshot baseline in this suite, so the alignment has to be an assertion.
  const { page, close, pageErrors } = await open(inventory({
    diagnostics: [DHCP_FAILURE],
    diagnosticsSummary: {
      status: 'failed', failed: 1, degraded: 0, ok: 0,
      sources: ['DHCP'], failedSources: ['DHCP'], degradedSources: []
    },
    context: SCAN_CONTEXT
  }));

  // Every width the layout is expected to hold, including the narrow end where
  // layout.test.js records the fixed-width limitation.
  const rows = [];
  for (const width of [1920, 1440, 1280]) {
    await page.setViewport({ width, height: 900 });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
    rows.push(await page.evaluate((w) => {
      const edges = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right) };
      };
      return { width: w, cards: edges('#ni-cards'), banner: edges('#ni-diag-banner'), table: edges('.ni-table-card') };
    }, width));
  }
  await close();

  assert.deepStrictEqual(pageErrors, []);
  for (const row of rows) {
    assert.ok(row.cards && row.banner && row.table, `a measured block is missing at ${row.width}px`);
    assert.deepStrictEqual(row.banner, row.cards, `banner must match the cards at ${row.width}px`);
    assert.deepStrictEqual(row.banner, row.table, `banner must match the table at ${row.width}px`);
  }
});

test('the report opens from the banner, one entry per diagnostic, worst first', async () => {
  const { page, close, pageErrors } = await open(inventory({
    diagnostics: [DNS_DEGRADED, DHCP_FAILURE],
    diagnosticsSummary: { status: 'failed', failed: 1, degraded: 1, ok: 0, sources: ['DNS', 'DHCP'] },
    context: SCAN_CONTEXT
  }));

  await page.click('#ni-diag-open');
  const view = await page.evaluate(() => {
    const modal = document.getElementById('ni-diag-modal');
    if (!modal) return null;
    const entries = [...modal.querySelectorAll('.ni-diag-entry')].map((e) => ({
      cls: e.className,
      source: e.querySelector('.ni-diag-source')?.textContent.trim() || null,
      message: e.querySelector('.ni-diag-msg')?.textContent.trim() || null,
      hint: e.querySelector('.ni-diag-hint')?.textContent.trim() || null,
      command: e.querySelector('.ni-diag-cmd')?.textContent.trim() || null,
      detail: e.querySelector('.ni-diag-detail')?.textContent.trim() || null
    }));
    const raw = document.getElementById('ni-diag-raw');
    return { hidden: modal.hidden, displayed: getComputedStyle(modal).display !== 'none', entries, raw: raw ? raw.value : null };
  });
  await close();

  assert.deepStrictEqual(pageErrors, []);
  assert.ok(view, 'the report element must exist');
  assert.strictEqual(view.hidden, false);
  assert.strictEqual(view.displayed, true);

  assert.strictEqual(view.entries.length, 2, 'one entry per diagnostic');
  // A failure has to be the first thing read, whatever order the scan emitted.
  assert.strictEqual(view.entries[0].source, 'DHCP');
  assert.ok(view.entries[0].cls.includes('failed'));
  assert.strictEqual(view.entries[1].source, 'DNS');
  assert.ok(view.entries[1].cls.includes('degraded'));

  // The four fields that make the entry actionable rather than decorative.
  assert.match(view.entries[0].message, /DhcpServer/);
  assert.match(view.entries[0].hint, /RSAT/);
  assert.strictEqual(view.entries[0].command, DHCP_FAILURE.command);
  assert.match(view.entries[0].detail, /CommandNotFoundException/);
});

test('the copyable text carries the context, the command and the raw error', async () => {
  const { page, close } = await open(inventory({
    diagnostics: [DHCP_FAILURE],
    diagnosticsSummary: { status: 'failed', failed: 1, degraded: 0, ok: 0, sources: ['DHCP'] },
    context: SCAN_CONTEXT
  }));

  await page.click('#ni-diag-open');
  const raw = await page.evaluate(() => {
    const el = document.getElementById('ni-diag-raw');
    return el ? el.value : null;
  });
  await close();

  assert.ok(raw && raw.length > 0, 'the report textarea must hold the report');
  // Who ran it, where, with what rights: the three questions an administrator
  // receiving this report asks before reading the error.
  assert.match(raw, /SRV-AUDIT/);
  assert.match(raw, /corp\.local/);
  assert.match(raw, /svc-aegis/);
  // And the error itself, verbatim.
  assert.ok(raw.includes(DHCP_FAILURE.command), 'the failing command must be in the text');
  assert.ok(raw.includes(DHCP_FAILURE.detail), 'the raw error must be in the text');
  assert.ok(raw.includes(DHCP_FAILURE.hint), 'the remediation hint must be in the text');
});

test('Escape closes the report', async () => {
  const { page, close } = await open(inventory({
    diagnostics: [DHCP_FAILURE],
    diagnosticsSummary: { status: 'failed', failed: 1, degraded: 0, ok: 0, sources: ['DHCP'] }
  }));

  await page.click('#ni-diag-open');
  const opened = await page.evaluate(() => document.getElementById('ni-diag-modal').hidden);
  await page.keyboard.press('Escape');
  const closed = await page.evaluate(() => document.getElementById('ni-diag-modal').hidden);
  await close();

  assert.strictEqual(opened, false, 'precondition: the report was open');
  assert.strictEqual(closed, true);
});

test('a /22 scope reads as one network, with its full DHCP range', async () => {
  const { page, close } = await open(inventory());
  const view = await page.evaluate(() => {
    const nets = [...document.querySelectorAll('#ni-net-list .ni-net')].map((n) => ({
      cidr: n.querySelector('.ni-cidr')?.textContent.trim() || null,
      count: n.querySelector('.ni-net-count')?.textContent.trim() || null
    }));
    const range = document.querySelector('#ni-cards .ni-range');
    return { nets, range: range ? range.textContent.trim() : null };
  });
  await close();

  assert.strictEqual(view.nets.length, 1, 'the scope must not split into /24 rows');
  assert.strictEqual(view.nets[0].cidr, '10.0.0.0/22');
  assert.match(view.nets[0].count, /1\s?022/, 'the row must size itself on the /22, not on 254');
  // The range used to render as ".50 — .200", which is wrong the moment a scope
  // crosses a /24 boundary. Both ends now, in full.
  assert.ok(view.range && view.range.includes('10.0.1.50'), `range was: ${view.range}`);
  assert.ok(view.range.includes('10.0.3.200'), `range was: ${view.range}`);
});

// ── DHCP failover line ──────────────────────────────────────────────────────
// The scan decides which server speaks for a shared scope
// (shield/netscan/DhcpFailover.ps1); the card names it in its title and says
// why on one line. A takeover means the primary is down, so it must read as a
// warning, not as a caption.

async function readDhcpCard(failover, server) {
  const body = inventory();
  body.subnets[0].dhcp = { ...body.subnets[0].dhcp, server, failover };
  const { page, close, pageErrors } = await open(body);
  const card = await page.evaluate(() => {
    const title = document.querySelector('#ni-cards .ni-ctx-title');
    const line = document.querySelector('#ni-cards .ni-failover');
    return {
      title: title ? title.textContent.trim() : null,
      line: line ? line.textContent.trim() : null,
      takeover: line ? line.classList.contains('takeover') : null
    };
  });
  await close();
  assert.deepStrictEqual(pageErrors, []);
  assert.ok(card.title, 'the DHCP card title must exist');
  return card;
}

test('a standalone scope shows no failover line', async () => {
  const card = await readDhcpCard(null, 'srvdhcp01');
  assert.match(card.title, /SRVDHCP01/);
  assert.strictEqual(card.line, null);
});

test('hot standby names the primary in the title and the standby on the line', async () => {
  const card = await readDhcpCard({
    mode: 'hotstandby', authority: 'dhcp1', servers: ['dhcp1', 'dhcp2'],
    state: 'Normal', takeover: false
  }, 'dhcp1');
  assert.match(card.title, /DHCP1/);
  assert.doesNotMatch(card.title, /DHCP2/, 'the standby does not speak for the scope');
  assert.ok(card.line && /DHCP2/.test(card.line), `line was: ${card.line}`);
  assert.strictEqual(card.takeover, false);
});

test('a takeover names the standby and reads as a warning', async () => {
  const card = await readDhcpCard({
    mode: 'hotstandby', authority: 'dhcp2', servers: ['dhcp1', 'dhcp2'],
    state: 'PartnerDown', takeover: true
  }, 'dhcp2');
  assert.match(card.title, /DHCP2/);
  assert.ok(card.line && /DHCP2/.test(card.line), `line was: ${card.line}`);
  assert.strictEqual(card.takeover, true);
});

test('load balance names both servers in the title', async () => {
  const card = await readDhcpCard({
    mode: 'loadbalance', authority: '', servers: ['dhcp1', 'dhcp2'],
    state: 'Normal', takeover: false
  }, 'dhcp1 / dhcp2');
  assert.match(card.title, /DHCP1 \/ DHCP2/);
  assert.ok(card.line, 'the load-balance line must render');
  assert.strictEqual(card.takeover, false);
});
