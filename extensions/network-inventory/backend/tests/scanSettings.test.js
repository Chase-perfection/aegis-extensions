'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scanSettings = require('../scanSettings');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ni-settings-'));

test('TCP probes are off when nothing is stored', () => {
    assert.deepStrictEqual(scanSettings.read(dir()), { tcpProbe: false, updatedAt: null, updatedBy: null });
});

test('TCP probes are off unless the file says exactly true', () => {
    // An operator has to have chosen active scanning: a corrupt file, a string
    // or a number never turns it on.
    for (const raw of ['not json', '{"tcpProbe":"true"}', '{"tcpProbe":1}', 'null', '[]']) {
        const d = dir();
        fs.writeFileSync(path.join(d, scanSettings.FILE), raw);
        assert.strictEqual(scanSettings.read(d).tcpProbe, false, raw);
    }
});

test('a saved choice reads back with who made it', () => {
    const d = dir();
    const saved = scanSettings.write(d, { tcpProbe: true }, 'admin@example.local');
    assert.strictEqual(saved.tcpProbe, true);
    assert.strictEqual(saved.updatedBy, 'admin@example.local');
    assert.match(saved.updatedAt, /^\d{4}-\d\d-\d\dT/);
    assert.deepStrictEqual(scanSettings.read(d), saved);
    assert.strictEqual(scanSettings.write(d, { tcpProbe: false }, null).tcpProbe, false);
});

test('only a boolean is written', () => {
    assert.throws(() => scanSettings.write(dir(), { tcpProbe: 'yes' }, null), TypeError);
});
