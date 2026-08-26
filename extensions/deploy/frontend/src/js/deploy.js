/**
 * Deploy page.
 *
 * One document, several panes, and the hash decides which one is on screen.
 * There is no router library and no build step here, so `location.hash` and the
 * `hashchange` event do the whole job: `#projects`, `#new`, `#github`, `#auth`,
 * `#refusals`, `#runs`, plus `#project/<id>` and `#run/<id>` for the two views
 * that address one thing. The back button works because the browser's own
 * history is what is being used.
 *
 * The rail on the left is Deploy's; the bar on top is the platform's. The gear
 * menu that used to fold setup away is gone: the rail reaches every pane
 * directly, and a menu duplicating it would be a second way to say the same
 * thing.
 */

(function () {
    'use strict';

    var readinessEl, listEl, errorEl;

    function tr(key, fallback) {
        var v = (typeof t === 'function') ? t(key) : null;
        return v && v !== key ? v : fallback;
    }

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }

    var NS = 'http://www.w3.org/2000/svg';

    /**
     * An icon, drawn rather than written.
     *
     * `el()` cannot build these: an SVG child created with createElement lands
     * in the HTML namespace and renders as nothing. A glyph or an emoji would
     * have been shorter and is ruled out by the house style.
     */
    function icon(paths, options) {
        var svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', (options && options.width) || '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        paths.forEach(function (d) {
            var p = document.createElementNS(NS, 'path');
            p.setAttribute('d', d);
            svg.appendChild(p);
        });
        return svg;
    }

    function lockIcon() {
        var svg = icon(['M8 11V7a4 4 0 0 1 8 0v4']);
        var body = document.createElementNS(NS, 'rect');
        body.setAttribute('x', '4');
        body.setAttribute('y', '11');
        body.setAttribute('width', '16');
        body.setAttribute('height', '10');
        body.setAttribute('rx', '2');
        svg.insertBefore(body, svg.firstChild);
        return svg;
    }

    /** A bin, for the one control on this page that destroys something. */
    function binIcon() {
        return icon([
            'M3 6h18',
            'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
            'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'
        ]);
    }

    function showError(detail) {
        if (!errorEl) return;
        errorEl.textContent = tr('deploy_load_failed', 'Could not load the deploy status. Reload the page.');
        errorEl.hidden = false;
        console.error('[Deploy] status load failed:', detail);
    }

    /** Whether this session may deploy. Set by `loadMe`, read by every button. */
    var isAdmin = false;

    /** The registered App, from the status call. Read when linking to GitHub. */
    var appInfo = null;

    /** The last project list the server sent, so a pane can repaint without refetching. */
    var projects = [];

    // --- Panes and the hash -----------------------------------------------

    var PANES = ['projects', 'new', 'console', 'project', 'runs', 'env', 'domains', 'usage', 'github', 'auth', 'refusals'];

    /** Which rail entry lights up for a pane that has no entry of its own. */
    var RAIL_FOR = { console: 'runs', project: 'projects', new: 'projects' };

    function paneEl(name) {
        return document.querySelector('.dep-pane[data-pane="' + name + '"]');
    }

    /**
     * `#project/site-a/env` -> `{ name: 'project', arg: 'site-a', sub: 'env' }`.
     *
     * Three segments at most, and the third only means anything to the project
     * page. A run id can contain no slash (`RUN_ID_RE`) and a project id can
     * contain no slash either (`PROJECT_ID_RE`), so splitting on the second one
     * cannot cut an id in half.
     */
    function readHash() {
        var raw = (window.location.hash || '').replace(/^#/, '');
        var cut = raw.indexOf('/');
        var name = cut === -1 ? raw : raw.slice(0, cut);
        var rest = cut === -1 ? '' : raw.slice(cut + 1);
        var split = rest.indexOf('/');
        var arg = split === -1 ? rest : rest.slice(0, split);
        var sub = split === -1 ? '' : rest.slice(split + 1);
        return {
            name: PANES.indexOf(name) === -1 ? 'projects' : name,
            arg: decodeURIComponent(arg),
            sub: decodeURIComponent(sub)
        };
    }

    function showPane(name) {
        PANES.forEach(function (p) {
            var node = paneEl(p);
            if (node) node.hidden = p !== name;
        });
        var lit = RAIL_FOR[name] || name;
        var links = document.querySelectorAll('.dep-side-link');
        for (var i = 0; i < links.length; i++) {
            links[i].classList.toggle('is-current', links[i].getAttribute('data-pane') === lit);
        }
        // A pane the reader arrives at from the bottom of a long one should
        // start at its own top.
        var scroller = document.querySelector('.main-content');
        if (scroller) scroller.scrollTop = 0;
    }

    /**
     * Reads the hash and paints whatever it names.
     *
     * Every pane except the two addressed ones is already in the document, so
     * routing is mostly showing and hiding. The addressed ones fetch first,
     * because the id in the hash may be one this session has never loaded: a
     * link pasted from a colleague, or a reload of the console.
     */
    function route() {
        var at = readHash();
        showPane(at.name);
        stopRunPolling();

        if (at.name === 'console') return openConsole(at.arg);
        if (at.name === 'project') return renderDetail(at.arg, at.sub);
        if (at.name === 'runs') return loadRuns();
        if (at.name === 'env') return renderEnvPane();
        if (at.name === 'domains') return renderDomainsPane();
        if (at.name === 'usage') return renderUsagePane();
        if (at.name === 'auth' && !authLoaded) return loadAuth();
        if (at.name === 'refusals') return renderRefusals();
        return undefined;
    }

    function goTo(hash) {
        if (window.location.hash === '#' + hash) return route();
        window.location.hash = hash;
        return undefined;
    }

    // --- Small shared pieces ----------------------------------------------

    // An unknown API path falls through to the SPA and answers 200 text/html,
    // so the content-type gets checked before parsing. Every deploy route
    // answers JSON, including its refusals (503 not enabled, 409 not
    // connected), so the body is always parsed and the caller reads `success`.
    // A non-JSON body means the request never reached the extension, and the
    // usual cause is a backend not restarted since the route was added.
    function readJson(r, path) {
        var type = r.headers.get('content-type') || '';
        if (type.indexOf('application/json') === -1) {
            throw new Error(path + ' answered ' + r.status + ' ' +
                (type || 'no content-type') + ' instead of JSON. Restart the backend.');
        }
        return r.json();
    }

    /** A relative time in words. Both consoles and cards ask the same question. */
    function ago(at) {
        if (!at) return '';
        var mins = Math.floor((Date.now() - at) / 60000);
        if (mins < 1) return tr('deploy_ago_now', 'moments ago');
        if (mins < 60) return tr('deploy_ago_mins', '$1 min ago').replace('$1', mins);
        var hours = Math.floor(mins / 60);
        if (hours < 24) return tr('deploy_ago_hours', '$1 h ago').replace('$1', hours);
        return tr('deploy_ago_days', '$1 d ago').replace('$1', Math.floor(hours / 24));
    }

    /** mm:ss. A build is read in seconds, and a clock time makes the reader subtract. */
    function elapsed(from, to) {
        var secs = Math.max(0, Math.floor(((to || Date.now()) - from) / 1000));
        var mins = Math.floor(secs / 60);
        return String(mins).padStart(2, '0') + ':' + String(secs % 60).padStart(2, '0');
    }

    function clock(ms) {
        return (ms / 1000).toFixed(1) + ' s';
    }

    function pill(kind, label) {
        return el('span', 'dep-pill is-' + kind, label);
    }

    /**
     * One label/value row, appended to `container` when there is a value to
     * show. `value` is a string (wrapped in a `dep-meta-value` span, and
     * skipped when falsy) or an already-built node (appended as-is, never
     * skipped: the caller decided it belongs, e.g. a link or a pill).
     */
    function metaRow(container, rowClass, key, value) {
        if (!value) return;
        var r = el('div', rowClass);
        r.appendChild(el('span', 'dep-meta-key', key));
        r.appendChild(value.nodeType ? value : el('span', 'dep-meta-value', value));
        container.appendChild(r);
    }

    /**
     * The state of a project, as one word.
     *
     * A project that published something and later failed is still live: the
     * previous version is on the port, and the failure is about the last
     * attempt. Saying "failed" there would send the operator looking for a site
     * that is down when it is not.
     */
    function projectState(p) {
        if (runningFor(p.id)) return 'running';
        // Published, and the port never opened. Another program holds it, or the
        // certificate of an HTTPS site could not be read. Saying Live here is
        // what sent an operator to debug a site that was never listening.
        if (p.lastSha && p.serving === false) return 'down';
        if (p.lastSha) return 'live';
        if (p.lastError) return 'failed';
        return 'idle';
    }

    function stateLabel(state) {
        if (state === 'live') return tr('deploy_state_live', 'Live');
        if (state === 'running') return tr('deploy_state_building', 'Building');
        if (state === 'failed') return tr('deploy_state_failed', 'Failed');
        if (state === 'down') return tr('deploy_state_down', 'Port closed');
        return tr('deploy_state_idle', 'Not published');
    }

    /**
     * The card's thumbnail: what a visitor sees first on that site.
     *
     * The backend photographs the page after every deployment, promote and
     * rollback (`shots.js`), so this only has to decide whether there is a
     * picture yet. There is not, for a site that has never published, on a host
     * with no Chromium, and for the moment between a deploy finishing and the
     * capture behind it completing — all of which keep the neutral plate.
     *
     * `deployedAt` rides along as the query so a redeployed site shows its new
     * first screen. The file is replaced in place, so without it the browser
     * would keep serving its copy of the release that is no longer on the port.
     *
     * This used to paint a gradient seeded from the project name — two dark
     * stops at 22% and 12% lightness — drawn for the near-black skin this page
     * used to wear.
     */
    function artFor(project) {
        var art = el('div', 'dep-card-art');
        if (!project || !project.hasPreview) return art;

        var img = document.createElement('img');
        img.className = 'dep-card-shot';
        img.alt = '';
        // Decorative: the project name is right below it, so a screen reader
        // announcing "screenshot of X" would say the name twice.
        img.setAttribute('aria-hidden', 'true');
        img.loading = 'lazy';
        img.src = window.tenantPrefix() + '/api/deploy/projects/' +
            encodeURIComponent(project.id) + '/preview.png?v=' + (project.deployedAt || 0);
        // A capture deleted by hand, or a 404 racing a fresh project, leaves
        // the plate rather than a broken-image glyph.
        img.addEventListener('error', function () { img.remove(); });
        art.appendChild(img);
        return art;
    }

    // --- Readiness ---------------------------------------------------------

    /**
     * One readiness row: a state, a sentence, what to run, and a footnote.
     *
     * `fix` takes a string or an array of them, and each entry renders as its
     * own chip. The reader of this page often has no shell on the host and
     * forwards these lines to whoever does, so a chip holds one command they
     * can copy whole. Naming only the variable, as this row used to, left them
     * to guess the shell, the elevation and the restart.
     */
    function row(state, label, detail, fix, note) {
        var wrap = el('div', 'dep-row dep-' + state);
        wrap.appendChild(el('span', 'dep-dot', ''));
        var body = el('div', 'dep-row-body');
        body.appendChild(el('span', 'dep-row-label', label));
        if (detail) body.appendChild(el('span', 'dep-row-detail', detail));
        var fixes = Array.isArray(fix) ? fix : (fix ? [fix] : []);
        for (var i = 0; i < fixes.length; i++) {
            body.appendChild(el('code', 'dep-row-fix', fixes[i]));
        }
        if (note) body.appendChild(el('span', 'dep-row-note', note));
        wrap.appendChild(body);
        return wrap;
    }

    function renderReadiness(s) {
        readinessEl.textContent = '';

        if (!s.enabled) {
            readinessEl.appendChild(row(
                'blocked',
                tr('deploy_off_label', 'Deploy is switched off on this server'),
                tr('deploy_off_detail', 'Building a repository runs its code on this machine, so only an administrator on the host can turn it on.')
                    + ' '
                    + tr('deploy_off_how', 'Install Deploy from the extension store, then restart the Aegis service and reload this page. There is nothing to tick: the install grants the host opt-in, because choosing to install the extension is the permission. Setting the variable by hand does not work: Windows caches a service environment at boot, so setx would only take effect after a reboot.'),
                // No command line. The installer stages no extensions at all, so
                // re-running it grants nothing; what grants the opt-in is the
                // store install, which writes the service's own environment and
                // asks for a restart. Nothing here for an operator to type.
                [],
                tr('deploy_off_dev', 'scripts/start-dashboard.ps1 switches Deploy on for its own window, so it needs none of the above. If you started the dashboard that way and are still reading this, AEGIS_DEPLOY_ENABLED is set to something other than "1" in that window: clear it, or set it to "1".')
            ));
            return false;
        }
        readinessEl.appendChild(row(
            'ok',
            tr('deploy_on_label', 'Deploy is enabled on this server'),
            '', ''
        ));

        if (s.github && s.github.connected) {
            readinessEl.appendChild(row(
                'ok',
                tr('deploy_gh_label', 'GitHub App registered'),
                s.github.slug || ('app ' + s.github.appId),
                ''
            ));
        } else {
            readinessEl.appendChild(row(
                'todo',
                tr('deploy_gh_missing_label', 'No GitHub App yet'),
                tr('deploy_gh_missing_detail', 'Aegis registers its own GitHub App so it never holds a personal access token. Registration lands in phase 1.'),
                ''
            ));
        }

        if (s.detection === 'webhook') {
            readinessEl.appendChild(row(
                'ok',
                tr('deploy_webhook_label', 'GitHub can reach this server'),
                tr('deploy_webhook_detail', 'A push is picked up in a second or two.'),
                s.webhookUrl || ''
            ));
        } else if (s.github && s.github.connected) {
            // The App is already registered, so the manual form below is gone and
            // pointing at it would send the operator looking for nothing. Polling
            // is a supported detection path, not an unfinished step: green dot.
            readinessEl.appendChild(row(
                'ok',
                tr('deploy_poll_ok_label', 'Pushes picked up by polling'),
                tr('deploy_poll_ok_detail', 'GitHub cannot reach this server, so Aegis checks the branch every 20 seconds. Cloning goes over outbound HTTPS. Nothing to set up here.'),
                ''
            ));
        } else {
            readinessEl.appendChild(row(
                'todo',
                tr('deploy_poll_label', 'GitHub cannot reach this server'),
                tr('deploy_poll_detail', 'Pushes get picked up by polling the branch instead of by webhook. Registering the App one click at a time needs an address GitHub can reach, so on this server you register it by hand below. Cloning works either way, over outbound HTTPS.'),
                ''
            ));
        }
        return true;
    }

    // --- GitHub connection ------------------------------------------------

    /**
     * Submits the manifest to GitHub as a real form POST.
     *
     * GitHub reads the App manifest from a form field, not from a JSON body or
     * a query string, so this builds a form and submits it. That also means the
     * operator leaves Aegis and comes back through the redirect, which is the
     * point: the App is created under their account, with their confirmation.
     */
    function submitManifest(action, manifest) {
        var form = document.createElement('form');
        form.method = 'POST';
        form.action = action;
        var field = document.createElement('input');
        field.type = 'hidden';
        field.name = 'manifest';
        field.value = JSON.stringify(manifest);
        form.appendChild(field);
        document.body.appendChild(form);
        form.submit();
    }

    function manualNote(msg) {
        var note = document.getElementById('deploy-manual-note');
        if (!note) return;
        note.textContent = msg;
        note.hidden = !msg;
    }

    // Each refusal names the field to fix. "Could not save" would send the
    // operator back to GitHub to re-read a page that was never the problem.
    var MANUAL_ERRORS = {
        bad_app_id: ['deploy_manual_bad_id', 'The App ID is the number on the App page, digits only.'],
        bad_private_key: ['deploy_manual_bad_key', 'That is not a private key. Paste the whole .pem file, including the BEGIN and END lines.'],
        github_rejected_credentials: ['deploy_manual_rejected', 'GitHub refused these credentials. Check the App ID, and generate a fresh key if the old one was deleted.'],
        app_id_key_mismatch: ['deploy_manual_mismatch', 'That key belongs to a different App than the ID you entered.'],
        github_already_connected: ['deploy_manual_already', 'A GitHub App is already connected on this server.'],
        github_unreachable: ['deploy_manual_unreachable', 'Aegis could not reach github.com. Check outbound HTTPS from this server.']
    };

    function submitManual(btn) {
        var idEl = document.getElementById('deploy-manual-appid');
        var keyEl = document.getElementById('deploy-manual-key');
        btn.disabled = true;
        manualNote('');
        var status = 0;
        window.api('/api/deploy/github/app/manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appId: idEl.value, privateKey: keyEl.value })
        })
            .then(function (r) { status = r.status; return readJson(r, 'app/manual'); })
            .then(function (data) {
                if (data && data.success) {
                    // The key is a credential and the operator has no reason to
                    // keep it on screen once it is stored.
                    keyEl.value = '';
                    manualNote(tr('deploy_manual_ok', 'GitHub App connected. Reloading.'));
                    return window.location.reload();
                }
                btn.disabled = false;
                var entry = MANUAL_ERRORS[data && data.error];
                if (entry) return manualNote(tr(entry[0], entry[1]));
                if (status === 403) {
                    return manualNote(tr('deploy_connect_admin_only',
                        'Only an administrator can connect GitHub.'));
                }
                throw new Error('app/manual refused with ' + status);
            })
            .catch(function (e) {
                btn.disabled = false;
                manualNote(tr('deploy_manual_failed', 'Could not save the App. Try again.'));
                console.error('[Deploy] manual registration failed:', e);
            });
    }

    function connectNote(msg) {
        var note = document.getElementById('deploy-connect-note');
        if (!note) return;
        note.textContent = msg;
        note.hidden = !msg;
    }

    function startConnect(btn) {
        btn.disabled = true;
        connectNote('');
        var status = 0;
        var ownerField = document.getElementById('deploy-connect-owner');
        window.api('/api/deploy/github/app/register-start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ owner: ownerField ? ownerField.value.trim() : '' })
        })
            .then(function (r) { status = r.status; return readJson(r, 'register-start'); })
            .then(function (data) {
                if (data && data.success) return submitManifest(data.action, data.manifest);
                // The button is visible to everyone, because hiding it would
                // leave a non-admin wondering where the feature went. The
                // backend is the check; this only explains the refusal.
                if (status === 403) {
                    btn.disabled = false;
                    return connectNote(tr('deploy_connect_admin_only',
                        'Only an administrator can connect GitHub.'));
                }
                // Named rather than left to the generic failure: the operator
                // typed this one, and it is the only field on the card.
                if (status === 400 && data && data.error === 'bad_owner') {
                    btn.disabled = false;
                    return connectNote(tr('deploy_connect_bad_owner',
                        'That is not a GitHub organisation name. Leave the field empty to use your own account.'));
                }
                throw new Error('register-start refused with ' + status);
            })
            .catch(function (e) {
                btn.disabled = false;
                connectNote(tr('deploy_connect_failed', 'Could not start the GitHub connection.'));
                console.error('[Deploy] register-start failed:', e);
            });
    }

    // Feedback from the callback redirect. Reported by code rather than a
    // generic failure, because "you took too long" and "GitHub refused the
    // exchange" need different responses from the operator.
    var CONNECT_RESULTS = {
        ok: ['deploy_connected_ok', 'GitHub connected.'],
        state_mismatch: ['deploy_connected_state', 'That registration link did not match this session. Start again.'],
        no_code: ['deploy_connected_nocode', 'GitHub sent no registration code. Start again.'],
        exchange_failed: ['deploy_connected_failed', 'GitHub refused the registration exchange. Start again.']
    };

    function reportCallback() {
        var code = new URLSearchParams(window.location.search).get('connected');
        if (!code) return;
        var entry = CONNECT_RESULTS[code] || CONNECT_RESULTS.exchange_failed;
        connectNote(tr(entry[0], entry[1]));
        goTo('github');
        // Drop the parameter so a reload does not repeat the message.
        window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    }

    // --- Choosing a repository --------------------------------------------

    var repoCache = [];
    /** The installation the list on screen came from, for the branch calls. */
    var repoInstallationId = null;

    /**
     * The branch one row will deploy.
     *
     * A field with a single option to start with, the default branch, so the
     * row still deploys in one click for the operator who wants that and only
     * costs a choice to the one who does not. The rest of the branches are
     * fetched the first time the field is reached rather than with the list:
     * a picker showing thirty repositories would otherwise make thirty calls
     * to GitHub for branches nobody opened.
     *
     * Whatever is showing stays selected when the real list arrives, because
     * the field may already have been read and left alone.
     */
    function branchPicker(repo) {
        var sel = el('select', 'dep-select dep-branch');
        sel.setAttribute('aria-label', tr('deploy_repo_branch', 'Branch to deploy'));
        sel.disabled = !isAdmin;

        function fill(names, chosen) {
            sel.textContent = '';
            names.forEach(function (name) {
                var opt = el('option', '', name);
                opt.value = name;
                if (name === chosen) opt.selected = true;
                sel.appendChild(opt);
            });
        }
        fill([repo.defaultBranch], repo.defaultBranch);

        var state = 'idle';
        function load() {
            if (state !== 'idle') return;
            state = 'loading';
            window.api('/api/deploy/github/branches?repo=' + encodeURIComponent(repo.fullName) +
                (repoInstallationId ? '&installation_id=' + encodeURIComponent(repoInstallationId) : ''))
                .then(function (r) { return readJson(r, '/api/deploy/github/branches'); })
                .then(function (d) {
                    if (!(d && d.success) || !d.branches || !d.branches.length) {
                        // Back to idle: GitHub refusing once is not a reason to
                        // leave the field stuck on one option for the session.
                        state = 'idle';
                        return;
                    }
                    state = 'loaded';
                    var keep = sel.value;
                    var names = d.branches.map(function (b) { return b.name; });
                    if (names.indexOf(keep) === -1) names.unshift(keep);
                    fill(names, keep);
                })
                .catch(function (e) {
                    state = 'idle';
                    console.error('[Deploy] branches failed:', e);
                });
        }

        // Three events, one intent. A pointer gives warning by hovering, and
        // the fetch started there is usually back before the list opens; a
        // mouse that went straight down and a keyboard that tabbed in get the
        // same list one moment later.
        sel.addEventListener('mouseenter', load);
        sel.addEventListener('mousedown', load);
        sel.addEventListener('focus', load);
        return sel;
    }

    /**
     * The repository picker.
     *
     * A button per repository rather than a dropdown and a form: the branch and
     * the name are both already known here, so asking for them again would be
     * asking the operator to retype what is on the card in front of them. The
     * paste field below stays for anything this list cannot show, which is any
     * public repository the App was not given.
     */
    function renderRepos() {
        var list = document.getElementById('deploy-repo-list');
        var empty = document.getElementById('deploy-repo-empty');
        var search = document.getElementById('deploy-repo-search');
        var needle = (search && search.value.trim().toLowerCase()) || '';
        var shown = repoCache.filter(function (r) {
            return !needle || r.fullName.toLowerCase().indexOf(needle) !== -1;
        });

        list.textContent = '';
        // Measured against what the search actually left, not against the whole
        // list: a search matching nothing used to empty the rows and say
        // nothing, which reads as a picker that broke.
        empty.hidden = !!shown.length;

        shown.forEach(function (r) {
            var card = el('div', 'dep-listrow');
            var main = el('div', 'dep-listrow-main');
            main.appendChild(el('span', 'dep-listrow-name', r.fullName));
            main.appendChild(el('span', 'dep-listrow-sub',
                (r.private ? tr('deploy_repo_private', 'private') : tr('deploy_repo_public', 'public')) +
                ' · ' + tr('deploy_repo_default', 'default') + ' ' + r.defaultBranch));
            card.appendChild(main);

            var branch = branchPicker(r);
            card.appendChild(branch);

            var btn = el('button', 'dep-btn dep-btn-ghost dep-btn-small',
                tr('deploy_repo_deploy', 'Deploy this'));
            btn.type = 'button';
            btn.disabled = !isAdmin;
            btn.addEventListener('click', function () {
                deployFrom({
                    repoUrl: r.fullName,
                    // What the field says, which is the default branch until
                    // someone changes it. Reading the record here instead is
                    // what made the choice unreachable in the first place.
                    branch: branch.value || r.defaultBranch,
                    // listRepos sends no short name, so it is taken from the one
                    // field that has it. Empty would work too (the backend falls
                    // back), but then the console has nothing to title itself
                    // with while the deployment runs.
                    name: r.fullName.split('/').pop()
                }, btn, card);
            });
            card.appendChild(btn);
            list.appendChild(card);
        });
    }

    function loadRepos(installationId) {
        repoInstallationId = installationId;
        return window.api('/api/deploy/github/repos?installation_id=' + encodeURIComponent(installationId))
            .then(function (r) { return readJson(r, '/api/deploy/github/repos'); })
            .then(function (d) { repoCache = (d && d.repos) || []; renderRepos(); })
            .catch(function (e) { console.error('[Deploy] repos failed:', e); });
    }

    // --- The deploy form and its plan -------------------------------------

    function newNote(msg) {
        var note = document.getElementById('deploy-new-note');
        if (!note) return;
        note.textContent = msg;
        note.hidden = !msg;
    }

    function formValues() {
        return {
            repoUrl: document.getElementById('deploy-new-url').value.trim(),
            branch: document.getElementById('deploy-new-branch').value.trim(),
            name: document.getElementById('deploy-new-name').value.trim(),
            rootDir: document.getElementById('deploy-new-root').value.trim(),
            installCmd: document.getElementById('deploy-new-install').value.trim(),
            buildCmd: document.getElementById('deploy-new-buildcmd').value.trim(),
            outputDir: document.getElementById('deploy-new-outputdir').value.trim(),
            startCmd: (document.getElementById('deploy-new-startcmd') || { value: '' }).value.trim(),
            dbFile: (document.getElementById('deploy-new-dbfile') || { value: '' }).value.trim(),
            migrationsDir: (document.getElementById('deploy-new-migrations') || { value: '' }).value.trim()
        };
    }

    /**
     * Offers the branches of whatever repository the URL field names.
     *
     * A datalist and not a select, because this field is the way in for a
     * repository the list above cannot show, and that repository's branches are
     * exactly the ones Aegis may fail to read. So the suggestions are a help
     * and never a constraint: an empty answer leaves a plain text field, which
     * is what this was before.
     *
     * Keyed by repository so switching back and forth costs one call, and
     * guarded by `formBranchesFor` so a field that fires `change` without
     * changing does not fire a request.
     */
    var formBranchesFor = null;

    function loadFormBranches() {
        var list = document.getElementById('deploy-branch-options');
        var url = document.getElementById('deploy-new-url');
        if (!list || !url) return;

        var raw = url.value.trim();
        // The same two shapes the backend's parser accepts, checked here only
        // to avoid a round trip on a field someone is halfway through typing.
        var m = raw.match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
        if (!m) {
            formBranchesFor = null;
            list.textContent = '';
            return;
        }
        var full = m[1] + '/' + m[2];
        if (full === formBranchesFor) return;
        formBranchesFor = full;

        window.api('/api/deploy/github/branches?repo=' + encodeURIComponent(full))
            .then(function (r) { return readJson(r, '/api/deploy/github/branches'); })
            .then(function (d) {
                // Checked again: the operator may have typed on while this was
                // in flight, and filling the list from the previous repository
                // would suggest branches that are not there.
                if (formBranchesFor !== full) return;
                list.textContent = '';
                if (!(d && d.success)) { formBranchesFor = null; return; }
                (d.branches || []).forEach(function (b) {
                    var opt = el('option', '', '');
                    opt.value = b.name;
                    list.appendChild(opt);
                });
                var field = document.getElementById('deploy-new-branch');
                if (field && d.defaultBranch) {
                    field.placeholder = d.defaultBranch;
                }
            })
            .catch(function (e) {
                formBranchesFor = null;
                console.error('[Deploy] form branches failed:', e);
            });
    }

    /**
     * The form, restated as the sequence the backend will run.
     *
     * Aegis inspects no repository before a real attempt, so this reads the
     * fields and nothing else. Calling it a detection preview would promise a
     * pre-flight check the backend does not make; what it does is turn seven
     * fields into the four steps they add up to, which is the part an operator
     * gets wrong (an output directory that is not where the build writes, a
     * subfolder that holds source rather than a site).
     */
    function renderPlan() {
        var box = document.getElementById('deploy-plan-steps');
        if (!box) return;
        var v = formValues();
        box.textContent = '';

        function step(text, code) {
            var li = document.createElement('li');
            li.appendChild(document.createTextNode(text));
            if (code) {
                li.appendChild(document.createTextNode(' '));
                li.appendChild(el('code', '', code));
            }
            box.appendChild(li);
        }

        step(tr('deploy_plan_clone', 'Clone the branch, one commit deep.'),
            v.branch || tr('deploy_plan_default_branch', 'default branch'));

        if (v.buildCmd) {
            step(tr('deploy_plan_build', 'Run install then build in the isolated sandbox.'),
                (v.installCmd ? v.installCmd + ' && ' : '') + v.buildCmd);
            step(tr('deploy_plan_output', 'Take what the build wrote here.'),
                v.outputDir || tr('deploy_plan_output_missing', 'output directory still empty'));
        } else if (v.rootDir) {
            step(tr('deploy_plan_root', 'Serve this folder from the branch.'), v.rootDir);
        } else {
            step(tr('deploy_plan_asis', 'Serve the root of the branch as it is, with no build.'), '');
        }

        if (v.startCmd) {
            step(tr('deploy_plan_start',
                'Start this command in the sandbox and serve every request through it.'), v.startCmd);
            step(tr('deploy_plan_health',
                'Refuse unless it answers, leaving the version that was running in place.'), '');
        } else {
            step(tr('deploy_plan_check',
                'Refuse unless index.html is there, leaving the current version serving.'), '');
        }
        step(tr('deploy_plan_publish', 'Publish on a free port and poll the branch every 20 seconds.'), '');
    }

    // Each refusal points at the thing to change. `needs_build` is the one an
    // operator will hit most, and it is a limit of this install rather than a
    // mistake they made, so it says so.
    //
    // An entry is [key, sentence] and, for the codes the refusal reference
    // lists, [key, sentence, shortKey, shortLabel]. The short label is the
    // heading that pane shows above the sentence. It lives here rather than in
    // a second table so a code cannot mean one thing on a card and another in
    // the reference; `REFUSAL_ORDER` below chooses which codes appear there and
    // in what order, which is an editorial decision and not this table's.
    var DEPLOY_ERRORS = {
        bad_repo_url: ['deploy_new_bad_url', 'That is not a GitHub repository URL. Paste something like https://github.com/owner/repo.',
            'deploy_ref_bad_repo_url', 'Not a github.com repository URL'],
        repo_not_found: ['deploy_new_repo_404', 'GitHub has no such repository, or the App cannot see it.',
            'deploy_ref_repo_not_found', 'GitHub has no such repository'],
        no_free_port: ['deploy_new_no_port', 'Every site port is taken. Delete a project or widen the range with AEGIS_SITES_PORT_BASE.',
            'deploy_ref_no_free_port', 'All 100 site ports are taken'],
        // Both of these reach a dozen panes, so they belong in the shared table
        // rather than in the one pane that happened to need them first. Every
        // caller falls back here, and a caller's own fallback sentence is wrong
        // for a code it never anticipated: redeploy used to answer a vanished
        // project with "already deploying".
        unknown_project: ['deploy_err_unknown_project', 'That site no longer exists. Reload the page.'],
        id_unavailable: ['deploy_err_id_unavailable', 'Ninety-nine projects here already share a name like that. Pick a different name.'],
        github_unreachable: ['deploy_manual_unreachable', 'Aegis could not reach github.com. Check outbound HTTPS from this server.',
            'deploy_ref_github_unreachable', 'Aegis could not reach github.com'],
        needs_build: ['deploy_new_needs_build', 'That branch holds source, not a built site. Fill in an install and build command above, or publish the build output to a branch or a subfolder whose root has index.html, then point Aegis at it.',
            'deploy_ref_needs_build', 'The branch holds source, not a site'],
        no_index: ['deploy_new_no_index', 'No index.html at the root of that branch. Point the subfolder field at the folder holding it.',
            'deploy_ref_no_index', 'No index.html in the served directory'],
        no_root_dir: ['deploy_new_no_root', 'That subfolder does not exist in this branch.',
            'deploy_ref_no_root_dir', 'That subfolder is not in this branch'],
        bad_root_dir: ['deploy_new_bad_root', 'That subfolder leaves the repository.',
            'deploy_ref_bad_root_dir', 'The subfolder path leaves the repository'],
        unsafe_symlink: ['deploy_new_unsafe_symlink', 'The site content contains a symlink or junction, which Aegis refuses to serve. Remove it from the build output.',
            'deploy_ref_unsafe_symlink', 'A symlink or junction in what would be served'],
        bad_site_config: ['deploy_new_bad_site_config', 'The vercel.json in that branch could not be read. Aegis refuses the deployment rather than serve a site whose config it ignored.',
            'deploy_ref_bad_site_config', 'The vercel.json in that branch will not parse'],
        runtime_disabled: ['deploy_new_runtime_off', 'This server does not run application processes. Set AEGIS_DEPLOY_RUNTIME=1 and the runtime accounts on the host, or leave the start command empty and deploy a built site.'],
        no_start_cmd: ['deploy_new_no_start', 'Name the command that starts the application.'],
        start_failed: ['deploy_new_start_failed', 'The start command stopped before it answered. What it printed is in the console above.'],
        unhealthy: ['deploy_new_unhealthy', 'The application never answered on its port. The version that was running is still serving.'],
        no_runtime_account: ['deploy_new_no_runtime_account', 'Every runtime account on this server is in use. Add one with Create-BuildAccounts.ps1, or remove a project that runs a process.'],
        bad_repo: ['deploy_new_bad_repo', 'Pick a repository from the list.'],
        bad_branch: ['deploy_new_bad_branch', 'That branch name is not one Aegis will pass to git.',
            'deploy_ref_bad_branch', 'A branch name Aegis will not pass to git'],
        bad_installation: ['deploy_new_bad_install', 'Pick an account above first.'],
        github_not_connected: ['deploy_new_not_connected', 'No GitHub App is connected on this server.'],
        deploy_failed: ['deploy_new_failed', 'The clone failed. Check that the branch exists and that this server reaches github.com.',
            'deploy_ref_deploy_failed', 'The clone itself failed'],
        // Everything below used to arrive as deploy_failed, which told the
        // operator to go and check a branch that was never the problem.
        build_failed: ['deploy_new_build_failed', 'The build command failed. What it printed is in the console above.',
            'deploy_ref_build_failed', 'The install or build command exited non-zero'],
        build_account_unconfigured: ['deploy_new_no_sandbox', 'The build sandbox accounts do not exist on this server. Run Create-BuildAccounts.ps1 on the host, or deploy a branch that needs no build.',
            'deploy_ref_no_sandbox', 'The build sandbox accounts are missing on the host'],
        tool_missing: ['deploy_new_tool_missing', 'This server could not start git or pwsh. Check both are on the PATH of the account Aegis runs as.',
            'deploy_ref_tool_missing', 'git or pwsh could not be started'],
        github_auth_failed: ['deploy_new_gh_auth', 'GitHub refused the App credentials. Reconnect the App, or check it is still installed on that repository.',
            'deploy_ref_gh_auth', 'GitHub refused the App credentials'],
        busy: ['deploy_new_busy', 'This project is already deploying. Wait for the deployment in progress to finish.',
            'deploy_ref_busy', 'A deployment of this project is already running'],
        needs_install: ['deploy_new_needs_install', 'Aegis cannot see that repository. If it is private, install the GitHub App on it; if the URL is wrong, check it.',
            'deploy_ref_needs_install', 'Aegis cannot see the repository'],
        cancelled: ['deploy_run_was_cancelled', 'You stopped this deployment. Nothing changed on the port.'],
        // Recorded by the poller rather than by a click, so these two only ever
        // reach the card, never the create form.
        branch_gone: ['deploy_branch_gone', 'That branch or repository is gone from GitHub. Check the App still has access to it.',
            'deploy_ref_branch_gone', 'The branch or repository disappeared'],
        poll_failed: ['deploy_poll_failed', 'Aegis could not ask GitHub about this branch. Check outbound HTTPS from this server.']
    };

    /**
     * The sentence for a refusal, with the folder named when the server found one.
     *
     * `suggestRootDir` is the difference between "no index.html at the root" and
     * an instruction: a repository whose site lives in `frontend/` gets told to
     * point at `frontend`, instead of the operator opening GitHub to look.
     */
    function refusal(entry, data) {
        var msg = tr(entry[0], entry[1]);
        if (data && data.suggestRootDir) {
            msg += ' ' + tr('deploy_new_try_root', 'Try the subfolder $1.')
                .replace('$1', data.suggestRootDir);
        }
        return msg;
    }

    /**
     * Turns the named folder into one click.
     *
     * Naming `frontend/` in a sentence still leaves the operator to find the
     * subfolder field and retype the repository into it, and on a repository
     * row there is no field in front of them at all. The server already worked
     * the folder out, so the retry is offered where the refusal was written.
     */
    function offerRootDir(values, rootDir, card) {
        var label = tr('deploy_new_retry_root', 'Deploy $1 instead').replace('$1', rootDir + '/');

        if (!card) {
            // The paste form has the field, so filling it is less surprising
            // than a second button beside the one just clicked.
            var field = document.getElementById('deploy-new-root');
            if (field) field.value = rootDir;
            renderPlan();
            return;
        }
        if (card.querySelector('.dep-card-retry')) return;   // already offered

        var retry = el('button', 'dep-btn dep-btn-ghost dep-btn-small dep-card-retry', label);
        retry.type = 'button';
        retry.disabled = !isAdmin;
        retry.addEventListener('click', function () {
            // Kept in the DOM rather than removed: `deployFrom` disables it for
            // the duration and re-enables it, and a detached button reports
            // nothing back if the retry fails too.
            deployFrom({
                repoUrl: values.repoUrl,
                branch: values.branch,
                name: values.name,
                rootDir: rootDir
            }, retry, card);
        });
        card.appendChild(retry);
    }

    /** An id for the console, minted here because the response arrives too late. */
    function mintRunId() {
        var bytes = new Uint8Array(12);
        window.crypto.getRandomValues(bytes);
        return Array.prototype.map.call(bytes, function (b) {
            return b.toString(16).padStart(2, '0');
        }).join('');
    }

    /**
     * The action every deploy button repeats: mint a run id, jump to the
     * build console for it, POST, and on a refusal turn the error code into
     * a message with the caller's own table.
     *
     * The run id is the one thing that cannot be built ahead of time, so
     * this is the only place that mints one; it is merged in ahead of
     * `opts.body`'s own keys, which puts it first on the wire for every
     * caller. That changes the byte order of the previous body for `create`
     * (whose `runId` used to come last) and leaves it as it already was for
     * `deployFrom` and `redeploy`; nothing here or in the backend compares a
     * request body as a string, so the order is not observable.
     *
     * `opts.label` names the request for `readJson`'s error text; kept
     * explicit rather than derived from `opts.url` because `create`'s label
     * ('preview') does not match its url's last segment ('previews').
     *
     * `opts.errorFor(code)` is the caller's own error table, returning a
     * tr() pair or nothing; nothing means the caller has more to decide once
     * this resolves (deployFrom's needs_install grant flow, and its
     * 403/unknown fallback), so this helper reports only what the table
     * actually resolved and leaves the rest to the caller's own `.then`.
     * Resolves to `{data, status}` either way.
     */
    function deployAction(opts) {
        var runId = mintRunId();
        goTo('console/' + runId);
        var status = 0;
        return window.api(opts.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ runId: runId }, opts.body))
        })
            .then(function (r) { status = r.status; return readJson(r, opts.label); })
            .then(function (data) {
                if (!(data && data.success)) {
                    var entry = opts.errorFor(data && data.error);
                    if (entry) opts.report(refusal(entry, data));
                }
                return { data: data, status: status };
            });
    }

    /**
     * Deploys one repository, from wherever the values came from.
     *
     * The request is answered only when the deployment is over, which for a
     * project with a build command is minutes. So the console opens first, on
     * an id `deployAction` mints, and watches the run while this promise is
     * still in flight. The refusal still comes back on the response, and is
     * written where the operator clicked.
     */
    function deployFrom(values, btn, card) {
        var report = card
            ? function (msg) {
                var line = card.querySelector('.dep-card-error') || el('p', 'dep-card-error', '');
                line.textContent = msg;
                card.appendChild(line);
            }
            : newNote;

        // Said in both places, because the operator is looking at the console
        // from the moment they click and the form note is behind it.
        function both(msg) { report(msg); consoleNote(msg); }

        btn.disabled = true;
        report(tr('deploy_new_working', 'Cloning and publishing. This takes a few seconds.'));

        var body = {
            repoUrl: values.repoUrl,
            branch: values.branch || '',
            name: values.name || '',
            rootDir: values.rootDir || '',
            installCmd: values.installCmd || '',
            buildCmd: values.buildCmd || '',
            outputDir: values.outputDir || '',
            startCmd: values.startCmd || ''
        };
        // Left out rather than sent empty, so the backend's own default (the
        // file and folder it already uses when nobody names either) applies.
        // A field sent as '' would work the same way today, but it would stop
        // being true the day a project wants to go back to no setting after
        // having one.
        if (values.dbFile) body.dbFile = values.dbFile;
        if (values.migrationsDir) body.migrationsDir = values.migrationsDir;

        return deployAction({
            url: '/api/deploy/projects',
            body: body,
            label: '/api/deploy/projects',
            // needs_install has its own grant-link handling below, so it is
            // kept out of the table lookup this helper does on our behalf.
            errorFor: function (code) { return code === 'needs_install' ? null : DEPLOY_ERRORS[code]; },
            report: both
        })
            .then(function (res) {
                var data = res.data, status = res.status;
                btn.disabled = !isAdmin;
                if (data && data.success) {
                    report('');
                    return loadProjects();
                }
                if (data && data.error === 'needs_install') {
                    both(tr('deploy_new_needs_install',
                        'Aegis cannot see that repository. If it is private, install the GitHub App on it; if the URL is wrong, check it.'));
                    if (data.installUrl) {
                        var link = el('a', 'dep-btn dep-btn-link',
                            tr('deploy_install_cta', 'Install the App on GitHub'));
                        link.href = data.installUrl;
                        link.target = '_blank';
                        link.rel = 'noopener noreferrer';
                        document.getElementById('deploy-new').appendChild(link);
                    }
                    return undefined;
                }
                // Already reported by deployAction when the table had an entry;
                // only the root-dir offer is still ours to add.
                if (DEPLOY_ERRORS[data && data.error]) {
                    if (data.suggestRootDir) offerRootDir(values, data.suggestRootDir, card);
                    return undefined;
                }
                if (status === 403) {
                    return both(tr('deploy_connect_admin_only',
                        'Only an administrator can connect GitHub.'));
                }
                // An error code this page does not know is not a clone failure,
                // and saying it was is what sends the operator to check a branch
                // that was never the problem.
                return both(tr('deploy_new_refused',
                    'Aegis refused this deployment for a reason this page does not know: $1. The backend log has the detail.')
                    .replace('$1', (data && data.error) || status));
            })
            .catch(function (e) {
                btn.disabled = false;
                // Everything that lands here is a request that never got an
                // answer: the backend is down, the session expired, the browser
                // could not reach it. None of that is the repository's fault.
                both(tr('deploy_new_unreachable',
                    'Aegis did not answer. Check the backend is running, then reload this page.'));
                console.error('[Deploy] deploy failed:', e);
            });
    }

    function submitDeploy(btn) {
        deployFrom(formValues(), btn, null);
    }

    /**
     * The grant step: an App exists, but it can see no repository yet.
     *
     * Creating an App on GitHub and installing it on an account are two separate
     * things, and the second is the one that hands over repository access. This is
     * the whole of it for the operator: one button, choose repositories on GitHub,
     * come back.
     *
     * While that tab is open the page watches for the installation appearing, so
     * coming back needs no reload. GitHub could redirect here instead, through the
     * App's setup URL, but an App registered by hand has none configured, and
     * polling costs one request every few seconds against a page someone is
     * actively looking at.
     */
    function renderGrantStep() {
        var wrap = document.getElementById('deploy-install');
        var link = document.getElementById('deploy-install-link');
        if (!wrap || !link) return;
        wrap.hidden = false;

        if (appInfo && appInfo.slug) {
            link.href = 'https://github.com/apps/' + encodeURIComponent(appInfo.slug) + '/installations/new';
            link.addEventListener('click', watchForInstallation, { once: true });
        } else {
            link.hidden = true;
        }
    }

    var installWatch = null;

    function stopWatching() {
        if (installWatch) clearInterval(installWatch);
        installWatch = null;
    }

    function watchForInstallation() {
        if (installWatch) return;
        var note = document.getElementById('deploy-install-note');
        if (note) {
            note.textContent = tr('deploy_grant_waiting',
                'Waiting for GitHub. This page updates itself once the App has access.');
            note.hidden = false;
        }

        // Capped so a tab left open overnight is not still polling in the morning.
        var attempts = 0;
        installWatch = setInterval(function () {
            attempts += 1;
            if (attempts > 75) {          // five minutes at four seconds
                stopWatching();
                if (note) {
                    note.textContent = tr('deploy_grant_timeout',
                        'Still no access. Reload this page once you have installed the App.');
                }
                return;
            }
            window.api('/api/deploy/github/installations')
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (d) {
                    if (d && d.installations && d.installations.length) {
                        stopWatching();
                        window.location.reload();
                    }
                })
                .catch(function () { /* a failed poll is the same as not yet */ });
        }, 4000);
    }

    function renderInstallations(installs) {
        var select = document.getElementById('deploy-installation');
        if (!installs || !installs.length) return renderGrantStep();
        document.getElementById('deploy-repos').hidden = false;
        select.textContent = '';
        installs.forEach(function (i) {
            var opt = document.createElement('option');
            opt.value = i.installationId;
            opt.textContent = i.accountLogin + ' (' + i.accountType + ')';
            select.appendChild(opt);
        });
        select.onchange = function () { loadRepos(select.value); };
        return loadRepos(select.value);
    }

    function loadGithub() {
        return window.api('/api/deploy/github/installations')
            .then(function (r) { return readJson(r, '/api/deploy/github/installations'); })
            .then(function (d) { renderInstallations(d && d.installations); })
            .catch(function (e) { console.error('[Deploy] installations failed:', e); });
    }

    // --- Projects ----------------------------------------------------------

    /** The line under the Projects grid, for what just happened to one. */
    function projectsNote(msg) {
        var note = document.getElementById('deploy-projects-note');
        if (!note) return;
        note.textContent = msg || '';
        note.hidden = !msg;
    }

    /**
     * Deletes a project after the operator confirms.
     *
     * `confirm` rather than an in-page two-step: the site is a clone of a
     * repository that still exists on GitHub, so the worst case is recreating it
     * with one click, and a bespoke confirmation panel would cost more attention
     * than the action is worth. What the sentence has to carry instead is the
     * part the word Remove does not: the files go, the port is freed, whoever is
     * signed in to the site is signed out, and GitHub keeps the repository.
     *
     * `card` is optional. From the grid the whole list repaints and there is no
     * card left to write on; from the detail pane there is.
     */
    function removeProject(project, btn, card) {
        var question = tr('deploy_delete_confirm',
            'Remove $1? Its files on this server are deleted, the port it holds is freed, and anyone signed in to the site is signed out. The repository on GitHub is untouched.')
            .replace('$1', project.name || project.id);
        if (!window.confirm(question)) return;

        btn.disabled = true;
        window.api('/api/deploy/projects/' + encodeURIComponent(project.id), { method: 'DELETE' })
            .then(function (r) { return readJson(r, 'delete project'); })
            .then(function (data) {
                if (data && data.success) {
                    // Written on the list rather than on the card, because the
                    // card is the thing that just stopped existing.
                    projectsNote(tr('deploy_delete_done', '$1 was removed.')
                        .replace('$1', data.name || project.name || project.id));
                    goTo('projects');
                    return loadProjects();
                }
                btn.disabled = !isAdmin;
                var msg = data && data.error === 'busy'
                    ? tr('deploy_delete_busy', 'That project is deploying. Stop it from its console, or try again in a moment.')
                    : tr('deploy_delete_failed', 'Aegis could not remove that project.');
                if (card) {
                    var line = card.querySelector('.dep-card-error') || el('p', 'dep-card-error', '');
                    line.textContent = msg;
                    card.appendChild(line);
                } else {
                    projectsNote(msg);
                }
                return undefined;
            })
            .catch(function (e) {
                btn.disabled = !isAdmin;
                projectsNote(tr('deploy_delete_unreachable',
                    'Aegis did not answer. Check the backend is running, then reload this page.'));
                console.error('[Deploy] delete failed:', e);
            });
    }

    /**
     * A project or one of its previews, by id.
     *
     * The previews are searched too because `GET /api/deploy/projects` nests
     * them under their parent rather than listing them, while the page
     * addresses one exactly like a project: `#project/<id>/<tab>` is where
     * Active branches, the domains pane and a preview's own tab strip all
     * point, and the build console for a preview deployment looks its site up
     * by the same id. Reading only the top level meant every one of those
     * found nothing -- the link landed on "that project is not in the list"
     * and the console dropped its Site row -- for a record the response did
     * send, one level down. The backend already treats a preview as a project
     * on every route (`projectStore.getProject` reads one store), so the
     * asymmetry was the page's alone, and it belongs here rather than in each
     * call site learning where a preview lives.
     */
    function projectById(id) {
        for (var i = 0; i < projects.length; i++) {
            if (projects[i].id === id) return projects[i];
            var previews = projects[i].previews || [];
            for (var j = 0; j < previews.length; j++) {
                if (previews[j].id === id) return previews[j];
            }
        }
        return null;
    }

    function projectCard(p) {
        var card = el('article', 'dep-card');

        var art = artFor(p);
        var state = projectState(p);
        art.appendChild(pill(state, stateLabel(state)));
        card.appendChild(art);

        var body = el('div', 'dep-card-body');
        body.appendChild(el('h3', 'dep-card-name', p.name));

        if (p.lastSha) {
            var link = el('a', 'dep-card-link', p.url);
            link.href = p.url;
            // A deployed site is untrusted content on another origin, so it
            // opens in its own tab with no handle back on this one.
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            body.appendChild(link);
        } else {
            body.appendChild(el('p', 'dep-card-repo', tr('deploy_no_port', 'port to assign')));
        }

        body.appendChild(el('p', 'dep-card-repo',
            p.repoFullName + ' · ' + p.branch +
            (p.lastSha ? ' · ' + p.lastSha.slice(0, 8) : '')));
        body.appendChild(el('p', 'dep-card-when', deployedLabel(p)));

        // A site behind a directory login looks exactly like an open one from
        // this list, and the difference is the whole point of the setting.
        if (p.protected) {
            var lock = el('p', 'dep-card-lock', '');
            lock.appendChild(lockIcon());
            var lockText = el('span', '', tr('deploy_auth_locked', 'Protected'));
            lockText.setAttribute('data-i18n', 'deploy_auth_locked');
            lock.appendChild(lockText);
            body.appendChild(lock);
        }

        if (state === 'down') {
            body.appendChild(el('p', 'dep-card-error',
                tr('deploy_card_not_listening',
                    'This site published, and its port is not open. Another program may hold port $1, or its certificate could not be read. The backend log names which.')
                    .replace('$1', p.port || '')));
        }

        // The last failure stays on the card while it is the newest thing that
        // happened, because a site that stopped updating looks exactly like a
        // site nobody pushed to.
        if (p.lastError) {
            var entry = DEPLOY_ERRORS[p.lastError];
            body.appendChild(el('p', 'dep-card-error',
                entry ? tr(entry[0], entry[1]) : p.lastError));
        }

        var actions = el('div', 'dep-card-actions');

        var open = el('a', 'dep-btn dep-btn-ghost dep-btn-small',
            tr('deploy_card_open', 'Open'));
        open.href = '#project/' + encodeURIComponent(p.id) + '/overview';
        actions.appendChild(open);

        var again = el('button', 'dep-btn dep-btn-ghost dep-btn-small',
            tr('deploy_redeploy_cta', 'Deploy latest commit'));
        again.type = 'button';
        again.disabled = !isAdmin;
        again.addEventListener('click', function () { redeploy(p.id, again, card); });
        actions.appendChild(again);

        // Removing a project was reachable only by opening it first, which is a
        // click too many for the one thing an operator does to a site they
        // created by mistake. Icon-only and last, so the row still reads Open,
        // then Deploy, then the destructive one on its own.
        var drop = el('button', 'dep-btn dep-btn-ghost dep-btn-small dep-btn-danger dep-btn-icon');
        drop.type = 'button';
        drop.disabled = !isAdmin;
        drop.title = tr('deploy_delete_cta', 'Remove');
        drop.setAttribute('aria-label', tr('deploy_delete_cta', 'Remove') + ' ' + (p.name || p.id));
        drop.appendChild(binIcon());
        drop.addEventListener('click', function () { removeProject(p, drop, null); });
        actions.appendChild(drop);

        body.appendChild(actions);
        card.appendChild(body);
        return card;
    }

    function renderProjects() {
        var hero = document.getElementById('deploy-hero');
        var block = document.getElementById('deploy-projects');
        var none = document.getElementById('deploy-project-none');
        var search = document.getElementById('deploy-project-search');
        var needle = (search && search.value.trim().toLowerCase()) || '';

        hero.hidden = !!projects.length;
        block.hidden = !projects.length;

        var shown = projects.filter(function (p) {
            return !needle ||
                (p.name || '').toLowerCase().indexOf(needle) !== -1 ||
                (p.repoFullName || '').toLowerCase().indexOf(needle) !== -1;
        });
        none.hidden = !projects.length || !!shown.length;

        listEl.textContent = '';
        shown.forEach(function (p) { listEl.appendChild(projectCard(p)); });
        paintProjectCount();
    }

    /**
     * "N sites — N ports taken", beside the pane title.
     *
     * A port counts as taken when a project holds one, which is not the same as
     * the number of projects: a project that has never published has no port
     * yet, and one served through the shared host listener does not hold a port
     * of its own. Counting projects here would overstate what is actually
     * occupied on the machine.
     */
    function paintProjectCount() {
        var out = document.getElementById('deploy-projects-count');
        if (!out) return;
        var ports = projects.filter(function (p) { return !!p.port; }).length;
        var sitesKey = projects.length === 1 ? 'deploy_count_site_one' : 'deploy_count_sites';
        var portsKey = ports === 1 ? 'deploy_count_port_one' : 'deploy_count_ports';
        out.textContent = '';
        out.appendChild(el('span', '', tr(sitesKey, '{n} sites').replace('{n}', projects.length)));
        out.appendChild(el('span', 'dep-meta-sep'));
        out.appendChild(el('span', '', tr(portsKey, '{n} ports taken').replace('{n}', ports)));
    }

    /**
     * When the site was last published, in words the operator can act on.
     *
     * Relative rather than a timestamp: the question this answers is "did my push
     * from a minute ago land", and a clock time makes the reader do the
     * subtraction themselves.
     */
    function deployedLabel(p) {
        if (!p.deployedAt) return tr('deploy_never', 'Never published');
        return tr('deploy_published', 'Published $1').replace('$1', ago(p.deployedAt));
    }

    function redeploy(projectId, btn, card) {
        stopWatching();
        btn.disabled = true;
        btn.textContent = tr('deploy_redeploy_working', 'Deploying');

        deployAction({
            url: '/api/deploy/projects/' + encodeURIComponent(projectId) + '/redeploy',
            body: {},
            label: 'redeploy',
            errorFor: function (code) {
                return DEPLOY_ERRORS[code] || ['deploy_redeploy_busy', 'That project is already deploying.'];
            },
            report: function (msg) {
                // A refusal replaces the card's error line, so the reason sits
                // next to the project it belongs to rather than at the top of
                // the page.
                consoleNote(msg);
                if (card) {
                    var line = card.querySelector('.dep-card-error') || el('p', 'dep-card-error', '');
                    line.textContent = msg;
                    card.appendChild(line);
                }
            }
        })
            .then(function (res) {
                btn.disabled = !isAdmin;
                btn.textContent = tr('deploy_redeploy_cta', 'Deploy latest commit');
                if (res.data && res.data.success) return loadProjects();
                return undefined;
            })
            .catch(function (e) {
                btn.disabled = !isAdmin;
                btn.textContent = tr('deploy_redeploy_cta', 'Deploy latest commit');
                console.error('[Deploy] redeploy failed:', e);
            });
    }

    // --- The build console --------------------------------------------------

    /**
     * How often the console asks what happened.
     *
     * Polled, not streamed. Server-sent events fit the shape better and fail
     * worse: this backend is installed behind whatever reverse proxy the
     * customer already runs, and a buffered SSE connection shows an empty
     * console rather than an error. Twice a second reads as live.
     *
     * ponytail: a poll with a line cursor. Worth revisiting only if a tenant
     * ever watches many builds at once.
     */
    var RUN_POLL_MS = 500;

    var runTimer = null;
    var runClockTimer = null;
    var currentRun = null;
    var runCursor = 0;
    /** Consecutive 404s tolerated while the backend is still resolving the repository. */
    var runMisses = 0;
    var RUN_MISS_LIMIT = 40;

    /** Runs still going, by project id, so a card can say "Building". */
    var runningRuns = {};

    function runningFor(projectId) {
        return !!runningRuns[projectId];
    }

    function stopRunPolling() {
        if (runTimer) clearInterval(runTimer);
        if (runClockTimer) clearInterval(runClockTimer);
        runTimer = null;
        runClockTimer = null;
    }

    function consoleNote(msg) {
        var note = document.getElementById('deploy-run-note');
        if (!note) return;
        note.textContent = msg || '';
        note.hidden = !msg;
    }

    function runStateOf(run) {
        if (run.status === 'running') return 'running';
        if (run.status === 'ready') return 'live';
        if (run.status === 'cancelled') return 'idle';
        return 'failed';
    }

    function runStateLabel(run) {
        if (run.status === 'running') return tr('deploy_run_running', 'Building');
        if (run.status === 'ready') return tr('deploy_run_ready', 'Published');
        if (run.status === 'cancelled') return tr('deploy_run_cancelled', 'Cancelled');
        return tr('deploy_run_failed', 'Failed');
    }

    var STAGE_LABELS = {
        clone: ['deploy_stage_clone', 'Clone'],
        install: ['deploy_stage_install', 'Install'],
        build: ['deploy_stage_build', 'Build'],
        check: ['deploy_stage_check', 'Acceptance test'],
        publish: ['deploy_stage_publish', 'Publish']
    };

    var TRIGGER_LABELS = {
        create: ['deploy_trigger_create', 'First deployment'],
        manual: ['deploy_trigger_manual', 'Started by hand'],
        push: ['deploy_trigger_push', 'Push on the branch'],
        poll: ['deploy_trigger_poll', 'New commit found by polling'],
        rollback: ['deploy_trigger_rollback', 'Rollback']
    };

    function triggerLabel(trigger) {
        var entry = TRIGGER_LABELS[trigger];
        return entry ? tr(entry[0], entry[1]) : trigger;
    }

    /**
     * Repaints the console.
     *
     * The stage list is rebuilt on every poll and the log is appended to, not
     * rebuilt: a log that is re-rendered twice a second cannot be selected with
     * the mouse, and losing a half-copied error message is the one thing an
     * operator needs from this screen.
     */
    /** The header clock. Called from paintRun and from its own tick. */
    function paintClock() {
        var node = document.getElementById('deploy-run-clock');
        if (!node || !currentRun) return;
        node.textContent = elapsed(currentRun.startedAt, currentRun.endedAt);
    }

    function paintRun(run, lines, resync) {
        document.getElementById('deploy-run-name').textContent = run.projectName || run.projectId;
        // Painted here as well as on the tick: a run that was already over when
        // the console opened stops the tick on its first poll, and the clock
        // would never have been written at all.
        paintClock();

        var branchEl = document.getElementById('deploy-run-branch');
        branchEl.textContent = run.branch || '';
        branchEl.hidden = !run.branch;

        var shaEl = document.getElementById('deploy-run-sha');
        shaEl.textContent = run.sha ? run.sha.slice(0, 8) : '';
        shaEl.hidden = !run.sha;

        var statusEl = document.getElementById('deploy-run-status');
        statusEl.className = 'dep-pill is-' + runStateOf(run);
        statusEl.textContent = runStateLabel(run);

        var cancel = document.getElementById('deploy-run-cancel');
        cancel.hidden = run.status !== 'running' || !isAdmin;

        // The stage list is rebuilt on every poll; the log is not. It hangs
        // below the list rather than under the running stage, because moving a
        // scrollable node between parents resets its scroll, and losing the
        // reader's place mid-error is worse than the nesting is worth.
        var stagesBox = document.getElementById('deploy-run-stages');
        var logBox = document.getElementById('deploy-run-log');
        var keepLog = logBox && !resync ? logBox : null;
        if (keepLog) keepLog.remove();
        stagesBox.textContent = '';

        run.stages.forEach(function (s) {
            // A skipped stage is not a stage. A static site installs nothing and
            // builds nothing, and a box for each says the opposite of that: it
            // reads as work still to come. They appear the moment the clone
            // shows there is something to install, and never otherwise.
            if (s.status === 'skipped') return;
            var wrap = el('div', 'dep-stage is-' + s.status);
            var head = el('div', 'dep-stage-head');
            head.appendChild(el('span', 'dep-stage-mark', ''));
            var entry = STAGE_LABELS[s.key];
            head.appendChild(el('span', 'dep-stage-name', tr(entry[0], entry[1])));
            if (s.startedAt && s.endedAt) {
                head.appendChild(el('span', 'dep-stage-time', clock(s.endedAt - s.startedAt)));
            } else if (s.status === 'running') {
                head.appendChild(el('span', 'dep-stage-time', elapsed(s.startedAt || run.startedAt)));
            }
            wrap.appendChild(head);
            if (s.detail) wrap.appendChild(el('p', 'dep-stage-detail', s.detail));
            stagesBox.appendChild(wrap);
        });

        var log = keepLog || el('div', 'dep-log');
        log.id = 'deploy-run-log';
        stagesBox.appendChild(log);

        var atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
        (lines || []).forEach(function (line) {
            var node = el('div', 'dep-log-line');
            node.appendChild(el('span', 'dep-log-at', new Date(line.at).toTimeString().slice(0, 8)));
            node.appendChild(el('span', 'dep-log-text', line.text));
            log.appendChild(node);
        });
        // Follows the tail only while the reader is already at the tail, so
        // scrolling back to read an earlier error is not undone by the next line.
        if (atBottom) log.scrollTop = log.scrollHeight;
        var placeholder = log.querySelector('.dep-log-wait');
        if (placeholder && log.childNodes.length > 1) placeholder.remove();
        else if (!log.childNodes.length) {
            log.appendChild(el('div', 'dep-log-line dep-log-wait',
                tr('deploy_run_waiting', 'Waiting for output.')));
        }

        var meta = document.getElementById('deploy-run-meta');
        meta.textContent = '';
        metaRow(meta, 'dep-meta-row', tr('deploy_meta_trigger', 'Trigger'), triggerLabel(run.trigger));
        metaRow(meta, 'dep-meta-row', tr('deploy_meta_actor', 'Started by'), run.actor);
        metaRow(meta, 'dep-meta-row', tr('deploy_meta_branch', 'Branch'), run.branch);
        metaRow(meta, 'dep-meta-row', tr('deploy_meta_commit', 'Commit'), run.sha ? run.sha.slice(0, 8) : '');
        metaRow(meta, 'dep-meta-row', tr('deploy_meta_started', 'Started'), ago(run.startedAt));
        metaRow(meta, 'dep-meta-row', tr('deploy_meta_duration', 'Duration'),
            run.endedAt ? clock(run.endedAt - run.startedAt) : '');

        var project = projectById(run.projectId);
        if (project && project.url && project.lastSha) {
            var a = el('a', 'dep-meta-value', project.url);
            a.href = project.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            metaRow(meta, 'dep-meta-row', tr('deploy_meta_site', 'Site'), a);
        }
    }

    function pollRun(runId) {
        return window.api('/api/deploy/runs/' + encodeURIComponent(runId) + '?after=' + runCursor)
            .then(function (r) {
                if (r.status === 404) {
                    runMisses += 1;
                    if (runMisses < RUN_MISS_LIMIT) return null;
                    stopRunPolling();
                    consoleNote(tr('deploy_run_gone',
                        'That build console is no longer in memory. Its result is on the project.'));
                    return null;
                }
                runMisses = 0;
                return readJson(r, 'run');
            })
            .then(function (data) {
                if (!data || !data.success) return undefined;
                var run = data.run;
                currentRun = run;
                runCursor = run.cursor;

                if (run.status === 'running') {
                    runningRuns[run.projectId] = true;
                    paintRunningCount();
                } else if (runningRuns[run.projectId]) {
                    delete runningRuns[run.projectId];
                    paintRunningCount();
                    // The card said "Building"; the run is over and the project
                    // record now says what happened.
                    loadProjects();
                }

                paintRun(run, run.lines, run.resync);
                if (run.status !== 'running') {
                    stopRunPolling();
                    if (run.error) {
                        var entry = DEPLOY_ERRORS[run.error];
                        consoleNote(entry ? tr(entry[0], entry[1]) : run.error);
                    }
                }
                return undefined;
            })
            .catch(function (e) {
                // Reached when the answer was not JSON, which on this page means
                // the request fell through to the SPA instead of reaching the
                // extension: a backend that has not been restarted since this
                // route was added. Saying so beats a console that just stops.
                stopRunPolling();
                consoleNote(tr('deploy_run_unreadable',
                    'Aegis stopped answering about this deployment. Restart the backend if it has not been restarted since the last update, then reopen this console.'));
                console.error('[Deploy] run poll failed:', e);
            });
    }

    /**
     * The console before the server has answered anything about this run.
     *
     * The id is minted here and the deployment starts on the request that
     * carries it, so for the first poll or three there is genuinely nothing to
     * fetch. Painting the five stages as pending says "this has started and is
     * waiting", which a blank pane does not: a blank pane reads as a broken
     * page, and that is what it was read as.
     */
    function pendingRun() {
        return {
            projectId: '',
            projectName: tr('deploy_run_starting', 'Starting'),
            branch: null,
            sha: null,
            trigger: '',
            actor: null,
            status: 'running',
            error: null,
            startedAt: Date.now(),
            endedAt: null,
            stages: ['clone', 'install', 'build', 'check', 'publish'].map(function (k) {
                return { key: k, status: 'pending', startedAt: null, endedAt: null, detail: null };
            })
        };
    }

    function openConsole(runId) {
        if (!runId) return goTo('runs');
        runCursor = 0;
        runMisses = 0;
        currentRun = pendingRun();
        consoleNote('');
        document.getElementById('deploy-run-stages').textContent = '';
        document.getElementById('deploy-run-meta').textContent = '';
        document.getElementById('deploy-run-clock').textContent = '';
        paintRun(currentRun, [], true);

        pollRun(runId);
        runTimer = setInterval(function () { pollRun(runId); }, RUN_POLL_MS);
        // The header clock ticks on its own so a slow poll does not freeze it.
        runClockTimer = setInterval(paintClock, 1000);

        var cancel = document.getElementById('deploy-run-cancel');
        cancel.onclick = function () { cancelRun(runId, cancel); };
        return undefined;
    }

    function cancelRun(runId, btn) {
        btn.disabled = true;
        window.api('/api/deploy/runs/' + encodeURIComponent(runId) + '/cancel', { method: 'POST' })
            .then(function (r) { return readJson(r, 'run cancel'); })
            .then(function (data) {
                btn.disabled = false;
                if (!data || !data.success) {
                    consoleNote(tr('deploy_run_cancel_failed',
                        'That deployment had already finished.'));
                }
                return undefined;
            })
            .catch(function (e) {
                btn.disabled = false;
                console.error('[Deploy] cancel failed:', e);
            });
    }

    function runRow(run) {
        var btn = el('button', 'dep-listrow');
        btn.type = 'button';
        var main = el('div', 'dep-listrow-main');
        main.appendChild(el('span', 'dep-listrow-name', run.projectName || run.projectId));
        main.appendChild(el('span', 'dep-listrow-sub',
            [run.sha ? run.sha.slice(0, 8) : '', run.branch, triggerLabel(run.trigger),
                ago(run.startedAt)].filter(Boolean).join(' · ')));
        btn.appendChild(main);
        btn.appendChild(pill(runStateOf(run), runStateLabel(run)));
        if (run.endedAt) {
            btn.appendChild(el('span', 'dep-stage-time', clock(run.endedAt - run.startedAt)));
        }
        btn.addEventListener('click', function () { goTo('console/' + run.id); });
        return btn;
    }

    function loadRuns() {
        var box = document.getElementById('deploy-run-list');
        var empty = document.getElementById('deploy-runs-empty');
        return window.api('/api/deploy/runs')
            .then(function (r) { return readJson(r, 'runs'); })
            .then(function (data) {
                var list = (data && data.runs) || [];
                box.textContent = '';
                empty.hidden = !!list.length;
                list.forEach(function (run) { box.appendChild(runRow(run)); });
                return undefined;
            })
            .catch(function (e) { console.error('[Deploy] runs failed:', e); });
    }

    // --- One project --------------------------------------------------------

    var HISTORY_STATE = { ready: 'live', failed: 'failed', cancelled: 'idle' };

    /**
     * The label on a history row's pill.
     *
     * "Published", not "Live": every row but the top one is a version that has
     * since been replaced, and a list of five rows all reading Live says the
     * site is serving five things at once. The refusal code goes in the line
     * underneath, where the pill's uppercase styling cannot mangle it.
     */
    function historyLabel(status) {
        if (status === 'ready') return tr('deploy_run_ready', 'Published');
        if (status === 'cancelled') return tr('deploy_run_cancelled', 'Cancelled');
        return tr('deploy_run_failed', 'Failed');
    }

    /**
     * One project: what it serves, what it did, and the way back.
     *
     * The history comes from the project record, which survives a restart, and
     * the console list comes from memory, which does not. Both are shown: the
     * record says whether a deployment worked, the run says why it did not.
     */
    // --- The project page --------------------------------------------------

    /**
     * The project page is tabbed, and the tab is in the hash.
     *
     * One long page with six panels stacked on it was readable while there were
     * two. It is not the shape of the thing being managed: a project has an
     * overview somebody opens twenty times a day and settings they touch once,
     * and those do not belong in the same scroll. `#project/<id>/<tab>` also
     * means a colleague can be sent straight to the variables.
     */
    // One entry per tab: id is the hash segment, labelKey/labelFallback go
    // through tr() at the render site below, render is the panel builder,
    // hiddenForPreview marks tabs a preview project may not show. Used to be
    // three separate lists (tab id/label, the preview exclusion check, the
    // renderDetail dispatch) that had to be kept in sync by hand; this is the
    // one place that knowledge lives now.
    var PROJECT_TABS = [
        { id: 'overview', labelKey: 'deploy_tab_overview', labelFallback: 'Overview', render: overviewTab, hiddenForPreview: false },
        { id: 'deployments', labelKey: 'deploy_tab_deployments', labelFallback: 'Deployments', render: deploymentsTab, hiddenForPreview: false },
        { id: 'previews', labelKey: 'deploy_tab_previews', labelFallback: 'Previews', render: previewsPanel, hiddenForPreview: true },
        { id: 'env', labelKey: 'deploy_tab_env', labelFallback: 'Variables', render: envPanel, hiddenForPreview: false },
        // Shown on a preview too: a preview writes its own data folder, under
        // its own id, and looking at what a branch wrote is most of why anyone
        // deploys one.
        { id: 'data', labelKey: 'deploy_tab_data', labelFallback: 'Data', render: dataPanel, hiddenForPreview: false },
        { id: 'domains', labelKey: 'deploy_tab_domains', labelFallback: 'Domains', render: domainsTab, hiddenForPreview: true },
        { id: 'settings', labelKey: 'deploy_tab_settings', labelFallback: 'Settings', render: settingsTab, hiddenForPreview: false }
    ];

    function tabById(id) {
        for (var i = 0; i < PROJECT_TABS.length; i++) {
            if (PROJECT_TABS[i].id === id) return PROJECT_TABS[i];
        }
        return null;
    }

    function projectTabName(raw) {
        return tabById(raw) ? raw : 'overview';
    }

    function projectTabBar(project, current) {
        var bar = el('nav', 'dep-tabs');
        bar.setAttribute('aria-label', tr('deploy_tabs_label', 'This project'));
        PROJECT_TABS.forEach(function (tab) {
            // A preview has no previews of its own and cannot take a host name,
            // so it is shown neither tab rather than two that refuse.
            if (project.parentId && tab.hiddenForPreview) return;
            var link = el('a', 'dep-tab' + (tab.id === current ? ' is-current' : ''), tr(tab.labelKey, tab.labelFallback));
            link.href = '#project/' + encodeURIComponent(project.id) + '/' + tab.id;
            if (tab.id === current) link.setAttribute('aria-current', 'page');
            bar.appendChild(link);
        });
        return bar;
    }

    function renderDetail(projectId, tab) {
        var p = projectById(projectId);
        var body = document.getElementById('deploy-detail-body');
        body.textContent = '';

        if (!p) {
            document.getElementById('deploy-detail-name').textContent = '';
            document.getElementById('deploy-detail-status').textContent = '';
            document.getElementById('deploy-detail-url').textContent = '';
            body.appendChild(el('p', 'dep-empty',
                tr('deploy_detail_gone', 'That project is not in the list. Reload the page.')));
            return;
        }

        document.getElementById('deploy-detail-name').textContent = p.name;
        var state = projectState(p);
        var statusEl = document.getElementById('deploy-detail-status');
        statusEl.className = 'dep-pill is-' + state;
        statusEl.textContent = stateLabel(state);

        var urlEl = document.getElementById('deploy-detail-url');
        urlEl.textContent = p.lastSha ? p.url : '';
        urlEl.href = p.url || '#';

        var at = projectTabName(tab);
        body.appendChild(projectTabBar(p, at));
        body.appendChild(tabById(at).render(p));
    }

    /**
     * What is live, and how to change it.
     *
     * The four facts an operator opens a project for -- the address, the state,
     * the commit, when -- above everything they might do about it. The
     * thumbnail is generated from the name rather than being a screenshot of the
     * site: taking one means loading a page from a repository in a headless
     * browser on the audit server, which is a lot of machinery for a picture.
     */
    function overviewTab(project) {
        var wrap = el('div', 'dep-block');

        var head = el('div', 'dep-prod-head');
        head.appendChild(el('h2', 'dep-subtitle', project.parentId
            ? tr('deploy_prod_preview', 'Preview deployment')
            : tr('deploy_prod_title', 'Production deployment')));

        var actions = el('div', 'dep-card-actions');
        if (project.lastSha && project.url) {
            var visit = el('a', 'dep-btn dep-btn-small', tr('deploy_prod_visit', 'Visit'));
            visit.href = project.url;
            visit.target = '_blank';
            visit.rel = 'noopener noreferrer';
            actions.appendChild(visit);
        }
        var rollNote = el('p', 'dep-note', '');
        rollNote.hidden = true;
        var releases = project.releases || [];
        if (releases.length) {
            var back = el('button', 'dep-btn dep-btn-ghost dep-btn-small',
                tr('deploy_prod_rollback', 'Instant rollback'));
            back.type = 'button';
            back.disabled = !isAdmin;
            back.addEventListener('click', function () {
                promote(project, releases[0].sha, back, rollNote);
            });
            actions.appendChild(back);
        }
        var again = el('button', 'dep-btn dep-btn-ghost dep-btn-small',
            tr('deploy_redeploy_cta', 'Deploy latest commit'));
        again.type = 'button';
        again.disabled = !isAdmin;
        again.addEventListener('click', function () { redeploy(project.id, again, null); });
        actions.appendChild(again);
        head.appendChild(actions);
        wrap.appendChild(head);

        var card = el('div', 'dep-prod');
        card.appendChild(artFor(project));

        var facts = el('div', 'dep-prod-facts');

        if (project.lastSha && project.url) {
            var link = el('a', 'dep-mono dep-detail-url', project.url);
            link.href = project.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            metaRow(facts, 'dep-prod-fact', tr('deploy_prod_address', 'Address'), link);
        } else {
            metaRow(facts, 'dep-prod-fact', tr('deploy_prod_address', 'Address'),
                tr('deploy_prod_nothing', 'nothing published yet'));
        }

        if (project.hostUrl) {
            var host = el('a', 'dep-mono dep-detail-url', project.hostUrl);
            host.href = project.hostUrl;
            host.target = '_blank';
            host.rel = 'noopener noreferrer';
            metaRow(facts, 'dep-prod-fact', tr('deploy_tab_domains', 'Domains'), host);
        } else if (!project.parentId) {
            var add = el('a', 'dep-meta-value', tr('deploy_prod_add_domain', 'add a host name'));
            add.href = '#project/' + encodeURIComponent(project.id) + '/domains';
            metaRow(facts, 'dep-prod-fact', tr('deploy_tab_domains', 'Domains'), add);
        }

        metaRow(facts, 'dep-prod-fact', tr('deploy_prod_status', 'Status'),
            pill(projectState(project), stateLabel(projectState(project))));
        metaRow(facts, 'dep-prod-fact', tr('deploy_prod_created', 'Published'), deployedLabel(project));
        metaRow(facts, 'dep-prod-fact', tr('deploy_prod_source', 'Source'),
            project.branch + (project.lastSha ? ' · ' + project.lastSha.slice(0, 8) : ''));
        metaRow(facts, 'dep-prod-fact', tr('deploy_meta_repo', 'Repository'), project.repoFullName);
        if (project.runtime === 'node') {
            metaRow(facts, 'dep-prod-fact', tr('deploy_meta_process', 'Process'), project.running
                ? tr('deploy_meta_process_up', 'answering')
                : tr('deploy_meta_process_down', 'not running'));
        }
        card.appendChild(facts);
        wrap.appendChild(card);
        wrap.appendChild(rollNote);

        if (project.lastError) {
            var entry = DEPLOY_ERRORS[project.lastError];
            wrap.appendChild(el('p', 'dep-card-error',
                entry ? tr(entry[0], entry[1]) : project.lastError));
        }

        // Active branches, the way the overview shows them: what else is
        // deployed from this repository, with a link into the tab that manages
        // them.
        if (!project.parentId) {
            var previews = project.previews || [];
            wrap.appendChild(el('h2', 'dep-subtitle', tr('deploy_prod_branches', 'Active branches')));
            if (!previews.length) {
                var none = el('p', 'dep-hint', tr('deploy_prod_branches_none',
                    'Only the production branch is deployed. Another branch can be, on a port of its own.'));
                wrap.appendChild(none);
            } else {
                var rows = el('div', 'dep-rows');
                previews.forEach(function (preview) {
                    var line = el('div', 'dep-listrow');
                    var main = el('div', 'dep-listrow-main');
                    main.appendChild(el('code', 'dep-code', preview.branch));
                    main.appendChild(el('span', 'dep-listrow-sub',
                        [preview.lastSha ? preview.lastSha.slice(0, 8) : null,
                        preview.deployedAt ? ago(preview.deployedAt) : null]
                            .filter(Boolean).join(' · ')));
                    line.appendChild(main);
                    var pstate = projectState(preview);
                    line.appendChild(pill(pstate, stateLabel(pstate)));
                    var open = el('a', 'dep-btn dep-btn-ghost dep-btn-small',
                        tr('deploy_previews_open', 'Open'));
                    open.href = '#project/' + encodeURIComponent(preview.id) + '/overview';
                    line.appendChild(open);
                    rows.appendChild(line);
                });
                wrap.appendChild(rows);
            }
            var manage = el('a', 'dep-btn dep-btn-ghost dep-btn-small',
                tr('deploy_prod_manage_branches', 'Deploy another branch'));
            manage.href = '#project/' + encodeURIComponent(project.id) + '/previews';
            wrap.appendChild(manage);
        }

        return wrap;
    }

    /** What this project has published, and what it can be put back to. */
    function deploymentsTab(project) {
        var wrap = el('div', 'dep-block');

        wrap.appendChild(el('h2', 'dep-subtitle', tr('deploy_detail_history', 'Deployments')));
        var history = project.history || [];
        if (!history.length) {
            wrap.appendChild(el('p', 'dep-empty',
                tr('deploy_hist_empty', 'Nothing recorded yet for this project.')));
        } else {
            var rows = el('div', 'dep-rows');
            history.forEach(function (h) {
                var line = el('div', 'dep-listrow');
                var main = el('div', 'dep-listrow-main');
                main.appendChild(el('span', 'dep-listrow-name',
                    h.sha ? h.sha.slice(0, 8) : tr('deploy_hist_nosha', 'no commit')));
                main.appendChild(el('span', 'dep-listrow-sub',
                    [triggerLabel(h.trigger), h.actor, h.error, ago(h.at)]
                        .filter(Boolean).join(' · ')));
                line.appendChild(main);
                line.appendChild(pill(HISTORY_STATE[h.status] || 'failed', historyLabel(h.status)));
                rows.appendChild(line);
            });
            wrap.appendChild(rows);
        }

        var consoles = el('a', 'dep-btn dep-btn-ghost dep-btn-small',
            tr('deploy_hist_consoles', 'Open the build consoles'));
        consoles.href = '#runs';
        wrap.appendChild(consoles);

        wrap.appendChild(el('h2', 'dep-subtitle', tr('deploy_releases_title', 'Versions kept on disk')));
        var releases = project.releases || [];
        if (!releases.length) {
            wrap.appendChild(el('p', 'dep-hint', tr('deploy_rollback_none',
                'Nothing to go back to. This project has published one version at most.')));
            return wrap;
        }

        wrap.appendChild(el('p', 'dep-hint', tr('deploy_releases_body',
            'Each publish keeps the version it replaced, five at a time. Putting one back is a folder swap: no clone, no build, and the site keeps its port.')));
        var note = el('p', 'dep-note', '');
        note.hidden = true;
        var rrows = el('div', 'dep-rows');
        releases.forEach(function (release) {
            var line = el('div', 'dep-listrow');
            var main = el('div', 'dep-listrow-main');
            main.appendChild(el('code', 'dep-code', release.sha.slice(0, 8)));
            main.appendChild(el('span', 'dep-listrow-sub', ago(release.at)));
            line.appendChild(main);
            var put = el('button', 'dep-btn dep-btn-ghost dep-btn-small',
                tr('deploy_release_cta', 'Serve this'));
            put.type = 'button';
            put.disabled = !isAdmin;
            put.addEventListener('click', function () { promote(project, release.sha, put, note); });
            line.appendChild(put);
            rrows.appendChild(line);
        });
        wrap.appendChild(rrows);
        wrap.appendChild(note);
        return wrap;
    }

    /** The name this site answers to, beside the port it always answers on. */
    function domainsTab(project) {
        var wrap = el('div', 'dep-block');
        wrap.appendChild(el('h2', 'dep-subtitle', tr('deploy_hostname_title', 'Host name')));
        wrap.appendChild(el('p', 'dep-hint', project.routerPort
            ? tr('deploy_hostname_body',
                'The shared listener answers on port $1 for the name you give here. The site keeps its own port either way, and the name starts working once a DNS record or a hosts entry points at this server.')
                .replace('$1', String(project.routerPort))
            : tr('deploy_hostname_off',
                'The shared listener is off on this install. Set AEGIS_SITES_ROUTER_PORT on the host to answer by name. The site keeps its own port either way.')));

        var field = el('input', 'dep-input');
        field.type = 'text';
        field.autocomplete = 'off';
        field.spellcheck = false;
        field.value = project.hostname || '';
        field.placeholder = 'intranet.example.local';
        field.disabled = !isAdmin;
        field.setAttribute('aria-label', tr('deploy_hostname_label', 'Host name'));
        wrap.appendChild(field);

        var save = el('button', 'dep-btn dep-btn-small', tr('deploy_hostname_save', 'Save'));
        save.type = 'button';
        save.disabled = !isAdmin;
        wrap.appendChild(save);

        var note = el('p', 'dep-note', '');
        note.hidden = true;
        wrap.appendChild(note);
        save.addEventListener('click', function () { saveHostname(project, field, save, note); });
        field.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && isAdmin) saveHostname(project, field, save, note);
        });

        var rows = el('div', 'dep-rows');
        [[tr('deploy_domains_port', 'Always answers on'), project.url || '-'],
        [tr('deploy_domains_name', 'Answers by name on'), project.hostUrl || tr('deploy_domains_none', 'no name set')]]
            .forEach(function (pair) {
                var line = el('div', 'dep-listrow');
                var main = el('div', 'dep-listrow-main');
                main.appendChild(el('span', 'dep-listrow-name', pair[0]));
                main.appendChild(el('span', 'dep-listrow-sub dep-mono', pair[1]));
                line.appendChild(main);
                rows.appendChild(line);
            });
        wrap.appendChild(rows);
        return wrap;
    }

    /** Everything about this project that is a decision rather than a fact. */
    function settingsTab(project) {
        var wrap = el('div', 'dep-block');

        // How this site answers a path with no file behind it. A built single
        // page application has one file and many routes, so a refresh on
        // /dashboard is a 404 unless something says otherwise.
        wrap.appendChild(el('h2', 'dep-subtitle', tr('deploy_serving_title', 'Unknown paths')));
        wrap.appendChild(el('p', 'dep-hint', tr('deploy_serving_body',
            'A path with no file behind it answers 404. A single-page build needs index.html instead, or a refresh on one of its routes fails. A vercel.json rewrite in the repository does the same thing and wins nothing over this switch.')));

        var check = el('label', 'dep-check');
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!project.spaFallback;
        box.disabled = !isAdmin;
        check.appendChild(box);
        check.appendChild(el('span', '', tr('deploy_serving_spa',
            'Answer with index.html rather than 404')));
        wrap.appendChild(check);

        var spaNote = el('p', 'dep-note', '');
        spaNote.hidden = true;
        wrap.appendChild(spaNote);
        box.addEventListener('change', function () { saveSpaFallback(project, box, spaNote); });

        wrap.appendChild(el('h2', 'dep-subtitle', tr('deploy_branch_title', 'Tracked branch')));
        if (project.parentId) {
            // A preview is its branch: the id was derived from it and the
            // parent lists it by it. Changing it here would leave a folder
            // named after a branch it no longer follows.
            wrap.appendChild(el('p', 'dep-hint', tr('deploy_branch_preview_fixed',
                'A preview is its branch. Remove it and deploy the other branch as a new preview.')));
        } else {
            wrap.appendChild(el('p', 'dep-hint', tr('deploy_branch_body',
                'This site serves $1 and republishes it on every push. Pointing it at another branch clones that one now, publishes it on the same port and moves the polling with it. What is on the port stays there until the new branch is accepted.')
                .replace('$1', project.branch)));

            var bform = el('div', 'dep-branch-form');
            var bin = el('input', 'dep-input');
            bin.type = 'text';
            bin.autocomplete = 'off';
            bin.spellcheck = false;
            bin.value = project.branch;
            bin.disabled = !isAdmin;
            bin.setAttribute('aria-label', tr('deploy_branch_title', 'Tracked branch'));
            bform.appendChild(bin);
            bform.appendChild(branchSuggestions(bin, project.repoFullName));

            var bgo = el('button', 'dep-btn dep-btn-small',
                tr('deploy_branch_cta', 'Change and deploy'));
            bgo.type = 'button';
            bgo.disabled = !isAdmin;
            bform.appendChild(bgo);
            wrap.appendChild(bform);

            var bnote = el('p', 'dep-note', '');
            bnote.hidden = true;
            wrap.appendChild(bnote);

            bgo.addEventListener('click', function () { changeBranch(project, bin, bgo, bnote); });
            bin.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && isAdmin) changeBranch(project, bin, bgo, bnote);
            });
        }

        wrap.appendChild(el('h2', 'dep-subtitle', tr('deploy_settings_build', 'Build and deployment')));
        var meta = el('aside', 'dep-meta');
        metaRow(meta, 'dep-meta-row', tr('deploy_meta_repo', 'Repository'), project.repoFullName);
        metaRow(meta, 'dep-meta-row', tr('deploy_meta_root', 'Subfolder'), project.rootDir);
        metaRow(meta, 'dep-meta-row', tr('deploy_meta_install', 'Install command'), project.installCmd);
        metaRow(meta, 'dep-meta-row', tr('deploy_meta_build', 'Build command'), project.buildCmd);
        metaRow(meta, 'dep-meta-row', tr('deploy_meta_output', 'Output directory'), project.outputDir);
        metaRow(meta, 'dep-meta-row', tr('deploy_meta_start', 'Start command'), project.startCmd);
        if (project.runtime === 'node') {
            metaRow(meta, 'dep-meta-row', tr('deploy_meta_process', 'Process'), project.running
                ? tr('deploy_meta_process_up', 'answering')
                : tr('deploy_meta_process_down', 'not running'));
        }
        metaRow(meta, 'dep-meta-row', tr('deploy_meta_port', 'Port'), project.port ? String(project.port) : '');
        metaRow(meta, 'dep-meta-row', tr('deploy_meta_commit', 'Commit'), project.lastSha ? project.lastSha.slice(0, 8) : '');
        metaRow(meta, 'dep-meta-row', tr('deploy_meta_published', 'Published'), project.deployedAt ? ago(project.deployedAt) : '');
        wrap.appendChild(meta);
        wrap.appendChild(el('p', 'dep-hint', tr('deploy_settings_immutable',
            'These are read when the project is created. The branch above is the one that can be changed afterwards; changing any of the others is a new project today.')));

        wrap.appendChild(el('h2', 'dep-subtitle', tr('deploy_nav_auth', 'Authentication')));
        wrap.appendChild(el('p', 'dep-hint', project.protected
            ? tr('deploy_settings_protected',
                'This site asks for a directory login before it serves anything.')
            : tr('deploy_settings_open',
                'Anyone who can reach the port can read this site.')));
        var protect = el('a', 'dep-btn dep-btn-ghost dep-btn-small',
            tr('deploy_settings_protect', 'Who may open it'));
        protect.href = '#auth';
        wrap.appendChild(protect);

        wrap.appendChild(el('h2', 'dep-subtitle dep-danger-title', tr('deploy_settings_danger', 'Remove')));
        wrap.appendChild(el('p', 'dep-hint', tr('deploy_settings_danger_body',
            'The files on this server, the port, every session open on the site and every preview of it. The repository on GitHub is not touched.')));
        var drop = el('button', 'dep-btn dep-btn-ghost dep-btn-small dep-btn-danger');
        drop.type = 'button';
        drop.disabled = !isAdmin;
        drop.appendChild(binIcon());
        drop.appendChild(el('span', '', tr('deploy_delete_cta', 'Remove')));
        drop.addEventListener('click', function () {
            removeProject(project, drop, document.getElementById('deploy-detail-body'));
        });
        wrap.appendChild(drop);

        return wrap;
    }

    /**
     * Puts one kept version back on the port.
     *
     * The confirmation names the commit rather than the project: on this panel
     * every button belongs to the same project and the version is the thing the
     * operator could get wrong.
     */
    function promote(project, sha, btn, note) {
        var short = sha.slice(0, 8);
        var question = tr('deploy_release_confirm',
            'Serve $1 again? The version on the port now becomes one you can go back to.')
            .replace('$1', short);
        if (!window.confirm(question)) return;

        btn.disabled = true;
        note.hidden = false;
        note.textContent = tr('deploy_auth_working', 'Saving.');
        window.api('/api/deploy/projects/' + encodeURIComponent(project.id) + '/promote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sha: sha })
        })
            .then(function (r) { return readJson(r, 'promote'); })
            .then(function (data) {
                btn.disabled = !isAdmin;
                if (data && data.success) {
                    note.textContent = tr('deploy_release_done', '$1 is on the port.').replace('$1', short);
                    return loadProjects().then(function () { renderDetail(project.id, readHash().sub); });
                }
                var reason = data && data.error;
                if (reason === 'busy') {
                    note.textContent = tr('deploy_delete_busy',
                        'That project is deploying. Try again in a moment.');
                } else if (reason === 'unknown_release' || reason === 'bad_release') {
                    note.textContent = tr('deploy_release_gone',
                        'That version is no longer on disk. Reload the page.');
                } else {
                    note.textContent = tr('deploy_rollback_failed',
                        'Aegis could not swap the two versions. The backend log has the detail.');
                }
                return undefined;
            })
            .catch(function (e) {
                btn.disabled = !isAdmin;
                note.textContent = tr('deploy_auth_unreachable',
                    'Aegis did not answer. Check the backend is running, then reload this page.');
                console.error('[Deploy] promote failed:', e);
            });
    }


    /**
     * Saves the fallback switch, straight from the checkbox.
     *
     * No Save button: one boolean with a button beside it is a form for the sake
     * of having one, and the note under it says what happened. A refusal puts
     * the box back where it was, because a checkbox that stays ticked after the
     * server said no is a lie.
     */
    function saveSpaFallback(project, box, note) {
        var wanted = !!box.checked;
        box.disabled = true;
        note.hidden = false;
        note.textContent = tr('deploy_auth_working', 'Saving.');
        window.api('/api/deploy/projects/' + encodeURIComponent(project.id) + '/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ spaFallback: wanted })
        })
            .then(function (r) { return readJson(r, 'settings'); })
            .then(function (data) {
                box.disabled = !isAdmin;
                if (data && data.success) {
                    box.checked = !!data.spaFallback;
                    project.spaFallback = !!data.spaFallback;
                    note.textContent = data.spaFallback
                        ? tr('deploy_serving_on', 'An unknown path now answers with index.html.')
                        : tr('deploy_serving_off', 'An unknown path now answers 404.');
                    return;
                }
                box.checked = !wanted;
                note.textContent = tr('deploy_serving_failed',
                    'Aegis could not save that. The backend log has the detail.');
            })
            .catch(function (e) {
                box.disabled = !isAdmin;
                box.checked = !wanted;
                note.textContent = tr('deploy_auth_unreachable',
                    'Aegis did not answer. Check the backend is running, then reload this page.');
                console.error('[Deploy] settings save failed:', e);
            });
    }


    /**
     * Saves the host name, or clears it when the field is emptied.
     *
     * Emptying it is a real action and not a no-op: the router stops answering
     * for that name, which frees it for another project. So an empty field is
     * sent rather than skipped.
     */
    function saveHostname(project, field, btn, note) {
        var wanted = field.value.trim();
        btn.disabled = true;
        note.hidden = false;
        note.textContent = tr('deploy_auth_working', 'Saving.');
        window.api('/api/deploy/projects/' + encodeURIComponent(project.id) + '/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hostname: wanted })
        })
            .then(function (r) { return readJson(r, 'settings'); })
            .then(function (data) {
                btn.disabled = !isAdmin;
                if (data && data.success) {
                    note.textContent = data.hostname
                        ? tr('deploy_hostname_saved', 'Saved.')
                        : tr('deploy_hostname_cleared', 'Removed. The site answers on its port only.');
                    return loadProjects().then(function () { renderDetail(project.id, readHash().sub); });
                }
                var reason = data && data.error;
                if (reason === 'bad_hostname') {
                    note.textContent = tr('deploy_hostname_bad',
                        'That is not a host name. Letters, digits, hyphens and dots, with no scheme and no port.');
                } else if (reason === 'hostname_taken') {
                    note.textContent = tr('deploy_hostname_taken',
                        'Another project on this server already answers for that name.');
                } else {
                    note.textContent = tr('deploy_serving_failed',
                        'Aegis could not save that. The backend log has the detail.');
                }
                return undefined;
            })
            .catch(function (e) {
                btn.disabled = !isAdmin;
                note.textContent = tr('deploy_auth_unreachable',
                    'Aegis did not answer. Check the backend is running, then reload this page.');
                console.error('[Deploy] hostname save failed:', e);
            });
    }

    // --- Preview deployments ------------------------------------------------

    /**
     * The other branches of this repository, deployed alongside the live one.
     *
     * A preview is the same site from another branch, on its own port, polled
     * and republished on every push like the project itself. It inherits the
     * repository, the commands and the protection, and it expires: seven days
     * with no commit and no visitor and its port goes back, because the range is
     * a hundred wide and a busy repository would eat it.
     */
    function previewsPanel(project) {
        var block = el('div', 'dep-env');
        block.appendChild(el('h2', 'dep-subtitle', tr('deploy_previews_title', 'Preview deployments')));
        block.appendChild(el('p', 'dep-hint', tr('deploy_previews_body',
            'Another branch of the same repository, on its own port, republished on every push. It inherits the build commands and the protection of this project, and reads only the environment variables marked for previews. Seven days with no commit and no visitor and it is removed.')));

        // Declared before the list that references it: `var` would hoist it
        // anyway and the closure only reads it on a click, but a reader should
        // not have to know that to follow the function.
        var note = el('p', 'dep-note', '');
        note.hidden = true;

        var rows = el('div', 'dep-rows');
        var list = project.previews || [];
        if (!list.length) {
            block.appendChild(el('p', 'dep-empty', tr('deploy_previews_none',
                'No branch is deployed alongside this one.')));
        } else {
            list.forEach(function (preview) {
                var line = el('div', 'dep-listrow');
                var main = el('div', 'dep-listrow-main');
                main.appendChild(el('code', 'dep-code', preview.branch));
                main.appendChild(el('span', 'dep-listrow-sub',
                    [preview.lastSha ? preview.lastSha.slice(0, 8) : null,
                    preview.deployedAt ? ago(preview.deployedAt) : null,
                    preview.port ? ':' + preview.port : null]
                        .filter(Boolean).join(' · ')));
                line.appendChild(main);

                var state = projectState(preview);
                line.appendChild(pill(state, stateLabel(state)));

                if (preview.url && preview.lastSha) {
                    var open = el('a', 'dep-btn dep-btn-ghost dep-btn-small',
                        tr('deploy_previews_open', 'Open'));
                    open.href = preview.url;
                    open.target = '_blank';
                    open.rel = 'noopener noreferrer';
                    line.appendChild(open);
                }

                var drop = el('button', 'dep-btn dep-btn-ghost dep-btn-small dep-btn-danger');
                drop.type = 'button';
                drop.disabled = !isAdmin;
                drop.appendChild(binIcon());
                drop.setAttribute('aria-label',
                    tr('deploy_previews_remove', 'Remove the $1 preview').replace('$1', preview.branch));
                drop.addEventListener('click', function () { removePreview(project, preview, drop, note); });
                line.appendChild(drop);
                rows.appendChild(line);
            });
            block.appendChild(rows);
        }

        var form = el('div', 'dep-env-form');
        var branchIn = el('input', 'dep-input');
        branchIn.type = 'text';
        branchIn.autocomplete = 'off';
        branchIn.spellcheck = false;
        branchIn.placeholder = tr('deploy_previews_branch', 'Branch');
        branchIn.setAttribute('aria-label', tr('deploy_previews_branch', 'Branch'));
        form.appendChild(branchSuggestions(branchIn, project.repoFullName));

        var add = el('button', 'dep-btn dep-btn-small', tr('deploy_previews_add', 'Deploy this branch'));
        add.type = 'button';
        add.disabled = !isAdmin;

        form.appendChild(branchIn);
        form.appendChild(add);
        block.appendChild(form);
        block.appendChild(note);

        function create() {
            var branch = branchIn.value.trim();
            if (!branch) {
                note.hidden = false;
                note.textContent = tr('deploy_previews_no_branch', 'Name the branch to deploy.');
                branchIn.focus();
                return;
            }
            stopWatching();
            add.disabled = true;

            deployAction({
                url: '/api/deploy/projects/' + encodeURIComponent(project.id) + '/previews',
                body: { branch: branch },
                label: 'preview',
                errorFor: previewError,
                report: consoleNote
            })
                .then(function (res) {
                    add.disabled = !isAdmin;
                    if (res.data && res.data.success) return loadProjects();
                    return undefined;
                })
                .catch(function (e) {
                    add.disabled = !isAdmin;
                    console.error('[Deploy] preview failed:', e);
                });
        }

        add.addEventListener('click', create);
        branchIn.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && isAdmin) create();
        });

        return block;
    }

    /**
     * Suggestions for a branch field whose repository is already known.
     *
     * Returns the datalist to append; the caller decides where it sits, because
     * a datalist is not rendered and only has to be in the document. Loaded on
     * first reach rather than on render, for the same reason the repository
     * rows do it: a project page must not spend a call to GitHub on a field
     * nobody opened.
     *
     * A datalist and not a select here too. The field has to keep accepting a
     * branch that GitHub refuses to list, which is what a repository the App
     * lost access to looks like, and a select would leave that operator with no
     * way to type the name they know is right.
     */
    var branchListSeq = 0;

    function branchSuggestions(input, repoFullName) {
        var list = el('datalist', '');
        branchListSeq += 1;
        list.id = 'deploy-branches-' + branchListSeq;
        input.setAttribute('list', list.id);

        var state = repoFullName ? 'idle' : 'loaded';
        function load() {
            if (state !== 'idle') return;
            state = 'loading';
            window.api('/api/deploy/github/branches?repo=' + encodeURIComponent(repoFullName))
                .then(function (r) { return readJson(r, '/api/deploy/github/branches'); })
                .then(function (d) {
                    if (!(d && d.success)) { state = 'idle'; return; }
                    state = 'loaded';
                    list.textContent = '';
                    (d.branches || []).forEach(function (b) {
                        var opt = el('option', '', '');
                        opt.value = b.name;
                        list.appendChild(opt);
                    });
                })
                .catch(function (e) {
                    state = 'idle';
                    console.error('[Deploy] branches failed:', e);
                });
        }
        input.addEventListener('mouseenter', load);
        input.addEventListener('focus', load);
        return list;
    }

    /** The refusals only this form can produce, then the shared table. */
    function previewError(code) {
        var own = {
            branch_is_production: ['deploy_previews_is_prod',
                'That is the branch this project already serves.'],
            preview_exists: ['deploy_previews_exists', 'That branch is already deployed here.'],
            already_preview: ['deploy_previews_nested', 'A preview cannot have previews of its own.'],
            no_free_port: ['deploy_previews_no_port',
                'Every site port is taken. Delete a project or a preview, or widen the range with AEGIS_SITES_PORT_BASE.']
        }[code];
        return own || DEPLOY_ERRORS[code] ||
            ['deploy_previews_failed', 'Aegis could not deploy that branch.'];
    }

    /**
     * Moves a project to another branch and watches the deployment that follows.
     *
     * Confirmed, and the question names both branches: the cost of getting this
     * wrong is not the clone, which is seconds, it is that pushes to the branch
     * the operator thought was live stop being deployed and nothing on the page
     * says so until someone notices the commit has gone old.
     *
     * The console opens on the run `deployAction` mints, same as a redeploy,
     * because this is a deployment and it fails like one.
     */
    function changeBranch(project, input, btn, note) {
        var branch = input.value.trim();
        function say(msg) {
            note.hidden = false;
            note.textContent = msg;
        }
        if (!branch) {
            say(tr('deploy_branch_empty', 'Name the branch to serve.'));
            input.focus();
            return;
        }
        if (branch === project.branch) {
            say(tr('deploy_branch_same', 'That is the branch this project already serves.'));
            return;
        }
        var question = tr('deploy_branch_confirm',
            'Serve $1 instead of $2? Aegis clones it now and publishes it on this port, and pushes to $2 stop being deployed.')
            .split('$1').join(branch).split('$2').join(project.branch);
        if (!window.confirm(question)) return;

        stopWatching();
        btn.disabled = true;
        say(tr('deploy_branch_working', 'Cloning the new branch.'));

        deployAction({
            url: '/api/deploy/projects/' + encodeURIComponent(project.id) + '/branch',
            body: { branch: branch },
            label: 'branch',
            errorFor: branchError,
            report: consoleNote
        })
            .then(function (res) {
                btn.disabled = !isAdmin;
                if (res.data && res.data.success) return loadProjects();
                return undefined;
            })
            .catch(function (e) {
                btn.disabled = !isAdmin;
                console.error('[Deploy] branch change failed:', e);
            });
    }

    /**
     * What the application wrote, read-only.
     *
     * Every folder a project owns is rebuilt by a deployment except `data/`, so
     * that is the one an application keeps anything in and the only one this
     * panel looks at. Three levels, each replacing the one below it rather than
     * stacking panes: the files, then one file's tables, then a page of rows.
     *
     * Nothing here writes. That is said on the panel and not only meant: the
     * backend opens the file read-only and builds every statement itself from a
     * table name and a column name, so there is no path from this page to a
     * change even if this page were wrong.
     *
     * State lives on the panel rather than in the hash. A table and a page
     * number are where somebody got to while reading, not a place to send a
     * colleague, and putting them in the URL would make every sort a history
     * entry to press Back through.
     */
    function dataPanel(project) {
        var wrap = el('div', 'dep-block');
        wrap.appendChild(el('h2', 'dep-subtitle', tr('deploy_data_title', 'Data')));
        wrap.appendChild(el('p', 'dep-hint', tr('deploy_data_body',
            'The one folder a deployment does not touch. Everything else a project owns is rebuilt by the next push; this is where an application keeps what it has to remember. Read-only here: Aegis opens these files without write access.')));

        var note = el('p', 'dep-note', '');
        note.hidden = true;
        var body = el('div', 'dep-data-body');
        wrap.appendChild(note);
        wrap.appendChild(body);

        function say(msg) {
            note.hidden = !msg;
            note.textContent = msg || '';
        }

        function fail(e) {
            var entry = DATA_ERRORS[(e && e.code) || ''] ||
                ['deploy_data_failed', 'Aegis could not read this folder.'];
            say(tr(entry[0], entry[1]));
        }

        function get(url) {
            return window.api(url)
                .then(function (r) { return readJson(r, url); })
                .then(function (d) {
                    if (!(d && d.success)) {
                        throw Object.assign(new Error('refused'), { code: d && d.error });
                    }
                    return d;
                });
        }

        var base = '/api/deploy/projects/' + encodeURIComponent(project.id) + '/data';

        // --- level 1: the files -------------------------------------------

        function showFiles() {
            say('');
            body.textContent = '';
            body.appendChild(el('p', 'dep-empty', tr('deploy_data_loading', 'Reading the folder.')));

            get(base).then(function (d) {
                body.textContent = '';
                var files = d.files || [];
                if (!files.length) {
                    body.appendChild(el('p', 'dep-empty', d.writable
                        ? tr('deploy_data_none',
                            'Nothing here yet. The application is given the folder as $1; a database it creates there survives every deployment.')
                            .replace('$1', d.variable || 'AEGIS_DATA_DIR')
                        : tr('deploy_data_static',
                            'This project serves files and runs no process, so nothing on this server can write here. A project served by a process is given the folder as $1.')
                            .replace('$1', d.variable || 'AEGIS_DATA_DIR')));
                    return;
                }

                var rows = el('div', 'dep-rows');
                files.forEach(function (f) {
                    var line = el('div', 'dep-listrow');
                    var main = el('div', 'dep-listrow-main');
                    main.appendChild(el('span', 'dep-listrow-name', f.name));
                    main.appendChild(el('span', 'dep-listrow-sub',
                        [f.bytes === null ? null : bytes(f.bytes),
                        f.modified ? ago(f.modified) : null]
                            .filter(Boolean).join(' · ')));
                    line.appendChild(main);

                    if (f.isDatabase) {
                        var open = el('button', 'dep-btn dep-btn-ghost dep-btn-small',
                            tr('deploy_data_open', 'Open'));
                        open.type = 'button';
                        open.addEventListener('click', function () { showTables(f.name); });
                        line.appendChild(open);
                    } else {
                        // Listed rather than hidden: an operator hunting for a
                        // table they cannot find learns more from seeing that
                        // the application wrote app.db.tmp than from an empty
                        // pane that says nothing at all.
                        line.appendChild(el('span', 'dep-listrow-sub',
                            tr('deploy_data_not_db', 'not a database')));
                    }
                    rows.appendChild(line);
                });
                body.appendChild(rows);
            }).catch(fail);
        }

        // --- level 2: one file's tables -----------------------------------

        function showTables(file) {
            say('');
            body.textContent = '';
            body.appendChild(crumbs([[tr('deploy_data_crumb_files', 'Files'), showFiles]], file));
            body.appendChild(el('p', 'dep-empty', tr('deploy_data_loading', 'Reading the folder.')));

            get(base + '/' + encodeURIComponent(file)).then(function (d) {
                body.textContent = '';
                body.appendChild(crumbs([[tr('deploy_data_crumb_files', 'Files'), showFiles]], file));

                var tables = d.tables || [];
                if (!tables.length) {
                    body.appendChild(el('p', 'dep-empty',
                        tr('deploy_data_no_tables', 'This database has no tables yet.')));
                    return;
                }
                var rows = el('div', 'dep-rows');
                tables.forEach(function (t) {
                    var line = el('div', 'dep-listrow');
                    var main = el('div', 'dep-listrow-main');
                    main.appendChild(el('span', 'dep-listrow-name', t.name));
                    main.appendChild(el('span', 'dep-listrow-sub',
                        [t.type === 'view' ? tr('deploy_data_view', 'view') : null,
                        t.rows === null ? null : tr('deploy_data_rows', '$1 rows')
                            .replace('$1', String(t.rows)),
                        (t.columns || []).map(function (c) { return c.name; }).join(', ')]
                            .filter(Boolean).join(' · ')));
                    line.appendChild(main);

                    var open = el('button', 'dep-btn dep-btn-ghost dep-btn-small',
                        tr('deploy_data_open', 'Open'));
                    open.type = 'button';
                    open.addEventListener('click', function () {
                        showRows(file, t.name, { offset: 0, order: '', dir: 'asc' });
                    });
                    line.appendChild(open);
                    rows.appendChild(line);
                });
                body.appendChild(rows);
            }).catch(fail);
        }

        // --- level 3: a page of rows --------------------------------------

        function showRows(file, table, view) {
            say('');
            var url = base + '/' + encodeURIComponent(file) + '/rows' +
                '?table=' + encodeURIComponent(table) +
                '&offset=' + encodeURIComponent(view.offset) +
                (view.order ? '&order=' + encodeURIComponent(view.order) +
                    '&dir=' + encodeURIComponent(view.dir) : '');

            get(url).then(function (d) {
                body.textContent = '';
                body.appendChild(crumbs([
                    [tr('deploy_data_crumb_files', 'Files'), showFiles],
                    [file, function () { showTables(file); }]
                ], table));

                if (!d.rows.length) {
                    body.appendChild(el('p', 'dep-empty',
                        tr('deploy_data_empty_table', 'This table has no rows.')));
                    return;
                }

                var scroll = el('div', 'dep-data-scroll');
                var t = el('table', 'dep-data-table');
                var head = el('tr', '');
                d.columns.forEach(function (name) {
                    var th = el('th', '');
                    var sort = el('button', 'dep-data-sort', name);
                    sort.type = 'button';
                    if (view.order === name) {
                        th.className = 'is-sorted';
                        sort.appendChild(el('span', 'dep-data-dir',
                            view.dir === 'desc' ? '▾' : '▴'));
                    }
                    sort.addEventListener('click', function () {
                        // Clicking the column already sorted reverses it, which
                        // is the one thing every table in the world does.
                        showRows(file, table, {
                            offset: 0,
                            order: name,
                            dir: view.order === name && view.dir === 'asc' ? 'desc' : 'asc'
                        });
                    });
                    th.appendChild(sort);
                    head.appendChild(th);
                });
                t.appendChild(el('thead', '')).appendChild(head);

                var tbody = el('tbody', '');
                d.rows.forEach(function (row) {
                    var tr_ = el('tr', '');
                    row.forEach(function (value) { tr_.appendChild(dataCell(value)); });
                    tbody.appendChild(tr_);
                });
                t.appendChild(tbody);
                scroll.appendChild(t);
                body.appendChild(scroll);

                body.appendChild(pager(d, function (offset) {
                    showRows(file, table, { offset: offset, order: view.order, dir: view.dir });
                }));
            }).catch(fail);
        }

        showFiles();
        return wrap;
    }

    /** A trail back up the three levels, the last one being where you are. */
    function crumbs(steps, here) {
        var nav = el('nav', 'dep-data-crumbs');
        steps.forEach(function (step) {
            var b = el('button', 'dep-data-crumb', step[0]);
            b.type = 'button';
            b.addEventListener('click', step[1]);
            nav.appendChild(b);
            nav.appendChild(el('span', 'dep-data-sep', '›'));
        });
        nav.appendChild(el('span', 'dep-data-here', here));
        return nav;
    }

    /**
     * One cell.
     *
     * The backend sends a plain value for anything it could send whole, and a
     * tagged object for the two it could not: a BLOB, which would be a wall of
     * mojibake, and text past its cap. Tagged rather than turned into a
     * sentence server-side, because a column of real text could otherwise hold
     * something indistinguishable from the sentence.
     *
     * `null` gets its own token. In a table of data the difference between no
     * value and the empty string is usually the thing being looked for.
     */
    function dataCell(value) {
        var td = el('td', '');
        if (value === null) {
            td.appendChild(el('span', 'dep-data-null', 'null'));
            return td;
        }
        if (typeof value === 'object') {
            if (value.aegis === 'blob') {
                td.appendChild(el('span', 'dep-data-blob',
                    tr('deploy_data_blob', 'binary, $1').replace('$1', bytes(value.bytes))));
                return td;
            }
            if (value.aegis === 'text') {
                td.textContent = value.shown;
                td.appendChild(el('span', 'dep-data-cut',
                    tr('deploy_data_cut', ' cut, $1 characters in all')
                        .replace('$1', String(value.length))));
                return td;
            }
        }
        td.textContent = String(value);
        return td;
    }

    /** Previous, where you are, next. Hidden when one page is the whole table. */
    function pager(d, go) {
        var box = el('div', 'dep-data-pager');
        var last = d.total === null ? null : Math.max(Math.ceil(d.total / d.limit), 1);
        var here = Math.floor(d.offset / d.limit) + 1;

        var back = el('button', 'dep-btn dep-btn-ghost dep-btn-small',
            tr('deploy_data_prev', 'Previous'));
        back.type = 'button';
        back.disabled = d.offset <= 0;
        back.addEventListener('click', function () { go(Math.max(d.offset - d.limit, 0)); });

        var on = el('button', 'dep-btn dep-btn-ghost dep-btn-small',
            tr('deploy_data_next', 'Next'));
        on.type = 'button';
        on.disabled = d.total !== null && d.offset + d.limit >= d.total;
        on.addEventListener('click', function () { go(d.offset + d.limit); });

        box.appendChild(back);
        box.appendChild(el('span', 'dep-data-count', last === null
            ? tr('deploy_data_page', 'Page $1').replace('$1', String(here))
            : tr('deploy_data_page_of', 'Page $1 of $2, $3 rows')
                .replace('$1', String(here)).replace('$2', String(last))
                .replace('$3', String(d.total))));
        box.appendChild(on);
        return box;
    }

    /** A size somebody reads, not a number of bytes they have to count. */
    function bytes(n) {
        if (n === null || n === undefined) return '';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' kB';
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    /** What the data routes refuse, and why. */
    var DATA_ERRORS = {
        bad_file: ['deploy_data_bad_file', 'That is not a file name Aegis will open in this folder.'],
        unknown_file: ['deploy_data_gone', 'That file is no longer in the folder. Go back and read it again.'],
        not_a_database: ['deploy_data_not_sqlite', 'SQLite will not open that file. It is not a database, or it was caught half written.'],
        unknown_table: ['deploy_data_no_table', 'That table is not in this database any more.'],
        bad_order: ['deploy_data_bad_order', 'That column is not in this table.'],
        db_busy: ['deploy_data_busy', 'The application is holding the database. Try again in a moment.'],
        reader_unavailable: ['deploy_data_no_reader', 'This server cannot read databases. Its Aegis core is older than the Deploy extension.'],
        unknown_project: ['deploy_err_unknown_project', 'That site no longer exists. Reload the page.'],
        db_read_failed: ['deploy_data_failed', 'Aegis could not read this folder.']
    };

    /** The refusals only the branch change can produce, then the shared table. */
    function branchError(code) {
        var own = {
            branch_unchanged: ['deploy_branch_same', 'That is the branch this project already serves.'],
            branch_is_preview: ['deploy_branch_is_preview',
                'A preview of this project already deploys that branch. Remove the preview first, or pick another branch.'],
            preview_branch_fixed: ['deploy_branch_preview_fixed',
                'A preview is its branch. Remove it and deploy the other branch as a new preview.'],
            // Distinct from the shared `branch_gone`, which is the poller saying
            // a branch that used to be there went away. Here the branch was
            // typed a moment ago and GitHub has never had it.
            branch_gone: ['deploy_branch_missing', 'GitHub has no such branch on this repository.'],
            settings_write_failed: ['deploy_branch_write_failed',
                'The project record could not be written, so the branch was not changed.']
        }[code];
        return own || DEPLOY_ERRORS[code] ||
            ['deploy_branch_failed', 'Aegis could not move this project to that branch.'];
    }

    function removePreview(project, preview, btn, note) {
        var question = tr('deploy_previews_remove_confirm',
            'Remove the $1 preview? Its files on this server, its port and every session open on it go with it. The branch on GitHub is not touched.')
            .replace('$1', preview.branch);
        if (!window.confirm(question)) return;

        btn.disabled = true;
        note.hidden = false;
        note.textContent = tr('deploy_auth_working', 'Saving.');
        window.api('/api/deploy/projects/' + encodeURIComponent(preview.id), { method: 'DELETE' })
            .then(function (r) { return readJson(r, 'preview delete'); })
            .then(function (data) {
                btn.disabled = !isAdmin;
                if (data && data.success) {
                    return loadProjects().then(function () { renderDetail(project.id, readHash().sub); });
                }
                note.textContent = data && data.error === 'busy'
                    ? tr('deploy_delete_busy', 'That project is deploying. Try again in a moment.')
                    : tr('deploy_previews_failed', 'Aegis could not deploy that branch.');
                return undefined;
            })
            .catch(function (e) {
                btn.disabled = !isAdmin;
                note.textContent = tr('deploy_auth_unreachable',
                    'Aegis did not answer. Check the backend is running, then reload this page.');
                console.error('[Deploy] preview delete failed:', e);
            });
    }

    // --- Environment variables ---------------------------------------------

    /**
     * The variables the install and build commands will read.
     *
     * Write-only, and the panel says so rather than showing a masked field that
     * looks like it could be revealed. The backend never sends a value back:
     * one is replaced by typing a new one, which is also what an operator does
     * with a value they cannot remember.
     *
     * Saved values change nothing until the next build reads them, so the note
     * after a save says that out loud. Getting this wrong looks like a variable
     * that did not save.
     */
    var ENV_TARGETS = [
        ['all', 'deploy_env_target_all', 'Every deployment'],
        ['production', 'deploy_env_target_prod', 'Production'],
        ['preview', 'deploy_env_target_preview', 'Previews']
    ];

    var ENV_ERRORS = {
        bad_env_key: ['deploy_env_err_key',
            'A name takes letters, digits and underscore, and does not start with a digit.'],
        reserved_env_key: ['deploy_env_err_reserved',
            'That name is set by Aegis or by the build sandbox, so a project cannot take it.'],
        env_value_too_long: ['deploy_env_err_long', 'That value is longer than 4096 characters.'],
        env_too_many: ['deploy_env_err_many', 'A project holds at most 50 variables.'],
        bad_env_target: ['deploy_env_err_target', 'Pick where the variable applies.'],
        no_entries: ['deploy_env_err_empty', 'Fill in a name before saving.'],
        unknown_env_key: ['deploy_env_err_gone', 'That variable is already gone. Reload the page.'],
        env_write_failed: ['deploy_env_err_write',
            'Aegis could not write the project record. The backend log has the detail.']
    };

    function envErrorText(code) {
        var known = ENV_ERRORS[code];
        return known ? tr(known[0], known[1])
            : tr('deploy_env_failed', 'Aegis refused that. The backend log has the detail.');
    }

    function targetLabel(target) {
        for (var i = 0; i < ENV_TARGETS.length; i++) {
            if (ENV_TARGETS[i][0] === target) return tr(ENV_TARGETS[i][1], ENV_TARGETS[i][2]);
        }
        return target || '';
    }

    function envPanel(project) {
        var block = el('div', 'dep-env');
        block.appendChild(el('h2', 'dep-subtitle', tr('deploy_env_title', 'Environment variables')));
        block.appendChild(el('p', 'dep-hint', tr('deploy_env_body',
            'Read by the install and build commands, never by the site. Aegis keeps each value encrypted and no page reads one back, so a value nobody remembers is replaced rather than shown.')));

        var rows = el('div', 'dep-rows');
        block.appendChild(rows);
        var empty = el('p', 'dep-empty', tr('deploy_env_none', 'No variable on this project.'));
        empty.hidden = true;
        block.appendChild(empty);

        var note = el('p', 'dep-note', '');
        note.hidden = true;

        var form = el('div', 'dep-env-form');
        var keyIn = el('input', 'dep-input dep-env-key');
        keyIn.type = 'text';
        keyIn.autocomplete = 'off';
        keyIn.spellcheck = false;
        keyIn.placeholder = tr('deploy_env_key', 'Name');
        keyIn.setAttribute('aria-label', tr('deploy_env_key', 'Name'));

        var valueIn = el('input', 'dep-input dep-env-value');
        valueIn.type = 'text';
        valueIn.autocomplete = 'off';
        valueIn.spellcheck = false;
        valueIn.placeholder = tr('deploy_env_value', 'Value');
        valueIn.setAttribute('aria-label', tr('deploy_env_value', 'Value'));

        var targetIn = el('select', 'dep-select dep-env-target');
        targetIn.setAttribute('aria-label', tr('deploy_env_target', 'Applies to'));
        ENV_TARGETS.forEach(function (entry) {
            var option = el('option', '', tr(entry[1], entry[2]));
            option.value = entry[0];
            targetIn.appendChild(option);
        });

        var add = el('button', 'dep-btn dep-btn-small', tr('deploy_env_add', 'Add'));
        add.type = 'button';
        add.disabled = !isAdmin;

        form.appendChild(keyIn);
        form.appendChild(valueIn);
        form.appendChild(targetIn);
        form.appendChild(add);
        block.appendChild(form);
        block.appendChild(note);

        var state = { builds: !!project.buildCmd };

        function paint(list) {
            rows.textContent = '';
            empty.hidden = !!(list && list.length);
            (list || []).forEach(function (entry) {
                var line = el('div', 'dep-listrow');
                var main = el('div', 'dep-listrow-main');
                main.appendChild(el('code', 'dep-code', entry.key));
                main.appendChild(el('span', 'dep-listrow-sub',
                    [targetLabel(entry.target), ago(entry.updatedAt)].filter(Boolean).join(' · ')));
                line.appendChild(main);

                var drop = el('button', 'dep-btn dep-btn-ghost dep-btn-small dep-btn-danger');
                drop.type = 'button';
                drop.disabled = !isAdmin;
                drop.appendChild(binIcon());
                drop.setAttribute('aria-label',
                    tr('deploy_env_remove', 'Remove $1').replace('$1', entry.key));
                drop.addEventListener('click', function () { removeVar(entry.key, drop); });
                line.appendChild(drop);
                rows.appendChild(line);
            });
        }

        function say(text) {
            note.hidden = false;
            note.textContent = text;
        }

        function savedText() {
            return state.builds
                ? tr('deploy_env_saved',
                    'Saved. The next build reads it, so deploy the latest commit to apply it now.')
                : tr('deploy_env_saved_nobuild',
                    'Saved. This project runs no build command, so nothing reads it yet.');
        }

        function unreachable() {
            return tr('deploy_auth_unreachable',
                'Aegis did not answer. Check the backend is running, then reload this page.');
        }

        function load() {
            window.api('/api/deploy/projects/' + encodeURIComponent(project.id) + '/env')
                .then(function (r) { return readJson(r, 'env'); })
                .then(function (data) {
                    if (!data || !data.success) return;
                    state.builds = !!data.builds;
                    paint(data.env);
                })
                .catch(function (e) {
                    say(unreachable());
                    console.error('[Deploy] env load failed:', e);
                });
        }

        function saveVar() {
            var key = keyIn.value.trim();
            if (!key) {
                say(envErrorText('no_entries'));
                keyIn.focus();
                return;
            }
            add.disabled = true;
            say(tr('deploy_auth_working', 'Saving.'));
            window.api('/api/deploy/projects/' + encodeURIComponent(project.id) + '/env', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    entries: [{ key: key, value: valueIn.value, target: targetIn.value }]
                })
            })
                .then(function (r) { return readJson(r, 'env save'); })
                .then(function (data) {
                    add.disabled = !isAdmin;
                    if (!data || !data.success) {
                        say(envErrorText(data && data.error));
                        return;
                    }
                    paint(data.env);
                    // Cleared on success only: a refused entry keeps its value
                    // in the field, so a typo in the name does not cost the
                    // paste.
                    keyIn.value = '';
                    valueIn.value = '';
                    say(savedText());
                })
                .catch(function (e) {
                    add.disabled = !isAdmin;
                    say(unreachable());
                    console.error('[Deploy] env save failed:', e);
                });
        }

        function removeVar(key, btn) {
            var question = tr('deploy_env_remove_confirm',
                'Remove $1 from this project? The next build runs without it.').replace('$1', key);
            if (!window.confirm(question)) return;

            btn.disabled = true;
            say(tr('deploy_auth_working', 'Saving.'));
            window.api('/api/deploy/projects/' + encodeURIComponent(project.id) +
                '/env/' + encodeURIComponent(key), { method: 'DELETE' })
                .then(function (r) { return readJson(r, 'env remove'); })
                .then(function (data) {
                    if (!data || !data.success) {
                        btn.disabled = !isAdmin;
                        say(envErrorText(data && data.error));
                        return;
                    }
                    paint(data.env);
                    say(savedText());
                })
                .catch(function (e) {
                    btn.disabled = !isAdmin;
                    say(unreachable());
                    console.error('[Deploy] env remove failed:', e);
                });
        }

        add.addEventListener('click', saveVar);
        // Enter in either field saves. Three fields and a button read as a form,
        // and behaving like one costs two listeners.
        [keyIn, valueIn].forEach(function (field) {
            field.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && isAdmin) saveVar();
            });
        });

        load();
        return block;
    }

    // --- The three install-wide panes --------------------------------------

    /**
     * Every project's variables, on one page.
     *
     * Vercel keeps shared variables at the team level and per-project ones on
     * the project. Aegis has only the second kind -- a variable belongs to the
     * build of one project -- so this pane is that list grouped rather than a
     * second store with its own rules. The panel it draws per project is the
     * same one the project page uses, so there is one implementation of "add a
     * variable" and not two.
     */
    function renderEnvPane() {
        var box = document.getElementById('deploy-env-pane');
        if (!box) return;
        box.textContent = '';

        var live = projects.filter(function (p) { return !p.parentId; });
        if (!live.length) {
            box.appendChild(el('p', 'dep-empty', tr('deploy_env_pane_none',
                'No project yet. Variables belong to a project and its build.')));
            return;
        }

        live.forEach(function (project) {
            var group = el('section', 'dep-card-block');
            var head = el('div', 'dep-block-head');
            var name = el('a', 'dep-subtitle', project.name);
            name.href = '#project/' + encodeURIComponent(project.id) + '/env';
            head.appendChild(name);
            head.appendChild(el('span', 'dep-listrow-sub',
                project.buildCmd
                    ? tr('deploy_env_pane_builds', 'read by its build')
                    : tr('deploy_env_pane_nobuild', 'no build command, nothing reads them yet')));
            group.appendChild(head);
            group.appendChild(envPanel(project));
            box.appendChild(group);
        });
    }

    /**
     * Where every deployed site answers, by port and by name.
     *
     * The port column is the one that always works, and saying so on the same
     * row as the name is the point: a name only resolves once somebody has added
     * the DNS record, and this page cannot know whether they have.
     */
    function renderDomainsPane() {
        var box = document.getElementById('deploy-domains-pane');
        if (!box) return;
        box.textContent = '';

        var all = [];
        projects.forEach(function (project) {
            all.push(project);
            (project.previews || []).forEach(function (preview) { all.push(preview); });
        });

        var router = all.length ? all[0].routerPort : null;
        box.appendChild(el('p', 'dep-hint', router
            ? tr('deploy_domains_router_on',
                'The shared listener answers on port $1.').replace('$1', String(router))
            : tr('deploy_domains_router_off',
                'The shared listener is off. Set AEGIS_SITES_ROUTER_PORT on the host for names to answer at all.')));

        if (!all.length) {
            box.appendChild(el('p', 'dep-empty', tr('deploy_domains_pane_none', 'Nothing is deployed yet.')));
            return;
        }

        var rows = el('div', 'dep-rows');
        all.forEach(function (project) {
            var line = el('div', 'dep-listrow');
            var main = el('div', 'dep-listrow-main');
            var name = el('a', 'dep-listrow-name', project.name);
            name.href = '#project/' + encodeURIComponent(project.id) +
                (project.parentId ? '/overview' : '/domains');
            main.appendChild(name);
            main.appendChild(el('span', 'dep-listrow-sub dep-mono',
                [project.url, project.hostUrl].filter(Boolean).join('  ·  ') ||
                tr('deploy_domains_none', 'no name set')));
            line.appendChild(main);
            if (project.hostname) line.appendChild(el('code', 'dep-code', project.hostname));
            else line.appendChild(el('span', 'dep-listrow-sub', tr('deploy_domains_none', 'no name set')));
            rows.appendChild(line);
        });
        box.appendChild(rows);
    }

    /**
     * What the install is holding, and which of it runs out.
     *
     * Counted from the project list the page already has rather than from a new
     * route: everything here is one field per project, and a second source for
     * it is a second thing to keep true.
     */
    function renderUsagePane() {
        var box = document.getElementById('deploy-usage-pane');
        if (!box) return;
        box.textContent = '';

        var live = projects.filter(function (p) { return !p.parentId; });
        var previews = [];
        var releases = 0;
        var variables = 0;
        var processes = 0;
        projects.forEach(function (project) {
            (project.previews || []).forEach(function (preview) { previews.push(preview); });
        });
        live.concat(previews).forEach(function (project) {
            releases += (project.releases || []).length;
            variables += project.envCount || 0;
            if (project.runtime === 'node') processes += 1;
        });

        var ports = live.length + previews.length;
        var tiles = [
            [tr('deploy_usage_projects', 'Projects'), String(live.length), ''],
            [tr('deploy_usage_previews', 'Previews'), String(previews.length),
                tr('deploy_usage_previews_note', 'removed after seven days unused')],
            [tr('deploy_usage_ports', 'Ports taken'), ports + ' / 100',
                tr('deploy_usage_ports_note', 'one per site, the range is a hundred wide')],
            [tr('deploy_usage_releases', 'Versions on disk'), String(releases),
                tr('deploy_usage_releases_note', 'five kept per site')],
            [tr('deploy_usage_variables', 'Variables'), String(variables), ''],
            [tr('deploy_usage_processes', 'Projects with a process'), String(processes),
                tr('deploy_usage_processes_note', 'one runtime account each')]
        ];

        var grid = el('div', 'dep-usage');
        tiles.forEach(function (tile) {
            var cell = el('div', 'dep-usage-tile');
            cell.appendChild(el('span', 'dep-meta-key', tile[0]));
            cell.appendChild(el('span', 'dep-usage-value', tile[1]));
            if (tile[2]) cell.appendChild(el('span', 'dep-listrow-sub', tile[2]));
            grid.appendChild(cell);
        });
        box.appendChild(grid);
    }

    // --- Refusal codes ------------------------------------------------------

    /**
     * Which refusals the reference lists, and in what order.
     *
     * Both sentences come from DEPLOY_ERRORS, so a code cannot mean one thing
     * here and another on a card. What this array carries is the part that is
     * not a fact about the code: which of them an operator is sent here to look
     * up, ordered from what they typed towards what the host could not do. The
     * codes DEPLOY_ERRORS holds but this omits are ones no operator reads out
     * of a failed deployment, so listing them would pad the page.
     *
     * A code named here without a short label in DEPLOY_ERRORS is skipped
     * rather than drawn half-empty.
     */
    var REFUSAL_ORDER = [
        'bad_repo_url', 'needs_install', 'repo_not_found', 'bad_branch', 'needs_build',
        'no_index', 'no_root_dir', 'bad_root_dir', 'unsafe_symlink', 'bad_site_config',
        'no_free_port', 'deploy_failed', 'build_failed', 'build_account_unconfigured',
        'tool_missing', 'github_auth_failed', 'github_unreachable', 'busy', 'branch_gone'
    ];

    var refusalsPainted = false;

    function renderRefusals() {
        if (refusalsPainted) return;
        var box = document.getElementById('deploy-refusal-list');
        if (!box) return;
        box.textContent = '';
        REFUSAL_ORDER.forEach(function (code) {
            var entry = DEPLOY_ERRORS[code];
            if (!entry || !entry[2]) return;
            var wrap = el('div', 'dep-listrow');
            wrap.appendChild(el('code', 'dep-code', code));
            var main = el('div', 'dep-listrow-main');
            main.appendChild(el('span', 'dep-listrow-name', tr(entry[2], entry[3])));
            main.appendChild(el('span', 'dep-listrow-sub', tr(entry[0], entry[1])));
            wrap.appendChild(main);
            box.appendChild(wrap);
        });
        refusalsPainted = true;
    }

    // --- Directory authentication -----------------------------------------

    /**
     * The directory settings panel, opened from the gear menu.
     *
     * A deployed site is served in the clear on its own port, so this is the
     * only place in the extension that decides who may read one. It is two
     * halves: the directory itself, configured once, and one row per deployed
     * site saying whether that site asks for a login and which groups pass.
     *
     * The bind password never comes back from the server. When one is stored the
     * field shows a mask, and the mask is never sent: the field is only put in
     * the payload once the operator has typed in it. The backend also treats the
     * mask as "keep the existing one", but relying on that alone would mean a
     * saved password rides across the wire on every unrelated edit.
     */
    var PASSWORD_MASK = '••••••••';

    /**
     * Example certificate paths, shown as placeholders and never sent.
     *
     * Windows paths because that is where Aegis is installed, and absolute
     * because the route refuses anything else: a relative path would resolve
     * against the backend's working directory rather than where the operator
     * thinks they are pointing.
     */
    var CERT_PLACEHOLDER = 'C:\\ProgramData\\Aegis\\certs\\site.crt';
    var KEY_PLACEHOLDER = 'C:\\ProgramData\\Aegis\\certs\\site.key';

    var authLoaded = false;
    var bindPasswordTouched = false;

    // One code, one thing to change. A directory that refuses the service
    // account and a directory that cannot be reached at all need different
    // moves from the operator, and "authentication failed" would cover both.
    /**
     * The authentication methods this page can label, and the key each label
     * lives under.
     *
     * The backend sends the vocabulary it can serve; this table says how to
     * name each entry. A method the backend offers and this table has no row
     * for is still listed, under its own identifier, rather than dropped: a
     * selector that hides an option the server accepts is a selector the
     * operator cannot use to undo what somebody else set.
     */
    var AUTH_METHOD_LABELS = {
        none: ['deploy_auth_method_none', 'None. Serve this site to anyone who can reach it'],
        ldap: ['deploy_auth_method_ldap', 'Directory login (LDAP / Active Directory)']
    };

    /** Every method the backend last said it could serve. */
    var authMethods = ['none', 'ldap'];

    function authMethodLabel(method) {
        var entry = AUTH_METHOD_LABELS[method];
        return entry ? tr(entry[0], entry[1]) : method;
    }

    var AUTH_ERRORS = {
        bad_auth_method: ['deploy_auth_err_bad_method', 'Aegis does not know that authentication method. Reload the page and pick one from the list.'],
        ldap_not_configured: ['deploy_auth_err_not_configured', 'No directory is configured yet. Fill in the address and the search base, then save.'],
        bad_ldap_url: ['deploy_auth_err_bad_url', 'The directory address must start with ldap:// or ldaps://, for example ldaps://dc01.corp.local:636.'],
        bad_base_dn: ['deploy_auth_err_bad_base', 'The search base is empty or holds a character the directory will not accept. It looks like DC=corp,DC=local.'],
        bad_user_filter: ['deploy_auth_err_bad_filter', 'The user filter must contain {username} and have balanced parentheses.'],
        bad_allowed_groups: ['deploy_auth_err_bad_groups', 'That is too many groups, or one of them is too long. Keep it to 64 entries of 512 characters each.'],
        unknown_project: ['deploy_err_unknown_project', 'That site no longer exists. Reload the page.'],
        ldap_unreachable: ['deploy_auth_err_unreachable', 'Aegis could not reach the directory. Check the address and the port, and that this server may open that connection.'],
        ldap_timeout: ['deploy_auth_err_timeout', 'The directory did not answer in time. It may be down, or a firewall may be dropping the connection instead of refusing it.'],
        ldap_tls_failed: ['deploy_auth_err_tls', 'The encrypted connection to the directory could not be established. Check that the port really speaks LDAPS, and that nothing between this server and the controller is intercepting the connection.'],
        ldap_tls_untrusted: ['deploy_auth_err_tls_untrusted', 'The controller presented a certificate from an authority this server does not know. Its details are below: check the fingerprint against your own certificate authority, then trust it.'],
        ldap_tls_name_mismatch: ['deploy_auth_err_tls_name', 'The certificate is valid, but it was issued for another name than the address above. The name it carries is below.'],
        ldap_tls_expired: ['deploy_auth_err_tls_expired', 'The controller certificate is expired or not yet valid. Renew it on the controller, or check this server clock. Nothing on this page can repair it.'],
        ldap_not_tls: ['deploy_auth_err_not_tls', 'This directory is configured without encryption, so there is no certificate to look at. Switch the address to ldaps:// or tick StartTLS.'],
        bad_fingerprint: ['deploy_auth_err_bad_fingerprint', 'That fingerprint is not readable. Reload the page and look at the certificate again.'],
        certificate_changed: ['deploy_auth_err_cert_changed', 'The controller is now presenting a different certificate than the one shown, so nothing was trusted. Look at it again before deciding.'],
        bad_certificate: ['deploy_auth_err_bad_cert', 'Aegis could not read that certificate and stored nothing.'],
        ldap_bind_refused: ['deploy_auth_err_bind_refused', 'The directory refused the service account. Check the bind DN and its password.'],
        ldap_user_not_found: ['deploy_auth_err_user_not_found', 'The directory has no account matching that name under the search base. Check the base and the user filter.'],
        ldap_invalid_credentials: ['deploy_auth_err_bad_credentials', 'The directory refused that account and password.'],
        ldap_ambiguous_user: ['deploy_auth_err_ambiguous', 'That name matches more than one account. Narrow the user filter so it can only ever match one.'],
        ldap_protocol_error: ['deploy_auth_err_protocol', 'The directory answered something Aegis could not read. Check that the address really points at an LDAP service.'],
        ldap_bad_config: ['deploy_auth_err_bad_config', 'The stored directory settings are incomplete. Fill in the address and the search base, then save.'],
        deploy_not_enabled: ['deploy_auth_err_not_enabled', 'Deploy is switched off on this server, so there is nothing to protect yet.'],
        bad_revalidate_minutes: ['deploy_auth_bad_revalidate', 'The re-check interval has to be a whole number of minutes between 0 and 1440.'],
        bad_cert_path: ['deploy_tls_bad_cert_path', 'The certificate path has to be a full path on the Aegis host.'],
        bad_key_path: ['deploy_tls_bad_key_path', 'The private key path has to be a full path on the Aegis host.'],
        tls_cert_unreadable: ['deploy_tls_cert_unreadable', 'Aegis could not read the certificate or the key, so the site is stopped. Check both paths and that the Aegis service may read them.']
    };

    function authNote(msg) {
        var note = document.getElementById('deploy-auth-note');
        if (!note) return;
        note.textContent = msg;
        note.hidden = !msg;
    }

    /** The sentence for a refusal, falling back on the status when the code is new. */
    function authRefusal(data, status) {
        var entry = AUTH_ERRORS[data && data.error];
        if (entry) return tr(entry[0], entry[1]);
        if (status === 403) {
            return tr('deploy_auth_admin_only',
                'Only an administrator can change the authentication settings.');
        }
        return tr('deploy_auth_refused',
            'Aegis refused this change for a reason this page does not know: $1. The backend log has the detail.')
            .replace('$1', (data && data.error) || status);
    }

    function authField(id) { return document.getElementById(id); }

    /**
     * The chip beside the title: configured or not, and whether the last check
     * reached the directory.
     *
     * A form with eight fields and a Save button never said whether any of it
     * worked. The operator saved, read "Directory settings saved", and found out
     * at the next login attempt on a deployed site. One word at the top of the
     * pane answers the question the page is actually about.
     */
    function authState(state) {
        var chip = document.getElementById('deploy-auth-state');
        if (!chip) return;
        var LABELS = {
            none: ['deploy_auth_state_none', 'Not configured', 'is-idle'],
            untested: ['deploy_auth_state_untested', 'Saved, not checked', 'is-idle'],
            checking: ['deploy_auth_state_checking', 'Checking', 'is-running'],
            ok: ['deploy_auth_state_ok', 'Connected', 'is-live'],
            failed: ['deploy_auth_state_failed', 'Not reachable', 'is-failed']
        };
        var row = LABELS[state] || LABELS.none;
        chip.className = 'dep-pill ' + row[2];
        chip.setAttribute('data-i18n', row[0]);
        chip.textContent = tr(row[0], row[1]);
    }

    /**
     * The authorities this directory trusts on top of the machine store.
     *
     * Always on screen once something is pinned, not only after a failure. A
     * trust decision that becomes invisible the moment it works is a trust
     * decision nobody can review or undo, and this one was made in a hurry to
     * get a login working.
     */
    function renderPinned(list) {
        var box = document.getElementById('deploy-auth-pinned');
        if (!box) return;
        box.textContent = '';
        var pinned = list || [];
        box.hidden = !pinned.length;
        if (!pinned.length) return;

        box.appendChild(el('h4', 'dep-cert-title',
            tr('deploy_auth_pinned_title', 'Authorities trusted for this directory')));
        box.appendChild(el('p', 'dep-cert-body', tr('deploy_auth_pinned_body',
            'Validation of the controller certificate stays on, and these are accepted alongside the ones Windows already trusts on this server.')));

        pinned.forEach(function (cert) {
            var name = cert.subject || tr('deploy_auth_pinned_unreadable', 'Unreadable certificate');
            box.appendChild(el('div', 'dep-meta-value', name));
            if (cert.fingerprint256) box.appendChild(el('code', 'dep-cert-print', cert.fingerprint256));
            if (cert.expired) {
                box.appendChild(el('p', 'dep-cert-body', tr('deploy_auth_pinned_expired',
                    'This authority has expired. Trust the new one, then remove this.')));
            }
        });

        var drop = el('button', 'dep-btn dep-btn-ghost dep-btn-small',
            tr('deploy_auth_pinned_drop', 'Stop trusting these'));
        drop.type = 'button';
        drop.disabled = !isAdmin;
        drop.addEventListener('click', function () { unpinAuthorities(drop); });
        box.appendChild(drop);
    }

    /** Hides the certificate panel. Called whenever the answer stops being about one. */
    function hideCertificate() {
        var box = document.getElementById('deploy-auth-cert');
        if (box) { box.textContent = ''; box.hidden = true; }
    }

    function fillAuthForm(ldap) {
        var cfg = ldap || {};
        authField('deploy-auth-url').value = cfg.url || '';
        authField('deploy-auth-starttls').checked = !!cfg.startTls;
        // Certificate validation defaults to on, including on a fresh install
        // where the server sent nothing back: a first visit that quietly starts
        // with the check off is the wrong default to inherit.
        authField('deploy-auth-verify').checked = cfg.configured ? !!cfg.rejectUnauthorized : true;
        authField('deploy-auth-binddn').value = cfg.bindDn || '';
        authField('deploy-auth-basedn').value = cfg.baseDn || '';
        authField('deploy-auth-filter').value = cfg.userFilter || '';
        authField('deploy-auth-dntemplate').value = cfg.userDnTemplate || '';
        authField('deploy-auth-groupattr').value = cfg.groupAttribute || '';
        authField('deploy-auth-nested').checked = !!cfg.nestedGroups;
        // A stored 0 means "never re-check" and has to survive the round trip;
        // `|| ''` would turn it into an empty field, which the server then reads
        // as "not sent" and answers with the default of ten.
        authField('deploy-auth-revalidate').value =
            (cfg.revalidateMinutes === undefined || cfg.revalidateMinutes === null)
                ? '' : String(cfg.revalidateMinutes);

        var pw = authField('deploy-auth-bindpw');
        pw.value = cfg.hasPassword ? PASSWORD_MASK : '';
        bindPasswordTouched = false;

        renderPinned(cfg.trustedCa);
        authState(cfg.configured ? 'untested' : 'none');
        // The search base is required and is the one advanced field that cannot
        // always be guessed. Unfolding the section when it is empty is the
        // difference between a refusal pointing at a field and a refusal
        // pointing at a field nobody can see.
        if (!cfg.baseDn) openAdvanced();
    }

    /** Unfolds the advanced block, so a refusal can never name a hidden field. */
    function openAdvanced() {
        var more = document.getElementById('deploy-auth-advanced');
        if (more) more.open = true;
    }

    /** The refusals that are about a field the advanced block holds. */
    var ADVANCED_ERRORS = [
        'bad_base_dn', 'bad_user_filter', 'bad_user_dn_template',
        'bad_group_attribute', 'bad_revalidate_minutes'
    ];

    function showTestGroups(groups) {
        var box = document.getElementById('deploy-auth-groups');
        var title = document.getElementById('deploy-auth-groups-title');
        if (!box || !title) return;
        box.textContent = '';
        var list = groups || [];
        title.hidden = !list.length;
        for (var i = 0; i < list.length; i++) {
            box.appendChild(el('code', 'dep-row-fix', list[i]));
        }
    }

    /**
     * One row per deployed site.
     *
     * Protection is per site rather than global because the two sites an install
     * runs are rarely the same audience: an internal dashboard and a public
     * landing page live side by side on the same server.
     */
    function renderAuthSites(sites) {
        var box = document.getElementById('deploy-auth-sites');
        var empty = document.getElementById('deploy-auth-sites-empty');
        if (!box) return;
        box.textContent = '';
        var list = sites || [];
        if (empty) empty.hidden = !!list.length;

        list.forEach(function (site) {
            var wrap = el('div', 'dep-auth-site');
            wrap.appendChild(el('h4', 'dep-auth-site-name', site.name || site.id));

            // The method, chosen rather than switched on. A checkbox could only
            // ever say "the default one or nothing", which is what sent the
            // operator to a login form they had not picked.
            var methodLabel = el('label', 'dep-label', tr('deploy_auth_method', 'Authentication'));
            methodLabel.setAttribute('data-i18n', 'deploy_auth_method');
            methodLabel.htmlFor = 'deploy-auth-method-' + site.id;
            var methodSelect = document.createElement('select');
            methodSelect.className = 'dep-input';
            methodSelect.id = methodLabel.htmlFor;
            methodSelect.disabled = !isAdmin;

            var current = site.method || (site.protected ? 'ldap' : 'none');
            var offered = authMethods.slice();
            // A stored method this build no longer offers still has to appear,
            // or the selector would show the site as something it is not and
            // rewrite it that way on the next Apply.
            if (offered.indexOf(current) < 0) offered.push(current);
            offered.forEach(function (m) {
                var opt = document.createElement('option');
                opt.value = m;
                opt.textContent = authMethodLabel(m);
                // data-i18n as well as the text: the text paints it now, and
                // the attribute lets applyTranslations repaint it when the
                // language switches. A method with no label key carries its own
                // identifier, which is the same in every language.
                if (AUTH_METHOD_LABELS[m]) opt.setAttribute('data-i18n', AUTH_METHOD_LABELS[m][0]);
                if (m === current) opt.selected = true;
                methodSelect.appendChild(opt);
            });
            wrap.appendChild(methodLabel);
            wrap.appendChild(methodSelect);

            // Short label, sentence underneath: .dep-label is uppercase and
            // letter-spaced, which a whole sentence would be unreadable in.
            var groupsBlock = el('div', 'dep-auth-site-groups');
            var label = el('label', 'dep-label', tr('deploy_auth_allowed', 'Allowed groups'));
            label.setAttribute('data-i18n', 'deploy_auth_allowed');
            var groups = document.createElement('input');
            groups.type = 'text';
            groups.className = 'dep-input';
            groups.autocomplete = 'off';
            groups.spellcheck = false;
            groups.value = (site.allowedGroups || []).join(', ');
            groups.disabled = !isAdmin;
            label.htmlFor = 'deploy-auth-groups-' + site.id;
            groups.id = label.htmlFor;
            groupsBlock.appendChild(label);
            groupsBlock.appendChild(groups);
            var hint = el('p', 'dep-hint', tr('deploy_auth_allowed_hint',
                'Separated by commas. Empty means anyone the directory authenticates.'));
            hint.setAttribute('data-i18n', 'deploy_auth_allowed_hint');
            groupsBlock.appendChild(hint);
            wrap.appendChild(groupsBlock);

            // Groups belong to the directory and mean nothing under any other
            // method. Hidden rather than removed: the value stays typed, so
            // switching away and back does not cost the operator the list.
            function paintGroups() {
                groupsBlock.hidden = methodSelect.value !== 'ldap';
            }
            paintGroups();
            methodSelect.addEventListener('change', paintGroups);

            var apply = el('button', 'dep-btn dep-btn-ghost dep-btn-small', tr('deploy_auth_apply', 'Apply'));
            apply.setAttribute('data-i18n', 'deploy_auth_apply');
            apply.type = 'button';
            apply.disabled = !isAdmin;
            var note = el('p', 'dep-auth-site-note', '');
            note.hidden = true;
            apply.addEventListener('click', function () {
                saveSiteAuth(site, methodSelect, groups, apply, note);
            });
            wrap.appendChild(apply);
            wrap.appendChild(note);

            appendTlsBlock(wrap, site, methodSelect);

            box.appendChild(wrap);
        });
    }

    /**
     * The HTTPS half of a site's row.
     *
     * In the same row as the method because the two are one decision: a login
     * form on a plain HTTP port sends the password across the network in
     * clear, so protecting a site without encrypting it is a half measure the
     * operator should see named. The warning is painted from both controls
     * rather than only on load, so picking a method makes it appear at once.
     */
    function appendTlsBlock(wrap, site, methodSelect) {
        var tls = site.tls || {};

        var title = el('h5', 'dep-auth-site-sub', tr('deploy_tls_title', 'HTTPS'));
        title.setAttribute('data-i18n', 'deploy_tls_title');
        wrap.appendChild(title);

        var check = el('label', 'dep-check');
        var tlsBox = document.createElement('input');
        tlsBox.type = 'checkbox';
        tlsBox.checked = !!tls.enabled;
        tlsBox.disabled = !isAdmin;
        check.appendChild(tlsBox);
        var tlsText = el('span', '', tr('deploy_tls_enable', 'Serve this site over HTTPS'));
        tlsText.setAttribute('data-i18n', 'deploy_tls_enable');
        check.appendChild(tlsText);
        wrap.appendChild(check);

        var warn = el('p', 'dep-auth-site-warn', tr('deploy_tls_warn',
            'This site asks for a password on a plain HTTP port. The password and the session cookie cross the network in clear.'));
        warn.setAttribute('data-i18n', 'deploy_tls_warn');
        wrap.appendChild(warn);

        function paintWarn() {
            // Any method other than none asks for a credential, so any of them
            // is worth the warning. Written against the value rather than
            // against 'ldap' so a method added later is covered without an edit
            // here, which is the kind of omission nobody notices.
            warn.hidden = !(methodSelect.value !== 'none' && !tlsBox.checked);
        }
        paintWarn();
        methodSelect.addEventListener('change', paintWarn);
        tlsBox.addEventListener('change', paintWarn);

        var certLabel = el('label', 'dep-label', tr('deploy_tls_cert', 'Certificate file'));
        certLabel.setAttribute('data-i18n', 'deploy_tls_cert');
        certLabel.htmlFor = 'deploy-tls-cert-' + site.id;
        var cert = document.createElement('input');
        cert.type = 'text';
        cert.className = 'dep-input';
        cert.autocomplete = 'off';
        cert.spellcheck = false;
        cert.id = certLabel.htmlFor;
        cert.value = tls.certFile || '';
        cert.placeholder = CERT_PLACEHOLDER;
        cert.disabled = !isAdmin;
        wrap.appendChild(certLabel);
        wrap.appendChild(cert);

        var keyLabel = el('label', 'dep-label', tr('deploy_tls_key', 'Private key file'));
        keyLabel.setAttribute('data-i18n', 'deploy_tls_key');
        keyLabel.htmlFor = 'deploy-tls-key-' + site.id;
        var key = document.createElement('input');
        key.type = 'text';
        key.className = 'dep-input';
        key.autocomplete = 'off';
        key.spellcheck = false;
        key.id = keyLabel.htmlFor;
        key.value = tls.keyFile || '';
        key.placeholder = KEY_PLACEHOLDER;
        key.disabled = !isAdmin;
        wrap.appendChild(keyLabel);
        wrap.appendChild(key);

        var hint = el('p', 'dep-hint', tr('deploy_tls_hint',
            'Full paths on the Aegis host, readable by the Aegis service. Aegis reads them when the site starts, so a renewed certificate is picked up by saving this again. The site restarts on save and keeps its port.'));
        hint.setAttribute('data-i18n', 'deploy_tls_hint');
        wrap.appendChild(hint);

        var apply = el('button', 'dep-btn dep-btn-ghost dep-btn-small', tr('deploy_auth_apply', 'Apply'));
        apply.setAttribute('data-i18n', 'deploy_auth_apply');
        apply.type = 'button';
        apply.disabled = !isAdmin;
        var note = el('p', 'dep-auth-site-note', '');
        note.hidden = true;
        apply.addEventListener('click', function () {
            saveSiteTls(site, tlsBox, cert, key, apply, note);
        });
        wrap.appendChild(apply);
        wrap.appendChild(note);
    }

    function saveSiteTls(site, checkbox, certInput, keyInput, btn, note) {
        btn.disabled = true;
        note.hidden = false;
        note.textContent = tr('deploy_auth_working', 'Saving.');
        var status = 0;
        window.api('/api/deploy/projects/' + encodeURIComponent(site.id) + '/tls', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                enabled: !!checkbox.checked,
                certFile: certInput.value.trim(),
                keyFile: keyInput.value.trim()
            })
        })
            .then(function (r) { status = r.status; return readJson(r, 'project tls'); })
            .then(function (data) {
                btn.disabled = !isAdmin;
                if (data && data.success) {
                    site.tls = (data.project && data.project.tls) || site.tls;
                    note.textContent = tr('deploy_tls_applied',
                        'Saved. The site restarted on its new scheme.');
                    // The card in the list prints the URL, and its scheme just
                    // changed.
                    return loadProjects();
                }
                // The site is stopped in this one case, which is worth saying
                // rather than the generic refusal: nothing serves until it is
                // fixed.
                if (data && data.error === 'tls_cert_unreadable') {
                    site.tls = data.tls || site.tls;
                    note.textContent = tr('deploy_tls_cert_unreadable',
                        'Aegis could not read the certificate or the key, so the site is stopped. Check both paths and that the Aegis service may read them.');
                    return loadProjects();
                }
                note.textContent = authRefusal(data, status);
                return undefined;
            })
            .catch(function (e) {
                btn.disabled = !isAdmin;
                note.textContent = tr('deploy_auth_unreachable',
                    'Aegis did not answer. Check the backend is running, then reload this page.');
                console.error('[Deploy] project tls failed:', e);
            });
    }

    function saveSiteAuth(site, methodSelect, groupsInput, btn, note) {
        var method = methodSelect.value;
        // The list is only meaningful to the directory, and sending a stale one
        // under another method would store an allow list nothing reads and the
        // page would then show back.
        var allowed = method === 'ldap'
            ? groupsInput.value.split(',')
                .map(function (s) { return s.trim(); })
                .filter(function (s) { return !!s; })
            : [];

        btn.disabled = true;
        note.hidden = false;
        note.textContent = tr('deploy_auth_working', 'Saving.');
        var status = 0;
        window.api('/api/deploy/projects/' + encodeURIComponent(site.id) + '/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Both fields, on purpose. A backend carrying the selector reads
            // `method` and ignores the mirror; one that predates it has no idea
            // what `method` is and would refuse the body outright with
            // `bad_enabled`, which is what a page updated ahead of its backend
            // used to hit. The mirror degrades in the safe direction: an older
            // backend reads any method other than none as the directory, so it
            // asks for a login rather than publishing the site.
            body: JSON.stringify({
                method: method,
                enabled: method !== 'none',
                allowedGroups: allowed
            })
        })
            .then(function (r) { status = r.status; return readJson(r, 'project auth'); })
            .then(function (data) {
                btn.disabled = !isAdmin;
                if (data && data.success) {
                    site.protected = !!(data.project && data.project.protected);
                    site.method = (data.project && data.project.method) || method;
                    site.allowedGroups = (data.project && data.project.allowedGroups) || allowed;
                    note.textContent = tr('deploy_auth_applied', 'Saved.');
                    // The card in the project list carries the badge, so it has
                    // to hear about this too.
                    return loadProjects();
                }
                note.textContent = authRefusal(data, status);
                return undefined;
            })
            .catch(function (e) {
                btn.disabled = !isAdmin;
                note.textContent = tr('deploy_auth_unreachable',
                    'Aegis did not answer. Check the backend is running, then reload this page.');
                console.error('[Deploy] project auth failed:', e);
            });
    }

    /**
     * The four fields a domain name is enough to fill, and the input each one
     * goes into. Order is the order the form asks for them.
     */
    var AUTH_HINT_FIELDS = [
        ['url', 'deploy-auth-url'],
        ['baseDn', 'deploy-auth-basedn'],
        ['userFilter', 'deploy-auth-filter'],
        ['userDnTemplate', 'deploy-auth-dntemplate'],
        ['groupAttribute', 'deploy-auth-groupattr']
    ];

    /**
     * Fills the fields still empty, and returns how many it filled.
     *
     * Empty only. A value on screen was either typed by the operator or read
     * back from what is saved, and a guess is worth less than both.
     */
    function applyAuthHint(fields) {
        var filled = 0;
        for (var i = 0; i < AUTH_HINT_FIELDS.length; i++) {
            var input = authField(AUTH_HINT_FIELDS[i][1]);
            var value = fields[AUTH_HINT_FIELDS[i][0]];
            if (!input || !value || input.value.trim()) continue;
            input.value = value;
            filled++;
        }
        return filled;
    }

    /**
     * Asks what Aegis already knows and puts it in the blanks.
     *
     * Nothing is saved: the operator reads the suggestion, corrects the bits
     * that are wrong, and presses Save. That is also why a scan that filled
     * nothing says so instead of looking like it worked.
     */
    function scanAuth(btn) {
        btn.disabled = true;
        authNote(tr('deploy_auth_scanning', 'Looking for what Aegis already knows...'));
        var status = 0;
        window.api('/api/deploy/auth/suggest')
            .then(function (r) { status = r.status; return readJson(r, 'auth suggest'); })
            .then(function (data) {
                btn.disabled = !isAdmin;
                if (!data || !data.success) return authNote(authRefusal(data, status));
                if (!data.suggest) {
                    authNote(tr('deploy_auth_scan_nothing',
                        'Aegis has nothing to go on yet: no audit has named a domain and this '
                        + 'server is not joined to one. Type the address and the search base.'));
                    return;
                }
                var filled = applyAuthHint(data.suggest.fields);
                var from = data.suggest.source === 'audit'
                    ? tr('deploy_auth_scan_from_audit', 'the last audit')
                    : tr('deploy_auth_scan_from_host', 'the domain this server is joined to');
                if (!filled) {
                    authNote(tr('deploy_auth_scan_full',
                        'Every field is already filled, so nothing was changed. $1 names $2.')
                        .replace('$1', from).replace('$2', data.suggest.domain));
                    return;
                }
                authNote(tr('deploy_auth_scan_done',
                    'Filled $1 empty field(s) from $2, which names $3. Check them, add the '
                    + 'service account, then Save. LDAPS is suggested because a password '
                    + 'crosses this connection; switch to ldap:// only if the controller has '
                    + 'no certificate.')
                    .replace('$1', String(filled)).replace('$2', from)
                    .replace('$3', data.suggest.domain));
            })
            .catch(function (e) {
                btn.disabled = !isAdmin;
                authNote(tr('deploy_auth_scan_failed',
                    'Aegis could not work out the directory settings. Type them in.'));
                console.error('[Deploy] auth suggest failed:', e);
            });
    }

    function loadAuth() {
        return window.api('/api/deploy/auth')
            .then(function (r) { return readJson(r, '/api/deploy/auth'); })
            .then(function (data) {
                if (!data || !data.success) throw new Error('auth payload not usable');
                authLoaded = true;
                // Before the rows are built, so the selector offers what this
                // backend actually accepts. An older backend sends no list and
                // the built-in pair stands.
                if (Array.isArray(data.methods) && data.methods.length) authMethods = data.methods;
                fillAuthForm(data.ldap);
                renderAuthSites(data.sites);
                // A first visit lands on an empty form, and the domain is
                // already known from the audit. Filling it here rather than
                // waiting for the Scan button means the operator reads a
                // proposal instead of a blank page; nothing is saved until
                // they press Save.
                var scan = document.getElementById('deploy-auth-scan');
                if (scan && isAdmin && !(data.ldap && data.ldap.configured)) scanAuth(scan);
            })
            .catch(function (e) {
                authNote(tr('deploy_auth_load_failed',
                    'Could not load the authentication settings.'));
                console.error('[Deploy] auth load failed:', e);
            });
    }

    function saveAuth(btn) {
        var payload = {
            url: authField('deploy-auth-url').value.trim(),
            startTls: authField('deploy-auth-starttls').checked,
            rejectUnauthorized: authField('deploy-auth-verify').checked,
            bindDn: authField('deploy-auth-binddn').value.trim(),
            baseDn: authField('deploy-auth-basedn').value.trim(),
            userFilter: authField('deploy-auth-filter').value.trim(),
            userDnTemplate: authField('deploy-auth-dntemplate').value.trim(),
            groupAttribute: authField('deploy-auth-groupattr').value.trim(),
            nestedGroups: authField('deploy-auth-nested').checked
        };
        // Left blank means "use the default", which is what omitting the key
        // tells the server. Sending an empty string would be a value it has to
        // decide about, and 0 is a real setting that must not be swallowed here.
        var reval = authField('deploy-auth-revalidate').value.trim();
        if (reval !== '') payload.revalidateMinutes = Number(reval);
        // Only sent once the operator has typed in the field. An untouched mask
        // is not a password, and an untouched empty field on an install with a
        // stored password is not an instruction to erase it.
        var pw = authField('deploy-auth-bindpw');
        if (bindPasswordTouched && pw.value !== PASSWORD_MASK) payload.bindPassword = pw.value;

        btn.disabled = true;
        authNote(tr('deploy_auth_working', 'Saving.'));
        var status = 0;
        // Returned so the repairs that save on the operator's behalf, such as
        // correcting the address to the name on the certificate, can wait for
        // the check that follows instead of racing it.
        return window.api('/api/deploy/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
            .then(function (r) { status = r.status; return readJson(r, 'auth'); })
            .then(function (data) {
                if (data && data.success) {
                    fillAuthForm(data.ldap);
                    // Saving used to end here, on "Directory settings saved",
                    // which says nothing about whether the directory answers.
                    // The operator found out at the next login on a deployed
                    // site. Checking is one round trip and it is the answer they
                    // came for, so it is not a second button any more.
                    return runTest(btn, {});
                }
                btn.disabled = !isAdmin;
                if (ADVANCED_ERRORS.indexOf(data && data.error) >= 0) openAdvanced();
                authNote(authRefusal(data, status));
                authState('failed');
                return undefined;
            })
            .catch(function (e) {
                btn.disabled = !isAdmin;
                authNote(tr('deploy_auth_unreachable',
                    'Aegis did not answer. Check the backend is running, then reload this page.'));
                console.error('[Deploy] auth save failed:', e);
            });
    }

    /**
     * Checks the saved settings against the real directory.
     *
     * With no account named it binds the service account and stops there, which
     * is the question "can Aegis talk to this directory at all". With one, it
     * authenticates that account and lists its groups, which is the question
     * "what do I put in the allowed groups field". The password typed here is
     * sent once and never stored, on either side.
     */
    function testAuth(btn) { return runTest(btn, { withUser: true }); }

    /**
     * The three TLS refusals the page can put a button under, and what that
     * button does.
     *
     * Splitting them apart is the point. They used to arrive as one code and
     * one paragraph -- install the authority in Windows, restart Aegis, or stop
     * validating -- which was the right advice for one of the three and useless
     * for the other two.
     */
    var TLS_REPAIRABLE = ['ldap_tls_untrusted', 'ldap_tls_name_mismatch', 'ldap_tls_expired'];

    /**
     * Checks the saved settings against the real directory.
     *
     * With `withUser` it sends the account typed in the test fields and lists
     * the groups the directory returns, which is the question "what do I put in
     * a site's allowed groups". Without it, it binds the service account and
     * stops, which is the question "does any of this work" -- and is what
     * saving now asks on the operator's behalf.
     *
     * A TLS refusal does not end here. The page goes and looks at the
     * certificate and offers the repair that matches, because the alternative
     * was a paragraph of instructions about a certificate nobody could see.
     */
    function runTest(btn, opts) {
        var withUser = !!(opts && opts.withUser);
        var user = withUser ? authField('deploy-auth-testuser').value.trim() : '';
        var body = {};
        if (user) { body.username = user; body.password = authField('deploy-auth-testpass').value; }

        btn.disabled = true;
        showTestGroups([]);
        hideCertificate();
        authState('checking');
        authNote(tr('deploy_auth_testing', 'Contacting the directory.'));
        var status = 0;
        return window.api('/api/deploy/auth/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })
            .then(function (r) { status = r.status; return readJson(r, 'auth/test'); })
            .then(function (data) {
                btn.disabled = !isAdmin;
                if (!data || !data.success) {
                    authState('failed');
                    authNote(authRefusal(data, status));
                    if (TLS_REPAIRABLE.indexOf(data && data.error) >= 0) {
                        return showCertificate(data.error);
                    }
                    return undefined;
                }
                // The password is a credential and there is no reason to leave
                // it on screen once the answer is in.
                authField('deploy-auth-testpass').value = '';
                authState('ok');
                if (data.user) {
                    showTestGroups(data.user.groups);
                    return authNote(tr('deploy_auth_test_user_ok',
                        'The directory accepted $1. Its groups are listed below.').replace('$1', user));
                }
                return authNote(tr('deploy_auth_test_ok',
                    'The directory answered and the service account bound.'));
            })
            .catch(function (e) {
                btn.disabled = !isAdmin;
                authState('failed');
                authNote(tr('deploy_auth_unreachable',
                    'Aegis did not answer. Check the backend is running, then reload this page.'));
                console.error('[Deploy] auth test failed:', e);
            });
    }

    /** One labelled line in the certificate panel. */
    function certRow(box, labelKey, fallback, value) {
        if (!value) return;
        var row = el('div', 'dep-meta-row');
        row.appendChild(el('span', 'dep-meta-key', tr(labelKey, fallback)));
        row.appendChild(el('span', 'dep-meta-value', value));
        box.appendChild(row);
    }

    /**
     * Fetches the certificate the controller presented and draws the repair.
     *
     * `reason` is the refusal that got us here and decides what the panel
     * offers: trusting the authority, correcting the address to the name on the
     * certificate, or nothing at all when it has expired, because no button on
     * this page renews a certificate and pretending otherwise wastes a click.
     */
    function showCertificate(reason) {
        var box = document.getElementById('deploy-auth-cert');
        if (!box) return undefined;
        box.hidden = false;
        box.textContent = '';
        box.appendChild(el('p', 'dep-cert-body',
            tr('deploy_auth_cert_loading', 'Reading the certificate the controller presented.')));

        var status = 0;
        return window.api('/api/deploy/auth/certificate', { method: 'POST' })
            .then(function (r) { status = r.status; return readJson(r, 'auth/certificate'); })
            .then(function (data) {
                box.textContent = '';
                if (!data || !data.success) {
                    box.appendChild(el('p', 'dep-cert-body', authRefusal(data, status)));
                    return undefined;
                }
                paintCertificate(box, data.certificate, reason);
                return undefined;
            })
            .catch(function (e) {
                box.textContent = '';
                box.appendChild(el('p', 'dep-cert-body', tr('deploy_auth_unreachable',
                    'Aegis did not answer. Check the backend is running, then reload this page.')));
                console.error('[Deploy] certificate probe failed:', e);
            });
    }

    function paintCertificate(box, cert, reason) {
        var anchor = cert.anchor || {};
        var leaf = cert.leaf || {};

        box.appendChild(el('h4', 'dep-cert-title',
            tr('deploy_auth_cert_title', 'The certificate this controller presented')));

        certRow(box, 'deploy_auth_cert_host', 'Reached at', cert.host + ':' + cert.port);
        certRow(box, 'deploy_auth_cert_issued_to', 'Issued to', leaf.subject);
        certRow(box, 'deploy_auth_cert_authority', 'Authority', anchor.subject || anchor.issuer);
        certRow(box, 'deploy_auth_cert_valid', 'Valid',
            (leaf.validFrom || '') + (leaf.validTo ? ' \u2192 ' + leaf.validTo : ''));

        if (reason === 'ldap_tls_untrusted') {
            box.appendChild(el('p', 'dep-cert-body', tr('deploy_auth_cert_trust_body',
                'Compare this fingerprint with the one on your certificate authority. If they match, trust it: certificate validation stays on and only this authority is added, for this directory.')));
            box.appendChild(el('code', 'dep-cert-print', anchor.fingerprint256 || ''));

            var trust = el('button', 'dep-btn', tr('deploy_auth_cert_trust', 'Trust this authority'));
            trust.type = 'button';
            trust.disabled = !isAdmin || !anchor.fingerprint256;
            trust.addEventListener('click', function () {
                trustCertificate(anchor.fingerprint256, trust);
            });
            box.appendChild(trust);
            return;
        }

        if (reason === 'ldap_tls_name_mismatch') {
            var names = cert.names || [];
            box.appendChild(el('p', 'dep-cert-body', names.length
                ? tr('deploy_auth_cert_name_body',
                    'This certificate is issued for $1. The address above names something else, so the check fails on the name and not on the authority.').replace('$1', names.join(', '))
                : tr('deploy_auth_cert_name_none',
                    'This certificate carries no name that matches the address above, and none that can be used instead. Correct the address by hand.')));

            if (names.length) {
                var fix = el('button', 'dep-btn',
                    tr('deploy_auth_cert_use_name', 'Use $1 instead').replace('$1', names[0]));
                fix.type = 'button';
                fix.disabled = !isAdmin;
                fix.addEventListener('click', function () { useCertificateName(names[0], fix); });
                box.appendChild(fix);
            }
            return;
        }

        // Expired, or anything else that got this far: the panel is evidence,
        // not a repair. Naming the dates is the whole contribution.
        box.appendChild(el('p', 'dep-cert-body', tr('deploy_auth_cert_no_fix',
            'Nothing on this page can repair this. The certificate has to be renewed on the controller.')));
    }

    /**
     * Trusts the authority on screen, then re-checks.
     *
     * Only the fingerprint is sent. The backend re-opens the connection and
     * pins what it reads there, so a controller swapped in since the panel was
     * drawn is refused rather than trusted on the strength of a value that came
     * back through the browser.
     */
    function trustCertificate(fingerprint, btn) {
        btn.disabled = true;
        authNote(tr('deploy_auth_cert_trusting', 'Trusting this authority.'));
        var status = 0;
        return window.api('/api/deploy/auth/trust', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fingerprint256: fingerprint })
        })
            .then(function (r) { status = r.status; return readJson(r, 'auth/trust'); })
            .then(function (data) {
                if (!data || !data.success) {
                    btn.disabled = !isAdmin;
                    return authNote(authRefusal(data, status));
                }
                fillAuthForm(data.ldap);
                hideCertificate();
                // Straight back into the check the operator was in the middle
                // of. Trusting an authority and then being told to press Test
                // again is the same dead end in a smaller form.
                var test = document.getElementById('deploy-auth-test');
                return runTest(test || btn, {});
            })
            .catch(function (e) {
                btn.disabled = !isAdmin;
                authNote(tr('deploy_auth_unreachable',
                    'Aegis did not answer. Check the backend is running, then reload this page.'));
                console.error('[Deploy] trust failed:', e);
            });
    }

    /**
     * Rewrites the address to the name the certificate carries, saves, re-checks.
     *
     * Host only: the port, the scheme and everything else the operator chose
     * are theirs and stay. This is a correction of one field, made from
     * evidence, not a rewrite of the configuration.
     */
    function useCertificateName(name, btn) {
        var field = authField('deploy-auth-url');
        if (!field) return undefined;
        var current = field.value.trim();
        var parsed;
        try { parsed = new URL(current); } catch (_) { parsed = null; }
        field.value = parsed
            ? parsed.protocol + '//' + name + (parsed.port ? ':' + parsed.port : '')
            : 'ldaps://' + name + ':636';
        hideCertificate();
        var save = document.getElementById('deploy-auth-save');
        return saveAuth(save || btn);
    }

    /** Removes every pinned authority, then re-checks so the effect is visible. */
    function unpinAuthorities(btn) {
        var question = tr('deploy_auth_pinned_drop_confirm',
            'Stop trusting these authorities? If the controller certificate depends on one of them, the directory stops answering until it is trusted again or installed on this server.');
        if (!window.confirm(question)) return undefined;

        btn.disabled = true;
        var status = 0;
        return window.api('/api/deploy/auth/trust', { method: 'DELETE' })
            .then(function (r) { status = r.status; return readJson(r, 'auth/trust delete'); })
            .then(function (data) {
                if (!data || !data.success) {
                    btn.disabled = !isAdmin;
                    return authNote(authRefusal(data, status));
                }
                fillAuthForm(data.ldap);
                var test = document.getElementById('deploy-auth-test');
                return runTest(test || btn, {});
            })
            .catch(function (e) {
                btn.disabled = !isAdmin;
                authNote(tr('deploy_auth_unreachable',
                    'Aegis did not answer. Check the backend is running, then reload this page.'));
                console.error('[Deploy] un-pin failed:', e);
            });
    }

    function clearAuth(btn) {
        var question = tr('deploy_auth_clear_confirm',
            'Forget the directory settings? Every protected site stops being served until a directory is configured again.');
        if (!window.confirm(question)) return;

        btn.disabled = true;
        var status = 0;
        window.api('/api/deploy/auth', { method: 'DELETE' })
            .then(function (r) { status = r.status; return readJson(r, 'auth delete'); })
            .then(function (data) {
                btn.disabled = !isAdmin;
                if (data && data.success) {
                    fillAuthForm(null);
                    showTestGroups([]);
                    hideCertificate();
                    authState('none');
                    return authNote(tr('deploy_auth_cleared', 'Directory settings removed.'));
                }
                return authNote(authRefusal(data, status));
            })
            .catch(function (e) {
                btn.disabled = !isAdmin;
                authNote(tr('deploy_auth_unreachable',
                    'Aegis did not answer. Check the backend is running, then reload this page.'));
                console.error('[Deploy] auth delete failed:', e);
            });
    }

    // --- Loading and wiring -------------------------------------------------

    function loadProjects() {
        return window.api('/api/deploy/projects')
            .then(function (r) { return readJson(r, '/api/deploy/projects'); })
            .then(function (p) {
                projects = (p && p.projects) || [];
                renderProjects();
                // The detail pane is built from this list, so it repaints with it
                // rather than holding the version from before a redeploy.
                var at = readHash();
                if (at.name === 'project') renderDetail(at.arg, at.sub);
                // The three install-wide panes are drawn from this list too, so
                // a redeploy or a deletion is reflected on whichever of them is
                // open rather than at the next navigation.
                else if (at.name === 'env') renderEnvPane();
                else if (at.name === 'domains') renderDomainsPane();
                else if (at.name === 'usage') renderUsagePane();
                return undefined;
            });
    }

    function load() {
        return window.api('/api/deploy/status')
            .then(function (r) { return readJson(r, '/api/deploy/status'); })
            .then(function (data) {
                if (!data || !data.success) throw new Error('status payload not usable');
                if (!renderReadiness(data)) {
                    // The host has not opted in. Nothing else on this page can do
                    // anything, so the readiness list is what the reader gets.
                    goTo('github');
                    return null;
                }
                appInfo = data.github || null;
                // A process running application code on this server is a host
                // decision, so the field only exists where the answer is yes.
                var runtimeRow = document.getElementById('deploy-new-runtime-row');
                if (runtimeRow) {
                    runtimeRow.hidden = !(data.capabilities && data.capabilities.runtimes);
                }
                if (data.github && data.github.connected) {
                    return loadProjects().then(loadGithub);
                }
                document.getElementById('deploy-connect').hidden = false;
                document.getElementById('deploy-manual').hidden = false;
                var ownerIn = document.getElementById('deploy-connect-owner');
                if (ownerIn) {
                    ownerIn.placeholder = tr('deploy_connect_owner_ph',
                        'leave empty for your own account');
                }
                // A public repository deploys with no App, so this install can
                // still have projects.
                loadProjects();
                // The button used to be disabled here whenever GitHub could not
                // reach this server, on the belief that the manifest flow needed
                // a public address. It does not: GitHub checks the hook address
                // is public, never that it is ours, and it is the operator's own
                // browser that follows the redirect home. One-click registration
                // is the normal path on a LAN install, and the manual form below
                // is the fallback rather than the only door.
                return null;
            })
            .catch(showError);
    }

    /**
     * Whether this session may deploy.
     *
     * The backend is the check: every mutating route carries
     * `requireRole('admin')`. This only decides whether a button looks usable,
     * because a button that fails on click reads as broken.
     */
    function loadMe() {
        return window.api('/auth/me')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                isAdmin = !!(d && d.role === 'admin');
                paintSideUser(d);
            })
            .catch(function () { isAdmin = false; });
    }

    /** The rail's footer: who is signed in, and on which tenant. */
    function paintSideUser(me) {
        var tenantEl = document.getElementById('deploy-side-tenant');
        if (tenantEl) {
            try {
                tenantEl.textContent = window.tenantSlug();
            } catch (e) {
                tenantEl.textContent = '';
            }
        }

        var foot = document.getElementById('deploy-side-user');
        if (!foot || !me) return;
        var who = me.name || me.email || '';
        if (!who) return;
        foot.textContent = '';
        foot.appendChild(el('span', 'dep-side-avatar', who.slice(0, 2).toUpperCase()));
        // Name then role on two lines: the role is what decides which controls
        // on this page answer, so it gets its own line rather than trailing the
        // address where it reads as part of it.
        var box = el('span', 'dep-side-who');
        box.appendChild(el('span', 'dep-side-who-name', who));
        if (me.role) box.appendChild(el('span', 'dep-side-who-role', me.role));
        foot.appendChild(box);
    }

    /**
     * The "N running" pill on the Deployments rail entry.
     *
     * Counts the runs the poller currently has open, and hides the pill at
     * zero: a badge that always reads "0 running" stops being read at all.
     */
    function paintRunningCount() {
        var pill = document.getElementById('deploy-runs-count');
        if (!pill) return;
        var n = Object.keys(runningRuns).length;
        pill.hidden = n === 0;
        if (n === 0) return;
        pill.textContent = tr('deploy_nav_running', '{n} running').replace('{n}', n);
    }

    function init() {
        readinessEl = document.getElementById('deploy-readiness');
        listEl = document.getElementById('deploy-project-list');
        errorEl = document.getElementById('deploy-error');
        if (!readinessEl) return;

        var btn = document.getElementById('deploy-connect-btn');
        if (btn) btn.addEventListener('click', function () { startConnect(btn); });

        var mbtn = document.getElementById('deploy-manual-btn');
        if (mbtn) mbtn.addEventListener('click', function () { submitManual(mbtn); });

        var nbtn = document.getElementById('deploy-new-btn');
        if (nbtn) nbtn.addEventListener('click', function () { submitDeploy(nbtn); });

        // The plan sidecar restates the form, so it follows every keystroke in
        // it rather than waiting for a submit that may never come.
        ['url', 'branch', 'root', 'install', 'buildcmd', 'outputdir'].forEach(function (id) {
            var field = document.getElementById('deploy-new-' + id);
            if (field) field.addEventListener('input', renderPlan);
        });

        // On `change` and not on `input`: the branch list is a call to GitHub,
        // and a URL is not a repository until the operator stops typing it.
        var urlField = document.getElementById('deploy-new-url');
        if (urlField) {
            urlField.addEventListener('change', loadFormBranches);
            urlField.addEventListener('blur', loadFormBranches);
        }

        var psearch = document.getElementById('deploy-project-search');
        if (psearch) {
            psearch.placeholder = tr('deploy_projects_search', 'Search a project');
            psearch.addEventListener('input', renderProjects);
        }

        var rsearch = document.getElementById('deploy-repo-search');
        if (rsearch) {
            rsearch.placeholder = tr('deploy_repos_search', 'Search a repository');
            rsearch.addEventListener('input', renderRepos);
        }

        var asave = document.getElementById('deploy-auth-save');
        if (asave) asave.addEventListener('click', function () { saveAuth(asave); });

        var ascan = document.getElementById('deploy-auth-scan');
        if (ascan) ascan.addEventListener('click', function () { scanAuth(ascan); });

        var atest = document.getElementById('deploy-auth-test');
        if (atest) atest.addEventListener('click', function () { testAuth(atest); });

        var aclear = document.getElementById('deploy-auth-clear');
        if (aclear) aclear.addEventListener('click', function () { clearAuth(aclear); });

        var apw = document.getElementById('deploy-auth-bindpw');
        if (apw) apw.addEventListener('input', function () { bindPasswordTouched = true; });

        // This page loads no app.js, so nothing else calls applyTranslations
        // and every static data-i18n on it stayed English next to a French
        // navbar. Same fix as extensions.js: once, up front, before any request
        // has answered. Text built in JS goes through tr() instead, because
        // applyTranslations only walks nodes that already exist.
        if (typeof applyTranslations === 'function') applyTranslations();

        window.addEventListener('hashchange', route);

        // The core language switcher calls this after applyTranslations. Text
        // this file builds with tr() is not in the DOM as a data-i18n node, so
        // without it a card stays in the language it was rendered in.
        window.onLanguageChange = function () {
            renderPlan();
            renderProjects();
            renderRepos();
            refusalsPainted = false;
            renderRefusals();
            var at = readHash();
            if (at.name === 'project') renderDetail(at.arg, at.sub);
            if (at.name === 'runs') loadRuns();
            if (at.name === 'env') renderEnvPane();
            if (at.name === 'domains') renderDomainsPane();
            if (at.name === 'usage') renderUsagePane();
        };

        renderPlan();
        reportCallback();

        // The pane is revealed at once, so a reader is not looking at an empty
        // page while /auth/me is in flight. Nothing inside it is *rendered*
        // until the role is known: several panes build their controls once,
        // from isAdmin, and each keeps whatever it was built with. Routing
        // before the answer arrived meant an administrator landing on a pane by
        // URL got it read-only. #auth is where that showed: every Apply
        // disabled and the directory form never proposed, while clicking to the
        // same tab from inside the page worked, because by then loadMe had
        // resolved.
        showPane(readHash().name);
        loadMe().then(function () {
            route();
            return load();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
