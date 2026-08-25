# Publishing an extension release

Six steps. The zip comes from the Aegis tree, the signature comes from the release
key, and `index.json` is regenerated rather than edited.

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

This number is unrelated to the integer in `extension.json`, which only changes when
the manifest contract changes.

## 2. Build the zip

The zip root holds what `extensions/<id>/` holds in the Aegis tree: `extension.json`
at the top, then `backend/` and `frontend/`. No wrapping folder, since the loader
reads `extension.json` at the root of the unpacked directory.

From the Aegis tree, on Windows:

```powershell
Compress-Archive -Path extensions\deploy\* -DestinationPath deploy-1.0.0.zip -Force
```

Leave out anything that does not ship: `CLAUDE.md`, tests, notes. The same exclusion
list the clean copy uses applies here.

## 3. Write the manifest

```bash
node scripts/make-manifest.mjs deploy 1.0.0 ../deploy-1.0.0.zip
```

The script prints the digest, the size, and the `latest` block to paste into
`store.json`. It writes `deploy-1.0.0.manifest.json` next to the zip.

Do not touch that file again. The signature covers its bytes as written.

## 4. Sign the manifest

Sign with the Aegis release key, the one `backend/src/lib/releaseKey.js` already
carries the public half of. `deploy/Sign-AgentRelease.ps1` in the Aegis tree signs
agent releases with it and takes the same detached RSA-SHA256 form:

```
deploy-1.0.0.manifest.json.sig
```

Base64, detached, over the manifest bytes. Verify locally before uploading:

```bash
node -e "
const {verifyReleaseSignature}=require('<aegis>/backend/src/lib/releaseKey.js');
const fs=require('fs');
console.log(verifyReleaseSignature(fs.readFileSync('deploy-1.0.0.manifest.json'), fs.readFileSync('deploy-1.0.0.manifest.json.sig','utf8')));
"
```

A `false` here means every Aegis install would refuse the release. Fix it now, not
after publishing.

## 5. Cut the release

Tag `<id>-v<version>`, matching the `agent-v<version>` shape on `aegis-releases`.
Three assets, named exactly as `scripts/build-index.mjs` expects:

```bash
gh release create deploy-v1.0.0 \
  deploy-1.0.0.zip \
  deploy-1.0.0.manifest.json \
  deploy-1.0.0.manifest.json.sig \
  --title "Deploy 1.0.0" \
  --notes-file extensions/deploy/CHANGELOG.md
```

Add `--prerelease` for a `preview` channel release.

## 6. Update the catalogue

Paste the `latest` block into `extensions/deploy/store.json`, append the version to
its `releases` array, then:

```bash
node scripts/build-index.mjs
node scripts/validate-catalog.mjs
git add -A && git commit -m "deploy 1.0.0"
git push
```

The validator refuses a hand-edited `index.json`, an asset URL pointing anywhere
other than this repository's releases, and two extensions claiming one `/api/`
prefix. CI runs it again on push and checks that the three assets resolve.

Aegis picks the new version up on its next catalogue poll.

## Yanking a release

Delete the GitHub release, drop the `latest` block back to the previous version in
`store.json`, rebuild, push. Installs already on disk stay where they are: the
catalogue describes what a backend can fetch, not what it runs.
