# Putting a site on Deploy

The five-minute version, then an honest account of where Deploy is strong and
where it stops. The full operator contract, every refusal and its fix, is
[DEPLOY-CONTRACT.md](DEPLOY-CONTRACT.md).

## The five minutes

Deploy needs a git branch and somewhere to serve from. You give it a repository
URL and a branch. If the repository already contains the files to serve, that
is all it needs. If it has to build them, you add an install command, a build
command, and the directory the build writes into.

Aegis allocates a port at creation and never moves it, so the URL you hand out
stays put. It clones the branch, runs the build inside a restricted local
account, and serves the result. Then it polls the branch every 20 seconds and
does it again whenever the head commit changes.

A project with a start command is a different animal. Aegis publishes the
folder and starts your command in it, then proxies to it. There is no separate
switch: the command is the reason.

Optional, in rough order of how often you will want it: environment variables,
encrypted at rest; a hostname so the site answers by name through one shared
listener; a TLS certificate, given as paths so a renewal is picked up by a
restart; a `vercel.json` for redirects, rewrites, headers and a single-page
fallback; a login form backed by your directory; a SQLite file and a migrations
directory.

## What it does well

Push to deploy works on a network GitHub cannot reach, and this is the part
that earns its keep. A webhook needs an App registration and a public host, and
a LAN server has neither. The poller costs one conditional request per project
per tick, GitHub answers 304 with no body and no rate-limit charge, and a
project nobody is pushing to is close to free. You push, and twenty seconds
later the site is new.

A build cannot touch the machine. It runs as a restricted local account, scoped
by NTFS ACL to its own workspace, inside a Job Object capped at 16 processes
and 1 GiB, with outbound firewall rules that deny the domain and the private
ranges and allow only 443, 80 and 53. A build that goes wrong takes its own
workspace with it and nothing else.

A version that fails never becomes the live one. For a static project the
acceptance test is an `index.html`. For a process project it is the application
answering on its health check. A new version starts on the port the running one
is not using, answers there, becomes the proxy's target, and only then is the
old process killed, five seconds later. A push does not take the site down for
as long as your application takes to boot.

Rollback is one click and not a redeploy. Five releases are kept, and promote
and rollback move the pointer.

The application knows who is reading it. Behind the directory login, the proxy
sets `X-Aegis-User`, `X-Aegis-Name` and `X-Aegis-Groups`, percent-encoded,
stripped of anything the client sent under those names. An application with
roles of its own does not have to put a second login in front of the first.

Deploy sets itself up. Installing the extension creates the sandbox accounts
and their rules and works out which subnets to deny by looking at the
interfaces that carry the domain. Turning on application processes is a click
on the extension card.

## Where it stops

The login form is not single sign-on. Site authentication is a username, a
password, and an LDAP bind. It is not integrated Windows authentication, so
people type their domain password into a web form. On an intranet that is also
a phishing target that Kerberos removes by construction. KPI Usine keeps IIS in
front for exactly this reason. If your users expect silent sign-on, Deploy's
grid is not the answer.

Without TLS, the honest description is "keeps colleagues out". The session
cookie is `Secure` only on a site actually served over HTTPS, because setting
the flag on a plain-HTTP site would stop login working rather than harden
anything. A site without TLS sends its credentials and its session token in
clear.

Sessions live in memory, so a backend restart logs everyone out of every
protected site. Group membership is re-checked on a timer, not per request, so
somebody removed from an allowed group keeps access until the next check.

Cookies are scoped by host and not by port. Two protected sites on one machine
share the cookie name, so logging into the second replaces the session of the
first. The session record carries the slug and project id and is rejected when
they do not match, which makes this a re-login rather than a way into another
site.

There is no WebSocket upgrade. The proxy forwards requests, not socket
upgrades. Anything that needs a live socket needs something else in front.

One process per project, and no autoscaling. The count of runtime accounts is
the count of projects that can run a process at all. Restarting the backend
restarts every one of them. A request arriving while no process is running gets
a 503 and never falls through to the files, because `current/` for a
server-rendered application is its source and publishing that is worse than
being down.

`vercel.json` does nothing for a process project. Routing is the application's
job there.

Deliberately absent, and not on the roadmap: object storage, image
optimisation, a CDN, a WAF, and a marketplace. Those refusals are argued in
`docs/plans/0002-deploy-vercel-parity.md` in the Aegis repository.

## Choosing between static and a process

Serve files if you can. A static project needs no host switch, no local
account, no health check and no restart discipline, and everything above about
builds, rollback and the poller still applies to it. Reach for a start command
when the application has to run code per request.

## When something is refused

Every refusal has a code and a fix, listed in
[DEPLOY-CONTRACT.md](DEPLOY-CONTRACT.md). The ones you are most likely to meet
first: `runtime_disabled` and `no_runtime_account` mean the host has not been
told to allow application processes, `start_failed` means your command exited
before answering, and `unhealthy` means nothing answered within 60 seconds.
