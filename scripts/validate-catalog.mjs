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

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetUrls } from './build-index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+$/;
const ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const errors = [];
const fail = (m) => errors.push(m);

const cat = JSON.parse(readFileSync(join(ROOT, 'index.json'), 'utf8'));

if (cat.schemaVersion !== 1) fail(`schemaVersion must be 1, got ${cat.schemaVersion}`);
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
const EXT_DIR = join(ROOT, 'extensions');
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
