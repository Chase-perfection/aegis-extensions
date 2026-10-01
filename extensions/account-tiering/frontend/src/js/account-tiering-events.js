/*
 * Account Tiering: every user action on the page, by delegation.
 *
 * Regions are re-rendered as HTML, so listeners sit on the document and read
 * `data-*` attributes rather than holding element references that a render
 * would orphan. Dialogs handle their own clicks (account-tiering-dialogs.js).
 */
(function () {
    'use strict';

    const AT = (window.AccountTiering = window.AccountTiering || {});
    const { T, errorText, toast } = AT.ui;

    function wire(hooks) {
        const app = () => AT.app;
        const st = () => AT.app.state;
        const inView = (e) => e.target.closest && e.target.closest('#at-view') && !e.target.closest('#at-dialog-root');

        function expandKey() {
            const s = st();
            return s.inverse != null ? 'inv' + s.inverse : s.acc;
        }

        /** The first of a chokepoint's candidate nodes that the inverted tree actually draws. */
        function pointSelection(point) {
            const probe = { ...st(), view: 'tree', inverse: point.tier, invSel: null, ecartOnly: true };
            const c = AT.tree.compute(probe, app().vm);
            return (c && point.select.find((id) => c.G.y[id] != null)) || null;
        }

        async function saveOverride(form) {
            const s = st();
            const tier = Number(form.querySelector('#at-override-tier').value);
            const reason = form.querySelector('#at-override-reason').value.trim();
            if (!reason || reason.length > 256) { app().set({ overrideError: 'reason_required' }); return; }
            const res = await app().call('/overrides/' + encodeURIComponent(s.acc), { method: 'PUT', json: { tier, reason } });
            if (!res.ok) { app().set({ overrideError: res.code }); return; }
            Object.assign(s, { overrideOpen: false, overrideError: null });
            toast(T('at_override_saved', 'Tier prévu corrigé : les écarts sont recalculés.'), 'success');
            await app().reloadModel();
        }

        async function removeOverride() {
            const res = await app().call('/overrides/' + encodeURIComponent(st().acc), { method: 'DELETE' });
            if (!res.ok) { toast(errorText(res.code), 'error'); return; }
            toast(T('at_override_removed', 'Correction retirée : le tier prévu revient aux règles.'), 'success');
            await app().reloadModel();
        }

        document.addEventListener('click', (e) => {
            if (!e.target.closest) return;
            // Any click outside an open menu closes it, as in the mockup.
            if (st().menu && !e.target.closest('.at-menu-wrap')) app().set({ menu: null });
            if (!inView(e)) return;
            const t = e.target;
            const on = (sel) => t.closest(sel);
            const s = st();
            if (on('#at-scan') || on('[data-act="scan"]')) { hooks.startScan(); return; }
            if (on('#at-rules-open') || on('[data-act="rules-open"]')) { AT.dialogs.openRules('rules'); return; }
            if (on('#at-export')) { app().set({ menu: s.menu === 'export' ? null : 'export' }); return; }
            if (on('#at-export-menu a')) { app().set({ menu: null }); return; }
            if (on('#at-search-clear')) {
                const input = document.getElementById('at-search');
                input.value = '';
                app().set({ q: '' });
                input.focus();
                return;
            }
            if (on('[data-tierf]')) { app().set({ tier: on('[data-tierf]').dataset.tierf, cell: null }); return; }
            if (on('#at-cell-clear')) { app().set({ cell: null }); return; }
            if (on('#at-more')) { app().set({ showAll: !s.showAll }); return; }
            if (on('[data-account]')) { app().openAccount(on('[data-account]').dataset.account); return; }
            if (on('[data-open-account]')) { app().openAccount(on('[data-open-account]').dataset.openAccount); return; }
            if (on('[data-viewbtn]')) { app().set({ view: on('[data-viewbtn]').dataset.viewbtn, menu: null }); return; }
            if (on('#at-depth')) { app().set({ menu: s.menu === 'depth' ? null : 'depth' }); return; }
            if (on('[data-depth]')) { app().set({ depth: Number(on('[data-depth]').dataset.depth), menu: null }); return; }
            if (on('#at-inverse')) {
                app().set(s.inverse != null ? { inverse: null, invSel: null } : { inverse: 0, invSel: null });
                return;
            }
            if (AT.tree.onClick(e)) return;
            const node = on('[data-node]');
            if (node) {
                const act = node.dataset.nodeAct;
                const ek = expandKey();
                if (act === 'expand-g' || act === 'expand-a') {
                    app().set({ expanded: { ...s.expanded, [(act === 'expand-g' ? 'g:' : 'a:') + ek]: true } });
                } else if (act === 'fold-g') {
                    const ex = { ...s.expanded };
                    delete ex['g:' + ek];
                    app().set({ expanded: ex });
                } else {
                    app().set(s.inverse != null ? { invSel: node.dataset.node } : { node: node.dataset.node, overrideOpen: false, overrideError: null });
                }
                return;
            }
            const cell = on('[data-cell]');
            if (cell) {
                const [p, ev] = cell.dataset.cell.split('-').map(Number);
                app().set({ cell: { p, e: ev }, tier: 'all', showAll: true });
                toast(T('at_cell_toast', 'Liste filtrée : prévu Tier {p}, effectif Tier {e}.', { p, e: ev }));
                return;
            }
            const point = on('[data-point]');
            if (point) {
                const pt = app().vm.points.find((x) => x.key === point.dataset.point);
                if (pt && pt.tier != null) app().set({ view: 'tree', inverse: pt.tier, invSel: pointSelection(pt), ecartOnly: true });
                return;
            }
            const act = on('[data-act]') && on('[data-act]').dataset.act;
            if (act === 'inv-0' || act === 'inv-1') { app().set({ view: 'tree', inverse: Number(act.slice(4)), invSel: null }); return; }
            if (act === 'points-toggle') { app().set({ showAllPoints: !s.showAllPoints }); return; }
            if (act === 'fix-open') { AT.dialogs.openRemediation(app().vm.byId[s.acc]); return; }
            if (act === 'override-open') { app().set({ overrideOpen: true, overrideError: null }); document.getElementById('at-override-reason').focus(); return; }
            if (act === 'override-cancel') { app().set({ overrideOpen: false, overrideError: null }); return; }
            if (act === 'override-remove') removeOverride();
        });

        document.addEventListener('change', (e) => {
            if (!inView(e)) return;
            if (e.target.id === 'at-ecart') app().set({ ecartOnly: e.target.checked });
            if (e.target.id === 'at-ghost') {
                const s = st();
                app().set({ hideGhost: e.target.checked, node: s.node === 'ghost' ? null : s.node });
            }
        });

        document.addEventListener('input', (e) => {
            if (e.target.id === 'at-search') app().set({ q: e.target.value });
        });

        document.addEventListener('submit', (e) => {
            if (e.target.id !== 'at-override-form') return;
            e.preventDefault();
            saveOverride(e.target);
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && st().menu && !document.querySelector('#at-dialog-root [role="dialog"]')) {
                const opener = st().menu === 'export' ? 'at-export' : 'at-depth';
                app().set({ menu: null });
                const el = document.getElementById(opener);
                if (el) el.focus();
            }
        });
    }

    AT.events = { wire };
})();
