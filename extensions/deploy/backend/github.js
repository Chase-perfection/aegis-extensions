/**
 * GitHub App authentication and the handful of API calls phase 1 needs.
 *
 * Why a GitHub App and not a personal access token: a token belongs to a person
 * and carries their whole account. An App installation is scoped to the
 * repositories the tenant picked, the credential it issues expires in an hour,
 * and the tenant can revoke it from GitHub without anyone touching Aegis.
 *
 * Why the App is registered per install rather than shipped with Aegis: an
 * App's callback URL is fixed, and every Aegis install has a different
 * hostname. GitHub's manifest flow exists for exactly this case. The operator
 * clicks once, GitHub hands back the credentials, and they never leave the
 * machine.
 *
 * No new dependency. Node's crypto signs RS256 directly and Node 20 has global
 * fetch, so the JWT and the HTTP calls are both first-party.
 */

'use strict';

const crypto = require('crypto');

const API = 'https://api.github.com';
const UA = 'Aegis-Deploy';

/** Requests hang rather than fail when a firewall blackholes them. */
const TIMEOUT_MS = 15000;

function b64url(input) {
    return Buffer.from(input).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A short-lived App JWT, signed with the App's private key.
 *
 * `iat` is backdated 60 seconds because GitHub rejects a token whose issue time
 * is in the future, and a server clock a few seconds fast is common enough to
 * be worth absorbing. Expiry is 9 minutes; GitHub's ceiling is 10.
 */
function appJwt(appId, privateKey) {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    return `${header}.${payload}.${b64url(signer.sign(privateKey))}`;
}

/**
 * One HTTP call to GitHub.
 *
 * Throws an Error carrying the status, because every caller here reports the
 * same way and the distinction that matters to a reader is 401 (our credential)
 * against 404 (their repository) against a timeout (their firewall).
 */
async function ghFetch(pathOrUrl, { token, tokenType = 'Bearer', method = 'GET', body, etag } = {}) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method,
            signal: ctrl.signal,
            headers: Object.assign({
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': UA
            }, token ? { Authorization: `${tokenType} ${token}` } : {},
                body ? { 'Content-Type': 'application/json' } : {},
                // A conditional request GitHub answers 304 costs nothing against
                // the hourly rate limit, which is what makes a 20 second poll
                // affordable on every project at once.
                etag ? { 'If-None-Match': etag } : {}),
            body: body ? JSON.stringify(body) : undefined
        });

        // Only reachable when the caller asked for a conditional request, so no
        // existing caller can be handed this shape by surprise.
        if (res.status === 304) return { notModified: true, etag, body: null };

        const text = await res.text();
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON error body */ }
        if (!res.ok) {
            const err = new Error(`GitHub ${method} ${url} answered ${res.status}`);
            err.status = res.status;
            err.body = parsed;
            throw err;
        }
        if (etag !== undefined) {
            return { notModified: false, etag: res.headers.get('etag') || null, body: parsed };
        }
        return parsed;
    } catch (e) {
        if (e.name === 'AbortError') {
            const err = new Error(`GitHub request timed out after ${TIMEOUT_MS}ms`);
            err.status = 504;
            throw err;
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Exchanges the temporary code from the manifest redirect for the App's
 * credentials. One shot: the code is single-use and expires in an hour.
 */
async function exchangeManifestCode(code) {
    const r = await ghFetch(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST' });
    return {
        appId: r.id,
        slug: r.slug,
        clientId: r.client_id,
        clientSecret: r.client_secret,
        privateKey: r.pem,
        webhookSecret: r.webhook_secret,
        htmlUrl: r.html_url
    };
}

/**
 * Installation tokens, cached until shortly before they expire.
 *
 * GitHub issues these for an hour. Re-minting one per API call would spend a
 * JWT signature and a round trip on every repository list, and the token is
 * held in memory either way.
 */
const tokenCache = new Map();

async function installationToken(app, installationId) {
    const hit = tokenCache.get(installationId);
    // 5 minute margin, so a token cannot expire between this check and its use.
    if (hit && hit.expiresAt - Date.now() > 5 * 60 * 1000) return hit.token;

    const jwt = appJwt(app.appId, app.privateKey);
    const r = await ghFetch(`/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
        token: jwt, method: 'POST'
    });
    tokenCache.set(installationId, { token: r.token, expiresAt: new Date(r.expires_at).getTime() });
    return r.token;
}

/** Drops a cached token. Call after a 401, so the next attempt re-mints. */
function forgetInstallationToken(installationId) {
    tokenCache.delete(installationId);
}

/** Every account that installed this App. Authenticated as the App itself. */
async function listInstallations(app) {
    const rows = await ghFetch('/app/installations?per_page=100', { token: appJwt(app.appId, app.privateKey) });
    return (rows || []).map((i) => ({
        installationId: i.id,
        accountLogin: i.account && i.account.login,
        accountType: i.account && i.account.type,
        repositorySelection: i.repository_selection
    }));
}

/**
 * Repositories one installation can see.
 *
 * Paged to the App's limit and capped at 10 pages. An account with more than a
 * thousand selected repositories is picking from a search box, not a list, and
 * that search belongs in phase 2 rather than an unbounded loop here.
 */
async function listRepos(app, installationId) {
    const token = await installationToken(app, installationId);
    const out = [];
    for (let page = 1; page <= 10; page++) {
        const r = await ghFetch(`/installation/repositories?per_page=100&page=${page}`, { token });
        const batch = (r && r.repositories) || [];
        for (const repo of batch) {
            out.push({
                id: repo.id,
                fullName: repo.full_name,
                private: repo.private,
                defaultBranch: repo.default_branch,
                updatedAt: repo.updated_at
            });
        }
        if (batch.length < 100) break;
    }
    return out;
}

/**
 * The branches of one repository.
 *
 * Alphabetical, which is what GitHub returns and what the picker shows. Sorting
 * by last commit would cost one call per branch, and the field this feeds keeps
 * accepting a typed name, so the list is a convenience and not the only way in.
 *
 * `installationId` may be null: a public repository is read without
 * credentials, the same way `publicRepoInfo` does it, because a project can be
 * created on one before any App exists.
 *
 * Paged to 100 and capped at five pages, same reasoning as `listRepos`: a
 * repository with five hundred open branches is picked from the search box
 * above the list, not scrolled.
 */
async function listBranches(app, installationId, repoFullName) {
    const token = installationId ? await installationToken(app, installationId) : null;
    const out = [];
    for (let page = 1; page <= 5; page++) {
        const batch = await ghFetch(
            `/repos/${repoFullName}/branches?per_page=100&page=${page}`, { token });
        const rows = Array.isArray(batch) ? batch : [];
        for (const b of rows) {
            out.push({
                name: b.name,
                sha: (b.commit && b.commit.sha) || null,
                protected: !!b.protected
            });
        }
        if (rows.length < 100) break;
    }
    return out;
}

/**
 * The manifest posted to github.com/settings/apps/new.
 *
 * Permissions are the minimum the plan's flow needs: read the code to clone it,
 * read metadata to list repositories and branches. No write access to code, no
 * issues, no organisation scopes. `push` is the only event subscribed.
 *
 * `webhookUrl` is mandatory, which two failed registrations taught us. A
 * localhost URL is refused with "Hook url is not supported because it isn't
 * reachable over the public Internet", and that check runs even for
 * `active: false`. Omitting `hook_attributes` is refused with "Hook url cannot
 * be blank", though the reference documents the object as optional. So the
 * manifest flow needs a public HTTPS address, and an install without one cannot
 * register this way at all. Throwing here keeps that fact at the boundary
 * rather than in a GitHub error page the operator has to interpret.
 */
function buildManifest({ name, baseUrl, webhookUrl, redirectUrl }) {
    if (!webhookUrl) throw new Error('buildManifest needs a public webhookUrl');
    return {
        name,
        url: baseUrl,
        redirect_url: redirectUrl,
        hook_attributes: { url: webhookUrl, active: true },
        public: false,
        default_permissions: { contents: 'read', metadata: 'read' },
        default_events: ['push']
    };
}

/**
 * `owner/repo` from anything an operator is likely to paste.
 *
 * Accepts the address bar, the clone URL, the SSH remote, and the bare
 * `owner/repo`. Returns null for anything else rather than guessing, because a
 * wrong guess becomes a clone attempt against a repository that is not theirs.
 *
 * `.git` and a trailing slash are stripped, and so is any path past the
 * repository name, so pasting a URL from a file view or a pull request works.
 */
function parseRepoUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;

    let owner, repo;
    const ssh = raw.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    if (ssh) {
        [, owner, repo] = ssh;
    } else if (/^https?:\/\//i.test(raw)) {
        let u;
        try { u = new URL(raw); } catch (_) { return null; }
        if (u.hostname.toLowerCase() !== 'github.com') return null;
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length < 2) return null;
        [owner, repo] = parts;
        repo = repo.replace(/\.git$/i, '');
    } else {
        const bare = raw.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/);
        if (!bare) return null;
        [, owner, repo] = bare;
    }

    const ok = /^[A-Za-z0-9._-]+$/;
    if (!ok.test(owner || '') || !ok.test(repo || '')) return null;
    // A path segment of `.` or `..` would travel into a URL path.
    if ([owner, repo].some((s) => s === '.' || s === '..')) return null;
    return { owner, repo, fullName: `${owner}/${repo}` };
}

/**
 * The installation that can see this repository, or null when none can.
 *
 * Replaces asking the operator which account to use: GitHub already knows, and
 * the answer is one call. Null covers both "the App is installed nowhere" and
 * "installed, but not on this repository", which are the same problem from the
 * operator's side and have the same fix.
 *
 * A public repository needs no installation at all, so null is not a failure by
 * itself. The caller falls back to an anonymous clone.
 */
async function installationForRepo(app, fullName) {
    try {
        const r = await ghFetch(`/repos/${fullName}/installation`, { token: appJwt(app.appId, app.privateKey) });
        return r && r.id ? String(r.id) : null;
    } catch (e) {
        if (e.status === 404) return null;
        throw e;
    }
}

/**
 * The default branch, for a repository Aegis can see without an installation.
 *
 * Used when a public repository is being deployed anonymously and the operator
 * gave no branch. Unauthenticated calls are rate limited by IP, which is fine
 * for one call per project creation.
 */
async function publicRepoInfo(fullName) {
    const r = await ghFetch(`/repos/${fullName}`);
    return { defaultBranch: (r && r.default_branch) || null, private: !!(r && r.private) };
}

/**
 * The head commit of one branch, or `null` when GitHub says it has not moved.
 *
 * `etag` is the value from the previous call, stored on the project. Passing it
 * turns this into a conditional request: unchanged branches answer 304 with an
 * empty body and no rate-limit cost, which is the whole reason polling every
 * project on a short interval is affordable.
 *
 * A branch that has been deleted answers 404, and that error carries the status
 * so the caller can tell "gone" from "GitHub is down".
 */
async function branchHead(app, installationId, repoFullName, branch, etag) {
    // No installation means a public repository, polled without credentials.
    const token = installationId ? await installationToken(app, installationId) : null;
    const r = await ghFetch(
        `/repos/${repoFullName}/branches/${encodeURIComponent(branch)}`,
        { token, etag: etag || null }
    );
    if (r.notModified) return { sha: null, etag: etag || null, moved: false };
    return {
        sha: (r.body && r.body.commit && r.body.commit.sha) || null,
        etag: r.etag,
        moved: true
    };
}

/**
 * Confirms an App id and a private key belong to each other, and to a real App.
 *
 * The manifest flow never needs this: GitHub hands over credentials that are
 * correct by construction. Manual registration has no such guarantee, and an
 * operator who pastes the wrong half of a key pair should hear it now rather
 * than at the first clone. `GET /app` is the cheapest call that proves the JWT
 * signs, the id matches the key, and the App still exists.
 *
 * `appJwt` throws on a key Node cannot parse, which is the common paste error,
 * so that failure arrives before any network call.
 */
async function verifyAppCredentials(appId, privateKey) {
    const app = await ghFetch('/app', { token: appJwt(appId, privateKey) });
    if (!app || String(app.id) !== String(appId)) {
        const err = new Error('the private key belongs to a different App');
        err.status = 409;
        throw err;
    }
    return { appId: String(app.id), slug: app.slug || null, htmlUrl: app.html_url || null };
}

module.exports = {
    appJwt, ghFetch, exchangeManifestCode, verifyAppCredentials, branchHead,
    parseRepoUrl, installationForRepo, publicRepoInfo,
    installationToken, forgetInstallationToken,
    listInstallations, listRepos, listBranches,
    buildManifest
};
