/**
 * A minimal LDAPv3 client written on node:net and node:tls, with BER encoded
 * and decoded by hand.
 *
 * Four constraints shaped this file.
 *
 * No npm package. `extensions/deploy/backend/` does not resolve the backend's
 * `node_modules`, and there is no `node_modules` at the repository root either,
 * so `ldapjs` and `ldapts` are unavailable here the same way `express` is
 * unavailable to `siteServer.js`. What we need of RFC 4511 is a bind, a search
 * and StartTLS, which is a small enough subset to write.
 *
 * The subset is deliberate, not aspirational. BindRequest/BindResponse,
 * SearchRequest/SearchResultEntry/SearchResultReference/SearchResultDone,
 * UnbindRequest and the StartTLS ExtendedRequest/ExtendedResponse. No SASL, no
 * paged results, no modify, no abandon, no controls. Anything outside that is a
 * protocol error rather than a silent success, because a directory client that
 * guesses is a directory client that lets the wrong person in.
 *
 * One filter form is emitted that `parseFilterString` will not read back: the
 * extensibleMatch behind `nestedGroups`. Filters written by an operator go
 * through the parser and its attribute rule; that one is built as BER by
 * `extensibleMatchFilter` and never parsed, so the parser stays as strict as it
 * is. See `collectGroups` for what it is for.
 *
 * Long-form lengths and TCP reassembly are not optional. A single `memberOf`
 * value from Active Directory routinely exceeds 127 bytes, so the short length
 * form alone cannot encode a real response, and a SearchResultEntry for a user
 * in a dozen groups will not arrive in one `data` event. Both are handled in
 * `decode` and in the reader loop rather than assumed away.
 *
 * This module fails closed and never throws at its callers: every fault becomes
 * `{ ok: false, error: '<code>' }` with a machine code from the fixed list in
 * the contract. It writes nothing to the console. A password appears in exactly
 * one place, the bytes of a BindRequest on the wire, and in no log, no error
 * message, no returned object and no thrown value.
 */

'use strict';

const net = require('node:net');
const tls = require('node:tls');

/** Cap on any single BER element. A hostile server must not size our heap. */
const MAX_ELEMENT = 8 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 120000;

const STARTTLS_OID = '1.3.6.1.4.1.1466.20037';

/**
 * LDAP_MATCHING_RULE_IN_CHAIN, Active Directory only.
 *
 * `(member:<oid>:=<userDN>)` asks the domain controller to walk the group graph
 * itself and return every group the user reaches, at any depth. The alternative
 * is fetching `memberOf`, then each group's `memberOf`, and so on from here:
 * many round trips, a cycle to guard against, and a different answer than the
 * one the DC uses when it evaluates access. Letting the DC answer is both
 * smaller and more correct.
 *
 * No other directory implements it. OpenLDAP answers with an error, which is
 * why every caller of this treats a failure as "no extra groups" and keeps the
 * direct list.
 */
const IN_CHAIN_OID = '1.2.840.113556.1.4.1941';

/** Protocol op tags we emit or understand. Everything else is an error. */
const OP = {
    BIND_REQUEST: 0x60,
    BIND_RESPONSE: 0x61,
    UNBIND_REQUEST: 0x42,
    SEARCH_REQUEST: 0x63,
    SEARCH_ENTRY: 0x64,
    SEARCH_DONE: 0x65,
    SEARCH_REFERENCE: 0x73,
    EXTENDED_REQUEST: 0x77,
    EXTENDED_RESPONSE: 0x78
};

/** The handful of LDAP result codes whose meaning changes what we return. */
const RESULT = {
    SUCCESS: 0,
    SIZE_LIMIT_EXCEEDED: 4,
    STRONGER_AUTH_REQUIRED: 8,
    NO_SUCH_OBJECT: 32,
    INVALID_CREDENTIALS: 49,
    INSUFFICIENT_ACCESS: 50,
    UNWILLING_TO_PERFORM: 53
};

/**
 * An internal error that already knows which contract code it becomes.
 *
 * `detail` is for the operator, and is only ever surfaced by `testConnection`,
 * which an admin triggers deliberately. It carries a socket error code or the
 * directory's own diagnostic message, never anything the caller supplied.
 */
class LdapError extends Error {
    constructor(code, detail) {
        super(code);
        this.name = 'LdapError';
        this.ldapCode = code;
        this.detail = detail ? sanitize(detail) : null;
    }
}

/** Server text is untrusted: strip control characters and keep it short. */
function sanitize(text) {
    return String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
}

/* ------------------------------------------------------------------ BER ---- */

/**
 * BER length octets, short form under 128 and long form above.
 *
 * The long form is mandatory here, not a nicety: an AD `memberOf` list is
 * thousands of bytes and would be unencodable in the short form.
 */
function encodeLength(n) {
    if (n < 0x80) return Buffer.from([n]);
    const bytes = [];
    let v = n;
    while (v > 0) {
        bytes.unshift(v & 0xff);
        v = Math.floor(v / 256);
    }
    if (bytes.length > 4) throw new LdapError('ldap_protocol_error', 'element too large to encode');
    return Buffer.from([0x80 | bytes.length].concat(bytes));
}

/**
 * One BER element: tag, length, value.
 *
 * `payload` is a Buffer, an array of Buffers for a constructed element, or a
 * string that is taken as UTF-8. Exported so the encoder can be tested on its
 * own rather than only through a round trip against its own decoder.
 */
function encode(tag, payload) {
    let body;
    if (Array.isArray(payload)) body = Buffer.concat(payload);
    else if (Buffer.isBuffer(payload)) body = payload;
    else if (payload === undefined || payload === null) body = Buffer.alloc(0);
    else body = Buffer.from(String(payload), 'utf8');
    return Buffer.concat([Buffer.from([tag & 0xff]), encodeLength(body.length), body]);
}

/**
 * One BER element read out of `buf` at `offset`.
 *
 * Returns null when the buffer holds less than a whole element, which is the
 * normal case on a TCP stream and the reason the reader loop can simply call
 * this again after the next `data` event. Throws only on bytes that cannot
 * become a valid element no matter how many more arrive.
 */
function decode(buf, offset) {
    const start = offset || 0;
    if (buf.length < start + 2) return null;

    const tag = buf[start];
    // High-tag-number form. No LDAP tag needs it, so its presence means we are
    // not looking at an LDAP message and guessing further would be worse.
    if ((tag & 0x1f) === 0x1f) throw new LdapError('ldap_protocol_error', 'multi-byte tag');

    const first = buf[start + 1];
    let length;
    let headerLength;
    if (first < 0x80) {
        length = first;
        headerLength = 2;
    } else {
        const count = first & 0x7f;
        // 0x80 is the indefinite form, legal in BER and forbidden in LDAP's
        // subset. It has no terminator we would honour, so it is rejected.
        if (count === 0) throw new LdapError('ldap_protocol_error', 'indefinite length');
        if (count > 4) throw new LdapError('ldap_protocol_error', 'length too wide');
        if (buf.length < start + 2 + count) return null;
        length = 0;
        for (let i = 0; i < count; i++) length = (length * 256) + buf[start + 2 + i];
        headerLength = 2 + count;
    }
    if (length > MAX_ELEMENT) throw new LdapError('ldap_protocol_error', 'element too large');

    const end = start + headerLength + length;
    if (buf.length < end) return null;
    return { tag, start, headerLength, length, value: buf.subarray(start + headerLength, end), end };
}

/** Every element of a constructed value, in order. */
function children(value) {
    const out = [];
    let off = 0;
    while (off < value.length) {
        const tlv = decode(value, off);
        if (!tlv) throw new LdapError('ldap_protocol_error', 'truncated element');
        out.push(tlv);
        off = tlv.end;
    }
    return out;
}

/** Big-endian two's complement. Result codes and message ids only. */
function readInteger(b) {
    if (!b.length) return 0;
    let n = (b[0] & 0x80) ? b[0] - 256 : b[0];
    for (let i = 1; i < b.length; i++) n = (n * 256) + b[i];
    return n;
}

function berInteger(n) {
    let v = Math.trunc(Number(n));
    if (!Number.isFinite(v) || v < 0) v = 0;
    const bytes = [];
    do {
        bytes.unshift(v & 0xff);
        v = Math.floor(v / 256);
    } while (v > 0);
    if (bytes[0] & 0x80) bytes.unshift(0x00);
    return encode(0x02, Buffer.from(bytes));
}

function berEnum(n) {
    const int = berInteger(n);
    int[0] = 0x0a;
    return int;
}

function berString(s) {
    return encode(0x04, s === undefined || s === null ? '' : String(s));
}

function berBoolean(v) {
    return encode(0x01, Buffer.from([v ? 0xff : 0x00]));
}

/* --------------------------------------------------------------- escaping -- */

const FILTER_ESCAPES = {
    '\\': '\\5c',
    '*': '\\2a',
    '(': '\\28',
    ')': '\\29',
    '\u0000': '\\00'
};

/**
 * RFC 4515 escaping of an assertion value.
 *
 * Applied to the operator's input before it is substituted into `userFilter`,
 * and that ordering is the whole point: a username of `*)(objectClass=*` turned
 * into a filter unescaped authenticates the first account the directory happens
 * to return. The backslash is in the same table as the rest, and `replace` with
 * a character class rewrites each character once, so escaping cannot double back
 * on its own output.
 */
function escapeFilter(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/[\\*()\u0000]/g, (ch) => FILTER_ESCAPES[ch]);
}

/**
 * RFC 4514 escaping of a relative distinguished name value.
 *
 * Used on the operator's input before it is substituted into `userDnTemplate`,
 * so a template like `CN={username},OU=Users,DC=corp,DC=local` cannot be steered
 * to another subtree by a username containing a comma. For the other common
 * template shape, a userPrincipalName like `{username}@corp.local`, no character
 * of a legal logon name is escaped and this is the identity function.
 */
function escapeDn(value) {
    const s = String(value === undefined || value === null ? '' : value);
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '\u0000') out += '\\00';
        else if (ch === '\\' || ch === ',' || ch === '+' || ch === '"' ||
                 ch === '<' || ch === '>' || ch === ';' || ch === '=') out += '\\' + ch;
        // A leading `#` would introduce a hex-encoded value, and a space at
        // either end is dropped by the directory unless it is escaped.
        else if (ch === '#' && i === 0) out += '\\#';
        else if (ch === ' ' && (i === 0 || i === s.length - 1)) out += '\\ ';
        else out += ch;
    }
    return out;
}

/* ----------------------------------------------------------------- filter -- */

const HEX = /[0-9a-fA-F]/;

/** `\5c` style escapes back to bytes, so the encoder sends the real value. */
function unescapeFilterValue(raw) {
    const b = Buffer.from(raw, 'utf8');
    const out = [];
    for (let i = 0; i < b.length; i++) {
        if (b[i] === 0x5c && i + 2 < b.length &&
            HEX.test(String.fromCharCode(b[i + 1])) && HEX.test(String.fromCharCode(b[i + 2]))) {
            out.push(parseInt(String.fromCharCode(b[i + 1], b[i + 2]), 16));
            i += 2;
        } else if (b[i] === 0x5c && i + 1 < b.length) {
            out.push(b[i + 1]);
            i += 1;
        } else {
            out.push(b[i]);
        }
    }
    return Buffer.from(out);
}

/**
 * An RFC 4515 filter string compiled to the BER Filter of RFC 4511.
 *
 * Supported: `&`, `|`, `!`, equality, `>=`, `<=`, `~=`, presence and substrings.
 * Not supported: extensible match (`attr:rule:=value`), which no user filter
 * for an authentication lookup needs and which would double the size of this
 * parser. An unsupported or malformed filter is `ldap_bad_config`, refused
 * before a socket is opened, rather than a filter that means something else.
 */
function parseFilterString(text) {
    const src = String(text === undefined || text === null ? '' : text);
    let pos = 0;

    function bad(why) {
        return new LdapError('ldap_bad_config', `filter: ${why} at offset ${pos}`);
    }
    function skipSpace() {
        while (pos < src.length && src[pos] === ' ') pos++;
    }
    function expect(ch) {
        if (src[pos] !== ch) throw bad(`expected '${ch}'`);
        pos++;
    }

    function parseExpr() {
        skipSpace();
        expect('(');
        skipSpace();
        const ch = src[pos];
        let out;
        if (ch === '&' || ch === '|') {
            pos++;
            const parts = [];
            skipSpace();
            while (src[pos] === '(') {
                parts.push(parseExpr());
                skipSpace();
            }
            if (!parts.length) throw bad('empty and/or');
            out = encode(ch === '&' ? 0xa0 : 0xa1, parts);
        } else if (ch === '!') {
            pos++;
            out = encode(0xa2, parseExpr());
            skipSpace();
        } else {
            out = parseItem();
        }
        expect(')');
        return out;
    }

    function parseItem() {
        const attrStart = pos;
        while (pos < src.length && !'=<>~()'.includes(src[pos])) pos++;
        const attr = src.slice(attrStart, pos).trim();
        if (!attr || !/^[A-Za-z0-9.;\-]+$/.test(attr)) throw bad('bad attribute');

        let op;
        if (src.startsWith('>=', pos)) { op = '>='; pos += 2; }
        else if (src.startsWith('<=', pos)) { op = '<='; pos += 2; }
        else if (src.startsWith('~=', pos)) { op = '~='; pos += 2; }
        else if (src[pos] === '=') { op = '='; pos += 1; }
        else throw bad('bad operator');

        const valStart = pos;
        while (pos < src.length && src[pos] !== ')') pos++;
        const raw = src.slice(valStart, pos);

        // Splitting before unescaping is what separates a wildcard from a
        // literal asterisk: `\2a` survives the split, a bare `*` does not.
        const segments = raw.split('*');
        if (segments.length === 1) {
            const tag = op === '=' ? 0xa3 : op === '>=' ? 0xa5 : op === '<=' ? 0xa6 : 0xa8;
            return encode(tag, [berString(attr), encode(0x04, unescapeFilterValue(raw))]);
        }
        if (op !== '=') throw bad('wildcard with a non-equality operator');
        if (segments.every((s) => s === '')) return encode(0x87, Buffer.from(attr, 'utf8'));

        const pieces = [];
        segments.forEach((seg, i) => {
            if (seg === '') return;
            const tag = i === 0 ? 0x80 : (i === segments.length - 1 ? 0x82 : 0x81);
            pieces.push(encode(tag, unescapeFilterValue(seg)));
        });
        return encode(0xa4, [berString(attr), encode(0x30, pieces)]);
    }

    const filter = parseExpr();
    skipSpace();
    if (pos !== src.length) throw new LdapError('ldap_bad_config', 'filter: trailing characters');
    return filter;
}

/* ------------------------------------------------------------- operations -- */

function bindRequest(dn, password) {
    return encode(OP.BIND_REQUEST, [
        berInteger(3),
        berString(dn || ''),
        // simple [0] of AuthenticationChoice: context-specific, primitive.
        encode(0x80, Buffer.from(password === undefined || password === null ? '' : String(password), 'utf8'))
    ]);
}

function unbindRequest() {
    // [APPLICATION 2] NULL: primitive, no content, and no response ever comes.
    return encode(OP.UNBIND_REQUEST, Buffer.alloc(0));
}

function searchRequest({ baseDn, filter, attributes, sizeLimit }) {
    return encode(OP.SEARCH_REQUEST, [
        berString(baseDn || ''),
        berEnum(2),                 // wholeSubtree
        berEnum(0),                 // neverDerefAliases
        berInteger(sizeLimit || 0),
        berInteger(0),              // timeLimit: our own deadline governs instead
        berBoolean(false),          // typesOnly
        filter,
        encode(0x30, (attributes || []).map(berString))
    ]);
}

/**
 * `(attr=<bytes>)` built straight as BER.
 *
 * `parseFilterString` takes text and unescapes `\xx` back to bytes, which works,
 * but going through it to compare a binary SID means encoding bytes into a
 * string so the parser can decode them again. The filter below is ours and
 * never comes from an operator, so it skips the round trip.
 */
function equalityFilter(attr, valueBuffer) {
    return encode(0xa3, [berString(attr), encode(0x04, valueBuffer)]);
}

/**
 * `(attr:<oid>:=<value>)`, the extensibleMatch of RFC 4511 4.5.1.7.
 *
 * Deliberately not added to `parseFilterString`. That parser reads the
 * operator's `userFilter`, and its attribute rule (`/^[A-Za-z0-9.;-]+$/`) is
 * part of what keeps a hand-typed filter from turning into something else.
 * Widening it so this one filter could be written as text would loosen the
 * parser for every input it handles, to express a filter no operator writes.
 *
 * MatchingRuleAssertion ::= SEQUENCE {
 *      matchingRule  [1] OPTIONAL, type [2] OPTIONAL,
 *      matchValue    [3], dnAttributes [4] BOOLEAN DEFAULT FALSE }
 * `dnAttributes` is omitted, which is its default of FALSE.
 */
function extensibleMatchFilter(attr, oid, value) {
    return encode(0xa9, [
        encode(0x81, Buffer.from(oid, 'utf8')),
        encode(0x82, Buffer.from(attr, 'utf8')),
        encode(0x83, Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'))
    ]);
}

function startTlsRequest() {
    return encode(OP.EXTENDED_REQUEST, [encode(0x80, Buffer.from(STARTTLS_OID, 'utf8'))]);
}

/** The first three fields of an LDAPResult, shared by every response we read. */
function parseResult(value) {
    const p = children(value);
    if (p.length < 3) throw new LdapError('ldap_protocol_error', 'short LDAPResult');
    return {
        resultCode: readInteger(p[0].value),
        matchedDn: p[1].value.toString('utf8'),
        diagnostic: sanitize(p[2].value.toString('utf8'))
    };
}

/**
 * A SearchResultEntry as `{ dn, attributes, raw }`, attribute names lowercased.
 *
 * Values stay as an array even when there is one of them, because `memberOf` is
 * multi-valued and collapsing it would lose every group but one.
 *
 * `raw` carries the same values as Buffers. LDAP attribute syntax is not all
 * text: `objectSid` is eight or more bytes of binary whose high bytes are not
 * valid UTF-8, and `toString('utf8')` replaces each of them with U+FFFD. A SID
 * that has been through that conversion cannot be turned back into bytes, so
 * the primary-group lookup needs the original. `attributes` is left exactly as
 * it was; nothing that reads text has to know this field exists.
 */
function parseSearchEntry(value) {
    const p = children(value);
    if (p.length < 2) throw new LdapError('ldap_protocol_error', 'short SearchResultEntry');
    const dn = p[0].value.toString('utf8');
    const attributes = Object.create(null);
    const raw = Object.create(null);
    for (const attr of children(p[1].value)) {
        const fields = children(attr.value);
        if (fields.length < 2) continue;
        const name = fields[0].value.toString('utf8').toLowerCase();
        const values = children(fields[1].value).map((v) => v.value);
        raw[name] = values;
        attributes[name] = values.map((v) => v.toString('utf8'));
    }
    return { dn, attributes, raw };
}

/* ------------------------------------------------------------ connection --- */

function fail(state, err) {
    if (state.closing) return;
    if (!state.failure) state.failure = err;
    const waiters = state.waiters.splice(0);
    const pending = Array.from(state.pending.values());
    state.pending.clear();
    for (const reject of waiters) reject(state.failure);
    for (const handler of pending) handler.reject(state.failure);
}

/**
 * Why the handshake failed, in the operator's terms rather than OpenSSL's.
 *
 * One code for every TLS fault was the original shape, and it produced one
 * piece of advice -- install the authority, restart, or stop validating -- for
 * three unrelated problems. An expired certificate is not fixed by installing a
 * CA, and a controller whose certificate says `dc01.corp.local` while the form
 * says `corp.local` is not fixed by anything on that list. The page offers a
 * different repair for each of these, so each needs its own code.
 *
 * Anything not in the table stays `ldap_tls_failed`: a code we cannot act on
 * must not be dressed up as one we can.
 */
const TLS_REASON = {
    // The chain does not reach an authority we hold. Repairable by pinning.
    UNABLE_TO_GET_ISSUER_CERT: 'ldap_tls_untrusted',
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'ldap_tls_untrusted',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'ldap_tls_untrusted',
    SELF_SIGNED_CERT_IN_CHAIN: 'ldap_tls_untrusted',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'ldap_tls_untrusted',
    CERT_UNTRUSTED: 'ldap_tls_untrusted',
    // The chain is fine; it belongs to another name. Repairable by correcting
    // the address, which the certificate itself supplies.
    ERR_TLS_CERT_ALTNAME_INVALID: 'ldap_tls_name_mismatch',
    // Nothing on this server can fix a clock or a renewal.
    CERT_HAS_EXPIRED: 'ldap_tls_expired',
    CERT_NOT_YET_VALID: 'ldap_tls_expired'
};

/** A socket-level failure means different things before and after the handshake. */
function socketError(state, e) {
    const code = (e && e.code) || '';
    const detail = code || (e && e.message) || 'socket error';
    if (state.phase === 'tls') return new LdapError(TLS_REASON[code] || 'ldap_tls_failed', detail);
    return new LdapError('ldap_unreachable', detail);
}

/**
 * The reader loop.
 *
 * A response is not a datagram: a SearchResultEntry carrying a full `memberOf`
 * arrives over several `data` events, and several small responses arrive in one.
 * So bytes accumulate and whole messages are taken off the front until `decode`
 * says the rest is a fragment.
 */
function onData(state, chunk) {
    state.buf = state.buf.length ? Buffer.concat([state.buf, chunk]) : chunk;
    try {
        for (;;) {
            const msg = decode(state.buf, 0);
            if (!msg) return;
            if (msg.tag !== 0x30) throw new LdapError('ldap_protocol_error', 'message is not a sequence');
            state.buf = Buffer.from(state.buf.subarray(msg.end));
            dispatch(state, msg.value);
        }
    } catch (e) {
        fail(state, e instanceof LdapError ? e : new LdapError('ldap_protocol_error', e.message));
    }
}

function dispatch(state, messageValue) {
    const parts = children(messageValue);
    if (parts.length < 2) throw new LdapError('ldap_protocol_error', 'short LDAPMessage');
    const id = readInteger(parts[0].value);
    const op = parts[1];

    const handler = state.pending.get(id);
    // Message id 0 is an unsolicited notification, typically the server saying
    // it is about to disconnect. Nothing is waiting on it, and dropping it lets
    // the socket close normally instead of turning into a protocol error.
    if (!handler) return;

    try {
        if (handler.accept(op, handler.resolve)) state.pending.delete(id);
    } catch (e) {
        state.pending.delete(id);
        handler.reject(e instanceof LdapError ? e : new LdapError('ldap_protocol_error', e.message));
    }
}

function attach(state, sock) {
    state.sock = sock;
    sock.on('data', (chunk) => onData(state, chunk));
    sock.on('error', (e) => fail(state, socketError(state, e)));
    sock.on('close', () => fail(state, new LdapError('ldap_unreachable', 'connection closed')));
}

/**
 * Sends one request and settles when its response arrives.
 *
 * `accept` returns true when the exchange is over, which is what lets a search
 * keep the same handler alive across a run of SearchResultEntry messages until
 * the SearchResultDone.
 */
function request(state, opBuffer, accept) {
    return new Promise((resolve, reject) => {
        if (state.failure) return reject(state.failure);
        const id = state.nextId++;
        state.pending.set(id, { accept, resolve, reject });
        try {
            state.sock.write(encode(0x30, [berInteger(id), opBuffer]));
        } catch (e) {
            state.pending.delete(id);
            reject(new LdapError('ldap_unreachable', e.message));
        }
    });
}

/**
 * Opens the session and starts the one deadline that governs all of it.
 *
 * One deadline for the whole exchange, not one per operation: a directory that
 * answers each step just under a per-step limit would otherwise hold a request
 * handler for as long as it liked. The timer destroys the socket, so a hung DC
 * cannot keep the session alive past it.
 */
function createSession(cfg) {
    const state = {
        sock: null,
        buf: Buffer.alloc(0),
        pending: new Map(),
        waiters: [],
        nextId: 1,
        phase: 'connect',
        failure: null,
        closing: false,
        timer: null
    };
    state.timer = setTimeout(() => {
        fail(state, new LdapError('ldap_timeout', `no answer within ${cfg.timeoutMs} ms`));
        if (state.sock) state.sock.destroy();
    }, cfg.timeoutMs);
    // The process must not be held open by a directory that never answers.
    if (typeof state.timer.unref === 'function') state.timer.unref();
    return state;
}

function closeSession(state) {
    clearTimeout(state.timer);
    if (state.closing) return;
    state.closing = true;
    if (!state.sock) return;
    try {
        // An UnbindRequest is a courtesy so the DC logs a clean disconnect. It
        // has no response, so there is nothing to wait for.
        if (state.sock.writable) state.sock.write(encode(0x30, [berInteger(state.nextId++), unbindRequest()]));
    } catch (_) { /* the socket is already gone; the destroy below is enough */ }
    try { state.sock.destroy(); } catch (_) { /* already destroyed */ }
}

/**
 * SNI, except when the URL names an address.
 *
 * RFC 6066 forbids an IP literal as a server name and Node warns about it, so
 * an `ldaps://10.0.0.1` configuration must send no SNI at all rather than an
 * invalid one. Certificate validation still happens against the address.
 */
function serverName(cfg) {
    return net.isIP(cfg.host) === 0 ? cfg.host : undefined;
}

/**
 * The certificate authorities to validate a domain controller against.
 *
 * Node ships the public web's roots and nothing else. An Active Directory
 * controller almost never presents one of those: its LDAPS certificate comes
 * from the organisation's own CA, which is in the Windows trust store of every
 * machine joined to the domain -- including this one -- and in no list Node
 * consults by default. The result was a TLS failure whose only documented fix
 * was to stop validating the certificate, which is the wrong lesson to teach
 * about a connection carrying a bind password.
 *
 * So the machine's own trust store is added to Node's. That is the same set of
 * authorities Windows itself would accept, no more: an operator who has not
 * installed their CA on this server still gets the failure, and it is still the
 * right one.
 *
 * Read once. The store is read from disk and does not change while the service
 * runs; a login is not the moment to go and look again.
 */
let caCache;
let caReadAt = 0;

/** Floor between two reads of the machine store, so a failing login cannot spin on it. */
const TRUST_REREAD_MS = 30000;

function machineAuthorities() {
    if (caCache !== undefined) return caCache;
    caCache = null;
    caReadAt = Date.now();
    // Absent before Node 22.15. Then there is nothing to add and the public
    // roots are what we have.
    if (typeof tls.getCACertificates === 'function') {
        try {
            const merged = new Set(tls.getCACertificates('default'));
            for (const pem of tls.getCACertificates('system')) merged.add(pem);
            caCache = Array.from(merged);
        } catch (e) {
            // A trust store that will not read is not a reason to refuse a
            // login. Node's own roots still apply.
            console.error(`[Deploy] could not read the machine trust store: ${e.message}`);
        }
    }
    return caCache;
}

/**
 * Drops the cached store so the next connection reads it again.
 *
 * This exists to delete a sentence from the product: "restart Aegis, the store
 * is read once at startup". An operator who has just installed their CA on this
 * server should press Test and have it work. Rate-limited because the retry
 * path calls it on every untrusted handshake, and re-reading the whole Windows
 * store per failed login is a denial of service with extra steps.
 *
 * Returns whether it actually invalidated anything, which is what tells the
 * caller a second attempt is worth making.
 */
function refreshTrust() {
    if (caCache !== undefined && Date.now() - caReadAt < TRUST_REREAD_MS) return false;
    caCache = undefined;
    return true;
}

/**
 * Every authority this connection may validate against: the machine store, plus
 * the ones the operator pinned for this directory.
 *
 * Pinning exists because the machine store is not always reachable ground. The
 * Aegis server is not necessarily joined to the domain it audits, installing a
 * root CA is a change many operators cannot make on their own, and the fallback
 * we used to offer instead was to stop validating a connection that carries the
 * bind password. A pinned authority keeps validation on and narrows what is
 * trusted rather than widening it: it is stored per tenant, next to the
 * directory it belongs to, and it authenticates exactly that controller.
 */
function trustedAuthorities(pinned) {
    const store = machineAuthorities();
    if (!pinned || !pinned.length) return store;
    return (store || tls.rootCertificates || []).concat(pinned);
}

function connectSocket(state, cfg) {
    return new Promise((resolve, reject) => {
        state.waiters.push(reject);
        const done = () => {
            state.phase = 'live';
            state.waiters.length = 0;
            resolve();
        };
        let sock;
        if (cfg.secure) {
            state.phase = 'tls';
            sock = tls.connect({
                host: cfg.host,
                port: cfg.port,
                servername: serverName(cfg),
                rejectUnauthorized: cfg.rejectUnauthorized,
                ca: trustedAuthorities(cfg.trustedCa) || undefined
            }, done);
        } else {
            sock = net.connect({ host: cfg.host, port: cfg.port }, done);
        }
        attach(state, sock);
    });
}

/**
 * StartTLS on an already open ldap:// connection.
 *
 * A refusal is fatal on purpose. Continuing in plaintext after asking for TLS
 * would send the password in the clear on a connection the operator configured
 * as encrypted, which is worse than not connecting at all.
 */
async function upgradeToTls(state, cfg) {
    const res = await request(state, startTlsRequest(), (op, resolve) => {
        if (op.tag !== OP.EXTENDED_RESPONSE) throw new LdapError('ldap_protocol_error', 'expected an ExtendedResponse');
        resolve(parseResult(op.value));
        return true;
    });
    if (res.resultCode !== RESULT.SUCCESS) {
        throw new LdapError('ldap_tls_failed', res.diagnostic || `StartTLS refused (${res.resultCode})`);
    }
    // Every byte after the response belongs to the TLS handshake. Anything left
    // in our buffer means the server got ahead of itself and we would feed the
    // handshake to the LDAP reader.
    if (state.buf.length) throw new LdapError('ldap_protocol_error', 'data received before the TLS handshake');

    const raw = state.sock;
    raw.removeAllListeners('data');
    raw.removeAllListeners('error');
    raw.removeAllListeners('close');
    state.phase = 'tls';
    await new Promise((resolve, reject) => {
        state.waiters.push(reject);
        const secure = tls.connect({
            socket: raw,
            servername: serverName(cfg),
            rejectUnauthorized: cfg.rejectUnauthorized,
            ca: trustedAuthorities(cfg.trustedCa) || undefined
        }, () => {
            state.phase = 'live';
            state.waiters.length = 0;
            resolve();
        });
        attach(state, secure);
    });
}

function bind(state, dn, password) {
    return request(state, bindRequest(dn, password), (op, resolve) => {
        if (op.tag !== OP.BIND_RESPONSE) throw new LdapError('ldap_protocol_error', 'expected a BindResponse');
        resolve(parseResult(op.value));
        return true;
    });
}

function search(state, params) {
    const entries = [];
    return request(state, searchRequest(params), (op, resolve) => {
        if (op.tag === OP.SEARCH_ENTRY) {
            entries.push(parseSearchEntry(op.value));
            return false;
        }
        // A SearchResultReference is a referral to another naming context. We
        // do not chase referrals, and a domain-root search on AD returns them
        // routinely, so ignoring them is the correct behaviour, not a gap.
        if (op.tag === OP.SEARCH_REFERENCE) return false;
        if (op.tag !== OP.SEARCH_DONE) throw new LdapError('ldap_protocol_error', 'unexpected search message');
        resolve({ entries, result: parseResult(op.value) });
        return true;
    });
}

/* ---------------------------------------------------------------- config --- */

function badConfig(why) {
    return new LdapError('ldap_bad_config', why);
}

/** How many authorities one directory may pin, and how large each may be. */
const MAX_PINNED = 8;
const MAX_PEM_LEN = 16 * 1024;

/**
 * The pinned authorities, keeping only what is shaped like a certificate.
 *
 * Not a validation of the certificate itself -- OpenSSL does that when it
 * builds the chain, and a PEM that will not parse simply never matches. This
 * is the cap and the shape check, so a corrupted store cannot hand `tls.connect`
 * a megabyte of arbitrary text.
 */
function cleanPemList(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const raw of value) {
        if (typeof raw !== 'string') continue;
        const pem = raw.trim();
        if (!pem || pem.length > MAX_PEM_LEN) continue;
        if (!pem.startsWith('-----BEGIN CERTIFICATE-----')) continue;
        if (!pem.includes('-----END CERTIFICATE-----')) continue;
        out.push(pem);
        if (out.length >= MAX_PINNED) break;
    }
    return out;
}

function normalizeConfig(config) {
    const c = (config && typeof config === 'object') ? config : {};

    const rawUrl = String(c.url || '').trim();
    if (!rawUrl) throw badConfig('no url');
    let u;
    try { u = new URL(rawUrl); } catch (_) { throw badConfig('url does not parse'); }
    if (u.protocol !== 'ldap:' && u.protocol !== 'ldaps:') throw badConfig('url is not ldap or ldaps');
    if (!u.hostname) throw badConfig('url has no host');

    const secure = u.protocol === 'ldaps:';
    const bindDn = String(c.bindDn || '').trim();
    const bindPassword = c.bindPassword === undefined || c.bindPassword === null ? '' : String(c.bindPassword);

    // A name with an empty password is an unauthenticated bind (RFC 4513 5.1.2),
    // which some directories accept and which grants nothing. It is always a
    // misconfiguration, and treating it as one here beats discovering later that
    // the service account was never actually authenticated.
    if (bindDn && !bindPassword) throw badConfig('bind DN set with an empty password');

    const timeoutMs = Number(c.timeoutMs) > 0
        ? Math.min(Number(c.timeoutMs), MAX_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS;

    return {
        host: u.hostname,
        port: Number(u.port) || (secure ? 636 : 389),
        secure,
        // StartTLS on an ldaps:// connection would be a second handshake inside
        // the first, so the flag is ignored rather than honoured there.
        startTls: !secure && c.startTls === true,
        rejectUnauthorized: c.rejectUnauthorized === false ? false : true,
        trustedCa: cleanPemList(c.trustedCa),
        bindDn,
        bindPassword,
        baseDn: String(c.baseDn || '').trim(),
        userFilter: String(c.userFilter || '').trim(),
        userDnTemplate: String(c.userDnTemplate || '').trim(),
        groupAttribute: String(c.groupAttribute || 'memberOf').trim() || 'memberOf',
        // Off unless asked for. Resolving nesting only ever adds groups, so it
        // only ever widens who may open a protected site; that is a decision an
        // operator makes, not a default that arrives with an upgrade.
        nestedGroups: c.nestedGroups === true,
        timeoutMs
    };
}

async function openOnce(cfg) {
    const state = createSession(cfg);
    try {
        await connectSocket(state, cfg);
        if (cfg.startTls) await upgradeToTls(state, cfg);
        return state;
    } catch (e) {
        closeSession(state);
        throw e;
    }
}

/**
 * Opens the session, and gives an untrusted handshake one second chance.
 *
 * There is exactly one TLS failure a retry can fix without anybody typing
 * anything: the authority was installed on this server after the trust store
 * was last read. That used to be documented as "restart Aegis", which is a
 * restart of an audit platform to pick up a file the operating system already
 * has. Re-reading the store and trying again costs one handshake and removes
 * the instruction entirely.
 *
 * Only `ldap_tls_untrusted` retries. A name mismatch, an expired certificate or
 * a refused bind will fail identically the second time, and retrying a bind is
 * how an account gets locked out.
 */
async function openSession(cfg) {
    try {
        return await openOnce(cfg);
    } catch (e) {
        if (e instanceof LdapError && e.ldapCode === 'ldap_tls_untrusted' && refreshTrust()) {
            return await openOnce(cfg);
        }
        throw e;
    }
}

/** The service account bind, or the anonymous bind when no bindDn is set. */
async function bindService(state, cfg) {
    const res = await bind(state, cfg.bindDn, cfg.bindPassword);
    if (res.resultCode !== RESULT.SUCCESS) {
        throw new LdapError('ldap_bind_refused',
            res.diagnostic || `bind refused with result ${res.resultCode}`);
    }
}

/**
 * What a failed user bind means.
 *
 * 49 is the only code that says "wrong password". A DC that requires LDAP
 * signing or channel binding answers 8 (strongerAuthRequired) to a simple bind
 * on an unprotected connection whatever the password is, and reporting that as
 * bad credentials would send an operator chasing the wrong problem.
 */
/**
 * What Active Directory means by result 49, when it is willing to say.
 *
 * AD answers ten different situations with `invalidCredentials` and tells them
 * apart only inside the diagnostic message, as `data <hex>`. Reading all of
 * them as "wrong password" sends a user whose password expired to type the same
 * password again, and their administrator looking for a fault in Aegis.
 *
 * Two sub-codes are deliberately absent. `52e` is a wrong password, which is
 * what `ldap_invalid_credentials` already says. `525` is "no such account", and
 * passing that back to an unauthenticated visitor turns the login form into an
 * account enumerator -- the one sub-code worth losing.
 *
 * Everything left in the table confirms the account exists, which is a
 * disclosure made on purpose: this gate stands in front of a site deployed for
 * the people of one directory, and telling them their password expired is the
 * whole reason they came to the form.
 */
const AD_SUB_CODE = {
    530: 'ldap_logon_denied',          // not permitted to log on at this hour
    531: 'ldap_logon_denied',          // not permitted from this workstation
    532: 'ldap_password_expired',
    533: 'ldap_account_disabled',
    701: 'ldap_account_expired',
    773: 'ldap_password_must_change',  // must change at next logon
    775: 'ldap_account_locked'
};

/**
 * The sub-code, or null.
 *
 * Three hex digits and no more: every code Microsoft documents is three wide,
 * and an unanchored match would read `data 5320000` as an expired password.
 */
function adSubCode(diagnostic) {
    const m = /\bdata\s+([0-9a-f]{3})\b/i.exec(String(diagnostic || ''));
    return m ? m[1].toLowerCase() : null;
}

function userBindError(res) {

    if (res.resultCode === RESULT.INVALID_CREDENTIALS) {

        const sub = adSubCode(res.diagnostic);

        // The diagnostic is kept as the detail whatever it says: it is the DC's

        // own sentence, and it is what an administrator reads in the log when a

        // sub-code this build does not know shows up.

        return new LdapError(AD_SUB_CODE[sub] || 'ldap_invalid_credentials',

            res.diagnostic || 'bind rejected');

    }

    return new LdapError('ldap_bind_refused',
        res.diagnostic || `user bind refused with result ${res.resultCode}`);
}

function attributesFor(cfg) {
    // `objectSid` is always asked for. It is the only identifier that survives
    // a rename and a move between OUs, and an allow list of named people is
    // matched on it. A directory that has no such attribute returns nothing,
    // which costs one name in the request and no behaviour anywhere else.
    const wanted = [cfg.groupAttribute, 'displayName', 'cn', 'objectSid'];
    // `primaryGroupID` means nothing on a directory that is not AD, and is read
    // only to compute the primary group the nested walk would otherwise miss.
    if (cfg.nestedGroups) wanted.push('primaryGroupID');
    const seen = new Set();
    return wanted.filter((a) => {
        const k = a.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

/**
 * The attribute list that asks for no attributes at all.
 *
 * An empty list in a SearchRequest does not mean "none", it means "all user
 * attributes" (RFC 4511 4.5.1.8). Searching for groups with an empty list would
 * pull every attribute of every group the user is in. `1.1` is the reserved OID
 * that means no attributes, which is what we want: the DN of each entry is
 * already in the SearchResultEntry.
 */
const NO_ATTRIBUTES = ['1.1'];

/** A user in more groups than this has a directory problem, not a login. */
const MAX_GROUPS = 500;

/** Rows one directory search may hand a picker. A list, not a directory dump. */
const MAX_USER_HITS = 25;

/* --------------------------------------------------------------- AD SIDs -- */

/**
 * A binary SID as its parts, or null when the bytes are not a SID.
 *
 * revision(1) subAuthorityCount(1) identifierAuthority(6, big-endian)
 * then one 4-byte little-endian sub-authority per count. The last of those is
 * the RID. Every field is checked because these bytes come off the network.
 */
function parseSid(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
    const revision = buf[0];
    const count = buf[1];
    if (revision !== 1) return null;
    // 15 is the protocol maximum, and the length has to agree with the count or
    // the buffer is something else that happens to start with the right byte.
    if (count < 1 || count > 15) return null;
    if (buf.length !== 8 + (4 * count)) return null;
    return { revision, count };
}

/**
 * A binary `objectSid` as the canonical `S-1-5-21-...-1103` text.
 *
 * An allow list of named people is matched on this string, so it has to be
 * byte-for-byte the one every other Windows tool prints: an operator comparing
 * what Aegis stored against what `whoami /user` says must see the same value.
 *
 * Sub-authorities are unsigned 32-bit little-endian. `readUInt32LE` and not
 * `readInt32LE`: a RID above 2^31 is legal and a signed read would print it
 * negative, which matches nothing. The identifier authority is 48 bits
 * big-endian, which no Buffer helper reads in one call, hence the two reads.
 *
 * Returns '' rather than throwing on anything `parseSid` rejects. Every caller
 * treats the empty string as "this entry has no usable identity" and drops it,
 * which is the behaviour a malformed attribute should produce.
 */
function sidToString(buf) {
    if (!parseSid(buf)) return '';
    const count = buf[1];
    const authority = (buf.readUInt16BE(2) * 0x100000000) + buf.readUInt32BE(4);
    let out = `S-${buf[0]}-${authority}`;
    for (let i = 0; i < count; i++) out += `-${buf.readUInt32LE(8 + (i * 4))}`;
    return out;
}

/**
 * The SID of the user's primary group.
 *
 * Primary group membership is stored as a number on the user, not as a link, so
 * no search over `member` or `memberOf` will ever find it. The group's SID is
 * the user's SID with the RID swapped for `primaryGroupID`: both live in the
 * same domain, so every byte before the last sub-authority is shared. This is
 * why `Domain Users` shows up in no `memberOf` list anywhere.
 */
function primaryGroupSid(userSid, primaryGroupId) {
    const parsed = parseSid(userSid);
    if (!parsed) return null;
    const rid = Number(primaryGroupId);
    if (!Number.isInteger(rid) || rid < 0 || rid > 0xffffffff) return null;
    const out = Buffer.from(userSid);
    out.writeUInt32LE(rid, out.length - 4);
    return out;
}

/**
 * Every group the user is in, direct and transitive, primary group included.
 *
 * Best effort by construction. This runs after the password has already been
 * accepted, so a directory that refuses either search leaves the caller with
 * the direct `memberOf` list rather than turning a correct password into a
 * failed login. Both searches are AD-specific and neither is expected to work
 * anywhere else.
 *
 * On the login path this runs on a connection already re-bound as the user, so
 * it reads with the user's rights. In AD, Authenticated Users may read group
 * objects, which is what makes that work; where it does not, the fallback above
 * applies.
 */
async function collectGroups(state, cfg, userDn, entry, direct) {
    const out = [];
    const seen = new Set();
    const add = (dn) => {
        const value = String(dn || '').trim();
        if (!value) return;
        const k = value.toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        out.push(value);
    };
    for (const g of (direct || [])) add(g);

    // Nesting: the DC walks the graph and answers with the closure.
    try {
        const found = await search(state, {
            baseDn: cfg.baseDn,
            filter: extensibleMatchFilter('member', IN_CHAIN_OID, userDn),
            attributes: NO_ATTRIBUTES,
            sizeLimit: MAX_GROUPS
        });
        for (const e of found.entries) add(e.dn);
    } catch (_) { /* not AD, or not permitted: the direct list stands */ }

    // Primary group: computed, then looked up to get its DN.
    try {
        const rawSid = entry && entry.raw && entry.raw.objectsid && entry.raw.objectsid[0];
        const rid = entry && entry.attributes && entry.attributes.primarygroupid
            && entry.attributes.primarygroupid[0];
        const sid = (rawSid && rid !== undefined) ? primaryGroupSid(rawSid, rid) : null;
        if (sid) {
            const found = await search(state, {
                baseDn: cfg.baseDn,
                filter: equalityFilter('objectSid', sid),
                attributes: NO_ATTRIBUTES,
                sizeLimit: 2
            });
            for (const e of found.entries) add(e.dn);
        }
    } catch (_) { /* same: the primary group is a bonus, never a gate */ }

    return out;
}

function shapeUser(cfg, dn, attributes, raw) {
    const attrs = attributes || Object.create(null);
    const groups = attrs[cfg.groupAttribute.toLowerCase()] || [];
    const displayName = (attrs.displayname && attrs.displayname[0]) || (attrs.cn && attrs.cn[0]) || '';
    const out = { ok: true, dn, groups };
    if (displayName) out.displayName = displayName;
    // The identity an allow list of named people is matched on.
    //
    // Absent whenever the entry could not be read, which the direct-bind path
    // in `verify` does best effort: a directory that refuses the lookup must
    // not turn a good password into a failed login. `siteAuth` refuses the
    // session rather than guessing when a list needs this field, so the gap
    // fails closed at the one place that can tell the difference.
    const sid = sidToString((raw && raw.objectsid && raw.objectsid[0]) || null);
    if (sid) out.sid = sid;
    return out;
}

/** `shapeUser`, plus the nested and primary groups when the operator asked. */
async function shapeUserResolved(state, cfg, dn, entry) {
    const out = shapeUser(cfg, dn, entry ? entry.attributes : null, entry ? entry.raw : null);
    if (!cfg.nestedGroups || !cfg.baseDn) return out;
    out.groups = await collectGroups(state, cfg, dn, entry, out.groups);
    return out;
}

/* ------------------------------------------------------------------- api --- */

/**
 * Checks a username and password against the directory.
 *
 * Never throws: a caller in a request handler gets `{ ok:false, error:'<code>' }`
 * for every fault, from a typo in the URL to a DC that stopped answering.
 */
async function verify(config, username, password) {
    // An LDAP simple bind with an empty password is not a failed bind. RFC 4513
    // section 5.1.1 makes it an anonymous bind, and the directory answers
    // success. A client that reads "the bind succeeded" as "the password was
    // right" therefore lets anyone in who submits a blank password. This is the
    // single most important line in the file: refuse before a socket is opened,
    // so no answer from any server can ever be misread this way.
    if (password === undefined || password === null || String(password) === '') {
        return { ok: false, error: 'ldap_invalid_credentials' };
    }
    const user = String(username === undefined || username === null ? '' : username);
    // A NUL or a control character in a username belongs to an injection
    // attempt, not to a logon name. Refuse rather than escape and hope.
    if (!user.trim() || /[\u0000-\u001f\u007f]/.test(user)) {
        return { ok: false, error: 'ldap_invalid_credentials' };
    }

    let state = null;
    try {
        const cfg = normalizeConfig(config);
        const pass = String(password);

        if (cfg.userDnTemplate) {
            if (!cfg.userDnTemplate.includes('{username}')) throw badConfig('userDnTemplate has no {username}');
            const dn = cfg.userDnTemplate.split('{username}').join(escapeDn(user));

            state = await openSession(cfg);
            const res = await bind(state, dn, pass);
            if (res.resultCode !== RESULT.SUCCESS) throw userBindError(res);

            // Direct bind means there was no search, so there is no entry to
            // read groups from. If the operator also configured a base and a
            // filter we look the user up as themselves, which reads their own
            // entry and needs no privilege. Best effort on purpose: a directory
            // that refuses it must not turn a good password into a failed login.
            let entry = null;
            if (cfg.baseDn && cfg.userFilter) {
                try {
                    const found = await search(state, {
                        baseDn: cfg.baseDn,
                        filter: parseFilterString(cfg.userFilter.split('{username}').join(escapeFilter(user))),
                        attributes: attributesFor(cfg),
                        sizeLimit: 2
                    });
                    if (found.entries.length === 1) entry = found.entries[0];
                } catch (_) { entry = null; }
            }
            return await shapeUserResolved(state, cfg, dn, entry);
        }

        if (!cfg.baseDn) throw badConfig('no baseDn');
        if (!cfg.userFilter) throw badConfig('no userFilter');
        const filter = parseFilterString(cfg.userFilter.split('{username}').join(escapeFilter(user)));

        state = await openSession(cfg);
        await bindService(state, cfg);

        // sizeLimit 2 is enough to tell "one match" from "more than one" without
        // making the DC walk the rest of the domain for an ambiguous filter.
        const found = await search(state, {
            baseDn: cfg.baseDn,
            filter,
            attributes: attributesFor(cfg),
            sizeLimit: 2
        });
        if (!found.entries.length) {
            if (found.result.resultCode !== RESULT.SUCCESS &&
                found.result.resultCode !== RESULT.NO_SUCH_OBJECT) {
                throw new LdapError('ldap_protocol_error', found.result.diagnostic ||
                    `search failed with result ${found.result.resultCode}`);
            }
            throw new LdapError('ldap_user_not_found', 'no entry matched');
        }
        if (found.entries.length > 1) throw new LdapError('ldap_ambiguous_user', 'more than one entry matched');

        const entry = found.entries[0];
        if (!entry.dn) throw new LdapError('ldap_protocol_error', 'entry without a DN');

        // Re-binding turns this connection into the user's connection. Anything
        // read after this point is read with the user's rights, which is why the
        // groups come from the entry above and not from a second search.
        const res = await bind(state, entry.dn, pass);
        if (res.resultCode !== RESULT.SUCCESS) throw userBindError(res);

        return await shapeUserResolved(state, cfg, entry.dn, entry);
    } catch (e) {
        return { ok: false, error: (e && e.ldapCode) || 'ldap_protocol_error' };
    } finally {
        // Closes on every path, including the timeout that already destroyed the
        // socket and the thrown config error that never opened one.
        if (state) closeSession(state);
    }
}

/**
 * The groups a user has right now, with no password.
 *
 * A session records the group list from the moment of login. Nothing after that
 * notices the user being taken out of the allowed group, so the session outlives
 * the entitlement it was granted for. This lets the guard ask the directory
 * again, using the service account it is already configured with.
 *
 * Not an authentication. It proves nothing about who is on the other end of the
 * connection and must only ever be used to re-check a session that a real
 * `verify` created. Calling it in place of `verify` would let anyone in under
 * any name that exists.
 *
 * Requires the search configuration. A `userDnTemplate`-only setup binds as the
 * user and has no service account to reuse, so there is nothing to ask with;
 * that returns `ldap_bad_config` and the caller keeps the session it has.
 */
async function lookup(config, username) {
    const user = String(username === undefined || username === null ? '' : username);
    if (!user.trim() || /[\u0000-\u001f\u007f]/.test(user)) {
        return { ok: false, error: 'ldap_user_not_found' };
    }

    let state = null;
    try {
        const cfg = normalizeConfig(config);
        if (!cfg.baseDn) throw badConfig('no baseDn');
        if (!cfg.userFilter) throw badConfig('no userFilter');
        const filter = parseFilterString(cfg.userFilter.split('{username}').join(escapeFilter(user)));

        state = await openSession(cfg);
        await bindService(state, cfg);

        const found = await search(state, {
            baseDn: cfg.baseDn,
            filter,
            attributes: attributesFor(cfg),
            sizeLimit: 2
        });
        if (!found.entries.length) throw new LdapError('ldap_user_not_found', 'no entry matched');
        if (found.entries.length > 1) throw new LdapError('ldap_ambiguous_user', 'more than one entry matched');

        const entry = found.entries[0];
        if (!entry.dn) throw new LdapError('ldap_protocol_error', 'entry without a DN');

        // No user bind on this path, so the searches below run as the service
        // account. It generally reads more than the user can, which can only
        // widen the list; a session is dropped on what this returns, never
        // granted by it, so a wider answer is the safe direction.
        return await shapeUserResolved(state, cfg, entry.dn, entry);
    } catch (e) {
        return { ok: false, error: (e && e.ldapCode) || 'ldap_protocol_error' };
    } finally {
        if (state) closeSession(state);
    }
}

/**
 * The people whose name starts with what the operator typed.
 *
 * `lookup` cannot serve this and should not be bent into it: it resolves one
 * account and refuses the moment a second matches, which is exactly right for
 * a login and useless for a picker. This searches the three attributes a person
 * is actually known by and returns a short page of them.
 *
 * The SID is the identity that gets stored; `login`, `name` and `mail` travel
 * back only so the operator recognises the row they are picking. An entry
 * without a SID is dropped rather than offered: it could be chosen and would
 * then match nothing at login, which is a grant of nothing that looks like a
 * grant of something.
 *
 * Two characters minimum. A one-character prefix on a domain is a scan the
 * controller pays for and returns more rows than anyone can read.
 *
 * `escapeFilter` neutralises every wildcard in the operator's text, and the
 * `*` that makes this a prefix search is appended after escaping. Reversing
 * those two steps is how a search field becomes a filter injection.
 *
 * A `sizeLimitExceeded` from the directory is not an error here. `search`
 * resolves on SearchResultDone whatever the result code, so the entries that
 * did arrive are returned and the cap does its job.
 */
async function searchUsers(config, query) {
    const q = String(query === undefined || query === null ? '' : query).trim();
    if (q.length < 2 || /[ -]/.test(q)) return { ok: true, users: [] };

    let state = null;
    try {
        const cfg = normalizeConfig(config);
        if (!cfg.baseDn) throw badConfig('no baseDn');

        const safe = escapeFilter(q);
        const filter = parseFilterString(
            '(&(objectClass=user)(objectCategory=person)(|'
            + `(sAMAccountName=${safe}*)(displayName=${safe}*)(mail=${safe}*)))`
        );

        state = await openSession(cfg);
        await bindService(state, cfg);

        const found = await search(state, {
            baseDn: cfg.baseDn,
            filter,
            attributes: ['sAMAccountName', 'displayName', 'cn', 'mail', 'objectSid'],
            sizeLimit: MAX_USER_HITS
        });

        const users = [];
        for (const entry of found.entries) {
            const attrs = entry.attributes || Object.create(null);
            const raw = entry.raw || Object.create(null);
            const sid = sidToString((raw.objectsid && raw.objectsid[0]) || null);
            if (!sid) continue;
            users.push({
                sid,
                login: (attrs.samaccountname && attrs.samaccountname[0]) || '',
                name: (attrs.displayname && attrs.displayname[0]) || (attrs.cn && attrs.cn[0]) || '',
                mail: (attrs.mail && attrs.mail[0]) || ''
            });
        }
        users.sort((a, b) => String(a.name || a.login).localeCompare(String(b.name || b.login)));
        return { ok: true, users };
    } catch (e) {
        return { ok: false, error: (e && e.ldapCode) || 'ldap_protocol_error' };
    } finally {
        if (state) closeSession(state);
    }
}

/**
 * Opens a connection, binds the service account, closes. Backs the Test button.
 *
 * Unlike `verify` this returns `detail`, because an admin pressing Test wants
 * the DC's own diagnostic. That string comes from the directory and never from
 * the configuration, so no secret can travel in it.
 */
async function testConnection(config) {
    let state = null;
    try {
        const cfg = normalizeConfig(config);
        state = await openSession(cfg);
        await bindService(state, cfg);
        return { ok: true };
    } catch (e) {
        const out = { ok: false, error: (e && e.ldapCode) || 'ldap_protocol_error' };
        if (e && e.detail) out.detail = e.detail;
        return out;
    } finally {
        if (state) closeSession(state);
    }
}

/* ---------------------------------------------------------- certificate --- */

/** `{ CN: 'dc01', O: 'Corp' }` -> `CN=dc01, O=Corp`. Readable, not a real DN. */
function dnString(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const parts = [];
    for (const key of Object.keys(obj)) {
        const v = obj[key];
        for (const one of Array.isArray(v) ? v : [v]) parts.push(`${key}=${sanitize(one)}`);
    }
    return parts.join(', ').slice(0, 300);
}

/** DER as it came off the wire, wrapped as PEM so `tls.connect` will take it. */
function pemOf(cert) {
    if (!cert || !Buffer.isBuffer(cert.raw)) return '';
    const b64 = cert.raw.toString('base64');
    const lines = [];
    for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
    return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/**
 * One certificate as the settings page shows it.
 *
 * The fingerprint is the field that matters and the reason this is worth
 * showing at all: it is what an operator compares against their own CA before
 * pinning it, and comparing subject names would compare something an attacker
 * chooses.
 */
function describeCert(cert) {
    const subject = dnString(cert.subject);
    const issuer = dnString(cert.issuer);
    return {
        subject,
        issuer,
        // `subject.CN` alone, for a heading that is not a DN soup.
        commonName: (cert.subject && String(cert.subject.CN || '').slice(0, 128)) || '',
        validFrom: sanitize(cert.valid_from || ''),
        validTo: sanitize(cert.valid_to || ''),
        fingerprint256: sanitize(cert.fingerprint256 || ''),
        altNames: String(cert.subjectaltname || '').split(', ').filter(Boolean).slice(0, 32),
        selfSigned: !!subject && subject === issuer
    };
}

/**
 * The names a certificate is valid for, so the page can offer the right one.
 *
 * `DNS:dc01.corp.local` is the form OpenSSL hands back; the prefix is dropped
 * and anything that is not a DNS name is left out, because an IP entry is not
 * something to put in an `ldaps://` URL when a hostname is available.
 */
function dnsNamesOf(cert) {
    const out = [];
    for (const entry of String(cert.subjectaltname || '').split(', ')) {
        if (entry.startsWith('DNS:')) {
            const name = sanitize(entry.slice(4));
            if (name && !name.startsWith('*') && !out.includes(name)) out.push(name);
        }
    }
    if (!out.length && cert.subject && cert.subject.CN) {
        const cn = sanitize(cert.subject.CN);
        if (cn.includes('.')) out.push(cn);
    }
    return out.slice(0, 8);
}

/**
 * Looks at the certificate a controller presents, without validating it and
 * without binding.
 *
 * This is the route out of a TLS dead end. The old advice -- install the
 * authority in Windows and restart, or stop validating -- assumed the operator
 * could see what was being rejected. They could not: the handshake fails before
 * anything is shown, so the choice was between an administrative task on the
 * host and switching off the protection. Showing the chain turns it into a
 * decision with the evidence attached.
 *
 * Two properties hold it together. **No password leaves this function**: the
 * probe connects, reads the peer chain and closes, and never sends a
 * BindRequest, so a hostile endpoint learns nothing it did not already have by
 * accepting a TCP connection. And validation is off *only here*, deliberately,
 * because a certificate that validated would not need looking at; every other
 * path keeps `rejectUnauthorized` exactly as configured.
 *
 * `anchor` is the top of the chain -- the authority to pin. On a controller
 * with a self-signed certificate and no CA, the leaf is its own anchor, which
 * is the correct thing to pin: it authenticates that one host and nothing else.
 */
async function inspectCertificate(config) {
    let state = null;
    try {
        const cfg = normalizeConfig(config);
        if (!cfg.secure && !cfg.startTls) return { ok: false, error: 'ldap_not_tls' };

        state = await openOnce(Object.assign({}, cfg, { rejectUnauthorized: false, trustedCa: [] }));
        const sock = state.sock;
        if (!sock || typeof sock.getPeerCertificate !== 'function') {
            return { ok: false, error: 'ldap_tls_failed' };
        }

        const leaf = sock.getPeerCertificate(true);
        if (!leaf || !leaf.raw) return { ok: false, error: 'ldap_tls_failed' };

        // Walk to the top. The root self-references rather than terminating, so
        // the fingerprint set is the loop guard, not a null check.
        const chain = [];
        const seen = new Set();
        let cur = leaf;
        while (cur && cur.raw && !seen.has(cur.fingerprint256)) {
            seen.add(cur.fingerprint256);
            chain.push(cur);
            cur = cur.issuerCertificate;
        }
        const anchor = chain[chain.length - 1];

        // The other half of a failed handshake: the chain can be perfect and the
        // name still wrong. Asked here explicitly because the probe did not ask.
        let nameError = null;
        try {
            const bad = tls.checkServerIdentity(cfg.host, leaf);
            if (bad) nameError = sanitize(bad.message);
        } catch (e) {
            nameError = sanitize(e.message);
        }

        return {
            ok: true,
            host: cfg.host,
            port: cfg.port,
            hostMatches: !nameError,
            nameError,
            names: dnsNamesOf(leaf),
            leaf: describeCert(leaf),
            anchor: Object.assign(describeCert(anchor), { pem: pemOf(anchor) }),
            chain: chain.map(describeCert)
        };
    } catch (e) {
        const out = { ok: false, error: (e && e.ldapCode) || 'ldap_protocol_error' };
        if (e && e.detail) out.detail = e.detail;
        return out;
    } finally {
        if (state) closeSession(state);
    }
}

module.exports = {
    verify, lookup, searchUsers, testConnection, inspectCertificate, refreshTrust,
    escapeFilter, escapeDn, encode, decode, sidToString,
    // Exercised directly by tests/ldap.test.js: the SID arithmetic has no
    // observable effect without a directory that publishes a primary group.
    parseSid, primaryGroupSid, IN_CHAIN_OID
};
