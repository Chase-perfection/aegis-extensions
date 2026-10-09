/**
 * The scan account routes: show it, set it, drop it, test what it can read.
 *
 * The same shape as the audit page's account form in core (account, its Windows
 * password, the operator's own Aegis password), minus what that one needs and
 * this one does not: no service restart, no "Log on as a service" right, no
 * administrator requirement. See scanAccount.js for why.
 *
 * Every route is admin only. Setting or dropping the account also asks for the
 * operator's Aegis password again, through core's `reauthenticate`: whoever
 * changes the identity the network is read with should prove they are still
 * the one at the keyboard. A core too old to hand that capability over refuses
 * these two routes with ECOREOLD and leaves the scan itself working, as
 * CONTRACT.md asks.
 */

'use strict';

const scanAccount = require('./scanAccount');

function register(router, context, scan) {
    const { requireRole } = context;
    const reauthenticate = typeof context.reauthenticate === 'function' ? context.reauthenticate : null;
    const { runScript, lastJsonLine, scanCredentials, launcherDiagnostic, log, event } = scan;

    router.get('/api/inventory/account', requireRole('admin'), (req, res) => {
        res.json({
            success: true,
            account: scanAccount.describe(req.tenant.slug),
            serviceIdentity: scanAccount.serviceIdentity(),
            canChange: reauthenticate !== null
        });
    });

    router.put('/api/inventory/account', requireRole('admin'), async (req, res) => {
        const slug = req.tenant.slug;
        const body = req.body || {};
        if (!reauthenticate) return res.status(501).json({ success: false, code: 'ECOREOLD' });
        if (scanAccount.isLocked(slug)) return res.status(429).json({ success: false, code: 'ELOCKED' });

        const user = await reauthenticate(req);
        if (!user) return res.status(403).json({ success: false, code: 'EREAUTH' });

        const account = scanAccount.normalize(body.account);
        if (!account) return res.status(400).json({ success: false, code: 'EBADACCOUNT' });

        const checked = await scanAccount.verify(account, body.accountPassword);
        if (!checked.ok) {
            // Only a refused Windows password counts toward the lock: it is the
            // one that would otherwise let this form guess a directory password.
            if (checked.code === 'EBADCRED') scanAccount.recordFailure(slug);
            return res.status(400).json({ success: false, code: checked.code, reason: checked.reason });
        }

        scanAccount.resetFailures(slug);
        scanAccount.save(slug, account, body.accountPassword, user.email || user.username || null);
        res.json({ success: true, account: scanAccount.describe(slug) });
    });

    router.delete('/api/inventory/account', requireRole('admin'), async (req, res) => {
        if (!reauthenticate) return res.status(501).json({ success: false, code: 'ECOREOLD' });
        const user = await reauthenticate(req);
        if (!user) return res.status(403).json({ success: false, code: 'EREAUTH' });
        scanAccount.clear(req.tenant.slug);
        res.json({ success: true, account: null, serviceIdentity: scanAccount.serviceIdentity() });
    });

    /**
     * The scan's directory, DHCP and DNS reads, without the ping sweep, as the
     * account the scan would use right now. The audit page's "check the
     * environment" for this one: it answers "what can this account read"
     * before anyone waits on a full scan to find out.
     */
    router.post('/api/inventory/account/check', requireRole('admin'), async (req, res) => {
        const slug = req.tenant.slug;
        const { creds, refused } = scanCredentials(slug);
        if (refused) return res.status(409).json({ success: false, code: 'ESCANACCOUNT', diagnostics: [refused] });
        const account = creds ? creds.account : scanAccount.serviceIdentity();
        const stderrLines = [];
        try {
            const stdout = await runScript({ slug, probeOnly: true, creds, log, event, stderrLines });
            const line = lastJsonLine(stdout);
            const parsed = line ? JSON.parse(line) : null;
            if (!parsed || !Array.isArray(parsed.diagnostics)) {
                return res.status(500).json({
                    success: false, account,
                    diagnostics: [{
                        source: 'Compte du scan', status: 'failed',
                        message: "Le test des accès s'est terminé sans rapport.",
                        hint: "Le détail ci-dessous vient de la sortie d'erreur du script.",
                        command: 'network_scan.ps1 -ProbeOnly',
                        detail: stderrLines.join(' | ')
                    }]
                });
            }
            res.json({ success: true, account: parsed.account || account, diagnostics: parsed.diagnostics });
        } catch (e) {
            const d = e && e.netOnly && creds
                ? launcherDiagnostic(creds.account, e.netOnly)
                : {
                    source: 'Compte du scan', status: 'failed',
                    message: "Le test des accès n'a pas pu être exécuté jusqu'au bout.",
                    hint: 'Le détail ci-dessous vient de la sortie d\'erreur du script.',
                    command: 'network_scan.ps1 -ProbeOnly',
                    detail: [String(e && e.message ? e.message : e)].concat(stderrLines).join(' | ')
                };
            res.status(500).json({ success: false, account, diagnostics: [d] });
        }
    });
}

module.exports = { register };
