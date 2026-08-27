# Aegis extension store

Where Aegis extensions are written, tested and published. Three things live here:
the source of each extension, the catalogue an Aegis backend reads to discover them
and to notice new versions, and the workflow that turns a tag into a signed
release.

The source used to live in the Aegis tree and the zip was built from there by hand,
which meant an extension was created by editing the core repository and the
published package described bytes nobody could rebuild. An extension developed
inside the thing it extends is not an extension.

The repository is public on purpose. An Aegis backend on a customer server checks
the catalogue over outbound HTTPS with no token and no git, the same reasoning that
makes `aegis-releases` public.

## What Aegis fetches

One file, at a stable URL:

```
https://raw.githubusercontent.com/Chase-perfection/aegis-extensions/main/index.json
```

`index.json` lists every published extension with its newest version, its size, the
digest of its zip, and the URL of the release that carries it. A backend compares
the `version` of each entry against what the tenant has installed and offers the
newer one. `generatedAt` lets the store page tell an operator how fresh the view is.

Discovery and trust are separate. `index.json` says what exists; it is regenerated
by CI and is not what Aegis trusts. Before installing anything, Aegis verifies the
per-release signed manifest described in [CONTRACT.md](CONTRACT.md). A catalogue
entry that points at an artifact whose manifest fails verification is refused.

## Layout

```
index.json                          the catalogue Aegis fetches
catalog.schema.json                 JSON Schema for index.json
CONTRACT.md                         field contract, versioning, trust model,
                                    and what an extension may import
WRITING-AN-EXTENSION.md             how to plug one into Aegis, and the parts
                                    that are easy to get wrong
PUBLISHING.md                       how to cut an extension release
package.json                        the test command. No dependencies
scripts/build-index.mjs             regenerates index.json from the store.json files
scripts/make-manifest.mjs           writes the manifest that gets signed
scripts/validate-catalog.mjs        checks the catalogue before it ships
.github/workflows/test.yml          runs every extension's suite
.github/workflows/release.yml       tag to signed release to catalogue
.github/workflows/catalog.yml       validates the catalogue and fetches its assets

extensions/<id>/extension.json      the manifest the loader reads. Ships
extensions/<id>/backend/            the backend, entry point named by the manifest. Ships
extensions/<id>/backend/tests/      node --test. Does not ship
extensions/<id>/frontend/           pages, css, js. Ships
extensions/<id>/frontend/tests/     puppeteer. Needs AEGIS_TREE. Does not ship
extensions/<id>/store.json          catalogue metadata. Does not ship
extensions/<id>/CHANGELOG.md        operator-facing history, and the release notes
extensions/<id>/card.png            the store card image, served from main

extensions/deploy/                  git clone, sandboxed build, site serving
extensions/mitre/                   ATT&CK coverage and mapping
extensions/network-inventory/       discovered hosts and services
extensions/parc/                    persistent IT asset registry
```

Three of those four are metadata only so far: `deploy` is the one with code.

`index.json` is generated. Edit `extensions/<id>/store.json`, then let CI rebuild
the catalogue, or run `node scripts/build-index.mjs` yourself.

## Tests

```bash
npm test
```

364 tests: 360 that run anywhere, and 4 that need a checkout of Aegis and skip
without one.

`node --test` takes no arguments, so it walks the tree and finds both suites of
every extension, `backend/tests/` and `frontend/tests/` alike. A new extension is
tested the day its folder lands, with no glob to update. Concurrency is pinned to 4
for the reason the Aegis suite pins it, and the version that matters is the one the
installer pins, 20.19.1. CI runs it on Windows, because that is where an Aegis
backend runs and where Deploy's PowerShell sandbox means anything.

There are no dependencies, so there is nothing to install first.

### The four that need Aegis on disk

`extensions/deploy/frontend/tests/` drives the Deploy pages through puppeteer, and
those pages are only half the extension's: the nav, the layout CSS, `app.js` and
`translations.js` come from core, and the browser renders the pair. So the harness
that serves them stays in the Aegis repository, where it is already maintained for
fourteen other pages, and these files reach it through an environment variable:

```bash
AEGIS_TREE=/path/to/aegis npm test
```

Unset, each file skips with the reason and the fix on one line rather than failing
or passing quietly. Two more preconditions get their own line the same way: a path
that is not an Aegis checkout, and a machine with no extension installed. That
second one is the interesting one. The harness serves an extension's frontend from
the data root, `C:\ProgramData\Aegis\extensions\<id>\frontend`, because nothing
ships inside the Aegis tree any more. So the junction that gives you a dev loop is
the same thing that lets these four tests find the page:

```
mklink /J C:\ProgramData\Aegis\extensions\deploy "<repo>\extensions\deploy"
```

That is the junction from **The dev loop** below, not a second one to set up. With
it in place the suite reads 399 tests, 399 passing, nothing skipped. Without it,
364 with 4 skipped, which is what CI sees.

**These four never run in this repository's CI.** The runner has no Aegis checkout
to point at, and the Aegis repository is private, so it cannot clone one without a
token. That is a real coverage gap and it is stated here rather than hidden behind a
green badge: a change to `deploy.js` can break its pages and this repository's CI
will not say so. Until it is closed, run them locally with `AEGIS_TREE` set before
cutting a release.

Closing it needs a pinned submodule of a private repository plus a token in CI,
which is a decision about coupling two release cadences and is deliberately not
made here. **Open question.**

## Working on an extension against a real backend

The loader has one root, `C:\ProgramData\Aegis\extensions`, and discovery runs once
at boot. So a working copy is reached with a junction rather than a copy, and a
change is picked up by restarting the backend rather than by reinstalling anything.

From an elevated `cmd`, once:

```
mklink /J C:\ProgramData\Aegis\extensions\deploy "<repo>\extensions\deploy"
```

A junction and not a symlink: a junction needs no developer mode and no elevation
of its own, and the loader stats through it like any directory. Restart the Aegis
service, and the log says `[Extensions] loaded: deploy@1`.

Two things that bite. `extension.json` is read at boot and never again, so a
manifest change needs a restart even though the file is live. And the host opt-in
is granted by a store install, which a junction is not: `scripts/start-dashboard.ps1`
in the Aegis tree sets `AEGIS_DEPLOY_ENABLED=1` for its own window, which is the
development path for that.

Remove it with `rmdir` (not `rmdir /s`, which would follow the junction into this
repository and delete the source):

```
rmdir C:\ProgramData\Aegis\extensions\deploy
```

## Prepared and published are not the same thing

An `extensions/<id>/` folder whose `store.json` carries `"latest": null` is
prepared, not published. `build-index.mjs` leaves it out of `index.json` on
purpose: emitting it would show an operator a card whose download and signature
do not exist.

Three of the four entries here also still live inside Aegis core, in
`backend/src/config/modules.js`. That file gives an in-tree module the win on an
id collision, so an extension named `mitre`, `network-inventory` or `parc` is
discovered and then ignored with `id already registered in core`. Publishing a
release for one of them therefore takes two steps in order: drop its entry from
the core `MODULES` literal, then cut the release. Doing it the other way round
offers an install that cannot load.

`deploy` has no such conflict: core carries no `deploy` entry, and the one that
appears in the registry at runtime is the extension itself.

## Adding an extension

One folder, `extensions/<id>/`, where `<id>` matches the folder name, the `id` in
`extension.json` and the `id` in `store.json`. Aegis refuses a manifest whose id and
folder disagree, so the store keeps the same rule.

`extension.json` and a backend entry point are the minimum the loader will mount;
`store.json` is what puts it in the catalogue.

Start with [WRITING-AN-EXTENSION.md](WRITING-AN-EXTENSION.md), which walks the
manifest, the deps object, the host opt-in, the provisioning phases and the dev
loop in the order you meet them. [CONTRACT.md](CONTRACT.md) is the field-by-field
reference behind it, and [PUBLISHING.md](PUBLISHING.md) is the release.

No template and no generator. `extensions/deploy/` is the worked example, and it is
the only one so far, so there is nothing yet to abstract from.
