/**
 * The host name a site link is built on.
 *
 * The link follows the host the operator reached the dashboard on, which is
 * right from another machine and useless on the server itself: opened there as
 * 127.0.0.1, every card said http://127.0.0.1:<port>/, an address nobody else
 * can open. A loopback host is replaced by the machine's network address.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { shareableHost, isLoopback } = require('../siteAddress');

const nic = (address, extra) => Object.assign({ address, family: 'IPv4', internal: false, netmask: '255.255.255.0' }, extra || {});

const NICS = {
    'Loopback Pseudo-Interface 1': [nic('127.0.0.1', { internal: true, netmask: '255.0.0.0' })],
    'Ethernet 2': [nic('169.254.12.4', { netmask: '255.255.0.0' })],
    Ethernet: [{ address: 'fe80::1', family: 'IPv6', internal: false }, nic('192.168.1.103')]
};

test('every loopback spelling is a loopback', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
        assert.strictEqual(isLoopback(h), true, h);
    }
    for (const h of ['192.168.1.103', 'srv.corp.local', '10.0.0.5', '']) {
        assert.strictEqual(isLoopback(h), false, h);
    }
});

test('a loopback host becomes the machine network address', () => {
    for (const h of ['127.0.0.1', 'localhost', '[::1]', '::1']) {
        assert.strictEqual(shareableHost(h, NICS), '192.168.1.103', h);
    }
});

test('a host reached from the network is kept as typed', () => {
    assert.strictEqual(shareableHost('10.0.0.5', NICS), '10.0.0.5');
    assert.strictEqual(shareableHost('srv.corp.local', NICS), 'srv.corp.local');
});

test('a private address wins over a public one', () => {
    const nics = { a: [nic('203.0.113.7')], b: [nic('10.20.30.40')] };
    assert.strictEqual(shareableHost('127.0.0.1', nics), '10.20.30.40');
});

test('a public address is used when it is the only one', () => {
    assert.strictEqual(shareableHost('127.0.0.1', { a: [nic('203.0.113.7')] }), '203.0.113.7');
});

test('a machine with no outside address keeps the host it was given', () => {
    const nics = { lo: [nic('127.0.0.1', { internal: true })], ll: [nic('169.254.1.1')] };
    assert.strictEqual(shareableHost('127.0.0.1', nics), '127.0.0.1');
    assert.strictEqual(shareableHost('localhost', {}), 'localhost');
});
