/*
 * Account Tiering: the backend model in, the view model the page draws out.
 *
 * Pure: no DOM, no fetch, no clock. It runs in the browser (window.AccountTiering
 * .model) and in Node (module.exports), so the unit tests feed it the model the
 * real backend produced and check every derived field without a browser.
 *
 * The backend keeps ONE path per account: the chain of edges that last lowered
 * its tier. The page wants more (every privileged group of the account, one
 * mechanism per group), so the other chains are rebuilt here by walking
 * `model.links` towards nodes of the same tier. Those rebuilt chains carry no
 * remediation: the backend attaches remediation to `account.path` only, so the
 * remediation dialog uses that path and nothing else.
 *
 * Every sentence is built from a translation key with named parameters, never
 * by gluing fragments, so a translator sees whole sentences.
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.AccountTiering = root.AccountTiering || {};
        root.AccountTiering.model = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const MAX_CHAIN = 12;

    /** Fallback translator for Node: the French text with its parameters filled in. */
    function plainT(key, fallback, params) {
        let text = String(fallback);
        for (const [k, v] of Object.entries(params || {})) text = text.split('{' + k + '}').join(String(v));
        return text;
    }

    /** Severity of reaching `tier` for an account planned at `planned`, as the backend derives it. */
    function sevOf(planned, tier) {
        if (tier == null || planned == null || tier >= planned) return null;
        return tier === 0 ? 'critical' : 'high';
    }

    function worst(list) {
        if (list.includes('critical')) return 'critical';
        if (list.includes('high')) return 'high';
        return null;
    }

    function buildViewModel(model, opts) {
        const options = opts || {};
        const T = options.t || plainT;
        const rules = options.rules || [];
        const m = model || {};
        const scan = m.scan || {};
        const domainSid = scan.domainSid || '';

        const accountsIn = Array.isArray(m.accounts) ? m.accounts : [];
        const groupsIn = Array.isArray(m.groups) ? m.groups : [];
        const objectsIn = Array.isArray(m.objects) ? m.objects : [];
        const links = Array.isArray(m.links) ? m.links : [];

        const accBySid = new Map(accountsIn.map((a) => [a.sid, a]));
        const groupBySid = new Map(groupsIn.map((g) => [g.sid, g]));
        const objByKey = new Map(objectsIn.map((o) => [o.key, o]));
        const outLinks = new Map();
        const memberCount = new Map();
        for (const l of links) {
            if (!outLinks.has(l.from)) outLinks.set(l.from, []);
            outLinks.get(l.from).push(l);
            if (l.type === 'membership') memberCount.set(l.to, (memberCount.get(l.to) || 0) + 1);
        }

        const wellKnown = {
            'S-1-1-0': T('at_wk_everyone', 'Tout le monde'),
            'S-1-5-11': T('at_wk_authenticated', 'Utilisateurs authentifiés'),
            'S-1-5-7': T('at_wk_anonymous', 'Ouverture de session anonyme'),
            'S-1-5-32-554': T('at_wk_pre2000', 'Accès compatible pré-Windows 2000'),
            'S-1-5-32-544': T('at_lg_admins', 'Administrateurs'),
            'S-1-5-32-555': T('at_lg_rdp', 'Utilisateurs du Bureau à distance'),
            'S-1-5-32-580': T('at_lg_winrm', 'Utilisateurs de gestion à distance')
        };
        wellKnown[`${domainSid}-513`] = T('at_wk_domain_users', 'Utilisateurs du domaine');
        wellKnown[`${domainSid}-515`] = T('at_wk_domain_computers', 'Ordinateurs du domaine');

        /** The short name a chip shows: sam for an account, name for a group, label for an object. */
        function labelOf(id) {
            const a = accBySid.get(id);
            if (a) return a.sam || a.name || id;
            const g = groupBySid.get(id);
            if (g) return g.name || g.sam || id;
            const o = objByKey.get(id);
            if (o) return o.label || id;
            return wellKnown[id] || id;
        }

        function gpoName(id) {
            const o = objByKey.get(id);
            return o ? o.label : id;
        }

        /** Tier of a node, or null when it reaches nothing. An account with no path reaches nothing. */
        function tierOf(id) {
            const a = accBySid.get(id);
            if (a) return a.path && a.path.length ? a.effective : null;
            const g = groupBySid.get(id);
            if (g) return g.tier == null ? null : g.tier;
            const o = objByKey.get(id);
            if (o) return o.tier == null ? null : o.tier;
            return null;
        }

        function edgeKey(e) {
            const d = e.detail || {};
            return `${e.kind}|${e.to}|${d.right || d.localGroup || ''}`;
        }

        /**
         * Where a chain ends, as the backend ends its own: on a group it flags
         * as a Tier 0 target, or on a directory object that carries a tier (the
         * domain root, AdminSDHolder, a GPO). Without this a chain would walk
         * on from Domain Admins into Administrators. Which groups are targets
         * is the backend's knowledge: the page reads the flag and keeps no list.
         */
        function endsChain(id) {
            const g = groupBySid.get(id);
            if (g) return g.target === true;
            const o = objByKey.get(id);
            return Boolean(o) && o.tier != null;
        }

        /** Rebuilds the backend's "best edge" chain from a node down to where it ends. */
        function walkFrom(start, tier) {
            const chain = [];
            const seen = new Set([start]);
            let node = start;
            while (!endsChain(node) && chain.length < MAX_CHAIN) {
                const next = (outLinks.get(node) || []).find((l) => !seen.has(l.to) && tierOf(l.to) === tier);
                if (!next) break;
                chain.push(next);
                seen.add(next.to);
                node = next.to;
            }
            return chain;
        }

        function chipOf(e) {
            const d = e.detail || {};
            if (e.kind === 'membership') return labelOf(e.to);
            if (e.kind === 'acl') return T('at_chain_acl', '{right} sur {target}', { right: d.right, target: labelOf(e.to) });
            if (e.kind === 'gpoEdit') return T('at_chain_gpo_edit', 'modification de {gpo}', { gpo: gpoName(e.to) });
            return T('at_chain_gpo_local', '{group} via {gpo}', { group: labelOf(d.localGroup), gpo: gpoName(e.to) });
        }

        function whyOf(acc, edges, d, tier) {
            const e = edges[d];
            const det = e.detail || {};
            const p = { account: acc.sam, holder: labelOf(e.from), target: labelOf(e.to), tier };
            if (e.kind === 'membership') {
                if (det.via === 'primaryGroup') return T('at_why_primary', '{target} est le groupe principal de {holder} : il ne figure pas dans memberOf, mais il donne le Tier {tier}.', p);
                if (d > 0) return T('at_why_member_nested', 'Par appartenance imbriquée, {account} hérite de {target}, un groupe Tier {tier}.', p);
                return T('at_why_member', '{holder} est membre de {target}, un groupe Tier {tier}.', p);
            }
            if (e.kind === 'acl') {
                if (det.right === 'DCSync') return T('at_why_dcsync', '{holder} peut répliquer les secrets du domaine {target} (DCSync), ce qui donne le Tier {tier}.', p);
                const q = { ...p, right: det.right, origin: det.originDn };
                if (det.inherited) return T('at_why_acl_inherited', '{holder} détient {right} sur {target}, hérité de {origin}, ce qui donne le Tier {tier}.', q);
                return T('at_why_acl', '{holder} détient {right} sur {target}, ce qui donne le Tier {tier}.', q);
            }
            if (e.kind === 'gpoEdit') return T('at_why_gpo_edit', '{holder} peut modifier la GPO {gpo}, appliquée à des machines Tier {tier}.', { ...p, gpo: gpoName(e.to) });
            return T('at_why_gpo_local', 'La GPO {gpo} place {holder} dans le groupe local {group} de machines Tier {tier}.', { ...p, gpo: gpoName(e.to), group: labelOf(det.localGroup) });
        }

        /** One mechanism from a chain of edges starting at the account. */
        function mechOf(acc, edges, tier, fromPath) {
            let d = edges.findIndex((e) => e.kind !== 'membership');
            if (d < 0) d = edges.length - 1;
            const e = edges[d];
            const det = e.detail || {};
            const first = edges[0];
            const gk = first.kind === 'membership' ? first.to : 'direct:' + acc.sid;
            let rel = 'gpo';
            let relTitle = T('at_rel_gpo', 'GPO');
            let name;
            let sub;
            let icon;
            if (e.kind === 'membership') {
                rel = 'member';
                if (det.via === 'primaryGroup') relTitle = T('at_rel_primary', 'Groupe principal');
                else if (d > 0) relTitle = T('at_rel_nested', 'Appartenance imbriquée');
                else relTitle = T('at_rel_member', 'Appartenance');
                name = labelOf(e.to);
                sub = T('at_mech_sub_group', 'groupe Tier {tier}', { tier });
                icon = tier === 0 ? 'shield' : 'group';
            } else if (e.kind === 'acl') {
                rel = 'acl';
                relTitle = T('at_rel_acl', 'Délégation ACL');
                name = det.right;
                sub = T('at_mech_sub_on', 'sur {target}', { target: labelOf(e.to) });
                icon = 'key';
            } else if (e.kind === 'gpoEdit') {
                name = T('at_mech_gpo_edit', 'Modification de GPO');
                sub = gpoName(e.to);
                icon = 'doc';
            } else {
                name = labelOf(det.localGroup);
                sub = T('at_mech_sub_gpo', 'GPO {gpo}', { gpo: gpoName(e.to) });
                icon = 'screen';
            }
            return {
                key: edgeKey(e), gk, name, sub, icon, rel, relTitle, tier,
                severity: sevOf(acc.planned, tier),
                chain: [acc.sam, ...edges.map(chipOf)],
                why: whyOf(acc, edges, d, tier),
                fromPath
            };
        }

        function stepOf(e, n) {
            const r = e.remediation || {};
            const p = {
                member: labelOf(e.from), holder: labelOf(e.from), group: labelOf(r.localGroup || e.to),
                target: labelOf(e.to), gpo: r.gpo || gpoName(e.to)
            };
            const titles = {
                membership: ['at_step_membership', 'Retirer {member} du groupe {group}'],
                primaryGroup: ['at_step_primary', 'Rendre à {member} son groupe principal par défaut'],
                acl: ['at_step_acl', 'Retirer les droits de {holder} sur {target}'],
                gpoEdit: ['at_step_gpo_edit', 'Retirer {holder} de la délégation de la GPO {gpo}'],
                gpoLocal: ['at_step_gpo_local', 'Retirer {holder} du groupe local {group} posé par la GPO {gpo}']
            };
            const title = titles[r.mechanism] || ['at_step_other', 'Couper le lien de {holder} vers {target}'];
            const sections = {
                delegation: ['at_gpmc_delegation', 'Dans la console de gestion des stratégies de groupe, ouvrez {gpo}, onglet Délégation, et retirez {holder}.'],
                restrictedGroups: ['at_gpmc_restricted', 'Dans la console de gestion des stratégies de groupe, modifiez {gpo} : Configuration ordinateur › Stratégies › Paramètres Windows › Paramètres de sécurité › Groupes restreints, puis retirez {holder} du groupe {group}.'],
                localUsersAndGroups: ['at_gpmc_local_users', 'Dans la console de gestion des stratégies de groupe, modifiez {gpo} : Configuration ordinateur › Préférences › Paramètres du Panneau de configuration › Utilisateurs et groupes locaux, puis retirez {holder} du groupe {group}.']
            };
            const warnings = {
                removes_all_aces: ['at_warn_removes_all_aces', 'dsacls /R retire toutes les ACE de ce titulaire sur l’objet, pas seulement celle-ci : relevez les autres avant de lancer la commande.'],
                primary_group: ['at_warn_primary_group', 'Remove-ADGroupMember ne retire pas un groupe principal : la commande remet le groupe par défaut (513, ou 515 pour un ordinateur ou un gMSA).']
            };
            const section = sections[r.section];
            const warning = warnings[r.warning];
            return {
                n,
                mechanism: r.mechanism || e.kind,
                title: T(title[0], title[1], p),
                command: r.command || null,
                gpmc: section ? T(section[0], section[1], p) : null,
                warning: r.warning || null,
                warningText: warning ? T(warning[0], warning[1]) : null
            };
        }

        function sourceLabel(src) {
            const s = src || {};
            if (s.type === 'override') return T('at_source_override', 'Correction manuelle');
            if (s.type === 'rule') {
                const i = rules.findIndex((r) => r.id === s.ruleId);
                if (i < 0) return T('at_source_rule_unknown', 'Règle de tiering');
                return T('at_source_rule', 'Règle {n} : {pattern}', { n: i + 1, pattern: rules[i].pattern });
            }
            return T('at_source_default', 'Aucune règle ne couvre ce compte : Tier 2 par défaut');
        }

        function groupView(gsid) {
            const g = groupBySid.get(gsid) || {};
            const n = memberCount.get(gsid) || 0;
            const tier = tierOf(gsid);
            return {
                key: gsid, sid: gsid, name: labelOf(gsid), members: n, tier, t0: tier === 0, direct: false,
                sub: n === 1 ? T('at_members_one', '{n} membre', { n }) : T('at_members_many', '{n} membres', { n }),
                desc: T('at_group_desc', 'Ses membres atteignent le Tier {tier}.', { tier }),
                broad: Boolean(g.broad)
            };
        }

        function accountView(a) {
            const path = Array.isArray(a.path) ? a.path : [];
            const mechs = [];
            const groups = [];
            const seenG = new Set();
            let hidden = 0;
            if (path.length) mechs.push(mechOf(a, path, a.effective, true));
            const pathFirst = path[0] ? edgeKey(path[0]) : null;
            let hasDirect = path.length > 0 && path[0].kind !== 'membership';

            for (const l of outLinks.get(a.sid) || []) {
                const tier = tierOf(l.to);
                if (l.type === 'membership') {
                    if (seenG.has(l.to)) continue;
                    seenG.add(l.to);
                    if (tier == null) { hidden += 1; continue; }
                    groups.push(groupView(l.to));
                } else if (tier == null) {
                    continue;
                } else {
                    hasDirect = true;
                }
                if (edgeKey(l) === pathFirst) continue;
                mechs.push(mechOf(a, [l, ...walkFrom(l.to, tier)], tier, false));
            }
            if (hasDirect) {
                groups.push({
                    key: 'direct:' + a.sid, sid: null, name: T('at_direct_name', 'Droits directs'),
                    sub: T('at_direct_sub', 'sur le compte lui-même'), members: null, tier: Math.min(...mechs.filter((x) => x.gk === 'direct:' + a.sid).map((x) => x.tier)),
                    t0: false, direct: true, desc: T('at_direct_desc', 'Droits accordés au compte lui-même, sans passer par un groupe.')
                });
            }
            // A link that starts at ANOTHER account which sits legitimately at
            // that tier (the Tier 0 admin whose password the helpdesk resets)
            // is not this account's gap: cutting it would demote the admin.
            const legit = (from) => from !== a.sid && accBySid.has(from) && accBySid.get(from).status !== 'gap';
            const steps = path
                .filter((e) => e.remediation && tierOf(e.to) != null && tierOf(e.to) < a.planned && !legit(e.from))
                .map((e, i) => stepOf(e, i + 1));
            // Only for a planned tier that comes from a manual correction; a
            // backend that predates the details sends none, and the panel then
            // shows the source alone.
            const ov = a.plannedSource && a.plannedSource.type === 'override' ? a.override : null;
            return {
                override: ov ? { reason: ov.reason || '', setBy: ov.setBy || null, setAt: ov.setAt || null } : null,
                id: a.sid, sid: a.sid, sam: a.sam, name: a.name || a.sam, dn: a.dn, enabled: a.enabled !== false,
                kind: a.kind === 'gmsa' ? 'service' : (a.kind === 'computer' ? 'computer' : 'user'),
                planned: a.planned, plannedSource: a.plannedSource || { type: 'default' },
                sourceLabel: sourceLabel(a.plannedSource), effective: a.effective,
                status: a.status, severity: a.severity || null, gap: a.status === 'gap',
                remediationProposed: Boolean(a.remediationProposed),
                groups, hidden, mechs, steps
            };
        }

        const accounts = accountsIn.map(accountView);
        const byId = {};
        for (const a of accounts) byId[a.id] = a;

        // The backend lists only the points to fix (a gap goes through, or the
        // holder is broad), already sorted: shown as they come.
        const rawPoints = Array.isArray(m.chokepoints) ? m.chokepoints : [];
        const maxExpo = Math.max(1, ...rawPoints.map((p) => (p.gaps || []).length));
        const points = rawPoints.map((p) => {
            const d = p.detail || {};
            const expo = (p.gaps || []).length;
            const prm = { right: d.right, target: labelOf(p.to), gpo: gpoName(p.to), group: labelOf(d.localGroup), holder: labelOf(p.from), tier: p.tier };
            let name;
            if (p.kind === 'membership') name = labelOf(p.to);
            else if (p.kind === 'acl') name = T('at_point_acl', '{right} sur {target}', prm);
            else if (p.kind === 'gpoEdit') name = T('at_point_gpo_edit', 'Modification de {gpo}', prm);
            else name = T('at_point_gpo_local', '{group} via {gpo}', prm);
            let meta;
            if (p.broad) meta = T('at_point_meta_broad', 'Titulaire trop large : {holder} couvre tous les comptes', prm);
            else if (p.kind === 'membership') meta = p.tier === 0 ? T('at_point_meta_t0', 'Groupe Tier 0 · membre non prévu') : T('at_point_meta_group', 'Groupe · Tier {tier}', prm);
            else meta = T('at_point_meta_holder', 'Titulaire : {holder}', prm);
            let expoLabel;
            if (p.broad) expoLabel = T('at_point_expo_all', 'tous les comptes');
            else if (expo === 1) expoLabel = T('at_point_expo_one', '{n} compte en écart', { n: expo });
            else expoLabel = T('at_point_expo_many', '{n} comptes en écart', { n: expo });
            const select = p.kind === 'membership'
                ? ['g:' + p.to, 'm:' + edgeKey(p)]
                : ['g:' + p.from, 'm:' + edgeKey(p), 'g:direct:' + p.from];
            return {
                key: p.key, kind: p.kind, tier: p.tier, broad: Boolean(p.broad), name, meta, expo, expoLabel,
                pct: p.broad ? 100 : Math.max(4, Math.round(expo / maxExpo * 100)),
                severity: p.tier === 0 ? 'critical' : 'high', select, gaps: p.gaps || []
            };
        });

        const matrix = Array.isArray(m.matrix) ? m.matrix : [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        const kf = m.keyFigures || {};
        const gaps = accounts.filter((a) => a.gap).length;
        return {
            domain: scan.domain || '', collectedAt: scan.collectedAt || null, passes: scan.passes || null,
            truncated: Boolean(scan.truncated), unreadable: Array.isArray(scan.unreadable) ? scan.unreadable : [],
            rulesCount: typeof m.rulesCount === 'number' ? m.rulesCount : 0,
            accounts, byId, points, matrix,
            uncollected: Math.max(0, (kf.accounts || accounts.length) - accounts.length),
            kpis: {
                accounts: accounts.length, gaps,
                gapPct: accounts.length ? Math.round(gaps / accounts.length * 100) : 0,
                t0Unplanned: accounts.filter((a) => a.effective === 0 && a.planned > 0).length,
                points: typeof kf.chokepoints === 'number' ? kf.chokepoints : points.length
            }
        };
    }

    return { buildViewModel, sevOf, worst, plainT };
});
