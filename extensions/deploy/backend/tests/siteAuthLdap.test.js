/**
 * The seam the other two suites leave open.
 *
 * `tests/ldap.test.js` proves the directory client against a fake DC but never
 * touches a site. `tests/siteAuth.test.js` proves the gate but injects a fake
 * verifier, so it never encodes a single BER byte. Between them sits the join
 * that actually ships: a browser hitting a deployed site on its own port, the
 * gate reading the stored config, decrypting the bind password, and handing it
 * to the real `ldap.js`, which really talks LDAP.
 *
 * So this file wires the whole chain together and drives it over HTTP the way a
 * browser does, with no stub anywhere in the path: `siteServer` -> `siteAuth`
 * -> `authStore` -> `machineStore` (real AES) -> `ldap` -> a fake directory
 * built on `net.createServer` that speaks real BER back.
 *
 * `AEGIS_DATA_ROOT` is pointed at a temporary directory before anything is
 * required, so the machine key and every encrypted value land there and never
 * in `C:\ProgramData\Aegis` or in the repository.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-siteauth-ldap-'));
process.env.AEGIS_DATA_ROOT = TMP;

const authStore = require('../authStore');
const projectStore = require('../projectStore');
const siteAuth = require('../siteAuth');
const siteServer = require('../siteServer');

// ---------------------------------------------------------------------------
// A fake directory. Independent BER writer, so a bug shared with ldap.js cannot
// hide by being symmetrical.
// ---------------------------------------------------------------------------

function len(n) {
    if (n < 0x80) return Buffer.from([n]);
    const bytes = [];
    let v = n;
    while (v > 0) { bytes.unshift(v & 0xff); v >>>= 8; }
    return Buffer.from([0x80 | bytes.length].concat(bytes));
}
function tlv(tag, payload) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.concat(payload);
    return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
}
const int = (n) => tlv(0x02, Buffer.from([n & 0xff]));
const str = (s) => tlv(0x04, Buffer.from(String(s), 'utf8'));
const enumerated = (n) => tlv(0x0a, Buffer.from([n & 0xff]));

function result(id, tag, code, diagnostic) {
    return tlv(0x30, [int(id), tlv(tag, [enumerated(code), str(''), str(diagnostic || '')])]);
}
function entry(id, dn, attrs) {
    const list = Object.keys(attrs).map((name) => tlv(0x30, [
        str(name),
        tlv(0x31, Object.prototype.hasOwnProperty.call(attrs, name)
            ? [].concat(attrs[name]).map((v) => str(v))
            : [])
    ]));
    return tlv(0x30, [int(id), tlv(0x64, [str(dn), tlv(0x30, list)])]);
}

/** Reads one TLV, or null while the buffer is still a fragment. */
function readTlv(buf) {
    if (buf.length < 2) return null;
    const first = buf[1];
    let start = 2;
    let length = first;
    if (first & 0x80) {
        const n = first & 0x7f;
        if (buf.length < 2 + n) return null;
        length = 0;
        for (let i = 0; i < n; i++) length = (length << 8) | buf[2 + i];
        start = 2 + n;
    }
    if (buf.length < start + length) return null;
    return { tag: buf[0], value: buf.subarray(start, start + length), end: start + length };
}
function children(buf) {
    const out = [];
    let rest = buf;
    for (;;) {
        const t = readTlv(rest);
        if (!t) return out;
        out.push(t);
        rest = rest.subarray(t.end);
    }
}

/**
 * `users`: { '<dn>': { password, groups: [] } }. A bind succeeds when the DN is
 * known and the password matches. The search answers on sAMAccountName.
 */
function fakeDirectory(users, accounts) {
    const state = { binds: [], searches: 0, errors: [], sockets: [] };

    const server = net.createServer((sock) => {
        state.sockets.push(sock);
        let buf = Buffer.alloc(0);
        sock.on('error', () => { /* the client destroys the socket on its way out */ });
        sock.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            for (;;) {
                const msg = readTlv(buf);
                if (!msg) return;
                buf = Buffer.from(buf.subarray(msg.end));
                try {
                    const parts = children(msg.value);
                    const id = parts[0].value[parts[0].value.length - 1];
                    const op = parts[1];

                    if (op.tag === 0x42) { sock.destroy(); return; }

                    if (op.tag === 0x60) {
                        const f = children(op.value);
                        const dn = f[1].value.toString('utf8');
                        const pw = f[2].value.toString('utf8');
                        state.binds.push({ dn, ok: !!(users[dn] && users[dn].password === pw) });
                        const known = users[dn] && users[dn].password === pw;
                        // An account the directory knows and still refuses: the
                        // password is right and something else about the account
                        // is not. AD says which in the diagnostic and nowhere else.
                        const refuse = users[dn] && users[dn].refuse;
                        if (known && refuse) {
                            sock.write(result(id, 0x61, 49, refuse));
                            return;
                        }
                        sock.write(result(id, 0x61, known ? 0 : 49));
                        return;
                    }

                    if (op.tag === 0x63) {
                        state.searches++;
                        // The filter carries the sAMAccountName the client is
                        // after; find it by looking for a known account name in
                        // the raw bytes rather than compiling the filter, which
                        // is ldap.js's job and not the fake's.
                        const raw = op.value.toString('utf8');
                        const hit = Object.keys(accounts).find((a) => raw.includes(a));
                        if (hit) {
                            const dn = accounts[hit];
                            sock.write(entry(id, dn, {
                                memberOf: users[dn].groups,
                                displayName: [hit]
                            }));
                        }
                        sock.write(result(id, 0x65, 0));
                        return;
                    }

                    state.errors.push('unexpected op 0x' + op.tag.toString(16));
                    sock.destroy();
                    return;
                } catch (e) {
                    state.errors.push(e.message);
                    sock.destroy();
                    return;
                }
            }
        });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            state.url = 'ldap://127.0.0.1:' + server.address().port;
            state.close = () => new Promise((done) => {
                for (const s of state.sockets) s.destroy();
                server.close(() => done());
            });
            resolve(state);
        });
    });
}

// ---------------------------------------------------------------------------
// An HTTP client that does not follow redirects, so each hop can be asserted.
// ---------------------------------------------------------------------------

function request(port, options, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port,
            method: options.method || 'GET',
            path: options.path || '/',
            headers: options.headers || {}
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8')
            }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

/**
 * A port the operating system just told us is free.
 *
 * Not a random number in a range: these tests each start a real listener, and a
 * collision between two of them fails a test for a reason that has nothing to
 * do with the code under test. Binding to 0 and reading the assignment back is
 * the only answer the OS actually guarantees.
 */
function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

/** The value of one cookie out of a set-cookie header list. */
function cookieFrom(res, name) {
    const list = [].concat(res.headers['set-cookie'] || []);
    for (const c of list) {
        const m = new RegExp('^' + name + '=([^;]*)').exec(c);
        if (m) return m[1];
    }
    return null;
}

/** The hidden csrf field of a rendered login form. */
function csrfField(html) {
    const m = /name="csrf" value="([^"]*)"/.exec(html);
    return m ? m[1] : null;
}

// ---------------------------------------------------------------------------

const SLUG = 'acme';
const GROUP_DN = 'CN=Site Viewers,OU=Groups,DC=corp,DC=local';
const USER_DN = 'CN=Alice,OU=Staff,DC=corp,DC=local';

function tenantPathsAt(dir) {
    return { root: dir, data: path.join(dir, 'data') };
}

/**
 * A tenant with one protected project, its files on disk, its listener running,
 * and a directory the config really points at.
 */
async function scaffold(t, { allowedGroups, protectedSite = true, configure = true, refuse = null }) {
    const dir = fs.mkdtempSync(path.join(TMP, 'tenant-'));
    const tenantPaths = tenantPathsAt(dir);

    const directory = await fakeDirectory({
        'CN=svc,OU=Service,DC=corp,DC=local': { password: 'svc-pw', groups: [] },
        [USER_DN]: { password: 'alice-pw', groups: [GROUP_DN], refuse }
    }, { alice: USER_DN });

    if (configure) {
        authStore.writeConfig(tenantPaths, {
            url: directory.url,
            bindDn: 'CN=svc,OU=Service,DC=corp,DC=local',
            bindPassword: 'svc-pw',
            baseDn: 'DC=corp,DC=local',
            userFilter: '(&(objectClass=user)(sAMAccountName={username}))',
            groupAttribute: 'memberOf'
        });
    }

    const port = await freePort();
    const project = {
        id: 'demo', name: 'Demo Site', port,
        auth: { enabled: protectedSite, allowedGroups: allowedGroups || [] }
    };
    projectStore.saveProject(tenantPaths, project);

    const current = projectStore.currentDir(tenantPaths, 'demo');
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(path.join(current, 'index.html'), '<h1>the private site</h1>', 'utf8');

    siteAuth.invalidate(SLUG, 'demo');
    siteServer.startSiteFor({ slug: SLUG, tenantPaths, project });
    await new Promise((r) => setTimeout(r, 60));

    t.after(async () => {
        siteServer.stopSiteFor(SLUG, 'demo');
        siteAuth.dropSessions(SLUG, 'demo');
        await directory.close();
    });

    return { tenantPaths, port, directory };
}

/** Walks the whole form: fetch the page, post it back with its cookies. */
async function login(port, username, password, next) {
    const page = await request(port, { path: '/__aegis/login?next=' + encodeURIComponent(next || '/') });
    const csrf = csrfField(page.body);
    const csrfCookie = cookieFrom(page, 'aegis_site_csrf');
    const form = new URLSearchParams({ username, password, csrf, next: next || '/' }).toString();
    const posted = await request(port, {
        method: 'POST',
        path: '/__aegis/login',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(form),
            Cookie: 'aegis_site_csrf=' + csrfCookie
        }
    }, form);
    return { page, posted };
}

test('the whole chain: an anonymous visitor is stopped, a real directory account gets in', async (t) => {
    const { port, directory } = await scaffold(t, { allowedGroups: [] });

    const anon = await request(port, { path: '/' });
    assert.strictEqual(anon.status, 302, 'an anonymous request is redirected');
    assert.match(anon.headers.location, /^\/__aegis\/login\?next=/, 'to the login, remembering where');
    assert.ok(!anon.body.includes('the private site'), 'and no byte of the site leaks');

    const { posted } = await login(port, 'alice', 'alice-pw', '/');
    assert.strictEqual(posted.status, 302, 'a good password is accepted');
    const session = cookieFrom(posted, 'aegis_site');
    assert.ok(session, 'and a session cookie is issued');

    const served = await request(port, { path: '/', headers: { Cookie: 'aegis_site=' + session } });
    assert.strictEqual(served.status, 200);
    assert.match(served.body, /the private site/, 'the site is served to the session');

    // The bind password really made the round trip through AES and BER.
    assert.ok(directory.binds.some((b) => b.dn.startsWith('CN=svc') && b.ok),
        'the service account bound with the decrypted password');
    assert.ok(directory.binds.some((b) => b.dn === USER_DN && b.ok),
        'and the user was bound by their found DN');
    assert.deepStrictEqual(directory.errors, [], 'the directory parsed every message we sent');
});

test('a wrong password never reaches the site and is never echoed back', async (t) => {
    const { port } = await scaffold(t, { allowedGroups: [] });

    const { posted } = await login(port, 'alice', 'not-the-password', '/');
    assert.strictEqual(posted.status, 401);
    assert.ok(!cookieFrom(posted, 'aegis_site'), 'no session is issued');
    assert.ok(!posted.body.includes('not-the-password'), 'the password is not in the page');
    assert.match(posted.body, /alice/, 'the username is kept so the form can be retried');
});

test('group membership is enforced against what the directory really returned', async (t) => {
    const { port } = await scaffold(t, { allowedGroups: ['CN=Nobody,OU=Groups,DC=corp,DC=local'] });

    const { posted } = await login(port, 'alice', 'alice-pw', '/');
    assert.strictEqual(posted.status, 403, 'authenticated but not entitled');
    assert.ok(!cookieFrom(posted, 'aegis_site'), 'and given no session');
});

test('a bare CN in the allow list matches the DN memberOf returned', async (t) => {
    const { port } = await scaffold(t, { allowedGroups: ['Site Viewers'] });

    const { posted } = await login(port, 'alice', 'alice-pw', '/');
    assert.strictEqual(posted.status, 302, 'the shorthand form is accepted');
    assert.ok(cookieFrom(posted, 'aegis_site'), 'and a session is issued');
});

test('the validated next is honoured after login', async (t) => {
    const { port } = await scaffold(t, { allowedGroups: [] });

    const good = await login(port, 'alice', 'alice-pw', '/deep/page.html');
    assert.strictEqual(good.posted.headers.location, '/deep/page.html', 'a real path is kept');

    const evil = await login(port, 'alice', 'alice-pw', '//evil.example.com/');
    assert.strictEqual(evil.posted.headers.location, '/', 'a scheme-relative path is not');
});

test('a site marked protected with no directory configured is refused, never served', async (t) => {
    const { port } = await scaffold(t, { allowedGroups: [], configure: false });

    const res = await request(port, { path: '/' });
    assert.strictEqual(res.status, 503, 'it fails closed');
    assert.ok(!res.body.includes('the private site'), 'and serves nothing');
});

test('an unprotected site is untouched by any of this', async (t) => {
    const { port } = await scaffold(t, { allowedGroups: [], protectedSite: false });

    const res = await request(port, { path: '/' });
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /the private site/, 'served straight through, no redirect');
});

test('turning protection off through the store frees the site on the next request', async (t) => {
    const { tenantPaths, port } = await scaffold(t, { allowedGroups: [] });

    assert.strictEqual((await request(port, { path: '/' })).status, 302, 'protected to begin with');

    const project = projectStore.getProject(tenantPaths, 'demo');
    project.auth = { enabled: false, allowedGroups: [] };
    projectStore.saveProject(tenantPaths, project);
    siteAuth.invalidate(SLUG, 'demo');

    const after = await request(port, { path: '/' });
    assert.strictEqual(after.status, 200, 'and open once the record says so');
    assert.match(after.body, /the private site/);
});

test('the login stylesheet is served even while the directory is unconfigured', async (t) => {
    const { port } = await scaffold(t, { allowedGroups: [], configure: false });

    const css = await request(port, { path: '/__aegis/login.css' });
    assert.strictEqual(css.status, 200, 'so the refusal page is legible');
    assert.match(css.headers['content-type'] || '', /text\/css/);
});

test('the site cannot shadow the reserved prefix', async (t) => {
    const { tenantPaths, port } = await scaffold(t, { allowedGroups: [], protectedSite: false });

    const current = projectStore.currentDir(tenantPaths, 'demo');
    fs.mkdirSync(path.join(current, '__aegis'), { recursive: true });
    fs.writeFileSync(path.join(current, '__aegis', 'login'), 'impostor', 'utf8');

    const res = await request(port, { path: '/__aegis/login' });
    assert.ok(!res.body.includes('impostor'), 'the reserved path is the gate, not a file');
});

test.after(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* windows file locks */ }
});

/* ------------------------------------- what the directory said about you ---- */

/**
 * A refusal the directory explained is a third answer, next to "wrong password"
 * and "the directory is down". It used to be filed under the second: anything
 * that was not `ldap_invalid_credentials` read as the directory being
 * unreachable, so a user whose password had expired was told to try again later
 * about a directory that had in fact answered immediately and precisely.
 */

const DIRECTORY_DOWN = 'directory could not be reached';

test('an expired password is a 401 that says so, not a 502 about the directory', async (t) => {
    const { port } = await scaffold(t, {
        allowedGroups: [],
        refuse: '80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 532, v4563'
    });

    const { posted } = await login(port, 'alice', 'alice-pw', '/');
    assert.strictEqual(posted.status, 401, 'the directory answered, so this is not a 502');
    assert.ok(posted.body.includes('password has expired'), 'the page names the reason');
    assert.ok(!posted.body.includes(DIRECTORY_DOWN), 'and does not blame the directory');
    assert.ok(!cookieFrom(posted, 'aegis_site'), 'no session is issued');
});

test('a disabled account is told it is disabled', async (t) => {
    const { port } = await scaffold(t, {
        allowedGroups: [],
        refuse: '80090308: LdapErr: DSID-0C0903A9, data 533, v4563'
    });

    const { posted } = await login(port, 'alice', 'alice-pw', '/');
    assert.strictEqual(posted.status, 401);
    assert.ok(posted.body.includes('account is disabled'), 'the page names the reason');
    assert.ok(!posted.body.includes(DIRECTORY_DOWN));
});

test('a locked account is told to wait rather than to retype', async (t) => {
    const { port } = await scaffold(t, {
        allowedGroups: [],
        refuse: '80090308: LdapErr: DSID-0C0903A9, data 775, v4563'
    });

    const { posted } = await login(port, 'alice', 'alice-pw', '/');
    assert.strictEqual(posted.status, 401);
    assert.ok(posted.body.includes('account is locked'), 'the page names the reason');
});

test('a refusal the directory did not explain stays the credentials message', async (t) => {
    const { port } = await scaffold(t, {
        allowedGroups: [],
        refuse: '80090308: LdapErr: DSID-0C09044E, data 52e, v4563'
    });

    const { posted } = await login(port, 'alice', 'alice-pw', '/');
    assert.strictEqual(posted.status, 401);
    assert.ok(posted.body.includes('Incorrect username or password'),
        'a wrong password is still a wrong password');
});

test('an unreachable directory is still a 502 and still blames nobody', async (t) => {
    // The class that used to swallow the others. It has to keep working.
    const { port, directory } = await scaffold(t, { allowedGroups: [] });
    await directory.close();

    const { posted } = await login(port, 'alice', 'alice-pw', '/');
    assert.strictEqual(posted.status, 502, 'nothing answered, so this is not the user error');
    assert.ok(posted.body.includes(DIRECTORY_DOWN), 'and the page says which');
    assert.ok(!posted.body.includes('password has expired'));
});
