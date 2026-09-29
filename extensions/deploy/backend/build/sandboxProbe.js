'use strict';

const path = require('path');

/** Long enough for a cold logon on a loaded host, short enough to hold no slot for long. */
const PROBE_TIMEOUT_MS = 30000;

/**
 * Starts `cmd /c exit 0` as every build account, and puts each slot in or out
 * of service on the answer.
 *
 * The point is to learn that an account is broken before a deployment does. A
 * wrong stored password, a disabled account or a folder Windows will not open
 * used to surface as a failed build, at the moment someone was waiting on it,
 * in words that blamed the project.
 *
 * Each slot is borrowed like a build borrows it, so a probe never runs in a
 * workspace a build is using, and waits its turn behind one that is. The
 * workspace is not emptied: the next build does that.
 *
 * `runLauncher` and `scopeWorkspace` are the builder's own, injected the same
 * way, so tests run this with no Windows account.
 */
async function probeAll({ pool, workspaceRoot, runLauncher, scopeWorkspace, fs = require('fs') }) {
    const results = [];
    for (const account of pool.slots) {
        results.push(await probeOne({ pool, workspaceRoot, runLauncher, scopeWorkspace, fs, account }));
    }
    return results;
}

async function probeOne({ pool, workspaceRoot, runLauncher, scopeWorkspace, fs, account }) {
    // A quarantined slot is not in the free list, so it cannot be borrowed:
    // it is probed where it stands, and only `restore` brings it back.
    const held = pool.health().find((h) => h.account === account);
    const inService = !(held && held.ok === false);
    if (inService) await pool.borrow(account);
    try {
        const workspace = path.join(workspaceRoot, account);
        fs.mkdirSync(workspace, { recursive: true });
        if (scopeWorkspace) scopeWorkspace(workspace, account);
        await runLauncher({ workspace, account, installCmd: '', buildCmd: 'exit 0', timeoutMs: PROBE_TIMEOUT_MS });
        pool.restore(account);
        return { account, ok: true };
    } catch (e) {
        const reason = String(e.output || e.message || 'unknown error').split(/\r?\n/).find((l) => l.trim()) || 'unknown error';
        // Only a slot fault takes the account out. A probe that timed out on a
        // busy host says nothing about the account.
        if (e.sandboxStart || e.code === 'build_account_unconfigured') pool.quarantine(account, reason);
        return { account, ok: false, error: reason };
    } finally {
        if (inService) pool.release(account);
    }
}

module.exports = { probeAll, PROBE_TIMEOUT_MS };
