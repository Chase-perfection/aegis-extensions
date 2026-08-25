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
//
// Schema 2 is what `backend/src/services/storeService.js` reads. It refuses a
// catalogue whose `schemaVersion` is not its own rather than guessing at an older
// shape, so this number is a contract with that file and not a label.

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'Chase-perfection/aegis-extensions';
const EXT_DIR = join(ROOT, 'extensions');

export const SCHEMA_VERSION = 2;

/**
 * The category rail on the store page, mirroring `storeService.CATEGORIES`.
 *
 * Closed on both sides: the backend drops an entry whose category it does not
 * know, so a new word invented here would publish an extension the operator
 * cannot see. Failing the build instead makes the mistake visible.
 */
export const CATEGORIES = ['Detection', 'Inventory', 'Compliance', 'Integrations', 'Automation'];

/**
 * The package file name, in one place.
 *
 * It is both the release asset name and the `file` field the signed manifest has
 * to carry: `extensionInstaller` compares the two and refuses the install when
 * they disagree. `make-manifest.mjs` reads it from here for that reason.
 */
export function packageFileName(id, version) {
    return `${id}-${version}.zip`;
}

/** A card image is a bare file name, the same rule `page` follows. */
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(?:png|webp|jpg|jpeg)$/;

/**
 * The URL Aegis fetches a card image from.
 *
 * The repository, not a release: a picture is not version-specific, and tying it
 * to a tag would mean cutting a release to fix a crop. `main` is the same ref
 * `index.json` itself is read from, so an image and the entry naming it move
 * together.
 */
export function imageUrl(repo, id, file) {
    return `https://raw.githubusercontent.com/${repo}/main/extensions/${id}/${file}`;
}

export function assetUrls(repo, id, version) {
    const tag = `${id}-v${version}`;
    const base = `https://github.com/${repo}/releases/download/${tag}`;
    const file = packageFileName(id, version);
    return {
        download: `${base}/${file}`,
        manifest: `${base}/${id}-${version}.manifest.json`,
        signature: `${base}/${id}-${version}.manifest.json.sig`
    };
}

function entryFor(store) {
    const l = store.latest;
    const entry = {
        id: store.id,
        name: store.name,
        version: l.version,
        manifestVersion: store.manifestVersion,
        minAppVersion: store.minAppVersion,
        labelKey: store.labelKey,
        descKey: store.descKey,
        icon: store.icon,
        page: store.page,
        category: store.category,
        routePrefixes: store.routePrefixes,
        requiresHostOptIn: store.requiresHostOptIn === true,
        file: packageFileName(store.id, l.version),
        size: l.size,
        sha256: l.sha256,
        ...assetUrls(REPO, store.id, l.version),
        publishedAt: l.publishedAt,
        channel: store.channel || 'stable'
    };

    // The card image, when the extension ships one. The digest is computed here
    // from the file on disk rather than pasted into store.json, so it cannot
    // drift from the bytes it describes: replacing the picture and rebuilding is
    // one step, and forgetting to update a hand-written hash is not possible.
    if (store.image) {
        if (!IMAGE_RE.test(store.image)) {
            throw new Error(`${store.id}/store.json image "${store.image}" must be a bare png, webp or jpg file name`);
        }
        const onDisk = join(EXT_DIR, store.id, store.image);
        if (!existsSync(onDisk)) {
            throw new Error(`${store.id}/store.json names image "${store.image}", which is not in extensions/${store.id}/`);
        }
        entry.image = imageUrl(REPO, store.id, store.image);
        entry.imageSha256 = createHash('sha256').update(readFileSync(onDisk)).digest('hex');
    }

    // Optional presentation fields. Absent rather than null when the publisher
    // says nothing: the store page falls back to the nav glyph for a card with no
    // art, and `additionalProperties` in the schema has nothing to reject.
    if (typeof store.publisher === 'string' && store.publisher.trim()) {
        entry.publisher = store.publisher.trim();
    }
    if (Array.isArray(store.art) && store.art.length) entry.art = store.art;
    if (Array.isArray(store.changelog) && store.changelog.length) entry.changelog = store.changelog;

    return entry;
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
        if (!CATEGORIES.includes(store.category)) {
            throw new Error(
                `${dir}/store.json declares category ${JSON.stringify(store.category)}; `
                + `it must be one of ${CATEGORIES.join(', ')}`
            );
        }
        if (!store.latest) { skipped.push(dir); continue; }
        extensions.push(entryFor(store));
    }

    const catalogue = {
        schemaVersion: SCHEMA_VERSION,
        generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        repo: REPO,
        extensions
    };
    writeFileSync(join(ROOT, 'index.json'), JSON.stringify(catalogue, null, 2) + '\n');

    console.log(`index.json: ${extensions.length} published`);
    for (const e of extensions) console.log(`  ${e.id} ${e.version} (${e.channel}, ${e.category})`);
    if (skipped.length) console.log(`  prepared, no release yet: ${skipped.join(', ')}`);
}

if (process.argv[1] && process.argv[1].endsWith('build-index.mjs')) main();
