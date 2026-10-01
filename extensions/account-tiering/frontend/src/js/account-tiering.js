/*
 * Account Tiering: page entry. Owns the state, talks to the routes under
 * /api/account-tiering, and renders the title bar, banners and centre toolbar;
 * the left list, tree, panel, overview and dialogs are their own modules.
 *
 * One state object, one render(). Rendering rewrites each region's HTML, so
 * every interactive element carries a `data-key` and render() puts focus back
 * on the element that had it: without that, a keyboard user would be thrown
 * to the top of the page on every click. For the same reason anything the user
 * is typing lives in the state (`overrideDraft`) and is drawn back.
 *
 * Every error is read from the body's `error` code, never from the status
 * alone, so the page shows the backend's reason (no_scan_yet, facts_schema...)
 * translated, not a generic failure.
 */
(function () {
    'use strict';

    const AT = (window.AccountTiering = window.AccountTiering || {});
    const { T, esc, icon, errorText, dateText, translateStatic, toast, focusMark, focusBack } = AT.ui;
    const BASE = '/api/account-tiering';
    const POLL_MS = 2000;
    const POLL_TRIES = 5;
    const byId = (id) => document.getElementById(id);

    const state = {
        loading: true, error: null, model: null, rules: [], settings: { domain: null, passes: 3 },
        scan: null, scanning: false, scanError: null,
        acc: null, node: null, invSel: null, inverse: null, q: '', tier: 'all', cell: null, showAll: false, leftLimit: AT.left.STEP,
        view: 'tree', depth: 4, hideGhost: false, ecartOnly: false, expanded: {}, showAllPoints: false, menu: null,
        overrideOpen: false, overrideError: null, overrideDraft: null, saving: false
    };
    let vm = null;
    let pollTimer = null;
    let pollFails = 0;
    let loadSeq = 0;

    async function call(path, opts) {
        const o = opts || {};
        const init = { method: o.method || 'GET' };
        if (o.json !== undefined) {
            init.headers = { 'Content-Type': 'application/json' };
            init.body = JSON.stringify(o.json);
        }
        let res;
        try {
            res = await window.api(BASE + path, init);
        } catch (_) {
            return { ok: false, code: 'network' };
        }
        if (res.status === 403) return { ok: false, code: 'forbidden', status: 403 };
        let body = null;
        try { body = await res.json(); } catch (_) { body = null; }
        if (!body) return { ok: false, code: 'internal', status: res.status };
        if (!res.ok || body.success === false) return { ok: false, code: body.error || 'internal', status: res.status };
        return { ok: true, body, status: res.status };
    }

    /**
     * The view model is built from whatever the route sent. A shape it does
     * not expect throws, and that must end as a visible error: left to
     * propagate, it would leave the page on "loading" for good.
     */
    function broken(error) {
        console.error('[account-tiering]', error);
        state.model = null;
        vm = null;
        state.error = 'internal';
    }

    function buildVm(model) {
        try {
            vm = AT.model.buildViewModel(model, { t: T, rules: state.rules });
            state.model = model;
            state.error = null;
        } catch (error) {
            broken(error);
        }
    }

    function absorbModel(res) {
        if (!res.ok) {
            state.model = null;
            vm = null;
            state.error = res.code;
            return;
        }
        buildVm(res.body.model);
        if (vm && !vm.byId[state.acc]) {
            const first = vm.accounts.find((a) => a.gap) || vm.accounts[0];
            state.acc = first ? first.id : null;
            state.node = null;
        }
    }

    /**
     * Loads overlap: a save reloads the model while a finished scan does too.
     * Each load takes a number and only the latest one is shown, so a slow
     * answer to an old request never replaces a newer model. Whichever load
     * is shown also ends the "loading" state, the first one included.
     */
    async function loadModel(withRules) {
        const seq = ++loadSeq;
        const [model, rules] = await Promise.all([call('/model'), withRules ? call('/rules') : null]);
        if (seq !== loadSeq) return;
        if (rules && rules.ok) state.rules = rules.body.rules || [];
        absorbModel(model);
        state.loading = false;
        render();
    }

    const reloadModel = () => loadModel(true);

    async function loadAll() {
        state.loading = true;
        render();
        const [rules, settings, scan] = await Promise.all([call('/rules'), call('/settings'), call('/scan/status')]);
        if (rules.ok) state.rules = rules.body.rules || [];
        if (settings.ok) state.settings = settings.body.settings || state.settings;
        if (scan.ok) state.scan = scan.body.scan || null;
        if (state.scan && state.scan.status === 'running') { state.scanning = true; poll(); }
        await loadModel(false);
    }

    async function startScan() {
        if (state.scanning) return;
        const res = await call('/scan', { method: 'POST' });
        if (!res.ok && res.code !== 'scan_running') { toast(errorText(res.code), 'error'); return; }
        pollFails = 0;
        Object.assign(state, { scanning: true, scanError: null });
        render();
        poll();
    }

    /** 2 s between two reads of the scan status; `data-at-poll-ms` on #at-view shortens it for the tests. */
    const pollDelay = () => Number(byId('at-view').dataset.atPollMs) || POLL_MS;

    function poll() {
        clearTimeout(pollTimer);
        pollTimer = setTimeout(async () => {
            const st = await call('/scan/status');
            if (!st.ok) {
                // A read that fails (dropped request, 403, 500, a proxy's HTML
                // page) says nothing about the scan: retry. After POLL_TRIES
                // in a row the page stops and says so; it never concludes that
                // the scan finished from an answer it could not read.
                pollFails += 1;
                if (pollFails < POLL_TRIES) { poll(); return; }
                Object.assign(state, { scanning: false, scanError: st.code });
                render();
                return;
            }
            pollFails = 0;
            state.scan = st.body.scan || null;
            if (state.scan && state.scan.status === 'running') { poll(); return; }
            state.scanning = false;
            if (state.scan && state.scan.status === 'failed') {
                toast(T('at_scan_failed_toast', 'Analyse échouée : {reason}', { reason: errorText(state.scan.error_code) }), 'error');
                render();
                return;
            }
            await reloadModel();
            // No model to show: the error card says why, and a count of gaps would be invented.
            if (!vm) return;
            const n = vm.kpis.gaps;
            const domain = vm.domain;
            if (n === 0) toast(T('at_scan_done_none', 'Analyse terminée : aucun écart de tiering sur {domain}.', { domain }), 'success');
            else if (n === 1) toast(T('at_scan_done_one', 'Analyse terminée : {n} écart de tiering sur {domain}.', { n, domain }), 'success');
            else toast(T('at_scan_done_many', 'Analyse terminée : {n} écarts de tiering sur {domain}.', { n, domain }), 'success');
        }, pollDelay());
    }

    function set(patch) {
        // A new filter starts the left list again from its first rows.
        if ('q' in patch || 'tier' in patch || 'cell' in patch) state.leftLimit = AT.left.STEP;
        Object.assign(state, patch);
        render();
    }

    /** What closing the correction form resets: the form, its error and what was typed in it. */
    const NO_OVERRIDE = { overrideOpen: false, overrideError: null, overrideDraft: null };

    function openAccount(id) {
        set({ acc: id, node: null, inverse: null, invSel: null, view: state.view === 'overview' ? 'tree' : state.view, menu: null, ...NO_OVERRIDE });
    }

    const domainShown = () => state.settings.domain || (vm && vm.domain) || T('at_domain_current', 'domaine du serveur Aegis');

    // ── Title bar and banners ────────────────────────────────────────────────
    function renderHeader() {
        const meta = byId('at-meta');
        const line = vm
            ? T('at_meta', 'Comptes à privilèges : {n} · écarts de tiering : {g} · {domain} · analyse du {date}', {
                n: vm.kpis.accounts, g: vm.kpis.gaps, domain: domainShown(), date: dateText(vm.collectedAt)
            })
            : T('at_meta_none', 'Aucune analyse affichable · {domain}', { domain: domainShown() });
        // aria-live: assigning the same text again would have it read again on every render.
        if (meta.textContent !== line) meta.textContent = line;
        const scan = byId('at-scan');
        scan.disabled = state.scanning;
        scan.textContent = state.scanning ? T('at_scanning', 'Analyse en cours…') : T('at_scan', "Relancer l'analyse");
        const exp = byId('at-export-wrap');
        exp.hidden = !vm;
        const open = state.menu === 'export';
        byId('at-export').setAttribute('aria-expanded', String(open));
        byId('at-export-menu').hidden = !open;
        const prefix = typeof window.tenantPrefix === 'function' ? window.tenantPrefix() : '';
        byId('at-export-csv').href = prefix + BASE + '/export.csv';
        byId('at-export-json').href = prefix + BASE + '/export.json';
    }

    function banner(id, kind, text, action) {
        const btn = action ? `<button type="button" class="at-link" data-act="${action[0]}" data-key="banner:${id}">${esc(action[1])}</button>` : '';
        return `<div class="at-banner" data-kind="${kind}" id="${id}" role="${kind === 'error' ? 'alert' : 'status'}">${icon('alert')}<span>${esc(text)}</span>${btn}</div>`;
    }

    function renderBanners() {
        const out = [];
        if (state.scanning) out.push(banner('at-banner-scanning', 'info', T('at_banner_scanning', 'Analyse en cours : la page se met à jour à la fin.')));
        if (state.scanError) {
            out.push(banner('at-banner-pollfail', 'error', T('at_banner_poll_failed', "Le suivi de l'analyse s'est arrêté : son état n'a pas pu être lu. {reason}", { reason: errorText(state.scanError) })));
        }
        if (!state.scanning && state.scan && state.scan.status === 'failed' && state.error !== 'no_scan_yet') {
            out.push(banner('at-banner-scanfail', 'error', T('at_banner_scan_failed', 'La dernière analyse a échoué. {reason}', { reason: errorText(state.scan.error_code) })));
        }
        if (vm && vm.rulesCount === 0) {
            out.push(banner('at-banner-norules', 'warning', T('at_banner_norules', 'Aucune règle de tiering : tous les comptes sont considérés Tier 2, les administrateurs légitimes apparaissent en écart.'), ['rules-open', T('at_banner_norules_action', 'Définir les règles')]));
        }
        if (vm && vm.truncated) {
            out.push(banner('at-banner-truncated', 'warning', T('at_banner_truncated', 'Chaîne tronquée à {n} niveaux : des droits plus lointains peuvent manquer. Augmentez le nombre de passes dans les paramètres de l’analyse.', { n: vm.passes })));
        }
        if (vm && vm.unreadable.length) {
            const n = vm.unreadable.length;
            out.push(banner('at-banner-unreadable', 'warning', n === 1
                ? T('at_banner_unreadable_one', '{n} objet n’a pas pu être lu : le résultat est partiel.', { n })
                : T('at_banner_unreadable_many', '{n} objets n’ont pas pu être lus : le résultat est partiel.', { n })));
        }
        byId('at-banners').innerHTML = out.join('');
    }

    function renderState() {
        const card = byId('at-state');
        const body = byId('at-body');
        let html = '';
        if (state.loading) {
            html = `<div class="at-card at-state-card" role="status"><h2 class="at-h3">${esc(T('at_loading', 'Chargement de l’arbre des comptes…'))}</h2></div>`;
        } else if (state.error === 'no_scan_yet') {
            html = `<div class="at-card at-state-card" id="at-empty-noscan"><h2 class="at-h3">${esc(T('at_noscan_title', 'Aucune analyse pour {domain}', { domain: domainShown() }))}</h2>
                <p class="at-text">${esc(T('at_noscan_text', "Lancez une analyse pour construire l'arbre des comptes de ce domaine. Elle lit l'annuaire en lecture seule depuis le serveur Aegis."))}</p>
                <button type="button" class="at-pill at-pill-ink" data-act="scan" data-key="state-scan"${state.scanning ? ' disabled' : ''}>${esc(state.scanning ? T('at_scanning', 'Analyse en cours…') : T('at_scan_first', 'Lancer la première analyse'))}</button></div>`;
        } else if (state.error) {
            html = `<div class="at-card at-state-card" id="at-error-card" role="alert" data-code="${esc(state.error)}"><h2 class="at-h3">${esc(T('at_error_title', "L'arbre des comptes ne peut pas s'afficher"))}</h2>
                <p class="at-text">${esc(errorText(state.error))}</p><span class="at-mono">${esc(state.error)}</span></div>`;
        }
        card.innerHTML = html;
        card.hidden = !html;
        body.hidden = Boolean(html);
    }

    // ── Centre: toolbar plus one of the views ───────────────────────────────
    function toolbarHtml(isInv) {
        const tabs = [['tree', T('at_view_tree', 'Arbre')], ['list', T('at_view_list', 'Liste')], ['overview', T('at_view_overview', "Vue d'ensemble")]]
            .map(([k, label]) => `<button type="button" class="at-seg-btn" data-viewbtn="${k}" data-key="view:${k}" aria-pressed="${state.view === k}">${esc(label)}</button>`).join('');
        const isTree = state.view === 'tree';
        const isOv = state.view === 'overview';
        const depthOpen = state.menu === 'depth';
        const depthItems = [[2, T('at_depth_2', 'Compte et groupes')], [3, T('at_depth_3', "Jusqu'aux mécanismes")], [4, T('at_depth_4', "Jusqu'au tier atteint")]]
            .map(([d, note]) => `<button type="button" role="menuitemradio" class="at-menu-item" data-depth="${d}" data-key="depth:${d}" aria-checked="${state.depth === d}"><span class="at-menu-text"><span class="at-strong">${esc(T('at_depth_n', '{n} niveaux', { n: d }))}</span><span class="at-note">${esc(note)}</span></span>${state.depth === d ? icon('check', 'at-menu-check') : ''}</button>`).join('');
        const depth = isTree ? `<div class="at-menu-wrap"><button type="button" class="at-btn" id="at-depth" data-key="depth" aria-haspopup="menu" aria-expanded="${depthOpen}">${esc(T('at_depth_label', 'Profondeur : {n}', { n: state.depth }))}${icon('chevron')}</button>
            <div class="at-menu" role="menu" aria-label="${esc(T('at_depth', 'Profondeur'))}"${depthOpen ? '' : ' hidden'}>${depthItems}</div></div>` : '';
        const check = (id, on, key, fb) => `<label class="at-check"><input type="checkbox" id="${id}" data-key="${id}"${on ? ' checked' : ''}><span>${esc(T(key, fb))}</span></label>`;
        return `<div class="at-toolbar"><div class="at-toolbar-left">
            <div class="at-seg" role="group" aria-label="${esc(T('at_view_group', 'Affichage'))}">${tabs}</div>${depth}
            ${isOv ? '' : check('at-ecart', state.ecartOnly, 'at_ecart_only', 'Écarts seulement')}
            ${isTree && !isInv ? check('at-ghost', state.hideGhost, 'at_hide_ghost', 'Masquer non-privilégiés') : ''}</div>
            ${isOv ? '' : `<button type="button" class="at-btn" id="at-inverse" data-key="inverse">${icon('swap')}${esc(isInv ? T('at_inverse_back', 'Retour au compte') : T('at_inverse', 'Arbre inversé'))}</button>`}</div>`;
    }

    function emptyCard(title, text) {
        return `<div class="at-card at-stage-empty" id="at-tree-empty"><h2 class="at-h3">${esc(title)}</h2><p class="at-text">${esc(text)}</p></div>`;
    }

    function renderCentre(c) {
        let content;
        let drewTree = false;
        if (state.view === 'overview') content = AT.overview.overviewHtml(vm, state);
        else if (!c) content = emptyCard(T('at_pick_title', 'Aucun compte sélectionné'), T('at_panel_pick', 'Sélectionnez un compte pour afficher ses chemins de privilège.'));
        else if (state.view === 'list') content = AT.tree.listHtml(c);
        else if (c.G.A.length) {
            const key = [state.view, state.acc, state.inverse, state.ecartOnly, state.hideGhost, JSON.stringify(state.expanded), state.depth].join('|');
            content = AT.tree.treeHtml(c, key);
            drewTree = true;
        } else if (state.ecartOnly) {
            content = emptyCard(T('at_tree_nogap_title', 'Aucun chemin en écart'), T('at_tree_nogap_text', 'Ce compte reste dans son tier prévu. Décochez « Écarts seulement » pour voir tous ses chemins.'));
        } else {
            content = emptyCard(T('at_tree_none_title', 'Aucun chemin de privilège'), T('at_tree_none_text', "Ce compte n'atteint aucun groupe ni droit relevé par l'analyse : il reste en Tier 2."));
        }
        byId('at-centre').innerHTML = `${toolbarHtml(c ? c.isInv : state.inverse != null)}<div class="at-stage" id="at-stage" data-view="${state.view}">${content}</div>`;
        if (drewTree) AT.tree.mount();
    }

    function renderBody() {
        const c = AT.tree.compute(state, vm);
        byId('at-left-dyn').innerHTML = AT.left.leftHtml(vm, state, domainShown());
        byId('at-search-clear').hidden = !state.q;
        renderCentre(c);
        byId('at-panel').innerHTML = AT.panel.panelHtml(c, state);
    }

    function render() {
        const focus = focusMark();
        renderHeader();
        renderBanners();
        renderState();
        if (vm && !state.loading && !state.error) {
            try {
                renderBody();
            } catch (error) {
                // Same reason as in buildVm: a model that builds but cannot be
                // drawn must show the error card, not half a page.
                broken(error);
                renderHeader();
                renderBanners();
                renderState();
            }
        }
        focusBack(focus);
    }

    AT.app = { state, call, set, render, reloadModel, openAccount, NO_OVERRIDE, get vm() { return vm; } };
    AT.events.wire({ startScan });

    function init() {
        if (!byId('at-view')) return;
        translateStatic(byId('at-view'));
        const prev = window.onLanguageChange;
        window.onLanguageChange = function () {
            if (typeof prev === 'function') { try { prev(); } catch (_) { /* another page's handler */ } }
            translateStatic(byId('at-view'));
            if (state.model) buildVm(state.model);
            render();
        };
        loadAll();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
