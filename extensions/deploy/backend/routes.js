/**
 * The deploy extension's backend entry point.
 *
 * `registerPublic` mounts routes above the session wall, `register` mounts the
 * rest below it. Both are called by `lib/extensionLoader.js`, which passes in
 * the core middleware rather than letting this file import it, so an extension
 * cannot pick a different tenant resolver or skip the module gate.
 *
 * Every route here lives under `/api/deploy`, the single prefix declared in
 * extension.json. ADR 0001 decision 4: an undeclared route stays reachable when
 * the module is hidden, so this file serves nothing outside its prefix.
 *
 * The directory routes at the end configure the optional LDAP guard that sits in
 * front of a deployed site. They are the only writers of the tenant's directory
 * config and of a project's `auth` field, and every one of them calls
 * `siteAuth.invalidate` afterwards: the site server answers from a cache, so a
 * write that skipped that call would keep serving the previous rule until the
 * backend restarted.
 *
 * Status: phase 0 and the start of phase 1 from
 * `docs/plans/0001-deploy-extension.md`. Project creation, builds and runtimes
 * are not implemented. Routes that would need them answer 501 rather than
 * pretending, so the page can render the real state of the install.
 */

'use strict';

const crypto = require('crypto');
const path = require('path');
const machineStore = require('./machineStore');
const github = require('./github');
const { verifySignature, createDeliveryCache, parsePush, MAX_BODY_BYTES } = require('./webhook');
const projectStore = require('./projectStore');
const projectData = require('./projectData');
const projectSettings = require('./projectSettings');
const projectEnv = require('./projectEnv');
const migrations = require('./migrations');
const { deployNow, promoteNow, releasesFor, isDeploying, startAllRuntimes, useWritableDb } = require('./deployService');
const runs = require('./runs');
const runStore = require('./runStore');
const { startPoller, SAME_SHA_ATTEMPTS } = require('./poller');
const {
    startSiteFor, restartSiteFor, startAllSites, allocatePort, isServing,
    startRouter, routerPort, routerIsTls, invalidateHostIndex, normaliseHostname
} = require('./siteServer');
const authStore = require('./authStore');
const authMethods = require('./authMethods');
const directoryHint = require('./directoryHint');
const ldap = require('./ldap');
const siteAuth = require('./siteAuth');
const siteConfig = require('./siteConfig');
const previews = require('./previews');
const runtime = require('./runtime');
const shots = require('./shots');

const deliveries = createDeliveryCache();

/** owner/repo, the only shape allowed to reach a GitHub URL path. */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * A branch name that is safe to hand `git` as an argument.
 *
 * Git itself allows more than this. The narrowing that matters is the leading
 * dash, which `git clone --branch` would read as another flag, and `..`, which
 * git refuses anyway but which should not travel this far.
 */
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,255}$/;
function safeBranch(b) {
    return BRANCH_RE.test(b) && !b.startsWith('-') && !b.includes('..');
}

/**
 * What the browser is shown instead of a stored bind password.
 *
 * The same eight bullets the SMTP settings form uses (`server.js`), and the same
 * contract with it: a value that comes back unchanged means "keep what is
 * stored", so the operator can save the other fields without retyping a secret
 * the page was never given. Written as an escape rather than as literal bullets
 * so the comparison cannot be broken by a re-encoding of this file.
 */
const PASSWORD_MASK = '\u2022'.repeat(8);

/** Control characters, which have no place in a DN, a filter or a group name. */
const CTRL_RE = /[\u0000-\u001f\u007f]/;

/** An LDAP attribute type, narrow enough to reach a SearchRequest untouched. */
const ATTR_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

const MAX_GROUPS = 64;
const MAX_GROUP_LEN = 512;

/** A filesystem path to a certificate or a key, as an operator may type it. */
const MAX_PATH_LEN = 4096;

/**
 * Whether every parenthesis in an LDAP filter is closed.
 *
 * An unbalanced filter comes back from the directory as a protocol error that
 * names nothing the operator can act on, so it is caught here where the field
 * that produced it is still known. RFC 4515 escapes a literal parenthesis as
 * `\28` / `\29`, so an escaped one never reads as structure and needs no case.
 */
function balancedParens(filter) {
    let depth = 0;
    for (let i = 0; i < filter.length; i++) {
        if (filter[i] === '(') depth++;
        else if (filter[i] === ')' && --depth < 0) return false;
    }
    return depth === 0;
}

/**
 * Validates the directory fields of a request body, one error code per field.
 *
 * Returns `{ error }` or `{ config }`. The password is deliberately not handled
 * here: it has keep-existing semantics that depend on whether the key was sent
 * at all, which a `String(... || '')` pass would erase.
 */
function parseLdapBody(body) {
    const url = String((body && body.url) || '').trim();
    let parsed = null;
    try { parsed = new URL(url); } catch (_) { parsed = null; }
    if (!parsed || !parsed.hostname || (parsed.protocol !== 'ldap:' && parsed.protocol !== 'ldaps:')) {
        return { error: 'bad_ldap_url' };
    }

    const baseDn = String((body && body.baseDn) || '').trim();
    if (!baseDn || baseDn.length > 1024 || CTRL_RE.test(baseDn)) return { error: 'bad_base_dn' };

    // Empty is legal: an anonymous bind is a supported configuration, and the
    // directory is the only thing that can say whether it is allowed.
    const bindDn = String((body && body.bindDn) || '').trim();
    if (bindDn.length > 1024 || CTRL_RE.test(bindDn)) return { error: 'bad_bind_dn' };

    const userFilter = String((body && body.userFilter) || '').trim() || authStore.DEFAULT_USER_FILTER;
    if (userFilter.length > 1024 || CTRL_RE.test(userFilter)
        || !userFilter.includes('{username}') || !balancedParens(userFilter)) {
        return { error: 'bad_user_filter' };
    }

    // Optional, and the alternative to searching rather than an addition to it.
    // Without `{username}` it would bind the same DN for every operator, which
    // is a silent authentication bypass, so it is refused rather than ignored.
    const userDnTemplate = String((body && body.userDnTemplate) || '').trim();
    if (userDnTemplate && (userDnTemplate.length > 512 || CTRL_RE.test(userDnTemplate)
        || !userDnTemplate.includes('{username}'))) {
        return { error: 'bad_user_dn_template' };
    }

    const groupAttribute = String((body && body.groupAttribute) || '').trim() || authStore.DEFAULT_GROUP_ATTR;
    if (!ATTR_RE.test(groupAttribute)) return { error: 'bad_group_attribute' };

    // 0 is "never re-check", which is the behaviour that predates the setting,
    // so it has to survive the parse rather than fall back to the default.
    let revalidateMinutes = authStore.DEFAULT_REVALIDATE_MINUTES;
    if (body && body.revalidateMinutes !== undefined && body.revalidateMinutes !== null
        && body.revalidateMinutes !== '') {
        const n = Number(body.revalidateMinutes);
        if (!Number.isFinite(n) || n < 0 || n > 1440) return { error: 'bad_revalidate_minutes' };
        revalidateMinutes = Math.floor(n);
    }

    return {
        config: {
            url,
            // StartTLS is opt-in and certificate validation is opt-out: the safe
            // value of each is the one an absent field should produce.
            startTls: !!(body && body.startTls),
            rejectUnauthorized: !(body && body.rejectUnauthorized === false),
            bindDn,
            baseDn,
            userFilter,
            userDnTemplate,
            groupAttribute,
            // Absent means off, like `startTls` above: resolving nested groups
            // can only add groups to a user, so it can only widen who gets in.
            nestedGroups: !!(body && body.nestedGroups),
            revalidateMinutes
        }
    };
}

/**
 * A certificate or key path, or null when the body is unfit.
 *
 * Absolute only. A relative path would resolve against the backend's working
 * directory, which is not where an operator thinks they are pointing, and the
 * mistake would only show as a site that will not start.
 *
 * Not confined to a per-tenant directory, and that is worth stating because it
 * looks like a tenant boundary being crossed. It is not one. Reaching this route
 * means Deploy is enabled on the host, and Deploy's whole entitlement is that a
 * tenant admin can have this machine clone a repository and run its build
 * command as the backend's user, which is LocalSystem on an installed server.
 * Anyone holding that can already read every file on the box. Naming one as a
 * certificate is strictly less than what they have, so a containment check here
 * would cost an operator the ability to point at wherever certbot or the
 * enterprise CA actually writes, and buy nothing.
 *
 * The gate that matters is the host opt-in, not this path. Nothing read here is
 * ever sent to a browser: a file that is not a usable certificate stops the
 * site, and the route answers with a fixed code.
 */
function parseCertPath(value) {
    const p = String(value === undefined || value === null ? '' : value).trim();
    if (!p || p.length > MAX_PATH_LEN || CTRL_RE.test(p)) return null;
    if (!path.isAbsolute(p)) return null;
    return p;
}

/**
 * The group list a project is allowed to carry, or null when the body is unfit.
 *
 * Capped because this list is read on every request the site server gates, and
 * because an operator pasting a whole directory export into the field should be
 * refused rather than persisted.
 */
function parseAllowedGroups(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_GROUPS) return null;
    const out = [];
    for (const raw of value) {
        if (typeof raw !== 'string') return null;
        const group = raw.trim();
        if (!group) continue;   // a blank line in the textarea is not a group
        if (group.length > MAX_GROUP_LEN || CTRL_RE.test(group)) return null;
        out.push(group);
    }
    return out;
}

/**
 * The directory config as the browser is allowed to see it.
 *
 * `authStore.publicConfig` already withholds the password. This whitelist is the
 * second lock: a field added to the stored record later cannot reach the page by
 * accident, which is the rule every other response in this file follows.
 */
function ldapView(config) {
    if (!config) return { configured: false };
    return {
        configured: !!config.configured,
        url: config.url || '',
        startTls: !!config.startTls,
        rejectUnauthorized: config.rejectUnauthorized !== false,
        bindDn: config.bindDn || '',
        hasPassword: !!config.hasPassword,
        baseDn: config.baseDn || '',
        userFilter: config.userFilter || '',
        userDnTemplate: config.userDnTemplate || '',
        groupAttribute: config.groupAttribute || '',
        nestedGroups: !!config.nestedGroups,
        // Descriptions only, never the PEM: `authStore.publicConfig` derives
        // each one from the stored certificate, so the page cannot be shown a
        // fingerprint that belongs to nothing.
        trustedCa: Array.isArray(config.trustedCa) ? config.trustedCa : [],
        revalidateMinutes: Number.isFinite(Number(config.revalidateMinutes))
            ? Number(config.revalidateMinutes)
            : authStore.DEFAULT_REVALIDATE_MINUTES,
        updatedAt: config.updatedAt || null
    };
}

/** A project's TLS settings as the page may see them. No file is read here. */
function tlsView(project) {
    const t = (project && project.tls) || {};
    return {
        enabled: t.enabled === true,
        certFile: t.certFile || '',
        keyFile: t.keyFile || ''
    };
}

/** Whether a project record asks to be gated. Absent `auth` means "no". */
function isProtectedRecord(project) {
    return authMethods.isGated(project && project.auth);
}

/**
 * The method a project record names, for a page that has to show the choice.
 *
 * Sent as stored, so a record naming something this build cannot serve shows
 * up on the page as the odd value it is instead of being rendered as one of
 * the options and silently rewritten on the next save.
 */
function methodOfProject(project) {
    return authMethods.methodOf(project && project.auth);
}

function groupsOf(project) {
    return (project && project.auth && Array.isArray(project.auth.allowedGroups))
        ? project.auth.allowedGroups
        : [];
}

/**
 * The HTTP status for a directory failure code.
 *
 * A rejected credential is the operator's input and answers 400; an unreachable
 * or confused directory is an upstream failure and answers 502. Anything not
 * listed is treated as upstream, so a code added to `ldap.js` later fails in the
 * safe direction rather than being reported as the operator's mistake.
 */
/** A SHA-256 fingerprint as OpenSSL prints it: 32 hex pairs, colon separated. */
const FINGERPRINT_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;

const LDAP_STATUS = {
    ldap_timeout: 504,
    ldap_bad_config: 400,
    ldap_bind_refused: 400,
    ldap_invalid_credentials: 400,
    ldap_user_not_found: 400,
    ldap_ambiguous_user: 409,
    // The three TLS faults the page can offer a repair for. Listed rather than
    // left to fall through to 502 so it is visible that they are answers about
    // the configuration, not about the controller being unreachable.
    ldap_tls_untrusted: 400,
    ldap_tls_name_mismatch: 400,
    ldap_tls_expired: 400,
    ldap_not_tls: 400
};

/**
 * The address to hand the operator for a deployed site.
 *
 * Built from the host they are already reaching Aegis on, rather than from a
 * configured public URL: a LAN install has no public URL, and the operator is
 * already on the network the site will be reached from. The port belongs to the
 * project, so a site serves from its own root and a built asset at
 * `/assets/app.js` resolves.
 */
/**
 * Where the deployed site answers.
 *
 * The scheme comes from the project, not from `req.protocol`. They are two
 * different servers on two different ports: the dashboard may be plain HTTP
 * while a site it manages is HTTPS, or the other way round, and taking the
 * dashboard's scheme would print a link that does not connect.
 */
function siteUrl(req, project) {
    if (!project || !project.port) return null;
    const scheme = (project.tls && project.tls.enabled === true) ? 'https' : 'http';
    return `${scheme}://${req.hostname}:${project.port}/`;
}

/**
 * The site's address by name, when it has a name and a router to answer it.
 *
 * Separate from `siteUrl` rather than replacing it. The port URL always works
 * because the port is bound on this machine; the name only works once somebody
 * has added the DNS record or the hosts entry, and Aegis cannot know whether
 * they have. So the page gets both and says which is which.
 *
 * The port is left off 80 and 443, which are the ports a browser adds itself.
 */
function siteHostUrl(project) {
    const hostname = normaliseHostname(project && project.hostname);
    if (!hostname || !project.port) return null;
    const port = routerPort();
    if (!port) return null;
    const scheme = routerIsTls() ? 'https' : 'http';
    const suffix = (port === 80 || port === 443) ? '' : `:${port}`;
    return `${scheme}://${hostname}${suffix}/`;
}

/**
 * Who already answers for this host name, across every tenant on the install.
 *
 * Every tenant and not just this one, on purpose. The router holds one map of
 * names for the whole machine, so two tenants declaring the same name would
 * mean one of them answering under the other's, decided by the order their
 * folders happened to be read. That is a name hijack between tenants, not a
 * cosmetic clash, so it is refused where it is typed.
 */
function hostnameOwner({ pathsFor, tenantsRoot }, hostname, exclude) {
    for (const { slug, tenantPaths } of projectStore.tenantsWithProjects(tenantsRoot(), pathsFor)) {
        for (const project of projectStore.listProjects(tenantPaths)) {
            if (normaliseHostname(project.hostname) !== hostname) continue;
            if (exclude && slug === exclude.slug && project.id === exclude.projectId) continue;
            return { slug, projectId: project.id };
        }
    }
    return null;
}

/**
 * The absolute origin to hand GitHub for redirects and webhooks.
 *
 * The configured public URL wins, because that is the one an operator has
 * pointed DNS and a certificate at. Falling back to the request's own host
 * covers a LAN-only install, where the redirect still works: GitHub redirects
 * the operator's browser, and the browser is already on the LAN.
 */
function originFor(req) {
    return machineStore.publicBaseUrl() || `${req.protocol}://${req.get('host')}`;
}

/** Turns a GitHub API failure into a reason the page can act on. */
function ghError(res, e, where) {
    const status = e.status === 401 || e.status === 403 ? 502 : (e.status === 504 ? 504 : 502);
    console.error(`[Deploy] ${where} failed:`, e.status || '', e.message);
    return res.status(status).json({
        success: false,
        error: e.status === 504 ? 'github_unreachable' : 'github_failed',
        detail: e.message
    });
}

/**
 * Refuses when this tenant has not registered a GitHub App yet.
 *
 * Per tenant and not per machine: another tenant's registration on the same
 * host is not this tenant's credential, and reading it here would hand a token
 * for somebody else's private repositories to whoever asked first.
 */
function withApp(req, res) {
    const app = machineStore.getGitHubApp(req.tenant.slug);
    if (!app || !app.privateKey) {
        res.status(409).json({ success: false, error: 'github_not_connected' });
        return null;
    }
    return app;
}

/**
 * Refuses every request when the host has not opted in.
 *
 * 503 rather than 403: the tenant has done nothing wrong and there is nothing
 * they can click to fix it. The reason code lets the page say so.
 */
function requireOptIn(req, res, next) {
    if (!machineStore.isEnabled()) {
        return res.status(503).json({
            success: false,
            error: 'deploy_not_enabled',
            hint: 'Install Deploy from the extension store, then restart the Aegis service. '
                + 'The install grants the host opt-in; there is no option to set and nothing to re-run.'
        });
    }
    next();
}

/**
 * Routes mounted above the session wall.
 *
 * Only the webhook belongs here, and it pays for that with signature
 * verification. `resolver` still runs, because the module gate reads
 * `req.tenantPaths`: a tenant who switched the module off must not have their
 * pushes build.
 */
function registerPublic(router, { resolver, moduleGate }) {
    router.post('/api/deploy/webhook', resolver, moduleGate, requireOptIn, (req, res) => {
        // Uniform response. A caller must not be able to tell a bad signature
        // from an unknown repository from a project that exists, because that
        // difference is a free enumeration oracle on an internet-facing route.
        const accept = () => res.status(202).json({ success: true });

        const raw = req.rawBody;
        if (!raw || raw.length > MAX_BODY_BYTES) return accept();

        const app = machineStore.getGitHubApp(req.tenant.slug);
        if (!app || !app.webhookSecret) return accept();

        if (!verifySignature(raw, req.get('X-Hub-Signature-256'), app.webhookSecret)) {
            console.warn(`[Deploy] ${req.tenant.slug}: webhook signature rejected`);
            return accept();
        }
        if (!deliveries.claim(req.get('X-GitHub-Delivery'))) return accept();

        const event = req.get('X-GitHub-Event');
        if (event === 'ping') return accept();
        if (event !== 'push') return accept();

        const push = parsePush(req.body);
        if (!push) return accept();

        // Phase 3 replaces this with createDeployment(). Logging the verified
        // push now means the endpoint can be tested end to end against a real
        // repository before any build machinery exists.
        console.log(`[Deploy] ${req.tenant.slug}: verified push ${push.repoFullName}@${push.branch} ${push.sha.slice(0, 8)}`);
        return accept();
    });
}

/** Routes below the session wall. The module gate is already mounted. */
function register(router, { requireRole, pathsFor, tenantsRoot, readOnlyDb, writableDb, resolveChrome, puppeteer }) {
    // The browser capabilities, handed straight down. `chromePath` and puppeteer
    // both live in the Aegis tree, which an extension installed under
    // C:\ProgramData\Aegis\extensions\ cannot reach by any path; the loader's
    // context is the only way in. Passed here rather than on each capture,
    // because a capture is started from `deployService` and from the poller,
    // neither of which holds this context. See `shots.useChrome`.
    shots.useChrome({ resolveChrome, puppeteer });

    // Both started here because core runs `register` once at boot, and both are
    // gated on the host opt-in: an install that never turns Deploy on never opens
    // the port and never calls GitHub on a timer.
    if (machineStore.isEnabled()) {
        // Before anything reads a registration. A GitHub App used to be stored
        // once per machine and is now stored per tenant; this moves an existing
        // one to its owner when the host has a single tenant, and sets it aside
        // when it cannot tell. Cheap and idempotent, so it runs at every boot
        // rather than behind a version flag nobody would remember to bump.
        try {
            machineStore.migrateLegacyGitHubApp(
                projectStore.allTenants(tenantsRoot(), pathsFor).map(({ slug }) => slug)
            );
        } catch (e) {
            // Not fatal. The consequence is that one tenant sees "no GitHub App"
            // and registers again, which is the fallback the migration already
            // chooses when it cannot attribute the old one.
            console.warn(`[Deploy] GitHub App migration skipped: ${e.message}`);
        }

        startAllSites({ pathsFor, tenantsRoot });
        // The listeners are back, and a project served by a process needs the
        // process back too or its port answers 503 until somebody redeploys it.
        startAllRuntimes({ pathsFor, tenantsRoot });
        // Off unless AEGIS_SITES_ROUTER_PORT names a port. A listener nobody
        // asked for is a listener on an audit server.
        startRouter({ pathsFor, tenantsRoot });
        startPoller({ pathsFor, tenantsRoot });
        // Injecte une fois au montage : `deployNow` lit `writableDb` en variable
        // de module, pas en argument, pour que ses cinq appelants (quatre routes
        // et le sweep du poller) ne puissent pas l'oublier. Voir deployService.js.
        useWritableDb(writableDb);
    }

    /**
     * What this install can actually do. The page renders itself from this
     * rather than assuming, because three of the four states here are ones an
     * operator has to fix on the host.
     */
    router.get('/api/deploy/status', (req, res) => {
        const status = machineStore.publicStatus(req.tenant.slug);
        res.json({
            success: true,
            ...status,
            webhookUrl: status.publicBaseUrl
                ? `${status.publicBaseUrl}/t/${req.tenant.slug}/api/deploy/webhook`
                : null,
            capabilities: {
                projects: true,
                builds: true,
                // The one that is still a decision about this host rather than
                // a feature: a process running application code on the audit
                // server. The form only offers it when this is true.
                runtimes: runtime.isEnabled()
            }
        });
    });

    // --- GitHub App registration (the manifest flow) ---------------------

    /**
     * Hands the browser a manifest to POST to github.com/settings/apps/new.
     *
     * Aegis cannot create the App itself: GitHub requires the operator to
     * confirm it while signed in, which is the point. The `state` is stored on
     * the session and checked on the way back, so a link someone else crafted
     * cannot drive the callback.
     *
     * This route used to refuse with 412 unless the host had a public HTTPS
     * address, on the belief that GitHub would not create an App whose webhook
     * it could not reach. Half right: GitHub requires the hook address to be
     * public, not to be this host's, and `redirect_url` is followed by the
     * operator's browser rather than by GitHub. So a LAN-only install can
     * register in one click after all, and the manual App-creation form below
     * stops being the only door. See `github.buildManifest` for the measurement.
     *
     * `owner` picks the account the App is created under, and it matters most
     * for exactly the repositories this feature exists to deploy: a `public:
     * false` App installs only on the account that owns it, so a personal-account
     * App can never read an organisation's private repositories.
     */
    router.post('/api/deploy/github/app/register-start', requireOptIn, requireRole('admin'), (req, res) => {
        if (machineStore.getGitHubApp(req.tenant.slug)) {
            return res.status(409).json({ success: false, error: 'github_already_connected' });
        }
        const state = crypto.randomBytes(24).toString('hex');
        const action = github.manifestAction((req.body && req.body.owner) || '', state);
        if (!action) {
            return res.status(400).json({ success: false, error: 'bad_owner' });
        }

        const origin = originFor(req);
        const base = `${origin}/t/${req.tenant.slug}`;
        req.session.deployAppState = state;

        // Only when GitHub can actually deliver. Absent, buildManifest fills the
        // field with a reserved address and switches delivery off, and the poller
        // is what notices a push.
        const publicBase = machineStore.publicBaseUrl();

        res.json({
            success: true,
            // GitHub reads the manifest from a form POST, so the page submits
            // this action with the manifest as a single field.
            action,
            manifest: github.buildManifest({
                name: `Aegis Deploy (${req.tenant.slug})`,
                baseUrl: base,
                webhookUrl: publicBase ? `${publicBase}/t/${req.tenant.slug}/api/deploy/webhook` : null,
                redirectUrl: `${base}/api/deploy/github/app/register-callback`
            })
        });
    });

    /**
     * Registration for an install GitHub cannot reach.
     *
     * The manifest flow needs a public HTTPS webhook address, which a LAN-only
     * install will never have, so the operator creates the App on github.com by
     * hand (leaving the webhook unchecked, which the web form allows and the
     * manifest API does not) and pastes the App id and private key here.
     *
     * No opt-in on reachability, deliberately: this route is the one that has to
     * work on localhost and on a private address. Cloning needs outbound HTTPS
     * only, and detection falls back to polling.
     *
     * The credentials are proved against GitHub before they are stored, so a
     * mistyped id or half a key pair cannot be saved as a working connection.
     */
    router.post('/api/deploy/github/app/manual', requireOptIn, requireRole('admin'), async (req, res) => {
        if (machineStore.getGitHubApp(req.tenant.slug)) {
            return res.status(409).json({ success: false, error: 'github_already_connected' });
        }
        const appId = String((req.body && req.body.appId) || '').trim();
        const privateKey = String((req.body && req.body.privateKey) || '').trim();

        // Validated here rather than left to GitHub, because these two are the
        // paste errors an operator actually makes and the messages differ.
        if (!/^[0-9]{1,20}$/.test(appId)) {
            return res.status(400).json({ success: false, error: 'bad_app_id' });
        }
        if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
            return res.status(400).json({ success: false, error: 'bad_private_key' });
        }

        try {
            const app = await github.verifyAppCredentials(appId, privateKey);
            machineStore.saveGitHubApp(req.tenant.slug, {
                appId: app.appId,
                slug: app.slug,
                htmlUrl: app.htmlUrl,
                privateKey
                // No client secret and no webhook secret: manual registration
                // produces neither, and the webhook route already refuses every
                // delivery when there is no secret to verify against.
            });
            console.log(`[Deploy] ${req.tenant.slug}: GitHub App ${app.slug || app.appId} registered by hand by ${req.user.email}`);
            return res.json({ success: true, github: { connected: true, appId: app.appId, slug: app.slug } });
        } catch (e) {
            // The key itself never reaches the log, only why it was refused.
            console.warn(`[Deploy] ${req.tenant.slug}: manual App registration refused (${e.status || ''} ${e.message})`);
            if (e.status === 401) return res.status(400).json({ success: false, error: 'github_rejected_credentials' });
            if (e.status === 409) return res.status(400).json({ success: false, error: 'app_id_key_mismatch' });
            if (/asn1|PEM|DECODER|unsupported/i.test(e.message)) {
                return res.status(400).json({ success: false, error: 'bad_private_key' });
            }
            return res.status(502).json({ success: false, error: 'github_unreachable' });
        }
    });

    /**
     * Where GitHub sends the operator back, carrying a single-use code.
     *
     * Answers with a redirect rather than JSON, because a browser lands here
     * from GitHub and the operator should end up back on the page.
     */
    router.get('/api/deploy/github/app/register-callback', requireOptIn, requireRole('admin'), async (req, res) => {
        const page = `/t/${req.tenant.slug}/pages/deploy.html`;
        const expected = req.session.deployAppState;
        delete req.session.deployAppState;

        if (!expected || req.query.state !== expected) {
            console.warn(`[Deploy] ${req.tenant.slug}: App registration state mismatch`);
            return res.redirect(`${page}?connected=state_mismatch`);
        }
        if (!req.query.code) return res.redirect(`${page}?connected=no_code`);

        try {
            const app = await github.exchangeManifestCode(String(req.query.code));
            machineStore.saveGitHubApp(req.tenant.slug, app);
            console.log(`[Deploy] ${req.tenant.slug}: GitHub App ${app.slug} registered by ${req.user.email}`);
            return res.redirect(`${page}?connected=ok`);
        } catch (e) {
            console.error('[Deploy] manifest exchange failed:', e.status || '', e.message);
            return res.redirect(`${page}?connected=exchange_failed`);
        }
    });

    // --- Reading what the App can see ------------------------------------

    router.get('/api/deploy/github/installations', requireOptIn, async (req, res) => {
        const app = withApp(req, res);
        if (!app) return;
        try {
            res.json({ success: true, installations: await github.listInstallations(app) });
        } catch (e) { return ghError(res, e, 'listInstallations'); }
    });

    router.get('/api/deploy/github/repos', requireOptIn, async (req, res) => {
        const app = withApp(req, res);
        if (!app) return;
        const id = Number(req.query.installation_id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, error: 'installation_id required' });
        }
        try {
            res.json({ success: true, repos: await github.listRepos(app, id) });
        } catch (e) {
            if (e.status === 401) github.forgetInstallationToken(id);
            return ghError(res, e, 'listRepos');
        }
    });

    /**
     * The branches of one repository, for the pickers that used to assume the
     * default one.
     *
     * `installation_id` is optional and the route resolves it when it is
     * missing, because the two call sites know different things: the repository
     * list already holds an installation, and the paste field holds nothing but
     * a URL. A repository no installation covers is read anonymously, which is
     * the same fallback `POST /projects` uses to find a default branch.
     *
     * Not admin-only: reading which branches exist tells an operator nothing
     * they could not read on GitHub, and the deploy buttons this feeds are
     * already gated. `defaultBranch` rides along so the picker can preselect it
     * without a second call.
     */
    router.get('/api/deploy/github/branches', requireOptIn, async (req, res) => {
        const parsed = github.parseRepoUrl(req.query.repo || '');
        if (!parsed || !REPO_RE.test(parsed.fullName)) {
            return res.status(400).json({ success: false, error: 'bad_repo_url' });
        }
        const repoFullName = parsed.fullName;
        const app = machineStore.getGitHubApp(req.tenant.slug);

        let installationId = null;
        const asked = Number(req.query.installation_id);
        if (Number.isInteger(asked) && asked > 0) {
            installationId = asked;
        } else if (app && app.privateKey) {
            try {
                installationId = await github.installationForRepo(app, repoFullName);
            } catch (e) {
                // Not fatal: a public repository lists its branches with no
                // credential at all, and that is the case this falls into.
                console.warn(`[Deploy] ${req.tenant.slug}: installation lookup failed (${e.status || ''} ${e.message})`);
            }
        }

        try {
            const [branches, info] = await Promise.all([
                github.listBranches(app, installationId, repoFullName),
                installationId
                    ? github.ghFetch(`/repos/${repoFullName}`, {
                        token: await github.installationToken(app, installationId)
                    }).then((r) => ({ defaultBranch: (r && r.default_branch) || null }))
                    : github.publicRepoInfo(repoFullName)
            ]);
            return res.json({
                success: true,
                repoFullName,
                defaultBranch: info.defaultBranch || null,
                branches
            });
        } catch (e) {
            if (e.status === 401 && installationId) github.forgetInstallationToken(installationId);
            // 404 without an installation is a private repository the App was
            // never given, which is the same sentence project creation says.
            if (e.status === 404) {
                return res.status(404).json({
                    success: false,
                    error: installationId ? 'repo_not_found' : 'needs_install'
                });
            }
            return ghError(res, e, 'listBranches');
        }
    });

    // --- Projects (phase 2) ----------------------------------------------

    /**
     * One project as the page reads it.
     *
     * A function rather than an inline map, because a preview is rendered from
     * the same fields as the project it belongs to and two copies of this list
     * would drift the first time a field was added to one of them.
     */
    const projectView = (req, p) => ({
        id: p.id,
        name: p.name,
        repoFullName: p.repoFullName,
        branch: p.branch,
        rootDir: p.rootDir || null,
        installCmd: p.installCmd || null,
        buildCmd: p.buildCmd || null,
        outputDir: p.outputDir || null,
        lastSha: p.lastSha || null,
        // Whether `previous/` holds something, and what. The rollback button
        // is offered only when this is set.
        previousSha: p.previousSha || null,
        deployedAt: p.deployedAt || null,
        lastError: p.lastError || null,
        failureCount: p.failureCount || 0,
        // Whether the sweep has stopped retrying the commit that keeps failing,
        // so the card can say so. Without it a project the poller has given up
        // on looks identical to one it is about to try again, and the operator
        // has no way to know the next move is theirs. Deploy and Redeploy are
        // unaffected: they call `deployNow` and never go through `decide`.
        pollGaveUp: !!p.lastFailedSha &&
            (p.failedShaAttempts || 0) >= SAME_SHA_ATTEMPTS,
        history: Array.isArray(p.history) ? p.history.slice(0, 5) : [],
        port: p.port || null,
        url: siteUrl(req, p),
        // Whether the port is open, not whether a version was published.
        // A listener that lost its bind to another program leaves a project
        // that deployed perfectly well and answers nothing.
        serving: isServing(req.tenant.slug, p.id),
        // So a card can show a lock without a second call. Absent `auth` on
        // every project predating the guard reads as false, which is what
        // the site server does with it too.
        protected: isProtectedRecord(p),
        authMethod: methodOfProject(p),
        allowedGroups: groupsOf(p),
        tls: tlsView(p),
        envCount: projectEnv.list(p).length,
        spaFallback: !!p.spaFallback,
        hostname: p.hostname || null,
        hostUrl: siteHostUrl(p),
        // So the page can say why a host name it saved is not a link yet.
        routerPort: routerPort(),
        // Read from disk, not from the record: the record can disagree
        // after a crash or a folder deleted by hand, and the disk is what
        // decides whether a promote will work.
        releases: releasesFor(req.tenantPaths, p),
        runtime: p.runtime === 'node' ? 'node' : 'static',
        startCmd: p.startCmd || null,
        // A process that is not running leaves the port answering 503, which is
        // a different state from a site that never deployed.
        running: p.runtime === 'node' ? runtime.isRunning(req.tenant.slug, p.id) : null,
        // Set on a preview, null on a project. The page groups by it.
        parentId: p.parentId || null,
        // Whether a thumbnail has been captured for what is currently on the
        // port. A boolean and not a URL: the page builds the URL and stamps it
        // with `deployedAt`, which is what makes a redeployed site show its new
        // first screen instead of the browser's copy of the old one.
        hasPreview: shots.has(req.tenantPaths, p.id)
    });

    /**
     * Every project, with each one's previews under it.
     *
     * Previews are project records with a `parentId`, which is what lets them
     * reuse the port allocation, the listener, the release folders, the branch
     * polling and the guard. They are not projects on the page, though: a
     * repository with six open branches would otherwise bury the site itself
     * under six cards that are all the same site.
     */
    router.get('/api/deploy/projects', requireOptIn, (req, res) => {
        const all = projectStore.listProjects(req.tenantPaths);
        const projects = all.filter((p) => !p.parentId).map((p) => Object.assign(projectView(req, p), {
            previews: all
                .filter((v) => v.parentId === p.id)
                .map((v) => projectView(req, v))
                .sort((a, b) => (b.deployedAt || 0) - (a.deployedAt || 0))
        }));
        res.json({ success: true, projects });
    });

    /**
     * Creates a project and deploys it once, synchronously.
     *
     * Synchronous because a shallow clone of a static site is seconds, and the
     * alternative is the deployment queue, the state machine and the log stream
     * from phase 3. Those arrive with push-to-deploy, where a build the operator
     * is not watching genuinely needs them.
     *
     * A repository with no `installCmd`/`buildCmd` still runs nothing but
     * `git clone` here, same as before. One that declares a build command
     * runs it in the sandbox `cloner.js` hands off to -- see
     * docs/superpowers/specs/2026-08-18-deploy-build-sandbox-design.md.
     */
    router.post('/api/deploy/projects', requireOptIn, requireRole('admin'), async (req, res) => {
        const app = machineStore.getGitHubApp(req.tenant.slug);
        const body = req.body || {};

        // Recording starts here, before anything has been read out of the body.
        //
        // The browser opened the console on this id the moment the operator
        // clicked, and it polls for it every half second. A run that comes into
        // existence only once the repository has been parsed, an installation
        // looked up and a port allocated leaves that console with nothing to
        // show for as long as GitHub takes to answer -- and with nothing at all,
        // ever, when one of those steps refuses. Every refusal below goes
        // through `refuse`, so the reason is on the screen the operator is
        // already looking at rather than only in this response.
        const run = runs.start({
            id: body.runId,
            slug: req.tenant.slug,
            tenantPaths: req.tenantPaths,
            projectId: '',
            projectName: String(body.name || body.repoUrl || body.repoFullName || '').slice(0, 80),
            branch: String(body.branch || '').trim(),
            trigger: 'create',
            actor: req.user.email
        });

        /** Answers the request and closes the console on the same reason. */
        const refuse = (status, payload) => {
            // The code alone is not worth a log line: the console turns it into
            // a sentence when the run finishes. A detail is the tool's own words.
            if (payload.detail) runs.log(run, payload.detail);
            runs.stage(run, 'clone', 'failed');
            runs.finish(run, 'failed', payload.error);
            return res.status(status).json(Object.assign({ success: false, runId: run.id }, payload));
        };

        // One field instead of three. GitHub knows which installation can see a
        // repository and what the default branch is, so asking the operator for
        // either was asking them to look up something Aegis can read.
        const parsed = github.parseRepoUrl(body.repoUrl || body.repoFullName);
        if (!parsed || !REPO_RE.test(parsed.fullName)) {
            return refuse(400, { error: 'bad_repo_url' });
        }
        const repoFullName = parsed.fullName;
        const rootDir = body.rootDir ? String(body.rootDir) : '';

        // Resolution order matters. An installation is tried first because it is
        // the only way into a private repository; a public one then works with no
        // App at all, which is why a missing installation is not fatal here.
        let installationId = null;
        if (app && app.privateKey) {
            try {
                installationId = await github.installationForRepo(app, repoFullName);
            } catch (e) {
                console.warn(`[Deploy] ${req.tenant.slug}: installation lookup failed (${e.status || ''} ${e.message})`);
            }
        }

        let branch = String(body.branch || '').trim();
        if (!branch) {
            try {
                if (installationId) {
                    const info = await github.ghFetch(`/repos/${repoFullName}`, {
                        token: await github.installationToken(app, installationId)
                    });
                    branch = (info && info.default_branch) || '';
                } else {
                    branch = (await github.publicRepoInfo(repoFullName)).defaultBranch || '';
                }
            } catch (e) {
                // 404 without an installation is the interesting case: either the
                // repository is private and the App cannot see it, or it does not
                // exist. Both are fixed by installing the App on it.
                if (e.status === 404) {
                    return refuse(404, {
                        error: installationId ? 'repo_not_found' : 'needs_install',
                        installUrl: app && app.slug
                            ? `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`
                            : null
                    });
                }
                return refuse(502, { error: 'github_unreachable', detail: e.message });
            }
        }
        if (!safeBranch(branch)) {
            return refuse(400, { error: 'bad_branch' });
        }
        // Resolved, so the console names the branch it is about to clone rather
        // than staying blank on a project created without one.
        run.branch = branch;

        let id;
        let port;
        try {
            id = projectStore.idFor(req.tenantPaths, body.name || parsed.repo, repoFullName);
            port = allocatePort({ pathsFor, tenantsRoot });
        } catch (e) {
            return refuse(409, {
                error: e.code === 'no_free_port' ? 'no_free_port' : 'id_unavailable',
                detail: e.message
            });
        }

        // Inferred from the start command rather than asked for separately. A
        // project is served by a process because there is a command to run; a
        // radio button beside it would be a second way to say the same thing and
        // a third state when the two disagree.
        const wantsProcess = !!(body.startCmd && String(body.startCmd).trim()) ||
            String(body.runtime || '') === 'node';
        if (wantsProcess && !runtime.isEnabled()) {
            // The host, not the tenant. A tenant admin can ask for a process and
            // still not get one on this server.
            return refuse(403, { error: 'runtime_disabled' });
        }
        const startCmd = body.startCmd ? String(body.startCmd).trim().slice(0, 500) : '';
        if (wantsProcess && !startCmd) {
            return refuse(400, { error: 'no_start_cmd' });
        }

        // Le nom du fichier de base et le dossier des migrations sont des
        // reglages du projet parce que c'est l'application qui les choisit :
        // le premier est le fichier qu'elle ouvre sous AEGIS_DATA_DIR, le
        // second un chemin dans son depot. Aegis impose seulement qu'ils ne
        // sortent pas de leur dossier. `projectSettings` porte les deux regles
        // et se teste hors ligne, sans cette route.
        let dbFile;
        let migrationsDir;
        try {
            dbFile = projectSettings.resolveDbFile(body.dbFile);
            migrationsDir = projectSettings.resolveMigrationsDir(body.migrationsDir);
        } catch (e) {
            return refuse(400, { error: e.code });
        }

        const draft = {
            id,
            name: String(body.name || parsed.repo).slice(0, 80),
            installationId,
            repoFullName,
            branch,
            rootDir: rootDir || null,
            installCmd: body.installCmd ? String(body.installCmd).slice(0, 500) : null,
            buildCmd: body.buildCmd ? String(body.buildCmd).slice(0, 500) : null,
            outputDir: body.outputDir ? String(body.outputDir).slice(0, 200) : null,
            runtime: wantsProcess ? 'node' : 'static',
            startCmd: wantsProcess ? startCmd : null,
            port,
            dbFile,
            migrationsDir,
            createdAt: Date.now(),
            createdBy: req.user.email
        };

        // The run has been recording since the top of this handler; now that the
        // project has an id it moves under it, so the project's detail view and
        // `dropProject` both see it.
        runs.attach(run, id, draft.name);

        try {
            const result = await deployNow({
                app,
                slug: req.tenant.slug,
                tenantPaths: req.tenantPaths,
                project: draft,
                trigger: 'create',
                actor: req.user.email,
                run
            });
            // Already deploying under this id: a double click, or a second tab.
            // `deployNow` returns rather than throwing, and taking that for
            // success used to answer with a project that was never written and
            // leave this run recording a deployment it never started.
            if (!result.deployed) {
                runs.finish(run, 'failed', 'busy');
                return res.status(409).json({ success: false, error: 'busy', runId: run.id });
            }
            const stored = projectStore.getProject(req.tenantPaths, id);
            // The listener starts only once files exist, so a failed first
            // deployment does not leave a port open on an empty folder.
            startSiteFor({ slug: req.tenant.slug, tenantPaths: req.tenantPaths, project: stored });
            return res.json({
                success: true,
                runId: run.id,
                project: Object.assign({}, stored, { url: siteUrl(req, stored) })
            });
        } catch (e) {
            // deployNow recorded the attempt and left `current` untouched. A first
            // deployment that fails leaves a project with no site, which the page
            // shows as a failed card rather than hiding.
            const reason = e.reason || 'deploy_failed';
            return res.status(reason === 'deploy_failed' ? 502 : 400).json({
                success: false,
                error: reason,
                runId: run.id,
                // What the tool printed, token redacted. Admin-only route, and
                // the alternative is an operator reading "the clone failed"
                // about a build that never got as far as cloning.
                detail: e.detail || e.message,
                // Set when the refusal came with a folder worth pointing at, so
                // the page can name it instead of asking the operator to guess.
                suggestRootDir: e.rootDir || undefined
            });
        }
    });

    /**
     * Removes a project: its record, its files, and its listener.
     *
     * There is no soft delete and no confirmation token. A project here is a
     * clone of a repository that still exists on GitHub plus a port number, so
     * the cost of recreating one is a click, and the cost of a two-step deletion
     * flow is paid on every use. The browser asks before calling this.
     *
     * A deployment in flight is refused rather than raced: `deployNow` renames
     * into `current` at the end, and deleting the folder underneath it would
     * leave the rename to recreate what was just removed.
     */
    router.delete('/api/deploy/projects/:id', requireOptIn, requireRole('admin'), (req, res) => {
        if (!projectStore.PROJECT_ID_RE.test(req.params.id || '')) {
            return res.status(404).json({ success: false, error: 'unknown_project' });
        }
        if (isDeploying(req.tenant.slug, req.params.id)) {
            return res.status(409).json({ success: false, error: 'busy' });
        }

        // The previews go first. A preview whose parent record is gone is a
        // port and a folder nothing on the page can reach.
        for (const preview of previews.listFor(req.tenantPaths, req.params.id)) {
            if (isDeploying(req.tenant.slug, preview.id)) {
                return res.status(409).json({ success: false, error: 'busy' });
            }
            previews.remove({
                slug: req.tenant.slug, tenantPaths: req.tenantPaths, projectId: preview.id
            });
        }

        // One sequence, in `previews.js`, because the expiry sweep runs it too:
        // the listener, the record, the files, and everything keyed on the id.
        // The id is handed to the next project of the same name, so a session, a
        // lockout, a cached rule or a build console left behind is inherited.
        const removed = previews.remove({
            slug: req.tenant.slug, tenantPaths: req.tenantPaths, projectId: req.params.id
        });
        if (!removed) return res.status(404).json({ success: false, error: 'unknown_project' });
        console.log(`[Deploy] ${req.tenant.slug}: ${req.params.id} deleted by ${req.user.email}`);
        // The name, so the page can say what it removed. By the time the answer
        // arrives the record is gone and the browser's copy may be a list old.
        return res.json({ success: true, name: removed.name || removed.id });
    });

    /**
     * Deploys the current head of an existing project's branch, on demand.
     *
     * The poller covers the normal case. This exists for the two it does not: an
     * operator who does not want to wait for the next tick, and a project whose
     * backoff has pushed the next attempt minutes out after a failure they have
     * since fixed.
     */
    router.post('/api/deploy/projects/:id/redeploy', requireOptIn, requireRole('admin'), async (req, res) => {
        const app = withApp(req, res);
        if (!app) return undefined;

        if (!projectStore.PROJECT_ID_RE.test(req.params.id || '')) {
            return res.status(404).json({ success: false, error: 'unknown_project' });
        }
        const project = projectStore.getProject(req.tenantPaths, req.params.id);
        if (!project) return res.status(404).json({ success: false, error: 'unknown_project' });

        const run = runs.start({
            id: (req.body || {}).runId,
            slug: req.tenant.slug,
            tenantPaths: req.tenantPaths,
            projectId: project.id,
            projectName: project.name,
            branch: project.branch,
            trigger: 'manual',
            actor: req.user.email
        });

        try {
            const result = await deployNow({
                app,
                slug: req.tenant.slug,
                tenantPaths: req.tenantPaths,
                project,
                trigger: 'manual',
                actor: req.user.email,
                run
            });
            if (!result.deployed) {
                // Already deploying. Not an error: the operator clicked twice, or
                // the poller got there first. The run this request opened never
                // ran anything, so it is dropped rather than left on the
                // Deployments list as a deployment that did nothing.
                runs.finish(run, 'failed', 'busy');
                return res.status(409).json({ success: false, error: 'busy' });
            }
            const stored = projectStore.getProject(req.tenantPaths, req.params.id);
            startSiteFor({ slug: req.tenant.slug, tenantPaths: req.tenantPaths, project: stored });
            return res.json({
                success: true,
                runId: run.id,
                project: Object.assign({}, stored, { url: siteUrl(req, stored) })
            });
        } catch (e) {
            const reason = e.reason || 'deploy_failed';
            return res.status(reason === 'deploy_failed' ? 502 : 400).json({
                success: false,
                error: reason,
                runId: run.id,
                // What the tool printed, token redacted. Admin-only route, and
                // the alternative is an operator reading "the clone failed"
                // about a build that never got as far as cloning.
                detail: e.detail || e.message,
                // Set when the refusal came with a folder worth pointing at, so
                // the page can name it instead of asking the operator to guess.
                suggestRootDir: e.rootDir || undefined
            });
        }
    });

    /**
     * Moves a project to another branch and republishes it there.
     *
     * A route of its own rather than a field on `/settings`, because this is
     * not a setting: it clones, it swaps what is on the port and it can fail,
     * so it needs the run and the console every other deployment gets. The
     * settings route stays what it is, two values written to a record.
     *
     * The branch is checked against GitHub before it is written. Saving first
     * and finding out at the clone would leave the record pointing at a branch
     * that does not exist, and the poller would then report `branch_gone`
     * every twenty seconds about a name the operator only mistyped.
     *
     * A deployment that fails after the write keeps the new branch: the branch
     * is real, the build is what broke, and reverting the record would hide
     * which branch the console is talking about.
     *
     * A preview is refused. Its branch is its identity: the id was derived from
     * it, the parent lists it by it, and changing it would leave a folder named
     * after a branch it no longer tracks. Remove it and deploy the other one.
     */
    router.post('/api/deploy/projects/:id/branch', requireOptIn, requireRole('admin'), async (req, res) => {
        // Read rather than demanded, because a project on a public repository
        // was cloned without one and its branch has to stay changeable on an
        // install where no App was ever registered. The one case that does need
        // it is checked below, once the record says whether an installation is
        // involved.
        const app = machineStore.getGitHubApp(req.tenant.slug);

        if (!projectStore.PROJECT_ID_RE.test(req.params.id || '')) {
            return res.status(404).json({ success: false, error: 'unknown_project' });
        }
        const project = projectStore.getProject(req.tenantPaths, req.params.id);
        if (!project) return res.status(404).json({ success: false, error: 'unknown_project' });
        if (project.parentId) {
            return res.status(400).json({ success: false, error: 'preview_branch_fixed' });
        }

        const branch = String((req.body || {}).branch || '').trim();
        if (!previews.BRANCH_RE.test(branch) || !safeBranch(branch)) {
            return res.status(400).json({ success: false, error: 'bad_branch' });
        }
        if (branch === project.branch) {
            return res.status(409).json({ success: false, error: 'branch_unchanged' });
        }
        // Otherwise the site and one of its previews would poll the same branch
        // and publish the same commit on two ports, which reads as a duplicate
        // rather than as a preview.
        if (previews.listFor(req.tenantPaths, project.id).some((v) => v.branch === branch)) {
            return res.status(409).json({ success: false, error: 'branch_is_preview' });
        }

        if (project.installationId && !(app && app.privateKey)) {
            // The record says a private repository read through an
            // installation, and there is no App left to mint a token with.
            return res.status(409).json({ success: false, error: 'github_not_connected' });
        }

        try {
            await github.branchHead(app, project.installationId, project.repoFullName, branch, null);
        } catch (e) {
            if (e.status === 404) {
                return res.status(404).json({ success: false, error: 'branch_gone' });
            }
            if (e.status === 401 && project.installationId) {
                github.forgetInstallationToken(project.installationId);
            }
            return ghError(res, e, 'branchHead');
        }

        let moved;
        try {
            moved = projectStore.saveProject(req.tenantPaths, Object.assign({}, project, {
                branch,
                // The poll state belongs to the branch that was here. Kept, the
                // ETag would answer 304 for a repository whose head this record
                // has never seen, and `lastSeenSha` would be compared against a
                // commit from another branch.
                pollEtag: null,
                lastSeenSha: null,
                lastError: null,
                failureCount: 0
            }));
        } catch (e) {
            console.error(`[Deploy] ${req.tenant.slug}: ${project.id} branch write failed: ${e.message}`);
            return res.status(500).json({ success: false, error: 'settings_write_failed' });
        }

        const run = runs.start({
            id: (req.body || {}).runId,
            slug: req.tenant.slug,
            tenantPaths: req.tenantPaths,
            projectId: moved.id,
            projectName: moved.name,
            branch,
            trigger: 'manual',
            actor: req.user.email
        });
        runs.log(run, `branch ${project.branch} -> ${branch}`);

        try {
            const result = await deployNow({
                app,
                slug: req.tenant.slug,
                tenantPaths: req.tenantPaths,
                project: moved,
                trigger: 'manual',
                actor: req.user.email,
                run
            });
            if (!result.deployed) {
                // The branch is saved either way: the poller will pick it up on
                // its next tick, so the operator is not left with a record that
                // says one thing and a port that serves another indefinitely.
                runs.finish(run, 'failed', 'busy');
                return res.status(409).json({ success: false, error: 'busy', branch });
            }
            const stored = projectStore.getProject(req.tenantPaths, moved.id);
            startSiteFor({ slug: req.tenant.slug, tenantPaths: req.tenantPaths, project: stored });
            console.log(`[Deploy] ${req.tenant.slug}: ${stored.id} now tracks ${branch} (was ${project.branch}) by ${req.user.email}`);
            return res.json({
                success: true,
                runId: run.id,
                branch,
                project: Object.assign({}, stored, { url: siteUrl(req, stored) })
            });
        } catch (e) {
            const reason = e.reason || 'deploy_failed';
            return res.status(reason === 'deploy_failed' ? 502 : 400).json({
                success: false,
                error: reason,
                runId: run.id,
                branch,
                detail: e.detail || e.message,
                suggestRootDir: e.rootDir || undefined
            });
        }
    });

    /**
     * What one deployment is doing, or did.
     *
     * Polled rather than streamed. Server-sent events would be the obvious fit
     * and were the first design, but this backend is installed behind whatever
     * reverse proxy the customer already runs, and a buffered SSE connection
     * fails by showing nothing rather than by erroring. A request every half
     * second reuses the session, the tenant resolver and the module gate that
     * every other route on this page already goes through.
     *
     * ponytail: polling with a line cursor. Move to SSE if a build console ever
     * has to serve more than the handful of operators one tenant has.
     */
    router.get('/api/deploy/runs/:id', requireOptIn, (req, res) => {
        if (!runs.RUN_ID_RE.test(req.params.id || '')) {
            return res.status(404).json({ success: false, error: 'unknown_run' });
        }
        const after = Number.parseInt(req.query.after, 10);

        const run = runs.get(req.tenant.slug, req.params.id);
        if (run) return res.json({ success: true, run: runs.snapshot(run, after) });

        // Not in memory means either a run from before the last restart or a run
        // that never existed, and the stored record is what tells those apart.
        // `read` is scoped to this tenant's folder, so an id from another tenant
        // is a miss here exactly as it is in memory.
        const kept = runStore.read(req.tenantPaths, req.params.id, after);
        if (!kept) return res.status(404).json({ success: false, error: 'unknown_run' });
        return res.json({ success: true, run: kept });
    });

    /** Every run this tenant has in memory, or one project's. Newest first. */
    router.get('/api/deploy/runs', requireOptIn, (req, res) => {
        const projectId = req.query.projectId ? String(req.query.projectId) : '';
        if (projectId && !projectStore.PROJECT_ID_RE.test(projectId)) {
            return res.status(400).json({ success: false, error: 'unknown_project' });
        }
        const live = projectId
            ? runs.listForProject(req.tenant.slug, projectId)
            : runs.listRecent(req.tenant.slug, 30);
        const kept = projectId
            ? runStore.listForProject(req.tenantPaths, projectId)
            : runStore.listRecent(req.tenantPaths, 60);

        // No lines: this is a list, and a run holds up to five hundred of them.
        const views = live.map((r) => {
            const view = runs.snapshot(r, Number.MAX_SAFE_INTEGER);
            view.lines = [];
            view.resync = false;
            return view;
        });
        // Memory wins on a tie. A run that finished in this process is in both
        // places, and the in-memory copy is the one with the abort controller
        // behind it.
        const seen = new Set(views.map((v) => v.id));
        for (const stored of kept) {
            if (!seen.has(stored.id)) views.push(stored);
        }
        views.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

        return res.json({
            success: true,
            runs: views
        });
    });

    /**
     * Stops a deployment the operator no longer wants.
     *
     * Nothing is undone: `cloneToCurrent` renames into `current` as its last
     * act, so a cancel before that point leaves the site exactly as it was, and
     * a cancel after it has nothing left to interrupt.
     */
    router.post('/api/deploy/runs/:id/cancel', requireOptIn, requireRole('admin'), (req, res) => {
        if (!runs.RUN_ID_RE.test(req.params.id || '')) {
            return res.status(404).json({ success: false, error: 'unknown_run' });
        }
        const run = runs.get(req.tenant.slug, req.params.id);
        if (!run) return res.status(404).json({ success: false, error: 'unknown_run' });
        if (!runs.cancel(run)) {
            return res.status(409).json({ success: false, error: 'already_finished' });
        }
        console.log(`[Deploy] ${req.tenant.slug}: ${run.projectId} cancelled by ${req.user.email}`);
        return res.json({ success: true });
    });

    /**
     * Deploys another branch of the same repository, alongside the live one.
     *
     * Everything but the branch comes from the parent record: the repository,
     * the installation, the subfolder, the install and build commands, and the
     * directory guard. A preview of a protected site is protected, and it is
     * copied at creation rather than resolved per request, so the parent's
     * protection route propagates a later change.
     *
     * No host name, and none can be set on it: names are claimed across the
     * whole install and a branch that lives for a week should not be holding
     * one. It answers on its own port, like every site here.
     */
    router.post('/api/deploy/projects/:id/previews', requireOptIn, requireRole('admin'), async (req, res) => {
        const app = machineStore.getGitHubApp(req.tenant.slug);
        if (!projectStore.PROJECT_ID_RE.test(req.params.id || '')) {
            return res.status(404).json({ success: false, error: 'unknown_project' });
        }
        const parent = projectStore.getProject(req.tenantPaths, req.params.id);
        if (!parent) return res.status(404).json({ success: false, error: 'unknown_project' });
        if (parent.parentId) {
            // A preview of a preview has no meaning: the branch is the axis, and
            // it is already spent.
            return res.status(400).json({ success: false, error: 'already_preview' });
        }

        const branch = String((req.body || {}).branch || '').trim();
        if (!previews.BRANCH_RE.test(branch) || !safeBranch(branch)) {
            return res.status(400).json({ success: false, error: 'bad_branch' });
        }
        if (branch === parent.branch) {
            return res.status(409).json({ success: false, error: 'branch_is_production' });
        }
        if (previews.listFor(req.tenantPaths, parent.id).some((v) => v.branch === branch)) {
            return res.status(409).json({ success: false, error: 'preview_exists' });
        }

        const run = runs.start({
            id: (req.body || {}).runId,
            slug: req.tenant.slug,
            tenantPaths: req.tenantPaths,
            projectId: '',
            projectName: previews.nameFor(parent, branch),
            branch,
            trigger: 'preview',
            actor: req.user.email
        });

        let id;
        let port;
        try {
            id = projectStore.idFor(req.tenantPaths, `${parent.id} ${branch}`, parent.repoFullName);
            port = allocatePort({ pathsFor, tenantsRoot });
        } catch (e) {
            runs.stage(run, 'clone', 'failed');
            runs.finish(run, 'failed', e.code === 'no_free_port' ? 'no_free_port' : 'id_unavailable');
            return res.status(409).json({
                success: false, runId: run.id,
                error: e.code === 'no_free_port' ? 'no_free_port' : 'id_unavailable'
            });
        }

        const draft = {
            id,
            name: previews.nameFor(parent, branch),
            parentId: parent.id,
            installationId: parent.installationId || null,
            repoFullName: parent.repoFullName,
            branch,
            rootDir: parent.rootDir || null,
            installCmd: parent.installCmd || null,
            buildCmd: parent.buildCmd || null,
            outputDir: parent.outputDir || null,
            runtime: parent.runtime === 'node' ? 'node' : 'static',
            startCmd: parent.startCmd || null,
            // Copied, not inherited by reference: the guard reads the record of
            // the site being served, and a preview of a protected site must be
            // protected from its first request.
            auth: parent.auth || undefined,
            spaFallback: !!parent.spaFallback,
            port,
            createdAt: Date.now(),
            createdBy: req.user.email
        };

        runs.attach(run, id, draft.name);

        try {
            const result = await deployNow({
                app,
                slug: req.tenant.slug,
                tenantPaths: req.tenantPaths,
                project: draft,
                trigger: 'preview',
                actor: req.user.email,
                run
            });
            if (!result.deployed) {
                runs.finish(run, 'failed', 'busy');
                return res.status(409).json({ success: false, error: 'busy', runId: run.id });
            }
            const stored = projectStore.getProject(req.tenantPaths, id);
            startSiteFor({ slug: req.tenant.slug, tenantPaths: req.tenantPaths, project: stored });
            console.log(`[Deploy] ${req.tenant.slug}: preview ${id} of ${parent.id} on ${branch}, by ${req.user.email}`);
            return res.json({ success: true, runId: run.id, project: projectView(req, stored) });
        } catch (e) {
            const reason = e.reason || 'deploy_failed';
            return res.status(reason === 'needs_build' || reason === 'no_index' ? 422 : 502).json({
                success: false, runId: run.id, error: reason, detail: e.detail || e.message
            });
        }
    });

    /**
     * The project's own serving switches. One so far: the single-page fallback.
     *
     * A repository can ask for the same thing with a rewrite in `vercel.json`,
     * and a project that has one does not need this. It exists because the
     * fallback is what nearly every single-page build needs and asking someone
     * to add a config file to their repository to stop `/dashboard` returning
     * 404 on a refresh is a support call, not a feature.
     *
     * `siteConfig` answers from a five-second cache, so the switch takes effect
     * within that whether or not this call clears it. It is cleared anyway: an
     * operator who ticks a box and reloads expects the reload to show it.
     */
    router.post('/api/deploy/projects/:id/settings', requireOptIn, requireRole('admin'), (req, res) => {
        if (!projectStore.PROJECT_ID_RE.test(req.params.id || '')) {
            return res.status(404).json({ success: false, error: 'unknown_project' });
        }
        const project = projectStore.getProject(req.tenantPaths, req.params.id);
        if (!project) return res.status(404).json({ success: false, error: 'unknown_project' });

        const body = req.body || {};
        const wantsFallback = body.spaFallback !== undefined;
        const wantsHostname = body.hostname !== undefined;
        if (!wantsFallback && !wantsHostname) {
            return res.status(400).json({ success: false, error: 'no_settings' });
        }

        // A strict boolean, not a truthiness test: a value this route did not
        // expect must not quietly resolve to one of the two answers.
        if (wantsFallback && typeof body.spaFallback !== 'boolean') {
            return res.status(400).json({ success: false, error: 'bad_spa_fallback' });
        }

        let hostname;
        if (wantsHostname && project.parentId) {
            // Names are claimed across the whole install. A branch that lives
            // for a week does not get to hold one.
            return res.status(400).json({ success: false, error: 'preview_no_hostname' });
        }
        if (wantsHostname) {
            hostname = normaliseHostname(body.hostname);
            if (hostname === null) {
                return res.status(400).json({ success: false, error: 'bad_hostname' });
            }
            if (hostname) {
                const owner = hostnameOwner({ pathsFor, tenantsRoot }, hostname,
                    { slug: req.tenant.slug, projectId: project.id });
                if (owner) {
                    return res.status(409).json({ success: false, error: 'hostname_taken' });
                }
            }
        }

        // Mutated on the record that was read: `saveProject` replaces the row
        // whole, so a fresh object would drop every field this route does not
        // know about.
        if (wantsFallback) project.spaFallback = body.spaFallback;
        if (wantsHostname) project.hostname = hostname || null;

        let stored;
        try {
            stored = projectStore.saveProject(req.tenantPaths, project);
        } catch (e) {
            console.error(`[Deploy] ${req.tenant.slug}: ${req.params.id} settings write failed: ${e.message}`);
            return res.status(500).json({ success: false, error: 'settings_write_failed' });
        }

        siteConfig.invalidate(req.tenant.slug, stored.id);
        // The router answers from a five-second index; a saved name should be
        // live by the time the operator has finished reading the note.
        invalidateHostIndex();
        console.log(`[Deploy] ${req.tenant.slug}: ${stored.id} settings saved (fallback ${stored.spaFallback ? 'on' : 'off'}, host ${stored.hostname || 'none'}) by ${req.user.email}`);
        return res.json({
            success: true,
            spaFallback: !!stored.spaFallback,
            hostname: stored.hostname || null,
            hostUrl: siteHostUrl(stored),
            routerPort: routerPort()
        });
    });

    // --- The project's own data (see docs/superpowers/specs/
    //     2026-08-24-deploy-project-data-design.md) ------------------------

    /**
     * Every folder a project owns is rebuilt by a deployment except one.
     *
     * `current` is renamed over by each clone, `staging` and `build-output` are
     * cleared before each one, `releases` holds copies of past clones. `data` is
     * the one nothing in the deployment path reads or writes, so it is where an
     * application keeps what it has to remember, and these three routes are how
     * somebody looks at it without opening a shell on the VM.
     *
     * Admin only, all three. The environment routes set the precedent: a
     * project's shape is readable by any member, its contents are not, and a
     * database is contents.
     *
     * `readOnlyDb` is core's, handed in by the loader. It opens with
     * `OPEN_READONLY` and builds every statement itself from a table name and a
     * column name this router checked; no SQL crosses the wire in either
     * direction. An install whose core predates the capability gets a refusal
     * rather than a crash.
     */
    const withReader = (res) => {
        if (!readOnlyDb || typeof readOnlyDb.describe !== 'function') {
            res.status(501).json({ success: false, error: 'reader_unavailable' });
            return null;
        }
        return readOnlyDb;
    };

    /**
     * Le module d'ecriture, ou un refus lisible.
     *
     * Meme forme et meme raison que `withReader` : un Aegis anterieur a ce
     * module chargerait cette extension et n'aurait rien a passer. Repondre
     * "cette version d'Aegis ne sait pas ecrire ici" vaut mieux qu'un
     * TypeError dans un log que personne ne lit.
     */
    const withWriter = (res) => {
        if (!writableDb || typeof writableDb.updateCell !== 'function') {
            res.status(501).json({ success: false, error: 'writer_unavailable' });
            return null;
        }
        return writableDb;
    };

    /** The project this request names, or null with the refusal already sent. */
    const projectOr404 = (req, res) => {
        if (!projectStore.PROJECT_ID_RE.test(req.params.id || '')) {
            res.status(404).json({ success: false, error: 'unknown_project' });
            return null;
        }
        const project = projectStore.getProject(req.tenantPaths, req.params.id);
        if (!project) {
            res.status(404).json({ success: false, error: 'unknown_project' });
            return null;
        }
        return project;
    };

    /**
     * Turns a reader or writer error into the code the page has a sentence for.
     *
     * The default matters more than the list. A code missing from here becomes
     * `db_read_failed`, a 500, logged as an incident. For a NOT NULL constraint
     * refused on a write that is three false statements at once: it was not a
     * read, there is no folder involved, and the machine is fine -- the value
     * the operator just typed is what the schema rejected.
     *
     * So: adding a code to `writableDb` means adding it here. A 400 says "what
     * you asked for will not do", a 500 says "this machine has a problem", and
     * confusing them sends somebody hunting a fault that does not exist.
     */
    const dataError = (res, e, where) => {
        // The caller asked for something that will not do. Their side, not ours.
        const refusals = [
            // reading
            'bad_file', 'unknown_file', 'not_a_database', 'unknown_table', 'bad_order',
            // writing
            'not_editable', 'bad_column', 'bad_value', 'bad_rowid', 'constraint'
        ];
        if (refusals.includes(e.code)) {
            return res.status(400).json({ success: false, error: e.code });
        }
        // The row is gone. Somebody may have deleted it between the page being
        // drawn and the cell being clicked, which is a 404 and not a fault.
        if (e.code === 'unknown_row') {
            return res.status(404).json({ success: false, error: e.code });
        }
        // The application is writing right now. Retrying makes sense.
        if (e.code === 'db_busy') {
            return res.status(503).json({ success: false, error: e.code });
        }

        // Everything left really is this machine: file permissions, a corrupt
        // database, a full disk. The word has to say whether we were reading or
        // writing, or the log sends the next reader down the wrong path.
        const writing = ['updateCell', 'insertRow', 'deleteRow'].includes(where);
        console.error(`[Deploy] ${where} failed: ${e.message}`);
        return res.status(500).json({
            success: false, error: writing ? 'db_write_failed' : 'db_read_failed'
        });
    };

    /**
     * The project card's thumbnail.
     *
     * Not admin-only, unlike the data routes below it: this is a picture of a
     * page every member of the tenant can already open by clicking the card's
     * link, so gating it above the site it depicts would be theatre.
     * `projectOr404` still scopes it to this tenant's projects.
     *
     * `no-cache` rather than a long max-age, with the page passing `deployedAt`
     * as the query: the file at this path is replaced in place on every
     * deployment, so a cached copy is a picture of a release that is no longer
     * on the port.
     */
    router.get('/api/deploy/projects/:id/preview.png', requireOptIn, (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return undefined;
        if (!shots.has(req.tenantPaths, project.id)) {
            return res.status(404).json({ success: false, error: 'no_preview' });
        }
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-cache');
        return res.sendFile(shots.shotPath(req.tenantPaths, project.id));
    });

    router.get('/api/deploy/projects/:id/data', requireOptIn, requireRole('admin'), (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return undefined;

        return res.json({
            success: true,
            files: projectData.list(req.tenantPaths, project.id),
            // Ce que la CONSOLE peut faire, qui n'est pas ce que
            // l'application peut faire. Un site statique n'a pas de processus
            // pour ecrire ici, mais une base posee la par une version
            // precedente reste modifiable depuis cette page. Les deux faits
            // sont distincts et la page dit les deux.
            writable: projectData.list(req.tenantPaths, project.id)
                .some((f) => f.isDatabase),
            processWrites: project.runtime === 'node',
            // Named so the page can tell somebody where to point their
            // application, which is the question the empty state raises.
            variable: 'AEGIS_DATA_DIR',
            // Le chemin absolu, montre a un admin du locataire et a personne
            // d'autre. C'est ce qu'il faut pour poser l'ACL du compte qui
            // depose les fichiers, et pour pointer une tache planifiee dessus.
            // `ensureDataDir` et pas `dataDir` : un projet deploye avant que ce
            // dossier existe n'en a pas, et ouvrir cet onglet est un aussi bon
            // moment qu'un autre pour le lui donner.
            dataDir: projectStore.ensureDataDir(req.tenantPaths, project.id)
        });
    });

    router.get('/api/deploy/projects/:id/data/:file', requireOptIn, requireRole('admin'), async (req, res) => {
        const reader = withReader(res);
        if (!reader) return undefined;
        const project = projectOr404(req, res);
        if (!project) return undefined;

        let file;
        try {
            file = projectData.resolveFile(req.tenantPaths, project.id, req.params.file);
        } catch (e) {
            return dataError(res, e, 'resolveFile');
        }

        try {
            const tables = await reader.describe(file);
            return res.json({ success: true, file: req.params.file, tables });
        } catch (e) {
            return dataError(res, e, 'describe');
        }
    });

    router.get('/api/deploy/projects/:id/data/:file/rows', requireOptIn, requireRole('admin'), async (req, res) => {
        const reader = withReader(res);
        if (!reader) return undefined;
        const project = projectOr404(req, res);
        if (!project) return undefined;

        let file;
        try {
            file = projectData.resolveFile(req.tenantPaths, project.id, req.params.file);
        } catch (e) {
            return dataError(res, e, 'resolveFile');
        }

        try {
            const page = await reader.page(file, {
                table: String(req.query.table || ''),
                order: req.query.order ? String(req.query.order) : '',
                dir: String(req.query.dir || 'asc'),
                limit: req.query.limit,
                offset: req.query.offset,
                withRowid: true
            });
            // Production data, read by a person, on a machine that audits a
            // domain. Who looked at what is worth a line.
            console.log(`[Deploy] ${req.tenant.slug}: ${project.id} data read ` +
                `${req.params.file}/${page.table} by ${req.user.email}`);
            return res.json(Object.assign({ success: true, file: req.params.file }, page));
        } catch (e) {
            return dataError(res, e, 'page');
        }
    });

    /**
     * Modifier une cellule.
     *
     * Le rowid vient de la page que la console a lue un instant plus tot. Il
     * n'est pas devine : `page(withRowid)` ne le rend que pour une table qui en
     * a un, et la page n'offre l'edition que la ou il est arrive.
     */
    router.patch('/api/deploy/projects/:id/data/:file/rows', requireOptIn,
        requireRole('admin'), async (req, res) => {
            const writer = withWriter(res);
            if (!writer) return undefined;
            const project = projectOr404(req, res);
            if (!project) return undefined;

            let file;
            try {
                file = projectData.resolveFile(req.tenantPaths, project.id, req.params.file);
            } catch (e) {
                return dataError(res, e, 'resolveFile');
            }

            const body = req.body || {};
            try {
                const r = await writer.updateCell(file, {
                    table: String(body.table || ''),
                    rowid: body.rowid,
                    column: String(body.column || ''),
                    value: body.value === undefined ? null : body.value
                });
                console.log(`[Deploy] ${req.tenant.slug}: ${project.id} data write ` +
                    `${req.params.file}/${body.table} rowid=${body.rowid} ` +
                    `col=${body.column} by ${req.user.email}`);
                return res.json({ success: true, changes: r.changes });
            } catch (e) {
                return dataError(res, e, 'updateCell');
            }
        });

    /** Ajouter une ligne. Rend son rowid, que la grille reutilise sans recharger. */
    router.post('/api/deploy/projects/:id/data/:file/rows', requireOptIn,
        requireRole('admin'), async (req, res) => {
            const writer = withWriter(res);
            if (!writer) return undefined;
            const project = projectOr404(req, res);
            if (!project) return undefined;

            let file;
            try {
                file = projectData.resolveFile(req.tenantPaths, project.id, req.params.file);
            } catch (e) {
                return dataError(res, e, 'resolveFile');
            }

            const body = req.body || {};
            try {
                const r = await writer.insertRow(file, {
                    table: String(body.table || ''),
                    values: body.values || {}
                });
                console.log(`[Deploy] ${req.tenant.slug}: ${project.id} data insert ` +
                    `${req.params.file}/${body.table} rowid=${r.rowid} by ${req.user.email}`);
                return res.json({ success: true, rowid: r.rowid });
            } catch (e) {
                return dataError(res, e, 'insertRow');
            }
        });

    /** Supprimer une ligne. Une contrainte declaree par l'application la retient. */
    router.delete('/api/deploy/projects/:id/data/:file/rows', requireOptIn,
        requireRole('admin'), async (req, res) => {
            const writer = withWriter(res);
            if (!writer) return undefined;
            const project = projectOr404(req, res);
            if (!project) return undefined;

            let file;
            try {
                file = projectData.resolveFile(req.tenantPaths, project.id, req.params.file);
            } catch (e) {
                return dataError(res, e, 'resolveFile');
            }

            const body = req.body || {};
            try {
                const r = await writer.deleteRow(file, {
                    table: String(body.table || ''),
                    rowid: body.rowid
                });
                console.log(`[Deploy] ${req.tenant.slug}: ${project.id} data delete ` +
                    `${req.params.file}/${body.table} rowid=${body.rowid} by ${req.user.email}`);
                return res.json({ success: true, changes: r.changes });
            } catch (e) {
                return dataError(res, e, 'deleteRow');
            }
        });

    /** Ce que le registre de la base porte, pour l'onglet Migrations. */
    router.get('/api/deploy/projects/:id/data/:file/migrations', requireOptIn,
        requireRole('admin'), async (req, res) => {
            const writer = withWriter(res);
            if (!writer) return undefined;
            const project = projectOr404(req, res);
            if (!project) return undefined;

            let file;
            try {
                file = projectData.resolveFile(req.tenantPaths, project.id, req.params.file);
            } catch (e) {
                return dataError(res, e, 'resolveFile');
            }

            try {
                const applied = await writer.appliedMigrations(file);
                return res.json({
                    success: true,
                    applied,
                    dir: project.migrationsDir || migrations.DEFAULT_DIR
                });
            } catch (e) {
                return dataError(res, e, 'appliedMigrations');
            }
        });

    // --- Environment variables (tranche 1.1 of plan 0002) ----------------

    /**
     * The names a project's build will see, never the values.
     *
     * There is no route that reads a value back. See `projectEnv.js`: the
     * values are encrypted with the machine key and the only thing that
     * decrypts them is a build, for the length of that build.
     */
    router.get('/api/deploy/projects/:id/env', requireOptIn, (req, res) => {
        if (!projectStore.PROJECT_ID_RE.test(req.params.id || '')) {
            return res.status(404).json({ success: false, error: 'unknown_project' });
        }
        const project = projectStore.getProject(req.tenantPaths, req.params.id);
        if (!project) return res.status(404).json({ success: false, error: 'unknown_project' });
        return res.json({ success: true, env: projectEnv.list(project), builds: !!project.buildCmd });
    });

    /**
     * Sets or replaces variables, one batch at a time.
     *
     * Upsert and not replace-the-set: the form sends the rows it changed, and a
     * replace would delete a variable the operator never touched because their
     * page was open while somebody else added one.
     *
     * A project with no build command stores them and says so in
     * `builds: false`. Nothing reads them at serve time, because nothing at
     * serve time runs code -- that is tranche 4.
     */
    router.put('/api/deploy/projects/:id/env', requireOptIn, requireRole('admin'), (req, res) => {
        if (!projectStore.PROJECT_ID_RE.test(req.params.id || '')) {
            return res.status(404).json({ success: false, error: 'unknown_project' });
        }
        const project = projectStore.getProject(req.tenantPaths, req.params.id);
        if (!project) return res.status(404).json({ success: false, error: 'unknown_project' });

        const entries = Array.isArray((req.body || {}).entries) ? req.body.entries : null;
        if (!entries || !entries.length) {
            return res.status(400).json({ success: false, error: 'no_entries' });
        }

        let env;
        try {
            env = projectEnv.setMany(project, entries);
        } catch (e) {
            // Every refusal from projectEnv names what to change, so it is the
            // answer rather than a 500 with a generic message.
            return res.status(400).json({ success: false, error: e.code || 'bad_env', detail: e.message });
        }

        project.env = env;
        let stored;
        try {
            stored = projectStore.saveProject(req.tenantPaths, project);
        } catch (e) {
            console.error(`[Deploy] ${req.tenant.slug}: ${req.params.id} env write failed: ${e.message}`);
            return res.status(500).json({ success: false, error: 'env_write_failed' });
        }

        // Names only, and only the count of them: this line goes to a log file
        // that gets pasted into support threads.
        console.log(`[Deploy] ${req.tenant.slug}: ${stored.id} env set ${entries.map((e) => e.key).join(', ')} by ${req.user.email}`);
        return res.json({
            success: true,
            env: projectEnv.list(stored),
            // A variable changes nothing until the next build reads it, and an
            // operator who saved one and saw no change on the site is about to
            // file a bug.
            needsRedeploy: !!stored.buildCmd
        });
    });

    router.delete('/api/deploy/projects/:id/env/:key', requireOptIn, requireRole('admin'), (req, res) => {
        if (!projectStore.PROJECT_ID_RE.test(req.params.id || '')) {
            return res.status(404).json({ success: false, error: 'unknown_project' });
        }
        const project = projectStore.getProject(req.tenantPaths, req.params.id);
        if (!project) return res.status(404).json({ success: false, error: 'unknown_project' });

        const { env, removed } = projectEnv.remove(project, req.params.key);
        if (!removed) return res.status(404).json({ success: false, error: 'unknown_env_key' });

        project.env = env;
        let stored;
        try {
            stored = projectStore.saveProject(req.tenantPaths, project);
        } catch (e) {
            console.error(`[Deploy] ${req.tenant.slug}: ${req.params.id} env write failed: ${e.message}`);
            return res.status(500).json({ success: false, error: 'env_write_failed' });
        }

        console.log(`[Deploy] ${req.tenant.slug}: ${stored.id} env removed ${req.params.key} by ${req.user.email}`);
        return res.json({
            success: true,
            env: projectEnv.list(stored),
            needsRedeploy: !!stored.buildCmd
        });
    });

    /**
     * Puts a named release back on the port.
     *
     * The same three renames as Rollback, with the version chosen rather than
     * assumed. `sha` is refused before it reaches `path.join`: it names a folder,
     * and a project id already went through `PROJECT_ID_RE` for the same reason.
     *
     * The branch is left alone. `lastSeenSha` keeps pointing at the commit the
     * poller last saw, so promoting an older version does not read as a new
     * commit on the next tick, and the next real push still deploys forward.
     */
    router.post('/api/deploy/projects/:id/promote', requireOptIn, requireRole('admin'), async (req, res) => {
        if (!projectStore.PROJECT_ID_RE.test(req.params.id || '')) {
            return res.status(404).json({ success: false, error: 'unknown_project' });
        }
        const project = projectStore.getProject(req.tenantPaths, req.params.id);
        if (!project) return res.status(404).json({ success: false, error: 'unknown_project' });

        const sha = String((req.body || {}).sha || '');
        if (!/^[0-9a-f]{7,64}$|^unknown$/.test(sha)) {
            return res.status(400).json({ success: false, error: 'bad_release' });
        }

        const result = await promoteNow({
            slug: req.tenant.slug,
            tenantPaths: req.tenantPaths,
            project,
            sha,
            actor: req.user.email
        });
        if (!result.promoted) {
            return res.status(result.reason === 'busy' ? 409 : 400)
                .json({ success: false, error: result.reason });
        }

        const stored = projectStore.getProject(req.tenantPaths, req.params.id);
        // A project whose first deployment failed has no listener yet, and a
        // promote may be what finally gave it something to serve.
        startSiteFor({ slug: req.tenant.slug, tenantPaths: req.tenantPaths, project: stored });
        return res.json({
            success: true,
            project: Object.assign({}, stored, {
                url: siteUrl(req, stored),
                releases: releasesFor(req.tenantPaths, stored)
            })
        });
    });

    /**
     * Turns HTTPS on or off for one site.
     *
     * Separate from the protection route above even though the two belong to
     * the same story, because they fail differently. Protection is a flag the
     * site server reads per request; TLS is decided when the listener is
     * created, so changing it restarts the site, and a certificate that will
     * not load leaves the site down rather than half-applied.
     *
     * The paths are read by the backend process, so they are checked to be
     * absolute and nothing more: this route is admin-only, and the operator who
     * reaches it is the person who installed the certificate. Pointing it at a
     * file that is not a certificate stops the site; it discloses nothing,
     * because nothing on this path is ever sent to a browser.
     */
    router.post('/api/deploy/projects/:id/tls', requireOptIn, requireRole('admin'), async (req, res) => {
        if (!projectStore.PROJECT_ID_RE.test(req.params.id || '')) {
            return res.status(404).json({ success: false, error: 'unknown_project' });
        }
        const project = projectStore.getProject(req.tenantPaths, req.params.id);
        if (!project) return res.status(404).json({ success: false, error: 'unknown_project' });

        const body = req.body || {};
        if (typeof body.enabled !== 'boolean') {
            return res.status(400).json({ success: false, error: 'bad_enabled' });
        }

        let tls;
        if (body.enabled) {
            const certFile = parseCertPath(body.certFile);
            if (!certFile) return res.status(400).json({ success: false, error: 'bad_cert_path' });
            const keyFile = parseCertPath(body.keyFile);
            if (!keyFile) return res.status(400).json({ success: false, error: 'bad_key_path' });
            tls = { enabled: true, certFile, keyFile };
        } else {
            // Switching off keeps the paths, so turning it back on does not mean
            // typing them again. Only `enabled` decides whether they are used.
            tls = {
                enabled: false,
                certFile: parseCertPath(body.certFile) || (project.tls && project.tls.certFile) || '',
                keyFile: parseCertPath(body.keyFile) || (project.tls && project.tls.keyFile) || ''
            };
        }

        // Mutated on the record that was read, for the same reason as `auth`
        // above: `saveProject` replaces the row whole.
        project.tls = tls;

        let stored;
        try {
            stored = projectStore.saveProject(req.tenantPaths, project);
        } catch (e) {
            console.error(`[Deploy] ${req.tenant.slug}: ${req.params.id} TLS write failed: ${e.message}`);
            return res.status(500).json({ success: false, error: 'tls_write_failed' });
        }

        // The scheme changes under the sessions that were granted on the old
        // one, and a cookie minted without `Secure` should not carry over into
        // an encrypted site as if it had been.
        siteAuth.dropSessions(req.tenant.slug, stored.id);

        // Awaited: the new listener cannot bind until the old one has let the
        // port go, so answering before that would report a state that is not
        // reached yet, including the failure below.
        const server = await restartSiteFor({ slug: req.tenant.slug, tenantPaths: req.tenantPaths, project: stored });
        if (tls.enabled && !server) {
            // The record is saved and the site is down: that is the fail-closed
            // choice in `siteServer.startSiteFor`, and the operator has to know
            // it rather than discover it from a card that still says "live".
            console.error(`[Deploy] ${req.tenant.slug}: ${stored.id} HTTPS on but the certificate would not load; site is stopped`);
            return res.status(400).json({ success: false, error: 'tls_cert_unreadable', tls: tlsView(stored) });
        }

        console.log(`[Deploy] ${req.tenant.slug}: ${stored.id} HTTPS ${tls.enabled ? 'on' : 'off'}, by ${req.user.email}`);
        return res.json({ success: true, project: { id: stored.id, tls: tlsView(stored), url: siteUrl(req, stored) } });
    });

    // --- Directory authentication in front of served sites ----------------

    /**
     * The directory config and which sites are gated by it, in one call.
     *
     * Together because the page renders them as one panel: a site cannot be
     * protected without a directory, and a directory with no protected site is
     * the state the operator is about to leave.
     */
    router.get('/api/deploy/auth', requireOptIn, (req, res) => {
        const sites = projectStore.listProjects(req.tenantPaths).map((p) => ({
            id: p.id,
            name: p.name,
            protected: isProtectedRecord(p),
            method: methodOfProject(p),
            allowedGroups: groupsOf(p),
            // The panel warns next to a protected site that is served in clear:
            // that is where a password is about to be typed.
            tls: tlsView(p)
        }));
        res.json({
            success: true,
            ldap: ldapView(authStore.publicConfig(req.tenantPaths)),
            // The vocabulary, sent rather than hardcoded in the page, so a
            // method added to the backend appears in the selector without a
            // second edit in the frontend.
            methods: authMethods.METHODS,
            sites
        });
    });

    /**
     * What Aegis can work out about the directory on its own.
     *
     * Admin-only like the save below it, and for the same reason: the answer
     * names the audited domain, which is the shape of the customer's network.
     *
     * A suggestion, never a write. The page fills empty fields with it and
     * leaves anything already typed alone, so this route can be wrong without
     * costing the operator a correction.
     */
    router.get('/api/deploy/auth/suggest', requireOptIn, requireRole('admin'), async (req, res) => {
        let hint = null;
        try {
            hint = directoryHint.suggest(req.tenantPaths);
        } catch (e) {
            // A guess that cannot be made is not an error the operator has to
            // read. The form still works; they type the four fields.
            console.error(`[Deploy] ${req.tenant.slug}: directory hint failed: ${e.message}`);
        }

        // The domain name reaches a controller but is rarely the name on its
        // certificate, and that gap is the most common TLS failure on this
        // form. Asking DNS which host is a controller costs one query and
        // removes the whole class of problem before it is ever seen.
        if (hint && hint.domain) {
            try {
                const dc = await directoryHint.discoverController(hint.domain);
                if (dc) {
                    hint.fields.url = `ldaps://${dc.host}:${dc.port}`;
                    hint.controller = dc.host;
                    hint.controllerCount = dc.count;
                }
            } catch (e) {
                console.error(`[Deploy] ${req.tenant.slug}: controller lookup failed: ${e.message}`);
            }
        }
        return res.json({ success: true, suggest: hint });
    });

    /**
     * Saves the directory the site guard authenticates against.
     *
     * Nothing is tested before it is stored. A directory that is briefly down
     * should not stop an operator from correcting a typo in the base DN, and the
     * `test` route below is the deliberate way to find out whether it works.
     */
    router.post('/api/deploy/auth', requireOptIn, requireRole('admin'), (req, res) => {
        const body = req.body || {};
        const parsed = parseLdapBody(body);
        if (parsed.error) {
            return res.status(400).json({ success: false, error: parsed.error });
        }

        // Keep-existing semantics, the same contract the SMTP form uses: the key
        // absent, null, or still carrying the mask all mean "leave the stored
        // password alone", and only an explicit empty string clears it. This is
        // why the field cannot go through `String(... || '')` with the others --
        // that would turn "not sent" and "cleared" into the same value.
        // Not trimmed either: a trailing space can be part of a password.
        let bindPassword;
        if (Object.prototype.hasOwnProperty.call(body, 'bindPassword') && body.bindPassword !== null) {
            const supplied = String(body.bindPassword);
            if (supplied !== PASSWORD_MASK) bindPassword = supplied;
        }

        let stored;
        try {
            stored = authStore.writeConfig(
                req.tenantPaths,
                Object.assign({}, parsed.config, { bindPassword })
            );
        } catch (e) {
            // The message can name the path and the errno. It cannot name the
            // password, which is why only `e.message` travels.
            console.error(`[Deploy] ${req.tenant.slug}: directory config write failed: ${e.message}`);
            return res.status(500).json({ success: false, error: 'auth_write_failed' });
        }

        siteAuth.invalidate(req.tenant.slug, null);
        console.log(`[Deploy] ${req.tenant.slug}: directory config saved (${parsed.config.url}) by ${req.user.email}`);
        return res.json({ success: true, ldap: ldapView(stored) });
    });

    /**
     * Forgets the directory config.
     *
     * A project left marked protected is not un-marked here. That combination is
     * a site the guard refuses outright rather than one it serves in the clear,
     * so clearing the directory can never be the step that exposes something.
     */
    router.delete('/api/deploy/auth', requireOptIn, requireRole('admin'), (req, res) => {
        try {
            authStore.clearConfig(req.tenantPaths);
        } catch (e) {
            console.error(`[Deploy] ${req.tenant.slug}: directory config clear failed: ${e.message}`);
            return res.status(500).json({ success: false, error: 'auth_write_failed' });
        }
        siteAuth.invalidate(req.tenant.slug, null);
        // The sessions this directory granted outlive it otherwise: they carry
        // the groups read at login and are checked against no directory again.
        // Forgetting the annuaire has to close them or the control is only
        // half removed.
        siteAuth.dropSessions(req.tenant.slug, null);
        console.log(`[Deploy] ${req.tenant.slug}: directory config cleared by ${req.user.email}`);
        return res.json({ success: true });
    });

    /**
     * Proves the stored config against the real directory.
     *
     * With no username it binds the service account and stops there, which is the
     * question "can Aegis talk to this directory at all". With a username and a
     * password it authenticates that person and hands back their groups, because
     * the operator's next task is filling in a project's allowed groups and the
     * only values that will ever match are the ones the directory actually
     * returns. That password is used for one bind and then dropped: it is not
     * stored, not echoed, and not logged.
     *
     * Admin, though it writes nothing: it spends the service account's
     * credentials and reports a real person's group membership.
     */
    router.post('/api/deploy/auth/test', requireOptIn, requireRole('admin'), async (req, res) => {
        const config = authStore.readConfig(req.tenantPaths);
        if (!config) {
            return res.status(409).json({ success: false, error: 'ldap_not_configured' });
        }

        const username = String((req.body && req.body.username) || '').trim();
        const password = (req.body && typeof req.body.password === 'string') ? req.body.password : '';

        if (!username) {
            let result;
            try {
                result = await ldap.testConnection(config);
            } catch (e) {
                // `ldap.js` answers with a code rather than throwing, so this is
                // the unforeseen case only. It still has to leave as JSON: the
                // page refuses to parse anything else and would show "restart
                // the backend" for what is really an unreachable controller.
                console.error(`[Deploy] ${req.tenant.slug}: directory test threw: ${e.message}`);
                return res.status(502).json({ success: false, error: 'ldap_protocol_error' });
            }
            if (!result || !result.ok) {
                const code = (result && result.error) || 'ldap_protocol_error';
                console.warn(`[Deploy] ${req.tenant.slug}: directory service bind refused (${code})`);
                return res.status(LDAP_STATUS[code] || 502).json({ success: false, error: code });
            }
            console.log(`[Deploy] ${req.tenant.slug}: directory service bind tested by ${req.user.email}`);
            return res.json({ success: true, bound: true });
        }

        // Refused here rather than handed to `ldap.verify`, which would answer
        // `ldap_invalid_credentials` and make an empty field look like a wrong
        // password. Same closed door, a reason the page can act on.
        if (!password) {
            return res.status(400).json({ success: false, error: 'bad_test_credentials' });
        }

        let result;
        try {
            result = await ldap.verify(config, username, password);
        } catch (e) {
            // Same reason as above. The message is the library's, never the
            // credentials it was handed.
            console.error(`[Deploy] ${req.tenant.slug}: directory test threw: ${e.message}`);
            return res.status(502).json({ success: false, error: 'ldap_protocol_error' });
        }
        if (!result || !result.ok) {
            const code = (result && result.error) || 'ldap_protocol_error';
            // The username is the operator's own input and is already on screen.
            // The password is not named, not counted and not hinted at.
            console.warn(`[Deploy] ${req.tenant.slug}: directory test for ${username} refused (${code})`);
            return res.status(LDAP_STATUS[code] || 502).json({ success: false, error: code });
        }

        console.log(`[Deploy] ${req.tenant.slug}: directory test for ${username} succeeded, run by ${req.user.email}`);
        return res.json({
            success: true,
            bound: true,
            user: {
                dn: result.dn || '',
                displayName: result.displayName || '',
                groups: Array.isArray(result.groups) ? result.groups.slice(0, 256) : []
            }
        });
    });

    /**
     * Shows the certificate a controller presents, without validating it.
     *
     * This route exists because the alternative was worse. A TLS failure used
     * to end the conversation: the handshake dies before anything is shown, so
     * the operator was told to install an authority in Windows and restart
     * Aegis, or to untick certificate validation on the one connection that
     * carries the service account password. Neither is a decision anybody can
     * make without seeing what was rejected.
     *
     * The probe sends no BindRequest. It connects, reads the chain and closes,
     * so pointing it at a hostile host leaks nothing beyond the fact that Aegis
     * opened a socket, which the failed handshake already did.
     *
     * POST rather than GET because it makes this server open an outbound
     * connection, and admin-only for the same reason as the routes around it.
     */
    router.post('/api/deploy/auth/certificate', requireOptIn, requireRole('admin'), async (req, res) => {
        const config = authStore.readConfig(req.tenantPaths);
        if (!config) {
            return res.status(409).json({ success: false, error: 'ldap_not_configured' });
        }
        let result;
        try {
            result = await ldap.inspectCertificate(config);
        } catch (e) {
            console.error(`[Deploy] ${req.tenant.slug}: certificate probe threw: ${e.message}`);
            return res.status(502).json({ success: false, error: 'ldap_protocol_error' });
        }
        if (!result || !result.ok) {
            const code = (result && result.error) || 'ldap_protocol_error';
            return res.status(LDAP_STATUS[code] || 502).json({ success: false, error: code });
        }
        // The anchor's PEM stays on this side. The page needs to name the
        // authority and quote its fingerprint; it never needs the bytes, and
        // the trust route below reads them from the live connection anyway.
        const anchor = Object.assign({}, result.anchor);
        delete anchor.pem;
        console.log(`[Deploy] ${req.tenant.slug}: certificate of ${result.host} inspected by ${req.user.email}`);
        return res.json({
            success: true,
            certificate: {
                host: result.host,
                port: result.port,
                hostMatches: result.hostMatches,
                nameError: result.nameError,
                names: result.names,
                leaf: result.leaf,
                anchor,
                chainLength: result.chain.length
            }
        });
    });

    /**
     * Pins the authority the operator has just been shown.
     *
     * The fingerprint travels, the certificate does not. This re-opens the
     * connection, reads the chain again, and pins only if the anchor still
     * carries the fingerprint the operator confirmed. That closes the window
     * between looking and deciding: a controller swapped in between the two
     * answers `certificate_changed` rather than being trusted on a fingerprint
     * the browser could have been handed by anyone.
     *
     * What it buys: certificate validation stays on. A pinned authority is a
     * narrowing, one CA for one tenant's one directory, where unticking the
     * validation box is a widening to everything.
     */
    router.post('/api/deploy/auth/trust', requireOptIn, requireRole('admin'), async (req, res) => {
        const config = authStore.readConfig(req.tenantPaths);
        if (!config) {
            return res.status(409).json({ success: false, error: 'ldap_not_configured' });
        }
        const wanted = String((req.body && req.body.fingerprint256) || '').trim().toUpperCase();
        if (!FINGERPRINT_RE.test(wanted)) {
            return res.status(400).json({ success: false, error: 'bad_fingerprint' });
        }

        let result;
        try {
            result = await ldap.inspectCertificate(config);
        } catch (e) {
            console.error(`[Deploy] ${req.tenant.slug}: certificate probe threw: ${e.message}`);
            return res.status(502).json({ success: false, error: 'ldap_protocol_error' });
        }
        if (!result || !result.ok) {
            const code = (result && result.error) || 'ldap_protocol_error';
            return res.status(LDAP_STATUS[code] || 502).json({ success: false, error: code });
        }
        const anchor = result.anchor || {};
        if (String(anchor.fingerprint256 || '').toUpperCase() !== wanted || !anchor.pem) {
            console.warn(`[Deploy] ${req.tenant.slug}: refused to pin, the controller presents a different authority now`);
            return res.status(409).json({ success: false, error: 'certificate_changed' });
        }

        let stored;
        try {
            stored = authStore.trustAuthority(req.tenantPaths, anchor.pem);
        } catch (e) {
            console.error(`[Deploy] ${req.tenant.slug}: pinning the authority failed: ${e.message}`);
            return res.status(500).json({ success: false, error: 'auth_write_failed' });
        }
        if (!stored) return res.status(400).json({ success: false, error: 'bad_certificate' });

        siteAuth.invalidate(req.tenant.slug, null);
        console.log(`[Deploy] ${req.tenant.slug}: authority ${anchor.subject} pinned (${wanted}) by ${req.user.email}`);
        return res.json({ success: true, ldap: ldapView(stored) });
    });

    /**
     * Un-pins every authority, leaving the machine trust store on its own.
     *
     * Separate from forgetting the directory: an operator undoing a mistaken
     * pin should not also lose the address, the base DN and the service
     * account they typed.
     */
    router.delete('/api/deploy/auth/trust', requireOptIn, requireRole('admin'), (req, res) => {
        let stored;
        try {
            stored = authStore.forgetAuthorities(req.tenantPaths);
        } catch (e) {
            console.error(`[Deploy] ${req.tenant.slug}: un-pinning failed: ${e.message}`);
            return res.status(500).json({ success: false, error: 'auth_write_failed' });
        }
        siteAuth.invalidate(req.tenant.slug, null);
        console.log(`[Deploy] ${req.tenant.slug}: pinned authorities removed by ${req.user.email}`);
        return res.json({ success: true, ldap: ldapView(stored) });
    });

    /**
     * Picks the method that guards one site, and says who may through it.
     *
     * An empty `allowedGroups` on a gated site means every account the
     * directory authenticates, which is a real configuration on a small install
     * and not a mistake worth refusing.
     *
     * Two shapes of body are accepted. `method` is the one the page sends and
     * the only one that can name a choice; `enabled`, a boolean, is what this
     * route took before the selector existed and still works, because a script
     * or a bookmarked call written against it should not break on an upgrade.
     * A body carrying both is read by `method`: it is the more specific of the
     * two, and refusing the pair would only send the caller round again.
     */
    router.post('/api/deploy/projects/:id/auth', requireOptIn, requireRole('admin'), (req, res) => {
        if (!projectStore.PROJECT_ID_RE.test(req.params.id || '')) {
            return res.status(404).json({ success: false, error: 'unknown_project' });
        }
        const project = projectStore.getProject(req.tenantPaths, req.params.id);
        if (!project) return res.status(404).json({ success: false, error: 'unknown_project' });

        const body = req.body || {};

        // Whitelisted against the vocabulary, never stored as sent: the value
        // ends up in a file the site guard reads on every request, and a method
        // it has no handler for turns that site into a 503 nobody asked for.
        let method;
        if (body.method !== undefined && body.method !== null) {
            if (typeof body.method !== 'string' || !authMethods.isKnown(body.method)) {
                return res.status(400).json({ success: false, error: 'bad_auth_method' });
            }
            method = body.method;
        } else if (typeof body.enabled === 'boolean') {
            // The pre-selector body. True meant the directory, and still does.
            method = body.enabled ? authMethods.LDAP : authMethods.NONE;
        } else {
            // A strict boolean, not a truthiness test: a value this route did
            // not expect must not quietly resolve to "unprotected".
            return res.status(400).json({ success: false, error: 'bad_enabled' });
        }

        const allowedGroups = parseAllowedGroups(body.allowedGroups);
        if (!allowedGroups) {
            return res.status(400).json({ success: false, error: 'bad_allowed_groups' });
        }

        // Mutated on the record that was read, not rebuilt from the body:
        // `saveProject` replaces the row whole, so a fresh object would drop
        // every field this route does not know about -- installationId, port,
        // history, lastSha.
        project.auth = authMethods.record(method, allowedGroups);

        let stored;
        try {
            stored = projectStore.saveProject(req.tenantPaths, project);
        } catch (e) {
            console.error(`[Deploy] ${req.tenant.slug}: ${req.params.id} protection write failed: ${e.message}`);
            return res.status(500).json({ success: false, error: 'auth_write_failed' });
        }

        siteAuth.invalidate(req.tenant.slug, stored.id);
        // Live sessions carry the group list they were granted with, and the
        // background re-check runs on a timer. Narrowing the allow list or
        // switching protection off should mean what it says now, not at the
        // next interval, so the sessions go.
        siteAuth.dropSessions(req.tenant.slug, stored.id);

        // And the same for the branches deployed alongside it. A preview holds
        // its own copy of the rule so the guard can read one record per
        // request; that copy is only correct if it follows the parent's.
        for (const preview of previews.listFor(req.tenantPaths, stored.id)) {
            preview.auth = authMethods.record(method, allowedGroups);
            projectStore.saveProject(req.tenantPaths, preview);
            siteAuth.invalidate(req.tenant.slug, preview.id);
            siteAuth.dropSessions(req.tenant.slug, preview.id);
        }
        console.log(`[Deploy] ${req.tenant.slug}: ${stored.id} authentication ${method}, ${allowedGroups.length} group(s) allowed, by ${req.user.email}`);
        return res.json({
            success: true,
            project: {
                id: stored.id,
                protected: isProtectedRecord(stored),
                method: methodOfProject(stored),
                allowedGroups: groupsOf(stored)
            }
        });
    });
}

module.exports = { register, registerPublic };
