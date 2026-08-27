# Deploy

Clones a git branch and serves it as a site, with an optional sandboxed build.

## 0.2.0

Deploy sets itself up on the host. Installing it now creates the sandbox
accounts, their ACLs and their firewall rules, and works out which subnets to
deny by looking at the interfaces that carry the domain instead of asking. When
an administrator clicks "Finish setup on this host" on the extension card, the
application runtime is switched on: the two environment variables the service
needs are written into its own environment, and the restart notice says so.

What this replaces: an administrator opening PowerShell, knowing the subnet of
their own Active Directory, and setting two machine environment variables by
hand. Aegis ships to customers who will do none of those three, so the runtime
was a feature only its author could reach.

What it deliberately does not do is turn the runtime on by itself. Installing an
extension is not the same sentence as allowing application code to run on a
server that holds directory audit data, and `DEPLOY-CONTRACT.md` calls that a
change-management decision. The procedure is gone; the decision is a click.

The mechanism is core's and belongs to no version: an extension declares
`provision` in its manifest and owns a prepare phase and an enable phase. Aegis
runs the first at every install and the second when an administrator asks.

`Create-BuildAccounts.ps1` runs again on a real install. It reached
machineStore.js by walking five levels up from itself to a `backend` folder,
which only existed while the extension lived inside the Aegis tree. On an
install the extension is unpacked under ProgramData, so that path resolved to
nothing and the script failed with a Node stack about a missing module, naming
neither itself nor the move that broke it. It now loads the machineStore sitting
beside it, which needs no node_modules and no path into the Aegis install.

This is the script that creates the sandbox accounts, so until now the node
runtime could not be enabled on any install that took Deploy from the store.

The generated account password no longer travels as an argument to `node`, where
anyone able to list processes could read it, but through the environment of that
one call.

## 0.1.0

The extension now ships from the extension repository rather than from the Aegis
tree. Its source, its tests and its release are all in one place, and the package a
store install downloads is built from that source by CI rather than zipped by hand
from the core repository.

What this changes for an install: the code arrives by installing Deploy from the
store, and the host opt-in is granted by that install rather than by anything the
Aegis installer does. A new Aegis starts with no extensions at all.

A site behind the directory now tells the application it serves who is reading
it. The proxy sets `X-Aegis-User`, `X-Aegis-Name` and `X-Aegis-Groups` from the
session the access guard already holds, and removes any header of those names
that came from the client, on every site. Until now a protected project was
guarded without ever learning the visitor's identity, so anything with roles of
its own had to ask for a second login in front of the first. Open sites receive
none of the three, and the values are percent-encoded so that a name the
directory spells with an accent cannot fail the request. `DEPLOY-CONTRACT.md`,
section `Who the request is from`, is where the names are fixed.

Projects get a database of their own. A project can name a SQLite file inside
its `data/` folder and a migrations directory beside it; Deploy plays the
migrations between the code and the process, in name order, and records what it
played in a registry table so a rerun does not replay them. The Data tab reads
the tables back, and a cell can be edited in place. A write that is refused now
says which of the reasons it was, instead of failing silently: a static project
has no process to write with, and a read-only reader cannot be talked into one.

The page says where the data folder is, because an operator restoring a backup
had no way to find it from the interface.

Project settings validate offline. Saving a repository URL no longer calls
GitHub, so a settings change on a machine that cannot reach it stops failing for
a reason that has nothing to do with what was typed.

A GitHub App can be registered on an install with no public host, which is what
every LAN deployment is.

`Create-BuildAccounts.ps1 -WithPython` grants each sandbox account read and
execute on a machine-wide Python, so a project whose install or start command is
Python can be deployed. Opt-in, never write, and it refuses outright when the
only Python on the host is a per-user install: an ACL on that path succeeds and
unblocks nothing, which is the worst of both answers.

## 0.0.0

First store release. Until it, the extension reached a customer inside the Aegis
application copy, with no version of its own; publishing it here gives it an update
cadence separate from the dashboard's.
