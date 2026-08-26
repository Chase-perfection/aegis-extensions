# What Aegis Deploy serves, and what a repository must contain

Aegis clones one branch and serves it. What that means depends on the project:
files by default, or a process it starts and proxies to when the project has a
start command and the host allows one.

The default is still the strict one. A project with no install and no build
command has nothing executed from its repository, and the branch it points at has
to hold a finished site already.

That single sentence is the contract. Everything below is the detail behind it,
including the exact acceptance test, every refusal code, and what to change in a
repository that builds its front end.

The reason for the restriction is not laziness. Aegis runs on a domain's audit
server, as SYSTEM on an installed Windows host. `npm ci` executes lifecycle
scripts from the whole dependency tree, so running a build as that user would
hand SYSTEM to whoever compromises any transitive package.

As of the build sandbox pool (`docs/superpowers/specs/2026-08-18-deploy-build-sandbox-design.md`),
a project can declare an install and build command: they run in a restricted,
low-privilege local Windows account, capped by a Job Object and firewalled off
the domain, never as the backend's own SYSTEM user. No Docker, no WSL2 -- both
are unavailable on this host. A project that declares no build command is
still only cloned and served, exactly as before.

## Preconditions on the Aegis host

| Requirement | How to satisfy it |
|---|---|
| `AEGIS_DEPLOY_ENABLED=1` | Written for you, by the install. `lib/hostOptIn.grant` writes it into the Aegis service's own environment when you install Deploy from the store, and it applies from the next service restart. There is no option to tick and no flag to pass: choosing to install the extension is the permission. `Aegis-Setup.exe` grants nothing here, and re-running it changes nothing: it stages `backend`, `frontend`, `scripts` and `shield`, and no extensions at all. Not `setx` either: the SCM caches a service's environment at boot, so `setx /M` plus a service restart does not reach the backend. `start-dashboard.ps1` sets it to `1` for its own window and needs nothing from you, because that script already refuses to run unelevated: export `AEGIS_DEPLOY_ENABLED=0` in the shell first to keep Deploy off there |
| Deploy module enabled for the tenant | Extension store, Deploy card |
| Caller is a tenant admin | `requireRole('admin')` guards every mutating route |
| `git` on the PATH | `git --version` |
| Outbound HTTPS to github.com | No inbound access is needed |
| A free port from 3081 up | `AEGIS_SITES_PORT_BASE` moves the range, 100 ports wide |

## Access to the repository

A public repository needs nothing. Aegis clones it anonymously and polls it
without credentials.

A private repository needs the GitHub App installed on it, with `contents: read`
and `metadata: read`. Aegis resolves which installation can see the repository
through `GET /repos/{owner}/{repo}/installation`, so nobody has to pick an
account.

## What you give Aegis

| Field | Required | Notes |
|---|---|---|
| Repository URL | yes | Address bar, clone URL, SSH remote, or `owner/repo` |
| Branch | no | Defaults to the repository's default branch |
| Subfolder | no | Path inside the branch that holds the site |
| Name | no | Defaults to the repository name |

## What Aegis does with it

1. Parses the URL to `owner/repo`, refusing anything that is not github.com.
2. Finds the installation that can see the repository, or falls back to
   anonymous access.
3. Reads the default branch when you gave no branch.
4. `git clone --depth 1 --single-branch --branch <branch>` into a staging folder.
5. Picks the served directory: the clone root, or the subfolder you named.
6. Runs the acceptance test below. A refusal stops here, and the previous version
   of the site keeps serving.
7. Deletes `.git`, then renames staging over `current` in one operation.
8. Serves `current` at `/` on the project's own port.
9. Photographs the site's first screen for the project card, from `127.0.0.1`
   on its own port. See **The card thumbnail** below.
10. Polls the branch every 20 seconds. A new head commit repeats steps 4 to 9.

## The card thumbnail

After every deployment, promote and rollback, Aegis loads the site once in a
headless Chromium and writes a PNG to the project's data folder. The project
card shows it; a project with no capture keeps a plain grey plate.

What it photographs is whatever the site answers with, and that includes a
sign-in form. A protected site shows its guard to a visitor, so the guard is
the honest first screen — Aegis does not hold a key that walks past its own
`siteAuth` to photograph the page behind it.

Facts worth knowing before you go looking for a missing thumbnail:

- It uses the browser already on the host — the one core resolves for PDF
  reports, Edge included. No browser is downloaded. On a host with none, every
  card keeps the plate and the backend log says so once.
- The resolver is core's, and arrives through the loader next to `requireRole` and
  `readOnlyDb`. `register` hands it to `backend/shots.js`; nothing here imports it.
  An installed extension sits under `C:\ProgramData\Aegis\extensions\deploy\`,
  from where no relative path reaches the Aegis tree, so an import would be a path
  that works in a checkout and nowhere else.
- puppeteer has to arrive the same way and does not yet. It lives in
  `backend/node_modules`, which a bare specifier does not reach from ProgramData
  either, so a store install finds no driver: every card keeps the plate, with one
  line in the log saying so. The junction used for development does not help,
  because Node resolves through it to the real folder in the extension repository.
  Only a copy still sitting inside an Aegis tree, from before the source moved out
  of it, resolves the module. Closing this is one more key in the object
  `server.js` passes to `register`; `shots.js` already reads it.
- It runs sandboxed, and it renders your build. That is the same code the port
  already serves; it is not given a wider seat than that.
- One capture runs at a time for the whole install, so six projects redeploying
  together do not mean six browsers on a machine that audits AD.
- It photographs the listener that is actually open, not the port on the
  record. Holding a port is not the same as answering on it — a bind that lost
  the port to something else reports on an event rather than by throwing — so
  the capture waits up to five seconds for the site to really be serving and
  gives up with a log line if it never is.
- It never fails a deployment. A browser that will not start, a page that will
  not load inside 15 seconds, a site that never starts listening — each leaves
  the previous picture (or no picture) and is logged.
- It is not on a schedule. A site that changes without a deployment — content
  pulled from an API, a page behind a clock — keeps the thumbnail from its last
  deployment, because that is the last moment Aegis knows something changed.

## The acceptance test

This is the condition. It runs against the served directory, which is the clone
root unless you named a subfolder.

```
index.html present            -> accept
no index.html, source found   -> refuse, needs_build
no index.html, no source      -> refuse, no_index
```

"Source found" means a `package.json`, `Dockerfile`, or `dockerfile` at the root
of the served directory or one level below it. One level, not deeper, so a static
site that vendors a `package.json` somewhere is not misread as a project needing
a build.

The two refusals differ in what you can do about them. `needs_build` means no
folder in that branch holds a finished site, so naming a subfolder will not help.
`no_index` means the branch looks static and is missing its entry point, where
naming a subfolder often is the fix.

## Every refusal, and its fix

| Code | Meaning | Fix |
|---|---|---|
| `bad_repo_url` | Not a github.com repository URL | Paste `https://github.com/owner/repo` |
| `needs_install` | Aegis cannot see the repository | Install the App on it, or check the URL |
| `repo_not_found` | GitHub has no such repository | Check the spelling |
| `bad_branch` | Branch name Aegis will not pass to git | Avoid a leading dash and `..` |
| `needs_build` | The branch holds source, not a site | Publish build output, see below |
| `no_index` | No `index.html` in the served directory | Name the subfolder that holds it |
| `no_root_dir` | That subfolder is not in this branch | Check the path, case included |
| `bad_root_dir` | The subfolder path leaves the repository | Use a path inside the repository |
| `no_free_port` | All 100 site ports are taken | Delete a project or move the range |
| `id_unavailable` | Ninety-nine projects already share the name this one derives | Give the project a different name |
| `unknown_project` | The project was removed while the page was open | Reload the page |
| `bad_site_config` | The `vercel.json` in that branch will not parse | Fix the JSON, or remove the file |
| `deploy_failed` | The clone itself failed, meaning git exited non-zero | Check the branch exists and github.com is reachable |
| `build_failed` | The install or build command exited non-zero | Read its output in the build console |
| `build_account_unconfigured` | The sandbox accounts were never created on this host | Run `backend/build/setup/Create-BuildAccounts.ps1`, or drop the build command |
| `tool_missing` | git or pwsh could not be started | Put both on the PATH of the account Aegis runs as, SYSTEM on an installed host |
| `github_auth_failed` | GitHub refused the App credentials | Reconnect the App, or check it is still installed on the repository |
| `busy` | A deployment of this project is already running | Wait for it, or cancel it from its console |
| `github_unreachable` | Aegis could not reach github.com | Check outbound HTTPS from the host |
| `branch_gone` | The branch or repository disappeared | Recreate it or point the project elsewhere |

## What the served directory must contain

An `index.html` at its root. Beyond that:

**Assets referenced from `/`.** Each project gets its own port and serves from
the root, so `/assets/app.js` resolves. If your build sets a base path such as
`/portail-interne/`, remove it. Vite calls this `base`, Next calls it `basePath`,
and both must be `/`.

**No server.** A static export works. A Node server build does not: server-side
rendering, API routes, and middleware all need a process running the
application, which is phase 4 of the plan and not built.

**No runtime environment variables.** A build that bakes values in at build time
is fine. Anything reading `process.env` when a visitor loads the page is not.

**No secrets.** Everything in the served directory is public to anyone who can
reach the port. That includes a `.env` you committed by accident.

**Deep links resolve to files, unless you say otherwise.** Aegis answers 404 for
a path with no matching file, and serves `index.html` only for a directory that
contains one. A single page application using history routing would 404 on a
refresh of `/dashboard`, so there are two ways to ask for the fallback: tick
"Answer with index.html rather than 404" on the project page, or put a rewrite
in `vercel.json`. Either way the fallback answers only for a path that could be
a route: a missing `/assets/app.js` still answers 404, because HTML returned for
a script is a page that fails with a syntax error instead of a missing file.

## What `vercel.json` can say

A repository can carry the file it would carry on Vercel, and five of its keys
are honoured:

| Key | What Aegis does |
|---|---|
| `cleanUrls` | `/about` serves `about.html`. The `.html` URL is not redirected away |
| `trailingSlash` | `false` redirects `/docs/` to `/docs`, `true` redirects the other way |
| `redirects` | 308 by default, 307 with `permanent: false`, or whatever `statusCode` says |
| `rewrites` | Tried only for a path no file answered, which is where the single-page fallback belongs |
| `headers` | Added to the response for a matching path |

Everything else in the file is a service this server does not run, and it is
reported by name on the deployment (`vercel.json: Aegis does not honour
functions, crons`) rather than dropped in silence. A file that will not parse
refuses the deployment with `bad_site_config`, because a site whose config was
ignored looks exactly like a site whose config was wrong.

A source pattern is an exact path or a path with a trailing wildcard, spelled
`/(.*)`, `/:path*` or `/*`. What the wildcard captured is available in the
destination as `$1`, `:path*` or `:splat`. Named segments (`/blog/:slug`) are
reported as unsupported rather than half-implemented.

Two things a config file cannot do. It cannot reach a file outside the site: a
rewrite destination goes through the same resolver a URL does, and that one
refuses anything outside the served directory. And it cannot set
`X-Content-Type-Options`, `Content-Length`, `Transfer-Encoding` or `Connection`:
the first is the protection that stops a mistyped extension in a repository from
becoming an executable response, and the other three belong to the transport.
Those four are dropped from the rule, and the rest of the rule still applies.

The order for one request: redirects, then the trailing-slash rule, then the
filesystem, then rewrites, then the fallback.

## Your case: `Chase-perfection/portail-interne`

The root of `main` holds `frontend/`, `infra/`, `deploy/`, `docs/`, `scripts/`,
and the blueprint files. No `index.html`, and no `package.json` at the top
either, because it lives in `frontend/`.

So the branch has no finished site anywhere in it. `infra/Dockerfile` builds
`frontend/dist` and nginx serves the result, which is what makes the Coolify
Dockerfile build pack work and what `deploy/README.md` is warning about when it
tells you to avoid the Static pack. Aegis today is that Static pack. The same
warning applies, for the same reason.

Three ways to give Aegis something it can serve.

### Option A: build in GitHub Actions, publish to a branch

Recommended. GitHub already builds in a sandbox, for free, and nothing new
executes on the audit server. Aegis polls the published branch and republishes
within 20 seconds of each build.

Add `.github/workflows/aegis-static.yml`:

```yaml
name: Build static for Aegis

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: frontend/package-lock.json

      - run: npm ci
        working-directory: frontend

      - run: npm run build
        working-directory: frontend

      # The branch holds only the build output, so its root is the site root and
      # Aegis needs no subfolder.
      - uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: frontend/dist
          publish_branch: aegis-static
          force_orphan: true
```

Then in Aegis: repository URL `https://github.com/Chase-perfection/portail-interne`,
branch `aegis-static`, subfolder empty.

Check `frontend/vite.config.*` for a `base` other than `/` before the first
build, and check that `frontend/dist` is what the build actually writes.

### Option B: commit the build output

Build locally, commit `frontend/dist`, and set the subfolder to `frontend/dist`.
It works today with no CI. The cost is a build artifact in the history of a
source branch, and a deploy that shows whatever you last remembered to commit.

### Option C: builds on the Aegis host

WSL2 and Docker Engine on the server, builds in a container, which is the plan's
design. This is a change-management decision about a production server holding
Active Directory audit data, so it belongs in a change request rather than in a
deploy form.

## The build console

Every deployment is recorded while it runs: five stages (clone, install, build,
acceptance test, publish), the output each command printed, and a cursor the
browser polls with. While it runs the record is in memory (`backend/runs.js`),
capped at 500 lines and eight runs per project, because that is where the abort
controller behind Cancel lives.

When it ends it is written to `<tenant>/deploy/runs/<runId>.json`
(`backend/runStore.js`), sixty per tenant, oldest dropped. So a restart no
longer takes the history with it, and opening an old deployment shows the same
page a running one does. A file per run and not a SQLite table because an
extension cannot resolve `backend/node_modules`, where `sqlite3` lives -- the
same constraint that makes the site server `node:http` rather than express.

A deployment the backend process died during leaves no stored record. The
project record still says it never succeeded, which is the part that mattered.

Install and build write to `install.log` and `build.log` inside the sandbox
workspace rather than to stdout, so `build/builder.js` tails those two files
while the sandbox runs. Which file exists is also how the two stages are told
apart.

Cancelling aborts the child process through an `AbortSignal`. The Job Object the
sandbox script creates is set to `KILL_ON_JOB_CLOSE`, so the install or build
process dies with the launcher rather than being orphaned under the restricted
account.

| Route | Answers |
|---|---|
A run is recorded from the first line of the create route, before the
repository URL has been parsed. It has to be: the browser mints the id, opens
the console on it and starts polling before it sends the request, so a run that
came into existence only after the installation lookup and the port allocation
left that console with nothing to show, and with nothing at all when one of
those steps refused. Every refusal is written to the run it belongs to, which is
why `bad_repo_url` reads on the console rather than only in the response.

| `GET /api/deploy/runs` | Every run this tenant has in memory, newest first. `?projectId=` narrows it |
| `GET /api/deploy/runs/:id?after=<n>` | Stages, status, and the log lines after `n`. `resync: true` means the ring dropped lines the caller never saw |
| `POST /api/deploy/runs/:id/cancel` | Aborts a running deployment. Admin only |

`POST /api/deploy/projects` and `.../redeploy` accept a `runId` in the body. The
browser mints it before it sends the request, because those routes answer only
when the deployment is over and the console has to open before that.

## Removing a project

The bin on a project's card, and the Remove button on its page, both run the
same deletion. It asks first, and the question names what goes, because Remove
on its own does not say it: the files on this server, the port, and every
session open on the site.

`DELETE /api/deploy/projects/:id` stops the listener, deletes the record, then
deletes the whole project folder, `current/` and every kept release with it. It also
drops the tenant's cached auth rule for the site, its cached serving config and
fallback switch, every session anyone holds on it, its build consoles, and the
login lockouts recorded against its id. That
last one matters because `idFor` hands a freed id straight to the next project
of the same name, and an inherited lockout would refuse a visitor who never
typed a password there.

Nothing is kept. There is no bin to restore from, and no soft delete: the
project is a clone of a repository that still exists on GitHub plus a port
number, so recreating one is a click. The repository is never touched.

A project with a deployment in flight refuses with `busy` rather than being
deleted underneath it, because a deployment ends by renaming folders onto
`current/` and deleting them mid-rename is how a site ends up half published.
Stop the deployment from its console first.

## Releases and rollback

A project keeps the five versions it published before the one on the port, a
folder per commit under `releases/`. `current/` is the site; a release is a
version waiting to be put back.

`POST /api/deploy/projects/:id/promote` with `{ "sha": "..." }` renames one of
them onto the port. `POST /api/deploy/projects/:id/rollback` does the same to
the most recent one, which is the one-click version of the same action. No
clone, no build, no acceptance test: the content being restored already passed
all three when it was published, and the site keeps its port and its listener.

It is a swap rather than a restore. The version coming off the port becomes a
release, so running it twice returns the project to where it started, and the
disk holds the same set either way.

The branch is left alone. `lastSha` follows the port and `lastSeenSha` records
where the branch was last seen, and the poller compares against the second one:
promoting an older version is not read as a new commit on the next tick, and the
next real push still deploys forward. Before that split, a rollback survived
only because GitHub was answering 304.

Refusals: `bad_release` for a name that is not a commit, `unknown_release` for a
version no longer on disk, `no_previous` for a project that has published one
version at most, `busy` while a deployment of that project is running.

Five and not fifty, because each one is a full copy of a built site on the audit
server's disk. A version nobody promoted in five deployments is one they will
reach for through GitHub instead.

An install upgrading from before this existed keeps its rollback: the `previous/`
folder is filed as a release the first time the project publishes or promotes.

## Environment variables

A project holds up to 50 variables, each value up to 4096 characters. They are
read by the install and build commands and by nothing else, because nothing else
runs: a served site is files on disk, so a variable cannot reach a visitor's
page unless the build baked it in.

Values are write-only. Each one is encrypted with the machine key that already
protects the GitHub App private key, and no route decrypts one back to a
browser. The page shows the name, where it applies and when it changed. A value
nobody remembers gets replaced, not revealed.

A name takes letters, digits and underscore and does not start with a digit.
Four groups of names are refused. `PATH`, `ComSpec`, `SystemRoot`, `windir`,
`TEMP`, `TMP`, `PSModulePath`, `ProgramData` and the user-profile variables,
because a project that sets those chooses which binary its build command
actually runs, which is the restriction the sandbox exists to impose. And
anything starting with `AEGIS_`, which is Aegis's own prefix.

Five are set for every build, and a project can override the first one:

| Name | Value |
|---|---|
| `CI` | `1`. Create React App turns warnings into errors when it is set, and `CI=false` is the documented way out |
| `AEGIS_DEPLOY` | `1` |
| `AEGIS_ENV` | `production` |
| `AEGIS_GIT_COMMIT_SHA` | The commit being built |
| `AEGIS_GIT_BRANCH` | The tracked branch |

`target` is `all`, `production` or `preview`. Previews are not built yet, so a
`preview` variable is stored and read by nothing until they are.

They reach the build the way the sandbox account password does: one JSON blob in
the launcher's own environment, read by `run-sandboxed-build.ps1`, put on the
child's environment block, and removed from the launcher's before any child
starts. Never a command-line argument, which would show in a process listing,
and never a file in the workspace, which would outlive the build.

A saved variable changes nothing until the next build reads it. Redeploy to
apply one now.

| Route | Answers |
|---|---|
| `GET /api/deploy/projects/:id/env` | Names, targets and timestamps. No values, ever |
| `PUT /api/deploy/projects/:id/env` | Upserts a batch of `{ key, value, target }`. Admin only |
| `DELETE /api/deploy/projects/:id/env/:key` | Forgets one. Admin only |

Refusals: `bad_env_key`, `reserved_env_key`, `bad_env_target`,
`env_value_too_long`, `env_too_many`, `unknown_env_key`.

One thing to know before putting a real secret in: a build script that prints
its environment prints it into the build console, and the console is on the
dashboard for anyone with tenant access. That is true of every build system and
it is worth saying once.

## How a site asks who is knocking

Each site in the Authentication pane picks one method. The choice is the site's
own: two sites cloned from the same account can differ, and one of them being
open says nothing about the other.

| Method | What the visitor gets |
|---|---|
| `none` | The files. No gate, which is what a deployed site does by default |
| `ldap` | The login form at `/__aegis/login`, checked against the tenant's directory |

The value is stored on the project record as `auth.method`. `auth.enabled` is
still written next to it, as a mirror of the method rather than as a second
opinion: the project cards, the poller and the preview branches all ask that
field whether a site shows a lock, and a mirror keeps them right without a sweep
through code that has nothing to do with authentication. Nothing reads
`enabled` to decide whether to serve.

Three rules the guard holds, and the reason for each.

**A record with no `method` is read by its boolean.** Every site protected
before the selector existed carries `{ enabled: true }` and no method, and it
reads as `ldap`, because that is what `true` meant. Nothing migrates
`projects.json`; the first save through the pane rewrites it in the new shape
and until then it is read in the old one.

**A method this build cannot serve is refused, never served.** A record naming
something a newer Aegis wrote, or a word typed into `projects.json` by hand,
answers 503 on every path. The tempting reading, "a method I do not recognise
is no method", would publish the very site somebody asked to protect. The
backend log names the value it could not run; the visitor is told only that
sign-in is unavailable.

**An empty method is `none`.** That is what a record carries when it has never
been protected, and reading it as a gate would take down a site that was
working.

`POST /api/deploy/projects/:id/auth` takes `{ method, allowedGroups }` and
whitelists the method against the vocabulary, refusing anything else with
`bad_auth_method`. The pre-selector body, `{ enabled: <boolean> }`, still works
and means what it always did, so a script written against it survives the
upgrade. The page sends **both**, and for the same reason in the other
direction: dashboard assets are files on disk and are new the moment they are
copied, while the backend only picks up a new `routes.js` when its process
restarts. A page ahead of its backend sending `method` alone got
`bad_enabled` on every save; sending the mirror too means the worst case is an
older backend reading a method it does not know as the directory, which asks
for a login rather than publishing the site. `GET /api/deploy/auth` returns the vocabulary in `methods`, which is
what the page builds its selector from rather than a list hardcoded in the
frontend.

Allowed groups belong to the directory. They are stored only under `ldap`, and
the pane hides the field under any other method rather than collecting a list
that nothing would read.

## What a refused sign-in says

A login that fails gets one of three answers, and the status code says which.

| Answer | Status | When |
|---|---|---|
| Incorrect username or password | 401 | The password is wrong, or there is no such account. The same sentence for both |
| The account's own state, named | 401 | The directory refused this account and said why: password expired, must be changed, account disabled, locked out, expired, or not allowed to sign in at this hour or from this machine |
| The directory could not be reached | 502 | Anything else: unreachable, refused the service account, a certificate this server does not trust, a configuration that cannot be run |

The middle row is the one worth explaining. Active Directory answers ten
different situations with the same result code, `invalidCredentials`, and tells
them apart only inside its diagnostic message, as `data <hex>`. Reading all of
them as "wrong password" sent a user whose password had expired to type the same
password again, and their administrator to look for a fault in Aegis. The
directory had answered precisely and immediately; the form threw the answer
away.

Two of those sub-codes stay behind the credentials sentence on purpose. A wrong
password is what that sentence already says. And "there is no such account" is
never passed on: a form that answers differently to a name that exists is an
account enumerator, which is the one sub-code worth losing.

Everything still named confirms the account exists, and that disclosure is made
deliberately. This gate stands in front of a site deployed for the people of one
directory, and telling them their password expired is the reason they came to
the form.

A refusal this build does not recognise falls to the 502, not to the 401. An
unknown code is a fault on Aegis's side of the form, and answering it with
"incorrect username or password" would blame the visitor for it.

The backend log keeps the directory's own sentence whatever it says, so a
sub-code Microsoft adds later is readable there before it is readable here.

## Filling the directory form

The Authentication page protects a deployed site with the same Active Directory
this product audits, which means the domain name has already been typed once,
into the audit. Typing it again is where the typo comes from, and a typo in the
search base is a refusal with no visible cause.

So the page asks first. `GET /api/deploy/auth/suggest`, admin only, answers with
the domain named by the newest readable audit of this tenant, or failing that
the domain this server is joined to (`USERDNSDOMAIN`), or `null` when it knows
neither. From that one name follow four fields: `ldaps://<host>:636`, the
search base as `DC=`-separated labels, `{username}@<domain>` as the direct bind
template, and the Active Directory user filter and group attribute.

`<host>` is a domain controller, not the domain. The route asks DNS for
`_ldap._tcp.dc._msdcs.<domain>` and takes the record the domain says to prefer,
because the certificate that controller presents names the host and not the
domain: suggesting `ldaps://corp.local:636` produced a valid chain rejected on
the name, which is a TLS failure with no useful reading. Port 636 whatever the
record says, since the SRV record advertises plain LDAP on 389 and LDAPS has no
record of its own. A resolver that is slow or silent costs the query and
nothing else; the domain name stands.

The button fills the fields left **empty** and nothing else, so a value you
typed survives it. A first visit to an unconfigured page runs the same thing on
load, which is why the form opens with a proposal rather than blank. Nothing is
saved until you save.

Three things it never guesses: the service account, its password, and the two
checkboxes. `ldaps://` is the suggestion rather than `ldap://` because a bind
password crosses that connection; a controller without a certificate is a
downgrade you make on purpose, after the check says so. And nested group
resolution decides who gets in, so a scan that quietly widened an access rule
would be the wrong kind of helpful.

Only three fields stay on screen: the address, the service account and its
password. The other five, and the certificate validation box, sit under
Advanced, folded. They follow from the domain name and the scan fills them, so
showing eight fields at once asked an operator to audit a form instead of
reading three answers. The page unfolds the block by itself when the search
base is empty, and when a refusal names a field inside it, because a refusal
that points at something invisible is worse than no refusal.

The service account field takes `CORP\svc-aegis`, `svc-aegis@corp.local` or a
full distinguished name. Active Directory accepts all three in a simple bind,
and requiring the DN made the one field nobody remembers the syntax of into the
first one they had to get right.

Saving runs the check. It used to end on "Directory settings saved", which says
nothing about whether the directory answers, and the operator found out at the
next login on a deployed site.

## When the certificate is refused

Aegis validates the controller against this server's own Windows certificate
store, not just the public web's roots: a domain controller presents a
certificate from the organisation's CA, which every domain member already
trusts and which Node consults in no default list.

When that is not enough, the page does not hand out instructions. Three
distinct refusals replace the single `ldap_tls_failed` that used to carry all
of them, because the same advice was right for one and useless for the other
two.

| Code | What happened | What the page offers |
|---|---|---|
| `ldap_tls_untrusted` | The chain reaches no authority this server holds | The certificate, its issuer and its SHA-256 fingerprint, and a button that trusts that authority |
| `ldap_tls_name_mismatch` | The chain is good, the certificate names another host | The name it carries, and a button that corrects the address to it |
| `ldap_tls_expired` | Expired, or not valid yet | The dates. Nothing on this page renews a certificate |
| `ldap_tls_failed` | Anything else | The address and the port, to check by hand |

Two mechanisms sit behind the first row. The trust store is re-read on an
untrusted handshake and the connection retried once, rate-limited to one read
every 30 seconds, which deletes the old instruction to restart Aegis after
installing a CA. And `POST /api/deploy/auth/certificate` connects with
validation off, reads the chain, and closes: it sends no BindRequest, so
looking at a certificate never spends the service account password on the host
presenting it. The anchor's PEM stays on the server.

`POST /api/deploy/auth/trust` takes a fingerprint, never a certificate. It
re-opens the connection, reads the chain again, and pins only if the anchor
still carries the fingerprint that was confirmed; a controller swapped in
between looking and deciding answers `certificate_changed`. Pinned authorities
are stored per tenant next to the directory, capped at 8, and every field shown
about one is derived from its bytes on each read rather than stored beside it.

This is a narrowing, not a widening: `rejectUnauthorized` stays true and one
named authority is added for one tenant's one directory. The old last resort,
unticking certificate validation on the connection that carries the bind
password, is still in the Advanced block and is still the wrong answer.
`DELETE /api/deploy/auth/trust` removes the pins without touching the address,
the base DN or the service account.

## Host names

A project can declare one, and it is an addition to its port rather than a
replacement. The port is bound on this machine so it always works; a name only
works once somebody adds a DNS record or a hosts entry, and Aegis cannot know
whether they have. The project page shows both addresses for that reason.

One shared listener answers by `Host` header, and it is off unless
`AEGIS_SITES_ROUTER_PORT` names a port. A listener nobody asked for is a
listener on an audit server. `AEGIS_SITES_ROUTER_CERT` and
`AEGIS_SITES_ROUTER_KEY` put it on HTTPS with one certificate, which is what a
wildcard certificate for an internal domain is for; a certificate per name
through SNI is the answer the day one host needs its own.

| Requirement | Why |
|---|---|
| Letters, digits, hyphens and dots | The value is compared against a header a client controls |
| No scheme, no port, no path | `https://site.local:3080/x` is a URL, not a host name |
| Free across every tenant on the install | The router holds one map of names for the whole machine, so two tenants declaring the same name would mean one answering under the other's. Refused with `hostname_taken` |

A request whose `Host` nobody claimed gets 404 from the router and never the
first site in the list. A project with no port is not routed either: it has
nothing published, and a 404 from the site reads as a deployment problem rather
than a configuration one.

Still no HSTS, for the reason in `siteServer.js`'s header: the header is scoped
to a host name and ignores the port, and these sites still share a machine with
plain HTTP ones.

`POST /api/deploy/projects/:id/settings` takes `hostname` and `spaFallback`,
either or both. An empty `hostname` clears it, which frees the name.

## Preview deployments

Another branch of the same repository, deployed alongside the live one. A
preview is a project record with a `parentId`, which is what lets it reuse the
port allocation, the listener, the release folders, the build console, the
branch polling and the directory guard rather than growing a second
implementation of each.

What it inherits from its parent: the repository, the installation, the
subfolder, the install and build commands, the single-page fallback, and the
protection rule. Protection is copied into the preview's own record because the
guard reads one record per request, and the parent's protection route writes
through to every preview so a later change is not left behind.

What it does not inherit. A host name, because names are claimed across the
whole install and a branch that lives for a week should not hold one
(`preview_no_hostname`). And production environment variables: a preview build
reads the parent's `preview` and `all` targets, never `production`, so a branch
nobody reviewed is not handed the values the live site runs on.

| Route | Answers |
|---|---|
| `POST /api/deploy/projects/:id/previews` | `{ branch, runId }`. Creates one and deploys it. Admin only |
| `DELETE /api/deploy/projects/:id` | Works on a preview like any project. On a parent, its previews go first |

Refusals: `bad_branch`, `branch_is_production` for the branch the project
already serves, `preview_exists`, `already_preview` for a preview of a preview,
`no_free_port`.

They expire. Seven days with no new commit and no visitor and the preview is
removed: its files, its port, its sessions, its lockouts, its build consoles and
its stored history. The port range is a hundred wide and previews take one per
branch, so a busy repository would fill it in a month otherwise. Visits are
counted in memory, so a backend restart resets that clock -- which errs towards
keeping a preview rather than deleting one somebody is reading. The sweep runs
inside the poll sweep, which already walks every tenant every twenty seconds.

`GET /api/deploy/projects` returns previews nested under their parent rather
than as projects of their own. A repository with six open branches would
otherwise bury the site itself under six cards that are all the same site.

## Choosing a branch

A project tracks one branch. Which one is a choice the operator makes twice: at
creation, and afterwards when the branch that holds the site changes name or the
site moves to another one.

| Route | Answers |
|---|---|
| `GET /api/deploy/github/branches?repo=<owner/name>` | `{ branches: [{ name, sha, protected }], defaultBranch }`. `installation_id` is optional and resolved when absent; a public repository is read with no credential |
| `POST /api/deploy/projects/:id/branch` | `{ branch, runId }`. Writes the branch, then deploys it like a redeploy. Admin only |

The list is a suggestion and never a constraint. Every branch field stays a text
field with a datalist behind it, because the repository whose branches GitHub
will not list is exactly the one whose branch name the operator has to type.
Five pages of a hundred is the cap, same as the repository list.

`POST .../branch` checks the branch against GitHub before it writes. Saving
first and finding out at the clone would leave a record pointing at a branch
that does not exist, and the poller would then report `branch_gone` every twenty
seconds about a name somebody only mistyped. Once written, the poll state goes:
`pollEtag` would answer 304 for a head this record has never seen, and
`lastSeenSha` would be compared against a commit from another branch.

A deployment that fails after the write keeps the new branch. The branch is
real, the build is what broke, and reverting the record would hide which branch
the console is talking about.

Refusals: `bad_branch`, `branch_unchanged`, `branch_is_preview` for a branch one
of the project's own previews already deploys, `preview_branch_fixed` on a
preview, `branch_gone` for a name GitHub does not have, `github_not_connected`
when the record names an installation and no App is registered any more, plus
every refusal a deployment can produce.

Why a preview refuses. Its branch is its identity: the id was derived from it,
the parent lists it by it, and a folder named after a branch it no longer tracks
is a project nobody can reason about. Remove it and deploy the other branch.

## Projects served by a process

The whole document above is about serving files. A project that needs server
rendering, API routes or middleware needs a process running its code on this
machine, and this machine is a domain's audit server. That is why it is behind
two host-level locks and not a form field:

| Lock | Meaning |
|---|---|
| `AEGIS_DEPLOY_RUNTIME=1` | The host allows application processes at all. Set in the service's environment, like `AEGIS_DEPLOY_ENABLED` |
| `AEGIS_RUNTIME_ACCOUNTS` | The restricted local accounts a process may run as, comma separated. Empty means the runtime is off whatever the flag says |

The accounts are separate names from the build pool, created the same way
(`backend/build/setup/Create-BuildAccounts.ps1 -AccountNames aegis-run-01,...`).
A build borrows a slot for two minutes; a running application holds one until its
project is deleted, so sharing the pool would mean one project starving every
build on the install. The count of accounts is the count of projects that can run
a process, and the refusal (`no_runtime_account`) says so.

A project asks for one by having a start command. There is no separate switch:
the command is the reason, and a radio button beside it would be a second way to
say the same thing and a third state when the two disagree.

### What happens on a deployment

Clone, install and build exactly as before. Then, instead of looking for an
`index.html`, Aegis publishes the folder and starts the command in it. The
acceptance test is the application answering: a version that crashes on boot, or
that never listens, is refused, the folder is swapped back, and the version that
was running keeps serving.

Each project gets two internal ports on 127.0.0.1, derived from its site port
(`AEGIS_RUNTIME_PORT_BASE`, 3200 by default). A new version starts on the one the
running version is not using, answers a health check there, becomes the proxy's
target, and only then is the old process killed, five seconds later. So a push
does not take the site down for as long as the application takes to boot.

The process runs under a restricted account inside a Job Object capped at 16
processes and 1 GiB, with `KILL_ON_JOB_CLOSE`: Aegis stops an application by
killing the pwsh that owns the job, and nothing survives it. The account is
granted read and execute on the published folder and nothing else -- it serves
that folder and has no business writing to it.

The application reads `PORT` and `HOST` from its environment, plus `NODE_ENV`
and every variable the project declared. Its output goes to the deployment
console while it starts, which is where a crash on boot explains itself.

### Who the request is from

A site behind the directory (`## How a site asks who is knocking`) already knows
who is reading it. The proxy passes that on, so an application with roles of its
own does not have to put a second login in front of one that has already run.

| Header | Holds |
|---|---|
| `X-Aegis-User` | the account name that was typed at the form, and that the directory answered for |
| `X-Aegis-Name` | the display name the directory returned, or the account name when it returned none |
| `X-Aegis-Groups` | the groups of that account, comma separated, in the order the directory answered |

Four properties, each of which an application is entitled to rely on.

**They arrive only on a protected site.** A project whose access method is
`none` receives none of the three. Not an empty one: absent. A site with no gate
authenticated nobody, and a header an application could read as an anonymous
user would be worse than no header at all.

**They cannot be forged.** Whatever a client sends under these names is removed
before the request is forwarded, on every site, protected or not. So an
application may treat `X-Aegis-User` as the answer of the gate and nothing else.

**They are percent-encoded UTF-8.** Decode before use --
`decodeURIComponent` in Node, `urllib.parse.unquote` in Python. A plain account
name contains nothing to encode and arrives unchanged, which is the common case;
a display name with an accent, or one written in an alphabet a header cannot
carry raw, arrives whole instead of failing the request. It also means no value
out of the directory can inject a header of its own.

**A comma inside a group name is encoded, the separators are not.** So splitting
`X-Aegis-Groups` on `,` and decoding each piece gives back exactly the groups the
directory answered, including a group called `Direction, Finance`.

```js
const user = req.headers['x-aegis-user'];           // absent on an open site
const groups = (req.headers['x-aegis-groups'] || '')
    .split(',').filter(Boolean).map(decodeURIComponent);
```

Group membership is re-checked on a timer and not on every request, so these
values can lag a directory change by up to the revalidation interval. An
application making an authorisation decision that must be immediate has to ask
the directory itself.

These three names are the proxy's public interface. Changing one breaks every
deployed application reading it, so they are fixed here rather than in the code
that writes them.

### What it does not do

No WebSocket upgrade: the proxy forwards requests, not socket upgrades. No
autoscaling and one process per project. No `vercel.json` handling for these
projects, because routing is the application's own job. A request arriving while
no process is running answers 503 and never falls through to the files, since
`current/` for a server-rendered application is its source.

Refusals: `runtime_disabled`, `no_start_cmd`, `no_runtime_account`,
`start_failed` (the command exited before answering), `unhealthy` (nothing
answered within 60 seconds), `runtime_acl_failed`, `bad_site_port`.

Restarting the backend restarts every project's process. A promote or a rollback
restarts the one it moved, because the folder under the application changed.

## What the page looks like

The shape follows Vercel's, because the operator asked for it and because it is
the shape of the thing: an install has projects and a few install-wide concerns,
a project has an overview somebody opens twenty times a day and settings they
touch once.

The rail: Projects, Deployments, Environment variables, Domains, Usage, GitHub
integration, Authentication, Refusal states. The three in the middle are
install-wide views of per-project state and not a second store: the variables
pane draws the same panel the project page does, the domains pane lists where
every site answers by port and by name, and the usage pane counts what runs out
(ports, runtime accounts, releases on disk).

A project page is tabbed, and the tab is in the address: `#project/<id>/env` can
be sent to a colleague. Overview, Deployments, Previews, Variables, Domains,
Settings. A preview gets neither Previews nor Domains, because it can have
neither.

Overview is the production deployment card: address, host name, state, when,
branch and commit, with Visit, Instant rollback and Deploy latest commit beside
it, then the active branches. The thumbnail is a gradient seeded from the project
name and not a screenshot: taking one means running a headless browser against a
repository's page on the audit server, which is a lot of machinery for a picture.

Settings is where the immutable facts are listed and where Remove lives. What a
project was created with -- repository, branch, subfolder, commands -- is read at
creation, so changing one is a new project today. That is a limitation, and the
page says so rather than offering fields that would not take effect.

## Not built yet

Webhook delivery, which needs a public HTTPS address and a webhook secret that
manual App registration does not produce. WebSocket upgrades through the runtime
proxy. More than one process per project.

The order the rest arrives in, and what each one costs, is
`docs/plans/0002-deploy-vercel-parity.md`.

## Where this lives in the code

| Piece | File |
|---|---|
| Acceptance test, clone, atomic publish | `backend/cloner.js` |
| URL parsing, installation lookup, branch head | `backend/github.js` |
| Project records, ports, history | `backend/projectStore.js` |
| One deployment, whatever triggered it | `backend/deployService.js` |
| Branch polling, preview expiry | `backend/poller.js` |
| Previews: expiry, the shared deletion | `backend/previews.js` |
| The site listeners, the host-name router, the runtime proxy | `backend/siteServer.js` |
| Application processes: ports, accounts, the flip | `backend/runtime.js` |
| The sandbox a process runs in | `backend/runtime/run-sandboxed-server.ps1` |
| Routes and refusal codes | `backend/routes.js` |
| Build console: stages, log ring, cancel | `backend/runs.js` |
| Deployment history on disk | `backend/runStore.js` |
| Releases, promote, rollback | `backend/cloner.js` (`swapOnto`, `promote`, `listReleases`) |
| Environment variables | `backend/projectEnv.js` |
| `vercel.json`, redirects, rewrites, headers, the fallback | `backend/siteConfig.js` |
| Getting them into the sandbox | `backend/build/launcher.js`, `backend/build/run-sandboxed-build.ps1` |

## The project's own data

Every folder a project owns is rebuilt by a deployment except one. `current/` is
renamed over by each clone, `staging/` and `build-output/` are cleared before
each one, `releases/` holds copies of past clones. So an application had nowhere
to keep anything, and `data/` is that place.

```
<tenant>/deploy/sites/<project-id>/data/
```

Created when the project's process starts, deleted with the project, and named
in the deletion prompt: a database is a different kind of loss from a copy of a
git branch. A preview gets its own, because its id is its own, which is the
answer we want rather than an accident: a branch nobody reviewed reads the
`preview` and `all` environment targets and never `production`, and the same
sentence applies to its data.

The application is given the path as `AEGIS_DATA_DIR`, injected in
`runtime.spawnSandboxed` beside `PORT`, `HOST` and `NODE_ENV`. **The build never
sees it.** `projectEnv.forBuild` is unchanged and the variable is added in the
runtime spawn instead, because a build runs `npm install` and executes arbitrary
scripts from a branch's whole dependency tree. Putting the variable where only
the runtime spawn reaches it makes that structural rather than a rule somebody
has to remember.

Two ACL grants, not one widened grant. `grantAccess` gives the runtime account
`(OI)(CI)(RX)` on `current/`: it serves that folder and has no business changing
it, because a process that can rewrite what it serves can serve something nobody
deployed. `grantData` gives `(OI)(CI)(M)` on `data/` and nothing else. Modify and
not full control, so the account writes its files and does not rewrite the ACL
that constrains it. The build accounts get neither.

A static project has no process, so nothing on the server writes there. The page
says that rather than showing an empty folder.

### Reading it back

| Route | Answers |
|---|---|
| `GET /api/deploy/projects/:id/data` | The files in the folder: name, bytes, modified, whether it is a database. Plus `writable`, which is whether this project runs a process at all |
| `GET /api/deploy/projects/:id/data/:file` | Tables and views, each with its columns and its row count |
| `GET /api/deploy/projects/:id/data/:file/rows` | `?table=&limit=&offset=&order=&dir=`. One page, 100 rows at most |

Admin only, all three, and each row read is logged with the actor. The
environment routes set the precedent: a project's shape is readable by any
member, its contents are not, and a database is contents.

`sqlite3` does not resolve from an extension, which is the same constraint that
makes the run store a file per run. It is not worked around: the reader lives in
core at `backend/src/lib/readOnlyDb.js` and arrives through the loader, next to
`requireRole`, `pathsFor` and `tenantsRoot`. Traffic stays one way, so ADR 0001
decision 2 holds. (`node:sqlite` would have avoided the question and needs Node
22.5; the installer pins v20.19.1.)

Three locks make it read-only, and they fail independently:

1. The handle is opened `OPEN_READONLY`, so SQLite answers `SQLITE_READONLY` to
   any write whatever the layers above got wrong.
2. **No SQL crosses the wire.** The routes take a table name, a column name and
   a direction. Each identifier is checked against what `sqlite_master` and
   `PRAGMA table_info` return for that file, and one that is not on the list is
   refused before any SQL is built. `LIMIT` and `OFFSET` are bound.
3. The file name is matched against `^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$`,
   resolved, and required to have the project's own `data/` as its parent
   directory. Compared as directories and not by prefix, because a prefix test
   says `<dir>-other/x` is inside `<dir>`. `lstat` refuses a symlink rather than
   following it: Aegis runs as SYSTEM, and the folder is one a deployed
   application writes to.

A BLOB comes back as its size and text past 500 characters as its start, both
tagged rather than turned into a sentence, because a column of real text could
otherwise hold something indistinguishable from the sentence. `null` stays
distinct from the empty string: in a table of data the difference between them is
usually the thing being looked for.

Refusals: `bad_file`, `unknown_file`, `not_a_database`, `unknown_table`,
`bad_order`, `db_busy` when the application holds the file past two seconds, and
`reader_unavailable` on an install whose core predates the capability.

Nothing here writes. An editable grid needs a primary-key story for tables that
have none, and that is a decision worth making on its own rather than smuggling
in behind a read path.
