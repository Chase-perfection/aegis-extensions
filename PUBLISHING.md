# Publishing an extension release

One tag. `.github/workflows/release.yml` builds the package from this repository's
`extensions/<id>/`, signs the manifest with the key held as a repository secret,
publishes the three assets, and rebuilds `index.json` on main.

So this document is about deciding what to release, not about assembling it. The
steps below are what a human does; the sections marked **the workflow** say what
happens after the tag lands, because a release you cannot follow is a release you
cannot debug.

Nothing in this repository ever holds the private key. If you find yourself pasting
a `.pem` here, stop.

## 0. What the catalogue promises

`index.json` carries `schemaVersion: 2`, and
`backend/src/services/storeService.js` refuses any other number outright rather
than reading fields off a shape it does not know. That constant is a contract with
that file: raising it here without raising it there blanks the store page for every
install.

Schema 2 asks two things of `extensions/<id>/store.json` that a release does not
provide:

- `category`, one of `Detection`, `Inventory`, `Compliance`, `Integrations`,
  `Automation`. The store page has no rail to file the card under without it, so
  the backend drops an entry naming anything else. `build-index.mjs` fails the
  build instead of publishing something invisible.
- `file`, the package name, which `build-index.mjs` derives and
  `make-manifest.mjs` writes into the signed manifest. `extensionInstaller`
  compares the two and refuses the install when they disagree, which is why one
  helper produces both.

## 1. Pick the version

Semver, in `store.json`. An extension's first release is `0.0.0`, which says the
thing is published and not yet promised to be stable. From there raise the patch for
a fix, the minor for a feature, the major when a tenant has to do something on
upgrade.

This number is unrelated to the integer `version` in `extension.json`, which only
changes when the manifest contract changes. It is **not** unrelated to `release` in
that same file: set it to the version you picked, in the same commit. An install
compares it with the signed manifest and refuses `release_mismatch` when they
disagree, so a stale field publishes assets that every install downloads and then
rejects. The workflow refuses the tag rather than letting you find out that way.

## 2. Write the changelog, then tag

`extensions/<id>/CHANGELOG.md` becomes the release notes verbatim, so write it
before tagging rather than editing the release afterwards. Rename its `Unreleased`
heading to the version you picked in step 1: what is under that heading is what the
release is.

```bash
git tag deploy-v1.0.0
git push origin deploy-v1.0.0
```

That is the publish. `<id>-v<version>`, matching the `agent-v<version>` shape on
`aegis-releases`. The tag is refused if the id names no folder, if the version is
not semver, or if the suite fails: nothing is uploaded before `npm test` passes,
because a release is three assets somebody has already downloaded by the time you
read a red run.

That gate has a hole worth knowing before you lean on it. The browser tier under
`extensions/<id>/frontend/tests/` skips on the runner, which has no Aegis checkout,
so a green release run says nothing about whether the extension's pages still
render. Run those locally with `AEGIS_TREE` set before you tag. See
[README.md](README.md), "The four that need Aegis on disk".

`workflow_dispatch` takes the same tag as an input, for re-running a release whose
workflow failed after the tag was pushed.

## 3. What the workflow does with it

Worth reading once, so a failure names something you recognise.

**Builds the package** from `extensions/<id>/`, with `zip -r -x`. The zip root holds
what that folder holds: `extension.json` at the top, then `backend/` and
`frontend/`. No wrapping folder, since the loader reads `extension.json` at the root
of the unpacked directory. Out: `backend/tests/`, `store.json`, `CHANGELOG.md`,
`card.png` and any `CLAUDE.md`. The first three belong to this repository rather
than to the package; the card image is served from `main`, so fixing a crop costs no
release.

**Checks the package against that list** by reading the names back out of the zip.
An exclusion pattern that quietly matched nothing would put an extension's tests on
a customer's audit server, so the build fails rather than trusting the pattern.

**Writes the manifest** with `scripts/make-manifest.mjs`, which reads
`manifestVersion` and `minAppVersion` out of `store.json` and computes the size and
the digest from the zip it just built. Those bytes are final: the signature covers
them exactly as written, and reindenting the file afterwards invalidates it.

**Signs it** with the Aegis release key, the one `backend/src/lib/releaseKey.js`
already carries the public half of: detached RSA-SHA256, base64. The private half is
the repository secret `RELEASE_SIGNING_KEY`, which a human sets once, in the
repository settings, to the PEM including its BEGIN and END lines. Unset, the
workflow refuses: an unsigned release is one every install rejects at step 2 of
**Trust model** in [CONTRACT.md](CONTRACT.md), which is worse than no release. The
signature is verified against the key's own public half before upload, which proves
it is well formed over those bytes; only a real install proves the key is the one
the field trusts, so check a first release against one before the catalogue points
at it.

**Cuts the release** with the three assets, named exactly as
`scripts/build-index.mjs` derives them, and marks it a prerelease when `store.json`
says `channel: preview`.

**Rebuilds the catalogue** on `main`: it reads the size and digest back out of the
published manifest, writes the `latest` block and the `releases` entry into
`extensions/<id>/store.json`, runs `build-index.mjs` and then
`validate-catalog.mjs`, and commits both files. Read back from the release rather
than carried over from the build, so what the catalogue describes is what somebody
can actually download.

That commit is the only writer of `index.json`. `catalog.yml` is the reader: it
validates the catalogue on every push and fetches every referenced asset, this
commit's push included. So the release is checked twice by two workflows that
cannot disagree about who owns the file.

## 4. If it fails

| Where | What it means |
|---|---|
| Read the tag | The id names no `extensions/<id>/` folder, or the version is not semver. Delete the tag and push a correct one |
| Run the suite | The release is not ready. Nothing was uploaded |
| Refuse a package carrying what must not ship | A `-x` pattern stopped matching, usually because a file moved. Fix the pattern, delete the tag, tag again |
| Sign the manifest | `RELEASE_SIGNING_KEY` is unset or is not a usable private key. Set it, then re-run from `workflow_dispatch` |
| Cut the release | A release for that tag already exists. Delete it before re-running |
| Rebuild and validate the catalogue | The validator disagrees with the generated `index.json`. Its output names the field |
| Commit the catalogue | Branch protection on `main` refuses a push from Actions. Either allow it, or apply the same three commands locally: `build-index.mjs`, `validate-catalog.mjs`, commit |

A tag is cheap to redo. Delete it on both sides (`git tag -d`, `git push --delete
origin <tag>`), delete any release it created, and push it again.

Aegis picks the new version up on its next catalogue poll.

## Yanking a release

Delete the GitHub release, drop the `latest` block back to the previous version in
`store.json`, run `node scripts/build-index.mjs` and `node
scripts/validate-catalog.mjs`, then push. By hand, because a yank is a decision and
there is no tag to hang it on. Installs already on disk stay where they are: the
catalogue describes what a backend can fetch, not what it runs.
