# Deploy builder: test the real sandbox, and take broken accounts out of the pool

2026-09-29. Follows the fix for "Accès refusé" on `aegis-build-03` (the workspace
was deleted and made again on every build, losing the ACL setup gave it).

## Why

Every builder test stubs the launcher, so `run-sandboxed-build.ps1`, the
accounts and the folder ACLs never run in a test. That is how a build that fails
on every host shipped green. And when one account is broken, every build that
lands on it fails, at deploy time, with a message that blames the project.

## Scope

In:

1. **A CI test against the real sandbox.** `tests/sandboxIntegration.test.js`
   runs `Create-BuildAccounts.ps1` for one throwaway account (so the deny-logon
   rights, the workspace ACL and the stored password are the real ones), then
   `buildInSandbox` with the real launcher, twice, and checks the build ran as
   that account. A third run with a wrong stored password must fail as a
   sandbox failure, not as a build failure. Gated on `CI=true`,
   `AEGIS_SANDBOX_IT=1`, Windows and elevation; `test.yml` sets the variable.
   Never runs on a workstation: it creates a local account and firewall rules.
2. **A probe, and a pool that skips broken slots.**
   - `run-sandboxed-build.ps1` exits 3 when Windows refuses to start the
     process, 1 for everything else. The launcher marks that error
     `sandboxStart`.
   - `accountPool` gains `quarantine(account, reason)`, `restore(account)` and
     `health()`. `borrow()` never hands out a quarantined slot, and refuses at
     once with `sandbox_unavailable` when every slot is quarantined.
   - `buildInSandbox`: a `sandboxStart` failure quarantines the slot and retries
     once on another. Nothing of the project ran, so the retry is safe. The
     error that reaches the operator is `sandbox_unavailable`, not
     `build_failed`.
   - `build/sandboxProbe.js`: borrows each slot, starts `cmd /c exit 0` as it,
     quarantines or restores it. Runs at boot (fire and forget, inside the
     `isEnabled()` block of `register`) and from `POST /api/deploy/sandbox/probe`
     (admin).
   - `GET /api/deploy/status` carries `sandbox: [{ account, ok, error, at }]`.
   - The Deploy page names `sandbox_unavailable` with its own sentence. Keys in
     core's `translations.js`, English and French, with the English fallback in
     the tuple for an older core.

Out, on purpose:

- Starting the build from LocalSystem without `CreateProcessWithLogonW`, and
  attaching the process to the Job Object before it runs. Security boundary:
  separate design, approved first.
- Retrying on network errors, host preflight, per-stage timeouts, package cache.
- Showing probe results on core's Extensions card. The Deploy page and the
  status route are enough for now.

## Check

- `npm test` green locally (the integration test skips, with its reason).
- The CI run on the branch: the integration test runs, and is proven able to go
  red by pointing it at the pre-fix builder once.
- VM: install the release, deploy a project with a build twice, then break one account's
  password and confirm builds move to the other slots and the page names the
  account.
