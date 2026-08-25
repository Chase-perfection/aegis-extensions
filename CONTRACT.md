# Catalogue contract

What every field means, which versions compare against what, and what Aegis
verifies before it loads code. Changing anything here changes what installed
backends accept, so treat it as a wire format.

## Two version numbers, and why they are not the same

An extension carries two numbers that both get called "version". Confusing them
breaks either the loader or the update check.

`extension.json.version` is an **integer**. `backend/src/lib/extensionLoader.js`
validates it with `Number.isInteger(manifest.version) && manifest.version >= 1` and
refuses the extension otherwise. It names the manifest contract the extension is
written against, not the release. The `deploy` extension sits at `1`. Putting
`"1.2.0"` there stops the extension from loading at all.

`store.json.version` is a **semver string**. It names the published artifact and is
the number Aegis compares with `compareSemver` from `backend/src/lib/semver.js` to
decide whether an update exists. It never reaches `extension.json`.

The catalogue carries both: `version` for the release, `manifestVersion` for the
integer. A backend that does not understand `manifestVersion` refuses the entry
rather than guessing.

## Catalogue entry fields

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Lowercase alphanumeric with dashes. Equals the folder name and the `id` in `extension.json`. |
| `name` | string | Display name in the store list. |
| `version` | semver | The published release. Compared with `compareSemver`. |
| `manifestVersion` | integer | Mirrors `extension.json.version`. |
| `minAppVersion` | semver | Lowest Aegis version that can load this release. |
| `labelKey`, `descKey` | string | Translation keys, resolved from `frontend/src/js/translations.js`. The catalogue ships keys, not sentences, so the store page stays translated. |
| `icon` | string | Icon name the nav rail already understands. |
| `page` | string | Bare `.html` filename. No slashes, per the loader. |
| `routePrefixes` | string[] | Every prefix starts with `/api/` and does not end in `/`. |
| `requiresHostOptIn` | boolean | Whether a tenant switching it on is the last step. |
| `size` | integer | Bytes of the zip. Shown before download. |
| `sha256` | hex | Digest of the zip. |
| `download` | url | Release asset holding the zip. |
| `manifest` | url | Release asset holding the signed manifest. |
| `signature` | url | Release asset holding the detached signature. |
| `publishedAt` | ISO 8601 | When this release was cut. |
| `channel` | `stable` or `preview` | A backend on the stable channel ignores `preview` entries. |

`labelKey` and `descKey` matter for a reason worth stating: a catalogue that shipped
English sentences would put untranslated text in a French dashboard. Keys keep the
existing i18n path intact.

## Trust model

Extensions load through `require()` into the backend process, which runs as SYSTEM
on the customer's audit server with Active Directory access, the secrets store, and
every tenant database. An extension is not a skin. It is code at the highest
privilege on the most sensitive machine in the network, so the store verifies before
it installs, not after.

`index.json` is not the trust anchor. CI regenerates it, and anyone who can push to
this repository can change it. The anchor is the per-release signed manifest.

Each release carries three assets:

```
<id>-<version>.zip
<id>-<version>.manifest.json
<id>-<version>.manifest.json.sig
```

The manifest names the id, version, manifestVersion, minAppVersion, size and the
zip's `sha256`. The signature is detached RSA-SHA256 with PKCS#1 padding, base64, over
the exact bytes of the manifest as uploaded. That is the same scheme
`backend/src/lib/releaseKey.js` already verifies for installer and agent releases,
with the same key, so the store needs no new crypto and no second key to protect.

Install order, and every step is a refusal point:

1. Fetch the manifest and its signature.
2. Verify the signature with `verifyReleaseSignature`. A failure stops here.
3. Check `minAppVersion` against the running backend version.
4. Check `manifestVersion` against what this backend supports.
5. Download the zip and compare its SHA-256 against the digest in the verified manifest.
6. Check that no installed extension already claims any of the `routePrefixes`. The loader refuses both sides of a collision, so catching it here keeps a download from disabling a working extension.
7. Unpack, then load.

Reformatting the manifest after signing breaks step 2. The signed bytes are the
uploaded bytes, whitespace included.

## What an extension may import

An extension's backend is `require()`d by `backend/src/lib/extensionLoader.js` into
the Aegis process. Two consequences follow, and between them they settle every
question about imports.

**Node resolves the extension's requires from the extension's own folder.** An
installed extension lives in `C:\ProgramData\Aegis\extensions\<id>\`, so a bare
specifier is looked for in `<id>\node_modules`, then in `extensions\node_modules`,
then up through `ProgramData`, and never in `backend\node_modules`. `sqlite3`,
`puppeteer`, `express` and everything else the backend depends on are therefore out
of reach. A dependency of its own is out of reach too, unless the package ships the
`node_modules` folder holding it.

**A relative path out of the extension reaches nothing.** `require('../../../backend/src/lib/x')`
resolves against `ProgramData`, where there is no Aegis tree. It appears to work
only in a development checkout, where the extension sits inside the repository, and
it is a layering violation there as much as it is a broken path in the field. The
loader is one-way by design (ADR 0001 decision 2: core must never call an
extension), and an extension reaching back into core is that rule failing in the
other direction.

So: **an extension imports its own files and Node's standard library, and nothing
else.** What it cannot build, core hands it.

### What the loader hands over

`register(router, context)` and `registerPublic(router, context)` receive core's
capabilities as an object. The keys, from `backend/src/server.js`:

| Key | Phase | What it is |
|---|---|---|
| `extension` | both | The loader's own record of this extension: `id`, `dir`, `root`, `page`, `icon`, `labelKey`, `descKey`, `routePrefixes`, `version`, `release`, `signature`, `requiresHostOptIn`, `frontendDir`, `backendEntry` |
| `resolver` | public | Resolves the tenant from the request. Mounted explicitly, because a public route runs above the session wall and still has to know whose install it is answering for |
| `moduleGate` | public | Refuses the route when the tenant has the module hidden |
| `requireRole` | private | `requireRole('admin')`, the role check every mutating route uses |
| `pathsFor` | private | Tenant-scoped filesystem paths, `pathsFor(slug)` |
| `tenantsRoot` | private | The root every tenant subtree hangs off |
| `readOnlyDb` | private | A read-only SQLite reader, `describe(file)` and `page(file, opts)`. In core because `sqlite3` does not resolve from an extension |
| `resolveChrome` | private | The Chromium the host actually has, for a headless capture. In core because `chromePath.js` reads the install locations of Chrome and Edge, and two copies of that list would drift |

The private phase is mounted below the session wall, so a route registered there
already has a session, a tenant and the module gate behind it.

Reading a key that a given install does not carry is the normal way to meet an
older core. Refuse the one route that needed it, with a code the page has a
sentence for, rather than throwing: a capability the loader has not got yet is a
feature that is unavailable, not an extension that is broken. The loader catches a
throw from `register` and leaves the whole extension inert, which is a much worse
answer to a missing thumbnail.

### Asking for a new one

A capability is added to the object in `server.js` and read off the context. That is
the whole mechanism, and there is deliberately no second one: no host API module, no
plugin SDK, no dependency injection container. An extension that needs something
core has not got yet is a one-line change in core and a read here.

## Publishing a version that nothing can install

`minAppVersion` is the guard against shipping an extension that calls an API the
field does not have yet. Set it to the Aegis version whose backend carries every
interface the extension uses. Aegis hides an entry it cannot satisfy and says why,
rather than offering an install that fails at load.
