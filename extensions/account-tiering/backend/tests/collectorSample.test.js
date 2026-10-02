'use strict';

/**
 * A sample of what collect-tiering.ps1 writes goes through the runner, as the
 * scan route reads it, then through analyze. The collector itself needs a
 * domain and is tested in the corp.local VM; this pins the format the two
 * sides agree on, so a drift on either side turns this file red.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runCollector } = require('../runner');
const { analyze } = require('../analyze');

const FAKE = { exe: process.execPath, prefix: [path.join(__dirname, 'fakeCollector.js')] };
const COLLECT = path.join(__dirname, '..', '..', 'collect');
const SCRIPT = ['collect-tiering.ps1', 'tiering-rules.ps1'].map((f) => fs.readFileSync(path.join(COLLECT, f), 'utf8')).join('\n');
const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'collector-sample.json'), 'utf8'));

async function sampleFacts() {
    process.env.FAKE_MODE = 'sample';
    const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'at-sample-')), 'facts.json');
    return runCollector({ passes: 3, outFile, command: FAKE });
}

test('the sample is read through the runner: BOM stripped, partial because one GPO file was unreadable', async () => {
    const r = await sampleFacts();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 'partial');
    assert.deepStrictEqual(r.facts, SAMPLE);
});

test('analyze gives each mechanism of the sample its tier', async () => {
    const { facts } = await sampleFacts();
    const model = analyze(facts, new Map());
    const tierOf = Object.fromEntries(model.accounts.map((a) => [a.sam, a.effective]));
    assert.deepStrictEqual(tierOf, {
        'adm-t0-jdurand': 0,   // member of Domain Admins
        'adm-t0-ancien': 0,    // same, disabled: still listed
        'b.lefebvre': 0,       // group nested in builtin Administrators
        'c.mercier': 0,        // DnsAdmins, found by name
        'd.ohenry': 0,         // primary group Domain Admins
        'DC01$': 0,            // primary group Domain Controllers
        'gmsa-backup$': 0,     // Backup Operators
        'svc-repli': 0,        // both halves of DCSync
        'svc-annuaire': 2,     // one half only: not DCSync
        'e.colin': 0,          // helpdesk resets a Tier 0 password, inherited from the OU
        'k.girard': 0,         // WriteDacl on the OU that holds Tier 0 accounts
        'i.faure': 0,          // edits the GPO linked at the domain root
        'h.roche': 1           // local admin on servers through a GPO
    });

    const reset = model.accounts.find((a) => a.sam === 'e.colin').path.find((e) => e.kind === 'acl');
    assert.strictEqual(reset.detail.right, 'ResetPassword');
    assert.strictEqual(reset.detail.originDn, 'OU=Admins-T0,DC=corp,DC=local');
    assert.strictEqual(model.accounts.find((a) => a.sam === 'adm-t0-ancien').enabled, false);
    assert.strictEqual(model.accounts.find((a) => a.sam === "d.ohenry").name, "David O'Henry");

    // Domain Users in the workstations' local Administrators is a broad chokepoint.
    assert.ok(model.chokepoints.some((p) => p.broad && p.from === `${SAMPLE.domainSid}-513` && p.kind === 'gpoLocal'));
    // The uncollected accounts are counted as Tier 2.
    assert.strictEqual(model.keyFigures.accounts, model.accounts.length + 40 + 15);
    assert.strictEqual(model.scan.unreadable.length, 1);
});

test('every value the sample uses is one the collector writes', () => {
    const quoted = (value) => SCRIPT.includes(`'${value}'`);
    const values = new Set([
        ...SAMPLE.principals.map((p) => p.kind),
        ...SAMPLE.memberships.map((m) => m.via),
        ...SAMPLE.aces.flatMap((a) => [a.right, a.objectKind]),
        ...SAMPLE.gpos.flatMap((g) => g.localGroups.map((l) => l.source)),
        ...SAMPLE.unreadable.map((u) => u.reason)
    ]);
    for (const value of values) assert.ok(quoted(value), `the collector never writes '${value}'`);
    for (const key of Object.keys(SAMPLE)) assert.ok(new RegExp(`\\b${key} = `).test(SCRIPT), `the collector has no key ${key}`);
});
