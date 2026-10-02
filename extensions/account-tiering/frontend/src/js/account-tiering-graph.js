/*
 * Account Tiering: the tree's layout, as pure functions.
 *
 * Columns are fixed (account, groups, mechanisms, tier); rows are placed by
 * barycentre, the mockup's hand-rolled algorithm: the mechanism column is
 * sorted first, then every other column sits at the mean height of its
 * neighbours, never closer than one ROW. No crossing minimisation beyond that,
 * on purpose: a tree of one account has few crossings, and the inverted tree
 * folds past AMAX accounts and GMAX groups so it never grows into a hairball.
 * Unfolded, it still draws AOPEN accounts at most.
 *
 * Layer coordinates are independent of the viewport. Pan and zoom are a CSS
 * transform applied on top (see account-tiering-tree.js), so nothing here
 * depends on the screen and the module runs in Node for the tests.
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.AccountTiering = root.AccountTiering || {};
        root.AccountTiering.graph = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const COLX = [36, 312, 588, 864];
    const CW = 220;
    const CH = 72;
    const ROW = 104;
    const TOP = 56;
    const HEAD_Y = TOP - 36;
    const CONTENT_W = COLX[3] + CW + 36;
    const GMAX = 8;
    const AMAX = 12;
    const AOPEN = 200;
    const ZMIN = 0.1;
    const ZMAX = 2;

    const cnt = (o) => Object.keys(o).length;
    const vals = (o) => Object.keys(o).map((k) => o[k]);
    const mean = (arr) => Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);

    function colOf(id) {
        if (id.startsWith('a:') || id === 'cl:a') return 0;
        if (id.startsWith('g:') || id === 'cl:g' || id === 'ghost' || id === 'fold') return 1;
        if (id.startsWith('m:') || id === 'cl:m') return 2;
        return 3;
    }

    /**
     * @param accs  view-model accounts (groups, mechs with gk/key/tier)
     * @param o     { tier, ecartOnly, inverse, expandG, expandA, keepG, ghost }
     */
    function buildGraph(accs, o) {
        const A = [];
        const Gm = {};
        const Mm = {};
        const tiersSet = {};
        let nG = 0;
        let nM = 0;
        for (const a of accs) {
            const ms = a.mechs.filter((m) => (o.tier == null || m.tier === o.tier) && (!o.ecartOnly || m.tier < a.planned));
            if (!ms.length) continue;
            const entry = { acc: a, ms, gks: {} };
            A.push(entry);
            for (const m of ms) {
                const g = a.groups.find((gg) => gg.key === m.gk) || { key: m.gk, name: m.gk, sub: '' };
                const gk = g.key;
                entry.gks[gk] = 1;
                let G = Gm[gk];
                if (!G) G = Gm[gk] = { key: gk, g, acc: a, accs: {}, mechs: {}, minTier: 9, order: nG++ };
                G.accs[a.id] = a;
                G.mechs[m.key] = 1;
                G.minTier = Math.min(G.minTier, m.tier);
                let M = Mm[m.key];
                if (!M) M = Mm[m.key] = { key: m.key, m, groups: {}, accs: {}, order: nM++ };
                M.groups[gk] = 1;
                M.accs[a.id] = a;
                tiersSet[m.tier] = 1;
            }
        }
        const allG = vals(Gm).sort((p, q) => p.minTier - q.minTier || cnt(q.accs) - cnt(p.accs) || p.order - q.order);
        let visGList = allG;
        let colG = [];
        if (allG.length > GMAX && !o.expandG) {
            visGList = allG.slice(0, GMAX - 1);
            colG = allG.slice(GMAX - 1);
            // A group the user selected stays visible even when it falls in the fold.
            const ix = o.keepG ? colG.findIndex((G) => G.key === o.keepG) : -1;
            if (ix >= 0) { visGList.push(colG[ix]); colG.splice(ix, 1); }
        }
        const visG = {};
        visGList.forEach((G) => { visG[G.key] = 1; });
        const allM = vals(Mm);
        const visMList = [];
        const colM = [];
        allM.forEach((M) => { (Object.keys(M.groups).some((k) => visG[k]) ? visMList : colM).push(M); });
        const sortA = A.slice().sort((p, q) => (p.acc.effective - p.acc.planned) - (q.acc.effective - q.acc.planned)
            || String(p.acc.name).localeCompare(String(q.acc.name)));
        let visAList = sortA;
        let colA = [];
        // Unfolded is not unbounded: past AOPEN accounts the tree is a column
        // of thousands of boxes nobody reads, and every render pays for it.
        // The rest stays behind the soft node, which then says how many
        // (capA), and the gaps are drawn first because sortA puts them first.
        const maxA = o.expandA ? AOPEN : AMAX - 1;
        const capA = Boolean(o.inverse && o.expandA && sortA.length > AOPEN);
        if (o.inverse && sortA.length > (o.expandA ? AOPEN : AMAX)) { visAList = sortA.slice(0, maxA); colA = sortA.slice(maxA); }
        const visA = {};
        visAList.forEach((e) => { visA[e.acc.id] = 1; });
        const visM = {};
        visMList.forEach((M) => { visM[M.key] = 1; });

        const edges = [];
        const seen = {};
        const add = (from, to, rel) => {
            const k = from + '>' + to;
            if (seen[k]) return;
            seen[k] = 1;
            edges.push({ from, to, rel });
        };
        const aId = (e) => (visA[e.acc.id] ? 'a:' + e.acc.id : 'cl:a');
        const gId = (k) => (visG[k] ? 'g:' + k : 'cl:g');
        const mId = (k) => (visM[k] ? 'm:' + k : 'cl:m');
        A.forEach((e) => Object.keys(e.gks).forEach((gk) => add(aId(e), gId(gk), 'member')));
        allG.forEach((G) => Object.keys(G.mechs).forEach((mk) => {
            const f = gId(G.key);
            const t = mId(mk);
            add(f, t, f === 'cl:g' || t === 'cl:m' ? 'member' : Mm[mk].m.rel);
        }));
        allM.forEach((M) => add(mId(M.key), 't:' + M.m.tier, 'member'));
        const extra1 = [];
        if (o.ghost && A.length) { extra1.push('ghost'); add('a:' + A[0].acc.id, 'ghost', 'member'); }
        if (allG.length > GMAX && o.expandG) extra1.push('fold');

        const y = {};
        const outs = {};
        const ins = {};
        edges.forEach((e) => { (outs[e.from] = outs[e.from] || []).push(e.to); (ins[e.to] = ins[e.to] || []).push(e.from); });
        const col2 = visMList.slice()
            .sort((p, q) => p.m.tier - q.m.tier || cnt(q.accs) - cnt(p.accs) || p.order - q.order)
            .map((M) => 'm:' + M.key);
        if (colM.length) col2.push('cl:m');
        col2.forEach((id, i) => { y[id] = TOP + 36 + i * ROW; });
        const meanOf = (arr) => {
            const ys = (arr || []).map((k) => y[k]).filter((v) => v != null);
            return ys.length ? mean(ys) : null;
        };
        const place = (ids, baryOf) => {
            const list = ids.map((id) => ({ id, b: baryOf(id) }))
                .sort((p, q) => (p.b == null ? 1e9 : p.b) - (q.b == null ? 1e9 : q.b));
            let prev = -1e9;
            list.forEach((it) => {
                const v = Math.max(it.b == null ? -1e9 : it.b, prev + ROW, TOP + 36);
                y[it.id] = v;
                prev = v;
            });
            return prev;
        };
        const col3 = Object.keys(tiersSet).map(Number).sort().map((t) => 't:' + t);
        place(col3, (id) => meanOf(ins[id]));
        const col1 = visGList.map((G) => 'g:' + G.key);
        if (colG.length) col1.push('cl:g');
        let last1 = place(col1, (id) => meanOf(outs[id]));
        extra1.forEach((id) => { last1 = Math.max(last1 + ROW, TOP + 36); y[id] = last1; });
        const col0 = visAList.map((e) => 'a:' + e.acc.id);
        if (colA.length) col0.push('cl:a');
        place(col0, (id) => meanOf((outs[id] || []).filter((k) => k !== 'ghost')));
        const bottom = Math.max(...Object.keys(y).map((k) => y[k]), TOP + 36) + 36;
        return { A, Gm, Mm, allG, colG, colM, colA, capA, visA, visG, visM, edges, y, col0, col3, bottom };
    }

    /** Everything upstream and downstream of `sel`: the highlighted path. */
    function highlight(edges, sel) {
        const fwd = {};
        const rev = {};
        edges.forEach((e) => { (fwd[e.from] = fwd[e.from] || []).push(e.to); (rev[e.to] = rev[e.to] || []).push(e.from); });
        const H = {};
        if (!sel) return H;
        H[sel] = 1;
        const walk = (adj) => {
            const seenW = {};
            const stack = [sel];
            while (stack.length) {
                const nd = stack.pop();
                (adj[nd] || []).forEach((k) => { if (!seenW[k]) { seenW[k] = 1; H[k] = 1; stack.push(k); } });
            }
        };
        walk(fwd);
        walk(rev);
        return H;
    }

    /** The two SVG paths of one edge (solid trunk, dashed tail), relative to its own box. */
    function edgeGeometry(x1, y1, x2, y2) {
        const mx = x1 + 28;
        const ox = x1;
        const oy = Math.min(y1, y2) - 8;
        const X = (v) => v - ox;
        const Y = (v) => v - oy;
        let trunk;
        let tail;
        if (y1 === y2) {
            trunk = `M ${X(x1)} ${Y(y1)} H ${X(mx)}`;
            tail = `M ${X(mx)} ${Y(y2)} H ${X(x2)}`;
        } else {
            const sg = y2 > y1 ? 1 : -1;
            const r = Math.min(6, Math.abs(y2 - y1) / 2);
            trunk = `M ${X(x1)} ${Y(y1)} H ${X(mx - r)} Q ${X(mx)} ${Y(y1)} ${X(mx)} ${Y(y1 + sg * r)} V ${Y(y2 - sg * r)} Q ${X(mx)} ${Y(y2)} ${X(mx + r)} ${Y(y2)}`;
            tail = `M ${X(mx + r)} ${Y(y2)} H ${X(x2)}`;
        }
        return { left: ox, top: oy, w: x2 - x1 + 8, h: Math.abs(y2 - y1) + 16, trunk, tail };
    }

    /**
     * The view that fits the whole tree in a viewport of W x H, rounded down to
     * a 5 % step. Never above 100 %: a small tree stays at natural size.
     * `reserve` is the strip the legend covers at the bottom.
     */
    function fitFor(bottom, W, H, reserve) {
        const contentTop = HEAD_Y - 8;
        const contentH = bottom + 16 - contentTop;
        const availH = Math.max(120, H - (reserve == null ? 96 : reserve));
        const availW = Math.max(120, W - 16);
        const z = Math.max(ZMIN, Math.floor(Math.min(1, availH / contentH, availW / CONTENT_W) * 20) / 20);
        return { x: Math.max(0, Math.round((W - CONTENT_W * z) / 2)), y: Math.round(16 - contentTop * z), z };
    }

    const clampZ = (z) => Math.max(ZMIN, Math.min(ZMAX, z));

    return {
        COLX, CW, CH, ROW, TOP, HEAD_Y, CONTENT_W, GMAX, AMAX, AOPEN, ZMIN, ZMAX,
        colOf, buildGraph, highlight, edgeGeometry, fitFor, clampZ
    };
});
