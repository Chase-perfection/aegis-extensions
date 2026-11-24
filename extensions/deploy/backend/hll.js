/**
 * An anonymous count of distinct visitors: a HyperLogLog sketch.
 *
 * Audience keeps raw events, with their pseudonymous visitor ids, for 90 days.
 * Past that only day totals stay, and a total of "visitors" cannot be added
 * across days: the same person comes back. This sketch is what lets a period
 * of six months still say how many distinct people it saw.
 *
 * It holds 1024 registers (p = 10), each the longest run of leading zero bits
 * seen in the part of a visitor id that falls into it. Nothing in it names or
 * can confirm a visitor: a register is a small number shared by every id that
 * lands on it. Two sketches merge by taking the larger register, so a period's
 * sketch is the merge of its days. The standard error is 1.04 / sqrt(1024),
 * about 3 %.
 *
 * Input is the 16 hex characters of a visitor id (audience.visitorId), which is
 * already an HMAC output and so already uniformly spread: no second hash.
 */

'use strict';

const P = 10;
const M = 1 << P;
const REST = 64 - P;
const ALPHA = 0.7213 / (1 + 1.079 / M);
const HEX_RE = /^[0-9a-f]{16}/i;

function create() {
    return new Uint8Array(M);
}

function add(sketch, hex) {
    const m = HEX_RE.exec(String(hex || ''));
    if (!m) return;
    const value = BigInt('0x' + m[0]);
    const index = Number(value >> BigInt(REST));
    const rest = value & ((1n << BigInt(REST)) - 1n);
    // Leading zeros of the remaining 54 bits, plus one; 55 when all are zero.
    const rank = rest === 0n ? REST + 1 : REST - rest.toString(2).length + 1;
    if (rank > sketch[index]) sketch[index] = rank;
}

function merge(into, other) {
    for (let i = 0; i < M; i++) if (other[i] > into[i]) into[i] = other[i];
}

function count(sketch) {
    let sum = 0;
    let zeros = 0;
    for (let i = 0; i < M; i++) {
        sum += Math.pow(2, -sketch[i]);
        if (sketch[i] === 0) zeros++;
    }
    const estimate = ALPHA * M * M / sum;
    if (estimate <= 2.5 * M && zeros > 0) return Math.round(M * Math.log(M / zeros));
    return Math.round(estimate);
}

function encode(sketch) {
    return Buffer.from(sketch).toString('base64');
}

function decode(b64) {
    if (typeof b64 !== 'string') return null;
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== M) return null;
    return new Uint8Array(buf);
}

module.exports = { create, add, merge, count, encode, decode, M };
