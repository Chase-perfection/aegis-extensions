# Network Inventory

Hosts and services discovered on the network.

## 0.1.0

You choose the account the scan reads the network with.

Until now the scan ran as the Aegis service. On a standard install that is the
system account, which reaches other servers as the machine itself
(`DOMAIN\HOST$`), and a DHCP server refuses that account: the report said
"access denied" and the scopes stayed empty.

The page now carries a gear beside **Relancer le scan**, and a line naming the
account in use. The dialog asks for the account, its Windows password and your
own Aegis password. From the next scan on, DHCP, the directory and DNS are read
as that account.

- **One account per organisation**, separate from the account the audit runs as.
  It can be the same one, or a directory account made for this and holding only
  read rights, for example membership of "DHCP Users" on the DHCP server.
- **Nothing restarts.** The scan keeps the service's identity on the Aegis host
  and presents the chosen account to remote servers only, the way
  `runas /netonly` does.
- **Tester les accès** runs the directory, DHCP and DNS reads without the ping
  sweep and lists what each one answered, so a missing right shows in seconds.
- **A refusal names the account to grant.** The diagnostic report used to name
  the local identity; it now names the account the server actually saw.
- **Revenir à l'identité du service** drops the account and restores the
  previous behaviour.

The password is checked with a network logon before it is saved, then stored
encrypted under the Aegis data folder (`network-inventory\scan-accounts.json`),
outside every organisation's own folder. It is never written to a command line
or a log. Five refused Windows passwords lock the form for ten minutes.

Changing the account needs an Aegis newer than 1.0.8. On an older one the
dialog says so and the scan works as before. The texts of this dialog are in
French only for now.

The Secondary Logon service (`seclogon`) must not be disabled on the Aegis
host: Windows starts the scan through it. The report says so when it is.

## 0.0.1

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
