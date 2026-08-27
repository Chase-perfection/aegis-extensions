/**
 * Tier 3 -- the empty Projects pane, which is the first screen a new install
 * shows and the one that has to say what to do next.
 *
 * It used to say the same thing in both states: "Connect GitHub", primary,
 * pointing at the pane the reader had just come back from. An operator who had
 * finished connecting GitHub landed on an empty grid whose only instruction was
 * to do again what they had done. These tests pin the two states apart:
 *
 * - no App registered: connect GitHub first, pasting a URL still offered
 *   because a public repository needs no App
 * - App registered: deploy something, with the steps for doing it on screen
 *
 * The network is stubbed by core's helpers/browser.js, so this needs no backend.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const harness = require('./harness');
if (!harness.available) {
  test('the Deploy empty state, inside the Aegis shell', { skip: harness.why }, () => {});
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

/** The status payload of a host that has opted in, with `github` swapped in. */
function statusWith(github) {
  return {
    success: true,
    enabled: true,
    detection: 'poll',
    github: github,
    capabilities: { projects: true, builds: true, runtimes: false }
  };
}

function stubs(github) {
  return {
    '/api/deploy/status': statusWith(github),
    // Empty on purpose: the hero is what an install with no project shows.
    '/api/deploy/projects': { success: true, projects: [] },
    '/api/deploy/github/installations': { success: true, installations: [] }
  };
}

/** What the reader actually sees in the empty state. */
function readHero(page) {
  return page.evaluate(function () {
    var hero = document.getElementById('deploy-hero');
    var steps = document.getElementById('deploy-hero-steps');
    var primary = document.getElementById('deploy-hero-primary');
    var secondary = document.getElementById('deploy-hero-secondary');
    return {
      heroShown: hero && !hero.hidden,
      stepsShown: !!(steps && !steps.hidden),
      stepCount: steps ? steps.querySelectorAll('li').length : 0,
      title: (document.getElementById('deploy-hero-title') || {}).textContent,
      primary: { text: primary.textContent.trim(), href: primary.getAttribute('href'), key: primary.getAttribute('data-i18n') },
      secondary: { text: secondary.textContent.trim(), href: secondary.getAttribute('href'), key: secondary.getAttribute('data-i18n') }
    };
  });
}

test('with no App registered, the empty state sends the reader to connect GitHub', async () => {
  const { page, close } = await openPage(
    browser, server.url + '/pages/deploy.html', stubs({ connected: false }));
  try {
    await page.waitForSelector('#deploy-hero:not([hidden])');
    const hero = await readHero(page);

    assert.ok(hero.heroShown, 'an install with no project shows the hero');
    assert.strictEqual(hero.primary.href, '#github');
    assert.strictEqual(hero.primary.key, 'deploy_hero_connect');
    // A public repository clones with no App at all, so this way in stays open.
    assert.strictEqual(hero.secondary.href, '#new');
    assert.strictEqual(hero.secondary.key, 'deploy_hero_paste');
    assert.strictEqual(hero.stepsShown, false,
      'the first-deployment steps are not the instruction before GitHub is connected');
  } finally {
    await close();
  }
});

test('with an App registered, the empty state says how to deploy the first site', async () => {
  const { page, close } = await openPage(
    browser, server.url + '/pages/deploy.html',
    stubs({ connected: true, appId: 123, slug: 'aegis-deploy-briconord' }));
  try {
    await page.waitForSelector('#deploy-hero:not([hidden])');
    const hero = await readHero(page);

    assert.strictEqual(hero.primary.href, '#new',
      'the next action is deploying something, not connecting GitHub again');
    assert.strictEqual(hero.primary.key, 'deploy_hero_deploy');
    assert.strictEqual(hero.secondary.href, '#github');
    assert.strictEqual(hero.secondary.key, 'deploy_hero_manage');

    assert.strictEqual(hero.stepsShown, true, 'the steps are the point of this state');
    assert.strictEqual(hero.stepCount, 4);
    assert.ok(hero.title && hero.title.trim().length > 0);

    // The keys must move with the text, or core's applyTranslations() repaints
    // the button back to the other state on the next language switch.
    const afterRepaint = await page.evaluate(function () {
      if (typeof applyTranslations === 'function') applyTranslations();
      var primary = document.getElementById('deploy-hero-primary');
      return { text: primary.textContent.trim(), href: primary.getAttribute('href') };
    });
    assert.strictEqual(afterRepaint.href, '#new');
    assert.strictEqual(afterRepaint.text, hero.primary.text,
      're-applying translations must not undo the connected state');
  } finally {
    await close();
  }
});
