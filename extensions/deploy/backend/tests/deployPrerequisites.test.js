'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WIN = process.platform === 'win32';
const SETUP = path.join(__dirname, '..', 'build', 'setup', 'Prerequisites.ps1');
const HARNESS = path.join(__dirname, 'fixtures', 'prereq-harness.ps1');

/** Runs one harness case under Windows PowerShell 5.1, the host core uses. */
function harness(caseName) {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', HARNESS, '-Case', caseName], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const line = out.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
    return JSON.parse(line);
}

test('a fingerprint mismatch refuses, deletes the download and never runs an installer', { skip: !WIN }, () => {
    const r = harness('mismatch');
    assert.strictEqual(r.results[0].status, 'failed');
    assert.match(r.results[0].error, /fingerprint/);
    assert.strictEqual(r.leftOnDisk, false);
    assert.strictEqual(r.installerRan, false);
});

test('a tool already there for all users is left alone', { skip: !WIN }, () => {
    const r = harness('present');
    assert.deepStrictEqual([r.results[0].status, r.results[0].version], ['present', '3.13.1']);
    assert.strictEqual(r.downloaded, false);
});

test('one failure does not stop the next tool', { skip: !WIN }, () => {
    const r = harness('continues');
    assert.deepStrictEqual(r.results.map((t) => [t.id, t.status]), [['node', 'failed'], ['python', 'installed']]);
});

test('an installer that exits non-zero but left the tool behind counts as installed', { skip: !WIN }, () => {
    const r = harness('python1638');
    assert.strictEqual(r.results[0].status, 'installed');
});

test('a tool with no pin fails by name', { skip: !WIN }, () => {
    const r = harness('nopin');
    assert.match(r.results[0].error, /no pinned installer/);
});

test('the pins are complete, official, and the ones store.json shows the operator', () => {
    const text = fs.readFileSync(SETUP, 'utf8');
    assert.doesNotMatch(text, /__FILL__/, 'Task 12 pins not written in');
    const store = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'store.json'), 'utf8'));
    for (const p of store.prerequisites) {
        const block = new RegExp(`${p.id}\\s*=\\s*@\\{([^}]*)\\}`).exec(text);
        assert.ok(block, `no pin for ${p.id}`);
        assert.match(block[1], new RegExp(`Version\\s*=\\s*'${p.version.replace(/\./g, '\\.')}'`), `${p.id} pin differs from store.json`);
        assert.match(block[1], /Sha256\s*=\s*'[0-9A-Fa-f]{64}'/, `${p.id} has no SHA-256`);
        assert.match(block[1], /Url\s*=\s*'https:\/\/(www\.python\.org|nodejs\.org|github\.com\/git-for-windows)\//, `${p.id} is not from its publisher`);
    }
});
