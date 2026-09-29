'use strict';

/**
 * A fixed-size pool of borrowable slot names (the pre-provisioned build
 * account names), with FIFO queueing when the pool is exhausted.
 *
 * Deliberately fixed and pre-provisioned, not created-and-deleted per build:
 * see docs/superpowers/specs/2026-08-18-deploy-build-sandbox-design.md,
 * "Sandbox identity". A crash mid-build leaves a slot un-released, not an
 * orphaned Windows account -- the process restarting rebuilds the pool from
 * AEGIS_BUILD_ACCOUNTS and every slot starts free again.
 *
 * A slot Windows refuses to start a process as is quarantined, not handed out
 * again: one broken account used to fail every build that landed on it, and
 * blame the project for it. sandboxProbe.js is what brings it back.
 */
function createPool(slots) {
    const free = slots.slice();
    const waiters = [];
    /** account -> { reason, at }: slots Windows refused to start a process as. */
    const quarantined = new Map();
    /** account -> { ok, error, at }: the last thing known about each slot. */
    const checked = new Map();

    function unavailable() {
        const why = [...quarantined].map(([a, q]) => `${a}: ${q.reason}`).join('; ');
        return Object.assign(
            new Error(`every build account on this server is out of service (${why}). Run the Deploy host setup again.`),
            { code: 'sandbox_unavailable' });
    }

    /**
     * Any free slot, or with `want` that one slot (the probe checks each in
     * turn, and must not run in a workspace a build is using).
     */
    function borrow(want) {
        if (want) {
            const i = free.indexOf(want);
            if (i !== -1) return Promise.resolve(free.splice(i, 1)[0]);
        } else if (free.length) {
            return Promise.resolve(free.shift());
        }
        // Waiting is only worth it while some slot can still come back.
        if (quarantined.size >= slots.length) return Promise.reject(unavailable());
        return new Promise((resolve, reject) => waiters.push({ want, resolve, reject }));
    }

    /**
     * Hands the slot straight to the oldest waiter that takes it rather than the
     * free list, so a queue drains in the order it formed. A quarantined slot
     * goes to neither: it is held aside until `restore`.
     */
    function release(account) {
        if (quarantined.has(account)) return;
        const i = waiters.findIndex((w) => !w.want || w.want === account);
        if (i !== -1) waiters.splice(i, 1)[0].resolve(account);
        else free.push(account);
    }

    /**
     * Takes a borrowed slot out of service. The caller still calls `release`,
     * which then keeps it aside. When this was the last slot in service, nobody
     * waiting will ever be served, so they are refused now rather than hung.
     */
    function quarantine(account, reason) {
        const i = free.indexOf(account);
        if (i !== -1) free.splice(i, 1);
        quarantined.set(account, { reason, at: Date.now() });
        checked.set(account, { ok: false, error: reason, at: Date.now() });
        if (quarantined.size >= slots.length) {
            const err = unavailable();
            waiters.splice(0).forEach((w) => w.reject(err));
        }
    }

    /** Puts a slot back in service, once a check proves it starts. */
    function restore(account) {
        checked.set(account, { ok: true, error: null, at: Date.now() });
        if (!quarantined.delete(account)) return;
        release(account);
    }

    /** One row per slot, for the status route. `at` null means never checked. */
    function health() {
        return slots.map((account) => {
            const c = checked.get(account);
            return { account, ok: c ? c.ok : null, error: c ? c.error : null, at: c ? c.at : null };
        });
    }

    function freeCount() { return free.length; }
    function waitingCount() { return waiters.length; }

    return { borrow, release, quarantine, restore, health, freeCount, waitingCount, size: slots.length, slots: slots.slice() };
}

/** The process-wide pool, sized from AEGIS_BUILD_ACCOUNTS (comma-separated account names, set up by Create-BuildAccounts.ps1). */
const DEFAULT_SLOTS = (process.env.AEGIS_BUILD_ACCOUNTS || 'aegis-build-01,aegis-build-02,aegis-build-03')
    .split(',').map((s) => s.trim()).filter(Boolean);

const defaultPool = createPool(DEFAULT_SLOTS);

module.exports = { createPool, defaultPool };
