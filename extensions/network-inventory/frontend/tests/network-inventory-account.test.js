/**
 * Tier 3 · the scan account bar and its dialog.
 *
 * What matters: an admin sees who the scan reads the network as, the service
 * identity when no account is set; a non-admin sees nothing; the dialog opens
 * on the current account, shows what the access test found, and forgets every
 * password typed into it when it closes. Each assertion first checks that the
 * element it reads exists, so a renamed id fails rather than passing on null.
 *
 * Not covered: the server side of saving, which backend/tests/accountRoutes
 * covers, and anything Windows does with the password.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const harness = require('./harness');
if (!harness.available) {
  test('the Network Inventory scan account, inside the Aegis shell', { skip: harness.why }, () => {});
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

const EMPTY_INVENTORY = {
  ...DEFAULT_API_BODY, success: true, scannedAt: null, totalScans: 0, subnets: [], ips: [],
  diagnostics: [], diagnosticsSummary: { status: 'ok', failed: 0, degraded: 0, ok: 0, sources: [] }, context: null
};

const SAVED = {
  success: true,
  account: { account: 'CORP\\svc-scan', updatedAt: '2026-10-09T08:00:00.000Z', updatedBy: 'admin@corp.local' },
  serviceIdentity: 'CORP\\SRV-AUDIT$',
  canChange: true
};

async function open(accountBody, extra = {}) {
  const opened = await openPage(browser, `${server.url}${PAGE}`, {
    '/api/inventory/network': EMPTY_INVENTORY,
    '/api/inventory/account': accountBody,
    ...extra
  });
  await opened.page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
  return opened;
}

function readBar() {
  const bar = document.getElementById('ni-account');
  const name = document.getElementById('ni-account-name');
  if (!bar || !name) return null;
  return {
    displayed: !bar.hidden && getComputedStyle(bar).display !== 'none',
    name: name.textContent.trim(),
    note: (document.getElementById('ni-account-note') || {}).textContent || '',
    hasChange: !!document.getElementById('ni-account-change'),
    // The gear beside "Relancer le scan". null when the element is gone, so a
    // renamed id cannot read as "hidden".
    gear: (g => (g ? getComputedStyle(g).display !== 'none' : null))(document.getElementById('ni-account-gear'))
  };
}

test('without an account the bar names the service identity, and says so', async () => {
  const { page, close, pageErrors } = await open({ ...SAVED, account: null });
  const bar = await page.evaluate(readBar);
  await close();
  assert.deepStrictEqual(pageErrors, []);
  assert.ok(bar, 'the bar must exist in the page');
  assert.strictEqual(bar.displayed, true);
  assert.strictEqual(bar.name, 'CORP\\SRV-AUDIT$');
  assert.match(bar.note, /service/);
  assert.strictEqual(bar.hasChange, true);
  assert.strictEqual(bar.gear, true, 'an admin sees the gear');
});

test('a saved account is the one the bar names', async () => {
  const { page, close } = await open(SAVED);
  const bar = await page.evaluate(readBar);
  await close();
  assert.ok(bar, 'the bar must exist in the page');
  assert.strictEqual(bar.name, 'CORP\\svc-scan');
  assert.strictEqual(bar.note.trim(), '');
});

test('a refused account read (not an admin) keeps the bar hidden', async () => {
  const { page, close } = await open(null);
  const bar = await page.evaluate(readBar);
  await close();
  assert.ok(bar, 'the bar must exist in the page');
  assert.strictEqual(bar.displayed, false);
  assert.strictEqual(bar.gear, false, 'and no gear either');
});

test('the gear opens the same dialog as the bar', async () => {
  const { page, close } = await open(SAVED);
  await page.click('#ni-account-gear');
  const visible = await page.evaluate(() => {
    const modal = document.getElementById('ni-account-modal');
    return modal ? !modal.hidden && getComputedStyle(modal).display !== 'none' : null;
  });
  await close();
  assert.strictEqual(visible, true);
});

test('the dialog opens on the current account and forgets passwords when it closes', async () => {
  const { page, close, pageErrors } = await open(SAVED);
  await page.click('#ni-account-change');
  const opened = await page.evaluate(() => {
    const modal = document.getElementById('ni-account-modal');
    const input = document.getElementById('ni-account-input');
    const reset = document.getElementById('ni-account-reset');
    if (!modal || !input || !reset) return null;
    return { visible: !modal.hidden && getComputedStyle(modal).display !== 'none', account: input.value, resetShown: !reset.hidden };
  });
  await page.type('#ni-account-secret', 'typed-secret');
  await page.type('#ni-account-password', 'typed-aegis');
  await page.keyboard.press('Escape');
  const closed = await page.evaluate(() => ({
    hidden: document.getElementById('ni-account-modal').hidden,
    secret: document.getElementById('ni-account-secret').value,
    password: document.getElementById('ni-account-password').value
  }));
  await close();
  assert.deepStrictEqual(pageErrors, []);
  assert.ok(opened, 'the dialog and its fields must exist');
  assert.deepStrictEqual(opened, { visible: true, account: 'CORP\\svc-scan', resetShown: true });
  assert.deepStrictEqual(closed, { hidden: true, secret: '', password: '' });
});

test('the access test lists what each source answered, failures flagged', async () => {
  const { page, close, pageErrors } = await open(SAVED, {
    '/api/inventory/account/check': {
      success: true,
      account: 'CORP\\svc-scan',
      diagnostics: [
        { source: 'DHCP', status: 'failed', message: 'Accès refusé par srv-dhcp.corp.local.', hint: 'Ajouter CORP\\svc-scan au groupe DHCP Users.' },
        { source: 'DNS', status: 'ok', message: '3 zone(s) DNS lue(s).' }
      ]
    }
  });
  await page.click('#ni-account-change');
  await page.click('#ni-account-test');
  await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
  const result = await page.evaluate(() => {
    const list = document.getElementById('ni-account-results');
    const msg = document.getElementById('ni-account-msg');
    if (!list || !msg) return null;
    return {
      entries: [...list.querySelectorAll('.ni-diag-entry')].map(e => ({
        source: e.querySelector('.ni-diag-source').textContent, failed: e.classList.contains('failed')
      })),
      hint: list.textContent.includes('DHCP Users'),
      error: msg.classList.contains('error')
    };
  });
  await close();
  assert.deepStrictEqual(pageErrors, []);
  assert.ok(result, 'the results list and the message must exist');
  assert.deepStrictEqual(result.entries, [{ source: 'DHCP', failed: true }, { source: 'DNS', failed: false }]);
  assert.strictEqual(result.hint, true);
  assert.strictEqual(result.error, true, 'a refused source must read as a failure');
});
