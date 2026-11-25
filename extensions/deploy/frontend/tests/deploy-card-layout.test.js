/**
 * The project card's layout, measured at three widths.
 *
 * Each rule here was reported on screen, fixed, and then shipped without the
 * fix more than once (the fix sat on a branch that never reached main). A rule
 * that is only a sentence in a review comes back; a measured one fails here.
 *
 *   - the action row sits on the bottom edge of every card in a row;
 *   - no button label breaks over two lines (tablet width did that);
 *   - Protected is on the name's line, and a long name ends in an ellipsis
 *     at least 8px before it;
 *   - nothing in the card is wider than the card.
 *
 * French on purpose: its labels are the longest the page has.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const harness = require('./harness');
if (!harness.available) {
  test('the Deploy project card layout', { skip: harness.why }, () => {});
  return;
}
const { serveFrontend, launchBrowser, openPage } = harness;

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

const SHA = 'aaaaaaa1111111111111111111111111111111111';
const LONG = 'reporting-portal-for-the-regional-operations-teams-and-their-managers-2026';

function project(over) {
  return Object.assign({
    id: 'site', name: 'site', repoFullName: 'acme/site', branch: 'main',
    lastSha: SHA, previousSha: null, deployedAt: Date.now() - 60000,
    lastError: null, failureCount: 0, pollGaveUp: false, history: [],
    port: 3081, url: 'http://srv.corp.local:3081/', serving: true,
    releases: [], runtime: 'static', running: null, draining: null,
    pendingSha: null, parentId: null, hasPreview: false, previews: []
  }, over || {});
}

function stubs() {
  return {
    '/api/deploy/status': {
      success: true, enabled: true, detection: 'poll',
      github: { connected: true, appId: 123, slug: 'aegis-deploy-test' },
      capabilities: { projects: true, builds: true, runtimes: true }
    },
    '/api/deploy/projects': { success: true, projects: [
      project({ id: 'short', name: 'docs' }),
      project({ id: 'long', name: LONG, protected: true, lastError: 'poll_failed', port: 3082 }),
      project({ id: 'third', name: 'intranet', lastSha: null, port: null, url: null })
    ] },
    '/api/deploy/github/installations': { success: true, installations: [] },
    '/api/deploy/runs': { success: true, runs: [] },
    'auth/me': { loggedIn: true, tenant: 'test', userId: 1, email: 'admin@example.com', role: 'admin' }
  };
}

/** Every number the rules need, read in one pass. */
function measure(page) {
  return page.evaluate(function () {
    function box(n) { var r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; }
    var grid = document.querySelector('#deploy-project-list');
    var cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
    var cards = Array.prototype.map.call(grid.querySelectorAll('.dep-card'), function (c) {
      var name = c.querySelector('.dep-card-name-text');
      var lock = c.querySelector('.dep-card-lock');
      var actions = c.querySelector('.dep-card-body > .dep-card-actions');
      var buttons = Array.prototype.map.call(actions.querySelectorAll('.dep-btn:not(.dep-btn-icon)'), function (b) {
        var cs = getComputedStyle(b);
        return { text: b.textContent, height: b.getBoundingClientRect().height, line: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4, padY: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + 2 };
      });
      return {
        card: box(c),
        actions: box(actions),
        overflow: c.scrollWidth - c.clientWidth,
        name: box(name),
        nameCut: name.scrollWidth > name.clientWidth,
        nameEllipsis: getComputedStyle(name).textOverflow,
        nameTitle: name.title,
        lock: lock ? box(lock) : null,
        buttons: buttons
      };
    });
    return { cols: cols, cards: cards };
  });
}

for (const [width, expectCols] of [[1600, 3], [996, 2], [768, 2], [390, 1]]) {
  test(`at ${width}px the cards keep their layout`, async () => {
    const { page, close } = await openPage(browser, server.url + '/pages/deploy.html#projects', stubs(), {
      beforeLoad: async (p) => {
        await p.setViewport({ width, height: 900 });
        await p.evaluateOnNewDocument(function () { localStorage.setItem('aegis_lang', 'fr'); });
      }
    });
    try {
      await page.waitForSelector('#deploy-project-list .dep-card .dep-card-actions', { timeout: 15000 });
      const m = await measure(page);

      assert.strictEqual(m.cols, expectCols, `columns at ${width}px`);
      assert.strictEqual(m.cards.length, 3);

      // Cards on the same row: the action rows end on the same line.
      const rows = {};
      for (const c of m.cards) (rows[Math.round(c.card.top)] = rows[Math.round(c.card.top)] || []).push(c);
      for (const row of Object.values(rows)) {
        const bottoms = row.map((c) => Math.round(c.actions.bottom));
        assert.ok(Math.max(...bottoms) - Math.min(...bottoms) <= 1, `action rows end together: ${bottoms}`);
        for (const c of row) {
          assert.ok(c.card.bottom - c.actions.bottom <= 18, `actions sit on the card's bottom edge (${c.card.bottom - c.actions.bottom}px gap)`);
        }
      }

      for (const c of m.cards) {
        assert.ok(c.overflow <= 0, `nothing wider than the card (${c.overflow}px over)`);
        for (const b of c.buttons) {
          assert.ok(b.height <= b.line + b.padY + 1, `"${b.text}" on one line (${b.height}px)`);
        }
      }

      const long = m.cards.find((c) => c.lock);
      assert.ok(long, 'the protected card shows its badge');
      assert.ok(Math.abs((long.lock.top + long.lock.bottom) / 2 - (long.name.top + long.name.bottom) / 2) <= 4,
        'Protected sits on the name line');
      assert.strictEqual(long.nameCut, true, 'the long name is cut');
      assert.strictEqual(long.nameEllipsis, 'ellipsis', 'and the cut is an ellipsis');
      assert.strictEqual(long.nameTitle, LONG, 'the whole name stays in the tooltip');
      assert.ok(long.lock.left - long.name.right >= 8, `a safe zone before the badge (${long.lock.left - long.name.right}px)`);
    } finally {
      await close();
    }
  });
}
