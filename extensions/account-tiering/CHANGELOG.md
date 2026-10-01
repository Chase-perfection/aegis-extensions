# Account Tiering

The tier each Active Directory account actually reaches, and how it gets there.

## 0.0.0

First release. Not tagged yet: the collector that reads the directory is still
to be written, and until it ships a scan ends with `collector_failed`.

What you get: the Arbre des comptes page under Parc Management, next to AD
Inventory. For every privileged account it shows the tier it reaches (T0
controls the domain, T1 administers servers, T2 workstations and daily use),
the groups and rights it reaches it through, and the gap with the tier you
planned for it. Three views: a tree you can pan and zoom, a list, and an
overview with the planned against effective matrix and the chokepoints worth
fixing first. An inverted tree answers "who reaches Tier 0?".

You set the planned tier with ordered rules (OU, name pattern, group) and a
manual correction per account, with a mandatory reason. With no rule every
account counts as Tier 2, and the page says so. For each path it proposes the
step that cuts it, as a command to copy or a GPMC section to open. Nothing is
written to Active Directory.

Page and routes are open to tenant administrators only. Results export as CSV
or JSON.

`minAppVersion` is the first Aegis release that hands an extension its own
database (`extensionDb`) and carries the page's translations. On an earlier
core the extension would load without storage, so the store does not offer it
there.
