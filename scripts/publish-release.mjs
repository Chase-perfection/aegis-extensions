#!/usr/bin/env node
// Signs a release that CI built, and publishes it.
//
//   node scripts/publish-release.mjs <id>-v<semver> [--dry-run]
//
// Why this step is not in CI. The signed manifest is the trust anchor of every
// install (CONTRACT.md, Trust model): an extension runs as SYSTEM on the audit
// server, and anyone who can push to this repository can rewrite `index.json`.
// A key held as a repository secret would let that same person sign. So the
// private key never goes to GitHub, the rule Aegis core already keeps for its
// installer and agent releases (`backend/src/lib/releaseKey.js`), and
// publishing takes the repository AND the key.
//
// What happens:
//   1. `release.yml` built the package on the tag and left a DRAFT release with
//      the zip and the manifest;
//   2. this script downloads both, checks the manifest describes that zip and
//      that tag, signs the manifest bytes with the key at the path in
//      $AEGIS_AGENT_SIGNING_KEY, and refuses unless the signature verifies
//      against `scripts/release-public-key.pem`, the key installs trust;
//   3. it uploads the signature and publishes the draft. Publishing fires
//      `release.yml` again, whose `catalogue` job checks the signature once
//      more and points the catalogue at the release.
//
// `--dry-run` does 1 and 2 and stops before anything is uploaded.
//
// Node's standard library and the `gh` CLI, nothing else. The key is read into
// this process and never printed, written or passed on a command line.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash, createPrivateKey, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageFileName } from './build-index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_KEY_PATH = join(ROOT, 'scripts', 'release-public-key.pem');
export const KEY_ENV = 'AEGIS_AGENT_SIGNING_KEY';

/** `<id>-v<semver>`, split on the last `-v`, the way `release.yml` reads it. */
export function readTag(tag) {
    const m = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-v(\d+\.\d+\.\d+)$/.exec(String(tag || ''));
    if (!m) throw new Error(`"${tag}" is not <id>-v<semver>`);
    return { id: m[1], version: m[2] };
}

/** What a manifest must say about the zip beside it, or the reasons it does not. */
export function manifestErrors(manifest, zip, { id, version }) {
    const errors = [];
    if (!manifest || typeof manifest !== 'object') return ['the manifest is not a JSON object'];
    if (manifest.id !== id) errors.push(`manifest id is "${manifest.id}", the tag says "${id}"`);
    if (manifest.version !== version) errors.push(`manifest version is "${manifest.version}", the tag says "${version}"`);
    if (manifest.file !== packageFileName(id, version)) errors.push(`manifest file is "${manifest.file}"`);
    if (manifest.size !== zip.length) errors.push(`manifest size is ${manifest.size}, the zip is ${zip.length} bytes`);
    const digest = createHash('sha256').update(zip).digest('hex');
    if (manifest.sha256 !== digest) errors.push('manifest sha256 does not match the zip');
    return errors;
}

/**
 * The detached signature over the manifest bytes, base64, the scheme
 * `releaseKey.verifyReleaseSignature` checks: RSA-SHA256, PKCS#1 v1.5.
 * Throws unless it verifies against `trustedPem`: a key that signs but is not
 * the trusted one would publish a release every install refuses.
 */
export function signManifest(manifestBytes, privateKey, trustedPem) {
    const signature = sign('sha256', manifestBytes, privateKey);
    if (!verify('sha256', manifestBytes, trustedPem, signature)) {
        throw new Error('this key does not match scripts/release-public-key.pem, the key installs trust. Nothing was published.');
    }
    return signature.toString('base64');
}

function gh(args, opts) {
    return execFileSync('gh', args, Object.assign({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }, opts));
}

function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const tag = args.find((a) => !a.startsWith('--'));
    if (!tag) {
        console.error('usage: node scripts/publish-release.mjs <id>-v<semver> [--dry-run]');
        process.exit(2);
    }
    const { id, version } = readTag(tag);
    const keyPath = process.env[KEY_ENV];
    if (!keyPath) {
        console.error(`${KEY_ENV} is not set. It holds the path to the private half of the Aegis release key.`);
        process.exit(1);
    }

    const release = JSON.parse(gh(['release', 'view', tag, '--json', 'isDraft,assets']));
    if (!release.isDraft) {
        console.error(`${tag} is already published. Nothing to do.`);
        process.exit(1);
    }
    const zipName = packageFileName(id, version);
    const manifestName = `${id}-${version}.manifest.json`;
    const names = release.assets.map((a) => a.name);
    for (const want of [zipName, manifestName]) {
        if (!names.includes(want)) {
            console.error(`the draft ${tag} has no ${want}. Re-run release.yml for the tag.`);
            process.exit(1);
        }
    }

    const dir = mkdtempSync(join(tmpdir(), 'aegis-release-'));
    try {
        gh(['release', 'download', tag, '-p', zipName, '-p', manifestName, '-D', dir]);
        const zip = readFileSync(join(dir, zipName));
        const manifestBytes = readFileSync(join(dir, manifestName));
        const errors = manifestErrors(JSON.parse(manifestBytes.toString('utf8')), zip, { id, version });
        if (errors.length) {
            console.error(`the draft ${tag} is not consistent:\n  ${errors.join('\n  ')}`);
            process.exit(1);
        }

        const privateKey = createPrivateKey(readFileSync(keyPath));
        const signature = signManifest(manifestBytes, privateKey, readFileSync(PUBLIC_KEY_PATH, 'utf8'));
        const sigPath = join(dir, `${manifestName}.sig`);
        writeFileSync(sigPath, signature);
        console.log(`${tag}: manifest checked against the zip and signed with the trusted key.`);

        if (dryRun) {
            console.log('dry run: nothing uploaded, the draft is unchanged.');
            return;
        }
        gh(['release', 'upload', tag, sigPath, '--clobber']);
        gh(['release', 'edit', tag, '--draft=false']);
        console.log(`${tag}: published. release.yml now points the catalogue at it.`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// Run, not imported by a test. Compared case-blind: Windows paths are.
const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : '';
if (invoked === fileURLToPath(import.meta.url).toLowerCase()) {
    try {
        main();
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
}
