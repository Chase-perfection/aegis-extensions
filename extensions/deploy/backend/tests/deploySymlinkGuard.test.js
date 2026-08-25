'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { assertNoSymlinks } = require('../build/symlinkGuard');

test('assertNoSymlinks refuses a directory containing a real symlink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-symlink-guard-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-symlink-outside-'));
    try {
        fs.symlinkSync(outside, path.join(dir, 'evil'), 'junction');
        assert.throws(() => assertNoSymlinks(dir), (e) => e.code === 'unsafe_symlink');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('assertNoSymlinks refuses a nested symlink in a subdirectory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-symlink-nested-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-symlink-outside-'));
    try {
        const subdir = path.join(dir, 'subdir');
        fs.mkdirSync(subdir);
        fs.symlinkSync(outside, path.join(subdir, 'evil'), 'junction');
        assert.throws(() => assertNoSymlinks(dir), (e) => e.code === 'unsafe_symlink');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('assertNoSymlinks accepts a directory with no symlinks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-symlink-guard-clean-'));
    try {
        fs.writeFileSync(path.join(dir, 'index.html'), '<h1>ok</h1>');
        assert.doesNotThrow(() => assertNoSymlinks(dir));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('assertNoSymlinks accepts nested directories with no symlinks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-symlink-nested-clean-'));
    try {
        const subdir = path.join(dir, 'subdir');
        fs.mkdirSync(subdir);
        fs.writeFileSync(path.join(dir, 'index.html'), '<h1>ok</h1>');
        fs.writeFileSync(path.join(subdir, 'page.html'), '<h1>page</h1>');
        assert.doesNotThrow(() => assertNoSymlinks(dir));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
