# Plugging an extension into Aegis

What you need to know before writing one, in the order you will hit it. The
catalogue rules live in [CONTRACT.md](CONTRACT.md) and the release procedure in
[PUBLISHING.md](PUBLISHING.md). This file is the part that is easy to get wrong.

## The shape

An extension is a folder with `extension.json` at its root. Aegis unpacks it
into `C:\ProgramData\Aegis\extensions\<id>` and requires it from there, once, at
boot. Nothing of yours lives in the Aegis tree, and an extension that reaches
into it with a relative require is a bug on both sides.

```
extensions/<id>/
  extension.json          the manifest, at the root of the zip
  backend/routes.js       your register(), named by "backend"
  frontend/pages/<id>.html
  backend/tests/          yours, and excluded from the package
  store.json              catalogue metadata, excluded from the package
  CHANGELOG.md            becomes the release notes, excluded from the package
```

## The manifest

Ten fields decide whether your extension loads. Seven of them fail loudly.

| Field | What it does |
|---|---|
| `id` | Must equal the folder name. A mismatch refuses the load |
| `version` | Integer. The manifest contract, not your release number |
| `release` | Semver. Compared against the signed manifest at install |
| `page` | Bare filename ending in `.html`, served from `frontend/pages/` |
| `routePrefixes` | Each starts with `/api/` and does not end in `/` |
| `backend` | Path to the file exporting `register()` |
| `provision` | Optional `.ps1`, see below |
| `prerequisites` | Optional list of host tools, see below |
| `requiresHostOptIn` | Boolean. Says a second switch exists |
| `labelKey` / `descKey` / `icon` | Navigation and store card |

`release` is the field that bites. `extensionInstaller` compares it with the
version in the signed manifest and refuses `release_mismatch` when they differ,
at the last step, after the package has already been downloaded. Bump it in the
same commit as the tag. Since 2026-08-27 the release workflow refuses a tag the
manifest contradicts, so the failure now costs you a red CI run instead of a
release nobody can install.

## What core gives you, and what it never does

Node resolves your requires against your own folder, so you cannot reach
`backend/node_modules` and should not try. Everything you cannot build yourself
arrives in the deps object that `server.js` passes to `register()`:
`requireRole`, `pathsFor`, `tenantsRoot`, `readOnlyDb`, `resolveChrome`,
`writableDb`.

Adding a capability means adding a key there and naming it in
[CONTRACT.md](CONTRACT.md). Traffic stays one way: core never calls into an
extension.

## Two switches, and only one is yours

A tenant admin enables your extension for their tenant. That is the first
switch, and the store page owns it.

The second is the host opt-in, and it exists when your manifest says
`requiresHostOptIn: true`. The variable is `AEGIS_<ID>_ENABLED`, with a dash
becoming an underscore, and the install grants it for you. Choosing to install
an extension is the permission, so `extensionInstallService` writes it into the
Aegis service's own environment block and the operator does nothing.

Write it there and nowhere else. The SCM caches the machine environment at boot,
so `setx /M` plus a service restart does not reach the backend, and only a full
reboot would. `hostOptIn.setVars` writes `AppEnvironmentExtra` under
`HKLM:\SYSTEM\CurrentControlSet\Services\AegisBackend\Parameters`, which NSSM
re-reads on every service start.

## When your extension needs more than a variable

Deploy needed restricted local accounts, an ACL and a firewall rule per account,
and two environment variables naming them. The instruction for that used to be a
PowerShell script, an AD subnet the operator had to look up, and two
`SetEnvironmentVariable` calls. No customer was ever going to follow it.

Declare `"provision": "backend/setup/YourScript.ps1"` and Aegis runs it for you,
as the service, which on a real install is LocalSystem. Two phases:

```powershell
param([ValidateSet('prepare','enable','remove')][string]$Phase)
```

`prepare` runs at every install and every update, of your extension from the
store and of Aegis itself by `Aegis-Setup.exe`. Create what you need on the host
and leave your feature off. Be idempotent: an update runs it again.

`enable` runs when an administrator clicks **Finish setup on this host** on your
card, or ticks the matching box in the Aegis installer. It may be the first
phase to run on a host, so create what is missing rather than refuse. Print one
line of JSON anywhere in your output and Aegis writes it into the service
environment:

```
{"env":{"AEGIS_YOURID_RUNTIME":"1","AEGIS_YOURID_ACCOUNTS":"a,b"}}
```

Everything else you print goes to the install log, so talk to the operator
freely. The last `env` line wins. Only `AEGIS_*` names that core does not own are
accepted by the installer, and a failure belongs on stdout: the last line printed
is what the administrator reads. The full list of what the installer checks
before it runs you is in [PUBLISHING.md](PUBLISHING.md), section 1b.

`remove` runs when an administrator deletes your extension from the server
(**Delete from this server**, in the card's details). It runs first, while your
files still exist, and undoes what the other two phases did on the host: the
accounts, the rules, any folder of yours outside
`tenants/<slug>/data/extensions/<id>` (that one, your code and your ledger line
are core's to delete). Find what you delete by a mark you wrote on it, never by
a name pattern. Print `{"env":{"AEGIS_YOURID_RUNTIME":null}}` to clear the
variables `enable` set; a value other than `null` is ignored. Exit non-zero only
when deleting would leave the host worse off (Deploy refuses while a site it
cannot stop is still running): core then deletes nothing. A script without a
`remove` phase is still removable; only its host changes stay behind.

You never write the service environment yourself. One implementation of that
registry write exists, it is tested, and it stays that way however many
extensions come later.

Three refusals to expect: a path climbing out of your folder, anything that is
not a `.ps1`, and a script that is not in the package. The manifest is signed,
so your path arrives trusted, but a path is not a promise and this runs as
LocalSystem.

### Host tools: `prerequisites`

Declare the tools your extension needs on the server, in `extension.json` and
in `store.json`:

```json
"prerequisites": [{ "id": "git", "required": true }, { "id": "python", "version": "3.13.1" }]
```

Core looks for an all-users copy of each before the package is downloaded and
shows the result in the store drawer. A per-user copy or the Store app does not
count: the service runs as LocalSystem. Required tools are always installed;
optional ones are ticked by default when missing.

Core installs nothing itself. It runs your provisioning script with
`-Phase prerequisites -Prerequisites git,python` (one comma-joined string),
before `prepare`, for up to 15 minutes, and streams what you print into the
install log. Print one line `{"prerequisites":[{"id","status","version","path","error"}]}`
at the end. Pin every installer by version and SHA-256, and refuse on a
mismatch. Deploy's `backend/build/setup/Prerequisites.ps1` is the reference.

A package whose script predates the phase has none: core reads the refused
parameter as "no such step", not as a failure.

## The dev loop

Point the install folder at your working copy with a junction, once, elevated:

```powershell
New-Item -ItemType Junction -Path 'C:\ProgramData\Aegis\extensions\deploy' `
         -Target 'C:\...\4.6-Aegis.extensions\extensions\deploy'
```

An absolute target is required. After that, a manifest or backend change needs a
backend restart because discovery runs at require time. A frontend file is read
per request, so a refresh is enough.

The loader follows the link on purpose. `readdir` reports a junction as a link
rather than a directory, and filtering on `isDirectory()` alone found nothing,
silently. Do not harden that filter back: the folder is administrator-only and
its contents get required into the backend, so a link in it was placed by
somebody who could already run code as the service.

## Tests

Your suite lives in your repo and your CI runs it. `npm test` at the root of
`aegis-extensions` runs every extension's `backend/tests/`, and the release
workflow refuses to publish on red.

Four frontend tests need an Aegis checkout on disk and skip on the runner, so a
green release run says nothing about whether your pages still render. Set
`AEGIS_TREE` and run them locally before you tag.

Core keeps one test about the seam rather than about any extension:
`backend/tests/extensionLoader.test.js` plants a fixture extension in a temp
`AEGIS_DATA_ROOT` and drives discovery, collision refusal and the module
registry through it.

## Shipping it

Tag `<id>-v<semver>` and the workflow builds the zip, checks nothing forbidden is
in it, writes the manifest and leaves a draft release. On the machine that holds
the release key, `node scripts/publish-release.mjs <tag>` signs the manifest and
publishes the draft, and the workflow rewrites the catalogue on `main` from what
was published. The key never goes to GitHub: [PUBLISHING.md](PUBLISHING.md) says
why, and what to do when a step refuses.

## What an operator sees when it works

Store page, **Install**, then a service restart. If your manifest declares
`provision`, the install log shows what your prepare phase said, line by line.
If it declares one and your feature needs turning on, the card offers **Finish
setup on this host**, and the restart notice appears once.

No PowerShell, no subnet, no environment variable. That is the bar, and it is
the reason half of this file exists.
