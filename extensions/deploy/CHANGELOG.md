# Deploy

Clones a git branch and serves it as a site, with an optional sandboxed build.

## 0.1.6

Making a site reachable is a click on a card and a field in a pane, not two
environment variables and a service restart.

0.1.5 opened the port. It also asked whoever installed Deploy to open PowerShell
as an administrator, know the notation Windows expects for a subnet, set two
machine environment variables and restart the service, which is the same
sentence Deploy's own setup script was written to delete for the application
runtime. Shipping a feature that only its author can turn on is shipping it to
one person.

**The switch is written by Finish setup on this host.** The button on the Deploy
card in the extension store already runs the extension's setup step as the
service and writes what it asks for; `AEGIS_DEPLOY_FIREWALL=1` now rides along
with it. Nothing is typed and no core code learns that an extension called
Deploy exists: the script says what it needs and core writes it, which is what
`hostOptIn.setVars` was generalised for.

It rides along rather than getting a decision of its own because it is not one.
A site binds `0.0.0.0` whatever the answer is, so the rule grants no reach that
creating the project did not already ask for. It stops the packets from being
dropped on the way to a listener that is already there. Withholding it produces
the most expensive failure in the product: a site that is up, correct, and
reported by every browser as a timeout, because a firewall drops in silence
where a closed port would have answered with a reset.

**Which networks is a real decision, and it has a screen.** The Domains pane now
opens with whether sites are reachable and from where. Three states, and each
says what to do: no firewall for Aegis to drive, which is the normal answer
behind a reverse proxy; reachable from this machine only, with the button to
press; or reachable, with the networks and a field to change them.

The field prints the networks this machine is actually on, read from the
interfaces. Widening a scope is otherwise a guess, and the guess that always
works is `Any`, which is the one nobody should make on a server holding
directory audit data.

**The scope moved out of the environment.** It is stored, and read on every rule
that gets written, so a new VLAN or a site move takes effect when the form is
submitted. As an environment variable it could not: the SCM caches a service's
environment at boot, so changing which network may reach a site meant restarting
the service that serves them. `AEGIS_DEPLOY_FIREWALL_SCOPE` still wins when it
is set, on the same pattern as `AEGIS_PUBLIC_URL`, and the pane then shows the
value and disables the field rather than offering one that would be ignored.

Both refusals still fall towards less reach. The form rejects a value the
firewall would not take, at the point the operator can still see the field, and
a value that somehow reaches the rule writer unusable becomes `LocalSubnet`. A
typo must not be the reason a site becomes visible from somewhere nobody
intended.

## 0.1.5

A deployed site is reachable from the other machines on the network, which is
what deploying it was for.

**It was not, and nothing said so.** `siteServer` binds `0.0.0.0` on purpose,
with a comment saying a site is reached from other machines. On Windows that is
half of it: the listener is up, and the host firewall drops the packets before
they arrive. Aegis opened exactly one port ever, 3000, in
`start-dashboard.ps1`, and no site's. The symptom is the worst kind, because it
looks like the wrong thing: a browser reports a timeout, not a refusal, so a
site that is running and correctly configured reads as a site that is down.
A closed port answers with a reset and says "nothing here"; a firewall says
nothing at all.

With `AEGIS_DEPLOY_FIREWALL=1` Deploy now opens one inbound TCP rule per
project, on the port that project was actually given. Created when the site
starts, removed when the project is deleted, including when a preview ages out
of the expiry sweep, and the whole set reconciled against the records at every
boot. That last one is not redundancy: nothing fires for a project deleted while
the service was stopped, and a rule left behind is a port open on a host with no
project left to explain it.

One port, never the range. The first shape this took was a single rule over
3081-3180, which is ninety-nine ports opened for one site, and still wrong the
day `AEGIS_SITES_PORT_BASE` moves.

**Off unless the host says so.** The switch is read from the service's
environment and reachable from no browser, exactly like `AEGIS_DEPLOY_ENABLED`
and `AEGIS_DEPLOY_RUNTIME`. Opening a port because a tenant administrator
clicked New Project is a privilege the extension would be granting itself, on a
machine holding AD audit data. Unlike `AEGIS_DEPLOY_ENABLED`, installing the
extension does not write this one: it is a change-management decision about a
server, not a consequence of clicking Install.

**`LocalSubnet` by default, not `Any`.** It is the Windows primitive for the
networks the machine is actually on, so there is no subnet arithmetic here to
get wrong and the default stays correct on a host that is not yours.
`AEGIS_DEPLOY_FIREWALL_SCOPE` takes an address, a CIDR block, a range or a list
for a domain that spans subnets. A value Windows would not take falls back to
`LocalSubnet` rather than to something wider: a typo must never be the reason a
site becomes reachable from more places than anybody meant. Profiles are Domain
and Private, because `Public` is the profile a machine uses on a network it does
not trust, and reaching it takes naming it.

**A firewall call never fails a deployment.** The site comes up either way, and
a refusal is logged with the reason and with the command to run by hand. A site
that is up and unreachable is a problem an operator can see and fix in a minute;
a deployment rolled back because a firewall call timed out is one they cannot.

None of it runs anywhere but Windows. Behind a reverse proxy or a load balancer
the local firewall is not the door, and there is nothing here to do.

## 0.1.4

A site can name the people who may sign in, and one of them as its
administrator.

**Groups were the only way to say who gets in.** A group is a standing rule the
directory already maintains, which is the right answer when one exists and the
wrong one when it does not: naming three colleagues meant asking a domain
administrator for a group, or leaving the site open to everybody the directory
authenticates. Named people are now a second allow list beside the groups.
Either one being satisfied opens the site.

They are matched on `objectSid` and not on a login or a DN. It is the only
identifier that survives a rename and a move between OUs, so an account that
changes desk keeps its access and an account that is deleted and recreated does
not inherit it. `objectSid` is now read on every login rather than only when
nested groups are switched on, and the picker in the Authentication pane
searches the directory rather than asking anybody to type a SID.

There is a case that fails closed and is worth knowing. When the directory is
configured with a user DN template, a login binds directly and reads the
account's entry best effort, so a directory that refuses that read returns no
SID. If people are named on the site, that login is refused rather than falling
through to the group rule, and the log says the SID was missing rather than
saying the person was not on the list. Those are two different problems and they
send an administrator to two different places.

**Who gets in is now stored instead of being inferred from an empty field.**
An empty group list used to mean "anyone the directory authenticates". That was
deliberate and documented, and it stopped working the moment a second list
existed: an operator who names one person to make them the administrator has not
said that nobody else may enter, and an operator who names nobody has not said
that everybody may. A site now carries the answer as a choice, `directory` or
`listed`, and the pane asks it above the two lists that qualify it.

Nothing migrates. A record written before this release is read under the old
rule exactly: groups named means those groups, none named means the directory.
Every existing project keeps the access it has until somebody changes it on
purpose. What is gone is the shape that used to be indistinguishable from an
open site, `listed` with both lists empty, which is now closed.

**A site is told who is reading it, so it can manage its own roles.** Aegis says
two things and stops there:

    GET /__aegis/whoami
    { "authenticated": true, "login": "PV", "name": "Paul Vue",
      "sid": "S-1-5-21-...-1103", "admin": true }

The administrator is designated in Aegis, once, when the project is set up. What
that person may then do is the application's business: it reads this endpoint,
sees `admin`, and builds whatever access console it wants. The alternative was an
access panel per deployed application, living in Aegis and edited in Aegis every
time an application changed its mind about roles, and the point of stopping here
is that Deploy does not accumulate one product's permission model.

Traffic stays one way, as everywhere else in the extension seam. The site reads
a fact and can write nothing back. The endpoint answers `no-store`, because a
cached answer is a stale role and a shared cache would hand one visitor's
identity to the next. It is served on protected sites only: an unprotected site
answers 404 on the whole reserved prefix, which is the honest answer, since there
is no directory identity behind one. An application reads any non-200 as "no
Aegis identity here".

A group can never confer `admin`. "Whoever is in this group administers the site"
is a promotion nobody reviews, so the flag is carried by a named person or by no
one. Demotion takes effect on the group revalidation timer rather than at the end
of the session: unticking the box says something about now.

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
