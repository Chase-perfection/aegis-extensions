/*
 * Account Tiering: the centre column's tree and list views, with free pan,
 * wheel pan, ctrl+wheel zoom, zoom buttons, fit and the mini-map.
 *
 * The view transform (x, y, z) lives here, outside the page state, and is
 * applied straight onto the layer's style: panning is a hot path and must not
 * re-render the DOM. It is refitted only when what is drawn changes (the
 * `fitKey`), or when the stage is resized before the user moved the view.
 * No easing and no transition on the transform: the mockup moves directly,
 * which also keeps it honest under prefers-reduced-motion.
 */
(function () {
    'use strict';

    const AT = (window.AccountTiering = window.AccountTiering || {});
    const { T, esc, icon, sevHtml } = AT.ui;
    const Gr = AT.graph;
    const { sevOf, worst } = AT.model;

    const view = { x: 0, y: 0, z: 1, key: null, bottom: 600, ms: 0.1, moved: false, drag: null };
    let observer = null;

    /** The graph, the selection and its highlight for the current state. Shared with the panel. */
    function compute(s, vm) {
        if (!vm) return null;
        const isInv = s.inverse != null;
        const acc = vm.byId[s.acc] || null;
        if (!isInv && !acc) return null;
        const ek = isInv ? 'inv' + s.inverse : acc.id;
        const selRaw = isInv ? s.invSel : s.node;
        const keepG = selRaw && selRaw.startsWith('g:') ? selRaw.slice(2) : null;
        const G = Gr.buildGraph(isInv ? vm.accounts : [acc], {
            tier: isInv ? s.inverse : null, ecartOnly: s.ecartOnly, inverse: isInv,
            expandG: Boolean(s.expanded['g:' + ek]), expandA: Boolean(s.expanded['a:' + ek]), keepG,
            ghost: !isInv && acc.hidden > 0 && !s.hideGhost
        });
        const depth = s.view === 'tree' ? s.depth : 4;
        const vis = (id) => G.y[id] != null && Gr.colOf(id) < depth;
        const pickable = (id) => Boolean(id) && vis(id) && !id.startsWith('cl:') && id !== 'fold';
        const defSel = G.col3.length && vis(G.col3[0]) ? G.col3[0] : (G.col0.length ? G.col0[0] : null);
        const sel = pickable(selRaw) ? selRaw : defSel;
        return { G, isInv, inv: s.inverse, acc, ek, sel, H: Gr.highlight(G.edges, sel), vis, depth };
    }

    const plural = (n, one, many) => (n === 1 ? T(one[0], one[1], { n }) : T(many[0], many[1], { n }));

    function metaOf(id, c) {
        const { G, isInv, acc } = c;
        if (id.startsWith('a:')) {
            const a = AT.app.vm.byId[id.slice(2)];
            const svc = a.kind === 'service';
            return {
                title: a.name, icon: svc ? 'cog' : 'user',
                sub: svc ? T('at_node_svc_sub', 'service · prévu T{planned}', { planned: a.planned })
                    : T('at_node_acc_sub', '{sam} · prévu T{planned}', { sam: a.sam, planned: a.planned })
            };
        }
        if (id === 'cl:a') {
            return { title: T('at_fold_accounts', '+ {n} comptes', { n: G.colA.length }), sub: T('at_fold_click', 'cliquer pour déplier'), icon: 'plus', soft: true, act: 'expand-a' };
        }
        if (id.startsWith('g:')) {
            const Gg = G.Gm[id.slice(2)];
            const g = Gg.g;
            const sub = isInv && g.direct ? Gg.acc.sam : g.sub;
            return { title: g.name, sub, icon: g.direct ? 'key' : (g.t0 ? 'shield' : 'group') };
        }
        if (id === 'cl:g') {
            const byT = {};
            G.colG.forEach((Gg) => { byT[Gg.minTier] = (byT[Gg.minTier] || 0) + 1; });
            const sub = Object.keys(byT).sort().map((t) => T('at_fold_by_tier', '{n} vers T{tier}', { n: byT[t], tier: t })).join(' · ');
            return { title: T('at_fold_groups', '+ {n} groupes', { n: G.colG.length }), sub, icon: 'plus', soft: true, act: 'expand-g' };
        }
        if (id === 'fold') {
            return { title: T('at_fold_back', 'Replier les groupes'), sub: T('at_fold_shown', '{n} groupes affichés', { n: G.allG.length }), icon: 'minus', soft: true, act: 'fold-g' };
        }
        if (id === 'ghost') {
            return {
                title: plural(acc.hidden, ['at_ghost_one', '{n} autre groupe'], ['at_ghost_many', '{n} autres groupes']),
                sub: T('at_ghost_sub', 'sans privilège'), icon: 'plus', soft: true
            };
        }
        if (id.startsWith('m:')) {
            const m = G.Mm[id.slice(2)].m;
            return { title: m.name, sub: m.sub, icon: m.icon };
        }
        if (id === 'cl:m') {
            return {
                title: plural(G.colM.length, ['at_fold_mechs_one', '{n} mécanisme'], ['at_fold_mechs_many', '{n} mécanismes']),
                sub: T('at_fold_click', 'cliquer pour déplier'), icon: 'plus', soft: true, act: 'expand-g'
            };
        }
        const t = Number(id.slice(2));
        const mark = isInv ? worst(G.A.map((e) => sevOf(e.acc.planned, t))) : sevOf(acc.planned, t);
        return { title: T('at_tier_node', 'Tier {tier} · {name}', { tier: t, name: AT.ui.TIER_NAMES()[t] }), icon: 'layers', tier: true, mark: mark || 'ok' };
    }

    function headsHtml(c) {
        const heads = c.isInv
            ? [['at_col_accounts', 'Comptes'], ['at_col_groups_inv', 'Groupes'], ['at_col_mechs', 'Mécanismes'], ['at_col_target', 'Cible']]
            : [['at_col_account', 'Compte'], ['at_col_groups', 'Groupes directs'], ['at_col_mech', 'Mécanisme'], ['at_col_tier', 'Tier atteint']];
        return heads.map((h, i) => (i < c.depth
            ? `<div class="at-colhead" style="left:${Gr.COLX[i]}px;top:${Gr.HEAD_Y}px">${esc(T(h[0], h[1]))}</div>` : '')).join('');
    }

    function nodesHtml(c, mini) {
        const out = [];
        for (const id of Object.keys(c.G.y)) {
            if (!c.vis(id)) continue;
            const me = metaOf(id, c);
            const x = Gr.COLX[Gr.colOf(id)];
            const y = c.G.y[id] - 36;
            const isSel = id === c.sel;
            mini.push({ x, y, hl: Boolean(c.H[id]) });
            const cls = ['at-node', me.soft ? 'is-soft' : '', isSel ? 'is-selected' : '', c.H[id] ? 'is-path' : ''].join(' ').trim();
            const body = me.tier
                ? `<span class="at-node-title">${esc(me.title)}</span>${sevHtml(me.mark)}`
                : `<span class="at-node-title">${esc(me.title)}</span><span class="at-node-sub">${esc(me.sub || '')}</span>`;
            out.push(`<button type="button" class="${cls}" style="left:${x}px;top:${y}px" data-node="${esc(id)}"${me.act ? ` data-node-act="${me.act}"` : ''} data-key="node:${esc(id)}" aria-pressed="${isSel}" title="${esc(me.title)}">${icon(me.icon, 'at-node-ico')}<span class="at-node-text">${body}</span></button>`);
        }
        return out.join('');
    }

    function edgesHtml(c) {
        const list = [];
        for (const e of c.G.edges) {
            if (!c.vis(e.from) || !c.vis(e.to)) continue;
            const hl = Boolean(c.H[e.from] && c.H[e.to]);
            const geo = Gr.edgeGeometry(Gr.COLX[Gr.colOf(e.from)] + Gr.CW, c.G.y[e.from], Gr.COLX[Gr.colOf(e.to)] - 3, c.G.y[e.to]);
            list.push({ hl, rel: e.rel, geo });
        }
        // Highlighted edges last, so the selected path is drawn over the others.
        list.sort((p, q) => (p.hl ? 1 : 0) - (q.hl ? 1 : 0));
        const dash = { member: '', acl: ' stroke-dasharray="6 4"', gpo: ' stroke-dasharray="2 4"' };
        return list.map(({ hl, rel, geo }) => `<svg class="at-edge${hl ? ' is-hl' : ''}" data-rel="${rel}" width="${geo.w}" height="${geo.h}" style="left:${geo.left}px;top:${geo.top}px" aria-hidden="true"><path d="${geo.trunk}"/><path d="${geo.tail}"${dash[rel] || ''} marker-end="url(#${hl ? 'at-ah-ink' : 'at-ah-grey'})"/></svg>`).join('');
    }

    function legendHtml() {
        const line = (cls, dashAttr, key, fb) => `<span class="at-legend-item"><svg class="at-legend-line ${cls}" viewBox="0 0 28 8" aria-hidden="true"><path d="M0 4H28"${dashAttr}/></svg>${esc(T(key, fb))}</span>`;
        return `<div class="at-legend">${line('', '', 'at_legend_member', 'Appartenance')}${line('', ' stroke-dasharray="6 4"', 'at_legend_acl', 'Délégation ACL')}${line('', ' stroke-dasharray="2 4"', 'at_legend_gpo', 'GPO')}<span class="at-legend-sep"></span>${line('is-ink', '', 'at_legend_selected', 'Chemin sélectionné')}${line('is-grey', '', 'at_legend_other', 'Autre chemin')}</div>`;
    }

    function controlsHtml(mini) {
        const ms = view.ms;
        const rects = mini.map((r) => `<span class="at-mini-node${r.hl ? ' is-hl' : ''}" style="left:${(8 + r.x * ms).toFixed(1)}px;top:${(8 + r.y * ms).toFixed(1)}px;width:${Math.max(2, Gr.CW * ms).toFixed(1)}px;height:${Math.max(2, Gr.CH * ms).toFixed(1)}px"></span>`).join('');
        return `<div class="at-zoom">
            <button type="button" class="at-icon-btn" id="at-zoom-out" data-key="zoom-out" aria-label="${esc(T('at_zoom_out', 'Dézoomer'))}">${icon('minus')}</button>
            <span class="at-zoom-label" id="at-zoom-label" aria-live="polite"></span>
            <button type="button" class="at-icon-btn" id="at-zoom-in" data-key="zoom-in" aria-label="${esc(T('at_zoom_in', 'Zoomer'))}">${icon('plus')}</button>
            <button type="button" class="at-icon-btn" id="at-fit" data-key="fit" aria-label="${esc(T('at_fit', "Ajuster à l'écran"))}" title="${esc(T('at_fit', "Ajuster à l'écran"))}">${icon('fit')}</button>
        </div>
        <button type="button" class="at-mini" id="at-mini" data-key="mini" aria-label="${esc(T('at_minimap', 'Mini-carte : cliquer pour centrer la vue à cet endroit'))}">${rects}<span class="at-mini-rect" id="at-mini-rect"></span></button>`;
    }

    const MARKERS = '<svg class="at-defs" width="0" height="0" aria-hidden="true"><defs><marker id="at-ah-ink" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path class="at-ah-ink" d="M0 0L10 5L0 10z"/></marker><marker id="at-ah-grey" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path class="at-ah-grey" d="M0 0L10 5L0 10z"/></marker></defs></svg>';

    /** Tree view HTML. `c` is compute()'s result with at least one account drawn. */
    function treeHtml(c, fitKey) {
        const mini = [];
        const nodes = nodesHtml(c, mini);
        view.bottom = c.G.bottom;
        view.ms = Math.min(184 / Gr.CONTENT_W, 120 / (c.G.bottom + 40));
        if (fitKey !== view.key) { view.key = fitKey; view.pendingFit = true; }
        return `${MARKERS}<div class="at-vp" id="at-vp"><div class="at-layer" id="at-layer" style="height:${c.G.bottom + 200}px">${headsHtml(c)}${edgesHtml(c)}${nodes}</div></div>${legendHtml()}${controlsHtml(mini)}`;
    }

    function stageSize() {
        const vp = document.getElementById('at-vp');
        const r = vp ? vp.getBoundingClientRect() : null;
        return r && r.width ? { W: r.width, H: r.height } : { W: 1000, H: 700 };
    }

    function fit() {
        const { W, H } = stageSize();
        Object.assign(view, Gr.fitFor(view.bottom, W, H), { moved: false });
        apply();
    }

    function apply() {
        const layer = document.getElementById('at-layer');
        const vp = document.getElementById('at-vp');
        if (!layer || !vp) return;
        layer.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
        vp.style.backgroundSize = `${24 * view.z}px ${24 * view.z}px`;
        vp.style.backgroundPosition = `${view.x}px ${view.y}px`;
        const { W, H } = stageSize();
        const r = document.getElementById('at-mini-rect');
        if (r) {
            r.style.left = `${8 - view.x / view.z * view.ms}px`;
            r.style.top = `${8 - view.y / view.z * view.ms}px`;
            r.style.width = `${W / view.z * view.ms}px`;
            r.style.height = `${H / view.z * view.ms}px`;
        }
        const label = document.getElementById('at-zoom-label');
        if (label) label.textContent = T('at_zoom_pct', '{n} %', { n: Math.round(view.z * 100) });
        const out = document.getElementById('at-zoom-out');
        const inn = document.getElementById('at-zoom-in');
        if (out) out.disabled = view.z <= Gr.ZMIN + 1e-9;
        if (inn) inn.disabled = view.z >= Gr.ZMAX - 1e-9;
    }

    function zoomAt(px, py, z) {
        const nz = Gr.clampZ(z);
        view.x = px - (px - view.x) * nz / view.z;
        view.y = py - (py - view.y) * nz / view.z;
        view.z = nz;
        view.moved = true;
        apply();
    }

    /** Wires the freshly rendered tree. Called after every centre render that drew a tree. */
    function mount() {
        const vp = document.getElementById('at-vp');
        if (!vp) return;
        if (view.pendingFit) { view.pendingFit = false; fit(); } else apply();
        vp.addEventListener('wheel', (e) => {
            e.preventDefault();
            const r = vp.getBoundingClientRect();
            if (e.ctrlKey || e.metaKey) {
                zoomAt(e.clientX - r.left, e.clientY - r.top, view.z * Math.exp(-e.deltaY * 0.002));
                return;
            }
            const unit = e.deltaMode === 1 ? 16 : 1;
            let dx = e.deltaX;
            let dy = e.deltaY;
            if (e.shiftKey && !dx) { dx = dy; dy = 0; }
            view.x -= dx * unit;
            view.y -= dy * unit;
            view.moved = true;
            apply();
        }, { passive: false });
        vp.addEventListener('pointerdown', (e) => {
            // A press on a node is a click, never the start of a drag.
            if (e.button !== 0 || e.target.closest('button')) return;
            view.drag = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
            vp.setPointerCapture(e.pointerId);
            vp.classList.add('is-grabbing');
        });
        vp.addEventListener('pointermove', (e) => {
            const d = view.drag;
            if (!d) return;
            view.x = d.ox + (e.clientX - d.sx);
            view.y = d.oy + (e.clientY - d.sy);
            view.moved = true;
            apply();
        });
        const up = () => { view.drag = null; vp.classList.remove('is-grabbing'); };
        vp.addEventListener('pointerup', up);
        vp.addEventListener('pointercancel', up);

        const stage = document.getElementById('at-stage');
        if (observer) observer.disconnect();
        if (stage && typeof ResizeObserver === 'function') {
            observer = new ResizeObserver(() => { if (view.moved) apply(); else fit(); });
            observer.observe(stage);
        }
    }

    /** Clicks inside the stage that belong to the tree's own controls. Returns true when handled. */
    function onClick(e) {
        const t = e.target;
        const { W, H } = stageSize();
        if (t.closest('#at-zoom-out')) { zoomAt(W / 2, H / 2, Math.round((view.z - 0.1) * 10) / 10); return true; }
        if (t.closest('#at-zoom-in')) { zoomAt(W / 2, H / 2, Math.round((view.z + 0.1) * 10) / 10); return true; }
        if (t.closest('#at-fit')) { fit(); return true; }
        const mini = t.closest('#at-mini');
        if (mini) {
            // A keyboard activation has no pointer position: it fits instead.
            if (!e.detail) { fit(); return true; }
            const r = mini.getBoundingClientRect();
            const lx = ((e.clientX - r.left) - 8) / view.ms;
            const ly = ((e.clientY - r.top) - 8) / view.ms;
            view.x = W / 2 - lx * view.z;
            view.y = H / 2 - ly * view.z;
            view.moved = true;
            apply();
            return true;
        }
        return false;
    }

    function listHtml(c) {
        const rows = [];
        c.G.A.forEach((e) => e.ms.slice().sort((p, q) => p.tier - q.tier).forEach((m) => {
            const id = 'm:' + m.key;
            const on = c.sel === id;
            const g = e.acc.groups.find((x) => x.key === m.gk) || { name: '' };
            const first = c.isInv ? e.acc.name : g.name;
            const sub = c.isInv ? T('at_list_via', 'via {group}', { group: g.name }) : m.sub;
            const sev = m.severity || (m.tier >= e.acc.planned ? 'ok' : null);
            // A row is an account, a group and a mechanism: two groups can lead
            // to the same mechanism, so the key needs all three to be unique.
            const key = `lrow:${e.acc.id}|${m.gk}|${m.key}`;
            rows.push(`<button type="button" class="at-lrow${on ? ' is-selected' : ''}" data-node="${esc(id)}" data-key="${esc(key)}" aria-pressed="${on}">
                <span class="at-lrow-strong">${esc(first)}</span>
                <span class="at-lrow-mech"><span>${esc(m.name)}</span><span class="at-mono">${esc(sub)}</span></span>
                <span>${esc(m.relTitle)}</span>
                <span class="at-lrow-strong">${esc(T('at_tier_n', 'Tier {tier}', { tier: m.tier }))}</span>
                <span>${sevHtml(sev)}</span></button>`);
        }));
        const heads = c.isInv
            ? [['at_lh_account', 'Compte'], ['at_lh_mech_via', 'Mécanisme · via'], ['at_lh_rel', 'Relation'], ['at_lh_tier', 'Tier atteint'], ['at_lh_gap', 'Écart']]
            : [['at_lh_group', 'Groupe'], ['at_lh_mech', 'Mécanisme'], ['at_lh_rel', 'Relation'], ['at_lh_tier', 'Tier atteint'], ['at_lh_gap', 'Écart']];
        const empty = rows.length ? '' : `<p class="at-empty-line">${esc(T('at_list_empty', 'Aucun chemin à afficher avec ces filtres.'))}</p>`;
        return `<div class="at-list" id="at-list" role="region" aria-label="${esc(T('at_view_list', 'Liste'))}"><div class="at-lhead">${heads.map((h) => `<span>${esc(T(h[0], h[1]))}</span>`).join('')}</div>${rows.join('')}${empty}</div>`;
    }

    AT.tree = { compute, treeHtml, listHtml, mount, onClick, fit, view };
})();
