# Deploy

Clones a git branch and serves it as a site, with an optional sandboxed build.

## 0.1.3

Three things a deployment said about itself were not true.

**The rail said a deployment was running after it had finished.** A first
deployment showed "1 running" beside a console whose five stages were all green,
and kept showing it for as long as the page stayed open, so the one number that
says whether anything is happening contradicted everything next to it. The page
counted runs by project id, and a first deployment starts recording before its
repository has been parsed: its entry went in under an empty id, became a real
id one poll later, and the removal then looked for something that was no longer
there. Runs are counted by run id now, which never changes. Two more holes went
with it: the count only ever moved while a build console was open, so leaving one
mid-build or reloading the page left it frozen, and it is reconciled against
`/api/deploy/runs` every five seconds when no console is watching.

**A deployment reported migrations it had not played.** A project with no
migrations printed "cette version d Aegis ne sait pas jouer de migration" on
every deployment, which is alarming and was about nothing: nothing was skipped
because there was nothing to skip. Worse, a project that did carry migrations on
an Aegis too old to play them printed the same line and published anyway. A
version whose code expects a column that does not exist answers the health
check, passes every stage in green, and fails on the first request from a user,
which is the most expensive failure in the sequence because the proxy has
already moved. A check nobody can perform is a failure, not a remark: the
deployment is now refused, the previous version goes back on the port, and the
message names what to do on the host. A project with no migrations says nothing
at all, and one whose schema is already current says so.

Migrations also have a stage on the console. They never had one: `migrate` was
missing from the list of stages, so the call that would have moved it matched
nothing and returned. Migrations ran, or did not, with no box either way.

**A commit that could not build was redeployed forever.** The sweep retried on a
backoff that spaced the attempts out and stopped nothing, so a branch pushed on a
Friday spent the weekend cloning, running the build account and failing, and
filed a console for each attempt. One project on a live install had eight
consecutive identical refusals and would have had a ninth. The backoff was doing
what it was written for; what was missing is that a refusal about what a
repository contains does not become right by being run again. A commit now gets
three attempts, counted against the commit rather than against the project, and
the block clears itself on the next push because that is a different commit.
Failures that are not the commit's fault are unaffected: an unreachable GitHub
still retries on the backoff alone, and a deployment an operator cancelled counts
for nothing.

Deploy and Redeploy never go through the sweep, so a commit it has given up on
can still be deployed by hand at any time. The card says when that is the
situation, because one that has been given up on otherwise looks exactly like one
about to be tried again.

A GitHub App registration belongs to one tenant instead of to the machine.

It was stored once per host, which on a host with several tenants meant any
tenant administrator could list another tenant's GitHub installations and mint a
token that clones its private repositories. What the tenants share is the
callback URL, and that already carries the slug in its path; the credential
never had to be shared with it. Every route now reads and writes the
registration under `req.tenant.slug`, and the poller resolves one per tenant
inside its sweep rather than holding one for the whole pass.

Upgrading moves an existing registration rather than dropping it. On the
single-tenant host, which is what an Aegis install normally is, there is exactly
one candidate and it is handed over at the next boot. On a host with several
there is no record of who registered it, so it is set aside under
`githubAppUnattributed` in the machine store, no tenant can read it, and each
registers its own App from the Deploy page. Guessing the owner would have been
the leak this change closes.

The page now says what to do rather than what is true. The empty Projects pane
used to offer "Connect GitHub" whether or not GitHub was connected, so an
operator who had just finished connecting it landed on an empty grid pointing
back at the screen they came from; once an App is registered it offers "Deploy a
repository" with the four steps of a first deployment above it. The one-click
card lists what the button is about to do, including the two things a reader
cannot guess: the App name is unique across the whole of GitHub and stays
editable on GitHub's own form, and installing the App on repositories is a
separate step without which the repository list stays empty. The by-hand
instructions name the exact address for a personal account and for an
organisation, say that the choice is final, and say which box to untick and why.

## 0.1.1

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
