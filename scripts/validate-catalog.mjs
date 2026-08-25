#!/usr/bin/env node
// Checks index.json before it ships. Zero dependencies, Node >= 18.
//
// The field rules mirror backend/src/lib/extensionLoader.js. An entry this script
// accepts but the loader refuses would let an operator download an extension that
// cannot load, so the two rule sets have to agree. When the loader changes, change
// this too.
//
// The last check rebuilds the catalogue from the store.json files and diffs it
// against what is committed, which catches a hand-edited index.json.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assetUrls, imageUrl, packageFileName, CATEGORIES, SCHEMA_VERSION } from './build-index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+$/;
const ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
// The name extensionInstaller accepts: no separator, nothing to traverse with.
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const errors = [];
const fail = (m) => errors.push(m);

const EXT_DIR = join(ROOT, 'extensions');
const cat = JSON.parse(readFileSync(join(ROOT, 'index.json'), 'utf8'));

/** One extension's store.json, or null when the folder has none. */
function storeFor(id) {
    try {
        return JSON.parse(readFileSync(join(EXT_DIR, String(id), 'store.json'), 'utf8'));
    } catch (_) {
        return null;
    }
}

if (cat.schemaVersion !== SCHEMA_VERSION) {
    fail(`schemaVersion must be ${SCHEMA_VERSION}, got ${cat.schemaVersion}`);
}
if (!Array.isArray(cat.extensions)) fail('extensions must be an array');
if (typeof cat.repo !== 'string' || !cat.repo.includes('/')) fail('repo must be owner/name');

const seenIds = new Set();
const prefixOwner = new Map();

for (const e of cat.extensions || []) {
    const at = `entry "${e.id ?? '?'}"`;

    if (!ID.test(e.id || '')) fail(`${at}: id must be lowercase alphanumeric with dashes`);
    if (seenIds.has(e.id)) fail(`${at}: duplicate id`);
    seenIds.add(e.id);

    if (!SEMVER.test(e.version || '')) fail(`${at}: version "${e.version}" must be semver`);
    if (!SEMVER.test(e.minAppVersion || '')) fail(`${at}: minAppVersion "${e.minAppVersion}" must be semver`);

    // The loader validates this as an integer. A semver here stops the extension
    // from loading at all, which is the mistake this check exists to catch.
    if (!Number.isInteger(e.manifestVersion) || e.manifestVersion < 1) {
        fail(`${at}: manifestVersion must be a positive integer, got ${JSON.stringify(e.manifestVersion)}`);
    }

    for (const f of ['name', 'labelKey', 'descKey', 'icon', 'page']) {
        if (typeof e[f] !== 'string' || !e[f]) fail(`${at}: ${f} must be a non-empty string`);
    }
    if (typeof e.page === 'string') {
        if (!e.page.endsWith('.html')) fail(`${at}: page "${e.page}" must end in .html`);
        if (/[\/]/.test(e.page)) fail(`${at}: page "${e.page}" must be a bare filename`);
    }

    if (!Array.isArray(e.routePrefixes) || e.routePrefixes.length === 0) {
        fail(`${at}: routePrefixes must be a non-empty array`);
    } else {
        for (const p of e.routePrefixes) {
            if (typeof p !== 'string' || !p.startsWith('/api/') || p.endsWith('/')) {
                fail(`${at}: routePrefix "${p}" must start with /api/ and not end in /`);
            }
            // The loader refuses both sides of a collision, so two entries claiming
            // one prefix would take a working extension down with the new one.
            if (prefixOwner.has(p)) fail(`routePrefix "${p}" claimed by both "${prefixOwner.get(p)}" and "${e.id}"`);
            else prefixOwner.set(p, e.id);
        }
    }

    // storeService drops an entry whose category it does not know, so an unknown
    // word here publishes something no operator can see.
    if (!CATEGORIES.includes(e.category)) {
        fail(`${at}: category must be one of ${CATEGORIES.join(', ')}, got ${JSON.stringify(e.category)}`);
    }

    // The package name, which has to match both the release asset and the `file`
    // field of the signed manifest. extensionInstaller refuses any disagreement.
    if (typeof e.file !== 'string' || !FILE_NAME.test(e.file)) {
        fail(`${at}: file must be a bare package name, got ${JSON.stringify(e.file)}`);
    } else if (SEMVER.test(e.version || '') && e.file !== packageFileName(e.id, e.version)) {
        fail(`${at}: file should be ${packageFileName(e.id, e.version)}, got ${e.file}`);
    }

    if ('publisher' in e && (typeof e.publisher !== 'string' || !e.publisher.trim())) {
        fail(`${at}: publisher, when present, must be a non-empty string`);
    }

    // The card image travels as a URL plus a digest, and both are derived. An
    // entry carrying one without the other would give Aegis bytes it cannot
    // check, or a check with nothing to check.
    if (('image' in e) !== ('imageSha256' in e)) {
        fail(`${at}: image and imageSha256 go together, got ${Object.keys(e).filter((k) => k.startsWith('image')).join(' and ') || 'neither'}`);
    }
    if ('image' in e) {
        if (!SHA256.test(e.imageSha256 || '')) {
            fail(`${at}: imageSha256 must be 64 lowercase hex characters`);
        }
        const store = storeFor(e.id);
        const named = store && store.image;
        if (!named) {
            fail(`${at}: index.json carries an image but ${e.id}/store.json names none`);
        } else {
            const want = imageUrl(cat.repo, e.id, named);
            if (e.image !== want) fail(`${at}: image should be ${want}, got ${e.image}`);
            // The digest against the bytes actually committed. This is the check
            // that catches a picture replaced without a rebuild, which would have
            // every Aegis refuse the image it is offered.
            const onDisk = join(EXT_DIR, e.id, named);
            if (!existsSync(onDisk)) {
                fail(`${at}: names image "${named}", absent from extensions/${e.id}/`);
            } else {
                const actual = createHash('sha256').update(readFileSync(onDisk)).digest('hex');
                if (actual !== e.imageSha256) {
                    fail(`${at}: imageSha256 is ${e.imageSha256} but ${named} hashes to ${actual}. Run scripts/build-index.mjs.`);
                }
            }
        }
    }

    if (typeof e.requiresHostOptIn !== 'boolean') fail(`${at}: requiresHostOptIn must be a boolean`);
    if (!Number.isInteger(e.size) || e.size < 1) fail(`${at}: size must be a positive integer`);
    if (!SHA256.test(e.sha256 || '')) fail(`${at}: sha256 must be 64 lowercase hex characters`);
    if (!['stable', 'preview'].includes(e.channel)) fail(`${at}: channel must be stable or preview`);
    if (Number.isNaN(Date.parse(e.publishedAt || ''))) fail(`${at}: publishedAt must be a date`);

    const want = assetUrls(cat.repo, e.id, e.version);
    for (const k of ['download', 'manifest', 'signature']) {
        if (e[k] !== want[k]) fail(`${at}: ${k} should be ${want[k]}, got ${e[k]}`);
    }
}

// index.json is generated. If it disagrees with the store.json files, someone
// edited the output instead of the input.
const dirs = readdirSync(EXT_DIR).filter((d) => statSync(join(EXT_DIR, d)).isDirectory()).sort();
const expectedIds = [];
for (const dir of dirs) {
    const store = JSON.parse(readFileSync(join(EXT_DIR, dir, 'store.json'), 'utf8'));
    if (store.id !== dir) fail(`${dir}/store.json declares id "${store.id}"; it must equal the folder name`);
    if (store.latest) expectedIds.push(store.id);
}
const actualIds = (cat.extensions || []).map((e) => e.id).sort();
if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds.sort())) {
    fail(`index.json lists [${actualIds}] but the store.json files describe [${expectedIds}]. Run scripts/build-index.mjs.`);
}

if (errors.length) {
    console.error(`catalogue invalid, ${errors.length} problem(s):`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
}
console.log(`catalogue valid: ${(cat.extensions || []).length} published, ${dirs.length} folder(s) tracked`);
