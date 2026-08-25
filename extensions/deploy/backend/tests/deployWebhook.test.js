/**
 * The webhook is the only Aegis route that answers unauthenticated POSTs from
 * the internet, on a domain-joined server. These tests cover the three things
 * that keep it safe: the signature is verified over the raw bytes, a redelivery
 * does not build twice, and a payload that is not a branch push is ignored.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const {
  verifySignature, createDeliveryCache, parsePush
} = require('../webhook');

const SECRET = 'a-webhook-secret';
const BODY = Buffer.from(JSON.stringify({ ref: 'refs/heads/main' }));

function sign(body, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

test('a correct signature verifies', () => {
  assert.strictEqual(verifySignature(BODY, sign(BODY), SECRET), true);
});

test('a wrong secret does not verify', () => {
  assert.strictEqual(verifySignature(BODY, sign(BODY, 'other'), SECRET), false);
});

// The case that matters most: a signature computed over different bytes than
// the ones received. JSON.parse then JSON.stringify does not reproduce the
// original bytes, which is why the route reads req.rawBody.
test('a signature over different bytes does not verify', () => {
  const other = Buffer.from(JSON.stringify({ ref: 'refs/heads/main', x: 1 }));
  assert.strictEqual(verifySignature(BODY, sign(other), SECRET), false);
});

test('missing or malformed signature headers do not verify', () => {
  for (const h of [undefined, null, '', 'sha1=abc', 'abc', 'sha256=', 'sha256=zz']) {
    assert.strictEqual(verifySignature(BODY, h, SECRET), false, `accepted header ${h}`);
  }
});

test('a missing secret never verifies', () => {
  assert.strictEqual(verifySignature(BODY, sign(BODY), ''), false);
  assert.strictEqual(verifySignature(BODY, sign(BODY), null), false);
});

test('a delivery id is claimed once', () => {
  const cache = createDeliveryCache();
  assert.strictEqual(cache.claim('d1'), true);
  assert.strictEqual(cache.claim('d1'), false);
  assert.strictEqual(cache.claim('d2'), true);
});

test('an absent delivery id is let through rather than swallowed', () => {
  const cache = createDeliveryCache();
  assert.strictEqual(cache.claim(undefined), true);
  assert.strictEqual(cache.claim(undefined), true);
});

test('delivery ids expire', () => {
  const cache = createDeliveryCache({ ttlMs: 1000 });
  assert.strictEqual(cache.claim('d1', 0), true);
  assert.strictEqual(cache.claim('d1', 500), false);
  assert.strictEqual(cache.claim('d1', 5000), true);
});

test('the delivery cache stays bounded', () => {
  const cache = createDeliveryCache({ max: 10 });
  for (let i = 0; i < 200; i++) cache.claim('d' + i, i);
  assert.ok(cache.size <= 10, `cache grew to ${cache.size}`);
});

test('a branch push parses', () => {
  const sha = 'a'.repeat(40);
  const p = parsePush({
    ref: 'refs/heads/main',
    after: sha,
    head_commit: { message: 'fix the thing\n\nlonger body', author: { name: 'Paul' } },
    repository: { full_name: 'me/site' },
    installation: { id: 42 }
  });
  assert.strictEqual(p.branch, 'main');
  assert.strictEqual(p.sha, sha);
  assert.strictEqual(p.message, 'fix the thing');   // first line only
  assert.strictEqual(p.author, 'Paul');
  assert.strictEqual(p.repoFullName, 'me/site');
  assert.strictEqual(p.installationId, 42);
});

test('a branch name containing a slash survives', () => {
  const p = parsePush({ ref: 'refs/heads/release/2026-08', after: 'b'.repeat(40) });
  assert.strictEqual(p.branch, 'release/2026-08');
});

test('tags, deletions and the zero sha are ignored', () => {
  const sha = 'c'.repeat(40);
  assert.strictEqual(parsePush({ ref: 'refs/tags/v1', after: sha }), null);
  assert.strictEqual(parsePush({ ref: 'refs/heads/main', after: sha, deleted: true }), null);
  assert.strictEqual(parsePush({ ref: 'refs/heads/main', after: '0'.repeat(40) }), null);
  assert.strictEqual(parsePush({ ref: 'refs/heads/main', after: 'not-a-sha' }), null);
  assert.strictEqual(parsePush(null), null);
  assert.strictEqual(parsePush({}), null);
});
