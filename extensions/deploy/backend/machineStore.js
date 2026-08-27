/**
 * Host state for the deploy extension: the GitHub App registrations, the public
 * webhook URL, and the opt-in flag that lets this extension do anything at all.
 *
 * Two different scopes live in one file, and the difference matters.
 *
 * The opt-in and the public URL are per machine, as ADR 0001 decision 7 splits
 * installation from visibility. **A GitHub App registration is per tenant.** It
 * used to be one per machine, on the reasoning that an App's callback URL is
 * fixed to one hostname and every tenant on a host shares that hostname. True,
 * and irrelevant: the callback is a URL, the App is a credential. One App shared
 * across tenants means tenant B's admin calls `GET /app/installations` and is
 * handed tenant A's GitHub organisation, its repository list, and a token that
 * clones its private code. The callback stays one URL per host because
 * `/t/<slug>/api/deploy/...` already carries the slug in its path.
 *
 * What stays machine-level is the *file*, not the scope. `tenants/<slug>/` is
 * tenant data, and it is inside the project tree on a dev install and inside a
 * backup on every install; the workspace rule is that no secret sits there. So
 * the registrations are keyed by slug inside a store that lives outside the
 * tree, under the same key as everything else here.
 *
 * The App private key can clone any repository the App is installed on, so it
 * is encrypted at rest with AES-256-GCM under a key file that never leaves the
 * data root. That is not protection against someone who already owns the
 * machine; it is protection against the file ending up in a backup, a support
 * bundle or a screenshot, which is how credentials actually leak.
 *
 * The opt-in flag defaults to OFF and there is no route that turns it on.
 * ADR 0001 decision 5 says entitlement fails closed, and "may fetch code from
 * the internet and run it on a domain-joined server" is entitlement. It is
 * granted by the installer, which writes AEGIS_DEPLOY_ENABLED into the service
 * environment; see `isEnabled` for why not by hand.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

/**
 * Where the GitHub App key lives. Never inside the repository.
 *
 * The workspace rule is that no secret sits in the project tree even when
 * gitignored, because this tree is synchronised by OneDrive and a `.gitignore`
 * does not stop a leak through sharing or a backup. The encryption key would
 * travel next to the ciphertext, so encryption buys nothing against that.
 *
 * Order: an explicit data root wins, then the platform's machine-wide app data
 * (`C:\ProgramData\Aegis` on Windows, `/var/lib/aegis` elsewhere), which is
 * where an installed service should keep this. The in-repo path is a last
 * resort for a dev tree with neither, and it warns.
 */
function storeDir() {
    if (process.env.AEGIS_DATA_ROOT) {
        return path.join(path.resolve(process.env.AEGIS_DATA_ROOT), 'deploy');
    }
    const machineRoot = process.platform === 'win32'
        ? (process.env.ProgramData && path.join(process.env.ProgramData, 'Aegis'))
        : '/var/lib/aegis';
    if (machineRoot) return path.join(machineRoot, 'deploy');

    const fallback = path.resolve(__dirname, '../../../data/deploy');
    console.warn(`[Deploy] storing machine secrets inside the repository at ${fallback}. ` +
        'Set AEGIS_DATA_ROOT to a path outside the tree before connecting GitHub.');
    return fallback;
}
function storeFile() { return path.join(storeDir(), 'machine.json'); }
function keyFile() { return path.join(storeDir(), 'machine.key'); }

/**
 * The encryption key, created on first use.
 *
 * `wx` so two workers racing on first boot cannot both write a key and leave
 * one of them unable to read what the other encrypted. The loser re-reads.
 */
function machineKey() {
    fs.mkdirSync(storeDir(), { recursive: true });
    try {
        const fd = fs.openSync(keyFile(), 'wx', 0o600);
        const key = crypto.randomBytes(32);
        fs.writeSync(fd, key);
        fs.closeSync(fd);
        return key;
    } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        return fs.readFileSync(keyFile());
    }
}

/** `iv.tag.ciphertext`, base64, one line. */
function encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv(ALGO, machineKey(), iv);
    const enc = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
    return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

/**
 * Returns null rather than throwing on a value that will not decrypt.
 *
 * A rotated key file makes every stored secret unreadable, and the useful
 * behaviour then is "GitHub is not connected" rather than a boot loop.
 */
function decrypt(packed) {
    try {
        const [ivB64, tagB64, dataB64] = String(packed).split('.');
        const d = crypto.createDecipheriv(ALGO, machineKey(), Buffer.from(ivB64, 'base64'));
        d.setAuthTag(Buffer.from(tagB64, 'base64'));
        return Buffer.concat([d.update(Buffer.from(dataB64, 'base64')), d.final()]).toString('utf8');
    } catch (_) {
        return null;
    }
}

function readRaw() {
    try {
        const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (_) {
        return {};
    }
}

function writeRaw(obj) {
    fs.mkdirSync(storeDir(), { recursive: true });
    // Write-then-rename, so a crash mid-write cannot leave a truncated file
    // that reads back as "no GitHub App" and prompts a second registration.
    const tmp = storeFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, storeFile());
}

/**
 * Is this install allowed to use the deploy extension?
 *
 * Deliberately an environment variable and not a settings route. Turning this
 * on is a decision about the host, made by whoever administers the host, and it
 * should survive no round trip through a web session. Enabling the extension
 * from the store is a tenant-admin action and is a different question: it
 * decides whether the tenant sees Deploy, never whether this machine will run a
 * stranger's build script.
 *
 * Set by the installer, into the service's own environment
 * (`RegisterServiceStep`), and read back from there on an upgrade so the answer
 * is not lost. Setting it by hand with `setx /M` does NOT work on an installed
 * host: that writes the machine environment, which the service control manager
 * caches at boot, so a service restart still sees the old value and only a
 * reboot would pick it up. On the dev path (`scripts/start-dashboard.ps1`) the
 * process is an ordinary child of the shell, so the script sets the variable in
 * its own window and Deploy is on by default there. That script refuses to run
 * unelevated, so reaching it already means holding the rights this switch
 * guards; exporting `AEGIS_DEPLOY_ENABLED=0` before it keeps Deploy off, which
 * is why the test below is for exactly "1" rather than for truthiness.
 */
function isEnabled() {
    return process.env.AEGIS_DEPLOY_ENABLED === '1';
}

/** The public base URL GitHub delivers webhooks to, or null when unreachable. */
function publicBaseUrl() {
    const raw = process.env.AEGIS_PUBLIC_URL || readRaw().publicBaseUrl || null;
    if (!raw) return null;
    try {
        const u = new URL(raw);
        // GitHub will not deliver to plain HTTP without the operator disabling
        // SSL verification on the App, which we will not document as a path.
        return u.protocol === 'https:' ? u.origin : null;
    } catch (_) {
        return null;
    }
}

/** `webhook` when GitHub can reach us, `poll` otherwise. See the plan. */
function detectionPath() {
    return publicBaseUrl() ? 'webhook' : 'poll';
}

/**
 * A tenant slug, validated before it is used as a key in the store.
 *
 * Core resolves and asserts the slug long before a route calls in here, so this
 * is defence in depth rather than the only check. It is worth having anyway:
 * this module is a library, an unvalidated key in a JSON object is how
 * `__proto__` becomes a registration, and the cost is one regex.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function appKey(slug) {
    const s = String(slug || '');
    return SLUG_RE.test(s) ? s : null;
}

/**
 * The App registration for one tenant, secrets decrypted, or null.
 *
 * Null for an unknown slug as well as for an unregistered one. Every caller
 * already treats null as "GitHub is not connected", which is the truthful
 * answer for a slug that cannot own a registration.
 */
function getGitHubApp(slug) {
    const key = appKey(slug);
    if (!key) return null;
    const raw = (readRaw().githubApps || {})[key];
    if (!raw || !raw.appId) return null;
    return {
        appId: raw.appId,
        slug: raw.slug || null,
        clientId: raw.clientId || null,
        htmlUrl: raw.htmlUrl || null,
        registeredAt: raw.registeredAt || null,
        clientSecret: raw.clientSecretEnc ? decrypt(raw.clientSecretEnc) : null,
        privateKey: raw.privateKeyEnc ? decrypt(raw.privateKeyEnc) : null,
        webhookSecret: raw.webhookSecretEnc ? decrypt(raw.webhookSecretEnc) : null
    };
}

/**
 * Stores the result of the App manifest exchange. Secrets in, ciphertext out.
 *
 * `tenantSlug` says whose registration this is; `slug` inside the payload is
 * GitHub's own slug for the App and is a different thing entirely. They are
 * separate arguments rather than one object for exactly that reason: two fields
 * named `slug` in one bag is a bug waiting for a tired reader.
 *
 * Throws on a slug the store will not key. A registration silently dropped here
 * would read back as "GitHub is not connected" one screen later, with a private
 * key already spent and no way to tell why.
 */
function saveGitHubApp(tenantSlug, { appId, slug, clientId, clientSecret, privateKey, webhookSecret, htmlUrl }) {
    const key = appKey(tenantSlug);
    if (!key) throw new Error(`refusing to store a GitHub App under ${JSON.stringify(String(tenantSlug))}`);

    const all = readRaw();
    if (!all.githubApps) all.githubApps = {};
    all.githubApps[key] = {
        appId,
        slug: slug || null,
        clientId: clientId || null,
        htmlUrl: htmlUrl || null,
        registeredAt: Date.now(),
        clientSecretEnc: clientSecret ? encrypt(clientSecret) : null,
        privateKeyEnc: privateKey ? encrypt(privateKey) : null,
        webhookSecretEnc: webhookSecret ? encrypt(webhookSecret) : null
    };
    writeRaw(all);
    return getGitHubApp(key);
}

/**
 * Forgets one tenant's registration. The App itself stays on GitHub, where the
 * operator deletes it; this only stops Aegis holding a key it will not use.
 */
function clearGitHubApp(tenantSlug) {
    const key = appKey(tenantSlug);
    if (!key) return false;
    const all = readRaw();
    if (!all.githubApps || !all.githubApps[key]) return false;
    delete all.githubApps[key];
    writeRaw(all);
    return true;
}

/**
 * Moves a pre-per-tenant registration to the tenant that owns it.
 *
 * The old store held one `githubApp` at the top level with nothing recording
 * who registered it. On the single-tenant host, which is what an Aegis install
 * normally is, there is exactly one candidate and the answer is not a guess. On
 * a host with several, there is no way to tell, and handing it to the wrong one
 * is the leak this whole change exists to close.
 *
 * So the ambiguous case is parked rather than deleted: the key stays in the
 * file under `githubAppUnattributed`, unreadable by any route, and the operator
 * is told to register again. Losing a key they can regenerate on GitHub beats
 * giving tenant B a token for tenant A's repositories.
 *
 * Idempotent: it runs at every boot and does nothing once the legacy key is gone.
 */
function migrateLegacyGitHubApp(slugs) {
    const all = readRaw();
    const legacy = all.githubApp;
    if (!legacy || !legacy.appId) return null;

    const candidates = (Array.isArray(slugs) ? slugs : []).filter((s) => appKey(s));
    delete all.githubApp;

    if (candidates.length === 1) {
        const only = candidates[0];
        if (!all.githubApps) all.githubApps = {};
        // Moved as ciphertext. Re-encrypting would decrypt a key into a variable
        // for no reason: the record is already sealed under this machine's key.
        if (!all.githubApps[only]) all.githubApps[only] = legacy;
        writeRaw(all);
        console.log(`[Deploy] GitHub App registration moved to tenant "${only}" (it is now per tenant, not per machine)`);
        return only;
    }

    all.githubAppUnattributed = legacy;
    writeRaw(all);
    console.warn('[Deploy] a GitHub App was registered before registrations became per tenant, and this host has '
        + `${candidates.length} tenants, so there is no way to tell whose it is. It has been set aside in `
        + `${storeFile()} under "githubAppUnattributed" and no tenant can use it. Each tenant registers its own App `
        + 'from the Deploy page; delete the old App on github.com once they have.');
    return null;
}

/**
 * Safe to send to a browser: no secret, only whether one exists.
 *
 * Per tenant, because the row it renders says "GitHub App registered" and the
 * question that answers is whether *this* tenant may deploy a private
 * repository, not whether somebody on this host once did.
 */
function publicStatus(slug) {
    const app = getGitHubApp(slug);
    return {
        enabled: isEnabled(),
        detection: detectionPath(),
        publicBaseUrl: publicBaseUrl(),
        github: app
            ? { connected: true, appId: app.appId, slug: app.slug, htmlUrl: app.htmlUrl, registeredAt: app.registeredAt }
            : { connected: false }
    };
}

/**
 * A build account's logon password, set once by Create-BuildAccounts.ps1 and
 * read by the launcher on every sandboxed build. Encrypted at rest for the
 * same reason the GitHub App key is: not protection from someone who already
 * owns the machine, but from the value ending up in a backup or a screenshot.
 */
function saveBuildAccountSecret(accountName, password) {
    const all = readRaw();
    all.buildAccounts = all.buildAccounts || {};
    all.buildAccounts[accountName] = encrypt(password);
    writeRaw(all);
}

function getBuildAccountSecret(accountName) {
    const enc = (readRaw().buildAccounts || {})[accountName];
    return enc ? decrypt(enc) : null;
}

module.exports = {
    isEnabled, publicBaseUrl, detectionPath,
    getGitHubApp, saveGitHubApp, clearGitHubApp, migrateLegacyGitHubApp, publicStatus,
    saveBuildAccountSecret, getBuildAccountSecret,
    encrypt, decrypt,
    storeDir, storeFile, SLUG_RE
};
