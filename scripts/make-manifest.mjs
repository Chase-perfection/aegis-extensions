#!/usr/bin/env node
// Writes the release manifest for one extension zip, and prints the digest.
//
//   node scripts/make-manifest.mjs <id> <version> <path-to-zip>
//
// The manifest is what gets signed, and the signature covers the bytes exactly as
// written here. Reformatting the file afterwards, even reindenting it, invalidates
// the signature (backend/src/lib/releaseKey.js verifies over the uploaded bytes).
// So this script writes the final bytes and nothing edits them again.
//
// Signing happens outside this repository. The private key lives on the maintainer
// machine or in CI, never here.

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [id, version, zipPath] = process.argv.slice(2);
if (!id || !version || !zipPath) {
    console.error('usage: make-manifest.mjs <id> <version> <path-to-zip>');
    process.exit(2);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`version "${version}" must be semver. The integer in extension.json is a different field.`);
    process.exit(2);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const storePath = join(ROOT, 'extensions', id, 'store.json');
const store = JSON.parse(readFileSync(storePath, 'utf8'));

const bytes = readFileSync(zipPath);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const size = statSync(zipPath).size;

const manifest = {
    id,
    version,
    manifestVersion: store.manifestVersion,
    minAppVersion: store.minAppVersion,
    size,
    sha256
};

const out = join(dirname(zipPath), `${id}-${version}.manifest.json`);
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');

console.log(`manifest: ${out}`);
console.log(`sha256:   ${sha256}`);
console.log(`size:     ${size}`);
console.log('');
console.log('Next: sign the manifest with the Aegis release key, then paste these into');
console.log(`extensions/${id}/store.json as the "latest" block:`);
console.log(JSON.stringify({ version, publishedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), size, sha256 }, null, 2));
