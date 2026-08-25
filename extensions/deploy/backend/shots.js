/**
 * The thumbnail on a project card: a picture of what a visitor sees first.
 *
 * Aegis renders nothing of a deployed site, so the card used to show a colour
 * derived from the project name. This takes the actual page instead, with the
 * puppeteer and the local-Chromium resolver core already installs for PDF
 * reports -- no new dependency, and no browser download on the host.
 *
 * Both of those arrive from core rather than being imported. An installed
 * extension lives under `C:\ProgramData\Aegis\extensions\<id>\`, from where no
 * relative path reaches the Aegis tree and no bare specifier reaches
 * `backend/node_modules`. `routes.js` receives core's capabilities from the
 * loader and hands the browser ones down here; see `useChrome` below.
 *
 * What gets photographed is deliberately whatever the site answers with, guard
 * page included. A protected site shows its sign-in form to a visitor, so the
 * card showing that form is the honest thumbnail; the alternative was minting a
 * capture token that walks past `siteAuth`, and a second door through the code
 * whose only job is refusing unauthenticated requests is not worth a picture.
 *
 * The capture targets 127.0.0.1 rather than the host name on the card. The port
 * is bound on this machine, so the loopback address always answers; the name
 * depends on a DNS record or a hosts entry that may not exist, and a thumbnail
 * is not the place to discover that.
 *
 * Nothing here throws. A capture is a nicety attached to a deployment, and a
 * deployment that succeeded must not be reported as failed because a browser
 * would not start.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const projectStore = require('./projectStore');
const siteServer = require('./siteServer');

const FILE = 'preview.png';

/** The card art is 158px tall in a ~345px column; 2x that, capped. */
const SHOT = { width: 1280, height: 800 };

/** Past this, the page is not going to settle and the deploy is waiting. */
const NAV_TIMEOUT_MS = 15000;
const LAUNCH_TIMEOUT_MS = 20000;

/** ~5s of grace for a first-deploy listener to come up. */
const SERVING_TRIES = 25;
const SERVING_POLL_MS = 200;

/**
 * One capture at a time for the whole process.
 *
 * Six projects redeploying together would otherwise launch six Chromiums on a
 * machine whose day job is auditing Active Directory. They queue instead: the
 * thumbnails are seconds late and the box stays usable.
 */
let chain = Promise.resolve();

/** Logged once, not per deployment: a host with no browser has no browser. */
let warnedNoChrome = false;

/** Logged once too: a core that hands over no browser hands over none. */
let warnedNoSeam = false;

/**
 * Core's browser capabilities, handed over by `register` (see `routes.js`).
 *
 * `resolveChrome` is `backend/src/lib/chromePath.resolveChrome`, which core
 * already uses to point puppeteer at a Chromium that exists on the host. It is
 * core's for a reason worth stating: it reads `PUPPETEER_EXECUTABLE_PATH` and
 * the install locations of Chrome and Edge, and two copies of that list would
 * drift into a report and a thumbnail disagreeing about which browser this
 * machine has.
 *
 * `puppeteer` is the driver itself, and it has to arrive the same way for the
 * same reason: it lives in `backend/node_modules`, which no specifier reaches
 * from an installed extension. It is read as optional so that a core which
 * passes only `resolveChrome` gets a missing picture rather than a broken
 * extension, and so that the day core passes it, nothing here changes.
 *
 * Empty until `register` runs. Nothing here is required for the extension to
 * work, only for a project card to carry a picture.
 */
let host = { resolveChrome: null, puppeteer: null };

/**
 * Receives the browser capabilities. Called once, from `register`.
 *
 * Written as a setter rather than as an argument on `capture`, because a capture
 * is started from `deployService` after a deploy and after a promote, and from
 * the poller's sweep -- none of which carries the loader's context. Threading it
 * through all three would put a browser detail in the signature of every
 * deployment.
 */
function useChrome(deps) {
    const d = deps || {};
    host = {
        resolveChrome: typeof d.resolveChrome === 'function' ? d.resolveChrome : null,
        puppeteer: d.puppeteer || null
    };
}

function shotPath(tenantPaths, projectId) {
    return path.join(projectStore.dataDir(tenantPaths, projectId), FILE);
}

function has(tenantPaths, projectId) {
    try {
        return fs.statSync(shotPath(tenantPaths, projectId)).size > 0;
    } catch (_) {
        return false;
    }
}

function remove(tenantPaths, projectId) {
    try {
        fs.unlinkSync(shotPath(tenantPaths, projectId));
    } catch (_) { /* nothing to remove is the state we wanted */ }
}

/** Loopback, because that is the address this process can always reach. */
function targetFor(project) {
    if (!project || !project.port) return null;
    const scheme = (project.tls && project.tls.enabled === true) ? 'https' : 'http';
    return `${scheme}://127.0.0.1:${project.port}/`;
}

/**
 * Waits for the project's listener to actually be open.
 *
 * `project.port` is the port allocated to the project, which is a different
 * fact from a socket accepting connections: `listen` reports a port already
 * taken on its 'error' event rather than by throwing, so a project can hold a
 * port whose bind failed. `isServing` is the live answer, and it is the one
 * worth photographing against.
 *
 * The wait exists because this runs the instant a deployment finishes. On a
 * project's first deploy the listener starts alongside, and a capture that
 * checked once would lose that race on exactly the deployment where a
 * thumbnail matters most.
 */
async function waitForServing(slug, projectId) {
    for (let i = 0; i < SERVING_TRIES; i++) {
        if (siteServer.isServing(slug, projectId)) return true;
        await new Promise((r) => setTimeout(r, SERVING_POLL_MS));
    }
    return siteServer.isServing(slug, projectId);
}

async function run(tenantPaths, project, slug) {
    const url = targetFor(project);
    if (!url) return false;

    // Nothing is answering on that port, so there is no deployed page to
    // photograph. Said plainly rather than left to a navigation timeout, which
    // would spend 15 seconds arriving at the same answer.
    if (!await waitForServing(slug, project.id)) {
        console.warn(`[Deploy] ${slug}: no listener open for ${project.id}, preview not captured`);
        return false;
    }

    // Core's, never imported. A resolver absent means a core that predates the
    // capability, which is a missing picture and not a missing feature.
    if (!host.resolveChrome) {
        if (!warnedNoSeam) {
            warnedNoSeam = true;
            console.warn('[Deploy] this Aegis hands the extension no Chromium resolver, ' +
                'so project cards keep the neutral plate. Upgrade Aegis to get thumbnails.');
        }
        return false;
    }

    // Core's when core hands it over. The bare require is the legacy case: a
    // copy of this extension still sitting inside an Aegis tree, from before the
    // source moved out of it, where backend/node_modules is on the resolution
    // path. Anywhere else it throws, and the throw is caught rather than
    // reported as a failed deployment.
    let puppeteer = host.puppeteer;
    if (!puppeteer) {
        try {
            puppeteer = require('puppeteer');
        } catch (_) {
            if (!warnedNoSeam) {
                warnedNoSeam = true;
                console.warn('[Deploy] puppeteer does not resolve from an installed extension, ' +
                    'so project cards keep the neutral plate until Aegis passes it in.');
            }
            return false;
        }
    }

    const executablePath = await host.resolveChrome(puppeteer);
    if (!executablePath) {
        if (!warnedNoChrome) {
            warnedNoChrome = true;
            console.warn('[Deploy] no Chromium found, so project cards keep the neutral plate. ' +
                'Set PUPPETEER_EXECUTABLE_PATH to point at one.');
        }
        return false;
    }

    let browser = null;
    try {
        browser = await puppeteer.launch({
            executablePath,
            headless: true,
            timeout: LAUNCH_TIMEOUT_MS,
            // The sandbox stays ON. This renders a customer's own build, which
            // is exactly the code that should not get a browser process with
            // the host's privileges. It already runs on this machine as a
            // served site; that is not a reason to hand it a second, wider seat.
            args: ['--disable-gpu', '--hide-scrollbars', '--mute-audio']
        });

        const page = await browser.newPage();
        await page.setViewport(SHOT);
        // A site on a self-signed certificate is still the site the operator
        // deployed, and refusing to photograph it would leave exactly the
        // installs most likely to be on one with no thumbnail.
        await page.setBypassCSP(false);
        page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

        // `domcontentloaded` and not `networkidle`: a dashboard that polls never
        // goes idle, and waiting for it to would spend the whole timeout on
        // every capture. What is wanted is the first paint, which is also what
        // the visitor sees first.
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        // Long enough for webfonts and above-the-fold images, short enough that
        // it does not become part of the deploy's wall clock.
        await new Promise((r) => setTimeout(r, 1200));

        const png = await page.screenshot({ type: 'png', fullPage: false });

        const dir = projectStore.ensureDataDir(tenantPaths, project.id);
        const target = path.join(dir, FILE);
        // Written beside and renamed: the route serves this file, and a reader
        // arriving mid-write would otherwise get a truncated PNG rather than
        // the previous one.
        const tmp = target + '.tmp';
        fs.writeFileSync(tmp, png);
        fs.renameSync(tmp, target);

        console.log(`[Deploy] ${slug}: captured ${project.id} preview from ${url}`);
        return true;
    } catch (e) {
        // Named, not swallowed silently: a thumbnail that never appears is a
        // question somebody will ask, and this line is the answer.
        console.warn(`[Deploy] ${slug}: preview capture failed for ${project.id}: ${e && e.message}`);
        return false;
    } finally {
        if (browser) {
            try { await browser.close(); } catch (_) { /* it is going away regardless */ }
        }
    }
}

/**
 * Queues a capture and resolves when it is done.
 *
 * Callers may await it or not; a deployment does not, because the operator
 * should not wait on a picture.
 */
function capture({ tenantPaths, project, slug }) {
    if (!tenantPaths || !project || !project.id) return Promise.resolve(false);
    chain = chain.then(
        () => run(tenantPaths, project, slug || '?'),
        () => run(tenantPaths, project, slug || '?')
    );
    return chain;
}

module.exports = { useChrome, capture, has, remove, shotPath, FILE };
