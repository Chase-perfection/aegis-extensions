/**
 * Tier 3 — the DHCP half of the Network Inventory page.
 *
 * Two things are pinned here, and both started as a sentence that was not true.
 *
 * The subnet card read "no DHCP scope for this network" whenever the network
 * carried none, including when a DHCP server had refused the read. So the first
 * group checks what the card says in each case: a server left unread, every
 * server read, no server known, and an inventory too old to know.
 *
 * The DHCP view then has to show what the scan actually holds, per server, and
 * nothing it does not: an unread server must read as unread, not as empty.
 *
 * Every read below first checks that the element exists and is displayed, and
 * the labels are read off the screen rather than assumed: 0.0.2 of this
 * extension shipped a dialog whose every label was a raw translation key, and
 * a test that only counted elements would have passed on it.
 *
 * Not covered: a real DHCP server. The fixtures have the shape
 * inventoryService.normalizeDhcp() returns; whether the scan fills that shape
 * correctly against Windows Server is a check to make on a real host.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const harness = require('./harness');
if (!harness.available) {
  test('the Network Inventory DHCP view, inside the Aegis shell', { skip: harness.why }, () => {});
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

const SCOPE = {
  scopeId: '10.0.0.0', mask: '255.255.252.0', cidr: '10.0.0.0/22', name: 'Postes', state: 'Active',
  rangeStart: '10.0.1.50', rangeEnd: '10.0.1.149', leaseSeconds: 691200, utilization: null,
  exclusions: [{ start: '10.0.1.50', end: '10.0.1.59' }],
  leases: [
    { ip: '10.0.1.72', mac: '00:11:22:33:44:55', hostName: 'poste-b', state: 'Active', expiresAt: '2026-09-20T08:00:00.000Z' },
    { ip: '10.0.1.60', mac: '02:00:00:AA:BB:01', hostName: 'mobile-a', state: 'Active', expiresAt: '2026-09-21T08:00:00.000Z' },
    { ip: '10.0.1.61', mac: '06:00:00:AA:BB:02', hostName: 'mobile-a', state: 'Active', expiresAt: '2026-09-22T08:00:00.000Z' },
    { ip: '10.0.1.90', mac: '00:11:22:33:44:66', hostName: 'ancien', state: 'Expired', expiresAt: '2026-09-01T08:00:00.000Z' }
  ],
  reservations: [{ ip: '10.0.1.140', mac: '00:11:22:33:44:77', name: 'imprimante' }],
  failover: null
};

const SRV_READ = {
  name: 'srv-dhcp-01', fqdn: 'srv-dhcp-01.corp.local', origin: 'directory', status: 'read',
  filters: {
    allowEnabled: false, denyEnabled: true,
    allow: [], deny: [{ mac: '02-00-00-AA-BB-CC', description: 'Appareil perdu' }]
  },
  scopes: [SCOPE]
};
const SRV_REFUSED = {
  name: 'srv-dhcp-02', fqdn: 'srv-dhcp-02.corp.local', origin: 'declared', status: 'refused',
  filters: null, scopes: []
};
const REFUSAL = {
  source: 'DHCP - srv-dhcp-02', status: 'failed',
  message: 'Le serveur DHCP srv-dhcp-02.corp.local a refusé la lecture de ses étendues.',
  hint: 'Ajouter le compte du scan au groupe DHCP Users.',
  command: 'Get-DhcpServerv4Scope -ComputerName srv-dhcp-02.corp.local',
  detail: 'WIN32 5', at: '2026-09-15T08:30:01.000Z'
};

const WITH_SCOPE = '10.0.0.0/22';
const WITHOUT_SCOPE = '10.0.8.0/24';

/** Two networks: one carrying a scope, one carrying none. */
function inventory(dhcp, extra) {
  return {
    ...DEFAULT_API_BODY,
    success: true,
    scannedAt: '2026-09-15T08:30:00.000Z',
    totalScans: 3,
    subnets: [{
      cidr: WITH_SCOPE, network: '10.0.0.0', prefix: 22, mask: '255.255.252.0',
      label: 'Postes', vlan: null, description: 'Postes', usedCount: 1, totalCount: 1022,
      dhcp: { server: 'srv-dhcp-01', rangeStart: '10.0.1.50', rangeEnd: '10.0.1.149', utilization: 3, activeLeases: 3, reservations: 1, leaseDays: 8 },
      dns: null, anomalies: { total: 0, conflicts: 0, aWithoutPtr: 0, orphanPtr: 0 }
    }, {
      cidr: WITHOUT_SCOPE, network: '10.0.8.0', prefix: 24, mask: '255.255.255.0',
      label: '', vlan: null, description: '', usedCount: 1, totalCount: 254,
      dhcp: null, dns: null, anomalies: { total: 0, conflicts: 0, aWithoutPtr: 0, orphanPtr: 0 }
    }],
    ips: [
      { ip: '10.0.1.60', network: WITH_SCOPE, status: 'used', hostname: 'mobile-a', mac: '', dns: [], dnsRecords: [], dhcp: { kind: 'lease', detail: 'Bail', expiresAt: null }, anomalies: [], evidence: null },
      { ip: '10.0.8.5', network: WITHOUT_SCOPE, status: 'used', hostname: 'borne', mac: '', dns: [], dnsRecords: [], dhcp: { kind: 'none', detail: '', expiresAt: null }, anomalies: [], evidence: null }
    ],
    diagnostics: [],
    diagnosticsSummary: { status: 'ok', failed: 0, degraded: 0, ok: 0, sources: [] },
    context: null,
    dhcp,
    ...extra
  };
}

async function open(body, stubs) {
  const opened = await openPage(browser, `${server.url}${PAGE}`, {
    '/api/inventory/network': body,
    '/api/inventory/dhcp/servers': { success: true, servers: ['srv-dhcp-02.corp.local'] },
    ...stubs
  });
  await opened.page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
  return opened;
}

const settle = (page) => page.evaluate(() => new Promise((r) => setTimeout(r, 150)));

/** The DHCP card of the selected network, read off the screen. */
function readCard() {
  const card = document.querySelector('#ni-cards .ni-ctx-card');
  if (!card) return null;
  return {
    displayed: getComputedStyle(card).display !== 'none' && card.getBoundingClientRect().height > 0,
    absence: card.getAttribute('data-dhcp-absence'),
    text: card.textContent.replace(/\s+/g, ' ').trim(),
    report: !!card.querySelector('[data-ni-diag]'),
    declare: !!card.querySelector('[data-ni-dhcp-servers]'),
    manage: card.querySelector('[data-ni-manage]') ? !card.querySelector('[data-ni-manage]').disabled : null
  };
}

async function selectNetwork(page, cidr) {
  const found = await page.evaluate((c) => {
    const el = [...document.querySelectorAll('.ni-net')].find((n) => n.dataset.cidr === c);
    if (!el) return false;
    el.click();
    return true;
  }, cidr);
  assert.ok(found, `the network ${cidr} must be listed`);
  await settle(page);
}

/** Which of the two views is on screen, measured rather than read off an attribute. */
function readPanes() {
  const shown = (el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
  const panes = [...document.querySelectorAll('[data-ni-pane]')];
  return {
    count: panes.length,
    networks: panes.filter((p) => p.dataset.niPane === 'networks').every(shown),
    dhcp: panes.filter((p) => p.dataset.niPane === 'dhcp').every(shown),
    networksHidden: panes.filter((p) => p.dataset.niPane === 'networks').every((p) => !shown(p)),
    dhcpHidden: panes.filter((p) => p.dataset.niPane === 'dhcp').every((p) => !shown(p))
  };
}

/** Everything the DHCP view shows, as text. */
function readDhcp() {
  const pane = document.querySelector('.ni-main[data-ni-pane="dhcp"]');
  const tree = document.getElementById('ni-dhcp-tree');
  if (!pane || !tree) return null;
  const texts = (sel, root) => [...(root || pane).querySelectorAll(sel)].map((e) => e.textContent.replace(/\s+/g, ' ').trim());
  return {
    title: document.getElementById('ni-dhcp-title').textContent.trim(),
    subtitle: document.getElementById('ni-dhcp-subtitle').textContent.trim(),
    cards: texts('#ni-dhcp-summary .ni-ctx-card'),
    tabs: texts('#ni-dhcp-tabs .ni-seg'),
    activeTab: texts('#ni-dhcp-tabs .ni-seg.active')[0] || null,
    head: texts('#ni-dhcp-thead .ni-dhcp-sort'),
    rows: texts('#ni-dhcp-tbody .ni-dhcp-line'),
    firstCells: [...pane.querySelectorAll('#ni-dhcp-tbody .ni-dhcp-line')].map((l) => l.firstElementChild.textContent.trim()),
    empty: texts('#ni-dhcp-tbody .ni-empty-state')[0] || null,
    emptyReport: !!pane.querySelector('#ni-dhcp-tbody [data-ni-diag]'),
    count: document.getElementById('ni-dhcp-count').textContent.trim(),
    note: document.getElementById('ni-dhcp-note').textContent.trim(),
    nodes: texts('.ni-dhcp-node', tree),
    selectedNodes: texts('.ni-dhcp-node.selected', tree),
    foot: document.getElementById('ni-dhcp-foot').textContent.trim(),
    rawKeys: (pane.textContent + ' ' + tree.textContent).match(/\bni_[a-z0-9_]+/g) || []
  };
}

async function click(page, selector, nth = 0) {
  const ok = await page.evaluate((sel, i) => {
    const el = document.querySelectorAll(sel)[i];
    if (!el) return false;
    el.click();
    return true;
  }, selector, nth);
  assert.ok(ok, `nothing to click at ${selector}[${nth}]`);
  await settle(page);
}

// ── The subnet card says what the scan knows, and no more ───────────────────

test('a network with no scope and a server left unread says the scope was not read', async () => {
  const { page, close, pageErrors } = await open(inventory({ servers: [SRV_READ, SRV_REFUSED] }, {
    diagnostics: [REFUSAL],
    diagnosticsSummary: { status: 'failed', failed: 1, degraded: 0, ok: 0, sources: [REFUSAL.source], failedSources: [REFUSAL.source], degradedSources: [] }
  }));
  await selectNetwork(page, WITHOUT_SCOPE);
  const card = await page.evaluate(readCard);

  assert.deepStrictEqual(pageErrors, []);
  assert.ok(card && card.displayed, 'the DHCP card must be on screen');
  assert.strictEqual(card.absence, 'unread');
  assert.match(card.text, /non lue/);
  assert.match(card.text, /1 serveur\(s\) DHCP sur 2/);
  assert.match(card.text, /SRV-DHCP-02/, 'the server that was not read is named');
  assert.doesNotMatch(card.text, /Aucune étendue/, 'an absence nobody checked must not be stated');
  assert.ok(card.report, 'the card must lead to the report');

  // The link does what it says: the report opens, with the refusal in it.
  await click(page, '#ni-cards [data-ni-diag]');
  const report = await page.evaluate(() => {
    const modal = document.getElementById('ni-diag-modal');
    return { open: !!modal && !modal.hidden, text: modal ? modal.textContent : '' };
  });
  await close();
  assert.ok(report.open, 'the diagnostic report must open from the card');
  assert.match(report.text, /srv-dhcp-02/);
});

test('with every server read, the card says so and names them', async () => {
  const { page, close, pageErrors } = await open(inventory({ servers: [SRV_READ] }));
  await selectNetwork(page, WITHOUT_SCOPE);
  const card = await page.evaluate(readCard);

  assert.deepStrictEqual(pageErrors, []);
  assert.strictEqual(card.absence, 'none');
  assert.match(card.text, /Aucune étendue pour ce réseau sur les serveurs lus/);
  assert.match(card.text, /SRV-DHCP-01/);
  assert.ok(card.declare, 'the card must offer to declare another server');
  assert.strictEqual(card.report, false);

  await click(page, '#ni-cards [data-ni-dhcp-servers]');
  const dialog = await page.evaluate(() => {
    const m = document.getElementById('ni-dhcp-servers-modal');
    return { open: !!m && !m.hidden && getComputedStyle(m).display !== 'none', value: document.getElementById('ni-dhcp-servers-input').value };
  });
  await close();
  assert.ok(dialog.open, 'the declared servers dialog must open from the card');
  assert.strictEqual(dialog.value, 'srv-dhcp-02.corp.local');
});

test('with no DHCP server known, the card says there was nobody to ask', async () => {
  const { page, close } = await open(inventory({ servers: [] }));
  await selectNetwork(page, WITHOUT_SCOPE);
  const card = await page.evaluate(readCard);
  await close();
  assert.strictEqual(card.absence, 'noserver');
  assert.match(card.text, /Aucun serveur DHCP connu/);
  assert.ok(card.declare);
});

test('an inventory written before the scan listed its servers claims nothing', async () => {
  const { page, close, pageErrors } = await open(inventory(null));
  await selectNetwork(page, WITHOUT_SCOPE);
  const card = await page.evaluate(readCard);
  await close();
  assert.deepStrictEqual(pageErrors, []);
  assert.strictEqual(card.absence, 'unknown');
  assert.match(card.text, /Relancer le scan/);
  assert.doesNotMatch(card.text, /pour ce réseau sur les serveurs lus/);
});

// ── The DHCP view ───────────────────────────────────────────────────────────

test('the page opens on the subnet explorer, and the switch shows the DHCP view alone', async () => {
  const { page, close, pageErrors } = await open(inventory({ servers: [SRV_READ, SRV_REFUSED] }));
  const before = await page.evaluate(readPanes);
  assert.strictEqual(before.count, 4, 'two panes per view');
  assert.ok(before.networks && before.dhcpHidden, 'the subnet explorer is the opening view');

  await click(page, '.ni-sidebar[data-ni-pane="networks"] [data-ni-view="dhcp"]');
  const during = await page.evaluate(readPanes);
  assert.ok(during.dhcp && during.networksHidden, 'the DHCP view replaces the explorer, it does not sit beside it');

  await click(page, '.ni-sidebar[data-ni-pane="dhcp"] [data-ni-view="networks"]');
  const back = await page.evaluate(readPanes);
  await close();
  assert.deepStrictEqual(pageErrors, []);
  assert.ok(back.networks && back.dhcpHidden);
});

test('"Gérer" on a network opens its scope, with every label readable', async () => {
  const { page, close, pageErrors } = await open(inventory({ servers: [SRV_REFUSED, SRV_READ] }));
  const card = await page.evaluate(readCard);
  assert.strictEqual(card.manage, true, 'the manage link must be enabled on a network that has a scope');

  await click(page, '#ni-cards [data-ni-manage]');
  const panes = await page.evaluate(readPanes);
  const v = await page.evaluate(readDhcp);
  await close();

  assert.deepStrictEqual(pageErrors, []);
  assert.ok(panes.dhcp && panes.networksHidden);
  assert.ok(v, 'the DHCP view must exist');
  assert.strictEqual(v.title, WITH_SCOPE);
  assert.strictEqual(v.subtitle, 'Postes · SRV-DHCP-01');
  assert.deepStrictEqual(v.tabs, ['Baux · 4', 'Réservations · 1', "Pool d'adresses · 2"]);
  assert.strictEqual(v.activeTab, 'Baux · 4');
  assert.deepStrictEqual(v.head, ['ADRESSE IP', "NOM D'HÔTE", 'MAC', 'ÉTAT', 'EXPIRE']);
  assert.deepStrictEqual(v.rawKeys, [], 'a raw translation key reached the screen');

  // Leases, in address order whatever order the server returned them in.
  assert.deepStrictEqual(v.firstCells, ['10.0.1.60', '10.0.1.61', '10.0.1.72', '10.0.1.90']);
  assert.match(v.rows[0], /mobile-a.*PLUSIEURS BAUX/, 'a host name holding two active leases is flagged');
  assert.match(v.rows[0], /02:00:00:AA:BB:01.*ALÉATOIRE/, 'a locally administered MAC is flagged');
  assert.doesNotMatch(v.rows[2], /ALÉATOIRE|PLUSIEURS BAUX/, 'a burned-in MAC on a single lease carries no flag');
  assert.match(v.rows[3], /Expiré/);
  assert.doesNotMatch(v.rows[3], /PLUSIEURS BAUX/);
  assert.strictEqual(v.count, '4 ligne(s) sur 4');
  assert.match(v.note, /Lecture seule/);

  // The three summary cards: range, occupancy from the pool, lease facts.
  assert.strictEqual(v.cards.length, 3);
  assert.match(v.cards[0], /PLAGE.*10\.0\.1\.50 → 10\.0\.1\.149.*masque 255\.255\.252\.0/);
  // 100 addresses, 10 excluded, 3 active leases: 3 of 90, rounded.
  assert.match(v.cards[1], /OCCUPATION.*3%.*3 baux actifs · 90 adresses distribuables · 10 exclues/);
  assert.match(v.cards[2], /Durée du bail : 8 j/);
  assert.match(v.cards[2], /2 MAC aléatoire\(s\) sur 3 baux actifs · 1 nom\(s\) d'hôte sur plusieurs baux/);

  assert.match(v.selectedNodes.join(' | '), /10\.0\.0\.0\/22/, 'the tree marks the scope that is open');
});

test('the tree lists every server the scan tried, and an unread one reads as unread', async () => {
  const { page, close, pageErrors } = await open(inventory({ servers: [SRV_READ, SRV_REFUSED] }, { diagnostics: [REFUSAL] }));
  await click(page, '.ni-sidebar[data-ni-pane="networks"] [data-ni-view="dhcp"]');
  const tree = await page.evaluate(readDhcp);
  assert.strictEqual(tree.foot, '1 serveur(s) lu(s) sur 2');
  assert.ok(tree.nodes.some((n) => /SRV-DHCP-01.*Lu/.test(n)), 'the read server and its status');
  assert.ok(tree.nodes.some((n) => /SRV-DHCP-02.*Accès refusé/.test(n)), 'the refused server and its status');
  assert.ok(tree.nodes.some((n) => /Filtres MAC/.test(n)));

  const clicked = await page.evaluate(() => {
    const node = [...document.querySelectorAll('.ni-dhcp-node')].find((n) => n.dataset.dhcpServer === 'srv-dhcp-02' && n.dataset.dhcpKind === 'server');
    if (!node) return false;
    node.click();
    return true;
  });
  assert.ok(clicked, 'the refused server must be a node of the tree');
  await settle(page);
  const v = await page.evaluate(readDhcp);
  await close();

  assert.deepStrictEqual(pageErrors, []);
  assert.strictEqual(v.title, 'SRV-DHCP-02');
  assert.match(v.cards[0], /ÉTAT.*Accès refusé.*a refusé la lecture/, "the scan's own diagnostic explains the status");
  assert.match(v.cards[1], /Déclaré à la main/);
  assert.match(v.cards[2], /Non lus/);
  assert.deepStrictEqual(v.rows, []);
  assert.match(v.empty, /n'a pas été lu : ses étendues sont inconnues/);
  assert.doesNotMatch(v.empty, /ne déclare aucune étendue/, 'unread is not empty');
  assert.ok(v.emptyReport, 'an unread server must lead to the report');
  assert.deepStrictEqual(v.rawKeys, []);
});

test('reservations, the address pool and the MAC filters each have their table', async () => {
  const { page, close, pageErrors } = await open(inventory({ servers: [SRV_READ] }));
  await click(page, '#ni-cards [data-ni-manage]');

  await click(page, '#ni-dhcp-tabs .ni-seg', 1);
  const res = await page.evaluate(readDhcp);
  assert.deepStrictEqual(res.head, ['ADRESSE IP', 'NOM', 'MAC']);
  assert.strictEqual(res.rows.length, 1);
  assert.match(res.rows[0], /10\.0\.1\.140.*imprimante.*00:11:22:33:44:77/);

  await click(page, '#ni-dhcp-tabs .ni-seg', 2);
  const pool = await page.evaluate(readDhcp);
  assert.deepStrictEqual(pool.head, ['DÉBUT', 'FIN', 'ADRESSES', 'RÔLE']);
  assert.strictEqual(pool.rows.length, 2);
  assert.ok(pool.rows.some((r) => /10\.0\.1\.50.*10\.0\.1\.149.*100.*Plage distribuée/.test(r)));
  assert.ok(pool.rows.some((r) => /10\.0\.1\.50.*10\.0\.1\.59.*10.*Exclue de la distribution/.test(r)));

  const opened = await page.evaluate(() => {
    const node = [...document.querySelectorAll('.ni-dhcp-node')].find((n) => n.dataset.dhcpKind === 'filters');
    if (!node) return false;
    node.click();
    return true;
  });
  assert.ok(opened, 'the filters node must exist under a server whose filters were read');
  await settle(page);
  const deny = await page.evaluate(readDhcp);
  assert.strictEqual(deny.title, 'Filtres MAC');
  assert.deepStrictEqual(deny.tabs, ['Refuser · 1', 'Autoriser · 0']);
  assert.match(deny.rows[0], /02-00-00-AA-BB-CC.*Appareil perdu/);
  assert.match(deny.cards[0], /LISTE REFUSER.*Appliquée · 1 adresse/);
  assert.match(deny.cards[1], /LISTE AUTORISER.*Coupée · 0 adresse/);
  assert.match(deny.cards[2], /adresse IP fixe ou une nouvelle adresse MAC/, 'the limit of a MAC filter is stated');

  await click(page, '#ni-dhcp-tabs .ni-seg', 1);
  const allow = await page.evaluate(readDhcp);
  await close();
  assert.deepStrictEqual(pageErrors, []);
  assert.deepStrictEqual(allow.rows, []);
  assert.match(allow.empty, /La liste Autoriser est vide/);
  assert.deepStrictEqual(allow.rawKeys, []);
});

test('the search narrows the rows and a column header reverses their order', async () => {
  const { page, close } = await open(inventory({ servers: [SRV_READ] }));
  await click(page, '#ni-cards [data-ni-manage]');

  await page.type('#ni-dhcp-search', 'mobile');
  await settle(page);
  const found = await page.evaluate(readDhcp);
  assert.deepStrictEqual(found.firstCells, ['10.0.1.60', '10.0.1.61']);
  assert.strictEqual(found.count, '2 ligne(s) sur 4');

  await page.evaluate(() => { const i = document.getElementById('ni-dhcp-search'); i.value = ''; i.dispatchEvent(new Event('input')); });
  await click(page, '#ni-dhcp-thead .ni-dhcp-sort', 0);
  const asc = await page.evaluate(readDhcp);
  await click(page, '#ni-dhcp-thead .ni-dhcp-sort', 0);
  const desc = await page.evaluate(readDhcp);
  await close();
  assert.deepStrictEqual(asc.firstCells, ['10.0.1.60', '10.0.1.61', '10.0.1.72', '10.0.1.90']);
  assert.deepStrictEqual(desc.firstCells, ['10.0.1.90', '10.0.1.72', '10.0.1.61', '10.0.1.60']);
});

test('a scan that knows no DHCP server leaves the view saying so, not blank', async () => {
  const { page, close, pageErrors } = await open(inventory({ servers: [] }));
  await click(page, '.ni-sidebar[data-ni-pane="networks"] [data-ni-view="dhcp"]');
  const v = await page.evaluate(readDhcp);
  await close();
  assert.deepStrictEqual(pageErrors, []);
  assert.match(v.empty, /Aucun serveur DHCP connu/);
  assert.deepStrictEqual(v.nodes, []);
});

// ── Declared servers ────────────────────────────────────────────────────────

/** Opens the dialog from the DHCP tree's foot and reads it. */
async function openServersDialog(page) {
  await click(page, '.ni-sidebar[data-ni-pane="networks"] [data-ni-view="dhcp"]');
  await click(page, '#ni-dhcp-servers-open');
  return page.evaluate(() => {
    const m = document.getElementById('ni-dhcp-servers-modal');
    return {
      open: !!m && !m.hidden && getComputedStyle(m).display !== 'none',
      title: document.getElementById('ni-dhcp-servers-title').textContent.trim(),
      value: document.getElementById('ni-dhcp-servers-input').value,
      buttons: [...m.querySelectorAll('.ni-diag-foot button')].map((b) => b.textContent.trim())
    };
  });
}

function readServersMsg() {
  const msg = document.getElementById('ni-dhcp-servers-msg');
  return { hidden: msg.hidden, text: msg.textContent.trim(), error: msg.classList.contains('error'), ok: msg.classList.contains('ok') };
}

test('the declared servers dialog shows the list and confirms a save', async () => {
  const { page, close, pageErrors } = await open(inventory({ servers: [SRV_READ] }));
  const dialog = await openServersDialog(page);
  assert.ok(dialog.open);
  assert.strictEqual(dialog.title, 'Serveurs DHCP déclarés');
  assert.strictEqual(dialog.value, 'srv-dhcp-02.corp.local');
  assert.deepStrictEqual(dialog.buttons, ['Fermer', 'Enregistrer']);

  await click(page, '#ni-dhcp-servers-save');
  const msg = await page.evaluate(readServersMsg);
  assert.strictEqual(msg.hidden, false);
  assert.ok(msg.ok);
  assert.match(msg.text, /prochain scan/);

  await page.keyboard.press('Escape');
  await settle(page);
  const closed = await page.evaluate(() => document.getElementById('ni-dhcp-servers-modal').hidden);
  await close();
  assert.deepStrictEqual(pageErrors, []);
  assert.strictEqual(closed, true, 'Escape closes the dialog');
});

test('a refused host name is named in the dialog, in a sentence', async () => {
  const { page, close } = await open(inventory({ servers: [SRV_READ] }), {
    '/api/inventory/dhcp/servers': { success: false, code: 'EBADSERVER', rejected: ['bad name'] }
  });
  await openServersDialog(page);
  await click(page, '#ni-dhcp-servers-save');
  const msg = await page.evaluate(readServersMsg);
  await close();
  assert.ok(msg.error);
  assert.match(msg.text, /Nom d'hôte refusé : bad name/);
  assert.doesNotMatch(msg.text, /EBADSERVER|ni_/);
});
