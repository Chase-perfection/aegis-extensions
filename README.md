# Aegis extension store

The catalogue Aegis reads to discover extensions and to notice new versions of the
ones a tenant already runs. This repository holds metadata and signed release
artifacts. It holds no extension source: each extension is developed where it
lives today, inside the Aegis tree under `extensions/<id>/`, and is published here
as a zip.

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
index.json                     the catalogue Aegis fetches
catalog.schema.json            JSON Schema for index.json
CONTRACT.md                    field contract, versioning, trust model
PUBLISHING.md                  how to cut an extension release
extensions/<id>/store.json     source metadata for one extension
extensions/<id>/CHANGELOG.md   operator-facing history
extensions/deploy/             git clone, sandboxed build, site serving
extensions/mitre/              ATT&CK coverage and mapping
extensions/network-inventory/  discovered hosts and services
extensions/parc/               persistent IT asset registry
scripts/build-index.mjs        regenerates index.json from the store.json files
scripts/validate-catalog.mjs   checks the catalogue before it ships
```

`index.json` is generated. Edit `extensions/<id>/store.json`, then let CI rebuild
the catalogue, or run `node scripts/build-index.mjs` yourself.

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

Create `extensions/<id>/store.json`, where `<id>` matches both the folder name and
the `id` in the extension's own `extension.json`. Aegis refuses a manifest whose id
and folder disagree, so the store keeps the same rule. Read
[CONTRACT.md](CONTRACT.md) for the fields, then [PUBLISHING.md](PUBLISHING.md) for
the release steps.
