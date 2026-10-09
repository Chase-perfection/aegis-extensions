/*
 * Network Inventory · the DHCP view.
 *
 * The subnet explorer shows DHCP folded into networks: one card per subnet,
 * leases flattened into addresses. This view shows it the way a DHCP console
 * does, by server: every server the scan tried, whether it answered or not,
 * and under each one its scopes, leases, reservations, address pool and MAC
 * filters as that server holds them.
 *
 * It exists because the folded view cannot answer "where is my scope". A scope
 * that no server returned leaves its network with an empty card, and the only
 * place that says which server refused, or that a server is missing from the
 * list altogether, is a list of servers.
 *
 * Read only in this release. It holds no copy of the inventory: the page's main
 * module announces each load and each scan with an `ni:inventory` event, and
 * this one redraws from it.
 *
 * Every label is written here, in French, or through T(key, fallback) with a
 * key core does not carry: core prints an unknown data-i18n key as the key.
 */
(function () {
    'use strict';

    const byId = id => document.getElementById(id);
    const esc = window.escHtml || (s => (s == null ? '' : String(s)));
    const T = (key, fallback) => (window.t ? window.t(key, fallback) : fallback);

    const state = {
        dhcp: null,
        diagnostics: [],
        loading: true,
        // { server, kind: 'server' | 'scope' | 'filters', scopeId }
        sel: null,
        tab: '',
        query: '',
        sort: { key: '', dir: 1 },
        // A network the subnet explorer asked for before the data was there.
        wantedCidr: null
    };

    // ── reading the block ──────────────────────────────────────────────────
    function servers() {
        return state.dhcp && Array.isArray(state.dhcp.servers) ? state.dhcp.servers : [];
    }
    function findServer(name) {
        return servers().find(s => s.name === name) || null;
    }
    function selected() {
        if (!state.sel) return { server: null, scope: null };
        const server = findServer(state.sel.server);
        const scope = server && state.sel.kind === 'scope'
            ? (server.scopes || []).find(x => x.scopeId === state.sel.scopeId) || null
            : null;
        return { server, scope };
    }

    function ipNum(ip) {
        const o = String(ip || '').split('.');
        if (o.length !== 4) return -1;
        return o.reduce((acc, p) => acc * 256 + (parseInt(p, 10) || 0), 0);
    }

    /**
     * True for a locally administered address: the second hexadecimal digit is
     * 2, 6, A or E. Phones and laptops present one of these per network, and a
     * new one after a reset, which is how one device comes to hold several
     * leases.
     */
    function isRandomMac(mac) {
        const hex = String(mac || '').replace(/[^0-9a-fA-F]/g, '');
        return hex.length >= 2 && '26aeAE'.includes(hex[1]);
    }

    function durationLabel(seconds) {
        if (seconds == null) return T('ni_dhcp_lease_unlimited', 'illimitée');
        const s = Number(seconds);
        if (!Number.isFinite(s) || s <= 0) return '';
        if (s % 86400 === 0) return (s / 86400) + ' j';
        if (s >= 3600) return (Math.round((s / 3600) * 10) / 10) + ' h';
        return Math.round(s / 60) + ' min';
    }

    function dateLabel(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        const p = n => String(n).padStart(2, '0');
        return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    const LEASE_STATES = {
        active: 'Actif',
        declined: 'Refusé, adresse en conflit',
        expired: 'Expiré',
        activereservation: 'Réservation active',
        inactivereservation: 'Réservation inactive'
    };
    function leaseStateLabel(raw) {
        const key = String(raw || '').toLowerCase();
        return LEASE_STATES[key] || String(raw || '');
    }

    const SERVER_STATUS = {
        read: { label: 'Lu', variant: 'success' },
        refused: { label: 'Accès refusé', variant: 'danger' },
        unreachable: { label: 'Sans réponse', variant: 'danger' },
        stale: { label: 'Autorisation à revoir', variant: 'danger' }
    };
    function statusOf(server) {
        return SERVER_STATUS[server.status] || SERVER_STATUS.unreachable;
    }
    function tag(opts) {
        if (typeof window.agTag === 'function') return window.agTag(opts);
        return `<span class="ni-chip-inline">${esc(opts.label)}</span>`;
    }

    /** The scan's own diagnostics for one server, matched on its short name. */
    function diagnosticsFor(server) {
        const want = ('dhcp - ' + String(server.name || '')).toLowerCase();
        return state.diagnostics.filter(d => String(d.source || '').toLowerCase() === want);
    }

    function poolOf(scope) {
        const a = ipNum(scope.rangeStart), b = ipNum(scope.rangeEnd);
        const size = a >= 0 && b >= a ? b - a + 1 : 0;
        const excluded = (scope.exclusions || []).reduce((n, x) => {
            const s = ipNum(x.start), e = ipNum(x.end);
            return n + (s >= 0 && e >= s ? e - s + 1 : 0);
        }, 0);
        return { size, excluded, usable: Math.max(size - excluded, 0) };
    }
    function activeLeases(scope) {
        return (scope.leases || []).filter(l => String(l.state || '').toLowerCase().includes('active'));
    }
    function occupancy(scope) {
        if (scope.utilization != null) return Math.max(0, Math.min(100, Math.round(Number(scope.utilization))));
        const usable = poolOf(scope).usable;
        return usable ? Math.min(100, Math.round((activeLeases(scope).length / usable) * 100)) : 0;
    }

    /** Host names that hold more than one active lease in a scope. */
    function repeatedHosts(scope) {
        const count = new Map();
        activeLeases(scope).forEach(l => {
            const h = String(l.hostName || '').trim().toLowerCase();
            if (h) count.set(h, (count.get(h) || 0) + 1);
        });
        return new Set([...count.entries()].filter(([, n]) => n > 1).map(([h]) => h));
    }

    // ── selection ──────────────────────────────────────────────────────────
    function select(sel) {
        state.sel = sel;
        state.tab = sel.kind === 'scope' ? 'leases' : (sel.kind === 'filters' ? 'deny' : 'scopes');
        state.query = '';
        state.sort = { key: '', dir: 1 };
        const search = byId('ni-dhcp-search');
        if (search) search.value = '';
        render();
    }

    function selectCidr(cidr) {
        for (const server of servers()) {
            const scope = (server.scopes || []).find(x => x.cidr === cidr);
            if (scope) { select({ server: server.name, kind: 'scope', scopeId: scope.scopeId }); return true; }
        }
        return false;
    }

    /** Keeps the selection on something that still exists after a new scan. */
    function ensureSelection() {
        const { server, scope } = selected();
        if (server && (state.sel.kind !== 'scope' || scope)) return;
        const all = servers();
        if (!all.length) { state.sel = null; return; }
        const withScope = all.find(s => (s.scopes || []).length);
        state.sel = withScope
            ? { server: withScope.name, kind: 'scope', scopeId: withScope.scopes[0].scopeId }
            : { server: all[0].name, kind: 'server', scopeId: null };
        state.tab = state.sel.kind === 'scope' ? 'leases' : 'scopes';
    }

    // ── tree ───────────────────────────────────────────────────────────────
    function renderTree() {
        const tree = byId('ni-dhcp-tree');
        const foot = byId('ni-dhcp-foot');
        if (!tree) return;
        const all = servers();

        if (state.loading) {
            tree.innerHTML = '';
        } else if (!state.dhcp) {
            tree.innerHTML = `<div class="ni-empty-state">${esc(T('ni_dhcp_tree_unknown', 'Relancer le scan pour lire les serveurs DHCP.'))}</div>`;
        } else if (!all.length) {
            tree.innerHTML = `<div class="ni-empty-state">${esc(T('ni_dhcp_tree_empty', 'Aucun serveur DHCP connu. Un serveur Windows peut être déclaré ci-dessous.'))}</div>`;
        } else {
            tree.innerHTML = all.map(server => {
                const st = statusOf(server);
                const isSel = kind => state.sel && state.sel.server === server.name && state.sel.kind === kind;
                const scopes = (server.scopes || []).map(scope => {
                    const on = isSel('scope') && state.sel.scopeId === scope.scopeId;
                    const pct = occupancy(scope);
                    return `
                    <button class="ni-dhcp-node ni-dhcp-leaf${on ? ' selected' : ''}" type="button"
                        data-dhcp-server="${esc(server.name)}" data-dhcp-kind="scope" data-dhcp-scope="${esc(scope.scopeId)}">
                        <span class="ni-dhcp-node-main">
                            <span class="ni-cidr">${esc(scope.cidr || scope.scopeId)}</span>
                            <span class="ni-net-count">${esc(pct)}%</span>
                        </span>
                        <span class="ni-desc">${esc(scope.name || T('ni_dhcp_scope_unnamed', 'Étendue sans nom'))}</span>
                    </button>`;
                }).join('');
                const filters = server.filters ? `
                    <button class="ni-dhcp-node ni-dhcp-leaf${isSel('filters') ? ' selected' : ''}" type="button"
                        data-dhcp-server="${esc(server.name)}" data-dhcp-kind="filters">
                        <span class="ni-dhcp-node-main">
                            <span class="ni-desc">${esc(T('ni_dhcp_filters', 'Filtres MAC'))}</span>
                            <span class="ni-net-count">${(server.filters.allow || []).length + (server.filters.deny || []).length}</span>
                        </span>
                    </button>` : '';
                return `
                <div class="ni-dhcp-server">
                    <button class="ni-dhcp-node${isSel('server') ? ' selected' : ''}" type="button"
                        data-dhcp-server="${esc(server.name)}" data-dhcp-kind="server">
                        <span class="ni-dhcp-node-main">
                            <span class="ni-dhcp-server-name">${esc(String(server.name || '').toUpperCase())}</span>
                            ${tag({ label: st.label, variant: st.variant, mono: true })}
                        </span>
                        <span class="ni-desc">${esc(server.fqdn || '')}</span>
                    </button>
                    ${scopes}${filters}
                </div>`;
            }).join('');
        }

        if (foot) {
            const read = all.filter(s => s.status === 'read').length;
            foot.textContent = all.length
                ? T('ni_dhcp_foot', '{r} serveur(s) lu(s) sur {t}').replace('{r}', read).replace('{t}', all.length)
                : '';
        }
    }

    // ── summary cards ──────────────────────────────────────────────────────
    function card(title, body, caption, extraClass) {
        return `
        <div class="ni-ctx-card${extraClass ? ' ' + extraClass : ''}">
            <div class="ni-ctx-head"><span class="ni-ctx-title">${esc(title)}</span></div>
            ${body}
            ${caption ? `<span class="ni-ctx-caption">${esc(caption)}</span>` : ''}
        </div>`;
    }

    function scopeSummary(scope) {
        const pool = poolOf(scope);
        const pct = occupancy(scope);
        const active = activeLeases(scope);
        const random = active.filter(l => isRandomMac(l.mac)).length;
        const repeated = repeatedHosts(scope).size;
        const inactive = scope.state && !/active/i.test(scope.state);
        const fo = scope.failover
            ? T('ni_dhcp_failover', 'Basculement {m} avec {p}, état {s}')
                .replace('{m}', scope.failover.mode || '?').replace('{p}', scope.failover.partner || '?')
                .replace('{s}', scope.failover.state || '?')
            : '';
        return [
            card(T('ni_dhcp_card_range', 'PLAGE'),
                `<span class="ni-ctx-strong">${esc(scope.rangeStart)} → ${esc(scope.rangeEnd)}</span>`,
                [T('ni_dhcp_mask', 'masque {m}').replace('{m}', scope.mask || '?'),
                    inactive ? T('ni_dhcp_scope_inactive', 'étendue inactive') : '', fo].filter(Boolean).join(' · '),
                inactive ? 'warn' : ''),
            card(T('ni_dhcp_card_occupancy', 'OCCUPATION'),
                `<div class="ni-dhcp-row">
                    <span class="ni-bar"><span class="ni-bar-fill" style="width:${pct}%"></span></span>
                    <span class="ni-pct">${esc(pct)}%</span>
                </div>`,
                T('ni_dhcp_occupancy_caption', '{a} baux actifs · {u} adresses distribuables · {x} exclues')
                    .replace('{a}', active.length).replace('{u}', pool.usable).replace('{x}', pool.excluded),
                pct >= 80 ? 'warn' : ''),
            card(T('ni_dhcp_card_leases', 'BAUX'),
                `<span class="ni-ctx-strong">${esc(T('ni_dhcp_lease_duration', 'Durée du bail : {d}').replace('{d}', durationLabel(scope.leaseSeconds)))}</span>`,
                T('ni_dhcp_leases_caption', '{r} MAC aléatoire(s) sur {n} baux actifs · {h} nom(s) d\'hôte sur plusieurs baux')
                    .replace('{r}', random).replace('{n}', active.length).replace('{h}', repeated),
                repeated > 0 ? 'warn' : '')
        ].join('');
    }

    function serverSummary(server) {
        const st = statusOf(server);
        const diags = diagnosticsFor(server).filter(d => d.status !== 'ok');
        const first = diags[0];
        const f = server.filters;
        const onOff = on => (on ? T('ni_dhcp_on', 'activée') : T('ni_dhcp_off', 'coupée'));
        return [
            card(T('ni_dhcp_card_state', 'ÉTAT'),
                `<span class="ni-ctx-strong">${esc(st.label)}</span>`,
                first ? first.message : (server.status === 'read'
                    ? T('ni_dhcp_state_read', '{n} étendue(s) IPv4 lue(s)').replace('{n}', (server.scopes || []).length)
                    : T('ni_dhcp_state_unread', 'Ce serveur n\'a pas pu être lu.')),
                server.status === 'read' ? '' : 'warn'),
            card(T('ni_dhcp_card_origin', 'ORIGINE'),
                `<span class="ni-ctx-strong">${esc(server.origin === 'declared'
                    ? T('ni_dhcp_origin_declared', 'Déclaré à la main')
                    : T('ni_dhcp_origin_directory', 'Autorisé dans l\'annuaire'))}</span>`,
                server.fqdn || ''),
            card(T('ni_dhcp_card_filters', 'FILTRES MAC'),
                f
                    ? `<span class="ni-ctx-strong">${esc(T('ni_dhcp_filters_counts', 'Refuser : {d} · Autoriser : {a}')
                        .replace('{d}', (f.deny || []).length).replace('{a}', (f.allow || []).length))}</span>`
                    : `<span class="ni-ctx-empty">${esc(T('ni_dhcp_filters_unread', 'Non lus'))}</span>`,
                f ? T('ni_dhcp_filters_state', 'Liste Refuser {d} · liste Autoriser {a}')
                    .replace('{d}', onOff(f.denyEnabled)).replace('{a}', onOff(f.allowEnabled)) : '')
        ].join('');
    }

    function filtersSummary(server) {
        const f = server.filters || { allow: [], deny: [] };
        const line = (on, n) => (on
            ? T('ni_dhcp_filter_enforced', 'Appliquée · {n} adresse(s)').replace('{n}', n)
            : T('ni_dhcp_filter_idle', 'Coupée · {n} adresse(s), sans effet').replace('{n}', n));
        return [
            card(T('ni_dhcp_card_deny', 'LISTE REFUSER'),
                `<span class="ni-ctx-strong">${esc(line(f.denyEnabled, (f.deny || []).length))}</span>`,
                T('ni_dhcp_deny_caption', 'Une adresse MAC de cette liste ne reçoit aucun bail de ce serveur.')),
            card(T('ni_dhcp_card_allow', 'LISTE AUTORISER'),
                `<span class="ni-ctx-strong">${esc(line(f.allowEnabled, (f.allow || []).length))}</span>`,
                T('ni_dhcp_allow_caption', 'Une fois appliquée, seules les adresses MAC de cette liste reçoivent un bail.'),
                f.allowEnabled ? 'warn' : ''),
            card(T('ni_dhcp_card_limit', 'LIMITE'),
                `<span class="ni-ctx-body">${esc(T('ni_dhcp_filter_limit', 'Un filtre MAC se contourne par une adresse IP fixe ou une nouvelle adresse MAC.'))}</span>`,
                '')
        ].join('');
    }

    // ── tables ─────────────────────────────────────────────────────────────
    // One definition per tab: its columns, its rows, what a search looks at.
    function tableFor() {
        const { server, scope } = selected();
        if (!server) return null;

        if (state.sel.kind === 'scope' && scope) {
            if (state.tab === 'reservations') {
                return {
                    grid: 'reservations',
                    cols: [
                        { key: 'ip', label: 'ADRESSE IP', value: r => ipNum(r.ip), cell: r => `<span class="ni-cell-ip">${esc(r.ip)}</span>` },
                        { key: 'name', label: 'NOM', value: r => String(r.name || '').toLowerCase(), cell: r => `<span class="ni-host">${esc(r.name || '')}</span>` },
                        { key: 'mac', label: 'MAC', value: r => r.mac, cell: r => `<span class="ni-mac">${esc(r.mac || '')}</span>` }
                    ],
                    rows: scope.reservations || [],
                    text: r => [r.ip, r.name, r.mac],
                    empty: T('ni_dhcp_no_reservation', 'Aucune réservation dans cette étendue.')
                };
            }
            if (state.tab === 'pool') {
                const rows = [{ kind: 'range', start: scope.rangeStart, end: scope.rangeEnd }]
                    .concat((scope.exclusions || []).map(x => ({ kind: 'exclusion', start: x.start, end: x.end })));
                const size = r => { const a = ipNum(r.start), b = ipNum(r.end); return a >= 0 && b >= a ? b - a + 1 : 0; };
                return {
                    grid: 'pool',
                    cols: [
                        { key: 'start', label: 'DÉBUT', value: r => ipNum(r.start), cell: r => `<span class="ni-cell-ip">${esc(r.start)}</span>` },
                        { key: 'end', label: 'FIN', value: r => ipNum(r.end), cell: r => `<span class="ni-cell-ip">${esc(r.end)}</span>` },
                        { key: 'size', label: 'ADRESSES', value: size, cell: r => `<span class="ni-mac">${size(r)}</span>` },
                        {
                            key: 'kind', label: 'RÔLE', value: r => r.kind,
                            cell: r => (r.kind === 'range'
                                ? tag({ label: 'Plage distribuée', variant: 'success', mono: true })
                                : tag({ label: 'Exclue de la distribution', variant: 'warning', mono: true }))
                        }
                    ],
                    rows,
                    text: r => [r.start, r.end],
                    empty: ''
                };
            }
            const repeated = repeatedHosts(scope);
            return {
                grid: 'leases',
                cols: [
                    { key: 'ip', label: 'ADRESSE IP', value: l => ipNum(l.ip), cell: l => `<span class="ni-cell-ip">${esc(l.ip)}</span>` },
                    {
                        key: 'hostName', label: 'NOM D\'HÔTE', value: l => String(l.hostName || '').toLowerCase(),
                        cell: l => {
                            const many = repeated.has(String(l.hostName || '').trim().toLowerCase())
                                && String(l.state || '').toLowerCase().includes('active');
                            return `<span class="ni-host">${esc(l.hostName || '')}${many
                                ? `<span class="ni-chip-inline" title="${esc(T('ni_dhcp_repeated_hint', 'Ce nom d\'hôte tient plusieurs baux actifs dans cette étendue.'))}">${esc(T('ni_dhcp_repeated', 'PLUSIEURS BAUX'))}</span>` : ''}</span>`;
                        }
                    },
                    {
                        key: 'mac', label: 'MAC', value: l => l.mac,
                        cell: l => `<span class="ni-mac">${esc(l.mac || '')}${isRandomMac(l.mac)
                            ? `<span class="ni-chip-inline" title="${esc(T('ni_dhcp_random_hint', 'Adresse administrée localement : l\'appareil peut en présenter une autre demain.'))}">${esc(T('ni_dhcp_random', 'ALÉATOIRE'))}</span>` : ''}</span>`
                    },
                    { key: 'state', label: 'ÉTAT', value: l => l.state, cell: l => `<span class="ni-dhcp-cell">${esc(leaseStateLabel(l.state))}</span>` },
                    { key: 'expiresAt', label: 'EXPIRE', value: l => l.expiresAt || '', cell: l => `<span class="ni-seen">${esc(dateLabel(l.expiresAt))}</span>` }
                ],
                rows: scope.leases || [],
                text: l => [l.ip, l.hostName, l.mac],
                empty: T('ni_dhcp_no_lease', 'Aucun bail dans cette étendue.')
            };
        }

        if (state.sel.kind === 'filters') {
            const f = server.filters || { allow: [], deny: [] };
            return {
                grid: 'filters',
                cols: [
                    { key: 'mac', label: 'ADRESSE MAC', value: r => r.mac, cell: r => `<span class="ni-mac">${esc(r.mac || '')}</span>` },
                    { key: 'description', label: 'DESCRIPTION', value: r => String(r.description || '').toLowerCase(), cell: r => `<span class="ni-host">${esc(r.description || '')}</span>` }
                ],
                rows: (state.tab === 'allow' ? f.allow : f.deny) || [],
                text: r => [r.mac, r.description],
                empty: state.tab === 'allow'
                    ? T('ni_dhcp_no_allow', 'La liste Autoriser est vide.')
                    : T('ni_dhcp_no_deny', 'La liste Refuser est vide.')
            };
        }

        return {
            grid: 'scopes',
            cols: [
                { key: 'cidr', label: 'ÉTENDUE', value: x => ipNum(x.scopeId), cell: x => `<span class="ni-cell-ip">${esc(x.cidr || x.scopeId)}</span>` },
                { key: 'name', label: 'NOM', value: x => String(x.name || '').toLowerCase(), cell: x => `<span class="ni-host">${esc(x.name || '')}</span>` },
                { key: 'range', label: 'PLAGE', value: x => ipNum(x.rangeStart), cell: x => `<span class="ni-mac">${esc(x.rangeStart)} → ${esc(x.rangeEnd)}</span>` },
                { key: 'leases', label: 'BAUX ACTIFS', value: x => activeLeases(x).length, cell: x => `<span class="ni-mac">${activeLeases(x).length}</span>` },
                { key: 'pct', label: 'OCCUPATION', value: x => occupancy(x), cell: x => `<span class="ni-mac">${occupancy(x)}%</span>` }
            ],
            rows: server.scopes || [],
            text: x => [x.cidr, x.name, x.rangeStart, x.rangeEnd],
            rowAttr: x => ` role="button" tabindex="0" data-dhcp-server="${esc(server.name)}" data-dhcp-kind="scope" data-dhcp-scope="${esc(x.scopeId)}"`,
            empty: server.status === 'read'
                ? T('ni_dhcp_no_scope', 'Ce serveur répond et ne déclare aucune étendue IPv4.')
                : T('ni_dhcp_server_unread', 'Ce serveur n\'a pas été lu : ses étendues sont inconnues.'),
            emptyAction: server.status === 'read' ? '' : 'report'
        };
    }

    function tabsFor() {
        const { server, scope } = selected();
        if (!server) return [];
        if (state.sel.kind === 'scope' && scope) {
            return [
                { key: 'leases', label: 'Baux', count: (scope.leases || []).length },
                { key: 'reservations', label: 'Réservations', count: (scope.reservations || []).length },
                { key: 'pool', label: 'Pool d\'adresses', count: 1 + (scope.exclusions || []).length }
            ];
        }
        if (state.sel.kind === 'filters') {
            const f = server.filters || { allow: [], deny: [] };
            return [
                { key: 'deny', label: 'Refuser', count: (f.deny || []).length },
                { key: 'allow', label: 'Autoriser', count: (f.allow || []).length }
            ];
        }
        return [{ key: 'scopes', label: 'Étendues', count: (server.scopes || []).length }];
    }

    function renderMain() {
        const title = byId('ni-dhcp-title');
        const sub = byId('ni-dhcp-subtitle');
        const summary = byId('ni-dhcp-summary');
        const tabs = byId('ni-dhcp-tabs');
        const thead = byId('ni-dhcp-thead');
        const tbody = byId('ni-dhcp-tbody');
        const count = byId('ni-dhcp-count');
        const note = byId('ni-dhcp-note');
        if (!title || !tbody || !thead) return;

        const { server, scope } = selected();
        if (!server) {
            title.textContent = state.loading ? '…' : T('ni_dhcp_title_none', 'DHCP');
            if (sub) sub.textContent = '';
            if (summary) summary.innerHTML = '';
            if (tabs) tabs.innerHTML = '';
            thead.innerHTML = '';
            thead.className = 'ni-thead';
            tbody.innerHTML = state.loading ? '' : `<div class="ni-empty-state">${esc(state.dhcp
                ? T('ni_dhcp_tree_empty', 'Aucun serveur DHCP connu. Un serveur Windows peut être déclaré ci-dessous.')
                : T('ni_dhcp_tree_unknown', 'Relancer le scan pour lire les serveurs DHCP.'))}</div>`;
            if (count) count.textContent = '';
            if (note) note.textContent = '';
            return;
        }

        const serverName = String(server.name || '').toUpperCase();
        if (state.sel.kind === 'scope' && scope) {
            title.textContent = scope.cidr || scope.scopeId;
            if (sub) sub.textContent = [scope.name, serverName].filter(Boolean).join(' · ');
            if (summary) summary.innerHTML = scopeSummary(scope);
        } else if (state.sel.kind === 'filters') {
            title.textContent = T('ni_dhcp_filters', 'Filtres MAC');
            if (sub) sub.textContent = serverName;
            if (summary) summary.innerHTML = filtersSummary(server);
        } else {
            title.textContent = serverName;
            if (sub) sub.textContent = server.fqdn || '';
            if (summary) summary.innerHTML = serverSummary(server);
        }

        const tabDefs = tabsFor();
        if (!tabDefs.some(t => t.key === state.tab)) state.tab = tabDefs.length ? tabDefs[0].key : '';
        if (tabs) {
            tabs.innerHTML = tabDefs.map(t =>
                `<button class="ni-seg${t.key === state.tab ? ' active' : ''}" type="button" data-dhcp-tab="${esc(t.key)}">${esc(t.label)} · ${t.count}</button>`
            ).join('');
        }

        const table = tableFor();
        if (!table) return;
        thead.className = 'ni-thead ni-dhcp-grid ' + table.grid;
        thead.innerHTML = table.cols.map(c => {
            const on = state.sort.key === c.key;
            const arrow = on ? (state.sort.dir > 0 ? ' ↑' : ' ↓') : '';
            return `<button class="ni-dhcp-sort${on ? ' active' : ''}" type="button" data-dhcp-sort="${esc(c.key)}">${esc(c.label)}${arrow}</button>`;
        }).join('');

        const q = state.query.trim().toLowerCase();
        let rows = table.rows.filter(r => !q || table.text(r).some(v => String(v || '').toLowerCase().includes(q)));
        const sortCol = table.cols.find(c => c.key === state.sort.key) || table.cols[0];
        rows = rows.slice().sort((a, b) => {
            const va = sortCol.value(a), vb = sortCol.value(b);
            if (va < vb) return -1 * state.sort.dir;
            if (va > vb) return 1 * state.sort.dir;
            return 0;
        });

        if (!rows.length) {
            const action = table.emptyAction === 'report'
                ? `<div><button class="ni-ctx-link" type="button" data-ni-diag>${esc(T('ni_dhcp_see_report', 'Voir le rapport →'))}</button></div>`
                : '';
            tbody.innerHTML = `<div class="ni-empty-state">${esc(q ? T('ni_dhcp_no_match', 'Aucune ligne ne correspond.') : table.empty)}${action}</div>`;
        } else {
            tbody.innerHTML = rows.map(r =>
                `<div class="ni-dhcp-grid ni-dhcp-line ${table.grid}${table.rowAttr ? ' clickable' : ''}"${table.rowAttr ? table.rowAttr(r) : ''}>${table.cols.map(c => `<span>${c.cell(r)}</span>`).join('')}</div>`
            ).join('');
        }
        if (count) {
            count.textContent = T('ni_dhcp_count', '{n} ligne(s) sur {t}').replace('{n}', rows.length).replace('{t}', table.rows.length);
        }
        if (note) note.textContent = T('ni_dhcp_readonly', 'Lecture seule · état au dernier scan');
    }

    function render() {
        ensureSelection();
        renderTree();
        renderMain();
    }

    // ── declared servers dialog ────────────────────────────────────────────
    function setMsg(text, kind) {
        const msg = byId('ni-dhcp-servers-msg');
        if (!msg) return;
        msg.hidden = !text;
        msg.textContent = text || '';
        msg.classList.toggle('ok', kind === 'ok');
        msg.classList.toggle('error', kind === 'error');
    }

    async function openServers() {
        const modal = byId('ni-dhcp-servers-modal');
        const input = byId('ni-dhcp-servers-input');
        if (!modal || !input) return;
        setMsg('', '');
        input.value = '';
        modal.hidden = false;
        try {
            const res = await window.api('/api/inventory/dhcp/servers');
            const data = await res.json();
            input.value = Array.isArray(data.servers) ? data.servers.join('\n') : '';
        } catch (_) {
            setMsg(T('ni_dhcp_servers_load_error', 'La liste n\'a pas pu être lue.'), 'error');
        }
        input.focus();
    }

    function closeServers() {
        const modal = byId('ni-dhcp-servers-modal');
        if (modal) modal.hidden = true;
    }

    async function saveServers() {
        const input = byId('ni-dhcp-servers-input');
        const save = byId('ni-dhcp-servers-save');
        if (!input) return;
        const servers = input.value.split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean);
        if (save) save.disabled = true;
        try {
            const res = await window.api('/api/inventory/dhcp/servers', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ servers })
            });
            let data = {};
            try { data = await res.json(); } catch (_) { data = {}; }
            if (data.success) {
                input.value = (data.servers || []).join('\n');
                setMsg(T('ni_dhcp_servers_saved', 'Enregistré. Ces serveurs seront lus au prochain scan.'), 'ok');
            } else if (data.code === 'EBADSERVER') {
                setMsg(T('ni_dhcp_servers_bad', 'Nom d\'hôte refusé : {s}. Lettres, chiffres, points et tirets uniquement.')
                    .replace('{s}', (data.rejected || []).join(', ')), 'error');
            } else if (data.code === 'ETOOMANY') {
                setMsg(T('ni_dhcp_servers_many', 'Trop de serveurs : {n} au plus.').replace('{n}', data.max || 32), 'error');
            } else if (res.status === 403) {
                setMsg(T('ni_dhcp_servers_admin', 'Seul un administrateur peut modifier cette liste.'), 'error');
            } else {
                setMsg(T('ni_dhcp_servers_error', 'La liste n\'a pas pu être enregistrée.'), 'error');
            }
        } catch (_) {
            setMsg(T('ni_dhcp_servers_error', 'La liste n\'a pas pu être enregistrée.'), 'error');
        } finally {
            if (save) save.disabled = false;
        }
    }

    // ── events ─────────────────────────────────────────────────────────────
    function wire() {
        const view = byId('network-inventory-view');
        if (!view) return;

        view.addEventListener('click', (e) => {
            if (e.target.closest('[data-ni-dhcp-servers]')) { openServers(); return; }
            const node = e.target.closest('[data-dhcp-kind]');
            if (node) {
                select({ server: node.dataset.dhcpServer, kind: node.dataset.dhcpKind, scopeId: node.dataset.dhcpScope || null });
                return;
            }
            const tab = e.target.closest('[data-dhcp-tab]');
            if (tab) {
                state.tab = tab.dataset.dhcpTab;
                state.sort = { key: '', dir: 1 };
                renderMain();
                return;
            }
            const sort = e.target.closest('[data-dhcp-sort]');
            if (sort) {
                const key = sort.dataset.dhcpSort;
                state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 };
                renderMain();
            }
        });

        view.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const line = e.target.closest('.ni-dhcp-line[data-dhcp-kind]');
            if (line) { e.preventDefault(); line.click(); }
        });

        const search = byId('ni-dhcp-search');
        if (search) search.addEventListener('input', (e) => { state.query = e.target.value; renderMain(); });

        const modal = byId('ni-dhcp-servers-modal');
        if (modal) modal.addEventListener('click', (e) => {
            if (e.target.closest('#ni-dhcp-servers-save')) { saveServers(); return; }
            if (e.target.closest('#ni-dhcp-servers-close') ||
                e.target.closest('#ni-dhcp-servers-cancel') ||
                e.target.closest('#ni-dhcp-servers-backdrop')) closeServers();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal && !modal.hidden) closeServers();
        });

        document.addEventListener('ni:inventory', (e) => {
            const d = e.detail || {};
            state.dhcp = d.dhcp || null;
            state.diagnostics = Array.isArray(d.diagnostics) ? d.diagnostics : [];
            state.loading = !!d.loading;
            if (state.wantedCidr && !state.loading) {
                const cidr = state.wantedCidr;
                state.wantedCidr = null;
                if (selectCidr(cidr)) return;
            }
            render();
        });

        document.addEventListener('ni:dhcp-select', (e) => {
            const cidr = e.detail && e.detail.cidr;
            if (!cidr) return;
            if (!selectCidr(cidr)) state.wantedCidr = cidr;
        });

        // The main module may have loaded the inventory before this one listened.
        document.dispatchEvent(new CustomEvent('ni:inventory-request'));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    } else {
        wire();
    }
})();
