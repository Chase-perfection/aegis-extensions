/*
 * Account Tiering: "Vue d'ensemble". Key figures, the planned x effective
 * matrix (a cell click filters the left list) and the chokepoints ("Points de
 * passage", top 6, a click opens the inverted tree on that point).
 *
 * The matrix comes from the backend as is, so its Planned T2 x Effective T2
 * cell also counts the accounts the collector did not detail (tier2Totals).
 * The left list only holds detailed accounts, hence the note under the matrix.
 */
(function () {
    'use strict';

    const AT = (window.AccountTiering = window.AccountTiering || {});
    const { T, esc, sevHtml } = AT.ui;
    const TOP_POINTS = 6;

    function kpisHtml(vm) {
        const k = vm.kpis;
        const cards = [
            { id: 'accounts', label: T('at_kpi_accounts', 'Comptes à privilèges'), value: k.accounts, note: T('at_kpi_accounts_note', 'sur {domain}', { domain: vm.domain }) },
            { id: 'gaps', label: T('at_kpi_gaps', 'Écarts de tiering'), value: k.gaps, note: T('at_kpi_gaps_note', '{pct} % des comptes à privilèges', { pct: k.gapPct }) },
            { id: 't0', label: T('at_kpi_t0', 'Tier 0 hors prévu'), value: k.t0Unplanned, note: T('at_kpi_t0_note', 'comptes qui contrôlent le domaine'), danger: k.t0Unplanned > 0 },
            { id: 'points', label: T('at_kpi_points', 'Points de passage'), value: k.points, note: T('at_kpi_points_note', 'groupes ou droits à corriger') }
        ];
        return `<div class="at-kpis">${cards.map((c) => `<div class="at-kpi" data-kpi="${c.id}"><span class="at-label">${esc(c.label)}</span><span class="at-kpi-value${c.danger ? ' is-danger' : ''}">${esc(c.value)}</span><span class="at-note">${esc(c.note)}</span></div>`).join('')}</div>`;
    }

    function matrixHtml(vm, s) {
        const heads = [0, 1, 2].map((e) => `<span class="at-mx-head">${esc(T('at_mx_effective', 'Effectif T{tier}', { tier: e }))}</span>`).join('');
        const rows = [0, 1, 2].map((p) => {
            const cells = [0, 1, 2].map((e) => {
                const c = (vm.matrix[p] && vm.matrix[p][e]) || 0;
                const on = Boolean(s.cell && s.cell.p === p && s.cell.e === e);
                let mark = '';
                if (c && e < p) mark = sevHtml(e === 0 ? 'critical' : 'high');
                else if (c && e === p) mark = sevHtml('ok');
                else if (c && e > p) mark = `<span class="at-note">${esc(T('at_sev_below', 'Sous le prévu'))}</span>`;
                const aria = c === 1
                    ? T('at_mx_aria_one', '{n} compte prévu en Tier {p} et effectif en Tier {e}', { n: c, p, e })
                    : T('at_mx_aria_many', '{n} comptes prévus en Tier {p} et effectifs en Tier {e}', { n: c, p, e });
                return `<button type="button" class="at-mx-cell${on ? ' is-selected' : ''}${c ? '' : ' is-empty'}" data-cell="${p}-${e}" data-key="cell:${p}-${e}" aria-pressed="${on}" aria-label="${esc(aria)}"${c ? '' : ' disabled'}><span class="at-mx-count">${esc(c)}</span>${mark}</button>`;
            }).join('');
            return `<span class="at-mx-row">${esc(T('at_mx_planned', 'Prévu T{tier}', { tier: p }))}</span>${cells}`;
        }).join('');
        const note = vm.uncollected > 0
            ? `<p class="at-note">${esc(T('at_mx_uncollected', 'La case Prévu T2 · Effectif T2 compte aussi {n} comptes sans privilège que l’analyse ne détaille pas.', { n: vm.uncollected }))}</p>` : '';
        return `<div class="at-card">
            <div class="at-card-head"><h2 class="at-h2">${esc(T('at_mx_title', 'Tier prévu et tier effectif'))}</h2><span class="at-note">${esc(T('at_mx_hint', 'Cliquez une case pour filtrer la liste des comptes.'))}</span></div>
            <div class="at-matrix" id="at-matrix"><span></span>${heads}${rows}</div>${note}
            <div class="at-row-links">
                <button type="button" class="at-link" data-act="inv-0" data-key="inv-0">${esc(T('at_inv_link_0', 'Arbre inversé du Tier 0 ›'))}</button>
                <button type="button" class="at-link" data-act="inv-1" data-key="inv-1">${esc(T('at_inv_link_1', 'Arbre inversé du Tier 1 ›'))}</button>
            </div></div>`;
    }

    function pointsHtml(vm, s) {
        const list = s.showAllPoints ? vm.points : vm.points.slice(0, TOP_POINTS);
        const rows = list.map((p) => `<button type="button" class="at-point" data-point="${esc(p.key)}" data-key="point:${esc(p.key)}">
            <span class="at-point-name"><span class="at-strong at-ellipsis">${esc(p.name)}</span><span class="at-note at-ellipsis">${esc(p.meta)}</span></span>
            <span class="at-point-expo"><span class="at-bar"><span class="at-bar-fill" data-sev="${p.severity}" style="width:${p.pct}%"></span></span><span class="at-mono at-ink">${esc(p.expoLabel)}</span></span>
            <span class="at-point-sev">${sevHtml(p.severity)}</span></button>`).join('');
        const empty = vm.points.length ? '' : `<p class="at-empty-line">${esc(T('at_points_empty', 'Aucun groupe ni droit ne fait sortir un compte de son tier prévu.'))}</p>`;
        const more = vm.points.length > TOP_POINTS
            ? `<div><button type="button" class="at-link" data-act="points-toggle" data-key="points-toggle">${esc(s.showAllPoints ? T('at_points_less', 'Réduire') : T('at_points_more', 'Voir les {n} points de passage ›', { n: vm.points.length }))}</button></div>` : '';
        return `<div class="at-card">
            <div class="at-card-head"><h2 class="at-h2">${esc(T('at_points_title', 'Points de passage'))}</h2><span class="at-note">${esc(T('at_points_hint', 'Groupes et droits qui font sortir des comptes de leur tier prévu. Corriger en haut de liste rapporte le plus.'))}</span></div>
            <div class="at-points" id="at-points">${rows}${empty}</div>${more}</div>`;
    }

    function overviewHtml(vm, s) {
        return `<div class="at-overview" id="at-overview">${kpisHtml(vm)}<div class="at-ov-grid">${matrixHtml(vm, s)}${pointsHtml(vm, s)}</div></div>`;
    }

    AT.overview = { overviewHtml };
})();
