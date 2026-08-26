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
const { appJwt, buildManifest, verifyAppCredentials, manifestAction, UNREACHABLE_HOOK } = require('../github');

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

// This test used to assert the opposite, and the belief behind it cost the
// product its one-click path. Two refused registrations had established that
// `{ url: localhost, active: false }` is rejected with "Hook url is not
// supported because it isn't reachable over the public Internet" and that
// dropping `hook_attributes` is rejected with "Hook url cannot be blank"; from
// those it was concluded that the manifest flow needs THIS host to be publicly
// reachable, and a LAN install was sent to a five-step manual form instead.
//
// The conclusion did not follow. GitHub checks the hook address is public. It
// does not check that it is yours, and `redirect_url` is followed by the
// operator's browser, not by GitHub. Measured against github.com on 2026-08-26:
// a manifest carrying a reserved public hook with `active: false` and a
// `http://192.168.x.x:3000` redirect was accepted, and the browser came back
// here carrying the code.
test('an install GitHub cannot reach still gets a manifest', () => {
  const m = buildManifest({
    name: 'Aegis Deploy (acme)', baseUrl: 'http://192.168.1.10:3000/t/acme',
    webhookUrl: null, redirectUrl: 'http://192.168.1.10:3000/t/acme/cb'
  });
  assert.strictEqual(m.hook_attributes.active, false, 'nothing may be delivered to a hook we do not own');
  assert.strictEqual(m.hook_attributes.url, UNREACHABLE_HOOK);
  assert.strictEqual(m.redirect_url, 'http://192.168.1.10:3000/t/acme/cb', 'the redirect stays on the LAN');
});

// RFC 2606 reserves example.com, so this address can never become somebody's.
// A placeholder on a domain that is merely unregistered today would be a
// delivery address for repository events waiting for its owner.
test('the placeholder hook is on a domain nobody can ever register', () => {
  assert.match(UNREACHABLE_HOOK, /^https:\/\/example\.com\//);
});

test('manifestAction targets the account that will own the App', () => {
  assert.strictEqual(manifestAction('', 'S'), 'https://github.com/settings/apps/new?state=S');
  assert.strictEqual(manifestAction('acme-corp', 'S'),
    'https://github.com/organizations/acme-corp/settings/apps/new?state=S');
});

// A `public: false` App installs only on the account that owns it, so this
// string decides whether an organisation's private repositories are reachable
// at all. It is refused rather than escaped.
test('manifestAction refuses anything that is not a GitHub login', () => {
  for (const bad of ['bad/login', '../x', 'a b', '-lead', 'trail-', '', 'x'.repeat(40)]) {
    if (bad === '') continue;   // empty means "my own account", tested above
    assert.strictEqual(manifestAction(bad, 'S'), null, bad);
  }
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
