/**
 * The routes behind "Internal network access" on a project's Settings tab.
 *
 *   POST   .../egress   opens one `address:port` to the project's process.
 *   DELETE .../egress   closes it.
 *
 * Both for a tenant administrator only. What they write is `egress` on the
 * record (`projectEgress.js`), and they are the only callers allowed to: they
 * save with `{ egress: true }`, every other save keeps the field as it is.
 *
 * An address that is not on the approved list is refused once, as
 * `egress_not_approved`, so the page can ask the administrator to confirm.
 * Sent again with `approve: true`, the same request adds the address to the
 * list (`projectStorage.approve`, which records who) and opens it. Nothing has
 * to be run on the server. The command is handed back only when the list
 * cannot be written, the one case where the host is the only way left.
 *
 * A running process is restarted at once, both ways, so an opening takes
 * effect without a push and a closing does not wait for one. The restart is
 * the one every start goes through (`deployService.startCurrent`), which sets
 * the firewall for the account before the new process exists and only moves
 * the proxy once it answers.
 */

'use strict';

const projectStore = require('./projectStore');
const projectStorage = require('./projectStorage');
const projectEgress = require('./projectEgress');
const runtime = require('./runtime');
const deployService = require('./deployService');

function register(router, { requireOptIn, requireRole, projectOr404, startCurrent }) {
    const admin = requireRole('admin');
    const base = '/api/deploy/projects/:id/egress';
    // The suite replaces the start, which would otherwise spawn a process.
    const start = startCurrent || ((args) => deployService.startCurrent(args));

    /**
     * Restarts the process if one is running, so the firewall follows the
     * record now. `next_start` when nothing runs or a deployment holds the
     * project: that deployment's own start reads the new record.
     */
    async function apply(req, project) {
        const slug = req.tenant.slug;
        if (project.runtime !== 'node' || !runtime.isRunning(slug, project.id)) return 'next_start';
        try {
            const held = await deployService.exclusive(slug, project.id, () =>
                start({ slug, tenantPaths: req.tenantPaths, project }));
            return held.busy ? 'next_start' : 'restarted';
        } catch (e) {
            // The previous process keeps serving: `restart` moves the proxy
            // only once the new one answers.
            console.warn(`[Deploy] ${slug}: ${project.id} restart after a network change failed: ${e.message}`);
            return 'restart_failed';
        }
    }

    function save(req, project, egress) {
        const next = Object.assign({}, project);
        if (egress) next.egress = egress;
        else delete next.egress;
        return projectStore.saveProject(req.tenantPaths, next, { egress: true });
    }

    router.post(base, requireOptIn, admin, async (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return undefined;
        if (project.parentId) return res.status(400).json({ success: false, error: 'preview_egress' });

        let target;
        try {
            target = projectEgress.normalise(req.body);
        } catch (e) {
            return res.status(400).json({ success: false, error: e.code, detail: e.message });
        }
        if (projectStorage.mode(project) === 'postgres') {
            return res.status(409).json({ success: false, error: 'egress_with_postgres' });
        }
        if (!projectStorage.isApproved(target.host, target.port)) {
            if (!req.body || req.body.approve !== true) {
                return res.status(409).json({ success: false, error: 'egress_not_approved' });
            }
            const who = (req.user && req.user.email) || null;
            try {
                projectStorage.approve(target.host, target.port, `${who || 'unknown'} (${req.tenant.slug}/${project.id})`);
            } catch (e) {
                console.error(`[Deploy] ${req.tenant.slug}: ${project.id} approval of ${target.host}:${target.port} could not be written: ${e.message}`);
                return res.status(500).json({
                    success: false,
                    error: 'egress_approval_failed',
                    approveCommand: projectStorage.approveCommand(target.host, target.port)
                });
            }
            console.log(`[Deploy] ${req.tenant.slug}: ${project.id} ${target.host}:${target.port} approved on this server by ${who}`);
        }

        let stored;
        try {
            stored = save(req, project, Object.assign({}, target, {
                setAt: Date.now(), setBy: (req.user && req.user.email) || null
            }));
        } catch (e) {
            console.error(`[Deploy] ${req.tenant.slug}: ${project.id} egress write failed: ${e.message}`);
            return res.status(500).json({ success: false, error: 'settings_write_failed' });
        }
        console.log(`[Deploy] ${req.tenant.slug}: ${stored.id} network access to ${target.host}:${target.port} opened by ${req.user && req.user.email}`);

        const applied = await apply(req, stored);
        return res.json({ success: true, egress: projectEgress.publicView(stored), applied });
    });

    router.delete(base, requireOptIn, admin, async (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return undefined;
        if (!projectEgress.of(project)) return res.status(404).json({ success: false, error: 'no_egress' });

        let stored;
        try {
            stored = save(req, project, null);
        } catch (e) {
            console.error(`[Deploy] ${req.tenant.slug}: ${project.id} egress write failed: ${e.message}`);
            return res.status(500).json({ success: false, error: 'settings_write_failed' });
        }
        console.log(`[Deploy] ${req.tenant.slug}: ${stored.id} network access closed by ${req.user && req.user.email}`);

        const applied = await apply(req, stored);
        return res.json({ success: true, egress: null, applied });
    });
}

module.exports = { register };
