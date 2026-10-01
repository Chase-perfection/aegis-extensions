/**
 * The routes behind the account-tiering page, all under /api/account-tiering.
 *
 * Every route is behind `requireRole('admin')`, reads included: the model is a
 * list of the ways to take control of the domain, and a reader who is not an
 * administrator of the tenant has no use for it that is not an attack.
 *
 * Storage is core's `extensionDb`, bound to this extension by the loader. A
 * core that does not hand it over gets a 501 `store_unavailable` on each route
 * that needs it, and `register` itself never throws: CONTRACT.md asks for a
 * refused feature, not an inert extension.
 *
 * A scan answers 202 at once and runs in the background. The page polls
 * `GET /scan/status`. The model is rebuilt only when the scan, the rules, the
 * overrides or the remediation markers change, so editing a rule recomputes the
 * tiers without reading the directory again.
 */

'use strict';

const path = require('path');

const store = require('./store');
const { runCollector } = require('./runner');
const { analyze } = require('./analyze');
const { classify } = require('./classify');
const { remediationFor, remediationContext } = require('./remediation');
const { toCsv } = require('./exportCsv');
const { isSid } = require('./sids');

const BASE = '/api/account-tiering';
const RULE_KINDS = new Set(['ou', 'name', 'group']);
const MAX_RULES = 200;
const MAX_TEXT = 256;
const DNS_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

// Test seam, as in deploy's firewall.js: the real collector needs a domain.
let runCollectorImpl = runCollector;

const isTier = (v) => v === 0 || v === 1 || v === 2;
const isText = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_TEXT;

function validRules(body) {
    if (!Array.isArray(body) || body.length > MAX_RULES) return null;
    const rules = [];
    for (const r of body) {
        if (!r || !RULE_KINDS.has(r.kind) || !isText(r.pattern) || !isTier(r.tier)) return null;
        if (r.kind === 'group' && !isSid(r.pattern)) return null;
        rules.push({ kind: r.kind, pattern: r.pattern.trim(), tier: r.tier });
    }
    return rules;
}

function register(router, context) {
    const { requireRole } = context;
    const admin = requireRole('admin');
    const edb = context.extensionDb && typeof context.extensionDb.withRequest === 'function'
        ? context.extensionDb
        : null;
    const log = typeof context.broadcastLog === 'function' ? context.broadcastLog : () => {};
    const models = new Map();
    const starting = new Set();

    const fail = (res, status, error) => res.status(status).json({ success: false, error });

    /** Runs `work(db)` on the tenant's store, or answers 501 without one. */
    const withStore = (handler) => async (req, res) => {
        if (!edb) return fail(res, 501, 'store_unavailable');
        try {
            await edb.withRequest(req, async (db) => {
                await store.ensure(db);
                await handler(req, res, db);
            });
        } catch (error) {
            console.error('[account-tiering]', error);
            if (!res.headersSent) fail(res, 500, 'internal');
        }
    };

    const sidParam = (handler) => (req, res, db) => (isSid(req.params.sid)
        ? handler(req, res, db)
        : fail(res, 400, 'invalid_sid'));

    /**
     * The key is built from the scan id, not its facts: the facts are the
     * whole directory graph, read and parsed only when the model must be
     * rebuilt. A scan finishing between the two reads takes the facts away
     * from the old id, so the id is read again then.
     */
    async function modelFor(req, db) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const id = await store.latestFactsId(db);
            if (!id) return null;
            const [rules, overrides, remediations] = await Promise.all([
                store.getRules(db), store.getOverrides(db), store.getRemediations(db)
            ]);
            const key = JSON.stringify([id, rules, overrides, remediations]);
            const cached = models.get(req.tenant.slug);
            if (cached && cached.key === key) return cached.model;
            const facts = await store.factsById(db, id);
            if (!facts) continue;
            const planned = classify(facts, rules, overrides);
            const model = analyze(facts, planned, { remediations: new Set(remediations.map((r) => r.sid)) });
            const ctx = remediationContext(facts);
            for (const account of model.accounts) {
                for (const edge of account.path) edge.remediation = remediationFor(edge, ctx);
            }
            model.rulesCount = rules.length;
            models.set(req.tenant.slug, { key, model });
            return model;
        }
        return null;
    }

    async function answerModel(req, res, db, send) {
        let model;
        try {
            model = await modelFor(req, db);
        } catch (error) {
            if (error.code === 'facts_schema') return fail(res, 422, 'facts_schema');
            throw error;
        }
        if (!model) return fail(res, 404, 'no_scan_yet');
        return send(model);
    }

    router.get(`${BASE}/model`, admin, withStore((req, res, db) =>
        answerModel(req, res, db, (model) => res.json({ success: true, model }))));

    router.post(`${BASE}/scan`, admin, withStore(async (req, res, db) => {
        // Checked and set before any await: two requests can both see no
        // running scan in the database while the first is still inserting.
        const slug = req.tenant.slug;
        if (starting.has(slug)) return fail(res, 409, 'scan_running');
        starting.add(slug);
        let id;
        let settings;
        let dir;
        try {
            if (await store.runningScan(db)) return fail(res, 409, 'scan_running');
            settings = await store.getSettings(db);
            // Before the row exists: if the path cannot be resolved there is
            // no `running` scan left behind to block the next one.
            dir = path.dirname(edb.pathForRequest(req));
            id = await store.startScan(db, settings.domain);
        } finally {
            starting.delete(slug);
        }
        const outFile = path.join(dir, `scan-${id}.json`);
        res.status(202).json({ success: true, id });

        // Inside a promise, so a collector that throws at launch lands in the
        // catch below and the scan is closed instead of staying `running`.
        Promise.resolve()
            .then(() => runCollectorImpl({ domain: settings.domain, passes: settings.passes, outFile, onLine: (l) => log(slug, l) }))
            .then((result) => edb.withRequest(req, (later) => store.finishScan(later, id, result.ok
                ? { status: result.status, facts: result.facts }
                : { status: 'failed', errorCode: result.code })))
            .catch((error) => {
                console.error('[account-tiering] scan', error);
                // One more try, so the row does not stay `running`; runningScan
                // closes it anyway if this fails too.
                return edb.withRequest(req, (later) => store.finishScan(later, id, { status: 'failed', errorCode: 'internal' }))
                    .catch((again) => console.error('[account-tiering] scan not recorded', again));
            });
    }));

    router.get(`${BASE}/scan/status`, admin, withStore(async (req, res, db) => {
        res.json({ success: true, scan: (await store.latestScan(db)) || null });
    }));

    router.get(`${BASE}/rules`, admin, withStore(async (req, res, db) => {
        res.json({ success: true, rules: await store.getRules(db) });
    }));

    router.put(`${BASE}/rules`, admin, withStore(async (req, res, db) => {
        const rules = validRules(req.body && req.body.rules);
        if (!rules) return fail(res, 400, 'invalid_rules');
        await store.replaceRules(db, rules, req.user && req.user.email);
        res.json({ success: true, rules: await store.getRules(db) });
    }));

    router.put(`${BASE}/overrides/:sid`, admin, withStore(sidParam(async (req, res, db) => {
        const { tier, reason } = req.body || {};
        if (!isTier(tier)) return fail(res, 400, 'invalid_tier');
        if (!isText(reason)) return fail(res, 400, 'reason_required');
        await store.setOverride(db, req.params.sid, { tier, reason: reason.trim(), by: req.user && req.user.email });
        res.json({ success: true });
    })));

    router.delete(`${BASE}/overrides/:sid`, admin, withStore(sidParam(async (req, res, db) => {
        await store.deleteOverride(db, req.params.sid);
        res.json({ success: true });
    })));

    router.post(`${BASE}/remediations/:sid`, admin, withStore(sidParam(async (req, res, db) => {
        await store.markRemediation(db, req.params.sid, req.user && req.user.email);
        res.json({ success: true });
    })));

    router.get(`${BASE}/settings`, admin, withStore(async (req, res, db) => {
        res.json({ success: true, settings: await store.getSettings(db) });
    }));

    router.put(`${BASE}/settings`, admin, withStore(async (req, res, db) => {
        const { domain, passes } = req.body || {};
        if (domain !== null && domain !== '' && !(typeof domain === 'string' && DNS_RE.test(domain))) {
            return fail(res, 400, 'invalid_domain');
        }
        if (!Number.isInteger(passes) || passes < 1 || passes > 5) return fail(res, 400, 'invalid_passes');
        await store.putSettings(db, { domain: domain || null, passes });
        res.json({ success: true, settings: await store.getSettings(db) });
    }));

    router.get(`${BASE}/export.json`, admin, withStore((req, res, db) =>
        answerModel(req, res, db, (model) => {
            res.setHeader('Content-Disposition', 'attachment; filename="account-tiering.json"');
            res.json(model);
        })));

    router.get(`${BASE}/export.csv`, admin, withStore((req, res, db) =>
        answerModel(req, res, db, (model) => {
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="account-tiering.csv"');
            res.send(toCsv(model));
        })));
}

/** Swaps the collector for tests; `null` restores the real one. */
function _setRunner(fn) {
    runCollectorImpl = fn || runCollector;
}

module.exports = { register, _setRunner };
