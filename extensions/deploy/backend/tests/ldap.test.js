/**
 * Tests for the hand-written LDAP client.
 *
 * The interesting half of this file is the fake directory. `verify()` is only
 * as good as the bytes it puts on the wire, and a round trip through our own
 * encoder and our own decoder would agree with itself no matter how wrong both
 * were. So the fake server parses what it receives with its own small BER
 * reader, written independently of `ldap.js`, and asserts the structure of a
 * BindRequest and a SearchRequest field by field before it answers. If the
 * encoder drifts, the server rejects it rather than the client shrugging.
 *
 * Escapes are built from `String.fromCharCode` rather than written as literals,
 * because this file is about backslashes and NUL bytes and a test that quietly
 * escapes its own fixtures proves nothing.
 *
 * Run: node --test tests/ldap.test.js   (from extensions/deploy/backend/)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { X509Certificate } = require('node:crypto');

const ldap = require('../ldap');

const B = String.fromCharCode(92);      // backslash
const NUL = String.fromCharCode(0);

/* ------------------------------------------------- a second BER, by hand -- */

/** Long form above 127 bytes, which every real SearchResultEntry needs. */
function len(n) {
    if (n < 0x80) return Buffer.from([n]);
    const bytes = [];
    let v = n;
    while (v > 0) { bytes.unshift(v & 0xff); v = Math.floor(v / 256); }
    return Buffer.from([0x80 | bytes.length].concat(bytes));
}

function ber(tag, ...payload) {
    const body = Buffer.concat(payload.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(String(p), 'utf8'))));
    return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
}

function int(n) {
    const bytes = [];
    let v = n;
    do { bytes.unshift(v & 0xff); v = Math.floor(v / 256); } while (v > 0);
    if (bytes[0] & 0x80) bytes.unshift(0);
    return ber(0x02, Buffer.from(bytes));
}

function enumr(n) {
    const e = int(n);
    e[0] = 0x0a;
    return e;
}

function str(s) {
    return ber(0x04, Buffer.from(String(s), 'utf8'));
}

/** Minimal reader: returns null when the buffer holds a fragment. */
function readTlv(buf, off) {
    if (buf.length < off + 2) return null;
    const tag = buf[off];
    let length = buf[off + 1];
    let header = 2;
    if (length & 0x80) {
        const count = length & 0x7f;
        if (count === 0 || count > 4) throw new Error('bad length form');
        if (buf.length < off + 2 + count) return null;
        length = 0;
        for (let i = 0; i < count; i++) length = (length * 256) + buf[off + 2 + i];
        header = 2 + count;
    }
    const end = off + header + length;
    if (buf.length < end) return null;
    return { tag, length, value: buf.subarray(off + header, end), end };
}

function tlvChildren(value) {
    const out = [];
    let off = 0;
    while (off < value.length) {
        const tlv = readTlv(value, off);
        if (!tlv) throw new Error('truncated');
        out.push(tlv);
        off = tlv.end;
    }
    return out;
}

function readInt(b) {
    let n = 0;
    for (const byte of b) n = (n * 256) + byte;
    return n;
}

/** A BER Filter back to a plain object, so a test can assert its shape. */
function readFilter(tlv) {
    if (tlv.tag === 0xa0 || tlv.tag === 0xa1) {
        return { type: tlv.tag === 0xa0 ? 'and' : 'or', items: tlvChildren(tlv.value).map(readFilter) };
    }
    if (tlv.tag === 0xa2) return { type: 'not', item: readFilter(tlvChildren(tlv.value)[0]) };
    if (tlv.tag === 0x87) return { type: 'present', attr: tlv.value.toString('utf8') };
    if (tlv.tag === 0xa4) {
        const parts = tlvChildren(tlv.value);
        return {
            type: 'substrings',
            attr: parts[0].value.toString('utf8'),
            pieces: tlvChildren(parts[1].value).map((p) => ({ tag: p.tag, value: p.value.toString('utf8') }))
        };
    }
    if (tlv.tag === 0xa9) {
        // MatchingRuleAssertion: [1] rule, [2] type, [3] value, [4] dnAttributes.
        const out = { type: 'extensible', oid: null, attr: null, value: null, dnAttributes: false };
        for (const part of tlvChildren(tlv.value)) {
            if (part.tag === 0x81) out.oid = part.value.toString('utf8');
            else if (part.tag === 0x82) out.attr = part.value.toString('utf8');
            else if (part.tag === 0x83) out.value = part.value.toString('utf8');
            else if (part.tag === 0x84) out.dnAttributes = part.value[0] !== 0;
            else assert.fail('unexpected field 0x' + part.tag.toString(16) + ' in an extensibleMatch');
        }
        return out;
    }
    const parts = tlvChildren(tlv.value);
    const kind = { 0xa3: 'eq', 0xa5: 'ge', 0xa6: 'le', 0xa8: 'approx' }[tlv.tag];
    assert.ok(kind, 'unknown filter tag 0x' + tlv.tag.toString(16));
    const out = {
        type: kind,
        attr: parts[0].value.toString('utf8'),
        value: parts[1].value.toString('utf8')
    };
    // A binary assertion value such as an objectSid does not survive utf8, so
    // the bytes are kept too. Non-enumerable: several tests assert a whole
    // filter with deepStrictEqual, and a field they never asked about must not
    // make them fail.
    Object.defineProperty(out, 'raw', { value: Buffer.from(parts[1].value), enumerable: false });
    return out;
}

/* ----------------------------------------------------- the fake directory -- */

function assertBindRequest(op, seen) {
    assert.strictEqual(op.tag, 0x60, 'BindRequest is [APPLICATION 0]');
    const parts = tlvChildren(op.value);
    assert.strictEqual(parts.length, 3, 'BindRequest carries version, name and authentication');
    assert.strictEqual(parts[0].tag, 0x02, 'version is an INTEGER');
    assert.strictEqual(readInt(parts[0].value), 3, 'version is 3');
    assert.strictEqual(parts[1].tag, 0x04, 'name is an OCTET STRING');
    assert.strictEqual(parts[2].tag, 0x80, 'simple authentication is [0] primitive');
    seen.push({
        op: 'bind',
        dn: parts[1].value.toString('utf8'),
        password: parts[2].value.toString('utf8')
    });
    return seen[seen.length - 1];
}

function assertSearchRequest(op, seen) {
    assert.strictEqual(op.tag, 0x63, 'SearchRequest is [APPLICATION 3]');
    const parts = tlvChildren(op.value);
    assert.strictEqual(parts.length, 8, 'SearchRequest carries eight fields');
    assert.strictEqual(parts[0].tag, 0x04, 'baseObject is an OCTET STRING');
    assert.strictEqual(parts[1].tag, 0x0a, 'scope is an ENUMERATED');
    assert.strictEqual(readInt(parts[1].value), 2, 'scope is wholeSubtree');
    assert.strictEqual(parts[2].tag, 0x0a, 'derefAliases is an ENUMERATED');
    assert.strictEqual(parts[3].tag, 0x02, 'sizeLimit is an INTEGER');
    assert.strictEqual(parts[4].tag, 0x02, 'timeLimit is an INTEGER');
    assert.strictEqual(parts[5].tag, 0x01, 'typesOnly is a BOOLEAN');
    assert.strictEqual(parts[7].tag, 0x30, 'attributes is a SEQUENCE');
    seen.push({
        op: 'search',
        baseDn: parts[0].value.toString('utf8'),
        sizeLimit: readInt(parts[3].value),
        filter: readFilter(parts[6]),
        attributes: tlvChildren(parts[7].value).map((a) => a.value.toString('utf8'))
    });
    return seen[seen.length - 1];
}

/** An attribute value: a Buffer goes out as its bytes, anything else as utf8. */
function attrValue(v) {
    return Buffer.isBuffer(v) ? ber(0x04, v) : str(v);
}

function entryMessage(id, entry) {
    const attrs = Object.keys(entry.attrs || {}).map((name) => ber(
        0x30,
        str(name),
        ber(0x31, ...entry.attrs[name].map(attrValue))
    ));
    return ber(0x30, int(id), ber(0x64, str(entry.dn), ber(0x30, ...attrs)));
}

function resultMessage(id, tag, code, diagnostic) {
    return ber(0x30, int(id), ber(tag, enumr(code), str(''), str(diagnostic || '')));
}

/**
 * A directory that answers in BER and checks what it is asked.
 *
 * `split` writes every response in three pieces across turns of the event loop,
 * which is the only way to prove the client reassembles rather than assuming a
 * response arrives whole.
 */
function startFake(options) {
    const opts = options || {};
    const state = { seen: [], errors: [], connections: 0, closed: 0, sockets: [], queues: new Map() };

    /**
     * One queue per socket, drained a piece at a time.
     *
     * Splitting each response independently would let the pieces of two
     * responses interleave, which tests nothing except that a scrambled stream
     * fails. The queue keeps the byte order the directory would produce and
     * still delivers it across several turns of the event loop.
     */
    function reply(sock, buf) {
        if (!opts.split) { sock.write(buf); return; }
        const q = state.queues.get(sock);
        if (buf.length < 3) q.chunks.push(buf);
        else q.chunks.push(buf.subarray(0, 1), buf.subarray(1, buf.length - 1), buf.subarray(buf.length - 1));
        if (q.draining) return;
        q.draining = true;
        setImmediate(function step() {
            const chunk = q.chunks.shift();
            if (!chunk) { q.draining = false; return; }
            if (!sock.destroyed) sock.write(chunk);
            setImmediate(step);
        });
    }

    function onMessage(sock, msg) {
        assert.strictEqual(msg.tag, 0x30, 'LDAPMessage is a SEQUENCE');
        const parts = tlvChildren(msg.value);
        assert.ok(parts.length >= 2, 'LDAPMessage carries an id and an operation');
        assert.strictEqual(parts[0].tag, 0x02, 'messageID is an INTEGER');
        const id = readInt(parts[0].value);
        assert.ok(id > 0, 'messageID starts at one');
        const op = parts[1];

        if (op.tag === 0x42) {
            assert.strictEqual(op.length, 0, 'UnbindRequest has no content');
            state.seen.push({ op: 'unbind' });
            sock.destroy();
            return;
        }

        if (op.tag === 0x77) {
            const oid = tlvChildren(op.value)[0];
            assert.strictEqual(oid.tag, 0x80, 'requestName is [0] primitive');
            state.seen.push({ op: 'extended', oid: oid.value.toString('utf8') });
            reply(sock, resultMessage(id, 0x78, opts.startTlsResult === undefined ? 0 : opts.startTlsResult,
                'StartTLS not available on this fake'));
            return;
        }

        if (op.tag === 0x60) {
            const seen = assertBindRequest(op, state.seen);
            const binds = state.seen.filter((s) => s.op === 'bind').length;
            const res = opts.onBind ? opts.onBind(seen.dn, seen.password, binds - 1) : { resultCode: 0 };
            reply(sock, resultMessage(id, 0x61, res.resultCode, res.diagnostic));
            return;
        }

        if (op.tag === 0x63) {
            const seenSearch = assertSearchRequest(op, state.seen);
            if (opts.silentSearch) return;
            // `onSearch` exists because resolving nested groups issues three
            // searches on one connection -- the user, the group closure, the
            // primary group -- and a single `entries` list would answer all
            // three the same way, which is the one thing these tests must not
            // do. It may also throw, standing in for a directory that refuses.
            let entries;
            if (opts.onSearch) {
                const searches = state.seen.filter((s) => s.op === 'search').length;
                const answer = opts.onSearch(seenSearch, searches - 1);
                if (answer && answer.resultCode) {
                    reply(sock, resultMessage(id, 0x65, answer.resultCode, answer.diagnostic || ''));
                    return;
                }
                entries = (answer && answer.entries) || [];
            } else {
                entries = opts.entries || [];
            }
            for (const entry of entries) reply(sock, entryMessage(id, entry));
            if (opts.reference) {
                reply(sock, ber(0x30, int(id), ber(0x73, str('ldap://other.corp.local/DC=corp,DC=local'))));
            }
            reply(sock, resultMessage(id, 0x65, opts.searchResult || 0, ''));
            return;
        }

        throw new Error('unexpected operation tag 0x' + op.tag.toString(16));
    }

    const onConnection = (sock) => {
        state.connections++;
        state.sockets.push(sock);
        state.queues.set(sock, { chunks: [], draining: false });
        let buf = Buffer.alloc(0);
        sock.on('error', () => { /* the client destroys the socket on the way out */ });
        sock.on('close', () => { state.closed++; });
        sock.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            if (opts.silent) return;
            try {
                for (;;) {
                    const msg = readTlv(buf, 0);
                    if (!msg) return;
                    buf = Buffer.from(buf.subarray(msg.end));
                    onMessage(sock, msg);
                }
            } catch (e) {
                state.errors.push(e.message);
                sock.destroy();
            }
        });
    };

    const server = opts.tls ? tls.createServer(opts.tls, onConnection) : net.createServer(onConnection);

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            state.port = server.address().port;
            state.url = (opts.tls ? 'ldaps' : 'ldap') + '://127.0.0.1:' + state.port;
            state.close = () => new Promise((done) => {
                for (const s of state.sockets) s.destroy();
                server.close(() => done());
            });
            resolve(state);
        });
    });
}

/** Polls a condition rather than sleeping a fixed time on a busy machine. */
async function waitFor(condition, budgetMs) {
    const until = Date.now() + (budgetMs || 2000);
    while (Date.now() < until) {
        if (condition()) return true;
        await new Promise((r) => setTimeout(r, 10));
    }
    return condition();
}

const LONG_GROUP = 'CN=Domain Admins,OU=' + 'G'.repeat(140) + ',DC=corp,DC=local';

const SEARCH_CONFIG = {
    bindDn: 'CN=svc-aegis,OU=Service,DC=corp,DC=local',
    bindPassword: 'service-secret',
    baseDn: 'DC=corp,DC=local',
    userFilter: '(&(objectClass=user)(sAMAccountName={username}))',
    groupAttribute: 'memberOf',
    timeoutMs: 3000
};

function userEntry() {
    return {
        dn: 'CN=Alice Martin,OU=Users,DC=corp,DC=local',
        attrs: {
            memberOf: [LONG_GROUP, 'CN=Deploy Readers,OU=Groups,DC=corp,DC=local', 'CN=Everyone,DC=corp,DC=local'],
            displayName: ['Alice Martin'],
            cn: ['Alice Martin']
        }
    };
}

/* ------------------------------------------------------------------ BER ---- */

test('encode uses the short length form under 128 bytes', () => {
    const out = ldap.encode(0x04, Buffer.alloc(5, 0x41));
    assert.deepStrictEqual(Array.from(out.subarray(0, 2)), [0x04, 0x05]);
    assert.strictEqual(out.length, 7);
});

test('encode uses the long length form above 127 bytes', () => {
    const one = ldap.encode(0x04, Buffer.alloc(200, 0x41));
    assert.deepStrictEqual(Array.from(one.subarray(0, 3)), [0x04, 0x81, 0xc8]);
    assert.strictEqual(one.length, 203);

    const two = ldap.encode(0x04, Buffer.alloc(4096, 0x41));
    assert.deepStrictEqual(Array.from(two.subarray(0, 4)), [0x04, 0x82, 0x10, 0x00]);
    assert.strictEqual(two.length, 4100);
});

test('decode reads both length forms and reports where the element ends', () => {
    const short = ldap.encode(0x04, Buffer.from('hello', 'utf8'));
    const shortTlv = ldap.decode(short, 0);
    assert.strictEqual(shortTlv.tag, 0x04);
    assert.strictEqual(shortTlv.headerLength, 2);
    assert.strictEqual(shortTlv.value.toString('utf8'), 'hello');
    assert.strictEqual(shortTlv.end, short.length);

    const long = ldap.encode(0x04, Buffer.alloc(300, 0x42));
    const longTlv = ldap.decode(long, 0);
    assert.strictEqual(longTlv.headerLength, 4);
    assert.strictEqual(longTlv.length, 300);
    assert.strictEqual(longTlv.end, long.length);
});

test('decode returns null on a fragment instead of guessing', () => {
    const full = ldap.encode(0x04, Buffer.alloc(300, 0x42));
    assert.strictEqual(ldap.decode(Buffer.alloc(0), 0), null);
    assert.strictEqual(ldap.decode(full.subarray(0, 1), 0), null);
    assert.strictEqual(ldap.decode(full.subarray(0, 3), 0), null, 'long length octets not all present');
    assert.strictEqual(ldap.decode(full.subarray(0, full.length - 1), 0), null, 'value not all present');
    assert.ok(ldap.decode(full, 0), 'the whole element decodes');
});

test('decode refuses the indefinite length form', () => {
    assert.throws(() => ldap.decode(Buffer.from([0x30, 0x80, 0x00, 0x00]), 0), /ldap_protocol_error/);
});

test('a BindRequest survives a round trip through encode and decode', () => {
    const request = ldap.encode(0x30, [
        ldap.encode(0x02, Buffer.from([1])),
        ldap.encode(0x60, [
            ldap.encode(0x02, Buffer.from([3])),
            ldap.encode(0x04, Buffer.from('CN=svc,DC=corp,DC=local', 'utf8')),
            ldap.encode(0x80, Buffer.from('p'.repeat(200), 'utf8'))
        ])
    ]);

    const message = ldap.decode(request, 0);
    assert.strictEqual(message.tag, 0x30);
    assert.strictEqual(message.end, request.length);

    const id = ldap.decode(message.value, 0);
    assert.strictEqual(id.tag, 0x02);
    assert.strictEqual(id.value[0], 1);

    const op = ldap.decode(message.value, id.end);
    assert.strictEqual(op.tag, 0x60, 'BindRequest is [APPLICATION 0]');

    const version = ldap.decode(op.value, 0);
    const name = ldap.decode(op.value, version.end);
    const auth = ldap.decode(op.value, name.end);
    assert.strictEqual(version.value[0], 3);
    assert.strictEqual(name.value.toString('utf8'), 'CN=svc,DC=corp,DC=local');
    assert.strictEqual(auth.tag, 0x80, 'simple authentication keeps its context tag');
    assert.strictEqual(auth.value.length, 200, 'a long password keeps the long length form');
    assert.strictEqual(auth.end, op.value.length, 'nothing is left over');
});

/* ------------------------------------------------------------- escaping --- */

test('escapeFilter applies RFC 4515 to every reserved character', () => {
    assert.strictEqual(ldap.escapeFilter('*'), B + '2a');
    assert.strictEqual(ldap.escapeFilter('('), B + '28');
    assert.strictEqual(ldap.escapeFilter(')'), B + '29');
    assert.strictEqual(ldap.escapeFilter(B), B + '5c');
    assert.strictEqual(ldap.escapeFilter(NUL), B + '00');
    assert.strictEqual(ldap.escapeFilter('alice'), 'alice');
    assert.strictEqual(ldap.escapeFilter(''), '');
    assert.strictEqual(ldap.escapeFilter(null), '');
});

test('escapeFilter does not escape its own output', () => {
    // The backslash it emits must not be re-escaped into 5c5c, which is what a
    // sequence of single-character replaces would do.
    assert.strictEqual(ldap.escapeFilter(B + '2a'), B + '5c' + '2a');
    assert.strictEqual(ldap.escapeFilter('a*b'), 'a' + B + '2ab');
});

test('escapeFilter closes the filter injection', () => {
    const injected = ldap.escapeFilter(')(objectClass=*');
    assert.ok(!injected.includes('('), 'no bare parenthesis survives');
    assert.ok(!injected.includes(')'), 'no bare parenthesis survives');
    assert.ok(!injected.includes('*'), 'no bare wildcard survives');
});

test('escapeDn applies RFC 4514 to the characters that end an RDN', () => {
    assert.strictEqual(ldap.escapeDn('a,b'), 'a' + B + ',b');
    assert.strictEqual(ldap.escapeDn('a+b'), 'a' + B + '+b');
    assert.strictEqual(ldap.escapeDn('a="b"'), 'a' + B + '=' + B + '"b' + B + '"');
    assert.strictEqual(ldap.escapeDn('a<b>c;d'), 'a' + B + '<b' + B + '>c' + B + ';d');
    assert.strictEqual(ldap.escapeDn(B), B + B);
    assert.strictEqual(ldap.escapeDn(NUL), B + '00');
    assert.strictEqual(ldap.escapeDn('#tag'), B + '#tag');
    assert.strictEqual(ldap.escapeDn(' pad '), B + ' pad' + B + ' ');
    assert.strictEqual(ldap.escapeDn('alice'), 'alice', 'a logon name is untouched');
});

/* ---------------------------------------------------- fail closed, no I/O -- */

test('an empty password is refused before a socket is opened', async (t) => {
    const fake = await startFake({});
    t.after(() => fake.close());

    const config = Object.assign({ url: fake.url }, SEARCH_CONFIG);
    for (const password of ['', null, undefined]) {
        const out = await ldap.verify(config, 'alice', password);
        assert.deepStrictEqual(out, { ok: false, error: 'ldap_invalid_credentials' });
    }
    // The point of the rule: an empty simple bind is an anonymous bind that the
    // directory answers with success, so the directory must never be asked.
    assert.strictEqual(fake.connections, 0, 'no connection was opened');
    assert.deepStrictEqual(fake.seen, []);
});

test('an empty or control-laden username is refused before a socket is opened', async (t) => {
    const fake = await startFake({});
    t.after(() => fake.close());

    const config = Object.assign({ url: fake.url }, SEARCH_CONFIG);
    for (const user of ['', '   ', 'ali' + NUL + 'ce']) {
        const out = await ldap.verify(config, user, 'right-password');
        assert.deepStrictEqual(out, { ok: false, error: 'ldap_invalid_credentials' });
    }
    assert.strictEqual(fake.connections, 0);
});

test('a broken configuration is ldap_bad_config and opens nothing', async () => {
    const cases = [
        {},
        { url: 'http://dc01.corp.local' },
        { url: 'not a url' },
        { url: 'ldap://dc01.corp.local', baseDn: '', userFilter: '(cn={username})' },
        { url: 'ldap://dc01.corp.local', baseDn: 'DC=corp', userFilter: '' },
        { url: 'ldap://dc01.corp.local', baseDn: 'DC=corp', userFilter: '(&(cn={username})' },
        { url: 'ldap://dc01.corp.local', baseDn: 'DC=corp', userFilter: '(cn={username})', bindDn: 'CN=svc', bindPassword: '' }
    ];
    for (const config of cases) {
        const out = await ldap.verify(config, 'alice', 'right-password');
        assert.deepStrictEqual(out, { ok: false, error: 'ldap_bad_config' }, JSON.stringify(config));
    }
});

/* ------------------------------------------------------- verify, on wires -- */

test('verify binds, searches, re-binds, and returns the groups it already read', async (t) => {
    const fake = await startFake({ entries: [userEntry()], reference: true });
    t.after(() => fake.close());

    const out = await ldap.verify(Object.assign({ url: fake.url }, SEARCH_CONFIG), 'alice', 'her-password');
    assert.deepStrictEqual(fake.errors, [], 'the fake directory accepted every request');

    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.dn, 'CN=Alice Martin,OU=Users,DC=corp,DC=local');
    assert.strictEqual(out.displayName, 'Alice Martin');
    assert.deepStrictEqual(out.groups, [
        LONG_GROUP,
        'CN=Deploy Readers,OU=Groups,DC=corp,DC=local',
        'CN=Everyone,DC=corp,DC=local'
    ], 'every value of a multi-valued memberOf survives, including one over 127 bytes');

    const ops = fake.seen.filter((s) => s.op !== 'unbind');
    assert.deepStrictEqual(ops.map((s) => s.op), ['bind', 'search', 'bind'],
        'service bind, search, user bind, and no privileged search after the user bind');
    assert.strictEqual(ops[0].dn, SEARCH_CONFIG.bindDn);
    assert.strictEqual(ops[0].password, SEARCH_CONFIG.bindPassword);
    assert.strictEqual(ops[1].baseDn, 'DC=corp,DC=local');
    assert.ok(ops[1].attributes.includes('memberOf'), 'the group attribute is asked for');
    assert.strictEqual(ops[2].dn, 'CN=Alice Martin,OU=Users,DC=corp,DC=local',
        'the second bind uses the DN the search returned');
    assert.strictEqual(ops[2].password, 'her-password');

    assert.ok(!JSON.stringify(out).includes('her-password'), 'no password in the result');
    assert.ok(!JSON.stringify(out).includes('service-secret'), 'no bind password in the result');
});

test('the username is escaped before it reaches the filter', async (t) => {
    const fake = await startFake({ entries: [] });
    t.after(() => fake.close());

    const injection = '*)(objectClass=*';
    await ldap.verify(Object.assign({ url: fake.url }, SEARCH_CONFIG), injection, 'her-password');
    assert.deepStrictEqual(fake.errors, []);

    const search = fake.seen.find((s) => s.op === 'search');
    assert.deepStrictEqual(search.filter, {
        type: 'and',
        items: [
            { type: 'eq', attr: 'objectClass', value: 'user' },
            { type: 'eq', attr: 'sAMAccountName', value: injection }
        ]
    }, 'the injection stayed one assertion value instead of becoming filter structure');
});

test('a response split across several packets is reassembled', async (t) => {
    const fake = await startFake({ entries: [userEntry()], split: true });
    t.after(() => fake.close());

    const out = await ldap.verify(Object.assign({ url: fake.url }, SEARCH_CONFIG), 'alice', 'her-password');
    assert.deepStrictEqual(fake.errors, []);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.groups.length, 3);
});

test('a wrong password is ldap_invalid_credentials', async (t) => {
    const fake = await startFake({
        entries: [userEntry()],
        onBind: (dn, password, index) => (index === 0
            ? { resultCode: 0 }
            : { resultCode: 49, diagnostic: '80090308: LdapErr: DSID-0C09044E, data 52e' })
    });
    t.after(() => fake.close());

    const out = await ldap.verify(Object.assign({ url: fake.url }, SEARCH_CONFIG), 'alice', 'wrong');
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_invalid_credentials' });
});

test('a service account the directory rejects is ldap_bind_refused', async (t) => {
    const fake = await startFake({ onBind: () => ({ resultCode: 49, diagnostic: 'data 52e' }) });
    t.after(() => fake.close());

    const config = Object.assign({ url: fake.url }, SEARCH_CONFIG);
    assert.deepStrictEqual(await ldap.verify(config, 'alice', 'her-password'),
        { ok: false, error: 'ldap_bind_refused' });
    assert.deepStrictEqual(fake.seen.filter((s) => s.op === 'search'), [],
        'no search is attempted once the service bind failed');
});

test('a DC that demands LDAP signing is ldap_bind_refused, not a bad password', async (t) => {
    // strongerAuthRequired (8) is what a hardened DC answers to a simple bind on
    // an unprotected connection whatever the password is.
    const fake = await startFake({
        entries: [userEntry()],
        onBind: (dn, password, index) => (index === 0 ? { resultCode: 0 } : { resultCode: 8, diagnostic: 'stronger auth required' })
    });
    t.after(() => fake.close());

    const out = await ldap.verify(Object.assign({ url: fake.url }, SEARCH_CONFIG), 'alice', 'her-password');
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_bind_refused' });
});

/* --------------------------------------------- AD sub-codes on result 49 ---- */

/**
 * Active Directory answers a great many different situations with result 49 and
 * tells them apart only in the diagnostic message, as `data <hex>`. Reading
 * every one of them as "wrong password" sends a user whose password expired to
 * try the same password again, and their administrator looking for a fault in
 * Aegis.
 *
 * `verify` already receives the string. These tests fix what it does with it.
 */

/** A refusal on the user bind, with the diagnostic AD would send. */
async function refusalFor(t, diagnostic) {
    const fake = await startFake({
        entries: [userEntry()],
        onBind: (dn, password, index) => (index === 0
            ? { resultCode: 0 }
            : { resultCode: 49, diagnostic })
    });
    t.after(() => fake.close());
    return ldap.verify(Object.assign({ url: fake.url }, SEARCH_CONFIG), 'alice', 'her-password');
}

test('a password that expired is not reported as a wrong password', async (t) => {
    const out = await refusalFor(t, '80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 532, v4563');
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_password_expired' });
});

test('a password the user must change at next logon says so', async (t) => {
    const out = await refusalFor(t, '80090308: LdapErr: DSID-0C0903A9, data 773, v4563');
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_password_must_change' });
});

test('a disabled account says so instead of blaming the password', async (t) => {
    const out = await refusalFor(t, '80090308: LdapErr: DSID-0C0903A9, data 533, v4563');
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_account_disabled' });
});

test('a locked-out account says so, because waiting is the fix', async (t) => {
    const out = await refusalFor(t, '80090308: LdapErr: DSID-0C0903A9, data 775, v4563');
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_account_locked' });
});

test('an expired account is not a locked one', async (t) => {
    const out = await refusalFor(t, '80090308: LdapErr: DSID-0C0903A9, data 701, v4563');
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_account_expired' });
});

test('logon-hours and workstation restrictions read as a refused logon', async (t) => {
    assert.deepStrictEqual(await refusalFor(t, 'LdapErr: data 530, v4563'),
        { ok: false, error: 'ldap_logon_denied' });
    assert.deepStrictEqual(await refusalFor(t, 'LdapErr: data 531, v4563'),
        { ok: false, error: 'ldap_logon_denied' });
});

test('a wrong password stays ldap_invalid_credentials', async (t) => {
    const out = await refusalFor(t, '80090308: LdapErr: DSID-0C09044E, data 52e, v4563');
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_invalid_credentials' });
});

test('an unknown user stays ldap_invalid_credentials, and never says so', async (t) => {
    // `data 525` is "there is no such account". Passing that back to an
    // unauthenticated visitor turns the login form into an account enumerator,
    // which is the one sub-code worth losing.
    const out = await refusalFor(t, '80090308: LdapErr: DSID-0C09044E, data 525, v4563');
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_invalid_credentials' });
});

test('a 49 with no sub-code stays ldap_invalid_credentials', async (t) => {
    // Not every directory is Active Directory, and the ones that are not send
    // 49 with a message that carries no `data` at all.
    const out = await refusalFor(t, 'invalid credentials');
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_invalid_credentials' });
});

test('the sub-code is read whatever the case and however it is spaced', async (t) => {
    assert.deepStrictEqual(await refusalFor(t, 'LdapErr: DATA 532'),
        { ok: false, error: 'ldap_password_expired' });
    assert.deepStrictEqual(await refusalFor(t, 'LdapErr: data  533,'),
        { ok: false, error: 'ldap_account_disabled' });
});

test('a sub-code this build does not know stays ldap_invalid_credentials', async (t) => {
    // A number Microsoft adds later, or a directory that writes `data` for its
    // own reasons, must not become a refusal nobody can read.
    const out = await refusalFor(t, 'LdapErr: data 999, v4563');
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_invalid_credentials' });
});

test('a sub-code longer than a sub-code is not read as one', async (t) => {
    // `data 5320000` is not `data 532`. Anchoring the match keeps a long number
    // from being truncated into a meaning it does not have.
    const out = await refusalFor(t, 'LdapErr: data 5320000, v4563');
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_invalid_credentials' });
});

test('no matching entry is ldap_user_not_found', async (t) => {
    const fake = await startFake({ entries: [] });
    t.after(() => fake.close());

    const out = await ldap.verify(Object.assign({ url: fake.url }, SEARCH_CONFIG), 'ghost', 'her-password');
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_user_not_found' });
    assert.strictEqual(fake.seen.filter((s) => s.op === 'bind').length, 1, 'the user bind never happened');
});

test('two matching entries is ldap_ambiguous_user', async (t) => {
    const second = userEntry();
    second.dn = 'CN=Alice Martin,OU=Contractors,DC=corp,DC=local';
    const fake = await startFake({ entries: [userEntry(), second] });
    t.after(() => fake.close());

    const out = await ldap.verify(Object.assign({ url: fake.url }, SEARCH_CONFIG), 'alice', 'her-password');
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_ambiguous_user' });
    assert.strictEqual(fake.seen.filter((s) => s.op === 'bind').length, 1, 'no bind against an ambiguous match');
});

test('userDnTemplate binds directly and issues no search', async (t) => {
    const fake = await startFake({});
    t.after(() => fake.close());

    const config = {
        url: fake.url,
        userDnTemplate: '{username}@corp.local',
        timeoutMs: 3000
    };
    const out = await ldap.verify(config, 'alice', 'her-password');
    assert.deepStrictEqual(fake.errors, []);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.dn, 'alice@corp.local');
    assert.deepStrictEqual(out.groups, []);

    const ops = fake.seen.filter((s) => s.op !== 'unbind');
    assert.deepStrictEqual(ops.map((s) => s.op), ['bind'], 'a direct bind and nothing else');
    assert.strictEqual(ops[0].password, 'her-password');
});

test('userDnTemplate escapes the username into the template', async (t) => {
    const fake = await startFake({});
    t.after(() => fake.close());

    const config = {
        url: fake.url,
        userDnTemplate: 'CN={username},OU=Users,DC=corp,DC=local',
        timeoutMs: 3000
    };
    await ldap.verify(config, 'evil,OU=Admins', 'her-password');
    const bind = fake.seen.find((s) => s.op === 'bind');
    // The equals sign is escaped too. RFC 4514 lists it as a special that a
    // pair may escape, so this is legal and leaves the attacker with one RDN.
    assert.strictEqual(bind.dn, 'CN=evil' + B + ',OU' + B + '=Admins,OU=Users,DC=corp,DC=local',
        'the comma cannot end the RDN and move the bind to another branch');
});

test('userDnTemplate with a base and a filter reads the groups as the user', async (t) => {
    const fake = await startFake({ entries: [userEntry()] });
    t.after(() => fake.close());

    const config = {
        url: fake.url,
        userDnTemplate: '{username}@corp.local',
        baseDn: 'DC=corp,DC=local',
        userFilter: '(&(objectClass=user)(sAMAccountName={username}))',
        timeoutMs: 3000
    };
    const out = await ldap.verify(config, 'alice', 'her-password');
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.groups.length, 3);
    assert.deepStrictEqual(fake.seen.filter((s) => s.op !== 'unbind').map((s) => s.op), ['bind', 'search']);
});

test('a directory that never answers is ldap_timeout, and the socket is closed', async (t) => {
    const fake = await startFake({ silent: true });
    t.after(() => fake.close());

    const started = Date.now();
    const config = Object.assign({ url: fake.url }, SEARCH_CONFIG, { timeoutMs: 250 });
    const out = await ldap.verify(config, 'alice', 'her-password');
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_timeout' });
    assert.ok(Date.now() - started < 3000, 'the deadline fired rather than the default');
    assert.ok(await waitFor(() => fake.closed >= 1), 'the client closed the connection on its way out');
});

test('a search that never completes is ldap_timeout', async (t) => {
    const fake = await startFake({ silentSearch: true });
    t.after(() => fake.close());

    const config = Object.assign({ url: fake.url }, SEARCH_CONFIG, { timeoutMs: 250 });
    const out = await ldap.verify(config, 'alice', 'her-password');
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_timeout' });
});

test('nothing listening is ldap_unreachable', async () => {
    const fake = await startFake({});
    const url = fake.url;
    await fake.close();

    const out = await ldap.verify(Object.assign({}, SEARCH_CONFIG, { url, timeoutMs: 2000 }), 'alice', 'her-password');
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_unreachable' });
});

/* ---------------------------------------------------------------- StartTLS - */

test('StartTLS sends the right extended request and a refusal is fatal', async (t) => {
    const fake = await startFake({ startTlsResult: 1 });
    t.after(() => fake.close());

    const config = Object.assign({ url: fake.url }, SEARCH_CONFIG, { startTls: true, timeoutMs: 2000 });
    const out = await ldap.verify(config, 'alice', 'her-password');
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_tls_failed' });

    const extended = fake.seen.find((s) => s.op === 'extended');
    assert.strictEqual(extended.oid, '1.3.6.1.4.1.1466.20037');
    assert.deepStrictEqual(fake.seen.filter((s) => s.op === 'bind'), [],
        'a refused StartTLS never falls back to a plaintext bind');
});

/* -------------------------------------------------------------- ldaps:// -- */

/**
 * A throwaway certificate, built at run time in the system temp directory.
 *
 * Never in the repository: the workspace rule is that no key material sits in
 * this tree even when gitignored, and a test key is still key material. When
 * openssl is not on the path the two ldaps tests skip rather than fail, because
 * the rest of the file still covers everything that does not need a handshake.
 */
function selfSignedPair(subject, altName) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-ldap-test-'));
    const keyFile = path.join(dir, 'key.pem');
    const certFile = path.join(dir, 'cert.pem');
    const run = spawnSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyFile, '-out', certFile, '-days', '1',
        '-subj', subject || '/CN=localhost',
        '-addext', 'subjectAltName=' + (altName || 'IP:127.0.0.1')
    ], { stdio: 'ignore' });
    if (run.status !== 0) {
        fs.rmSync(dir, { recursive: true, force: true });
        return null;
    }
    const pair = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
    fs.rmSync(dir, { recursive: true, force: true });
    return pair;
}

test('ldaps carries a whole verify over TLS', async (t) => {
    const pair = selfSignedPair();
    if (!pair) return t.skip('openssl is not available to build a test certificate');

    const fake = await startFake({ tls: pair, entries: [userEntry()] });
    t.after(() => fake.close());

    const config = Object.assign({ url: fake.url }, SEARCH_CONFIG, { rejectUnauthorized: false });
    const out = await ldap.verify(config, 'alice', 'her-password');
    assert.deepStrictEqual(fake.errors, []);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.groups.length, 3);
    assert.deepStrictEqual(fake.seen.filter((s) => s.op !== 'unbind').map((s) => s.op), ['bind', 'search', 'bind']);
});

test('rejectUnauthorized is honoured and an untrusted DC is ldap_tls_untrusted', async (t) => {
    const pair = selfSignedPair();
    if (!pair) return t.skip('openssl is not available to build a test certificate');

    const fake = await startFake({ tls: pair, entries: [userEntry()] });
    t.after(() => fake.close());

    // No rejectUnauthorized in the config: the default must be to validate.
    const out = await ldap.verify(Object.assign({ url: fake.url }, SEARCH_CONFIG), 'alice', 'her-password');
    // Its own code, not the shared `ldap_tls_failed`: this is the one TLS fault
    // the page can repair by pinning, and it has to be distinguishable from an
    // expired certificate or a wrong name, which pinning does nothing for.
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_tls_untrusted' });
    assert.deepStrictEqual(fake.seen, [], 'nothing was sent over an unvalidated connection');
});

test('a certificate issued for another name is ldap_tls_name_mismatch', async (t) => {
    // Issued for a controller name, reached at an address. This is the everyday
    // shape of the failure: the form was filled with the domain or the IP, the
    // controller answers, and its certificate names the host instead.
    const pair = selfSignedPair('/CN=dc01.corp.local', 'DNS:dc01.corp.local');
    if (!pair) return t.skip('openssl is not available to build a test certificate');

    const fake = await startFake({ tls: pair, entries: [userEntry()] });
    t.after(() => fake.close());

    // Pinned, so trust cannot be what fails here and the name check is the only
    // thing left that can. The two used to arrive as the same code and the same
    // useless advice.
    const config = Object.assign({ url: fake.url }, SEARCH_CONFIG,
        { trustedCa: [pair.cert.toString('utf8')] });
    const out = await ldap.verify(config, 'alice', 'her-password');
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_tls_name_mismatch' });
    assert.deepStrictEqual(fake.seen, [], 'no bind on a connection that failed the name check');
});

test('inspectCertificate names the host the certificate is actually for', async (t) => {
    const pair = selfSignedPair('/CN=dc01.corp.local', 'DNS:dc01.corp.local');
    if (!pair) return t.skip('openssl is not available to build a test certificate');

    const fake = await startFake({ tls: pair, entries: [userEntry()] });
    t.after(() => fake.close());

    // What lets the page offer "use dc01.corp.local instead" as a button rather
    // than as a paragraph telling the operator to go and find out.
    const out = await ldap.inspectCertificate(Object.assign({ url: fake.url }, SEARCH_CONFIG));
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.hostMatches, false);
    assert.deepStrictEqual(out.names, ['dc01.corp.local']);
});

test('a pinned authority validates the connection instead of switching validation off', async (t) => {
    const pair = selfSignedPair();
    if (!pair) return t.skip('openssl is not available to build a test certificate');

    const fake = await startFake({ tls: pair, entries: [userEntry()] });
    t.after(() => fake.close());

    // The point of the whole feature: `rejectUnauthorized` is left at its
    // default of true and the handshake still succeeds, because the authority
    // is trusted rather than the check skipped.
    const config = Object.assign({ url: fake.url }, SEARCH_CONFIG,
        { trustedCa: [pair.cert.toString('utf8')] });
    const out = await ldap.verify(config, 'alice', 'her-password');
    assert.deepStrictEqual(fake.errors, []);
    assert.strictEqual(out.ok, true, `expected a bind, got ${JSON.stringify(out)}`);
    assert.strictEqual(out.groups.length, 3);
});

test('rubbish in trustedCa is dropped rather than handed to OpenSSL', async (t) => {
    const pair = selfSignedPair();
    if (!pair) return t.skip('openssl is not available to build a test certificate');

    const fake = await startFake({ tls: pair, entries: [userEntry()] });
    t.after(() => fake.close());

    const config = Object.assign({ url: fake.url }, SEARCH_CONFIG, {
        trustedCa: ['not a certificate', '', null, 42, pair.cert.toString('utf8')]
    });
    const out = await ldap.verify(config, 'alice', 'her-password');
    assert.strictEqual(out.ok, true, 'the one real certificate still works');
});

/* ----------------------------------------------------- inspectCertificate -- */

test('inspectCertificate describes the chain and never binds', async (t) => {
    const pair = selfSignedPair();
    if (!pair) return t.skip('openssl is not available to build a test certificate');

    const fake = await startFake({ tls: pair, entries: [userEntry()] });
    t.after(() => fake.close());

    const out = await ldap.inspectCertificate(Object.assign({ url: fake.url }, SEARCH_CONFIG));
    assert.strictEqual(out.ok, true, `expected a chain, got ${JSON.stringify(out)}`);

    // The fingerprint is the field an operator compares before pinning, so it
    // has to be the certificate's own and not something we composed.
    const expected = new X509Certificate(pair.cert).fingerprint256;
    assert.strictEqual(out.anchor.fingerprint256, expected);
    assert.strictEqual(out.hostMatches, true);
    assert.strictEqual(out.chain.length, 1, 'a self-signed certificate is its own anchor');
    assert.match(out.anchor.pem, /^-----BEGIN CERTIFICATE-----/);

    // The probe exists so an operator can look at a certificate that did not
    // validate. Sending the service account password to a host on that footing
    // would defeat the point of looking first.
    assert.deepStrictEqual(fake.seen.filter((e) => e.op === 'bind'), []);
    assert.ok(!JSON.stringify(out).includes('service-secret'), 'no password in the answer');
});

test('the pem inspectCertificate hands back is one a later connection can trust', async (t) => {
    const pair = selfSignedPair();
    if (!pair) return t.skip('openssl is not available to build a test certificate');

    const fake = await startFake({ tls: pair, entries: [userEntry()] });
    t.after(() => fake.close());

    // The round trip the Trust button performs: look, pin what was returned,
    // connect again with validation on. Re-encoded from the DER on the wire, so
    // this also proves the PEM wrapping is well formed and not merely present.
    const seen = await ldap.inspectCertificate(Object.assign({ url: fake.url }, SEARCH_CONFIG));
    assert.strictEqual(seen.ok, true);

    const out = await ldap.verify(
        Object.assign({ url: fake.url }, SEARCH_CONFIG, { trustedCa: [seen.anchor.pem] }),
        'alice', 'her-password');
    assert.strictEqual(out.ok, true, `expected a bind, got ${JSON.stringify(out)}`);
});

test('inspectCertificate refuses a plaintext directory instead of pretending', async (t) => {
    const fake = await startFake({});
    t.after(() => fake.close());

    const out = await ldap.inspectCertificate(Object.assign({ url: fake.url }, SEARCH_CONFIG));
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_not_tls' });
});

/* --------------------------------------------------------- testConnection -- */

test('testConnection binds the service account and closes', async (t) => {
    const fake = await startFake({});
    t.after(() => fake.close());

    const out = await ldap.testConnection(Object.assign({ url: fake.url }, SEARCH_CONFIG));
    assert.deepStrictEqual(out, { ok: true });
    assert.deepStrictEqual(fake.errors, []);
    assert.deepStrictEqual(fake.seen.filter((s) => s.op !== 'unbind').map((s) => s.op), ['bind']);
    assert.ok(!JSON.stringify(out).includes('service-secret'), 'no password in the answer');
});

test('testConnection reports the directory diagnostic without the password', async (t) => {
    const fake = await startFake({ onBind: () => ({ resultCode: 49, diagnostic: '80090308: LdapErr, data 52e' }) });
    t.after(() => fake.close());

    const out = await ldap.testConnection(Object.assign({ url: fake.url }, SEARCH_CONFIG));
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error, 'ldap_bind_refused');
    assert.match(out.detail, /data 52e/);
    assert.ok(!out.detail.includes('service-secret'));
});

test('testConnection on a broken url never touches the network', async () => {
    assert.deepStrictEqual(await ldap.testConnection({ url: 'https://dc01.corp.local' }),
        { ok: false, error: 'ldap_bad_config', detail: 'url is not ldap or ldaps' });
});

/* ------------------------------------------------------------- AD SIDs ---- */

/**
 * A binary SID from its sub-authorities.
 *
 * Built here rather than pasted as a hex literal so a reader can see which
 * bytes are the header and which are the RID, and so the expected primary
 * group SID of a test can be written the same way as the user's.
 */
function sidBuffer(subAuthorities) {
    const out = Buffer.alloc(8 + (4 * subAuthorities.length));
    out[0] = 1;                     // revision
    out[1] = subAuthorities.length; // subAuthorityCount
    out[7] = 5;                     // identifierAuthority, six bytes big-endian: NT
    subAuthorities.forEach((v, i) => out.writeUInt32LE(v, 8 + (4 * i)));
    return out;
}

const DOMAIN = [21, 1111111111, 2222222222, 3333333333];
const USER_SID = sidBuffer(DOMAIN.concat([1105]));
const DOMAIN_USERS_SID = sidBuffer(DOMAIN.concat([513]));

test('parseSid reads a well-formed SID and reports its sub-authority count', () => {
    assert.deepStrictEqual(ldap.parseSid(USER_SID), { revision: 1, count: 5 });
    // The shortest legal SID: a header and a single sub-authority.
    assert.deepStrictEqual(ldap.parseSid(sidBuffer([18])), { revision: 1, count: 1 });
});

test('parseSid refuses every malformed shape rather than reading past the end', () => {
    assert.strictEqual(ldap.parseSid(null), null, 'not a buffer');
    assert.strictEqual(ldap.parseSid('S-1-5-21-1-2-3-1105'), null, 'a string is not a SID');
    assert.strictEqual(ldap.parseSid(Array.from(USER_SID)), null, 'an array of bytes is not a buffer');
    assert.strictEqual(ldap.parseSid(Buffer.alloc(7)), null, 'shorter than the header');

    const badRevision = Buffer.from(USER_SID);
    badRevision[0] = 2;
    assert.strictEqual(ldap.parseSid(badRevision), null, 'revision is not 1');

    const noSubAuthority = Buffer.from(USER_SID);
    noSubAuthority[1] = 0;
    assert.strictEqual(ldap.parseSid(noSubAuthority), null, 'sub-authority count below 1');

    const tooMany = Buffer.from(USER_SID);
    tooMany[1] = 16;
    assert.strictEqual(ldap.parseSid(tooMany), null, 'sub-authority count above the protocol maximum of 15');

    // The count and the length have to agree. Bytes that merely start like a
    // SID would otherwise be read as one, with the RID taken from whatever
    // happens to sit at the end of the buffer.
    assert.strictEqual(ldap.parseSid(Buffer.concat([USER_SID, Buffer.alloc(4)])), null,
        'four bytes too long for the count it declares');
    assert.strictEqual(ldap.parseSid(USER_SID.subarray(0, USER_SID.length - 4)), null,
        'four bytes too short for the count it declares');
});

test('primaryGroupSid swaps the RID and leaves the domain untouched', () => {
    const out = ldap.primaryGroupSid(USER_SID, '513');
    assert.deepStrictEqual(out, DOMAIN_USERS_SID);
    // Stated the long way too, because the whole point of the function is that
    // the group lives in the same domain as the user.
    assert.deepStrictEqual(
        Buffer.from(out.subarray(0, out.length - 4)),
        Buffer.from(USER_SID.subarray(0, USER_SID.length - 4)),
        'every byte before the last sub-authority is the user SID unchanged'
    );
    assert.strictEqual(out.readUInt32LE(out.length - 4), 513, 'only the RID moved');
    assert.strictEqual(USER_SID.readUInt32LE(USER_SID.length - 4), 1105, 'the caller buffer is not written to');
});

test('primaryGroupSid returns null on a bad SID or a RID that is not a RID', () => {
    assert.strictEqual(ldap.primaryGroupSid(Buffer.alloc(7), 513), null, 'not a SID');
    assert.strictEqual(ldap.primaryGroupSid('S-1-5-21', 513), null, 'not a buffer');
    assert.strictEqual(ldap.primaryGroupSid(USER_SID, 'Domain Users'), null, 'a name is not a RID');
    assert.strictEqual(ldap.primaryGroupSid(USER_SID, 1.5), null, 'a RID is a whole number');
    assert.strictEqual(ldap.primaryGroupSid(USER_SID, -1), null, 'below the range of a 32-bit field');
    assert.strictEqual(ldap.primaryGroupSid(USER_SID, 0x100000000), null, 'above the range of a 32-bit field');
});

/* -------------------------------------------------------- nested groups --- */

const USER_DN = 'CN=Alice Martin,OU=Users,DC=corp,DC=local';

/** The same user, with the two attributes the primary-group lookup needs. */
function userEntryWithSid() {
    const entry = userEntry();
    entry.attrs.objectSid = [USER_SID];
    entry.attrs.primaryGroupID = ['513'];
    return entry;
}

function group(dn) {
    return { dn, attrs: {} };
}

test('nestedGroups off issues one search and returns memberOf alone', async (t) => {
    const fake = await startFake({ entries: [userEntry()] });
    t.after(() => fake.close());

    const out = await ldap.verify(Object.assign({ url: fake.url }, SEARCH_CONFIG), 'alice', 'her-password');
    assert.deepStrictEqual(fake.errors, []);
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.groups, [
        LONG_GROUP,
        'CN=Deploy Readers,OU=Groups,DC=corp,DC=local',
        'CN=Everyone,DC=corp,DC=local'
    ]);
    // The flag is off by default, so the extensibleMatch that only AD
    // understands must never reach a directory nobody opted in for.
    assert.strictEqual(fake.seen.filter((s) => s.op === 'search').length, 1, 'the user search and nothing else');
});

test('nestedGroups on asks the DC for the group closure and merges what comes back', async (t) => {
    const fake = await startFake({
        onSearch: (seen, index) => (index === 0
            ? { entries: [userEntry()] }
            : {
                entries: [
                    group('CN=Ops Parent,OU=Groups,DC=corp,DC=local'),
                    group('CN=Global Readers,OU=Groups,DC=corp,DC=local')
                ]
            })
    });
    t.after(() => fake.close());

    const config = Object.assign({ url: fake.url }, SEARCH_CONFIG, { nestedGroups: true });
    const out = await ldap.verify(config, 'alice', 'her-password');
    assert.deepStrictEqual(fake.errors, []);
    assert.strictEqual(out.ok, true);

    const searches = fake.seen.filter((s) => s.op === 'search');
    assert.strictEqual(searches.length, 2, 'the user search, then the closure; no primary group without a SID');
    assert.strictEqual(searches[1].baseDn, SEARCH_CONFIG.baseDn);
    assert.deepStrictEqual(searches[1].filter, {
        type: 'extensible',
        oid: ldap.IN_CHAIN_OID,
        attr: 'member',
        value: USER_DN,
        dnAttributes: false
    }, 'LDAP_MATCHING_RULE_IN_CHAIN against the DN the first search returned');
    assert.deepStrictEqual(searches[1].attributes, ['1.1'],
        'the DN is already in the entry, so no attribute is worth transferring');
    assert.strictEqual(searches[1].sizeLimit, 500);

    assert.deepStrictEqual(out.groups, [
        LONG_GROUP,
        'CN=Deploy Readers,OU=Groups,DC=corp,DC=local',
        'CN=Everyone,DC=corp,DC=local',
        'CN=Ops Parent,OU=Groups,DC=corp,DC=local',
        'CN=Global Readers,OU=Groups,DC=corp,DC=local'
    ], 'direct membership first, then what the closure added');
});

test('a group in both memberOf and the closure appears once, whatever its case', async (t) => {
    // AD is case-insensitive about DNs and does not promise the closure spells
    // one the way memberOf did, so a case-sensitive de-duplication would list
    // the same group twice and a role check would see a group it cannot match.
    const fake = await startFake({
        onSearch: (seen, index) => (index === 0
            ? { entries: [userEntry()] }
            : {
                entries: [
                    group('cn=deploy readers,ou=groups,dc=corp,dc=local'),
                    group('CN=Ops Parent,OU=Groups,DC=corp,DC=local')
                ]
            })
    });
    t.after(() => fake.close());

    const config = Object.assign({ url: fake.url }, SEARCH_CONFIG, { nestedGroups: true });
    const out = await ldap.verify(config, 'alice', 'her-password');
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.groups, [
        LONG_GROUP,
        'CN=Deploy Readers,OU=Groups,DC=corp,DC=local',
        'CN=Everyone,DC=corp,DC=local',
        'CN=Ops Parent,OU=Groups,DC=corp,DC=local'
    ], 'the memberOf spelling is the one that survives');
});

test('the primary group is computed from the user SID and resolved to a DN', async (t) => {
    const fake = await startFake({
        onSearch: (seen, index) => {
            if (index === 0) return { entries: [userEntryWithSid()] };
            if (index === 1) return { entries: [] };
            return { entries: [group('CN=Domain Users,CN=Users,DC=corp,DC=local')] };
        }
    });
    t.after(() => fake.close());

    const config = Object.assign({ url: fake.url }, SEARCH_CONFIG, { nestedGroups: true });
    const out = await ldap.verify(config, 'alice', 'her-password');
    assert.deepStrictEqual(fake.errors, []);
    assert.strictEqual(out.ok, true);

    const searches = fake.seen.filter((s) => s.op === 'search');
    assert.strictEqual(searches.length, 3);
    assert.strictEqual(searches[2].filter.type, 'eq');
    assert.strictEqual(searches[2].filter.attr, 'objectSid');
    // Compared as bytes: a SID does not survive utf8, so the decoded `value`
    // of the filter is meaningless and only `raw` proves the arithmetic.
    assert.deepStrictEqual(searches[2].filter.raw, DOMAIN_USERS_SID,
        'the user SID with the RID replaced by primaryGroupID 513');
    assert.deepStrictEqual(searches[2].attributes, ['1.1']);
    assert.strictEqual(searches[2].sizeLimit, 2);

    assert.ok(out.groups.includes('CN=Domain Users,CN=Users,DC=corp,DC=local'),
        'the group that no memberOf anywhere lists is in the answer');
    assert.strictEqual(out.groups.length, 4);
});

test('objectSid and primaryGroupID are asked for only when nestedGroups is on', async (t) => {
    const plain = await startFake({ entries: [userEntry()] });
    t.after(() => plain.close());
    await ldap.verify(Object.assign({ url: plain.url }, SEARCH_CONFIG), 'alice', 'her-password');
    assert.deepStrictEqual(plain.seen.find((s) => s.op === 'search').attributes,
        ['memberOf', 'displayName', 'cn'],
        'a directory that is not AD is never asked for AD attributes');

    const nested = await startFake({
        onSearch: (seen, index) => (index === 0 ? { entries: [userEntry()] } : { entries: [] })
    });
    t.after(() => nested.close());
    await ldap.verify(Object.assign({ url: nested.url }, SEARCH_CONFIG, { nestedGroups: true }), 'alice', 'her-password');
    assert.deepStrictEqual(nested.seen.find((s) => s.op === 'search').attributes,
        ['memberOf', 'displayName', 'cn', 'objectSid', 'primaryGroupID'],
        'the two extra attributes ride along on the search that is already happening');
});

test('a directory that refuses the closure search still logs the user in', async (t) => {
    // unwillingToPerform (53) is a plausible answer from a directory that has
    // never heard of LDAP_MATCHING_RULE_IN_CHAIN. The password was already
    // accepted at this point, so this must cost the extra groups and nothing more.
    const fake = await startFake({
        onSearch: (seen, index) => (index === 0
            ? { entries: [userEntry()] }
            : { resultCode: 53, diagnostic: 'matching rule not supported' })
    });
    t.after(() => fake.close());

    const config = Object.assign({ url: fake.url }, SEARCH_CONFIG, { nestedGroups: true });
    const out = await ldap.verify(config, 'alice', 'her-password');
    assert.strictEqual(out.ok, true, 'a refused group search is not a refused login');
    assert.deepStrictEqual(out.groups, [
        LONG_GROUP,
        'CN=Deploy Readers,OU=Groups,DC=corp,DC=local',
        'CN=Everyone,DC=corp,DC=local'
    ], 'the direct memberOf list stands on its own');
});

test('a primary-group search that blows up leaves the groups already found intact', async (t) => {
    // Here the directory does not answer at all: the fake throws, which drops
    // the connection mid-exchange. That exercises the rejection path rather
    // than the error-code path the previous test covers.
    const fake = await startFake({
        onSearch: (seen, index) => {
            if (index === 0) return { entries: [userEntryWithSid()] };
            if (index === 1) return { entries: [group('CN=Ops Parent,OU=Groups,DC=corp,DC=local')] };
            throw new Error('the directory gave up on the primary group');
        }
    });
    t.after(() => fake.close());

    const config = Object.assign({ url: fake.url }, SEARCH_CONFIG, { nestedGroups: true });
    const out = await ldap.verify(config, 'alice', 'her-password');
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.groups, [
        LONG_GROUP,
        'CN=Deploy Readers,OU=Groups,DC=corp,DC=local',
        'CN=Everyone,DC=corp,DC=local',
        'CN=Ops Parent,OU=Groups,DC=corp,DC=local'
    ], 'the closure result survives the failure that came after it');
});

test('no objectSid on the entry means no primary-group search at all', async (t) => {
    const fake = await startFake({
        onSearch: (seen, index) => (index === 0 ? { entries: [userEntry()] } : { entries: [] })
    });
    t.after(() => fake.close());

    const config = Object.assign({ url: fake.url }, SEARCH_CONFIG, { nestedGroups: true });
    const out = await ldap.verify(config, 'alice', 'her-password');
    assert.strictEqual(out.ok, true);
    // A SID cannot be guessed, so the lookup is skipped rather than issued with
    // something invented. Two searches, not three.
    assert.strictEqual(fake.seen.filter((s) => s.op === 'search').length, 2);
});

/* -------------------------------------------------------------- lookup ---- */

test('lookup reads the groups with the service account and never binds as the user', async (t) => {
    const fake = await startFake({ entries: [userEntry()] });
    t.after(() => fake.close());

    const out = await ldap.lookup(Object.assign({ url: fake.url }, SEARCH_CONFIG), 'alice');
    assert.deepStrictEqual(fake.errors, []);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.dn, USER_DN);
    assert.strictEqual(out.displayName, 'Alice Martin');
    assert.deepStrictEqual(out.groups, [
        LONG_GROUP,
        'CN=Deploy Readers,OU=Groups,DC=corp,DC=local',
        'CN=Everyone,DC=corp,DC=local'
    ]);

    // The one thing that separates lookup from verify: it has no password and
    // must not pretend to have one. A second bind here would mean it was
    // authenticating, which is exactly what it is not allowed to do.
    assert.strictEqual(fake.seen.filter((s) => s.op === 'bind').length, 1, 'the service bind only');
    const ops = fake.seen.filter((s) => s.op !== 'unbind');
    assert.deepStrictEqual(ops.map((s) => s.op), ['bind', 'search']);
    assert.strictEqual(ops[0].dn, SEARCH_CONFIG.bindDn);
});

test('lookup resolves nested and primary groups when the flag is on', async (t) => {
    const fake = await startFake({
        onSearch: (seen, index) => {
            if (index === 0) return { entries: [userEntryWithSid()] };
            if (index === 1) return { entries: [group('CN=Ops Parent,OU=Groups,DC=corp,DC=local')] };
            return { entries: [group('CN=Domain Users,CN=Users,DC=corp,DC=local')] };
        }
    });
    t.after(() => fake.close());

    const config = Object.assign({ url: fake.url }, SEARCH_CONFIG, { nestedGroups: true });
    const out = await ldap.lookup(config, 'alice');
    assert.deepStrictEqual(fake.errors, []);
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.groups, [
        LONG_GROUP,
        'CN=Deploy Readers,OU=Groups,DC=corp,DC=local',
        'CN=Everyone,DC=corp,DC=local',
        'CN=Ops Parent,OU=Groups,DC=corp,DC=local',
        'CN=Domain Users,CN=Users,DC=corp,DC=local'
    ], 'a re-check sees the same group list a login would have produced');
    assert.strictEqual(fake.seen.filter((s) => s.op === 'bind').length, 1, 'still no user bind');
    assert.strictEqual(fake.seen.filter((s) => s.op === 'search').length, 3);
});

test('lookup without a service account is ldap_bad_config and opens nothing', async (t) => {
    const fake = await startFake({});
    t.after(() => fake.close());

    // A userDnTemplate setup authenticates by binding as the user, so there is
    // no credential left over to ask the directory a question with.
    const config = { url: fake.url, userDnTemplate: '{username}@corp.local', timeoutMs: 3000 };
    assert.deepStrictEqual(await ldap.lookup(config, 'alice'), { ok: false, error: 'ldap_bad_config' });
    assert.strictEqual(fake.connections, 0, 'the caller keeps the session it has, at no cost to the DC');
});

test('lookup refuses an empty or control-laden username before a socket is opened', async (t) => {
    const fake = await startFake({ entries: [userEntry()] });
    t.after(() => fake.close());

    const config = Object.assign({ url: fake.url }, SEARCH_CONFIG);
    for (const user of ['', '   ', null, 'ali' + NUL + 'ce']) {
        assert.deepStrictEqual(await ldap.lookup(config, user), { ok: false, error: 'ldap_user_not_found' });
    }
    assert.strictEqual(fake.connections, 0);
});

test('lookup on a user the directory does not have is ldap_user_not_found', async (t) => {
    const fake = await startFake({ entries: [] });
    t.after(() => fake.close());

    const out = await ldap.lookup(Object.assign({ url: fake.url }, SEARCH_CONFIG), 'ghost');
    assert.deepStrictEqual(out, { ok: false, error: 'ldap_user_not_found' });
});
