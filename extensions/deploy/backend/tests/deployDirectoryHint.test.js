/**
 * The directory settings Aegis can work out on its own.
 *
 * The authentication form asks for a domain that this product has already
 * audited. Suggesting it is the whole point, so what matters here is that the
 * suggestion is right and that a wrong one cannot do damage: the domain comes
 * from the newest readable audit, a value that is not a domain name is refused
 * before it reaches an LDAP URL or a distinguished name, and nothing is
 * suggested at all when nothing is known.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hint = require('../directoryHint');

/** A tenant tree with `audits/`, and a helper to file audits into it. */
function tenant() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-dirhint-'));
    const audits = path.join(root, 'audits');
    fs.mkdirSync(audits);
    return {
        paths: { audits },
        /** Writes one audit. `at` sets its mtime, which is how newest is decided. */
        audit(name, report, at) {
            const dir = path.join(audits, name);
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, 'audit_results.json');
            // With the BOM PowerShell writes, because that is what is on disk.
            fs.writeFileSync(file, '\uFEFF' + (typeof report === 'string' ? report : JSON.stringify(report)));
            if (at) fs.utimesSync(file, at / 1000, at / 1000);
        }
    };
}

test('a domain name becomes a base DN', () => {
    assert.strictEqual(hint.baseDnFor('corp.local'), 'DC=corp,DC=local');
    assert.strictEqual(hint.baseDnFor('ad.corp.example.com'), 'DC=ad,DC=corp,DC=example,DC=com');
    assert.strictEqual(hint.baseDnFor(''), '');
});

test('anything that is not a domain name is refused', () => {
    for (const bad of ['', 'local', '*.corp.local', 'corp .local', 'corp.local)(uid=*',
        'DC=corp,DC=local', 'ldaps://corp.local', '-corp.local', null, undefined, 42]) {
        assert.strictEqual(hint.cleanDomain(bad), '', String(bad));
    }
    assert.strictEqual(hint.cleanDomain('  CORP.Local.  '), 'corp.local');
});

test('the domain comes from the newest audit', () => {
    const t = tenant();
    t.audit('audit(01.01.2026_09h00)', { Metadata: { TargetDomain: 'old.local' } }, 1_000_000_000_000);
    t.audit('audit(20.08.2026_15h00)', { Metadata: { TargetDomain: 'dom2.local' } }, 1_800_000_000_000);
    assert.strictEqual(hint.auditedDomain(t.paths.audits), 'dom2.local');
});

test('a summary DomainName wins over the metadata target', () => {
    const t = tenant();
    t.audit('audit(20.08.2026_15h00)', {
        Summary: { DomainName: 'corp.local' },
        Metadata: { TargetDomain: 'typo.local' }
    });
    assert.strictEqual(hint.auditedDomain(t.paths.audits), 'corp.local');
});

test('a half-written report falls through to the one before it', () => {
    const t = tenant();
    t.audit('audit(01.01.2026_09h00)', { Metadata: { TargetDomain: 'good.local' } }, 1_000_000_000_000);
    t.audit('audit(20.08.2026_15h00)', '{"Metadata": {"TargetDo', 1_800_000_000_000);
    assert.strictEqual(hint.auditedDomain(t.paths.audits), 'good.local');
});

test('no audits directory is not an error', () => {
    assert.strictEqual(hint.auditedDomain(path.join(os.tmpdir(), 'aegis-dirhint-absent')), '');
});

test('the suggestion is the four fields a domain name settles', () => {
    const t = tenant();
    t.audit('audit(20.08.2026_15h00)', { Metadata: { TargetDomain: 'dom2.local' } });
    const s = hint.suggest(t.paths);
    assert.strictEqual(s.source, 'audit');
    assert.strictEqual(s.domain, 'dom2.local');
    assert.strictEqual(s.fields.baseDn, 'DC=dom2,DC=local');
    assert.strictEqual(s.fields.userDnTemplate, '{username}@dom2.local');
    // LDAPS, because the bind password crosses this connection.
    assert.match(s.fields.url, /^ldaps:\/\/dom2\.local:636$/);
    // Never guessed: the two fields that decide who gets in and as whom.
    assert.strictEqual(s.fields.bindDn, undefined);
    assert.strictEqual(s.fields.nestedGroups, undefined);
});

test('with no audit, the host\'s own domain is the fallback', () => {
    const t = tenant();
    const was = process.env.USERDNSDOMAIN;
    process.env.USERDNSDOMAIN = 'host.local';
    try {
        const s = hint.suggest(t.paths);
        assert.strictEqual(s.source, 'host');
        assert.strictEqual(s.domain, 'host.local');
    } finally {
        if (was === undefined) delete process.env.USERDNSDOMAIN; else process.env.USERDNSDOMAIN = was;
    }
});

test('nothing known means no suggestion, not a blank one', () => {
    const t = tenant();
    const was = process.env.USERDNSDOMAIN;
    delete process.env.USERDNSDOMAIN;
    try {
        assert.strictEqual(hint.suggest(t.paths), null);
    } finally {
        if (was !== undefined) process.env.USERDNSDOMAIN = was;
    }
});
