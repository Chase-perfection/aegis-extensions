#!/usr/bin/env node
// Regenerates index.json from the per-extension store.json files.
//
// Only an extension with a `latest` block lands in the catalogue. One without a
// release is prepared but unpublished, and emitting it would put an entry in
// front of Aegis whose download and signature do not exist yet.
//
// Asset URLs are derived here rather than stored, so the tag convention lives in
// one place. Tags follow `<id>-v<semver>`, the shape agent releases already use
// on aegis-releases.

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'Chase-perfection/aegis-extensions';
const EXT_DIR = join(ROOT, 'extensions');

export function assetUrls(repo, id, version) {
    const tag = `${id}-v${version}`;
    const base = `https://github.com/${repo}/releases/download/${tag}`;
    return {
        download: `${base}/${id}-${version}.zip`,
        manifest: `${base}/${id}-${version}.manifest.json`,
        signature: `${base}/${id}-${version}.manifest.json.sig`
    };
}

function entryFor(store) {
    const l = store.latest;
    return {
        id: store.id,
        name: store.name,
        version: l.version,
        manifestVersion: store.manifestVersion,
        minAppVersion: store.minAppVersion,
        labelKey: store.labelKey,
        descKey: store.descKey,
        icon: store.icon,
        page: store.page,
        routePrefixes: store.routePrefixes,
        requiresHostOptIn: store.requiresHostOptIn === true,
        size: l.size,
        sha256: l.sha256,
        ...assetUrls(REPO, store.id, l.version),
        publishedAt: l.publishedAt,
        channel: store.channel || 'stable'
    };
}

function main() {
    const dirs = readdirSync(EXT_DIR).filter((d) => statSync(join(EXT_DIR, d)).isDirectory()).sort();
    const extensions = [];
    const skipped = [];

    for (const dir of dirs) {
        const store = JSON.parse(readFileSync(join(EXT_DIR, dir, 'store.json'), 'utf8'));
        if (store.id !== dir) {
            throw new Error(`${dir}/store.json declares id "${store.id}"; it must equal the folder name`);
        }
        if (!store.latest) { skipped.push(dir); continue; }
        extensions.push(entryFor(store));
    }

    const catalogue = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        repo: REPO,
        extensions
    };
    writeFileSync(join(ROOT, 'index.json'), JSON.stringify(catalogue, null, 2) + '\n');

    console.log(`index.json: ${extensions.length} published`);
    for (const e of extensions) console.log(`  ${e.id} ${e.version} (${e.channel})`);
    if (skipped.length) console.log(`  prepared, no release yet: ${skipped.join(', ')}`);
}

if (process.argv[1] && process.argv[1].endsWith('build-index.mjs')) main();
