/*
 * Account Tiering: the left list. Tier filters with their counts, the matrix
 * cell chip, then the accounts in two groups: gaps first, compliant after.
 *
 * Sized for a domain of thousands of privileged accounts. The list is rewritten
 * on every render, so what it draws is bounded: the gaps show SHOW_GAPS rows
 * until unfolded, and each group then draws `state.leftLimit` rows at most,
 * raised STEP at a time by its "more" control. The counts in the headings and
 * on the filters stay those of the whole domain; the filter counts come from
 * the view model, which counts them once per model and not once per render.
 */
(function () {
    'use strict';

    const AT = (window.AccountTiering = window.AccountTiering || {});
    const { T, esc, icon, accountMark } = AT.ui;
    const SHOW_GAPS = 3;
    const STEP = 100;

    function rowSub(a) {
        if (a.gap && a.kind === 'service') return T('at_row_gap_service', 'compte de service · T{planned} → T{effective}', a);
        if (a.gap) return T('at_row_gap', '{sam} · prévu T{planned} → T{effective}', a);
        return T('at_row_ok', '{sam} · Tier {effective}', a);
    }

    function rowHtml(a, s) {
        const sel = a.id === s.acc && s.inverse == null;
        return `<button type="button" class="at-arow${sel ? ' is-selected' : ''}" data-account="${esc(a.id)}" data-key="arow:${esc(a.id)}" aria-current="${sel}">
            <span class="at-arow-top"><span class="at-strong">${esc(a.name)}</span>${a.gap ? accountMark(a) : ''}</span>
            <span class="at-mono">${esc(rowSub(a))}</span></button>`;
    }

    /** The control under a group that is not drawn whole: it says how many rows the next click adds. */
    function moreHtml(group, hidden) {
        if (hidden <= 0) return '';
        const n = Math.min(STEP, hidden);
        const label = n === 1
            ? T('at_left_step_one', 'Afficher {n} compte de plus ›', { n })
            : T('at_left_step_many', 'Afficher {n} comptes de plus ›', { n });
        return `<div class="at-pad at-more"><button type="button" class="at-link" id="at-more-${group}" data-act="left-more" data-key="more-${group}">${esc(label)}</button></div>`;
    }

    /** `domain` is the name shown when the domain has no account at all. */
    function leftHtml(vm, s, domain) {
        const all = vm.accounts;
        const q = s.q.trim().toLowerCase();
        const gaps = [];
        const rest = [];
        for (const a of all) {
            if (q && !a.name.toLowerCase().includes(q) && !String(a.sam).toLowerCase().includes(q)) continue;
            if (s.cell ? (a.planned !== s.cell.p || a.effective !== s.cell.e) : (s.tier !== 'all' && a.effective !== Number(s.tier))) continue;
            (a.gap ? gaps : rest).push(a);
        }
        const filters = [['all', T('at_filter_all', 'Tous')], ['0', T('at_tier_n', 'Tier {tier}', { tier: 0 })], ['1', T('at_tier_n', 'Tier {tier}', { tier: 1 })], ['2', T('at_tier_n', 'Tier {tier}', { tier: 2 })]]
            .map(([k, label]) => {
                const on = !s.cell && s.tier === k;
                const n = k === 'all' ? all.length : vm.tierCounts[Number(k)];
                return `<button type="button" class="at-tf${on ? ' is-on' : ''}" data-tierf="${k}" data-key="tierf:${k}" aria-pressed="${on}"><span>${esc(label)}</span><span class="at-mono">${n}</span></button>`;
            }).join('');
        const chip = s.cell ? `<div class="at-cellchip" id="at-cellchip"><span>${esc(T('at_cell_chip', 'Prévu T{p} · effectif T{e}', s.cell))}</span><button type="button" class="at-x-btn" id="at-cell-clear" data-key="cell-clear" aria-label="${esc(T('at_cell_clear', 'Retirer ce filtre'))}">${icon('close')}</button></div>` : '';
        const head = (label) => `<div class="at-rule-head at-pad"><span>${esc(label)}</span><span class="at-rule-line"></span></div>`;
        const rows = (list) => list.map((a) => rowHtml(a, s)).join('');
        let html = `<div class="at-pad at-stack"><span class="at-label">${esc(T('at_filter_label', 'Tier effectif'))}</span><div class="at-tfs" role="group" aria-label="${esc(T('at_filter_label', 'Tier effectif'))}">${filters}</div>${chip}</div>`;
        if (!all.length) html += `<p class="at-pad at-muted">${esc(T('at_left_none', 'Aucun compte à afficher pour {domain}.', { domain }))}</p>`;
        else if (!gaps.length && !rest.length) html += `<p class="at-pad at-muted" id="at-left-nomatch">${esc(T('at_left_nomatch', 'Aucun compte ne correspond à ces critères.'))}</p>`;
        if (gaps.length) {
            const shown = gaps.slice(0, s.showAll ? s.leftLimit : SHOW_GAPS);
            const fold = gaps.length > SHOW_GAPS ? `<div class="at-pad at-more"><button type="button" class="at-link" id="at-more" data-key="more">${esc(s.showAll ? T('at_left_less', 'Réduire la liste') : T('at_left_more', 'Voir les {n} écarts ›', { n: gaps.length }))}</button></div>` : '';
            html += `<div class="at-group-list" id="at-list-gaps">${head(T('at_left_gaps', 'Écarts de tiering · {n}', { n: gaps.length }))}${rows(shown)}${s.showAll ? moreHtml('gaps', gaps.length - shown.length) : ''}${fold}</div>`;
        }
        if (rest.length) {
            const shown = rest.slice(0, s.leftLimit);
            html += `<div class="at-group-list" id="at-list-ok">${head(T('at_left_ok', 'Conformes · {n}', { n: rest.length }))}${rows(shown)}${moreHtml('ok', rest.length - shown.length)}</div>`;
        }
        return html;
    }

    AT.left = { leftHtml, STEP };
})();
