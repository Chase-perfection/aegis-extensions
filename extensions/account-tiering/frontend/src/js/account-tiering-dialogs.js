/*
 * Account Tiering: the two dialogs.
 *
 * - "Proposer une remédiation": one step per link of the account's path that
 *   puts it above its planned tier, each with the command to copy or the GPMC
 *   location. Nothing runs: confirming only records the "remédiation proposée"
 *   marker (POST /remediations/:sid), the spec keeps the core actions queue out
 *   of v1, so the dialog says so instead of promising a queue.
 * - "Règles de tiering": the ordered rule table (PUT /rules) and, on a second
 *   tab, the scan settings (PUT /settings, both fields always sent).
 *
 * Both open through AT.ui.openDialog (focus trap, Escape, focus return). Each
 * button that sends a request is disabled until the answer is back.
 */
(function () {
    'use strict';

    const AT = (window.AccountTiering = window.AccountTiering || {});
    const { T, esc, icon, errorText, openDialog, toast, copyText } = AT.ui;

    /**
     * Re-enables a button after a refused request and puts focus back on it:
     * disabling it dropped the focus, and from the body the next Tab would
     * leave the dialog.
     */
    const giveBack = (btn) => { btn.disabled = false; btn.focus(); };

    const closeBtn = () => `<button type="button" class="at-round-btn" data-dlg-close data-key="dlg-close" aria-label="${esc(T('at_close', 'Fermer'))}">${icon('close')}</button>`;

    // ── Remediation ─────────────────────────────────────────────────────────
    function stepHtml(st, i) {
        const body = st.command
            ? `<div class="at-code"><code class="at-code-text">${esc(st.command)}</code><button type="button" class="at-btn at-btn-sm" data-copy="${i}" data-key="copy:${i}">${icon('copy')}<span>${esc(T('at_copy', 'Copier'))}</span></button></div>`
            : `<p class="at-text">${esc(st.gpmc || '')}</p>`;
        const warn = st.warningText ? `<p class="at-step-warn">${icon('alert')}<span>${esc(st.warningText)}</span></p>` : '';
        return `<li class="at-step"><span class="at-step-num">${esc(st.n)}</span><div class="at-step-body"><p class="at-strong">${esc(st.title)}</p>${body}${warn}</div></li>`;
    }

    function openRemediation(acc) {
        const n = acc.steps.length;
        const meta = n === 1
            ? T('at_fix_meta_one', '{name} · {n} action', { name: acc.name, n })
            : T('at_fix_meta_many', '{name} · {n} actions', { name: acc.name, n });
        const lede = n > 1 ? `<p class="at-text">${esc(T('at_fix_lede', 'Chaque étape coupe ce chemin à elle seule : choisissez celle qui respecte votre organisation.'))}</p>` : '';
        const html = `<div class="at-dialog" role="dialog" aria-modal="true" aria-labelledby="at-fix-title" id="at-fix-dialog">
            <div class="at-dialog-head"><div class="at-dialog-titles"><h2 class="at-h2" id="at-fix-title">${esc(T('at_fix_title', 'Proposer une remédiation'))}</h2><span class="at-note">${esc(meta)}</span></div>${closeBtn()}</div>
            ${lede}<ol class="at-steps">${acc.steps.map(stepHtml).join('')}</ol>
            <div class="at-warnbox"><span class="at-warnbox-title">${esc(T('at_fix_nothing_title', "Rien n'est appliqué maintenant"))}</span><span>${esc(T('at_fix_nothing_text', 'Le compte est marqué « remédiation proposée ». Un administrateur Tier 0 exécute ces étapes lui-même, après validation.'))}</span></div>
            <p class="at-field-error" id="at-fix-error" role="alert" hidden></p>
            <div class="at-dialog-foot">
                <button type="button" class="at-pill at-pill-outline" data-dlg-close data-key="fix-cancel">${esc(T('at_cancel', 'Annuler'))}</button>
                <button type="button" class="at-pill at-pill-ink" id="at-fix-confirm" data-key="fix-confirm">${esc(T('at_fix_confirm', 'Marquer comme proposée'))}</button>
            </div></div>`;
        const dlg = openDialog(html);
        dlg.el.addEventListener('click', async (e) => {
            const copy = e.target.closest('[data-copy]');
            if (copy) {
                const ok = await copyText(acc.steps[Number(copy.dataset.copy)].command);
                toast(ok ? T('at_copied', 'Commande copiée.') : T('at_copy_failed', 'Copie impossible : sélectionnez la commande à la main.'), ok ? 'success' : 'warning');
                return;
            }
            if (e.target.closest('#at-fix-confirm')) {
                const btn = e.target.closest('#at-fix-confirm');
                btn.disabled = true;
                const res = await AT.app.call('/remediations/' + encodeURIComponent(acc.sid), { method: 'POST' });
                if (!res.ok) {
                    giveBack(btn);
                    const err = dlg.el.querySelector('#at-fix-error');
                    err.textContent = errorText(res.code);
                    err.hidden = false;
                    return;
                }
                dlg.close();
                toast(T('at_fix_toast', 'Remédiation proposée pour {sam}.', { sam: acc.sam }), 'success');
                AT.app.reloadModel();
            }
        });
    }

    // ── Rules and settings ──────────────────────────────────────────────────
    let draft = [];
    const KINDS = () => [
        ['ou', T('at_kind_ou', 'OU'), T('at_kind_ou_ph', 'OU=Admins-T0,DC=corp,DC=local')],
        ['name', T('at_kind_name', 'Nom'), T('at_kind_name_ph', '*-adm')],
        ['group', T('at_kind_group', 'Groupe'), T('at_kind_group_ph', 'SID du groupe')]
    ];

    /**
     * One rule as a table row. Each control sits INSIDE its cell: `role="cell"`
     * on the control itself would replace its own role, and a screen reader
     * would announce a cell where there is a list or a text field.
     */
    function ruleRowHtml(r, i) {
        const kinds = KINDS();
        const ph = (kinds.find((k) => k[0] === r.kind) || kinds[0])[2];
        const last = i === draft.length - 1;
        return `<div class="at-rule" role="row" data-row="${i}">
            <span class="at-rule-n" role="cell">${i + 1}</span>
            <div class="at-rule-cell" role="cell"><select class="at-select" data-field="kind" data-key="rule-kind:${i}" aria-label="${esc(T('at_rule_kind', 'Type de la règle {n}', { n: i + 1 }))}">${kinds.map((k) => `<option value="${k[0]}"${k[0] === r.kind ? ' selected' : ''}>${esc(k[1])}</option>`).join('')}</select></div>
            <div class="at-rule-cell" role="cell"><input class="at-input" type="text" maxlength="256" data-field="pattern" data-key="rule-pattern:${i}" value="${esc(r.pattern)}" placeholder="${esc(ph)}" aria-label="${esc(T('at_rule_pattern', 'Motif de la règle {n}', { n: i + 1 }))}"${r.kind === 'group' ? ' list="at-group-sids"' : ''}></div>
            <div class="at-rule-cell" role="cell"><select class="at-select" data-field="tier" data-key="rule-tier:${i}" aria-label="${esc(T('at_rule_tier', 'Tier de la règle {n}', { n: i + 1 }))}">${[0, 1, 2].map((t) => `<option value="${t}"${t === r.tier ? ' selected' : ''}>${esc(T('at_tier_n', 'Tier {tier}', { tier: t }))}</option>`).join('')}</select></div>
            <span class="at-rule-tools" role="cell">
                <button type="button" class="at-icon-btn at-icon-btn-sm" data-move="-1" data-key="rule-up:${i}" aria-label="${esc(T('at_rule_up', 'Monter la règle {n}', { n: i + 1 }))}"${i === 0 ? ' disabled' : ''}>${icon('up')}</button>
                <button type="button" class="at-icon-btn at-icon-btn-sm" data-move="1" data-key="rule-down:${i}" aria-label="${esc(T('at_rule_down', 'Descendre la règle {n}', { n: i + 1 }))}"${last ? ' disabled' : ''}>${icon('down')}</button>
                <button type="button" class="at-icon-btn at-icon-btn-sm" data-del data-key="rule-del:${i}" aria-label="${esc(T('at_rule_delete', 'Supprimer la règle {n}', { n: i + 1 }))}">${icon('trash')}</button>
            </span></div>`;
    }

    function rowsHtml() {
        // A rowgroup holds rows: a bare paragraph in it is invalid ARIA, so the message is a row of one cell.
        if (!draft.length) return `<div role="row"><div class="at-empty-line" role="cell">${esc(T('at_rules_none', 'Aucune règle : tous les comptes sont considérés Tier 2.'))}</div></div>`;
        return draft.map(ruleRowHtml).join('');
    }

    function openRules(tab) {
        const app = AT.app;
        draft = (app.state.rules || []).map((r) => ({ kind: r.kind, pattern: r.pattern, tier: r.tier }));
        const settings = app.state.settings || { domain: null, passes: 3 };
        const groups = (app.state.model && app.state.model.groups) || [];
        const datalist = `<datalist id="at-group-sids">${groups.map((g) => `<option value="${esc(g.sid)}">${esc(g.name || g.sam)}</option>`).join('')}</datalist>`;
        const html = `<div class="at-dialog at-dialog-wide" role="dialog" aria-modal="true" aria-labelledby="at-rules-title" id="at-rules-dialog">
            <div class="at-dialog-head"><div class="at-dialog-titles"><h2 class="at-h2" id="at-rules-title">${esc(T('at_rules_title', 'Règles de tiering'))}</h2><span class="at-note">${esc(T('at_rules_meta', 'La première règle qui correspond donne le tier prévu. Un compte qu’aucune règle ne couvre est Tier 2.'))}</span></div>${closeBtn()}</div>
            <div class="at-tabs" role="tablist" aria-label="${esc(T('at_rules_tabs', 'Paramètres'))}">
                <button type="button" role="tab" class="at-tab" id="at-tab-rules" aria-controls="at-tabpanel-rules" data-tab="rules" data-key="tab-rules">${esc(T('at_tab_rules', 'Règles'))}</button>
                <button type="button" role="tab" class="at-tab" id="at-tab-scan" aria-controls="at-tabpanel-scan" data-tab="scan" data-key="tab-scan">${esc(T('at_tab_scan', 'Analyse'))}</button>
            </div>
            <div role="tabpanel" id="at-tabpanel-rules" aria-labelledby="at-tab-rules" class="at-tabpanel">
                <ul class="at-help"><li>${esc(T('at_help_ou', 'OU : le DN du compte se termine par ce motif, sans tenir compte de la casse.'))}</li><li>${esc(T('at_help_name', 'Nom : motif sur le sAMAccountName, * pour une suite de caractères, ? pour un seul.'))}</li><li>${esc(T('at_help_group', 'Groupe : SID d’un groupe, appartenance directe, imbriquée ou par groupe principal.'))}</li></ul>
                <div class="at-rules" role="table" aria-label="${esc(T('at_rules_title', 'Règles de tiering'))}">
                    <div class="at-rule at-rule-head-row" role="row"><span role="columnheader">#</span><span role="columnheader">${esc(T('at_rule_col_kind', 'Type'))}</span><span role="columnheader">${esc(T('at_rule_col_pattern', 'Motif'))}</span><span role="columnheader">${esc(T('at_rule_col_tier', 'Tier'))}</span><span role="columnheader"></span></div>
                    <div id="at-rule-rows" role="rowgroup">${rowsHtml()}</div>
                </div>${datalist}
                <div><button type="button" class="at-btn" id="at-rule-add" data-key="rule-add">${icon('plus')}<span>${esc(T('at_rule_add', 'Ajouter une règle'))}</span></button></div>
                <p class="at-field-error" id="at-rules-error" role="alert" hidden></p>
                <div class="at-dialog-foot"><button type="button" class="at-pill at-pill-outline" data-dlg-close data-key="rules-cancel">${esc(T('at_cancel', 'Annuler'))}</button><button type="button" class="at-pill at-pill-ink" id="at-rules-save" data-key="rules-save">${esc(T('at_rules_save', 'Enregistrer les règles'))}</button></div>
            </div>
            <div role="tabpanel" id="at-tabpanel-scan" aria-labelledby="at-tab-scan" class="at-tabpanel">
                <label class="at-label" for="at-set-domain">${esc(T('at_set_domain', 'Domaine analysé'))}</label>
                <input class="at-input" type="text" id="at-set-domain" maxlength="253" value="${esc(settings.domain || '')}" placeholder="${esc(T('at_set_domain_ph', 'corp.local'))}">
                <span class="at-note">${esc(T('at_set_domain_help', 'Laissez vide pour analyser le domaine du serveur Aegis.'))}</span>
                <label class="at-label" for="at-set-passes">${esc(T('at_set_passes', 'Nombre de passes'))}</label>
                <input class="at-input at-input-num" type="number" id="at-set-passes" min="1" max="5" step="1" value="${esc(settings.passes || 3)}">
                <span class="at-note">${esc(T('at_set_passes_help', 'Chaque passe suit les droits un niveau plus loin. De 1 à 5.'))}</span>
                <p class="at-field-error" id="at-set-error" role="alert" hidden></p>
                <div class="at-dialog-foot"><button type="button" class="at-pill at-pill-outline" data-dlg-close data-key="set-cancel">${esc(T('at_cancel', 'Annuler'))}</button><button type="button" class="at-pill at-pill-ink" id="at-set-save" data-key="set-save">${esc(T('at_set_save', 'Enregistrer'))}</button></div>
            </div></div>`;
        const dlg = openDialog(html);
        const el = dlg.el;
        const showTab = (name) => {
            for (const t of el.querySelectorAll('[role="tab"]')) {
                const on = t.dataset.tab === name;
                t.setAttribute('aria-selected', String(on));
                t.tabIndex = on ? 0 : -1;
            }
            el.querySelector('#at-tabpanel-rules').hidden = name !== 'rules';
            el.querySelector('#at-tabpanel-scan').hidden = name !== 'scan';
        };
        showTab(tab === 'scan' ? 'scan' : 'rules');
        const redraw = (focusKey) => {
            el.querySelector('#at-rule-rows').innerHTML = rowsHtml();
            const f = focusKey && el.querySelector(`[data-key="${focusKey}"]`);
            if (f && !f.disabled) f.focus();
        };
        const fail = (id, code) => { const p = el.querySelector(id); p.textContent = errorText(code); p.hidden = false; };

        el.addEventListener('input', (e) => syncField(e.target));
        el.addEventListener('change', (e) => {
            syncField(e.target);
            if (e.target.dataset.field === 'kind') redraw(e.target.dataset.key);
        });
        el.addEventListener('keydown', (e) => {
            const tabBtn = e.target.closest('[role="tab"]');
            if (tabBtn && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
                const next = tabBtn.dataset.tab === 'rules' ? 'scan' : 'rules';
                showTab(next);
                el.querySelector(`[data-tab="${next}"]`).focus();
            }
        });
        el.addEventListener('click', async (e) => {
            const t = e.target;
            const tabBtn = t.closest('[data-tab]');
            if (tabBtn) { showTab(tabBtn.dataset.tab); return; }
            const row = t.closest('[data-row]');
            const i = row ? Number(row.dataset.row) : -1;
            if (t.closest('[data-move]')) {
                const d = Number(t.closest('[data-move]').dataset.move);
                const j = i + d;
                if (j < 0 || j >= draft.length) return;
                [draft[i], draft[j]] = [draft[j], draft[i]];
                redraw(`rule-${d < 0 ? 'up' : 'down'}:${j}`);
                return;
            }
            if (t.closest('[data-del]')) {
                draft.splice(i, 1);
                redraw(draft.length ? `rule-del:${Math.min(i, draft.length - 1)}` : 'rule-add');
                return;
            }
            if (t.closest('#at-rule-add')) {
                draft.push({ kind: 'ou', pattern: '', tier: 0 });
                redraw(`rule-pattern:${draft.length - 1}`);
                return;
            }
            // Both saves disable their button for the time of the request, as
            // the remediation confirm does: a double click sends one request.
            const save = t.closest('#at-rules-save, #at-set-save');
            if (!save || save.disabled) return;
            save.disabled = true;
            if (save.id === 'at-rules-save') {
                const res = await app.call('/rules', { method: 'PUT', json: { rules: draft.map((r) => ({ kind: r.kind, pattern: r.pattern, tier: r.tier })) } });
                if (!res.ok) { giveBack(save); fail('#at-rules-error', res.code); return; }
                app.state.rules = res.body.rules || [];
                dlg.close();
                toast(T('at_rules_saved', 'Règles enregistrées : les tiers prévus sont recalculés.'), 'success');
                app.reloadModel();
                return;
            }
            const domain = el.querySelector('#at-set-domain').value.trim();
            const passes = Number.parseInt(el.querySelector('#at-set-passes').value, 10);
            const res = await app.call('/settings', { method: 'PUT', json: { domain, passes } });
            if (!res.ok) { giveBack(save); fail('#at-set-error', res.code); return; }
            app.state.settings = res.body.settings || { domain: domain || null, passes };
            dlg.close();
            toast(T('at_set_saved', 'Paramètres enregistrés : ils servent à la prochaine analyse.'), 'success');
            app.render();
        });
    }

    function syncField(input) {
        const row = input.closest('[data-row]');
        if (!row || !input.dataset.field) return;
        const r = draft[Number(row.dataset.row)];
        if (!r) return;
        if (input.dataset.field === 'tier') r.tier = Number(input.value);
        else r[input.dataset.field] = input.value;
    }

    AT.dialogs = { openRemediation, openRules };
})();
