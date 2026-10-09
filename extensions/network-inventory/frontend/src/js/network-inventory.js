/*
 * Network Inventory — subnet explorer (design handoff option 2a + read-only IP drawer).
 *
 * Self-contained page module: no edits to app.js. Reuses the shared helpers
 * (window.api, t, escHtml, showToast, applyTranslations) and the existing scan
 * SSE contract (/api/inventory/scan + /api/audit/events -> scan_progress).
 *
 * v1 is READ-ONLY: every mutating control (Créer le PTR, DNS CRUD, Convertir/
 * Révoquer, + Déclarer, Gérer) renders disabled with a "bientôt" hint. The read
 * pipeline (Shield -> backend -> here) drives everything else from real data.
 */
(function () {
    'use strict';

    const esc = window.escHtml || (s => (s == null ? '' : String(s)));
    const byId = id => document.getElementById(id);

    const state = {
        subnets: [],
        ips: [],
        scannedAt: null,
        totalScans: 0,
        selectedCidr: null,
        statusFilter: 'all',
        sidebarQuery: '',
        tableQuery: '',
        drawerIp: null,
        loading: true,
        error: false,
        // Per-source scan diagnostics, their rolled-up verdict, and the machine
        // context. Feed the banner and the copyable report; empty on a clean scan.
        diagnostics: [],
        diagSummary: null,
        scanContext: null,
        // Every DHCP server the scan tried, read or not, with its scopes. Null
        // for an inventory written before the scan sent it.
        dhcp: null,
        // 'networks' (the subnet explorer) or 'dhcp' (network-inventory-dhcp.js).
        view: 'networks'
    };

    // ── inline icons (stroke-based, Lucide-compatible) ──
    const ICON = {
        globe: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18"/><path d="M12 3a15 15 0 0 0 0 18"/></svg>',
        close: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
        pencil: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
        trash: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>'
    };

    // ── i18n-aware labels ──
    const T = (key, fallback) => (window.t ? window.t(key, fallback) : fallback);
    const statusLabel = s => T('ni_status_' + s, s.toUpperCase());
    const soon = () => T('ni_soon', 'bientôt');

    // coarse relative time, mirrors backend inventoryService.relativeTime (French)
    function relTime(iso) {
        if (!iso) return '';
        const then = new Date(iso).getTime();
        if (Number.isNaN(then)) return '';
        const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
        if (secs < 60) return secs + ' s';
        const mins = Math.floor(secs / 60);
        if (mins < 60) return mins + ' min';
        const hours = Math.floor(mins / 60);
        if (hours < 24) return hours + ' h';
        return Math.floor(hours / 24) + ' j';
    }
    // "DD/MM HH:mm" for history/lease timestamps
    function shortDate(iso) {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        const p = n => String(n).padStart(2, '0');
        return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    /**
     * "10.0.1.50 → .200" when both ends share a /24, "10.0.1.50 → 10.0.3.200"
     * otherwise. The scan now emits full addresses at both ends; abbreviating the
     * second one is a reading convenience, and it stops the moment it would lie.
     */
    function scopeRangeLabel(dhcp) {
        if (!dhcp || !dhcp.rangeStart || !dhcp.rangeEnd) return '';
        const a = String(dhcp.rangeStart), b = String(dhcp.rangeEnd);
        const sameBlock = a.split('.').slice(0, 3).join('.') === b.split('.').slice(0, 3).join('.');
        return sameBlock ? `${a} → .${b.split('.')[3]}` : `${a} → ${b}`;
    }

    /**
     * One line under the DHCP card saying how the scope is served when more than
     * one server holds it. The card title already names the server that speaks
     * for it (the scan decides, see shield/netscan/DhcpFailover.ps1); this says
     * why, and a takeover reads as a warning because the primary is down.
     */
    function failoverLine(d) {
        const f = d && d.failover;
        if (!f || !f.mode) return '';
        const servers = Array.isArray(f.servers) ? f.servers : [];
        const other = servers.filter(s => s !== f.authority).join(' / ');
        let text;
        if (f.mode === 'hotstandby' && f.takeover) {
            text = T('ni_failover_takeover', 'Bascule active : le secours {s} sert l\'étendue, principal hors ligne')
                .replace('{s}', String(f.authority || '').toUpperCase());
        } else if (f.mode === 'hotstandby' && f.authority) {
            text = T('ni_failover_hotstandby', 'Secours à chaud : principal, secours {s}')
                .replace('{s}', other.toUpperCase() || '?');
        } else if (f.mode === 'hotstandby') {
            text = T('ni_failover_unknown_role', 'Secours à chaud, rôle principal illisible');
        } else if (f.mode === 'loadbalance') {
            text = T('ni_failover_loadbalance', 'Répartition de charge entre les deux serveurs');
        } else {
            text = T('ni_failover_split', 'Étendue partagée sans basculement (split-scope)');
        }
        const cls = f.takeover ? ' takeover' : '';
        const title = f.state ? ` title="${esc(f.state)}"` : '';
        return `<span class="ni-ctx-caption ni-failover${cls}"${title}>${esc(text)}</span>`;
    }

    /**
     * What the DHCP card says for a network that carries no scope.
     *
     * It used to say "no scope for this network", whatever had happened. That
     * is a statement about the network, and the scan can only make it when
     * every DHCP server it knows of answered. With one server refused or
     * silent, the honest sentence is that the scope was not read; with none
     * known at all, that there was nobody to ask.
     *
     * `dhcp` is the scan's server list, or null for an inventory written before
     * the scan sent one. Null is ignorance, and reads as such.
     */
    function dhcpAbsence(dhcp) {
        if (!dhcp || !Array.isArray(dhcp.servers)) {
            return {
                kind: 'unknown', action: '',
                text: T('ni_dhcp_absence_unknown', 'Aucune étendue lue pour ce réseau'),
                caption: T('ni_dhcp_absence_unknown_hint', 'Relancer le scan pour savoir quels serveurs DHCP ont répondu.')
            };
        }
        const names = list => list.map(s => String(s.name || s.fqdn || '?').toUpperCase()).join(', ');
        const unread = dhcp.servers.filter(s => s.status !== 'read');
        const read = dhcp.servers.filter(s => s.status === 'read');
        if (unread.length) {
            return {
                kind: 'unread', action: 'report',
                text: T('ni_dhcp_absence_unread', 'Étendue non lue : {n} serveur(s) DHCP sur {t} sans réponse exploitable')
                    .replace('{n}', unread.length).replace('{t}', dhcp.servers.length),
                caption: T('ni_dhcp_absence_unread_hint', 'Non lu : {s}. Une étendue de ce réseau peut s\'y trouver.')
                    .replace('{s}', names(unread))
            };
        }
        if (!read.length) {
            return {
                kind: 'noserver', action: 'declare',
                text: T('ni_dhcp_absence_noserver', 'Aucun serveur DHCP connu'),
                caption: T('ni_dhcp_absence_noserver_hint', 'L\'annuaire n\'en autorise aucun. Un serveur DHCP Windows peut être déclaré à la main.')
            };
        }
        return {
            kind: 'none', action: 'declare',
            text: T('ni_dhcp_absence_none', 'Aucune étendue pour ce réseau sur les serveurs lus'),
            caption: T('ni_dhcp_absence_none_hint', 'Lus : {s}. Si un autre serveur distribue ces adresses, le déclarer.')
                .replace('{s}', names(read))
        };
    }

    function selectedSubnet() {
        return state.subnets.find(s => s.cidr === state.selectedCidr) || null;
    }
    function ipsInSelected() {
        return state.ips.filter(i => i.network === state.selectedCidr);
    }

    // Live (answered ping or seen in ARP) yet with no identity at all:
    // no hostname, no DNS records, no DHCP lease. The "we see it but can't
    // name it" bucket. Requires evidence; false on legacy scans.
    function isUnidentified(i) {
        const e = i.evidence;
        if (!e) return false;
        const live = e.pingAlive || e.hasArp;
        const named = (i.hostname && i.hostname.length) ||
            (i.dns && i.dns.length) || e.hasDhcpLease;
        return !!live && !named;
    }

    // segment predicates (non-overlapping; gateway folds into "used")
    const SEG = {
        all: () => true,
        used: i => i.status === 'used' || i.status === 'gateway',
        free: i => i.status === 'free',
        reserved: i => i.status === 'reserved',
        conflict: i => i.status === 'conflict',
        unidentified: i => isUnidentified(i)
    };

    function filteredIps() {
        const q = state.tableQuery.trim().toLowerCase();
        return ipsInSelected().filter(i => {
            if (!SEG[state.statusFilter](i)) return false;
            if (!q) return true;
            return (i.ip && i.ip.toLowerCase().includes(q)) ||
                (i.hostname && i.hostname.toLowerCase().includes(q)) ||
                (i.mac && i.mac.toLowerCase().includes(q));
        });
    }

    // Absorbs the diagnostic half of any inventory response. Kept apart from the
    // data half because a failed scan answers with diagnostics and nothing else.
    function absorbDiagnostics(data) {
        state.diagnostics = Array.isArray(data.diagnostics) ? data.diagnostics : [];
        state.diagSummary = data.diagnosticsSummary || summarize(state.diagnostics);
        if (data.context) state.scanContext = data.context;
    }

    // Local fallback for a response that carries raw diagnostics with no summary
    // (the failure paths in server.js). Mirrors summarizeDiagnostics() backend-side.
    function summarize(entries) {
        const failed = entries.filter(d => d.status === 'failed').length;
        const degraded = entries.filter(d => d.status === 'degraded').length;
        return {
            status: failed ? 'failed' : (degraded ? 'degraded' : 'ok'),
            failed, degraded,
            ok: entries.filter(d => d.status === 'ok').length,
            sources: [...new Set(entries.filter(d => d.status !== 'ok').map(d => d.source))],
            failedSources: [...new Set(entries.filter(d => d.status === 'failed').map(d => d.source))],
            degradedSources: [...new Set(entries.filter(d => d.status === 'degraded').map(d => d.source))]
        };
    }

    // ── data ──
    async function loadInventory() {
        state.loading = true;
        state.error = false;
        renderAll();
        try {
            const res = await window.api('/api/inventory/network');
            const data = await res.json();
            state.subnets = Array.isArray(data.subnets) ? data.subnets : [];
            state.ips = Array.isArray(data.ips) ? data.ips : [];
            state.scannedAt = data.scannedAt || null;
            state.totalScans = Number(data.totalScans) || 0;
            state.dhcp = data.dhcp || null;
            absorbDiagnostics(data);
            state.loading = false;
            if (!state.selectedCidr || !state.subnets.some(s => s.cidr === state.selectedCidr)) {
                state.selectedCidr = state.subnets.length ? state.subnets[0].cidr : null;
            }
        } catch (e) {
            console.error('[NetworkInventory] load failed:', e);
            state.loading = false;
            state.error = true;
        }
        renderAll();
    }

    // ── sidebar ──
    function renderSidebar() {
        const list = byId('ni-net-list');
        const foot = byId('ni-foot-meta');
        if (!list) return;

        const q = state.sidebarQuery.trim().toLowerCase();
        const nets = state.subnets.filter(s => {
            if (!q) return true;
            return s.cidr.toLowerCase().includes(q) ||
                (s.description && s.description.toLowerCase().includes(q)) ||
                (s.label && s.label.toLowerCase().includes(q)) ||
                (s.vlan != null && ('vlan ' + s.vlan).includes(q));
        });

        if (!nets.length) {
            list.innerHTML = `<div class="ni-empty-state">${esc(T('ni_no_networks', 'Aucun réseau'))}</div>`;
        } else {
            list.innerHTML = nets.map(s => {
                const occ = s.totalCount ? Math.round((s.usedCount / s.totalCount) * 100) : 0;
                const high = occ >= 80 ? ' high' : '';
                const chips = [];
                if (s.dhcp && s.dhcp.utilization >= 80) {
                    chips.push(agTag({
                        label: 'DHCP', variant: 'warning',
                        action: { label: `${s.dhcp.utilization}%` }, monoAction: true
                    }));
                }
                if (s.anomalies && s.anomalies.conflicts > 0) {
                    chips.push(agTag({ label: `${s.anomalies.conflicts} ${T('ni_conflicts_short', 'CONFLITS')}`, variant: 'danger', mono: true }));
                }
                const total = Number(s.totalCount).toLocaleString('fr-FR');
                return `
                <div class="ni-net${s.cidr === state.selectedCidr ? ' selected' : ''}" data-cidr="${esc(s.cidr)}" role="button" tabindex="0">
                    <div class="ni-net-row1">
                        <span class="ni-cidr">${esc(s.cidr)}</span>
                        <span class="ni-net-count">${esc(s.usedCount)} / ${esc(total)}</span>
                    </div>
                    <div class="ni-net-row2">
                        <span class="ni-desc">${esc(s.description || T('ni_no_label', '—'))}</span>
                        <span class="ni-occ"><span class="ni-occ-fill${high}" style="width:${Math.min(occ, 100)}%"></span></span>
                    </div>
                    ${chips.length ? `<div class="ni-net-chips">${chips.join('')}</div>` : ''}
                </div>`;
            }).join('');
        }

        if (foot) {
            const activeIps = state.ips.filter(i => i.status !== 'free').length;
            foot.textContent = T('ni_sidebar_footer', '{n} réseaux · {a} IP actives')
                .replace('{n}', state.subnets.length).replace('{a}', activeIps);
        }
    }

    // ── context cards ──
    function renderCards() {
        const wrap = byId('ni-cards');
        if (!wrap) return;
        const s = selectedSubnet();
        if (!s) { wrap.innerHTML = ''; return; }

        // DHCP card
        let dhcpCard;
        if (s.dhcp) {
            const d = s.dhcp;
            dhcpCard = `
            <div class="ni-ctx-card">
                <div class="ni-ctx-head">
                    <span class="ni-ctx-title">${esc(T('ni_card_dhcp', 'ÉTENDUE DHCP'))} · ${esc((d.server || '').toUpperCase())}</span>
                    <button class="ni-ctx-link" type="button" data-ni-manage="${esc(s.cidr)}">${esc(T('ni_manage', 'Gérer →'))}</button>
                </div>
                <div class="ni-dhcp-row">
                    <span class="ni-range">${esc(scopeRangeLabel(d))}</span>
                    <span class="ni-bar"><span class="ni-bar-fill" style="width:${Math.min(Number(d.utilization) || 0, 100)}%"></span></span>
                    <span class="ni-pct">${esc(d.utilization)}%</span>
                </div>
                <span class="ni-ctx-caption">${esc(T('ni_dhcp_caption', '{l} baux actifs · {r} réservations · bail {d} jours')
                    .replace('{l}', d.activeLeases != null ? d.activeLeases : '—')
                    .replace('{r}', d.reservations != null ? d.reservations : '—')
                    .replace('{d}', d.leaseDays != null ? d.leaseDays : '—'))}</span>
                ${failoverLine(d)}
            </div>`;
        } else {
            const a = dhcpAbsence(state.dhcp);
            const action = a.action === 'report'
                ? `<button class="ni-ctx-link" type="button" data-ni-diag>${esc(T('ni_dhcp_see_report', 'Voir le rapport →'))}</button>`
                : (a.action === 'declare'
                    ? `<button class="ni-ctx-link" type="button" data-ni-dhcp-servers>${esc(T('ni_dhcp_declare', 'Déclarer un serveur →'))}</button>`
                    : '');
            dhcpCard = `
            <div class="ni-ctx-card${a.kind === 'unread' ? ' warn' : ''}" data-dhcp-absence="${esc(a.kind)}">
                <div class="ni-ctx-head">
                    <span class="ni-ctx-title">${esc(T('ni_card_dhcp', 'ÉTENDUE DHCP'))}</span>
                    ${action}
                </div>
                <span class="ni-ctx-empty">${esc(a.text)}</span>
                ${a.caption ? `<span class="ni-ctx-caption">${esc(a.caption)}</span>` : ''}
            </div>`;
        }

        // DNS card
        let dnsCard;
        if (s.dns) {
            const z = s.dns;
            dnsCard = `
            <div class="ni-ctx-card">
                <div class="ni-ctx-head">
                    <span class="ni-ctx-title">${esc(T('ni_card_dns', 'ZONE DNS'))} · ${esc((z.zone || '').toUpperCase())}</span>
                    <button class="ni-ctx-link" disabled title="${esc(soon())}">${esc(T('ni_manage', 'Gérer →'))}</button>
                </div>
                <div class="ni-ctx-line">
                    <span class="ni-ctx-strong">${esc(z.recordCount)} ${esc(T('ni_records', 'enregistrements'))}</span>
                    <span class="ni-ctx-caption">A · PTR · CNAME</span>
                </div>
                <span class="ni-ctx-caption">${esc(T('ni_reverse_zone', 'Zone inverse'))} : ${esc(z.reverseZone || '—')}</span>
            </div>`;
        } else {
            dnsCard = `
            <div class="ni-ctx-card">
                <div class="ni-ctx-head"><span class="ni-ctx-title">${esc(T('ni_card_dns', 'ZONE DNS'))}</span></div>
                <span class="ni-ctx-empty">${esc(T('ni_dns_empty', 'Aucune zone DNS connue'))}</span>
            </div>`;
        }

        // Health card
        const a = s.anomalies || { total: 0, conflicts: 0, aWithoutPtr: 0, orphanPtr: 0 };
        const lastCheck = state.scannedAt ? relTime(state.scannedAt) : '';
        let healthCard;
        if (a.total > 0) {
            healthCard = `
            <div class="ni-ctx-card alert">
                <div class="ni-ctx-head">
                    <span class="ni-ctx-title">${esc(T('ni_card_health', 'SANTÉ'))} · ${esc(a.total)} ${esc(T('ni_anomalies', 'ANOMALIES'))}</span>
                    <button class="ni-ctx-link" id="ni-fix-anomalies">${esc(T('ni_fix', 'Corriger →'))}</button>
                </div>
                <span class="ni-ctx-body">${esc(T('ni_health_body', '{c} conflits d\'IP · {p} A sans PTR · {o} PTR orphelin')
                    .replace('{c}', a.conflicts).replace('{p}', a.aWithoutPtr).replace('{o}', a.orphanPtr))}</span>
                ${lastCheck ? `<span class="ni-ctx-caption">${esc(T('ni_last_check', 'Dernier contrôle il y a {t}').replace('{t}', lastCheck))}</span>` : ''}
            </div>`;
        } else {
            healthCard = `
            <div class="ni-ctx-card">
                <div class="ni-ctx-head"><span class="ni-ctx-title">${esc(T('ni_card_health', 'SANTÉ'))}</span></div>
                <span class="ni-ctx-body">${esc(T('ni_health_ok', 'Aucune anomalie détectée'))}</span>
                ${lastCheck ? `<span class="ni-ctx-caption">${esc(T('ni_last_check', 'Dernier contrôle il y a {t}').replace('{t}', lastCheck))}</span>` : ''}
            </div>`;
        }

        wrap.innerHTML = dhcpCard + dnsCard + healthCard;
    }

    // ── title + segment ──
    function renderHeader() {
        const s = selectedSubnet();
        const title = byId('ni-title');
        const sub = byId('ni-subtitle');
        if (title) title.textContent = s ? s.cidr : (state.loading ? '…' : T('ni_no_selection', 'Aucun réseau'));
        if (sub) {
            if (s) {
                const bits = [];
                if (s.description) bits.push(s.description);
                if (s.mask) bits.push(T('ni_mask', 'masque') + ' ' + s.mask);
                sub.textContent = bits.join(' · ');
            } else {
                sub.textContent = '';
            }
        }
    }

    function renderSegment() {
        const seg = byId('ni-segment');
        if (!seg) return;
        const ips = ipsInSelected();
        const counts = {
            all: ips.length,
            used: ips.filter(SEG.used).length,
            free: ips.filter(SEG.free).length,
            reserved: ips.filter(SEG.reserved).length,
            conflict: ips.filter(SEG.conflict).length,
            unidentified: ips.filter(isUnidentified).length
        };
        const defs = [
            { key: 'all', label: T('ni_seg_all', 'Toutes') },
            { key: 'used', label: T('ni_seg_used', 'Utilisées') },
            { key: 'free', label: T('ni_seg_free', 'Libres') },
            { key: 'reserved', label: T('ni_seg_reserved', 'Réservées') },
            { key: 'conflict', label: T('ni_seg_conflict', 'Conflits'), danger: true },
            { key: 'unidentified', label: T('ni_seg_unidentified', 'Non identifiées'), danger: true }
        ];
        seg.innerHTML = defs.map(d => {
            const cls = ['ni-seg'];
            if (d.danger) cls.push('danger');
            if (state.statusFilter === d.key) cls.push('active');
            return `<button class="${cls.join(' ')}" data-seg="${d.key}">${esc(d.label)} · ${counts[d.key]}</button>`;
        }).join('');
    }

    // ── table ──
    const NI_STATUS_VARIANT = { used: 'danger', free: 'success', reserved: 'warning', conflict: 'danger' };
    function pill(status) {
        if (status === 'gateway') {
            return agTag({ label: statusLabel(status), variant: 'neutral', stroke: true, mono: true });
        }
        return agTag({ label: statusLabel(status), variant: NI_STATUS_VARIANT[status] || 'neutral', mono: true });
    }
    function dnsBadges(ip) {
        if (!ip.dns || !ip.dns.length) return `<span class="ni-cell-empty">—</span>`;
        return `<div class="ni-dns">${ip.dns.map(d => {
            const uncertain = d === 'PTR?';
            const label = uncertain ? 'PTR ?' : d;
            return agTag({ label, variant: uncertain ? 'warning' : 'accent', mono: true });
        }).join('')}</div>`;
    }
    // Evidence checklist for the drawer: each present signal becomes a row.
    function evidenceRows(ip) {
        const e = ip.evidence;
        if (!e) return ''; // legacy scan: no evidence captured, hide the section
        const rows = [];
        if (e.pingAlive) {
            rows.push(e.rttMs != null && e.rttMs >= 0
                ? T('ni_ev_ping_rtt', 'Répond au ping · {ms} ms').replace('{ms}', e.rttMs)
                : T('ni_ev_ping', 'Répond au ping'));
        }
        if (e.hasArp) rows.push(e.arpStale ? T('ni_ev_arp_stale', 'Entrée ARP périmée') : T('ni_ev_arp', 'Présente dans la table ARP'));
        if (e.hasDnsA) rows.push(T('ni_ev_dns_a', 'Enregistrement DNS (A)'));
        if (e.hasDnsPtr) rows.push(T('ni_ev_dns_ptr', 'Enregistrement inverse (PTR)'));
        if (e.hasDhcpLease) rows.push(T('ni_ev_dhcp', 'Bail DHCP actif'));
        const inner = rows.length
            ? rows.map(r => `<div class="ni-ev-row"><span class="ni-ev-dot"></span><span>${esc(r)}</span></div>`).join('')
            : `<div class="ni-ev-row muted"><span>${esc(T('ni_ev_none', 'Aucun signal réseau — présence issue d\'un enregistrement seul'))}</span></div>`;
        return `
        <section>
            <div class="ni-section-head"><span class="ni-section-label">${esc(T('ni_why_used', 'Pourquoi cette IP est-elle utilisée ?'))}</span></div>
            <div class="ni-evidence">${inner}</div>
        </section>`;
    }
    function hostCell(ip) {
        if (!ip.hostname) {
            return isUnidentified(ip)
                ? agTag({ label: T('ni_unidentified', 'NON IDENTIFIÉ'), variant: 'warning', mono: true })
                : `<span class="ni-cell-empty">—</span>`;
        }
        let html = `<span class="ni-host" title="${esc(ip.hostname)}">${esc(ip.hostname)}`;
        if (ip.status === 'conflict' && ip.macCount > 1) {
            html += ` <span class="ni-host-flag">· ${esc(T('ni_n_macs', '{n} MAC détectées').replace('{n}', ip.macCount))}</span>`;
        }
        html += `</span>`;
        if (ip.anomalies && ip.anomalies.includes('a_without_ptr')) {
            html += ' ' + agTag({ label: T('ni_a_without_ptr', 'A SANS PTR'), variant: 'warning', mono: true });
        }
        if (isUnidentified(ip)) {
            html += ' ' + agTag({ label: T('ni_unidentified', 'NON IDENTIFIÉ'), variant: 'warning', mono: true });
        }
        return html;
    }

    function renderTable() {
        const body = byId('ni-tbody');
        const footCount = byId('ni-table-foot-count');
        const footNote = byId('ni-table-foot-note');
        if (!body) return;

        if (state.loading) {
            body.innerHTML = `<div class="ni-empty-state">${esc(T('ni_loading', 'Chargement…'))}</div>`;
        } else if (state.error) {
            body.innerHTML = `<div class="ni-empty-state">${esc(T('ni_load_error', 'Impossible de charger l\'inventaire'))}</div>`;
        } else {
            const rows = filteredIps();
            if (!rows.length) {
                body.innerHTML = `<div class="ni-empty-state">${esc(T('ni_no_rows', 'Aucune adresse pour ce filtre'))}</div>`;
            } else {
                body.innerHTML = rows.map(ip => {
                    const conflict = ip.status === 'conflict' ? ' conflict' : '';
                    const ipCls = ip.status === 'free' ? 'ni-cell-ip free' : 'ni-cell-ip';
                    const vendor = ip.vendor ? `<span class="ni-vendor">${esc(ip.vendor)}</span>` : '';
                    const mac = ip.mac
                        ? `<span class="ni-mac">${esc(ip.mac)}</span>${vendor}`
                        : (ip.vendor ? vendor : `<span class="ni-cell-empty">—</span>`);
                    const dhcp = ip.dhcp && ip.dhcp.detail
                        ? `<span class="ni-dhcp-cell">${esc(ip.dhcp.detail)}</span>`
                        : `<span class="ni-cell-empty">—</span>`;
                    const seen = ip.lastSeenLabel
                        ? `<span class="ni-seen">${esc(ip.lastSeenLabel)}</span>`
                        : `<span class="ni-cell-empty">—</span>`;
                    return `
                    <div class="ni-grid ni-row${conflict}" data-ip="${esc(ip.ip)}" role="button" tabindex="0">
                        <span class="${ipCls}">${esc(ip.ip)}</span>
                        <span>${pill(ip.status)}</span>
                        <span>${hostCell(ip)}</span>
                        <span>${mac}</span>
                        <span>${dnsBadges(ip)}</span>
                        <span>${dhcp}</span>
                        <span>${seen}</span>
                    </div>`;
                }).join('');
            }
            const total = ipsInSelected().length;
            if (footCount) footCount.textContent = T('ni_table_count', '{n} adresses · triées par IP').replace('{n}', total);
            if (footNote) footNote.textContent = '';
        }
    }

    // ── drawer (read-only) ──
    function openDrawer(ipStr) {
        const ip = state.ips.find(i => i.ip === ipStr);
        if (!ip) return;
        state.drawerIp = ip;
        renderDrawer();
        const scrim = byId('ni-scrim');
        const drawer = byId('ni-drawer');
        if (scrim) scrim.classList.add('open');
        if (drawer) { drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); }
    }
    function closeDrawer() {
        state.drawerIp = null;
        const scrim = byId('ni-scrim');
        const drawer = byId('ni-drawer');
        if (scrim) scrim.classList.remove('open');
        if (drawer) { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); }
    }

    function renderDrawer() {
        const drawer = byId('ni-drawer');
        const ip = state.drawerIp;
        if (!drawer || !ip) return;
        const s = selectedSubnet() || {};
        const zone = s.dns && s.dns.zone ? s.dns.zone : '';
        const dhcpServer = s.dhcp && s.dhcp.server ? s.dhcp.server : '';
        const scopeRange = s.dhcp ? scopeRangeLabel(s.dhcp) : '';

        // subtitle bits
        const subBits = [];
        if (ip.hostname) subBits.push(esc(ip.hostname));
        subBits.push(esc(ip.network));
        if (s.vlan != null) subBits.push('VLAN ' + esc(s.vlan));
        const subtitle = subBits.join(' · ') +
            ` · <span class="ni-drawer-asset" style="opacity:.55">${esc(T('ni_view_asset', 'Voir l\'actif →'))}</span>`;

        // DNS records
        let recordsHtml = '';
        (ip.dnsRecords || []).forEach(r => {
            recordsHtml += `
            <div class="ni-record">
                ${agTag({ label: r.type, variant: 'accent', mono: true })}
                <span class="ni-rec-value" title="${esc(r.value)}">${esc(r.value)}</span>
                ${r.ttl ? `<span class="ni-rec-ttl">TTL ${esc(r.ttl)}</span>` : ''}
                <span class="ni-rec-actions">
                    <button class="ni-icon-btn" disabled title="${esc(soon())}">${ICON.pencil}</button>
                    <button class="ni-icon-btn danger" disabled title="${esc(soon())}">${ICON.trash}</button>
                </span>
            </div>`;
        });
        if (ip.anomalies && ip.anomalies.includes('a_without_ptr')) {
            recordsHtml += `
            <div class="ni-record missing">
                ${agTag({ label: 'PTR', variant: 'warning', mono: true })}
                <span class="ni-rec-note">${esc(T('ni_missing_ptr', 'Aucun enregistrement inverse —'))} <b>${esc(T('ni_a_without_ptr', 'A SANS PTR'))}</b></span>
                <button class="ni-btn-fix" disabled title="${esc(soon())}">${esc(T('ni_create_ptr', 'Créer le PTR'))}</button>
            </div>`;
        }
        if (!recordsHtml) {
            recordsHtml = `<div class="ni-record"><span class="ni-rec-note">${esc(T('ni_no_dns', 'Aucun enregistrement DNS'))}</span></div>`;
        }

        // DHCP section
        const d = ip.dhcp || { kind: 'none', detail: '' };
        const leaseActive = d.kind === 'lease' || d.kind === 'reservation';
        let dhcpBody;
        if (d.kind === 'none' || (!d.detail && !leaseActive)) {
            dhcpBody = `<div class="ni-lease-card"><div class="ni-lease-top"><span class="ni-dot muted"></span><span class="ni-lease-text">${esc(T('ni_no_dhcp', 'Hors DHCP / statique'))}</span></div></div>`;
        } else {
            // detail already carries the human expiry ("Bail · expire 6j 4h"), so no
            // separate expire chip — avoids a redundant (and direction-sensitive) recompute.
            dhcpBody = `
            <div class="ni-lease-card">
                <div class="ni-lease-top">
                    <span class="ni-dot${leaseActive ? '' : ' muted'}"></span>
                    <span class="ni-lease-text">${esc(d.detail || T('ni_dhcp_generic', 'Bail DHCP'))}</span>
                </div>
                <div class="ni-lease-grid">
                    <span>MAC <b>${esc(ip.mac || '—')}</b>${ip.vendor ? ` <span class="ni-vendor">${esc(ip.vendor)}</span>` : ''}</span>
                    <span>${esc(T('ni_client', 'Client'))} <b>${esc(ip.hostname ? ip.hostname.split('.')[0] : '—')}</b></span>
                </div>
                <div class="ni-lease-actions">
                    <button class="ni-btn-soft" disabled title="${esc(soon())}">${esc(T('ni_convert_reservation', 'Convertir en réservation'))}</button>
                    <button class="ni-btn-ghost" disabled title="${esc(soon())}">${esc(T('ni_revoke_lease', 'Révoquer le bail'))}</button>
                </div>
            </div>`;
        }

        // history (derive a single entry from lastSeen when no log exists)
        let history = ip.history && ip.history.length ? ip.history.slice() : [];
        if (!history.length && ip.lastSeen) {
            history = [{ date: shortDate(ip.lastSeen), text: T('ni_hist_seen', 'Vu en ligne (scan subnet)'), latest: true }];
        }
        const seenLine = (ip.scanCount && state.totalScans)
            ? `<div class="ni-tl-meta">${esc(T('ni_seen_count', 'Vue lors de {n} scans sur {m}')
                .replace('{n}', ip.scanCount).replace('{m}', state.totalScans))}</div>`
            : '';
        // "Probably stale": counted as used, but no live signal this scan — present
        // only via a lingering DNS/DHCP record, never answered ping or ARP. Needs
        // evidence (null on legacy scans → hint stays hidden).
        const e = ip.evidence;
        const staleLine = (ip.status !== 'free' && e && !e.pingAlive && !e.hasArp)
            ? `<div class="ni-tl-meta stale">${esc(T('ni_stale_hint', 'Aucune réponse réseau — présente via un enregistrement seul'))}</div>`
            : '';
        const historyHtml = history.length
            ? history.map((h, idx) => `
                <div class="ni-tl-item">
                    <div class="ni-tl-rail">
                        <span class="ni-tl-dot${h.latest || idx === 0 ? ' latest' : ''}"></span>
                        ${idx < history.length - 1 ? '<span class="ni-tl-line"></span>' : ''}
                    </div>
                    <div class="ni-tl-body">
                        <span class="ni-tl-date">${esc(h.date || '')}</span>
                        <span class="ni-tl-text">${esc(h.text || '')}</span>
                    </div>
                </div>`).join('')
            : `<span class="ni-ctx-empty">${esc(T('ni_no_history', 'Aucun historique'))}</span>`;

        const footServers = [dhcpServer && dhcpServer, zone].filter(Boolean);

        drawer.innerHTML = `
        <div class="ni-drawer-head">
            <div class="ni-drawer-icon">${ICON.globe}</div>
            <div class="ni-drawer-hd-main">
                <div class="ni-drawer-hd-top">
                    <span class="ni-drawer-ip">${esc(ip.ip)}</span>
                    ${pill(ip.status)}
                </div>
                <div class="ni-drawer-sub">${subtitle}</div>
            </div>
            <button class="ni-close" id="ni-drawer-close" aria-label="${esc(T('ni_close', 'Fermer'))}">${ICON.close}</button>
        </div>
        <div class="ni-drawer-body">
            <section>
                <div class="ni-section-head">
                    <span class="ni-section-label">${esc(T('ni_dns_records', 'ENREGISTREMENTS DNS'))}${zone ? ' · ' + esc(zone.toUpperCase()) : ''}</span>
                    <button class="ni-section-action" disabled title="${esc(soon())}">${esc(T('ni_add', '+ Ajouter'))}</button>
                </div>
                <div class="ni-records">${recordsHtml}</div>
            </section>
            <section>
                <div class="ni-section-head">
                    <span class="ni-section-label">DHCP${dhcpServer ? ' · ' + esc(dhcpServer.toUpperCase()) : ''}</span>
                    ${scopeRange ? `<span class="ni-section-note">${esc(T('ni_scope', 'étendue'))} ${esc(scopeRange)}</span>` : ''}
                </div>
                ${dhcpBody}
            </section>
            ${evidenceRows(ip)}
            <section>
                <div class="ni-section-head"><span class="ni-section-label">${esc(T('ni_history', 'HISTORIQUE'))}</span></div>
                ${seenLine}${staleLine}
                <div class="ni-timeline">${historyHtml}</div>
            </section>
        </div>
        <div class="ni-drawer-foot">
            <span class="ni-foot-servers">${footServers.length ? esc(footServers.join(' · ')) : '&nbsp;'}</span>
            <div class="ni-drawer-foot-actions">
                <button class="ni-btn-close-foot" id="ni-drawer-close-foot">${esc(T('ni_close', 'Fermer'))}</button>
                <button class="ni-btn-apply" disabled title="${esc(soon())}">${esc(T('ni_apply', 'Appliquer les modifications'))}</button>
            </div>
        </div>`;
    }

    // ── diagnostics: banner, report, copy ──────────────────────────────────
    //
    // The scan reaches half a dozen services it does not control (DHCP over RPC,
    // DNS, the directory) and any of them can refuse. Before this, every refusal
    // was swallowed: the page showed an inventory missing its DHCP half and said
    // nothing. What an operator needs is not a nicer error string, it is something
    // they can paste into a message to whoever administers that server. Hence a
    // plain-text report carrying the failing command and the exact error, and a
    // banner rather than a modal, so a scan that mostly worked is not interrupted.

    function statusRank(s) {
        return s === 'failed' ? 2 : (s === 'degraded' ? 1 : 0);
    }

    function renderDiagBanner() {
        const bar = byId('ni-diag-banner');
        const text = byId('ni-diag-banner-text');
        if (!bar || !text) return;

        const sum = state.diagSummary;
        if (!sum || sum.status === 'ok') { bar.hidden = true; return; }

        // Name only the sources the count is about. `sources` carries every
        // source in trouble, both verdicts mixed, so pairing it with the failed
        // count announced three failures and then listed four names, the fourth
        // being a merely degraded read. Older payloads have no split list; they
        // fall back to the mixed one rather than to nothing.
        const failedOnly = sum.status === 'failed'
            ? (sum.failedSources || sum.sources || [])
            : (sum.degradedSources || sum.sources || []);
        const key = sum.status === 'failed' ? 'ni_diag_banner_failed' : 'ni_diag_banner_degraded';
        const fallback = sum.status === 'failed'
            ? '{n} source(s) en échec : {s}'
            : '{n} source(s) incomplète(s) : {s}';
        text.textContent = T(key, fallback)
            .replace('{n}', failedOnly.length)
            .replace('{s}', failedOnly.join(', '));
        bar.classList.toggle('failed', sum.status === 'failed');
        bar.hidden = false;
    }

    /**
     * The report, as plain text. Deliberately not JSON and not HTML: it is pasted
     * into a ticket or a chat message, so it has to stay readable once the
     * formatting is gone.
     */
    function buildDiagReport() {
        const L = [];
        const ctx = state.scanContext || {};
        L.push('=== Aegis · Inventaire réseau · rapport de diagnostic ===');
        L.push('Généré le          : ' + new Date().toLocaleString('fr-FR'));
        if (state.scannedAt) L.push('Scan du            : ' + new Date(state.scannedAt).toLocaleString('fr-FR'));
        if (ctx.computerName) L.push('Machine du scan    : ' + ctx.computerName);
        if (ctx.userName) L.push('Compte             : ' + ctx.userName);
        if (ctx.elevated !== undefined) L.push('Élévation          : ' + (ctx.elevated ? 'oui' : 'non'));
        if (ctx.domain) L.push('Domaine            : ' + ctx.domain);
        if (ctx.pdc) L.push('Contrôleur         : ' + ctx.pdc);
        if (ctx.psVersion) L.push('PowerShell         : ' + ctx.psVersion);
        if (ctx.osVersion) L.push('Système            : ' + ctx.osVersion);
        if (ctx.engine) L.push('Moteur             : ' + ctx.engine);
        if (ctx.dhcpScopes !== undefined) L.push('Étendues DHCP lues : ' + ctx.dhcpScopes);
        if (ctx.sweptSubnets !== undefined) {
            L.push('Sous-réseaux       : ' + ctx.sweptSubnets + ' balayé(s), ' + (ctx.sweptHosts || 0) + ' adresse(s)');
        }
        L.push('Inventaire         : ' + state.subnets.length + ' réseau(x), ' + state.ips.length + ' adresse(s)');
        L.push('');

        const entries = state.diagnostics.slice()
            .sort((a, b) => statusRank(b.status) - statusRank(a.status));

        if (!entries.length) {
            L.push('Aucun diagnostic enregistré pour ce scan.');
        }
        entries.forEach((d, i) => {
            L.push('--- ' + (i + 1) + '. ' + (d.source || 'Scan') + ' · ' + String(d.status || '').toUpperCase() + ' ---');
            if (d.message) L.push('Problème  : ' + d.message);
            if (d.hint) L.push('Piste     : ' + d.hint);
            if (d.command) L.push('Commande  : ' + d.command);
            if (d.detail) L.push('Erreur    : ' + d.detail);
            if (d.at) L.push('Horodatage: ' + d.at);
            L.push('');
        });
        return L.join('\n');
    }

    function renderDiagModal() {
        const list = byId('ni-diag-list');
        const raw = byId('ni-diag-raw');
        if (!list || !raw) return;

        const entries = state.diagnostics.slice()
            .sort((a, b) => statusRank(b.status) - statusRank(a.status));

        list.innerHTML = entries.length
            ? entries.map(d => {
                const st = String(d.status || 'ok');
                return `
                <div class="ni-diag-entry ${esc(st)}">
                    <div class="ni-diag-entry-head">
                        <span class="ni-diag-source">${esc(d.source || 'Scan')}</span>
                        <span class="ni-diag-status ${esc(st)}">${esc(T('ni_diag_status_' + st, st))}</span>
                    </div>
                    ${d.message ? `<p class="ni-diag-msg">${esc(d.message)}</p>` : ''}
                    ${d.hint ? `<p class="ni-diag-hint">${esc(d.hint)}</p>` : ''}
                    ${d.command ? `<code class="ni-diag-cmd">${esc(d.command)}</code>` : ''}
                    ${d.detail ? `<code class="ni-diag-detail">${esc(d.detail)}</code>` : ''}
                </div>`;
            }).join('')
            : `<div class="ni-empty-state">${esc(T('ni_diag_none', 'Aucun diagnostic pour ce scan'))}</div>`;

        raw.value = buildDiagReport();
    }

    function openDiag() {
        const modal = byId('ni-diag-modal');
        if (!modal) return;
        renderDiagModal();
        modal.hidden = false;
        const copied = byId('ni-diag-copied');
        if (copied) copied.hidden = true;
        const btn = byId('ni-diag-copy');
        if (btn) btn.focus();
    }

    function closeDiag() {
        const modal = byId('ni-diag-modal');
        if (modal) modal.hidden = true;
    }

    async function copyDiag() {
        const raw = byId('ni-diag-raw');
        if (!raw) return;
        const text = raw.value;
        let ok = false;
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                ok = true;
            }
        } catch (_) { /* falls through to the selection path below */ }
        if (!ok) {
            // http://<host>:3000 is not a secure context, so the Clipboard API is
            // unavailable on most installs. Selecting the textarea works there, and
            // leaves the text selected for a manual Ctrl+C if execCommand is gone too.
            raw.focus();
            raw.select();
            try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
        }
        const copied = byId('ni-diag-copied');
        if (copied) {
            copied.textContent = ok
                ? T('ni_diag_copied', 'Copié')
                : T('ni_diag_copy_manual', 'Rapport sélectionné, faites Ctrl+C');
            copied.hidden = false;
        }
    }

    // ── CSV export (client-side, current subnet + filters) ──
    function exportCsv() {
        const rows = filteredIps();
        if (!rows.length) {
            if (window.showToast) window.showToast(T('ni_export_empty', 'Rien à exporter'), 'warning');
            return;
        }
        const head = ['IP', 'Status', 'Hostname', 'MAC', 'DNS', 'DHCP', 'LastSeen'];
        const csvCell = v => {
            const str = v == null ? '' : String(v);
            return /[",;\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
        };
        const lines = [head.join(',')];
        rows.forEach(i => {
            lines.push([
                i.ip, i.status, i.hostname || '', i.mac || '',
                (i.dns || []).join(' '), i.dhcp && i.dhcp.detail || '', i.lastSeen || ''
            ].map(csvCell).join(','));
        });
        const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `inventaire-${(state.selectedCidr || 'reseau').replace(/[^\w.-]/g, '_')}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    // ── scan (reuses existing SSE contract) ──
    let scanning = false;
    async function runScan() {
        if (scanning) return;
        scanning = true;
        const btn = byId('ni-scan');
        const progress = byId('ni-progress');
        const fill = byId('ni-progress-fill');
        const pct = byId('ni-progress-pct');
        const label = byId('ni-progress-label');
        if (btn) btn.disabled = true;
        if (progress) progress.style.display = 'block';
        if (fill) fill.style.width = '0%';
        if (pct) pct.textContent = '0%';
        if (label) label.textContent = T('inventory_scanning', 'Scan en cours…');

        let sse = null;
        try {
            sse = new EventSource(window.tenantPrefix() + '/api/audit/events');
            sse.onmessage = (ev) => {
                try {
                    const d = JSON.parse(ev.data);
                    if (d.scan_progress !== undefined && fill) {
                        const p = Math.min(d.scan_progress, 100);
                        fill.style.width = p + '%';
                        if (pct) pct.textContent = p + '%';
                    }
                } catch (_) { }
            };
        } catch (_) { }

        try {
            const domain = (byId('audit-domain') && byId('audit-domain').value) || '';
            const res = await window.api('/api/inventory/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ domain })
            });
            const data = await res.json();
            if (fill) fill.style.width = '100%';
            if (pct) pct.textContent = '100%';
            // Both halves of the answer are read whatever the verdict: a failed scan
            // carries no inventory but always carries the reason it failed.
            absorbDiagnostics(data);
            if (data.success) {
                state.subnets = Array.isArray(data.subnets) ? data.subnets : [];
                state.ips = Array.isArray(data.ips) ? data.ips : [];
                state.scannedAt = data.scannedAt || new Date().toISOString();
                state.totalScans = Number(data.totalScans) || state.totalScans;
                state.dhcp = data.dhcp || null;
                if (!state.selectedCidr || !state.subnets.some(s => s.cidr === state.selectedCidr)) {
                    state.selectedCidr = state.subnets.length ? state.subnets[0].cidr : null;
                }
                renderAll();
                if (window.showToast) window.showToast(T('ni_scan_done', 'Scan terminé : {n} adresses').replace('{n}', state.ips.length), 'success');
            } else {
                renderAll();
                // The scan itself failed, so the report is opened rather than
                // left behind a banner: there is no result to look at instead.
                if (window.showToast) {
                    window.showToast(T('ni_scan_error', 'Échec du scan') + (data.error ? ' : ' + data.error : ''), 'error');
                }
                openDiag();
            }
        } catch (e) {
            console.error('[NetworkInventory] scan failed:', e);
            // The request never came back: no diagnostics from the scan, so this
            // builds the one entry that describes what the browser actually saw.
            state.diagnostics = [{
                source: 'Dashboard',
                status: 'failed',
                message: T('ni_diag_net_msg', "Le dashboard n'a pas obtenu de réponse du backend pendant le scan."),
                hint: T('ni_diag_net_hint', "Vérifier que le service Aegis tourne toujours et consulter son journal. Un scan long peut aussi avoir dépassé le délai d'un proxy intermédiaire."),
                command: 'POST /api/inventory/scan',
                detail: String(e && e.message ? e.message : e)
            }];
            state.diagSummary = summarize(state.diagnostics);
            renderDiagBanner();
            if (window.showToast) window.showToast(T('ni_scan_error', 'Échec du scan'), 'error');
            openDiag();
        } finally {
            if (sse) sse.close();
            scanning = false;
            if (btn) btn.disabled = false;
            setTimeout(() => { if (progress) progress.style.display = 'none'; }, 1200);
        }
    }

    // ── full render ──
    function renderAll() {
        renderSidebar();
        renderHeader();
        renderCards();
        renderSegment();
        renderTable();
        renderDiagBanner();
        if (state.drawerIp) renderDrawer();
        applyView();
        announce();
    }

    // The DHCP view is its own module and holds no copy of the inventory: it
    // redraws from whatever this page last loaded or scanned. It also asks once
    // when it starts (`ni:inventory-request`), in case the answer to the first
    // load arrived before it was listening.
    function announce() {
        document.dispatchEvent(new CustomEvent('ni:inventory', {
            detail: { dhcp: state.dhcp, diagnostics: state.diagnostics, scannedAt: state.scannedAt, loading: state.loading }
        }));
    }

    // ── view switch: subnet explorer | DHCP ──
    function applyView() {
        const root = byId('network-inventory-view');
        if (!root) return;
        const dhcp = state.view === 'dhcp';
        root.querySelectorAll('[data-ni-pane]').forEach(el => {
            el.hidden = (el.dataset.niPane === 'dhcp') !== dhcp;
        });
        root.querySelectorAll('[data-ni-view]').forEach(b => {
            const on = b.dataset.niView === state.view;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
    }
    function setView(view) {
        state.view = view === 'dhcp' ? 'dhcp' : 'networks';
        if (state.view === 'dhcp' && state.drawerIp) closeDrawer();
        applyView();
    }

    // ── events (delegated) ──
    function wire() {
        const view = byId('network-inventory-view');
        if (!view) return;

        view.addEventListener('click', (e) => {
            const tab = e.target.closest('[data-ni-view]');
            if (tab) { setView(tab.dataset.niView); return; }
            const manage = e.target.closest('[data-ni-manage]');
            if (manage) {
                setView('dhcp');
                document.dispatchEvent(new CustomEvent('ni:dhcp-select', { detail: { cidr: manage.dataset.niManage } }));
                return;
            }
            if (e.target.closest('[data-ni-diag]')) { openDiag(); return; }
            const net = e.target.closest('.ni-net');
            if (net && net.dataset.cidr) {
                state.selectedCidr = net.dataset.cidr;
                state.statusFilter = 'all';
                state.tableQuery = '';
                const ts = byId('ni-table-search'); if (ts) ts.value = '';
                renderAll();
                return;
            }
            const seg = e.target.closest('.ni-seg');
            if (seg && seg.dataset.seg) {
                state.statusFilter = seg.dataset.seg;
                renderSegment();
                renderTable();
                return;
            }
            if (e.target.closest('#ni-fix-anomalies')) {
                state.statusFilter = 'conflict';
                renderSegment();
                renderTable();
                return;
            }
            const row = e.target.closest('.ni-row');
            if (row && row.dataset.ip) { openDrawer(row.dataset.ip); return; }
            if (e.target.closest('#ni-export')) { exportCsv(); return; }
            if (e.target.closest('#ni-scan')) { runScan(); return; }
            if (e.target.closest('#ni-diag-open')) { openDiag(); return; }
        });

        // diagnostic report: the modal sits outside .ni-main, so it gets its own
        // listener rather than riding the view-level delegation above.
        const diagModal = byId('ni-diag-modal');
        if (diagModal) diagModal.addEventListener('click', (e) => {
            if (e.target.closest('#ni-diag-copy')) { copyDiag(); return; }
            if (e.target.closest('#ni-diag-close') ||
                e.target.closest('#ni-diag-close-foot') ||
                e.target.closest('#ni-diag-backdrop')) { closeDiag(); }
        });

        // keyboard activation for net items / rows
        view.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const net = e.target.closest('.ni-net');
            const row = e.target.closest('.ni-row');
            if (net && net.dataset.cidr) { e.preventDefault(); net.click(); }
            else if (row && row.dataset.ip) { e.preventDefault(); openDrawer(row.dataset.ip); }
        });

        const sbSearch = byId('ni-sidebar-search');
        if (sbSearch) sbSearch.addEventListener('input', (e) => { state.sidebarQuery = e.target.value; renderSidebar(); });
        const tblSearch = byId('ni-table-search');
        if (tblSearch) tblSearch.addEventListener('input', (e) => { state.tableQuery = e.target.value; renderTable(); });

        // drawer close (delegated: buttons live inside re-rendered drawer)
        const drawer = byId('ni-drawer');
        if (drawer) drawer.addEventListener('click', (e) => {
            if (e.target.closest('#ni-drawer-close') || e.target.closest('#ni-drawer-close-foot')) closeDrawer();
        });
        const scrim = byId('ni-scrim');
        if (scrim) scrim.addEventListener('click', closeDrawer);
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            // The report sits above the drawer, so Escape dismisses it first.
            const modal = byId('ni-diag-modal');
            if (modal && !modal.hidden) { closeDiag(); return; }
            if (state.drawerIp) closeDrawer();
        });

        document.addEventListener('ni:inventory-request', announce);

        // re-render dynamic content on language switch (chain any existing handler)
        const prev = window.onLanguageChange;
        window.onLanguageChange = function () {
            if (typeof prev === 'function') { try { prev(); } catch (_) { } }
            renderAll();
        };
    }

    function init() {
        if (!byId('network-inventory-view')) return;
        wire();
        loadInventory();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
