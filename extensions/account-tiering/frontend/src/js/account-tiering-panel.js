/*
 * Account Tiering: the right panel, "Détail de la sélection".
 *
 * One function per kind of selection (account, tier, mechanism, group, ghost,
 * and the inverted tree), each returning the same shape: crumb, title, mark,
 * summary, facts, then the shared blocks (accounts, paths, planned tier,
 * remediation, references, limits). Every value from the model is escaped.
 */
(function () {
    'use strict';

    const AT = (window.AccountTiering = window.AccountTiering || {});
    const { T, esc, icon, sevHtml, accountMark, TIER_NAMES, dateText } = AT.ui;
    const { sevOf, worst } = AT.model;

    const REFS = {
        member: [['MITRE-T1078.002', 'https://attack.mitre.org/techniques/T1078/002/']],
        acl: [['MITRE-T1098', 'https://attack.mitre.org/techniques/T1098/'], ['MITRE-T1222.001', 'https://attack.mitre.org/techniques/T1222/001/']],
        gpo: [['MITRE-T1484.001', 'https://attack.mitre.org/techniques/T1484/001/']]
    };
    const LIM = 8;
    const pl = (n, one, many, params) => T(n === 1 ? one[0] : many[0], n === 1 ? one[1] : many[1], { n, ...(params || {}) });
    const tierFact = (label, tier, danger) => ({ label, value: T('at_tier_n', 'Tier {tier}', { tier }), danger });
    const GAIN = () => [T('at_gain_0', 'le contrôle du domaine'), T('at_gain_1', "l'administration de serveurs"), T('at_gain_2', "l'accès aux postes de travail")];

    function factsHtml(facts) {
        if (!facts.length) return '';
        return `<dl class="at-facts">${facts.map((f) => `<div class="at-fact"><dt>${esc(f.label)}</dt><dd${f.danger ? ' class="is-danger"' : ''}>${esc(f.value)}</dd></div>`).join('')}</dl>`;
    }

    function sectionHead(label) {
        return `<div class="at-rule-head"><span>${esc(label)}</span><span class="at-rule-line"></span></div>`;
    }

    function pathsHtml(ms) {
        if (!ms.length) return '';
        const cards = ms.slice(0, LIM).map((m, i) => `<div class="at-path">
            <h3 class="at-path-title">${esc(T('at_path_title', '{i} · {rel}', { i: i + 1, rel: m.relTitle }))}</h3>
            <div class="at-chain">${m.chain.map((c, j) => `${j ? '<span class="at-chain-sep" aria-hidden="true">›</span>' : ''}<span class="at-chip">${esc(c)}</span>`).join('')}</div>
            <p class="at-text">${esc(m.why)}</p></div>`).join('');
        const more = ms.length > LIM
            ? `<span class="at-note">${esc(pl(ms.length - LIM, ['at_paths_more_one', '+ {n} autre chemin : la vue Liste les montre tous.'], ['at_paths_more_many', '+ {n} autres chemins : la vue Liste les montre tous.']))}</span>` : '';
        return `<div class="at-block">${sectionHead(T('at_paths_label', 'Chemins · {n}', { n: ms.length }))}${cards}${more}</div>`;
    }

    function refsHtml(ms) {
        const seen = new Set();
        const refs = [];
        ms.forEach((m) => (REFS[m.rel] || []).forEach((r) => { if (!seen.has(r[0])) { seen.add(r[0]); refs.push(r); } }));
        if (!refs.length) return '';
        return `<div class="at-block at-refs"><span class="at-label">${esc(T('at_refs', 'Référentiels'))}</span><div class="at-chips">${refs.map((r) => `<a class="at-chip at-chip-link" href="${esc(r[1])}" target="_blank" rel="noopener noreferrer">${esc(r[0])}</a>`).join('')}</div></div>`;
    }

    /**
     * Why, by whom and when a planned tier was corrected by hand. The reason is
     * free text typed by an administrator: it is shown under its own label and
     * never passed through a translation, so braces in it stay as typed. The
     * author and the date can each be missing (a correction made without a
     * session email, an unreadable date), hence one whole sentence per case.
     */
    function overrideShownHtml(ov) {
        if (!ov) return '';
        const p = { author: ov.setBy, date: dateText(ov.setAt) };
        let meta = '';
        if (p.author && p.date) meta = T('at_override_shown_by_at', 'Corrigé par {author}, le {date}', p);
        else if (p.author) meta = T('at_override_shown_by', 'Corrigé par {author}', p);
        else if (p.date) meta = T('at_override_shown_at', 'Corrigé le {date}', p);
        const why = ov.reason
            ? `<span class="at-label">${esc(T('at_override_shown_label', 'Motif de la correction'))}</span><p class="at-text" id="at-override-why">${esc(ov.reason)}</p>` : '';
        if (!why && !meta) return '';
        return `<div class="at-override-shown" id="at-override-shown">${why}${meta ? `<span class="at-note" id="at-override-meta">${esc(meta)}</span>` : ''}</div>`;
    }

    /**
     * "Tier prévu" with its source, the details of a manual correction, and the
     * correction form. The form is drawn from `s.overrideDraft`, what the user
     * has typed so far: the panel is rewritten on every render, and a form
     * drawn empty would lose its text to a search keystroke or a refused save.
     * `s.saving` disables the buttons that send, so a second click cannot send
     * the same correction twice.
     */
    function plannedHtml(acc, s) {
        const isOverride = acc.plannedSource && acc.plannedSource.type === 'override';
        const draft = s.overrideDraft || { tier: acc.planned, reason: '' };
        const busy = s.saving ? ' disabled' : '';
        const form = s.overrideOpen ? `<form class="at-override-form" id="at-override-form" novalidate>
                <label class="at-label" for="at-override-tier">${esc(T('at_override_tier', 'Tier prévu corrigé'))}</label>
                <select class="at-select" id="at-override-tier" name="tier" data-key="override-tier">${[0, 1, 2].map((t) => `<option value="${t}"${t === draft.tier ? ' selected' : ''}>${esc(T('at_tier_n', 'Tier {tier}', { tier: t }))}</option>`).join('')}</select>
                <label class="at-label" for="at-override-reason">${esc(T('at_override_reason', 'Motif (obligatoire)'))}</label>
                <textarea class="at-input at-textarea" id="at-override-reason" name="reason" data-key="override-reason" maxlength="256" rows="3" required>${esc(draft.reason)}</textarea>
                <p class="at-field-error" id="at-override-error" role="alert"${s.overrideError ? '' : ' hidden'}>${esc(s.overrideError ? AT.ui.errorText(s.overrideError) : '')}</p>
                <div class="at-row-actions">
                    <button type="button" class="at-btn" data-act="override-cancel" data-key="override-cancel">${esc(T('at_cancel', 'Annuler'))}</button>
                    <button type="submit" class="at-btn at-btn-ink" data-key="override-save"${busy}>${esc(T('at_override_save', 'Enregistrer la correction'))}</button>
                </div></form>` : '';
        const actions = s.overrideOpen ? '' : `<div class="at-row-actions">
                <button type="button" class="at-link" data-act="override-open" data-key="override-open">${esc(T('at_override_open', 'Corriger le tier prévu'))}</button>
                ${isOverride ? `<button type="button" class="at-link" data-act="override-remove" data-key="override-remove"${busy}>${esc(T('at_override_remove', 'Retirer la correction'))}</button>` : ''}</div>`;
        return `<section class="at-block at-planned" id="at-planned" aria-labelledby="at-planned-h">
            <h3 class="at-label" id="at-planned-h">${esc(T('at_planned_label', 'Tier prévu'))}</h3>
            <p class="at-text"><strong>${esc(T('at_tier_n', 'Tier {tier}', { tier: acc.planned }))}</strong> · <span id="at-planned-source">${esc(acc.sourceLabel)}</span></p>
            ${isOverride ? overrideShownHtml(acc.override) : ''}${actions}${form}</section>`;
    }

    function remediationHtml(acc) {
        if (!acc.steps.length) return '';
        if (acc.remediationProposed) {
            return `<div class="at-actions"><span class="at-badge" id="at-fix-badge">${icon('check', 'at-ok-ico')}${esc(T('at_fix_done', 'Remédiation proposée'))}</span></div>`;
        }
        return `<div class="at-actions"><button type="button" class="at-pill at-pill-outline" id="at-fix-open" data-act="fix-open" data-key="fix-open">${esc(T('at_fix_open', 'Proposer une remédiation'))}</button></div>`;
    }

    const limitsHtml = () => `<details class="at-limits"><summary>${esc(T('at_limits_title', "Limites de l'analyse"))}</summary><p class="at-text">${esc(T('at_limits_text', "Les filtres de sécurité et les filtres WMI des GPO ne sont pas évalués, et les ACE de refus ne sont pas soustraites. Le tier atteint peut donc être surévalué, jamais sous-évalué."))}</p></details>`;

    function accountPanel(c, s) {
        const acc = c.acc;
        const sel = c.sel;
        const fm = c.G.A.length ? c.G.A[0].ms : [];
        const byTier = (arr) => arr.slice().sort((p, q) => p.tier - q.tier);
        const groupOf = (m) => acc.groups.find((g) => g.key === m.gk) || { name: '', direct: true };
        const std = (n) => [
            tierFact(T('at_fact_planned', 'Tier prévu'), acc.planned, false),
            tierFact(T('at_fact_effective', 'Tier effectif'), acc.effective, acc.gap),
            { label: T('at_fact_paths', 'Chemins'), value: String(n) }
        ];
        const p = { sam: acc.sam, name: acc.name, planned: acc.planned, effective: acc.effective };
        let P;
        let ms = [];
        let withPlanned = false;
        if (!sel || sel.startsWith('a:')) {
            ms = byTier(fm);
            const crumbKey = { user: ['at_crumb_user', 'Compte utilisateur'], service: ['at_crumb_service', 'Compte de service'], computer: ['at_crumb_computer', 'Compte ordinateur'] }[acc.kind];
            let summary = T('at_sum_ok', '{sam} reste dans le Tier {planned} prévu pour lui.', p);
            if (acc.status === 'gap') summary = T('at_sum_gap', '{sam} est prévu en Tier {planned} mais atteint le Tier {effective}.', p);
            if (acc.status === 'below') summary = T('at_sum_below', "{sam} est prévu en Tier {planned} mais n'atteint que le Tier {effective} : son tier prévu est peut-être trop haut.", p);
            P = { crumb: T(crumbKey[0], crumbKey[1]), title: acc.name, mark: accountMark(acc), summary, facts: std(ms.length) };
            withPlanned = true;
        } else if (sel.startsWith('t:')) {
            const t = Number(sel.slice(2));
            ms = fm.filter((m) => m.tier === t);
            const n = ms.length;
            const q = { ...p, tier: t, n, gain: GAIN()[t] };
            let summary;
            if (t < acc.planned) summary = pl(n, ['at_sum_tier_gap_one', 'Prévu en Tier {planned}, ce compte obtient {gain} par {n} chemin.'], ['at_sum_tier_gap_many', 'Prévu en Tier {planned}, ce compte obtient {gain} par {n} chemins.'], q);
            else if (t === acc.planned) summary = pl(n, ['at_sum_tier_ok_one', 'Tier {tier} est le niveau prévu pour ce compte : {n} chemin y mène, sans écart.'], ['at_sum_tier_ok_many', 'Tier {tier} est le niveau prévu pour ce compte : {n} chemins y mènent, sans écart.'], q);
            else summary = T('at_sum_tier_under', "Tier {tier} est au-dessous du Tier {planned} prévu pour ce compte : ces chemins ne créent pas d'écart.", q);
            P = {
                crumb: T('at_crumb_tier', '{name} › Tier {tier} · {tn}', { name: acc.name, tier: t, tn: TIER_NAMES()[t] }),
                title: T('at_why_title', 'Pourquoi Tier {tier} ?', { tier: t }), mark: sevHtml(sevOf(acc.planned, t) || 'ok'), summary, facts: std(n)
            };
            withPlanned = true;
        } else if (sel.startsWith('m:')) {
            const m0 = c.G.Mm[sel.slice(2)].m;
            const g0 = groupOf(m0);
            ms = [m0];
            P = {
                crumb: T('at_crumb_pair', '{a} › {b}', { a: acc.name, b: g0.name }), title: m0.name, mark: sevHtml(m0.severity || 'ok'),
                summary: g0.direct ? T('at_sum_mech_direct', 'Droit accordé directement au compte, ce mécanisme donne le Tier {tier}.', { tier: m0.tier })
                    : T('at_sum_mech_via', 'Obtenu via {group}, ce mécanisme donne le Tier {tier}.', { group: g0.name, tier: m0.tier }),
                facts: [{ label: T('at_fact_rel', 'Relation'), value: m0.relTitle }, tierFact(T('at_fact_given', 'Tier donné'), m0.tier, Boolean(m0.severity)), tierFact(T('at_fact_planned', 'Tier prévu'), acc.planned, false)]
            };
        } else if (sel.startsWith('g:')) {
            const Gg = c.G.Gm[sel.slice(2)];
            ms = byTier(Object.keys(Gg.mechs).map((k) => c.G.Mm[k].m));
            const topT = Math.min(...ms.map((m) => m.tier));
            P = {
                crumb: T('at_crumb_pair', '{a} › {b}', { a: acc.name, b: Gg.g.direct ? T('at_direct_name', 'Droits directs') : T('at_crumb_group', 'Groupe') }),
                title: Gg.g.name, mark: sevHtml(worst(ms.map((m) => m.severity)) || 'ok'), summary: Gg.g.desc,
                facts: [{ label: T('at_fact_members', 'Membres'), value: Gg.g.members == null ? T('at_none', 'aucun') : String(Gg.g.members) },
                    { label: T('at_fact_mechs', 'Mécanismes'), value: String(ms.length) }, tierFact(T('at_fact_given', 'Tier donné'), topT, topT < acc.planned)]
            };
        } else {
            P = {
                crumb: acc.name, title: pl(acc.hidden, ['at_ghost_title_one', '{n} groupe sans privilège'], ['at_ghost_title_many', '{n} groupes sans privilège']), mark: '',
                summary: T('at_ghost_text', "Ces groupes ne mènent à aucun des tiers analysés. Cochez « Masquer non-privilégiés » pour alléger l'arbre."), facts: []
            };
        }
        return head(P) + pathsHtml(ms) + (withPlanned ? plannedHtml(acc, s) : '') + refsHtml(ms) + remediationHtml(acc);
    }

    function inversePanel(c) {
        const { G, H, inv, sel } = c;
        const inH = (id) => Boolean(H[id]);
        const accIn = G.A.filter((e) => inH('a:' + e.acc.id) || (!G.visA[e.acc.id] && inH('cl:a'))).map((e) => e.acc);
        const groupsIn = G.allG.filter((Gg) => inH('g:' + Gg.key) || (!G.visG[Gg.key] && inH('cl:g')));
        const mechsIn = Object.values(G.Mm).filter((M) => inH('m:' + M.key) || (!G.visM[M.key] && inH('cl:m')));
        const nA = accIn.length;
        const nE = accIn.filter((a) => inv < a.planned).length;
        const ecart = AT.app.state.ecartOnly;
        let title;
        let summary;
        if (!sel || sel.startsWith('t:')) {
            title = T('at_inv_title', 'Qui atteint le Tier {tier} ?', { tier: inv });
            summary = (ecart
                ? pl(nA, ['at_inv_sum_gap_one', '{n} compte atteint le Tier {tier} hors de son tier prévu.'], ['at_inv_sum_gap_many', '{n} comptes atteignent le Tier {tier} hors de leur tier prévu.'], { tier: inv })
                : pl(nA, ['at_inv_sum_one', '{n} compte atteint le Tier {tier}.'], ['at_inv_sum_many', '{n} comptes atteignent le Tier {tier}.'], { tier: inv }))
                + ' ' + T('at_inv_sum_counts', 'Groupes : {g} · mécanismes : {m}.', { g: Object.keys(G.Gm).length, m: Object.keys(G.Mm).length });
        } else if (sel.startsWith('a:')) {
            const ai = AT.app.vm.byId[sel.slice(2)];
            const en = G.A.find((e) => e.acc.id === ai.id);
            title = ai.name;
            summary = pl(en.ms.length, ['at_inv_sum_acc_one', '{sam} est prévu en Tier {planned} et atteint le Tier {tier} par {n} chemin.'], ['at_inv_sum_acc_many', '{sam} est prévu en Tier {planned} et atteint le Tier {tier} par {n} chemins.'], { sam: ai.sam, planned: ai.planned, tier: inv });
        } else if (sel.startsWith('g:')) {
            const Gi = G.Gm[sel.slice(2)];
            title = Gi.g.direct ? T('at_inv_direct_title', 'Droits directs · {sam}', { sam: Gi.acc.sam }) : Gi.g.name;
            summary = Gi.g.desc + ' ' + pl(nA, ['at_inv_sum_group_one', '{n} compte analysé passe par là pour atteindre le Tier {tier}.'], ['at_inv_sum_group_many', '{n} comptes analysés passent par là pour atteindre le Tier {tier}.'], { tier: inv });
        } else {
            const Mi = G.Mm[sel.slice(2)];
            title = Mi.m.name;
            summary = Mi.m.why + ' ' + pl(nA, ['at_inv_sum_mech_one', '{n} compte analysé en profite.'], ['at_inv_sum_mech_many', '{n} comptes analysés en profitent.']);
        }
        const P = {
            crumb: T('at_inv_crumb', 'Arbre inversé · Tier {tier} · {tn}', { tier: inv, tn: TIER_NAMES()[inv] }), title,
            mark: nA ? sevHtml(worst(accIn.map((a) => sevOf(a.planned, inv))) || 'ok') : '', summary,
            facts: [{ label: T('at_fact_accounts', 'Comptes'), value: String(nA) }, { label: T('at_fact_gaps', 'En écart'), value: String(nE), danger: nE > 0 },
                { label: T('at_fact_groups', 'Groupes'), value: String(groupsIn.length) }]
        };
        const rows = accIn.slice().sort((p, q) => (p.effective - p.planned) - (q.effective - q.planned)).map((a) => `<button type="button" class="at-prow" data-open-account="${esc(a.id)}" data-key="prow:${esc(a.id)}">
            <span class="at-prow-top"><span class="at-strong">${esc(a.name)}</span>${accountMark(a)}</span>
            <span class="at-mono">${esc(T('at_row_gap', '{sam} · prévu T{planned} → T{effective}', { sam: a.sam, planned: a.planned, effective: a.effective }))}</span></button>`).join('');
        const accounts = nA ? `<div class="at-block">${sectionHead(T('at_accounts_label', 'Comptes · {n}', { n: nA }))}${rows}<span class="at-note">${esc(T('at_accounts_hint', 'Cliquez un compte pour ouvrir son arbre.'))}</span></div>` : '';
        return head(P) + accounts + refsHtml(mechsIn.map((M) => M.m));
    }

    function head(P) {
        return `<div class="at-phead"><span class="at-crumb-small">${esc(P.crumb)}</span><h2 class="at-ptitle" id="at-panel-title">${esc(P.title)}</h2>${P.mark || ''}<p class="at-text">${esc(P.summary)}</p></div>${factsHtml(P.facts)}`;
    }

    function panelHtml(c, s) {
        if (!c) return `<p class="at-muted">${esc(T('at_panel_pick', 'Sélectionnez un compte pour afficher ses chemins de privilège.'))}</p>`;
        return (c.isInv ? inversePanel(c) : accountPanel(c, s)) + limitsHtml();
    }

    AT.panel = { panelHtml };
})();
