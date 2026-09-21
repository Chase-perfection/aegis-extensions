# Network Inventory

Hosts and services discovered on the network.

## 0.0.0

The subnet explorer leaves Aegis core and becomes an extension you install.

What you get: the Network Inventory page, the sweep behind it
(`scan/network_scan.ps1`, ping, ARP, DNS A and PTR, DHCP scopes and leases, CIDR
filing), the DHCP failover resolver that decides which server speaks for a
shared scope, and the diagnostic report that names the source which refused
rather than showing an empty table.

`minAppVersion` is 1.0.7 because core carried this module until then. On an
earlier core the loader finds the id already registered and ignores the
extension, so the store hides this entry rather than offering an install that
does nothing.

**Upgrading to Aegis 1.0.7 removes the Network Inventory page until you install
it here.** Your scan history survives: it has always been one JSON file per
tenant, `inventory_history.json`, and it does not move. Install the extension
and the page reads the same file.

Auditing DHCP does not depend on this extension. Shield still checks which DHCP
servers the domain authorizes, and still reports a rogue one, with no extension
installed.
