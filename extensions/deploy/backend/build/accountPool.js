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
 */
function createPool(slots) {
    const free = slots.slice();
    const waiters = [];

    function borrow() {
        if (free.length) return Promise.resolve(free.shift());
        return new Promise((resolve) => waiters.push(resolve));
    }

    /** Hands the slot straight to the oldest waiter rather than the free list, so a queue drains in the order it formed. */
    function release(account) {
        if (waiters.length) {
            const next = waiters.shift();
            next(account);
        } else {
            free.push(account);
        }
    }

    function freeCount() { return free.length; }
    function waitingCount() { return waiters.length; }

    return { borrow, release, freeCount, waitingCount, size: slots.length };
}

/** The process-wide pool, sized from AEGIS_BUILD_ACCOUNTS (comma-separated account names, set up by Create-BuildAccounts.ps1). */
const DEFAULT_SLOTS = (process.env.AEGIS_BUILD_ACCOUNTS || 'aegis-build-01,aegis-build-02,aegis-build-03')
    .split(',').map((s) => s.trim()).filter(Boolean);

const defaultPool = createPool(DEFAULT_SLOTS);

module.exports = { createPool, defaultPool };
