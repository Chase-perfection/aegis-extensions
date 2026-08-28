/**
 * Tier 3 — the Authentication pane, where a site's method is chosen and the
 * directory form is filled from what Aegis already knows.
 *
 * Two changes landed in this pane and neither had a browser test. The first
 * replaced a checkbox with a selector: the checkbox could only ever say "the
 * default method or nothing", which is how an operator ended up at a login
 * form they had not picked. The second added a button that fills the directory
 * form from the domain the last audit named, because that domain has already
 * been typed once and typing it again is where the typo in a search base comes
 * from.
 *
 * What is pinned here is the part a reviewer reading the diff cannot rule out:
 *
 *  - the selector offers what the backend said it could serve, not a list
 *    hardcoded in the page, and a stored method this build does not offer is
 *    still shown rather than silently rewritten on the next Apply;
 *  - a record from before the selector — `protected: true`, no `method` —
 *    reads as the directory;
 *  - Apply sends both `method` and the `enabled` mirror, which is what lets a
 *    page updated ahead of its backend degrade towards asking for a login
 *    instead of publishing the site;
 *  - the fill button writes into empty fields only, so a value the operator
 *    typed survives it.
 *
 * The network is stubbed by helpers/browser.js, so this needs no backend and
 * no directory. The fixtures carry the fields GET /api/deploy/auth really
 * sends (extensions/deploy/backend/routes.js, the handler above
 * /api/deploy/auth/suggest), not an invented shape.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

// The harness is core's and stays there: these tests render the page inside
// core's shell, so they need core's frontend on disk. `harness.js` resolves it
// through AEGIS_TREE and says why when it cannot. Skipped rather than failed,
// and never silently: this file cannot run in CI, which has no Aegis checkout.
const harness = require('./harness');
if (!harness.available) {
  test('the Deploy directory guard UI, inside the Aegis shell', { skip: harness.why }, () => {});
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

// --- Fixtures ------------------------------------------------------------

const STATUS_OK = {
    success: true,
    enabled: true,
    github: { connected: true, appId: 1, slug: 'acme' },
    detection: 'webhook',
    webhookUrl: null,
    capabilities: { projects: true, builds: true, runtimes: true }
};

// role sits at the top level, not under a nested `user` — the shape /auth/me
// really answers. Admin, because every control in this pane is admin-only and
// a reader would otherwise be testing a disabled form.
const ME_ADMIN = { loggedIn: true, tenant: 'test', userId: 1, email: 'admin@example.com', role: 'admin' };

/** ldapView() with everything filled, which is also what suppresses the load-time fill. */
function ldapConfigured(overrides) {
    return Object.assign({
        configured: true,
        url: 'ldaps://dc01.corp.local:636',
        startTls: false,
        rejectUnauthorized: true,
        bindDn: 'CN=svc,DC=corp,DC=local',
        hasPassword: true,
        baseDn: 'DC=corp,DC=local',
        userFilter: '(&(objectClass=user)(sAMAccountName={username}))',
        userDnTemplate: '{username}@corp.local',
        groupAttribute: 'memberOf',
        nestedGroups: false,
        trustedCa: [],
        revalidateMinutes: 60,
        updatedAt: 1700000000000
    }, overrides || {});
}

/** One row of the `sites` array, the way the auth handler builds it. */
function site(overrides) {
    return Object.assign({
        id: 'site-a',
        name: 'Site A',
        protected: false,
        method: 'none',
        audience: 'directory',
        allowedGroups: [],
        allowedUsers: [],
        tls: { enabled: false, certFile: '', keyFile: '' }
    }, overrides || {});
}

function authPayload(sites, ldap, methods) {
    return {
        success: true,
        ldap: ldap || ldapConfigured(),
        methods: methods || ['none', 'ldap'],
        sites: sites || [site()]
    };
}

/**
 * Stub keys match on "pathname includes this key, longest wins". That is why
 * the suggest route needs its own key: `deploy/auth` matches its path too, and
 * without the longer key the pane would read the site list as a suggestion.
 */
function baseStubs(payload, suggest) {
    return {
        'deploy/status': STATUS_OK,
        'auth/me': ME_ADMIN,
        'deploy/projects': { success: true, projects: [] },
        'deploy/auth/suggest': suggest === undefined ? { success: true, suggest: null } : suggest,
        'deploy/auth': payload
    };
}

/** Opens the pane and waits for the first site row to exist. */
async function openAuth(stubs) {
    const opened = await openPage(browser, `${server.url}/pages/deploy.html#auth`, stubs);
    await opened.page.waitForSelector('#deploy-auth-sites .dep-auth-site', { timeout: 5000 });
    return opened;
}

/** value + label of every option in a site's selector, and whether groups show. */
function readSelector(page, siteId) {
    return page.evaluate((id) => {
        const sel = document.getElementById('deploy-auth-method-' + id);
        return {
            value: sel.value,
            options: [...sel.options].map((o) => ({ value: o.value, label: o.textContent.trim() })),
            groupsHidden: sel.closest('.dep-auth-site').querySelector('.dep-auth-site-groups').hidden
        };
    }, siteId);
}

// --- The selector --------------------------------------------------------

test('the selector offers the vocabulary the backend sent, with the stored method chosen', async () => {
    const { page, close } = await openAuth(baseStubs(authPayload([site({ method: 'ldap', protected: true })])));
    try {
        const sel = await readSelector(page, 'site-a');
        assert.strictEqual(sel.value, 'ldap');
        assert.deepStrictEqual(sel.options, [
            { value: 'none', label: 'None. Serve this site to anyone who can reach it' },
            { value: 'ldap', label: 'Directory login (LDAP / Active Directory)' }
        ]);
    } finally {
        await close();
    }
});

test('a method the backend offers and the page has no label for is listed under its own id', async () => {
    // The page must not drop an option the server accepts: a selector that
    // hides one is a selector the operator cannot use to undo it.
    const payload = authPayload([site()], null, ['none', 'ldap', 'oidc']);
    const { page, close } = await openAuth(baseStubs(payload));
    try {
        const sel = await readSelector(page, 'site-a');
        assert.deepStrictEqual(sel.options.map((o) => o.value), ['none', 'ldap', 'oidc']);
        assert.strictEqual(sel.options[2].label, 'oidc');
    } finally {
        await close();
    }
});

test('a stored method this build no longer offers is still shown, and shown as selected', async () => {
    // Otherwise the row would display the site as something it is not, and
    // Apply would write that misreading back.
    const payload = authPayload([site({ method: 'saml', protected: true })], null, ['none', 'ldap']);
    const { page, close } = await openAuth(baseStubs(payload));
    try {
        const sel = await readSelector(page, 'site-a');
        assert.strictEqual(sel.value, 'saml');
        assert.deepStrictEqual(sel.options.map((o) => o.value), ['none', 'ldap', 'saml']);
    } finally {
        await close();
    }
});

test('a record from before the selector reads as the directory', async () => {
    // `protected: true` and no method is every site gated before the selector
    // existed. This backend sends `method` for those, but one that predates
    // this pane does not, and the page still has to be right.
    const stored = site({ protected: true });
    delete stored.method;
    const { page, close } = await openAuth(baseStubs(authPayload([stored])));
    try {
        assert.strictEqual((await readSelector(page, 'site-a')).value, 'ldap');
    } finally {
        await close();
    }
});

test('allowed groups belong to the directory: hidden under none, shown under ldap', async () => {
    const { page, close } = await openAuth(baseStubs(authPayload([site({ method: 'ldap', protected: true })])));
    try {
        assert.strictEqual((await readSelector(page, 'site-a')).groupsHidden, false);

        await page.select('#deploy-auth-method-site-a', 'none');
        assert.strictEqual((await readSelector(page, 'site-a')).groupsHidden, true);

        // Hidden, not removed: switching back must not cost the typed list.
        await page.select('#deploy-auth-method-site-a', 'ldap');
        assert.strictEqual((await readSelector(page, 'site-a')).groupsHidden, false);
    } finally {
        await close();
    }
});

// --- Apply ---------------------------------------------------------------

/** Clicks Apply on one site row and returns the POST body it sent. */
async function applyAndRead(page, siteId) {
    const seen = [];
    page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().includes('/auth')) {
            seen.push(req.postData());
        }
    });
    await page.evaluate((id) => {
        const row = document.getElementById('deploy-auth-method-' + id).closest('.dep-auth-site');
        [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Apply').click();
    }, siteId);
    // Not "the note changed": the row blanks its note while the request is out,
    // so a wait that accepts any change reads the blank and asserts against ''.
    await page.waitForFunction(
        (id) => {
            const row = document.getElementById('deploy-auth-method-' + id).closest('.dep-auth-site');
            const note = row.querySelector('.dep-auth-site-note');
            return !note.hidden && note.textContent.trim() !== '';
        },
        { timeout: 5000 },
        siteId
    );
    assert.strictEqual(seen.length, 1, 'expected exactly one auth POST');
    return JSON.parse(seen[0]);
}

test('Apply sends the method and the enabled mirror together', async () => {
    // Both, on purpose. A backend carrying the selector reads `method`; one
    // that predates it has never heard of it and would refuse the body with
    // `bad_enabled`, which is what a page updated ahead of its backend hit.
    const stubs = baseStubs(authPayload([site({ method: 'ldap', protected: true, allowedGroups: ['Admins'] })]));
    stubs['projects/site-a/auth'] = {
        success: true,
        project: { id: 'site-a', protected: true, method: 'ldap', allowedGroups: ['Admins'] }
    };
    const { page, close } = await openAuth(stubs);
    try {
        const body = await applyAndRead(page, 'site-a');
        assert.deepStrictEqual(body, {
            method: 'ldap', enabled: true, audience: 'directory',
            allowedGroups: ['Admins'], allowedUsers: []
        });
    } finally {
        await close();
    }
});

test('Apply under none sends no allow list, whatever is still typed in the box', async () => {
    // A list stored under a method that reads none of it would be shown back on
    // the next load as a rule nobody is enforcing.
    const stubs = baseStubs(authPayload([site({ method: 'ldap', protected: true, allowedGroups: ['Admins'] })]));
    stubs['projects/site-a/auth'] = {
        success: true,
        project: { id: 'site-a', protected: false, method: 'none', allowedGroups: [] }
    };
    const { page, close } = await openAuth(stubs);
    try {
        await page.select('#deploy-auth-method-site-a', 'none');
        const body = await applyAndRead(page, 'site-a');
        assert.deepStrictEqual(body, {
            method: 'none', enabled: false, audience: 'directory',
            allowedGroups: [], allowedUsers: []
        });
    } finally {
        await close();
    }
});

test('a refused method names the refusal rather than the generic sentence', async () => {
    const stubs = baseStubs(authPayload([site({ method: 'ldap', protected: true })]));
    stubs['projects/site-a/auth'] = { success: false, error: 'bad_auth_method' };
    const { page, close } = await openAuth(stubs);
    try {
        await applyAndRead(page, 'site-a');
        const note = await page.$eval('.dep-auth-site-note', (n) => n.textContent.trim());
        assert.strictEqual(note,
            'Aegis does not know that authentication method. Reload the page and pick one from the list.');
    } finally {
        await close();
    }
});

// --- Filling the directory form ------------------------------------------

const SUGGEST_OK = {
    success: true,
    suggest: {
        source: 'audit',
        domain: 'corp.local',
        fields: {
            url: 'ldaps://corp.local:636',
            baseDn: 'DC=corp,DC=local',
            userDnTemplate: '{username}@corp.local',
            userFilter: '(&(objectClass=user)(sAMAccountName={username}))',
            groupAttribute: 'memberOf'
        }
    }
};

/** Every field the fill button can write, read back off the form. */
function readForm(page) {
    return page.evaluate(() => ({
        url: document.getElementById('deploy-auth-url').value,
        baseDn: document.getElementById('deploy-auth-basedn').value,
        userFilter: document.getElementById('deploy-auth-filter').value,
        userDnTemplate: document.getElementById('deploy-auth-dntemplate').value,
        groupAttribute: document.getElementById('deploy-auth-groupattr').value,
        note: document.getElementById('deploy-auth-note').textContent.trim()
    }));
}

/** Waits past the "looking..." line for whatever the fill settled on. */
async function waitForNote(page) {
    await page.waitForFunction(() => {
        const n = document.getElementById('deploy-auth-note');
        return !n.hidden && n.textContent.trim() !== ''
            && !/^Looking for what Aegis/.test(n.textContent.trim());
    }, { timeout: 5000 });
}

test('the fill button writes the empty fields and leaves a typed one alone', async () => {
    // `configured: true` with one field filled: enough to suppress the
    // load-time fill, so what this test observes is the button and nothing
    // else.
    const ldap = ldapConfigured({
        url: 'ldap://typed-by-hand.corp.local:389',
        baseDn: '', userFilter: '', userDnTemplate: '', groupAttribute: ''
    });
    const { page, close } = await openAuth(baseStubs(authPayload([site()], ldap), SUGGEST_OK));
    try {
        await page.click('#deploy-auth-scan');
        await waitForNote(page);
        const form = await readForm(page);

        assert.strictEqual(form.url, 'ldap://typed-by-hand.corp.local:389', 'a typed value must survive');
        assert.strictEqual(form.baseDn, 'DC=corp,DC=local');
        assert.strictEqual(form.userFilter, '(&(objectClass=user)(sAMAccountName={username}))');
        assert.strictEqual(form.userDnTemplate, '{username}@corp.local');
        assert.strictEqual(form.groupAttribute, 'memberOf');
        assert.strictEqual(form.note,
            'Filled 4 empty field(s) from the last audit, which names corp.local. Check them, add the '
            + 'service account, then save. LDAPS is suggested because a password crosses this '
            + 'connection; switch to ldap:// only if the controller has no certificate.');
    } finally {
        await close();
    }
});

test('an unconfigured pane opens on a proposal rather than on a blank form', async () => {
    const { page, close } = await openAuth(
        baseStubs(authPayload([site()], { configured: false }), SUGGEST_OK));
    try {
        await waitForNote(page);
        const form = await readForm(page);
        assert.strictEqual(form.url, 'ldaps://corp.local:636');
        assert.strictEqual(form.baseDn, 'DC=corp,DC=local');
        assert.ok(form.note.startsWith('Filled 5 empty field(s) from the last audit'), form.note);
    } finally {
        await close();
    }
});

test('nothing to go on says so, and writes nothing', async () => {
    const { page, close } = await openAuth(
        baseStubs(authPayload([site()], { configured: false }), { success: true, suggest: null }));
    try {
        await waitForNote(page);
        const form = await readForm(page);
        assert.strictEqual(form.url, '');
        assert.strictEqual(form.baseDn, '');
        assert.strictEqual(form.note,
            'Aegis has nothing to go on yet: no audit has named a domain and this server is not '
            + 'joined to one. Type the address and the search base.');
    } finally {
        await close();
    }
});

/* --- The certificate a controller presented ----------------------------- */

/**
 * What the certificate probe answers, in the shape routes.js really builds.
 *
 * The `pem` is absent on purpose: the backend strips it before answering, and
 * a fixture carrying one would let a regression that leaks it pass here.
 */
const FINGERPRINT = 'A3:1F:9C:2D:44:5B:6E:70:81:92:A3:B4:C5:D6:E7:F8:09:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8';

function certificatePayload(overrides) {
    return {
        success: true,
        certificate: Object.assign({
            host: 'dc01.corp.local',
            port: 636,
            hostMatches: true,
            nameError: null,
            names: ['dc01.corp.local'],
            leaf: {
                subject: 'CN=dc01.corp.local',
                issuer: 'CN=CORP-CA',
                commonName: 'dc01.corp.local',
                validFrom: 'Jan  4 00:00:00 2026 GMT',
                validTo: 'Jan  4 00:00:00 2028 GMT',
                fingerprint256: FINGERPRINT,
                altNames: ['DNS:dc01.corp.local'],
                selfSigned: false
            },
            anchor: {
                subject: 'CN=CORP-CA',
                issuer: 'CN=CORP-CA',
                commonName: 'CORP-CA',
                validFrom: 'Jan  1 00:00:00 2020 GMT',
                validTo: 'Jan  1 00:00:00 2040 GMT',
                fingerprint256: FINGERPRINT,
                altNames: [],
                selfSigned: true
            },
            chainLength: 2
        }, overrides || {})
    };
}

/** Everything on screen inside the certificate panel. */
function readCert(page) {
    return page.evaluate(() => {
        const box = document.getElementById('deploy-auth-cert');
        return {
            hidden: box.hidden,
            text: box.textContent.replace(/\s+/g, ' ').trim(),
            buttons: [...box.querySelectorAll('button')].map((b) => b.textContent.trim()),
            print: (box.querySelector('.dep-cert-print') || {}).textContent || ''
        };
    });
}

function readState(page) {
    return page.evaluate(() => document.getElementById('deploy-auth-state').textContent.trim());
}

/** Waits for the panel to hold something other than its loading line. */
async function waitForCert(page) {
    await page.waitForFunction(() => {
        const box = document.getElementById('deploy-auth-cert');
        return !box.hidden && box.querySelector('.dep-cert-title');
    }, { timeout: 5000 });
}

test('an untrusted authority is shown with its fingerprint and a button that trusts it', async () => {
    // The failure this whole panel exists for. It used to be a paragraph
    // telling the operator to install a CA in Windows and restart Aegis, about
    // a certificate the handshake had already refused to show them.
    const stubs = baseStubs(authPayload());
    stubs['deploy/auth/test'] = { success: false, error: 'ldap_tls_untrusted' };
    stubs['deploy/auth/certificate'] = certificatePayload({ hostMatches: false });

    const { page, close } = await openAuth(stubs);
    try {
        await page.click('#deploy-auth-test');
        await waitForCert(page);
        const cert = await readCert(page);

        assert.match(cert.text, /CN=CORP-CA/, 'the authority is named');
        assert.strictEqual(cert.print.trim(), FINGERPRINT,
            'the fingerprint is what the operator compares, so it has to be on screen verbatim');
        assert.deepStrictEqual(cert.buttons, ['Trust this authority']);
        assert.strictEqual(await readState(page), 'Not reachable');
    } finally {
        await close();
    }
});

test('trusting the authority re-checks and the pane reports the connection', async () => {
    const stubs = baseStubs(authPayload());
    stubs['deploy/auth/test'] = { success: false, error: 'ldap_tls_untrusted' };
    stubs['deploy/auth/certificate'] = certificatePayload({ hostMatches: false });
    stubs['deploy/auth/trust'] = {
        success: true,
        ldap: ldapConfigured({ trustedCa: [{ subject: 'CN=CORP-CA', issuer: 'CN=CORP-CA', validTo: 'Jan  1 00:00:00 2040 GMT', fingerprint256: FINGERPRINT, expired: false, usable: true }] })
    };

    const { page, close } = await openAuth(stubs);
    try {
        await page.click('#deploy-auth-test');
        await waitForCert(page);

        // The directory answers once its authority is trusted. Mutating the
        // stub is what the real install does: the same request, a different
        // answer, because the configuration changed underneath it.
        stubs['deploy/auth/test'] = { success: true, bound: true };
        await page.click('#deploy-auth-cert button');

        await page.waitForFunction(
            () => document.getElementById('deploy-auth-state').textContent.trim() === 'Connected',
            { timeout: 5000 });

        // Trusting must never be a quiet switch-off of the check, so the pane
        // has to keep saying what it now trusts.
        const pinned = await page.evaluate(() => {
            const box = document.getElementById('deploy-auth-pinned');
            return { hidden: box.hidden, text: box.textContent.replace(/\s+/g, ' ').trim() };
        });
        assert.strictEqual(pinned.hidden, false);
        assert.match(pinned.text, /CN=CORP-CA/);
        assert.match(pinned.text, /Stop trusting these/);
        assert.strictEqual((await readCert(page)).hidden, true, 'the panel closes once it is answered');
    } finally {
        await close();
    }
});

test('a certificate for another name offers that name instead of an instruction', async () => {
    const stubs = baseStubs(authPayload());
    stubs['deploy/auth/test'] = { success: false, error: 'ldap_tls_name_mismatch' };
    stubs['deploy/auth/certificate'] = certificatePayload({
        host: 'corp.local',
        hostMatches: false,
        nameError: 'Host: corp.local is not in the cert\u2019s altnames',
        names: ['dc01.corp.local']
    });

    const { page, close } = await openAuth(stubs);
    try {
        await page.click('#deploy-auth-test');
        await waitForCert(page);
        const cert = await readCert(page);
        assert.deepStrictEqual(cert.buttons, ['Use dc01.corp.local instead']);

        // The repair rewrites the host and keeps the port and the scheme the
        // operator chose, because only one of the three was wrong.
        stubs['deploy/auth/test'] = { success: true, bound: true };
        await page.click('#deploy-auth-cert button');
        await page.waitForFunction(
            () => document.getElementById('deploy-auth-state').textContent.trim() === 'Connected',
            { timeout: 5000 });

        const url = await page.evaluate(() => document.getElementById('deploy-auth-url').value);
        assert.strictEqual(url, 'ldaps://dc01.corp.local:636');
    } finally {
        await close();
    }
});

test('an expired certificate is shown without a button that cannot help', async () => {
    const stubs = baseStubs(authPayload());
    stubs['deploy/auth/test'] = { success: false, error: 'ldap_tls_expired' };
    stubs['deploy/auth/certificate'] = certificatePayload();

    const { page, close } = await openAuth(stubs);
    try {
        await page.click('#deploy-auth-test');
        await waitForCert(page);
        const cert = await readCert(page);
        // Nothing on this page renews a certificate, and offering a button that
        // pretends otherwise costs a click and teaches the wrong thing.
        assert.deepStrictEqual(cert.buttons, []);
        assert.match(cert.text, /renewed on the controller/);
    } finally {
        await close();
    }
});

test('the advanced block stays folded when the search base is known, and opens when it is not', async () => {
    const folded = await openAuth(baseStubs(authPayload()));
    try {
        assert.strictEqual(
            await folded.page.evaluate(() => document.getElementById('deploy-auth-advanced').open),
            false, 'a complete configuration has nothing to unfold');
    } finally {
        await folded.close();
    }

    // The search base is required and cannot always be guessed, so a refusal
    // must never point at a field the operator cannot see.
    const open = await openAuth(baseStubs(authPayload([site()], ldapConfigured({ baseDn: '' }))));
    try {
        assert.strictEqual(
            await open.page.evaluate(() => document.getElementById('deploy-auth-advanced').open),
            true);
    } finally {
        await open.close();
    }
});

test('the audience the site was loaded with is the one shown', async () => {
    // The selector is the site's stored answer, not a default painted over it.
    // Showing `directory` on a site that is restricted would invite an operator
    // to press Apply and open it.
    const stubs = baseStubs(authPayload([site({
        method: 'ldap', protected: true, audience: 'listed', allowedGroups: ['Admins']
    })]));
    const { page, close } = await openAuth(stubs);
    try {
        assert.strictEqual(
            await page.$eval('#deploy-auth-audience-site-a', (e) => e.value), 'listed');
    } finally {
        await close();
    }
});

test('people loaded with the site are sent back untouched, admin flag included', async () => {
    // The panel is a round trip. A person the operator did not touch has to
    // leave in the state they arrived in, or opening the pane and pressing
    // Apply would quietly demote somebody.
    const stubs = baseStubs(authPayload([site({
        method: 'ldap',
        protected: true,
        audience: 'listed',
        allowedUsers: [
            { sid: 'S-1-5-21-1-2-3-1103', login: 'PV', name: 'Paul Vue', admin: true },
            { sid: 'S-1-5-21-1-2-3-1200', login: 'JD', name: 'J Doe', admin: false }
        ]
    })]));
    stubs['projects/site-a/auth'] = {
        success: true,
        project: { id: 'site-a', protected: true, method: 'ldap', audience: 'listed', allowedGroups: [], allowedUsers: [] }
    };
    const { page, close } = await openAuth(stubs);
    try {
        const body = await applyAndRead(page, 'site-a');
        assert.strictEqual(body.audience, 'listed');
        assert.deepStrictEqual(body.allowedUsers, [
            { sid: 'S-1-5-21-1-2-3-1103', login: 'PV', name: 'Paul Vue', admin: true },
            { sid: 'S-1-5-21-1-2-3-1200', login: 'JD', name: 'J Doe', admin: false }
        ]);
    } finally {
        await close();
    }
});

test('unticking Administrator is what leaves in the body', async () => {
    const stubs = baseStubs(authPayload([site({
        method: 'ldap',
        protected: true,
        audience: 'listed',
        allowedUsers: [{ sid: 'S-1-5-21-1-2-3-1103', login: 'PV', name: 'Paul Vue', admin: true }]
    })]));
    stubs['projects/site-a/auth'] = {
        success: true,
        project: { id: 'site-a', protected: true, method: 'ldap', audience: 'listed', allowedGroups: [], allowedUsers: [] }
    };
    const { page, close } = await openAuth(stubs);
    try {
        await page.$eval('.dep-auth-person-admin input', (box) => {
            box.checked = false;
            box.dispatchEvent(new Event('change', { bubbles: true }));
        });
        const body = await applyAndRead(page, 'site-a');
        assert.strictEqual(body.allowedUsers[0].admin, false);
    } finally {
        await close();
    }
});

test('Remove takes the person out of the body', async () => {
    const stubs = baseStubs(authPayload([site({
        method: 'ldap',
        protected: true,
        audience: 'listed',
        allowedUsers: [{ sid: 'S-1-5-21-1-2-3-1103', login: 'PV', name: 'Paul Vue', admin: true }]
    })]));
    stubs['projects/site-a/auth'] = {
        success: true,
        project: { id: 'site-a', protected: true, method: 'ldap', audience: 'listed', allowedGroups: [], allowedUsers: [] }
    };
    const { page, close } = await openAuth(stubs);
    try {
        await page.$eval('.dep-auth-person button', (b) => b.click());
        const body = await applyAndRead(page, 'site-a');
        assert.deepStrictEqual(body.allowedUsers, []);
    } finally {
        await close();
    }
});

test('under none, the people list leaves as empty like the groups do', async () => {
    // Same reason as the group list: a rule stored under a method that reads
    // none of it is shown back on the next load as something being enforced.
    const stubs = baseStubs(authPayload([site({
        method: 'ldap',
        protected: true,
        audience: 'listed',
        allowedUsers: [{ sid: 'S-1-5-21-1-2-3-1103', login: 'PV', name: 'Paul Vue', admin: true }]
    })]));
    stubs['projects/site-a/auth'] = {
        success: true,
        project: { id: 'site-a', protected: false, method: 'none', audience: 'directory', allowedGroups: [], allowedUsers: [] }
    };
    const { page, close } = await openAuth(stubs);
    try {
        await page.select('#deploy-auth-method-site-a', 'none');
        const body = await applyAndRead(page, 'site-a');
        assert.deepStrictEqual(body.allowedUsers, []);
        assert.strictEqual(body.audience, 'directory');
    } finally {
        await close();
    }
});
