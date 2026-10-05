/**
 * The path from a sandbox account to its database.
 *
 * `storageNetwork._setRunner` replaces PowerShell with a function that records
 * the scripts it was handed. The arithmetic is the part that fails silently: a
 * range off by one either leaves the database blocked or opens its neighbour.
 * So `subtract` has a case table, checked in both directions: the address is
 * out of what stays blocked, and every other address of the subnet is in.
 *
 * Every test sets `AEGIS_DEPLOY_FIREWALL` itself and puts it back.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const net = require('../storageNetwork');

async function withFirewall(answer, fn) {
    const before = process.env.AEGIS_DEPLOY_FIREWALL;
    process.env.AEGIS_DEPLOY_FIREWALL = '1';
    const scripts = [];
    net._setRunner((script) => {
        scripts.push(script);
        return answer(script, scripts.length - 1);
    });
    try {
        return await fn(scripts);
    } finally {
        net._setRunner(null);
        if (before === undefined) delete process.env.AEGIS_DEPLOY_FIREWALL;
        else process.env.AEGIS_DEPLOY_FIREWALL = before;
    }
}

/** A firewall holding these rules: answers the read, accepts every write. */
function holding(state) {
    return (script) => (script.includes('ConvertTo-Json')
        ? { ok: true, out: JSON.stringify(state) }
        : { ok: true, out: '' });
}

const ACCOUNT = 'aegis-run-01';
const DENY_24 = { name: 'AegisBuild-aegis-run-01-DenyDomain-192_0_2_0_24', enabled: 'True', remote: ['192.0.2.0/255.255.255.0'] };
const DENY_10 = { name: 'AegisBuild-aegis-run-01-DenyDomain-10_0_0_0_8', enabled: 'True', remote: ['10.0.0.0/255.0.0.0'] };

/** Whether an address falls in what a list of `-RemoteAddress` entries blocks. */
function blocks(entries, ip) {
    const at = net._entryRange(ip)[0];
    return entries.some((e) => {
        const r = net._entryRange(e);
        return at >= r[0] && at <= r[1];
    });
}

test('subtract leaves the address out and every neighbour in', () => {
    const cases = [
        // subnet, address, expected entries
        ['192.0.2.0/24', '192.0.2.10', ['192.0.2.0-192.0.2.9', '192.0.2.11-192.0.2.255']],
        ['192.0.2.0/24', '192.0.2.0', ['192.0.2.1-192.0.2.255']],
        ['192.0.2.0/24', '192.0.2.255', ['192.0.2.0-192.0.2.254']],
        ['192.0.2.0/24', '192.0.2.1', ['192.0.2.0', '192.0.2.2-192.0.2.255']],
        ['192.0.2.0/24', '192.0.2.254', ['192.0.2.0-192.0.2.253', '192.0.2.255']],
        ['10.0.0.0/8', '10.20.30.40', ['10.0.0.0-10.20.30.39', '10.20.30.41-10.255.255.255']],
        ['192.0.2.10/32', '192.0.2.10', []],
        ['192.0.2.8/31', '192.0.2.9', ['192.0.2.8']],
        // a host bit set in the subnet is still the subnet
        ['192.0.2.77/24', '192.0.2.10', ['192.0.2.0-192.0.2.9', '192.0.2.11-192.0.2.255']],
        // an address outside: the block is returned as it was
        ['192.0.2.0/24', '198.51.100.7', ['192.0.2.0/24']],
        ['192.0.2.0/24', 'not an address', ['192.0.2.0/24']]
    ];
    for (const [cidr, ip, expected] of cases) {
        assert.deepStrictEqual(net.subtract(cidr, ip), expected, `${cidr} minus ${ip}`);
    }

    // The other direction, on a whole /24: one address out, 255 still blocked.
    const left = net.subtract('192.0.2.0/24', '192.0.2.10');
    let stillBlocked = 0;
    for (let i = 0; i < 256; i++) {
        const ip = `192.0.2.${i}`;
        if (blocks(left, ip)) stillBlocked++;
        else assert.strictEqual(ip, '192.0.2.10', `${ip} was opened and nobody asked`);
    }
    assert.strictEqual(stillBlocked, 255);
    assert.strictEqual(blocks(left, '192.0.3.0'), false);
    assert.strictEqual(blocks(left, '192.0.1.255'), false);

    assert.strictEqual(net.subtract('192.0.2.0/33', '192.0.2.1'), null);
    assert.strictEqual(net.subtract('garbage', '192.0.2.1'), null);
});

test('contains and the forms Windows writes an address in', () => {
    assert.strictEqual(net.contains('192.0.2.0/24', '192.0.2.255'), true);
    assert.strictEqual(net.contains('192.0.2.0/24', '192.0.3.0'), false);
    assert.strictEqual(net.contains('0.0.0.0/0', '203.0.113.9'), true);
    assert.strictEqual(net.contains('192.0.2.0/24', '192.0.2.256'), false);

    assert.deepStrictEqual(net._entryRange('192.0.2.0/255.255.255.0'), net._entryRange('192.0.2.0/24'));
    assert.deepStrictEqual(net._entryRange('192.0.2.5'), net._entryRange('192.0.2.5-192.0.2.5'));
    assert.strictEqual(net._entryRange('192.0.2.0/255.0.255.0'), null, 'a mask with a hole is not a block');
    assert.strictEqual(net._entryRange('LocalSubnet'), null);
    assert.strictEqual(net._entryRange('192.0.2.9-192.0.2.1'), null);

    assert.strictEqual(net._sameAddresses(['192.0.2.11-192.0.2.255', '192.0.2.0-192.0.2.9'],
        ['192.0.2.0-192.0.2.9', '192.0.2.11-192.0.2.255']), true);
    assert.strictEqual(net._sameAddresses(['192.0.2.0/255.255.255.0'], ['192.0.2.0/24']), true);
    assert.strictEqual(net._sameAddresses(['Any'], ['192.0.2.0/24']), false);
});

test('a rule name gives its subnet back, and a foreign name gives nothing', () => {
    assert.strictEqual(net.subnetFromRuleName(DENY_24.name, ACCOUNT), '192.0.2.0/24');
    assert.strictEqual(net.subnetFromRuleName(DENY_10.name, ACCOUNT), '10.0.0.0/8');
    assert.strictEqual(net.subnetFromRuleName(DENY_24.name, 'aegis-run-02'), null, 'another account');
    assert.strictEqual(net.subnetFromRuleName("AegisBuild-aegis-run-01-DenyDomain-1_2_3_4_8'; Remove-Item", ACCOUNT), null);
    assert.strictEqual(net.subnetFromRuleName('AegisBuild-aegis-run-01-AllowWeb', ACCOUNT), null);
    assert.strictEqual(net.subnetFromRuleName('AegisBuild-aegis-run-01-DenyDomain-1_2_3_4_40', ACCOUNT), null);
});

test('the ports that stay blocked are all of them but the database port', () => {
    assert.deepStrictEqual(net.otherPorts(5432), ['1-5431', '5433-65535']);
    assert.deepStrictEqual(net.otherPorts(1), ['2-65535']);
    assert.deepStrictEqual(net.otherPorts(65535), ['1-65534']);
    assert.deepStrictEqual(net.otherPorts(2), ['1', '3-65535']);
    assert.deepStrictEqual(net.otherPorts(65534), ['1-65533', '65535']);
});

test('off unless the host switch is set: nothing is read and nothing is written', async () => {
    const before = process.env.AEGIS_DEPLOY_FIREWALL;
    delete process.env.AEGIS_DEPLOY_FIREWALL;
    const scripts = [];
    net._setRunner((s) => { scripts.push(s); return { ok: true, out: '{}' }; });
    try {
        const res = await net.ensureFor(ACCOUNT, { host: '192.0.2.10', port: 5432 });
        assert.deepStrictEqual(res, { ok: true, changed: false, managed: false });
        assert.strictEqual(scripts.length, 0);
    } finally {
        net._setRunner(null);
        if (before !== undefined) process.env.AEGIS_DEPLOY_FIREWALL = before;
    }
});

test('opening: the address is confined before the subnet is narrowed', async () => {
    await withFirewall(holding({ deny: [DENY_24, DENY_10], data: null }), async (scripts) => {
        const res = await net.ensureFor(ACCOUNT, { host: '192.0.2.10', port: 5432 });
        assert.deepStrictEqual(res, { ok: true, changed: true, managed: true, inside: true });
        assert.strictEqual(scripts.length, 2, 'one read, one write');

        const steps = scripts[1].split('; ');
        const at = (needle) => steps.findIndex((s) => s.includes(needle));

        const confine = at("New-NetFirewallRule -DisplayName 'Aegis Deploy data: aegis-run-01 tcp'");
        const narrow = at('-RemoteAddress 192.0.2.0-192.0.2.9,192.0.2.11-192.0.2.255');
        assert.ok(confine !== -1 && narrow !== -1);
        assert.ok(confine < narrow, 'the subnet was narrowed before the address was confined');

        assert.match(steps[confine], /-Direction Outbound -Action Block -RemoteAddress 192\.0\.2\.10 -Owner \$sid -Protocol TCP -RemotePort 1-5431,5433-65535/);
        assert.ok(at("'Aegis Deploy data: aegis-run-01 udp'") !== -1);
        assert.ok(at("'Aegis Deploy data: aegis-run-01 icmp'") !== -1);
        assert.ok(at("Get-LocalUser -Name 'aegis-run-01'") < confine);

        // The subnet the address is not in keeps its whole block.
        const narrowed = steps.filter((s) => s.includes('DenyDomain-10_0_0_0_8'));
        assert.deepStrictEqual(narrowed,
            ["Set-NetFirewallRule -DisplayName 'AegisBuild-aegis-run-01-DenyDomain-10_0_0_0_8' -RemoteAddress 10.0.0.0/8 -Enabled True"]);
        assert.ok(!scripts[1].includes('-Action Allow'), 'an allow rule would not beat the block, and is not what this does');
    });
});

test('already open for this target: one read and no write', async () => {
    const state = {
        deny: [Object.assign({}, DENY_24, { remote: ['192.0.2.0-192.0.2.9', '192.0.2.11-192.0.2.255'] }), DENY_10],
        data: { remote: ['192.0.2.10'], ports: ['1-5431', '5433-65535'] }
    };
    await withFirewall(holding(state), async (scripts) => {
        const res = await net.ensureFor(ACCOUNT, { host: '192.0.2.10', port: 5432 });
        assert.deepStrictEqual(res, { ok: true, changed: false, managed: true, inside: true });
        assert.strictEqual(scripts.length, 1);
    });
});

test('a rule left by another project is replaced, not kept beside the new one', async () => {
    const state = {
        deny: [Object.assign({}, DENY_24, { remote: ['192.0.2.0-192.0.2.19', '192.0.2.21-192.0.2.255'] })],
        data: { remote: ['192.0.2.20'], ports: ['1-5431', '5433-65535'] }
    };
    await withFirewall(holding(state), async (scripts) => {
        const res = await net.ensureFor(ACCOUNT, { host: '192.0.2.10', port: 6543 });
        assert.strictEqual(res.changed, true);
        const steps = scripts[1].split('; ');
        assert.strictEqual(steps[1], "Set-NetFirewallRule -DisplayName 'AegisBuild-aegis-run-01-DenyDomain-192_0_2_0_24' -RemoteAddress 192.0.2.0/24 -Enabled True",
            'the old opening is closed first');
        assert.ok(scripts[1].includes('-RemotePort 1-6542,6544-65535'));
        assert.ok(!scripts[1].includes('192.0.2.20'), 'the old address is named nowhere in what is written');
    });
});

test('no target puts every rule back and removes the per-address ones', async () => {
    const state = {
        deny: [Object.assign({}, DENY_24, { remote: ['192.0.2.0-192.0.2.9', '192.0.2.11-192.0.2.255'] })],
        data: { remote: ['192.0.2.10'], ports: ['1-5431', '5433-65535'] }
    };
    await withFirewall(holding(state), async (scripts) => {
        const res = await net.ensureFor(ACCOUNT, null);
        assert.deepStrictEqual(res, { ok: true, changed: true, managed: true, inside: false });
        assert.ok(scripts[1].includes('-RemoteAddress 192.0.2.0/24 -Enabled True'));
        assert.ok(scripts[1].includes("Remove-NetFirewallRule -DisplayName 'Aegis Deploy data: aegis-run-01 tcp'"));
        assert.ok(!scripts[1].includes('New-NetFirewallRule'));
    });

    // And an account that was never opened costs one read.
    await withFirewall(holding({ deny: [DENY_24], data: null }), async (scripts) => {
        const res = await net.ensureFor(ACCOUNT, null);
        assert.strictEqual(res.changed, false);
        assert.strictEqual(scripts.length, 1);
    });
});

test('a target outside every denied subnet changes nothing', async () => {
    await withFirewall(holding({ deny: [DENY_24], data: null }), async (scripts) => {
        const res = await net.ensureFor(ACCOUNT, { host: '203.0.113.5', port: 5432 });
        assert.deepStrictEqual(res, { ok: true, changed: false, managed: true, inside: false });
        assert.strictEqual(scripts.length, 1);
    });
});

test('a /32 deny rule that is the address is disabled, and enabled again on the way back', async () => {
    const deny32 = { name: 'AegisBuild-aegis-run-01-DenyDomain-192_0_2_10_32', enabled: 'True', remote: ['192.0.2.10'] };
    await withFirewall(holding({ deny: [deny32], data: null }), async (scripts) => {
        await net.ensureFor(ACCOUNT, { host: '192.0.2.10', port: 5432 });
        assert.ok(scripts[1].endsWith("Set-NetFirewallRule -DisplayName 'AegisBuild-aegis-run-01-DenyDomain-192_0_2_10_32' -Enabled False"));
    });
    const opened = {
        deny: [Object.assign({}, deny32, { enabled: 'False' })],
        data: { remote: ['192.0.2.10'], ports: ['1-5431', '5433-65535'] }
    };
    await withFirewall(holding(opened), async (scripts) => {
        assert.strictEqual((await net.ensureFor(ACCOUNT, { host: '192.0.2.10', port: 5432 })).changed, false);
        await net.ensureFor(ACCOUNT, null);
        assert.ok(scripts[2].includes('-RemoteAddress 192.0.2.10/32 -Enabled True'));
    });
});

test('a host name is resolved, and one that does not resolve opens nothing', async () => {
    await withFirewall(holding({ deny: [DENY_24], data: null }), async (scripts) => {
        const res = await net.ensureFor(ACCOUNT, { host: 'db.corp.local', port: 5432 },
            { lookup: async () => '192.0.2.10' });
        assert.strictEqual(res.changed, true);
        assert.ok(scripts[1].includes('-RemoteAddress 192.0.2.10 -Owner'));
    });
    await withFirewall(holding({ deny: [DENY_24], data: null }), async (scripts) => {
        const res = await net.ensureFor(ACCOUNT, { host: 'db.corp.local', port: 5432 },
            { lookup: async () => { throw new Error('ENOTFOUND'); } });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(scripts.length, 0);
    });
});

test('refusals: a bad account, a bad port, a failed read and a failed write never throw', async () => {
    await withFirewall(holding({ deny: [DENY_24], data: null }), async (scripts) => {
        assert.strictEqual((await net.ensureFor("x'; calc", null)).ok, false);
        assert.strictEqual((await net.ensureFor(ACCOUNT, { host: '192.0.2.10', port: 0 })).ok, false);
        assert.strictEqual(scripts.length, 0);
    });
    await withFirewall(() => ({ ok: false, error: 'Access is denied' }), async () => {
        const res = await net.ensureFor(ACCOUNT, { host: '192.0.2.10', port: 5432 });
        assert.deepStrictEqual(res, { ok: false, changed: false, managed: true, error: 'Access is denied' });
    });
    await withFirewall((script) => (script.includes('ConvertTo-Json')
        ? { ok: true, out: JSON.stringify({ deny: [DENY_24], data: null }) }
        : { ok: false, error: 'The rule could not be created' }), async () => {
        const res = await net.ensureFor(ACCOUNT, { host: '192.0.2.10', port: 5432 });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.error, 'The rule could not be created');
    });
    await withFirewall(() => ({ ok: true, out: 'not json' }), async () => {
        assert.strictEqual((await net.ensureFor(ACCOUNT, null)).ok, false);
    });
});

test('inspect says whether setup blocks the address, and writes nothing', async () => {
    await withFirewall(holding({ deny: [DENY_24], data: null }), async (scripts) => {
        assert.deepStrictEqual(await net.inspect([ACCOUNT, 'aegis-run-02'], { host: '192.0.2.10', port: 5432 }),
            { ok: true, blocked: true, managed: true, ip: '192.0.2.10' });
        assert.deepStrictEqual(await net.inspect([ACCOUNT], { host: '203.0.113.5', port: 5432 }),
            { ok: true, blocked: false, managed: true, ip: '203.0.113.5' });
        assert.ok(scripts.every((s) => !/New-|Set-|Remove-/.test(s)));
    });
});

test('an address typed with leading zeros reaches the firewall as the address that was compared', async () => {
    await withFirewall(holding({ deny: [DENY_10], data: null }), async (scripts) => {
        const res = await net.ensureFor(ACCOUNT, { host: '010.000.0.5', port: 5432 });
        assert.strictEqual(res.changed, true);
        assert.ok(scripts[1].includes('-RemoteAddress 10.0.0.5 -Owner'), scripts[1]);
        assert.ok(!scripts[1].includes('010.000'), 'the typed form reached PowerShell, which may read it differently');
    });
});
