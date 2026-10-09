/**
 * The DHCP view's own routes: the list of servers an operator declared.
 *
 * What the scan read off those servers does not have a route here. It travels
 * with the rest of the inventory in `GET /api/inventory/network`, as its `dhcp`
 * block, because the subnet cards need it too: a card can only say "no scope
 * here" once it knows every server answered.
 *
 * Reading the list is open to whoever can open the page; changing it is admin
 * only. A declared name is where the next scan will present the scan account,
 * so it is not something a reader should be able to point elsewhere.
 */

'use strict';

const dhcpSettings = require('./dhcpSettings');

function register(router, context) {
    const { requireRole } = context;
    const activity = typeof context.recordActivity === 'function' ? context.recordActivity : () => {};

    router.get('/api/inventory/dhcp/servers', (req, res) => {
        res.json({ success: true, servers: dhcpSettings.read(req.tenantPaths.data).dhcpServers });
    });

    router.put('/api/inventory/dhcp/servers', requireRole('admin'), (req, res) => {
        const body = req.body || {};
        const { names, rejected } = dhcpSettings.normalizeServers(body.servers);
        // All or nothing: saving the valid half would leave the operator
        // believing the server they mistyped is being read.
        if (rejected.length) {
            return res.status(400).json({ success: false, code: 'EBADSERVER', rejected });
        }
        if (names.length > dhcpSettings.MAX_SERVERS) {
            return res.status(400).json({ success: false, code: 'ETOOMANY', max: dhcpSettings.MAX_SERVERS });
        }
        try {
            const saved = dhcpSettings.saveServers(req.tenantPaths.data, names);
            activity(req, 'config', 'inventory.dhcp.servers', {
                system: 'Network Inventory', event: 'inventory.dhcp.servers', details: saved.dhcpServers.join(', ') || null
            });
            res.json({ success: true, servers: saved.dhcpServers });
        } catch (e) {
            console.error('[Inventory DHCP servers]', e);
            res.status(500).json({ success: false, code: 'ESAVE' });
        }
    });
}

module.exports = { register };
