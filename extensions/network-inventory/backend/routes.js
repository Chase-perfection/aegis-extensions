/**
 * The two routes behind the Network Inventory page.
 *
 * Both lived in `backend/src/server.js` under `// --- Inventory ---` until this
 * extension took them. The bodies are the same code; what changed is where the
 * scan script sits and where the three core helpers come from.
 *
 * `network_scan.ps1` used to be resolved as `../../shield/network_scan.ps1`,
 * relative to core's `src/`. It now ships inside this package, under `scan/`,
 * and resolves against `__dirname`. An installed extension lives in
 * `C:\ProgramData\Aegis\extensions\network-inventory\`, so nothing here may
 * reach back into the Aegis tree: see CONTRACT.md, "What an extension may
 * import". The script is ours, so it travels with us.
 *
 * Storage did not move. The inventory is one JSON file per tenant,
 * `<tenantPaths.data>/inventory_history.json`, and `pathsFor(slug)` built the
 * path before this extension existed. A tenant who had the module in core keeps
 * their history when they install it from the store, with no migration, because
 * the file never moved.
 */

'use strict';

const path = require('path');
const { execFile } = require('child_process');

const inventoryService = require('./inventoryService');
const scanAccount = require('./scanAccount');
const accountRoutes = require('./accountRoutes');

/** The scan script, inside this package rather than in core's `shield/`. */
const SCRIPT_PATH = path.join(__dirname, 'scan', 'network_scan.ps1');

/**
 * A stderr tail long enough to diagnose a failed scan and short enough to read.
 *
 * A PowerShell stack trace runs for pages, and this ends up in a dialog someone
 * has to read.
 */
const STDERR_KEEP = 40;

/**
 * Three capabilities core hands over, each optional.
 *
 * `minAppVersion` in store.json already refuses an install on a core that
 * predates them, so this is not the version guard. It is what keeps a missing
 * key from turning a working scan into a 500: an operator loses the live log
 * and the progress bar, and still gets their inventory. CONTRACT.md asks for a
 * refused feature rather than a broken extension, and for these three the
 * feature is the feedback, not the scan.
 */
function feedbackFrom(context) {
    const log = typeof context.broadcastLog === 'function'
        ? context.broadcastLog
        : () => {};
    const event = typeof context.broadcastAuditEvent === 'function'
        ? context.broadcastAuditEvent
        : () => {};
    const activity = typeof context.recordActivity === 'function'
        ? context.recordActivity
        : () => {};
    return { log, event, activity };
}

/**
 * Runs the scan script and resolves its stdout, streaming PROGRESS lines and
 * log text as it goes.
 *
 * With `creds` it goes through scan/Start-NetOnly.ps1, so every network read is
 * made as the tenant's scan account; without, straight to powershell.exe as the
 * service, which is what the scan has always done. A launcher that Windows
 * refused to start rejects with `err.netOnly = { win32, message }`.
 */
function runScript({ slug, domain, probeOnly, creds, log, event, stderrLines }) {
    return new Promise((resolve, reject) => {
        let file = 'powershell.exe';
        let args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH];
        let options = { maxBuffer: 10 * 1024 * 1024 };
        if (creds) {
            const l = scanAccount.launch(creds, { domain, probeOnly });
            file = l.file;
            args = l.args;
            options = { ...options, env: l.env, windowsHide: true };
        } else {
            if (domain) args.push('-Domain', domain);
            if (probeOnly) args.push('-ProbeOnly');
        }

        // powershell.exe, not pwsh. The scan targets Windows PowerShell
        // 5.1 and shield/CLAUDE.md records why: the 5.1 parser, the
        // ibm850 stdout encoding and the BOM this script needs are all
        // part of the contract it was tested against.
        const child = execFile(file, args, options, (err, stdout, stderr) => {
            if (err) {
                const refused = creds ? scanAccount.launcherError(stderr) : null;
                if (refused) err.netOnly = refused;
                return reject(err);
            }
            resolve(stdout);
        });

        child.stderr.on('data', (data) => {
            const text = data.toString().trim();
            if (text) {
                if (stderrLines.length < STDERR_KEEP) stderrLines.push(text);
                log(slug, text);
            }
        });
        child.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                const trimmed = line.trim();
                if (!trimmed) return;
                const progressMatch = trimmed.match(/^PROGRESS:(\d+)$/);
                if (progressMatch) {
                    event(slug, { scan_progress: parseInt(progressMatch[1], 10) });
                    return;
                }
                if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
                    log(slug, trimmed);
                }
            });
        });
    });
}

/** The last line of the script's output that holds JSON, or ''. */
function lastJsonLine(stdout) {
    const lines = String(stdout || '').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i].trim();
        if (l.startsWith('[') || l.startsWith('{')) return l;
    }
    return '';
}

/**
 * The tenant's scan account, ready to launch with, or a diagnostic saying why
 * the scan must not run. `{ creds: null }` when none is set: the service runs it.
 *
 * A saved account whose password no longer decrypts refuses the scan instead of
 * falling back to the service identity: the operator chose who reads the
 * network, and a scan made by someone else would be both a surprise and a
 * misleading report.
 */
function scanCredentials(slug) {
    const creds = scanAccount.credentials(slug);
    if (!creds) return { creds: null };
    if (creds.password === null) {
        return {
            refused: {
                source: 'Compte du scan',
                status: 'failed',
                message: `Le mot de passe enregistré pour ${creds.account} ne peut plus être déchiffré : le scan n'a pas été lancé.`,
                hint: "La clé de chiffrement de cette machine a changé. Saisir de nouveau le mot de passe du compte du scan, ou revenir à l'identité du service.",
                command: 'PUT /api/inventory/account'
            }
        };
    }
    return { creds };
}

/** A diagnostic for a launcher Windows refused to start, by Windows error code. */
function launcherDiagnostic(account, refused) {
    const hints = {
        1314: "Le service Aegis n'a pas le privilège « Emprunter l'identité d'un client après authentification ». Le compte système et les comptes de service l'ont par défaut.",
        1058: "Le service « Ouverture de session secondaire » (seclogon) est désactivé sur cette machine. Le repasser en démarrage manuel.",
        1326: `Le mot de passe de ${account} a été refusé.`,
        1331: `Le compte ${account} est désactivé.`
    };
    return {
        source: 'Compte du scan',
        status: 'failed',
        message: `Windows a refusé de lancer le scan avec le compte ${account}.`,
        hint: hints[refused.win32] || 'Vérifier le compte du scan, puis relancer.',
        command: 'Start-NetOnly.ps1',
        detail: `Erreur Windows ${refused.win32} : ${refused.message}`
    };
}

function register(router, context) {
    const { requireRole } = context;
    const { log, event, activity } = feedbackFrom(context);

    accountRoutes.register(router, context, { runScript, lastJsonLine, scanCredentials, launcherDiagnostic, log, event });

    router.get('/api/inventory/network', (req, res) => {
        try {
            const historyFile = path.join(req.tenantPaths.data, 'inventory_history.json');
            res.json({ success: true, ...inventoryService.getConsolidatedInventory(historyFile) });
        } catch (e) {
            console.error('[Inventory API Error]', e);
            res.status(500).json({
                success: false,
                error: 'Failed to retrieve inventory',
                diagnostics: [{
                    source: 'Backend',
                    status: 'failed',
                    message: "L'inventaire enregistre n'a pas pu etre relu.",
                    hint: "Le fichier inventory_history.json du locataire est peut-etre corrompu. Relancer un scan le reecrit entierement.",
                    command: 'GET /api/inventory/network',
                    detail: String(e && e.message ? e.message : e)
                }]
            });
        }
    });

    router.post('/api/inventory/scan', requireRole('admin'), async (req, res) => {
        const { domain } = req.body;
        const slug = req.tenant.slug;
        const historyFile = path.join(req.tenantPaths.data, 'inventory_history.json');

        // Kept for the failure report: when the scan dies before emitting its
        // JSON, this is the only account of what went wrong the operator will
        // ever get.
        const stderrLines = [];

        const { creds, refused } = scanCredentials(slug);
        if (refused) {
            return res.status(409).json({ success: false, code: 'ESCANACCOUNT', error: refused.message, diagnostics: [refused] });
        }
        if (creds && domain && !scanAccount.SCAN_DOMAIN.test(String(domain))) {
            return res.status(400).json({ success: false, code: 'EBADDOMAIN', error: 'Nom de domaine invalide.' });
        }

        try {
            log(slug, creds
                ? `Starting standalone Network Inventory scan as ${creds.account}...`
                : 'Starting standalone Network Inventory scan...');

            const result = await runScript({ slug, domain, creds, log, event, stderrLines });
            const jsonLine = lastJsonLine(result);

            activity(req, 'audit', 'scan', {
                system: 'Shield', event: 'audit.scan', details: domain || null
            });

            if (jsonLine) {
                // The enriched scan emits { ips, subnets, diagnostics }; a legacy
                // scan emits a flat array. updateInventory accepts either, so
                // pass it untouched.
                const scanData = JSON.parse(jsonLine);
                const ipCount = Array.isArray(scanData)
                    ? scanData.length
                    : (Array.isArray(scanData.ips) ? scanData.ips.length : 0);
                log(slug, `Scan found ${ipCount} IP addresses.`);
                res.json({ success: true, ...inventoryService.updateInventory(scanData, historyFile) });
            } else {
                // The script ran to the end and printed no payload at all. Not an
                // empty network: a scan that failed without saying so, which is
                // the silence this report exists to break.
                log(slug, 'No IPs found by scan script.');
                res.json({
                    success: false,
                    error: "Le scan n'a produit aucun resultat.",
                    diagnostics: [{
                        source: 'Scan',
                        status: 'failed',
                        message: "Le script de scan s'est termine sans emettre d'inventaire. L'affichage montre le resultat du scan precedent.",
                        hint: "Verifier que PowerShell peut executer le script de scan de l'extension sur cette machine et que la strategie d'execution ne le bloque pas.",
                        command: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${SCRIPT_PATH}`,
                        detail: stderrLines.join(' | ')
                    }]
                });
            }
        } catch (e) {
            console.error('[Inventory Scan Error]', e);
            if (e && e.netOnly && creds) {
                const d = launcherDiagnostic(creds.account, e.netOnly);
                return res.status(500).json({ success: false, error: d.message, diagnostics: [d] });
            }
            // The scan could not be launched, or died mid-run. Answer with a
            // report of the same shape as a successful scan's, so the dialog has
            // one code path.
            res.status(500).json({
                success: false,
                error: e.message,
                diagnostics: [{
                    source: 'Scan',
                    status: 'failed',
                    message: "Le script de scan n'a pas pu etre execute jusqu'au bout.",
                    hint: `Verifier que powershell.exe est accessible au service Aegis, que ${SCRIPT_PATH} est present, et que le compte du service peut le lire.`,
                    command: 'POST /api/inventory/scan',
                    detail: [String(e && e.message ? e.message : e)].concat(stderrLines).join(' | ')
                }]
            });
        }
    });
}

module.exports = { register, SCRIPT_PATH, lastJsonLine };
