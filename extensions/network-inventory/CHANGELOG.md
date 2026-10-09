# Network Inventory

Hosts and services discovered on the network.

## 0.0.4

DHCP scopes appear again, and the page has a DHCP view.

**The scan dropped every scope it read.** It called two helpers from a file it
never loaded. Each call failed as an unknown command, PowerShell carried on, and
the scan threw away every scope while its report said "1 étendue lue". No
network showed a DHCP card, a scope name or a lease. The file is loaded now, a
test checks that the scan loads every helper it calls, and a scope that cannot
be attached to a server is reported instead of skipped.

**The DHCP card says what the scan knows.** A network without a scope used to
read "Aucune étendue DHCP pour ce réseau" whatever had happened. It now says one
of four things: the scope was not read because a server refused or stayed
silent, and which one; every known server answered and none holds a scope for
this network; no DHCP server is known; or the inventory is too old to tell.

**A DHCP view, beside the subnet explorer.** The switch at the top of the
sidebar opens it, and so does "Gérer" on a network's card. It lists every server
the scan tried, read or not, and under each one:

- its scopes, with range, mask, occupancy and lease duration;
- leases, with their state and expiry. A randomised MAC address is flagged, and
  so is a host name that holds several active leases in one scope;
- reservations;
- the address pool: the distributed range and each exclusion;
- the Allow and Deny MAC filter lists, and whether each is enforced.

A server that was not read shows its status and the scan's own explanation. It
is never shown as empty. The view is read only in this release.

**Servers the directory does not list can be declared.** The scan read the
servers authorized in Active Directory and no others, so a standalone Windows
DHCP server could not be read at all. "+ Déclarer" in the DHCP view takes host
names, one per line, admins only. They are read at the next scan with the scan
account, and "Tester les accès" probes them too. A DHCP service held by a
firewall, a router or an access point still cannot be read this way.

**An authorization that points elsewhere is no longer called obsolete.** When
the directory records a DHCP server on one address and its name answers on
another, the report said the server had been decommissioned. It may equally
have been re-addressed and still be serving. The report now gives both cases
and the command for each.

## 0.0.3

The scan account dialog shows its labels. In 0.0.2 the title, the fields and
the buttons read `ni_account_title`, `ni_account_save` and so on: the page
named translation keys that Aegis does not carry, and Aegis prints the key
itself when it has no text for it. The dialog worked, and nobody could tell
what it asked. The labels are now in the page, in French.

## 0.0.2

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
