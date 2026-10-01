'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runCollector } = require('../runner');

const FAKE = { exe: process.execPath, prefix: [path.join(__dirname, 'fakeCollector.js')] };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-runner-'));
let n = 0;

function run(mode, extra = {}) {
    process.env.FAKE_MODE = mode;
    const outFile = path.join(dir, `facts-${n++}.json`);
    return runCollector({ passes: 3, outFile, command: FAKE, ...extra }).then((r) => ({ ...r, outFile }));
}

test('facts written with a BOM are read, progress lines are passed on, the file is removed', async () => {
    const seen = [];
    const r = await run('ok', { domain: 'corp.local', onLine: (l) => seen.push(l) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 'ok');
    assert.deepStrictEqual(r.facts, { schema: 1, domain: 'corp.local', passes: 3 });
    assert.deepStrictEqual(seen, ['pass 1', 'pass 2']);
    await new Promise((done) => setTimeout(done, 50));
    assert.strictEqual(fs.existsSync(r.outFile), false);
});

test('unreadable objects make the scan partial', async () => {
    assert.strictEqual((await run('partial')).status, 'partial');
});

test('an AT-ERROR line and exit code 2 both give domain_unreachable', async () => {
    assert.strictEqual((await run('unreachable')).code, 'domain_unreachable');
    assert.strictEqual((await run('exit2')).code, 'domain_unreachable');
});

test('the AMSI error id gives collector_blocked, whatever the language around it', async () => {
    assert.strictEqual((await run('amsi')).code, 'collector_blocked');
});

test('a code the collector may not send is not passed through', async () => {
    assert.strictEqual((await run('unknown-code')).code, 'collector_failed');
});

test('facts that do not parse give collector_failed', async () => {
    assert.strictEqual((await run('garbage')).code, 'collector_failed');
});

test('a run past the timeout is killed and gives scan_timeout', async () => {
    assert.strictEqual((await run('hang', { timeoutMs: 300 })).code, 'scan_timeout');
});

test('a missing executable gives powershell_missing', async () => {
    const r = await runCollector({ passes: 1, outFile: path.join(dir, 'x.json'), command: { exe: 'no-such-powershell-exe', prefix: [] } });
    assert.strictEqual(r.code, 'powershell_missing');
});
