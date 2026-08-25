/**
 * The App JWT and the registration manifest.
 *
 * Both are things you cannot check by reading: a JWT that GitHub rejects looks
 * fine on screen, and a permission set that is one word too wide reads exactly
 * like the correct one. The permission assertions are deliberately strict, so
 * widening the App's access has to be a deliberate edit to this file too.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { appJwt, buildManifest, verifyAppCredentials } = require('../github');

// Generated once per run rather than checked in: a private key in the test tree
// is the kind of file that gets copied somewhere real.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function decodeSegment(seg) {
  return JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

test('the App JWT verifies against the App public key', () => {
  const jwt = appJwt(12345, privateKey.export({ type: 'pkcs1', format: 'pem' }));
  const [h, p, s] = jwt.split('.');
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${h}.${p}`);
  const sig = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  assert.strictEqual(verifier.verify(publicKey, sig), true);
});

test('the JWT header and claims are what GitHub expects', () => {
  const jwt = appJwt(12345, privateKey.export({ type: 'pkcs1', format: 'pem' }));
  const [h, p] = jwt.split('.');
  assert.deepStrictEqual(decodeSegment(h), { alg: 'RS256', typ: 'JWT' });

  const claims = decodeSegment(p);
  const now = Math.floor(Date.now() / 1000);
  assert.strictEqual(claims.iss, '12345', 'issuer must be the app id as a string');
  assert.ok(claims.iat <= now, 'iat is backdated so a fast clock is tolerated');
  assert.ok(claims.exp > now, 'token is still valid when issued');
  assert.ok(claims.exp - claims.iat <= 600, 'GitHub refuses a lifetime over 10 minutes');
});

test('the JWT is base64url with no padding', () => {
  const jwt = appJwt(1, privateKey.export({ type: 'pkcs1', format: 'pem' }));
  assert.ok(!jwt.includes('='), 'padding would break the token');
  assert.ok(!jwt.includes('+') && !jwt.includes('/'), 'standard base64 chars are not URL safe');
  assert.strictEqual(jwt.split('.').length, 3);
});

// The App can clone a client's private repositories. Every permission here is
// one the plan justified; anything else needs the same justification.
test('the manifest asks for read on contents and metadata, and nothing else', () => {
  const m = buildManifest({
    name: 'Aegis Deploy (acme)', baseUrl: 'https://aegis.example/t/acme',
    webhookUrl: 'https://aegis.example/t/acme/api/deploy/webhook',
    redirectUrl: 'https://aegis.example/t/acme/cb'
  });
  assert.deepStrictEqual(m.default_permissions, { contents: 'read', metadata: 'read' });
  assert.deepStrictEqual(m.default_events, ['push']);
  assert.strictEqual(m.public, false, 'the App must not be listed publicly');
});

// Two real registrations wrote this test. `{ url: localhost, active: false }`
// was refused with "Hook url is not supported because it isn't reachable over
// the public Internet", and dropping `hook_attributes` was refused with "Hook
// url cannot be blank" despite the reference calling the object optional. So an
// install with no public URL cannot register through the manifest flow, and the
// caller has to hear that from us rather than from GitHub.
test('a manifest cannot be built without a public webhook URL', () => {
  assert.throws(() => buildManifest({
    name: 'Aegis Deploy (acme)', baseUrl: 'http://localhost:3000/t/acme',
    webhookUrl: null, redirectUrl: 'http://localhost:3000/t/acme/cb'
  }), /public webhookUrl/);
});

test('a reachable install gets an active hook', () => {
  const m = buildManifest({
    name: 'Aegis Deploy (acme)', baseUrl: 'https://aegis.example/t/acme',
    webhookUrl: 'https://aegis.example/t/acme/api/deploy/webhook',
    redirectUrl: 'https://aegis.example/t/acme/cb'
  });
  assert.deepStrictEqual(m.hook_attributes,
    { url: 'https://aegis.example/t/acme/api/deploy/webhook', active: true });
});

// Manual registration is the only route that works on an install GitHub cannot
// reach, which is every install on a private network. A pasted key is the
// failure mode, so the malformed cases must not reach the network at all.
test('verifyAppCredentials refuses a malformed key before calling GitHub', async () => {
  await assert.rejects(
    () => verifyAppCredentials('123456', 'not a pem at all'),
    (e) => !e.status,   // a crypto parse error, not an HTTP status from GitHub
    'a key Node cannot parse must fail locally'
  );
});

test('verifyAppCredentials refuses a key whose PEM body is corrupt', async () => {
  const broken = ['-----BEGIN RSA PRIVATE KEY-----', 'zzzz',
    '-----END RSA PRIVATE KEY-----', ''].join('\n');
  await assert.rejects(() => verifyAppCredentials('123456', broken), (e) => !e.status);
});

/* ------------------------------------------------------------------ */
/* listing the branches of a repository                                */
/* ------------------------------------------------------------------ */

const { listBranches } = require('../github');

/** Replaces global fetch for one call and gives back what was asked for. */
async function withFetch(pages, run) {
    const real = global.fetch;
    const seen = [];
    let i = 0;
    global.fetch = async (url, init) => {
        seen.push({ url: String(url), auth: (init.headers || {}).Authorization || null });
        const body = pages[i++] || [];
        return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: async () => JSON.stringify(body)
        };
    };
    try {
        return { result: await run(), seen };
    } finally {
        global.fetch = real;
    }
}

test('listBranches maps the fields the picker shows and stops on a short page', async () => {
    const page = [
        { name: 'main', commit: { sha: 'a'.repeat(40) }, protected: true },
        { name: 'feature/x', commit: { sha: 'b'.repeat(40) }, protected: false }
    ];
    const { result, seen } = await withFetch([page], () => listBranches(null, null, 'acme/site'));

    assert.deepEqual(result, [
        { name: 'main', sha: 'a'.repeat(40), protected: true },
        { name: 'feature/x', sha: 'b'.repeat(40), protected: false }
    ]);
    assert.equal(seen.length, 1, 'a page shorter than 100 ends the loop');
    assert.match(seen[0].url, /\/repos\/acme\/site\/branches\?per_page=100&page=1$/);
});

test('a public repository is listed with no credential at all', async () => {
    const { seen } = await withFetch([[]], () => listBranches(null, null, 'acme/site'));
    assert.equal(seen[0].auth, null, 'no installation means no Authorization header');
});

test('listBranches pages on and stops at the cap rather than looping', async () => {
    const full = Array.from({ length: 100 }, (_, n) => ({ name: 'b' + n, commit: { sha: 'c'.repeat(40) } }));
    // Six full pages offered, five read: the cap is what stops a repository
    // with thousands of branches from holding the request open.
    const { result, seen } = await withFetch([full, full, full, full, full, full],
        () => listBranches(null, null, 'acme/site'));

    assert.equal(seen.length, 5);
    assert.equal(result.length, 500);
});
