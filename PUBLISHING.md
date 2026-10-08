# Publishing an extension release

One tag and one command. The tag makes `.github/workflows/release.yml` build the
package from this repository's `extensions/<id>/` and leave a draft release.
`node scripts/publish-release.mjs <tag>`, on the machine that holds the release
key, signs the manifest and publishes the draft; the workflow then rebuilds
`index.json` on main.

Why the signature is not made in CI: the signed manifest is the trust anchor of
every install (**Trust model** in [CONTRACT.md](CONTRACT.md)), and anyone who can
push here can already rewrite the catalogue. A key held as a repository secret would
let them sign too. So the key stays off GitHub, the rule Aegis core keeps for its
installer and agent releases, and publishing takes the repository and the key.

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

## 1b. If the extension declares `provision`

A host setup script runs with administrator rights, from three places, and a
release has to be ready for all three:

| Who runs it | When | Phases |
|---|---|---|
| The backend, as the service | a store install where the operator ticked a missing tool or the extension requires one, and **Install what is missing** in the drawer | `prerequisites`, before `prepare`, async, up to 15 minutes. `Aegis-Setup.exe` never runs it |
| The backend, as the service | the store installs or updates the extension | `prepare` |
| The backend, as the service | an admin clicks **Finish setup on this host** | `enable` |
| `Aegis-Setup.exe` (elevated) | every install and update of Aegis, wizard or `--silent` | `prepare`, then `enable` when the wizard's "Finish their setup on this machine" box is ticked (`--silent` never ticks it) |
| The backend, as the service | an admin deletes the extension (**Delete from this server**) | `remove`, before core deletes the files |

The installer is the reason this section exists. An extension used to reach a
machine without its `prepare` ever running (a reinstall of Aegis, a restored data
folder, an install whose `prepare` failed quietly), and the admin's click then
failed on accounts nobody had created. `installer/Aegis.Setup.Core/ExtensionSetup.cs`
closes that, and it is strict about what it will run. Before tagging, check:

- **`provision` is a relative `.ps1` inside the extension.** Absolute, `..`, or
  another extension: skipped and logged.
- **Everything the script calls is inside the package.** The installer checks the
  permissions of the data root, its `extensions` folder, and every file and folder
  of your extension. An owner, or a write grant, outside SYSTEM, Administrators,
  TrustedInstaller and the account running the installer, and it runs nothing.
  A store install gives you exactly that, so this only bites when the folder
  was put there some other way.
- **No link or junction anywhere in the extension.** Refused for the same reason:
  the permissions read would be the link's, the content somebody else's. The
  developer loop in [README.md](README.md) junctions the working copy into
  `ProgramData`, so on a developer machine the installer skips your extension
  and says why. That is the check working, not a bug: use the dashboard button there.
- **`enable` sets only `AEGIS_*` variables, never one core owns** (`PORT`,
  `AEGIS_ADMIN_PORT`, `AEGIS_DATA_ROOT`, `AEGIS_AUTH_DB_PATH`,
  `PUPPETEER_CACHE_DIR`, the `AEGIS_STORAGE_*` overrides). Anything else is
  refused by name in the install log. Values are strings, one line.
- **`enable` succeeds on a host where `prepare` never ran.** Check what you need,
  and create what is missing instead of refusing: the installer may be the first
  thing to call you, and "reinstall the extension" is not an answer an
  administrator can act on. Deploy's `Provision.ps1` is the reference.
- **A failure is printed on stdout, not thrown.** Both runners keep stdout and
  show its last line to the administrator; stderr is kept by neither the card
  nor the backend. Catch, `Write-Output` the reason, `exit 1`.
- **`remove` undoes only what you made, found by a mark you left on it.** Core
  already deletes your code, `tenants/<slug>/data/extensions/<id>` in every
  tenant, your opt-in variable and your ledger line. Anything else of yours is
  your `remove` phase's job; clear your `enable` variables with `null`. Exiting
  non-zero stops the whole deletion, so do it only when going ahead would harm
  the host. Test it on a VM before tagging: nobody gets a second try at a delete.
- **Five minutes, no input.** Both runners stop the script after that, and stdin
  is closed. Rerunnable, because an update runs it again.
- **Node is on `PATH` and `AEGIS_DATA_ROOT` is set** when the installer runs
  you, pointing where the service keeps its data, so what you store there is what
  the service reads.

The installer never fails an Aegis install on your script: a refusal or an exit
code is logged, and the dashboard button stays the way to retry.

## 2. Write the changelog, then tag

`extensions/<id>/CHANGELOG.md` becomes the release notes verbatim, so write it
before tagging rather than editing the release afterwards. Rename its `Unreleased`
heading to the version you picked in step 1: what is under that heading is what the
release is.

```bash
git tag deploy-v1.0.0
git push origin deploy-v1.0.0
```

`<id>-v<version>`, matching the `agent-v<version>` shape on `aegis-releases`. Tag the
commit on `main` that carries the version, after the pull request is merged: the
workflow refuses a tag whose `extension.json` says another version. The tag is
also refused if the id names no folder, if the version is not semver, or if the
suite fails: nothing is uploaded before `npm test` passes.

The run ends with a **draft** release holding the zip and the manifest, which
neither the catalogue nor any install can see. Then, on the machine that holds the
key:

```bash
node scripts/publish-release.mjs deploy-v1.0.0 --dry-run   # checks and signs, uploads nothing
node scripts/publish-release.mjs deploy-v1.0.0
```

That is the publish. The script reads the private key from the path in
`$AEGIS_AGENT_SIGNING_KEY`, the same variable core's release scripts use, so there
is no second key to protect. It downloads the draft, checks that the manifest
describes that zip and that tag, signs the manifest bytes, and refuses unless the
signature verifies against `scripts/release-public-key.pem`, the public half that
`backend/src/lib/releaseKey.js` carries in core. Then it uploads the signature and
publishes the draft.

That gate has a hole worth knowing before you lean on it. The browser tier under
`extensions/<id>/frontend/tests/` skips on the runner, which has no Aegis checkout,
so a green release run says nothing about whether the extension's pages still
render. Run those locally with `AEGIS_TREE` set before you tag. See
[README.md](README.md), "The six that need Aegis on disk".

`workflow_dispatch` takes the same tag as an input, with a `step`:

- `build` re-runs a build whose workflow failed after the tag was pushed. It builds
  from the tag, not from `main`;
- `catalogue` points the catalogue at a release already published, after checking
  its signature. Needed when publishing did not move the catalogue: GitHub runs the
  `release` event with the workflow file of the tagged commit, so a tag on a commit
  older than that trigger publishes without firing it.

```bash
gh workflow run release.yml -f tag=deploy-v1.0.0 -f step=catalogue
```

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

**Cuts a draft release** with the zip and the manifest, named exactly as
`scripts/build-index.mjs` derives them, and marks it a prerelease when `store.json`
says `channel: preview`. Not signed: that is `publish-release.mjs`, above.

When the draft is published, the workflow runs again on the `release` event (the
script publishes under your own token; one published with the workflow's token
would not fire it).

**Checks the signature** against `scripts/release-public-key.pem` before anything
else. A release somebody published without the key stops here, and the catalogue
never offers it.

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
| Refuse a tag the manifest does not agree with | The tag is on a commit whose `extension.json` says another version, usually a tag pushed before the pull request was merged. Delete the tag, tag the merge commit |
| Cut a draft release | A release for that tag already exists. Delete it before re-running |
| `publish-release.mjs` | It names what it refused: no `$AEGIS_AGENT_SIGNING_KEY`, a draft missing an asset, a manifest that does not match its zip, or a key that is not the trusted one. Nothing is uploaded on a refusal |
| Refuse a release whose signature installs would reject | The published signature does not verify, or the release is still a draft. Unpublish the release (back to draft) and run `publish-release.mjs` again |
| No run after publishing | The tag is on a commit whose `release.yml` predates the `release` trigger. Run the `catalogue` step by hand, above |
| Rebuild and validate the catalogue | The validator disagrees with the generated `index.json`. Its output names the field |
| Commit the catalogue | Branch protection on `main` refuses a push from Actions. Either allow it, or apply the same three commands locally: `build-index.mjs`, `validate-catalog.mjs`, commit |

A tag is cheap to redo. Delete it on both sides (`git tag -d`, `git push --delete
origin <tag>`), delete any release or draft it created, and push it again.

Aegis picks the new version up on its next catalogue poll.

## Yanking a release

Delete the GitHub release, drop the `latest` block back to the previous version in
`store.json`, run `node scripts/build-index.mjs` and `node
scripts/validate-catalog.mjs`, then push. By hand, because a yank is a decision and
there is no tag to hang it on. Installs already on disk stay where they are: the
catalogue describes what a backend can fetch, not what it runs.
