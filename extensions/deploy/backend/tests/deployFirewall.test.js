/**
 * The host firewall opener.
 *
 * `firewall._setRunner` replaces the PowerShell call with a function that
 * records the scripts it was handed and answers what the test wants. What is
 * worth testing here is the diffing, the idempotency, reading an answer back
 * and, most of all, the refusals: driving any of it through the real firewall
 * would mean a suite that changes the host it runs on.
 *
 * Every test sets `AEGIS_DEPLOY_FIREWALL` itself and puts it back. The switch
 * is the whole safety property, so no test may inherit it from the environment
 * and none may leave it behind.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const firewall = require('../firewall');

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

/**
 * Runs `fn` with the switch on and a fake PowerShell, then puts both back.
 *
 * `answer` is called with each script and returns `{ ok, out }` or
 * `{ ok: false, error }`. The scripts are collected so a test can assert on
 * what would have been run.
 */
async function withFirewall(answer, fn) {
    const before = process.env.AEGIS_DEPLOY_FIREWALL;
    process.env.AEGIS_DEPLOY_FIREWALL = '1';
    const scripts = [];
    firewall._setRunner((script) => {
        scripts.push(script);
        return answer(script, scripts.length - 1);
    });
    try {
        return await fn(scripts);
    } finally {
        firewall._setRunner(null);
        if (before === undefined) delete process.env.AEGIS_DEPLOY_FIREWALL;
        else process.env.AEGIS_DEPLOY_FIREWALL = before;
    }
}

/** An answer that reports the given rules to a list, and succeeds at everything else. */
function withRules(rules) {
    return (script) => {
        if (script.includes('Get-NetFirewallRule')) {
            return { ok: true, out: JSON.stringify(rules) };
        }
        return { ok: true, out: '' };
    };
}

/** Silences one console channel for the duration, and hands back what it saw. */
async function muffle(channel, fn) {
    const original = console[channel];
    const lines = [];
    console[channel] = (...a) => lines.push(a.join(' '));
    try { return await fn(lines); } finally { console[channel] = original; }
}

async function withEnv(name, value, fn) {
    const before = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    try { return await fn(); } finally {
        if (before === undefined) delete process.env[name];
        else process.env[name] = before;
    }
}

/* ------------------------------------------------------------------ */
/* the switch                                                          */
/* ------------------------------------------------------------------ */

test('firewall: nothing happens without the host switch', async () => {
    // The property the whole file exists to hold. A tenant administrator
    // clicking New Project must not be able to open a port on a machine that
    // was never told to allow it.
    const before = process.env.AEGIS_DEPLOY_FIREWALL;
    delete process.env.AEGIS_DEPLOY_FIREWALL;
    const scripts = [];
    firewall._setRunner((s) => { scripts.push(s); return { ok: true, out: '[]' }; });
    try {
        assert.strictEqual(firewall.enabled(), false);
        assert.strictEqual(await firewall.ensureFor('acme', 'site', 3081), false);
        assert.strictEqual(await firewall.removeFor('acme', 'site'), false);
        assert.deepStrictEqual(scripts, [], 'not one command may reach the host');
    } finally {
        firewall._setRunner(null);
        if (before !== undefined) process.env.AEGIS_DEPLOY_FIREWALL = before;
    }
});

test('firewall: a value other than 1 is not the switch', async () => {
    for (const value of ['0', 'true', 'yes', '']) {
        await withEnv('AEGIS_DEPLOY_FIREWALL', value, async () => {
            firewall._setRunner(() => ({ ok: true, out: '[]' }));
            try {
                assert.strictEqual(firewall.enabled(), false, `"${value}" must not enable it`);
            } finally { firewall._setRunner(null); }
        });
    }
});

/* ------------------------------------------------------------------ */
/* scope and profiles                                                  */
/* ------------------------------------------------------------------ */

test('firewall: the default scope is the local subnet, never Any', async () => {
    await withEnv('AEGIS_DEPLOY_FIREWALL_SCOPE', undefined, () => {
        assert.deepStrictEqual(firewall._scope(), ['LocalSubnet']);
    });
    await withEnv('AEGIS_DEPLOY_FIREWALL_PROFILE', undefined, () => {
        assert.deepStrictEqual(firewall._profiles(), ['Domain', 'Private']);
    });
});

test('firewall: a scope the operator sets is honoured', async () => {
    await withEnv('AEGIS_DEPLOY_FIREWALL_SCOPE', '192.168.0.0/16', () => {
        assert.deepStrictEqual(firewall._scope(), ['192.168.0.0/16']);
    });
    await withEnv('AEGIS_DEPLOY_FIREWALL_SCOPE', '10.0.0.0/8, 192.168.1.10-192.168.1.20', () => {
        assert.deepStrictEqual(firewall._scope(), ['10.0.0.0/8', '192.168.1.10-192.168.1.20']);
    });
});

test('firewall: a scope Windows would not take falls back to the narrow answer', async () => {
    // Narrow, not wide. A typo must never be the reason a site becomes
    // reachable from more places than the operator meant.
    for (const bad of ['everyone', '192.168.0.0/16; Any', 'Local Subnet', "'; Remove-Item C:\\ #"]) {
        await withEnv('AEGIS_DEPLOY_FIREWALL_SCOPE', bad, async () => {
            await muffle('warn', () => {
                assert.deepStrictEqual(firewall._scope(), ['LocalSubnet'], `refused: ${bad}`);
            });
        });
    }
});

test('firewall: an unknown profile falls back, and Public is never a default', async () => {
    await withEnv('AEGIS_DEPLOY_FIREWALL_PROFILE', 'Domain,Nonsense', async () => {
        await muffle('warn', () => {
            assert.deepStrictEqual(firewall._profiles(), ['Domain', 'Private']);
        });
    });
    // Reachable, but only by saying so.
    await withEnv('AEGIS_DEPLOY_FIREWALL_PROFILE', 'public', () => {
        assert.deepStrictEqual(firewall._profiles(), ['Public']);
    });
});

/* ------------------------------------------------------------------ */
/* rule names                                                          */
/* ------------------------------------------------------------------ */

test('firewall: a rule name round-trips, and a malformed one is not ours', async () => {
    const name = firewall._ruleName('acme', 'kpi-briconord');
    assert.deepStrictEqual(firewall._parseRuleName(name), { slug: 'acme', projectId: 'kpi-briconord' });

    for (const other of ['', 'Aegis Dashboard (TCP 3000)', 'Aegis Deploy site: acme',
        'Aegis Deploy site: acme/kpi/extra', 'Aegis Deploy site: ACME/kpi',
        'Aegis Deploy site: acme/../kpi']) {
        assert.strictEqual(firewall._parseRuleName(other), null, `not ours: ${other}`);
    }
});

/* ------------------------------------------------------------------ */
/* opening                                                             */
/* ------------------------------------------------------------------ */

test('firewall: opening names the port, the profiles and the scope', async () => {
    await withEnv('AEGIS_DEPLOY_FIREWALL_SCOPE', '192.168.0.0/16', async () => {
        await withFirewall(withRules([]), async (scripts) => {
            await muffle('log', async () => {
                assert.strictEqual(await firewall.ensureFor('acme', 'kpi', 3081), true);
            });
            const add = scripts.find((s) => s.includes('New-NetFirewallRule'));
            assert.ok(add, 'a rule is added');
            assert.match(add, /-LocalPort 3081\b/);
            assert.match(add, /-Profile Domain,Private\b/);
            assert.match(add, /-RemoteAddress 192\.168\.0\.0\/16/);
            assert.match(add, /-Direction Inbound -Action Allow -Protocol TCP/);
            assert.match(add, /-Group 'Aegis Deploy'/);
            // One port. Never the range, which is what a first attempt at this
            // reached for and would have opened ninety-nine.
            assert.doesNotMatch(add, /3081-\d+/);
        });
    });
});

test('firewall: a rule that is already right is left alone', async () => {
    await withFirewall(withRules([{ name: firewall._ruleName('acme', 'kpi'), port: '3081' }]),
        async (scripts) => {
            assert.strictEqual(await firewall.ensureFor('acme', 'kpi', 3081), true);
            assert.ok(!scripts.some((s) => s.includes('New-NetFirewallRule')),
                'nothing is rewritten when the host already agrees');
        });
});

test('firewall: a project that moved port does not keep the old one open', async () => {
    // The hole nobody would think to look for: a rule left behind on a port the
    // project no longer uses, which some other project may later be given.
    await withFirewall(withRules([{ name: firewall._ruleName('acme', 'kpi'), port: '3081' }]),
        async (scripts) => {
            await muffle('log', async () => {
                assert.strictEqual(await firewall.ensureFor('acme', 'kpi', 3090), true);
            });
            assert.ok(scripts.some((s) => s.includes('Remove-NetFirewallRule')), 'the old rule goes');
            assert.ok(scripts.some((s) => /New-NetFirewallRule[\s\S]*-LocalPort 3090\b/.test(s)),
                'the new port is opened');
        });
});

test('firewall: a port outside the range, or a bad id, opens nothing', async () => {
    await withFirewall(withRules([]), async (scripts) => {
        for (const port of [0, -1, 70000, 1.5, NaN, '3081; shutdown']) {
            assert.strictEqual(await firewall.ensureFor('acme', 'kpi', port), false, `port ${port}`);
        }
        for (const id of ['../etc', 'ACME', 'a b', "x'; Remove-Item C:\\ #", '']) {
            assert.strictEqual(await firewall.ensureFor(id, 'kpi', 3081), false, `slug ${id}`);
            assert.strictEqual(await firewall.ensureFor('acme', id, 3081), false, `id ${id}`);
        }
        assert.ok(!scripts.some((s) => s.includes('New-NetFirewallRule')));
    });
});

test('firewall: a refusal is reported and never thrown', async () => {
    // A deployment must not be rolled back because a firewall call failed. A
    // site that is up and unreachable is a problem an operator can see.
    await withFirewall((script) => {
        if (script.includes('Get-NetFirewallRule')) return { ok: true, out: '[]' };
        return { ok: false, error: 'Access is denied.' };
    }, async () => {
        const lines = [];
        const original = console.warn;
        console.warn = (...a) => lines.push(a.join(' '));
        try {
            assert.strictEqual(await firewall.ensureFor('acme', 'kpi', 3081), false);
        } finally { console.warn = original; }
        assert.ok(lines.some((l) => l.includes('Access is denied')), 'the reason is named');
        assert.ok(lines.some((l) => l.includes('New-NetFirewallRule')),
            'and so is the command to run by hand');
    });
});

/* ------------------------------------------------------------------ */
/* reconciling                                                         */
/* ------------------------------------------------------------------ */

/** A tenants root with one tenant and the projects given. */
function seed(projects) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-fw-'));
    const tenant = path.join(root, 'acme', 'deploy');
    fs.mkdirSync(tenant, { recursive: true });
    fs.writeFileSync(path.join(tenant, 'projects.json'), JSON.stringify({ projects }));
    return {
        tenantsRoot: () => root,
        pathsFor: (slug) => ({ root: path.join(root, slug) }),
        cleanup: () => fs.rmSync(root, { recursive: true, force: true })
    };
}

test('firewall: reconcile closes a rule whose project is gone', async () => {
    // Nothing fires for a project deleted while the service was stopped, so a
    // per-project hook can never see this. The sweep is the only thing that can.
    const seeded = seed([{ id: 'kpi', name: 'KPI', port: 3081 }]);
    try {
        await withFirewall(withRules([
            { name: firewall._ruleName('acme', 'kpi'), port: '3081' },
            { name: firewall._ruleName('acme', 'ghost'), port: '3082' }
        ]), async (scripts) => {
            const out = await muffle('log', async () => firewall.reconcile(seeded));
            assert.strictEqual(out.ok, true);
            const removals = scripts.filter((s) => s.includes('Remove-NetFirewallRule'));
            assert.strictEqual(removals.length, 1, 'only the orphan goes');
            assert.ok(removals[0].includes('acme/ghost'));
        });
    } finally { seeded.cleanup(); }
});

test('firewall: reconcile leaves a rule it does not own alone', async () => {
    // `Aegis Dashboard (TCP 3000)` is created by start-dashboard.ps1 and is not
    // this file's to remove. Ownership is the group and the name prefix.
    const seeded = seed([]);
    try {
        await withFirewall(withRules([{ name: 'Aegis Dashboard (TCP 3000)', port: '3000' }]),
            async (scripts) => {
                await muffle('log', async () => firewall.reconcile(seeded));
                assert.ok(!scripts.some((s) => s.includes('Remove-NetFirewallRule')),
                    'a rule that is not ours is not ours to remove');
            });
    } finally { seeded.cleanup(); }
});

test('firewall: reconcile opens a project that has no rule yet', async () => {
    const seeded = seed([{ id: 'kpi', port: 3081 }, { id: 'pulse', port: 3082 }]);
    try {
        await withFirewall(withRules([]), async (scripts) => {
            await muffle('log', async () => firewall.reconcile(seeded));
            const adds = scripts.filter((s) => s.includes('New-NetFirewallRule'));
            assert.strictEqual(adds.length, 2);
            assert.ok(adds.some((s) => /-LocalPort 3081\b/.test(s)));
            assert.ok(adds.some((s) => /-LocalPort 3082\b/.test(s)));
        });
    } finally { seeded.cleanup(); }
});

test('firewall: a project with no port yet is not a rule', async () => {
    // A project exists between being created and being given a port. Opening
    // port 0, or `undefined`, is not a thing to do about that.
    const seeded = seed([{ id: 'fresh' }]);
    try {
        await withFirewall(withRules([]), async (scripts) => {
            await muffle('log', async () => firewall.reconcile(seeded));
            assert.ok(!scripts.some((s) => s.includes('New-NetFirewallRule')));
        });
    } finally { seeded.cleanup(); }
});

test('firewall: one rule comes back as an object, not a one-element array', async () => {
    // ConvertTo-Json does that, and reading it as an array silently finds no
    // rules: the sweep would then re-add every rule that already exists.
    const single = { name: firewall._ruleName('acme', 'kpi'), port: '3081' };
    await withFirewall((script) => (script.includes('Get-NetFirewallRule')
        ? { ok: true, out: JSON.stringify(single) }
        : { ok: true, out: '' }), async (scripts) => {
        assert.strictEqual(await firewall.ensureFor('acme', 'kpi', 3081), true);
        assert.ok(!scripts.some((s) => s.includes('New-NetFirewallRule')),
            'the existing rule was seen');
    });
});

test('firewall: an answer that is not JSON is a refusal, not a crash', async () => {
    const seeded = seed([{ id: 'kpi', port: 3081 }]);
    try {
        await withFirewall((script) => (script.includes('Get-NetFirewallRule')
            ? { ok: true, out: 'Le terme Get-NetFirewallRule n est pas reconnu' }
            : { ok: true, out: '' }), async () => {
            const out = await muffle('warn', async () => firewall.reconcile(seeded));
            assert.strictEqual(out.ok, false);
        });
    } finally { seeded.cleanup(); }
});
