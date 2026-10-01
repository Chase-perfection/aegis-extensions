/*
 * Account Tiering: page entry. Owns the state, talks to the routes under
 * /api/account-tiering, and renders the title bar, banners, left list and
 * centre toolbar; the tree, panel, overview and dialogs are their own modules.
 *
 * One state object, one render(). Rendering rewrites each region's HTML, so
 * every interactive element carries a `data-key` and render() puts focus back
 * on the element that had it: without that, a keyboard user would be thrown
 * to the top of the page on every click.
 *
 * Every error is read from the body's `error` code, never from the status
 * alone, so the page shows the backend's reason (no_scan_yet, facts_schema...)
 * translated, not a generic failure.
 */
(function () {
    'use strict';

    const AT = (window.AccountTiering = window.AccountTiering || {});
    const { T, esc, icon, accountMark, errorText, dateText, translateStatic, toast } = AT.ui;
    const BASE = '/api/account-tiering';
    const POLL_MS = 2000;
    const SHOW_GAPS = 3;
    const byId = (id) => document.getElementById(id);

    const state = {
        loading: true, error: null, model: null, rules: [], settings: { domain: null, passes: 3 }, scan: null, scanning: false,
        acc: null, node: null, invSel: null, inverse: null, q: '', tier: 'all', cell: null, showAll: false,
        view: 'tree', depth: 4, hideGhost: false, ecartOnly: false, expanded: {}, showAllPoints: false, menu: null,
        overrideOpen: false, overrideError: null
    };
    let vm = null;
    let pollTimer = null;

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

    function absorbModel(res) {
        if (res.ok) {
            state.model = res.body.model;
            state.error = null;
            vm = AT.model.buildViewModel(state.model, { t: T, rules: state.rules });
            if (!vm.byId[state.acc]) {
                const first = vm.accounts.find((a) => a.gap) || vm.accounts[0];
                state.acc = first ? first.id : null;
                state.node = null;
            }
        } else {
            state.model = null;
            vm = null;
            state.error = res.code;
        }
    }

    async function loadAll() {
        state.loading = true;
        render();
        const [rules, settings, scan] = await Promise.all([call('/rules'), call('/settings'), call('/scan/status')]);
        if (rules.ok) state.rules = rules.body.rules || [];
        if (settings.ok) state.settings = settings.body.settings || state.settings;
        if (scan.ok) state.scan = scan.body.scan || null;
        absorbModel(await call('/model'));
        state.loading = false;
        if (state.scan && state.scan.status === 'running') { state.scanning = true; poll(); }
        render();
    }

    async function reloadModel() {
        const [rules, model] = await Promise.all([call('/rules'), call('/model')]);
        if (rules.ok) state.rules = rules.body.rules || [];
        absorbModel(model);
        render();
    }

    async function startScan() {
        if (state.scanning) return;
        const res = await call('/scan', { method: 'POST' });
        if (!res.ok && res.code !== 'scan_running') { toast(errorText(res.code), 'error'); return; }
        state.scanning = true;
        render();
        poll();
    }

    function poll() {
        clearTimeout(pollTimer);
        pollTimer = setTimeout(async () => {
            const st = await call('/scan/status');
            // A dropped request while the scan runs is not the scan failing: retry.
            if (!st.ok && st.code === 'network') { poll(); return; }
            if (st.ok) state.scan = st.body.scan || null;
            if (state.scan && state.scan.status === 'running' && st.ok) { poll(); return; }
            state.scanning = false;
            if (state.scan && state.scan.status === 'failed') {
                toast(T('at_scan_failed_toast', 'Analyse échouée : {reason}', { reason: errorText(state.scan.error_code) }), 'error');
                render();
                return;
            }
            await reloadModel();
            const n = vm ? vm.kpis.gaps : 0;
            const domain = vm ? vm.domain : '';
            if (n === 0) toast(T('at_scan_done_none', 'Analyse terminée : aucun écart de tiering sur {domain}.', { domain }), 'success');
            else if (n === 1) toast(T('at_scan_done_one', 'Analyse terminée : {n} écart de tiering sur {domain}.', { n, domain }), 'success');
            else toast(T('at_scan_done_many', 'Analyse terminée : {n} écarts de tiering sur {domain}.', { n, domain }), 'success');
        }, POLL_MS);
    }

    function set(patch) {
        Object.assign(state, patch);
        render();
    }

    function openAccount(id) {
        set({ acc: id, node: null, inverse: null, invSel: null, view: state.view === 'overview' ? 'tree' : state.view, overrideOpen: false, overrideError: null, menu: null });
    }

    const domainShown = () => state.settings.domain || (vm && vm.domain) || T('at_domain_current', 'domaine du serveur Aegis');

    // ── Title bar and banners ────────────────────────────────────────────────
    function renderHeader() {
        const meta = byId('at-meta');
        if (vm) {
            meta.textContent = T('at_meta', 'Comptes à privilèges : {n} · écarts de tiering : {g} · {domain} · analyse du {date}', {
                n: vm.kpis.accounts, g: vm.kpis.gaps, domain: domainShown(), date: dateText(vm.collectedAt)
            });
        } else {
            meta.textContent = T('at_meta_none', 'Aucune analyse affichable · {domain}', { domain: domainShown() });
        }
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

    // ── Left list ────────────────────────────────────────────────────────────
    function rowSub(a) {
        if (a.gap && a.kind === 'service') return T('at_row_gap_service', 'compte de service · T{planned} → T{effective}', a);
        if (a.gap) return T('at_row_gap', '{sam} · prévu T{planned} → T{effective}', a);
        return T('at_row_ok', '{sam} · Tier {effective}', a);
    }

    function rowHtml(a) {
        const sel = a.id === state.acc && state.inverse == null;
        return `<button type="button" class="at-arow${sel ? ' is-selected' : ''}" data-account="${esc(a.id)}" data-key="arow:${esc(a.id)}" aria-current="${sel}">
            <span class="at-arow-top"><span class="at-strong">${esc(a.name)}</span>${a.gap ? accountMark(a) : ''}</span>
            <span class="at-mono">${esc(rowSub(a))}</span></button>`;
    }

    function renderLeft() {
        const host = byId('at-left-dyn');
        const all = vm.accounts;
        const q = state.q.trim().toLowerCase();
        const list = all.filter((a) => (!q || a.name.toLowerCase().includes(q) || String(a.sam).toLowerCase().includes(q))
            && (state.cell ? (a.planned === state.cell.p && a.effective === state.cell.e) : (state.tier === 'all' || a.effective === Number(state.tier))));
        const gaps = list.filter((a) => a.gap);
        const rest = list.filter((a) => !a.gap);
        const filters = [['all', T('at_filter_all', 'Tous')], ['0', T('at_tier_n', 'Tier {tier}', { tier: 0 })], ['1', T('at_tier_n', 'Tier {tier}', { tier: 1 })], ['2', T('at_tier_n', 'Tier {tier}', { tier: 2 })]]
            .map(([k, label]) => {
                const on = !state.cell && state.tier === k;
                const n = k === 'all' ? all.length : all.filter((a) => a.effective === Number(k)).length;
                return `<button type="button" class="at-tf${on ? ' is-on' : ''}" data-tierf="${k}" data-key="tierf:${k}" aria-pressed="${on}"><span>${esc(label)}</span><span class="at-mono">${n}</span></button>`;
            }).join('');
        const chip = state.cell ? `<div class="at-cellchip" id="at-cellchip"><span>${esc(T('at_cell_chip', 'Prévu T{p} · effectif T{e}', state.cell))}</span><button type="button" class="at-x-btn" id="at-cell-clear" data-key="cell-clear" aria-label="${esc(T('at_cell_clear', 'Retirer ce filtre'))}">${icon('close')}</button></div>` : '';
        const head = (label) => `<div class="at-rule-head at-pad"><span>${esc(label)}</span><span class="at-rule-line"></span></div>`;
        let html = `<div class="at-pad at-stack"><span class="at-label">${esc(T('at_filter_label', 'Tier effectif'))}</span><div class="at-tfs" role="group" aria-label="${esc(T('at_filter_label', 'Tier effectif'))}">${filters}</div>${chip}</div>`;
        if (!all.length) html += `<p class="at-pad at-muted">${esc(T('at_left_none', 'Aucun compte à afficher pour {domain}.', { domain: domainShown() }))}</p>`;
        else if (!list.length) html += `<p class="at-pad at-muted" id="at-left-nomatch">${esc(T('at_left_nomatch', 'Aucun compte ne correspond à ces critères.'))}</p>`;
        if (gaps.length) {
            const shown = state.showAll ? gaps : gaps.slice(0, SHOW_GAPS);
            const more = gaps.length > SHOW_GAPS ? `<div class="at-pad at-more"><button type="button" class="at-link" id="at-more" data-key="more">${esc(state.showAll ? T('at_left_less', 'Réduire la liste') : T('at_left_more', 'Voir les {n} écarts ›', { n: gaps.length }))}</button></div>` : '';
            html += `<div class="at-group-list" id="at-list-gaps">${head(T('at_left_gaps', 'Écarts de tiering · {n}', { n: gaps.length }))}${shown.map(rowHtml).join('')}${more}</div>`;
        }
        if (rest.length) html += `<div class="at-group-list" id="at-list-ok">${head(T('at_left_ok', 'Conformes · {n}', { n: rest.length }))}${rest.map(rowHtml).join('')}</div>`;
        host.innerHTML = html;
        const clear = byId('at-search-clear');
        if (clear) clear.hidden = !state.q;
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

    function render() {
        const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
        renderHeader();
        renderBanners();
        renderState();
        if (vm && !state.loading && !state.error) {
            const c = AT.tree.compute(state, vm);
            renderLeft();
            renderCentre(c);
            byId('at-panel').innerHTML = AT.panel.panelHtml(c, state);
        }
        if (focusKey) {
            const el = document.querySelector(`#at-view [data-key="${CSS.escape(focusKey)}"]`);
            if (el && el !== document.activeElement && !el.disabled) el.focus({ preventScroll: true });
        }
    }

    AT.app = { state, call, set, render, reloadModel, openAccount, get vm() { return vm; } };
    AT.events.wire({ startScan });

    function init() {
        if (!byId('at-view')) return;
        translateStatic(byId('at-view'));
        const prev = window.onLanguageChange;
        window.onLanguageChange = function () {
            if (typeof prev === 'function') { try { prev(); } catch (_) { /* another page's handler */ } }
            translateStatic(byId('at-view'));
            if (state.model) vm = AT.model.buildViewModel(state.model, { t: T, rules: state.rules });
            render();
        };
        loadAll();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
