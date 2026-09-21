const { test } = require('node:test');
const assert = require('node:assert');
const { vendorForMac } = require('../ouiVendor');

test('vendorForMac resolves a known prefix regardless of separator/case', () => {
  assert.strictEqual(vendorForMac('00:50:56:AB:CD:EF'), 'VMware');
  assert.strictEqual(vendorForMac('00-50-56-ab-cd-ef'), 'VMware');
  assert.strictEqual(vendorForMac('005056ABCDEF'), 'VMware');
});

test('vendorForMac returns null for unknown or malformed input', () => {
  assert.strictEqual(vendorForMac('AA:BB:CC:00:00:00'), null);
  assert.strictEqual(vendorForMac(''), null);
  assert.strictEqual(vendorForMac(null), null);
  assert.strictEqual(vendorForMac('xyz'), null);
});
