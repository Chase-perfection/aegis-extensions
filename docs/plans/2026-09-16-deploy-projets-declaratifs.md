# Declarative Deploy projects, and projects you can correct

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A branch declares how it is deployed, that declaration keeps working after the project exists, and a project configured wrongly is corrected instead of deleted.

**Architecture:** Three layers already decide a project's configuration at creation: what the operator typed, then `aegis.deploy.json`, then what the root of the branch implies. This plan makes the manifest live (re-read from the clone on every deployment), lets it carry the authentication method, and adds the one route that removes "delete and recreate" from the product: settings a project can change after it exists, including the one that flips it between a static site and a process.

**Tech Stack:** Node 20 CommonJS, `node --test`, no transpilation. Extension code under `extensions/deploy/`, loaded by core through `extensionLoader`. Frontend is vanilla JS with no bundler; user-visible strings live in core's `frontend/src/js/translations.js`.

---

## Background an engineer needs before Task 1

Read these first, in order. They are short.

- `extensions/deploy/DEPLOY-CONTRACT.md`, sections **What `aegis.deploy.json` can say**, **What Aegis works out on its own**, and **Every refusal, and its fix**. The contract is the specification; this plan does not get to contradict it, it extends it.
- `extensions/deploy/backend/deployManifest.js`. Pure parse and merge, no I/O. The rule it enforces is that a file which will not parse refuses rather than being ignored, and that the form wins over the branch.
- `extensions/deploy/backend/cloner.js:290-370`. The clone lands in `staging`, `head` is resolved at line 290, the served directory is chosen at 294, the build runs, and two other repository manifests are read at 356 (`siteConfig`) and 369 (`accessPolicy`). The new read belongs with those two, not in the create route.

Three facts that decide the design, and that are easy to get wrong:

1. **The manifest is currently read only in the create route**, through the GitHub API, because the runtime and the port are decided before any clone exists. Every later deployment ignores the file. That is the bug Task 1 fixes.
2. **`project.runtime === 'node'` is what makes a project a process.** It is set at creation from the presence of a start command and never changes. `runtime.restart()` refuses with `runtime_disabled` when the host allows no processes, and that refusal is the host's, not the tenant's.
3. **A preview inherits its parent's configuration** (`routes.js` builds a preview record from the parent). Anything this plan writes onto a project record has to leave previews coherent, which Task 4 tests directly.

### Running the suites

```bash
cd extensions/deploy
node --test backend/tests/*.test.js
AEGIS_TREE=<path to the Aegis checkout> node --test frontend/tests/*.test.js
```

The frontend tier skips itself with a message when `AEGIS_TREE` is unset: it renders `deploy.html` inside core's shell and needs core's frontend on disk. A skipped file is not a passing file.

---

## File structure

| File | Responsibility | This plan |
|---|---|---|
| `backend/deployManifest.js` | Parse and merge the manifest. Pure. | Modify: add the `auth` key |
| `backend/manifestLive.js` | Read the manifest from a clone and say what it changes on a record | Create |
| `backend/cloner.js` | Clone, build, acceptance test | Modify: call the reader after the clone |
| `backend/deployService.js` | One deployment, whatever triggered it | Modify: persist what the manifest changed |
| `backend/projectSettings.js` | Validate `dbFile` and `migrationsDir` | Modify: reuse for the settings route |
| `backend/routes.js` | HTTP surface | Modify: the settings route, the manifest `auth` at creation |
| `frontend/src/js/deploy.js` | The whole page | Modify: the settings form, the readiness row |

`manifestLive.js` is a new file rather than more lines in `cloner.js` because it is the piece with a decision in it (which keys may change under a running project) and that decision needs its own tests without a clone.

---

## Task 1: Read the manifest from the clone, on every deployment

**Files:**
- Create: `extensions/deploy/backend/manifestLive.js`
- Test: `extensions/deploy/backend/tests/deployManifestLive.test.js`

The keys split in two. `installCmd`, `buildCmd`, `outputDir` and `rootDir` describe how this deployment is built and served, and a new value takes effect on the next deployment with nothing else to do. `startCmd`, `dbFile` and `migrationsDir` describe a running project: changing them moves a database or flips the runtime, and Task 5 is where that becomes possible. Here they are reported and not applied.

- [ ] **Step 1: Write the failing test**

Create `extensions/deploy/backend/tests/deployManifestLive.test.js`:

```javascript
/**
 * What a manifest in the clone may change under a project that already exists.
 *
 * Split deliberately. The build keys take effect on the next deployment and
 * nothing else moves. The runtime keys move a database or turn a static site
 * into a process, so they are reported here and applied only through the
 * settings route, where an operator is looking at the consequence.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const live = require('../manifestLive');

const PROJECT = {
    id: 'site-a',
    runtime: 'static',
    installCmd: 'npm ci',
    buildCmd: null,
    outputDir: null,
    rootDir: null,
    startCmd: null,
    dbFile: null,
    migrationsDir: null
};

test('a build key the branch changed is applied', () => {
    const r = live.apply(PROJECT, { buildCmd: 'npm run build' });
    assert.strictEqual(r.changed.buildCmd, 'npm run build');
    assert.deepStrictEqual(r.applied, ['buildCmd']);
    assert.deepStrictEqual(r.reported, []);
});

test('a build key that matches the record changes nothing', () => {
    const r = live.apply(PROJECT, { installCmd: 'npm ci' });
    assert.deepStrictEqual(r.applied, []);
    assert.deepStrictEqual(r.changed, {});
});

test('a runtime key is reported, never applied behind a running project', () => {
    const r = live.apply(PROJECT, { startCmd: 'node server.js' });
    assert.deepStrictEqual(r.applied, []);
    assert.deepStrictEqual(r.reported, ['startCmd']);
    assert.deepStrictEqual(r.changed, {},
        'a static project was turned into a process by a file in a branch');
});

test('a manifest that declares nothing changes nothing', () => {
    const r = live.apply(PROJECT, {});
    assert.deepStrictEqual(r.applied, []);
    assert.deepStrictEqual(r.reported, []);
});

test('the sentence for the console names the keys and where they came from', () => {
    const r = live.apply(PROJECT, { buildCmd: 'npm run build', startCmd: 'node s.js' });
    assert.match(r.say, /buildCmd/);
    assert.match(r.say, /startCmd/);
    assert.match(r.say, /Settings/, 'the operator is not told where to act on the rest');
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd extensions/deploy && node --test backend/tests/deployManifestLive.test.js
```

Expected: FAIL, `Cannot find module '../manifestLive'`.

- [ ] **Step 3: Write the implementation**

Create `extensions/deploy/backend/manifestLive.js`:

```javascript
'use strict';

/**
 * What a manifest found in a clone may change under a project that exists.
 *
 * The create route reads `aegis.deploy.json` through the GitHub API, because
 * the runtime and the port are settled before any clone exists. Every later
 * deployment used to ignore the file, so correcting a branch corrected nothing
 * and the operator was left deleting the project. This is the other half.
 *
 * Two sets of keys, and the split is the whole point. BUILD keys describe how
 * the next deployment is built and served, so a new value costs nothing to
 * honour. RUNTIME keys describe a project that is running: `startCmd` decides
 * whether there is a process at all, and `dbFile` names the database its data
 * lives in. A file in a branch must not move either under an operator who is
 * not looking, so they are reported and the console says where to act.
 */

const BUILD_KEYS = ['installCmd', 'buildCmd', 'outputDir', 'rootDir'];
const RUNTIME_KEYS = ['startCmd', 'dbFile', 'migrationsDir'];

/** `null` and `''` are the same absence on a project record. */
function same(a, b) {
    return String(a || '') === String(b || '');
}

/**
 * Returns `{ changed, applied, reported, say }`.
 *
 * `changed` is the patch to write onto the record, and is empty when the branch
 * agrees with it. `say` is one line for the build console, or null when there
 * is nothing to say: a deployment that prints a sentence about configuration
 * every twenty seconds trains the operator to stop reading it.
 */
function apply(project, config) {
    const changed = {};
    const applied = [];
    const reported = [];

    for (const key of BUILD_KEYS) {
        if (!config[key] || same(project[key], config[key])) continue;
        changed[key] = config[key];
        applied.push(key);
    }
    for (const key of RUNTIME_KEYS) {
        if (!config[key] || same(project[key], config[key])) continue;
        reported.push(key);
    }

    let say = null;
    if (applied.length || reported.length) {
        const parts = [];
        if (applied.length) parts.push(`took ${applied.join(', ')} from the branch`);
        if (reported.length) {
            parts.push(`${reported.join(', ')} differ from this project and were not `
                + 'changed here: set them on the project Settings tab');
        }
        say = `aegis.deploy.json: ${parts.join('. ')}.`;
    }

    return { changed, applied, reported, say };
}

module.exports = { apply, BUILD_KEYS, RUNTIME_KEYS };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd extensions/deploy && node --test backend/tests/deployManifestLive.test.js
```

Expected: `pass 5`, `fail 0`.

- [ ] **Step 5: Prove the tests can fail**

Change `if (!config[key] || same(project[key], config[key])) continue;` in the RUNTIME loop to push into `changed` as well, rerun, and confirm the third test fails with "a static project was turned into a process by a file in a branch". Put the line back.

- [ ] **Step 6: Commit**

```bash
git add extensions/deploy/backend/manifestLive.js extensions/deploy/backend/tests/deployManifestLive.test.js
git commit -m "feat(deploy): decide what a manifest may change under a live project"
```

---

## Task 2: Call it from the clone, and persist what it changed

**Files:**
- Modify: `extensions/deploy/backend/cloner.js` (after line 290, where `head` is resolved)
- Modify: `extensions/deploy/backend/deployService.js` (the `cloneToCurrent` call site)
- Test: `extensions/deploy/backend/tests/deployManifestLive.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `extensions/deploy/backend/tests/deployManifestLive.test.js`:

```javascript
const fs = require('fs');
const os = require('os');
const path = require('path');

test('read() takes the manifest out of a clone, and refuses a broken one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-live-'));
    assert.deepStrictEqual(live.read(dir), { ok: true, config: {}, error: null },
        'a branch with no manifest is not a fault');

    fs.writeFileSync(path.join(dir, 'aegis.deploy.json'),
        JSON.stringify({ buildCmd: 'npm run build' }));
    assert.deepStrictEqual(live.read(dir).config, { buildCmd: 'npm run build' });

    fs.writeFileSync(path.join(dir, 'aegis.deploy.json'), '{ broken');
    const bad = live.read(dir);
    assert.strictEqual(bad.ok, false);
    assert.ok(bad.error, 'a refusal with no reason');
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd extensions/deploy && node --test backend/tests/deployManifestLive.test.js
```

Expected: FAIL, `live.read is not a function`.

- [ ] **Step 3: Add `read` to `manifestLive.js`**

Add at the top of `extensions/deploy/backend/manifestLive.js`:

```javascript
const fs = require('fs');
const path = require('path');
const deployManifest = require('./deployManifest');
```

and before `module.exports`:

```javascript
/**
 * The manifest as the clone holds it. Reading from the clone and not from the
 * API the create route uses: the files are already on disk, and a read that
 * cannot disagree with what is about to be built is worth more than one that
 * costs nothing.
 */
function read(dir) {
    let text = null;
    try {
        text = fs.readFileSync(path.join(dir, deployManifest.FILE), 'utf8');
    } catch {
        return { ok: true, config: {}, error: null };
    }
    const parsed = deployManifest.parse(text);
    return { ok: parsed.ok, config: parsed.config, error: parsed.error };
}
```

and add `read` to the exports:

```javascript
module.exports = { apply, read, BUILD_KEYS, RUNTIME_KEYS };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd extensions/deploy && node --test backend/tests/deployManifestLive.test.js
```

Expected: `pass 6`, `fail 0`.

- [ ] **Step 5: Call it from the cloner**

In `extensions/deploy/backend/cloner.js`, immediately after the line that resolves `head` (line 290, `const head = (await run(gitExe(), ...`), insert:

```javascript
        // Read here, before the served directory is chosen and before the
        // build: the keys it can change are the ones those two steps consume.
        // `siteConfig` and `accessPolicy` are read further down for the same
        // reason in reverse, they describe serving and not building.
        const declared = manifestLive.read(staging);
        if (!declared.ok) {
            throw Object.assign(
                new Error(`${deployManifest.FILE}: ${declared.error}`),
                { code: 'bad_deploy_manifest' });
        }
        const live = manifestLive.apply(
            { installCmd, buildCmd, outputDir, rootDir, startCmd: null, dbFile: null, migrationsDir: null },
            declared.config);
        if (live.say) say.log(`${live.say}\n`);
        if (live.changed.installCmd) installCmd = live.changed.installCmd;
        if (live.changed.buildCmd) buildCmd = live.changed.buildCmd;
        if (live.changed.outputDir) outputDir = live.changed.outputDir;
        if (live.changed.rootDir) rootDir = live.changed.rootDir;
```

The four parameters are destructured `const` today. Change the signature's destructuring so those four are reassignable by declaring them with `let` at the top of the function body instead:

```javascript
    let { installCmd, buildCmd, outputDir, rootDir } = args;
```

and take the rest from `args` as before. Add the two requires at the top of the file:

```javascript
const manifestLive = require('./manifestLive');
const deployManifest = require('./deployManifest');
```

- [ ] **Step 6: Return the patch so the record can be updated**

At the end of `cloneToCurrent`, add `manifestChanged: live.changed` to the object it resolves with, beside `sha`.

In `extensions/deploy/backend/deployService.js`, at the `cloneToCurrent` call, take it and persist it:

```javascript
        const { sha, manifestChanged } = await cloner.cloneToCurrent({ /* unchanged */ });
        if (manifestChanged && Object.keys(manifestChanged).length) {
            // Written after the clone succeeded, never before: a manifest that
            // broke the build must not leave the record describing a project
            // nobody can deploy.
            Object.assign(project, manifestChanged);
            projectStore.saveProject(tenantPaths, project);
        }
```

- [ ] **Step 7: Add `bad_deploy_manifest` to the named reasons**

In `extensions/deploy/backend/deployService.js`, add `'bad_deploy_manifest'` to the `NAMED` array. Without it, a broken manifest reaching the clone is filed as `deploy_failed`, whose sentence tells the operator to check the branch exists.

- [ ] **Step 8: Run the whole backend suite**

```bash
cd extensions/deploy && node --test backend/tests/*.test.js
```

Expected: `fail 0`. `deployBuilder.test.js` and `deploySites.test.js` drive `cloneToCurrent` and will catch a signature mistake.

- [ ] **Step 9: Commit**

```bash
git add extensions/deploy/backend/manifestLive.js extensions/deploy/backend/cloner.js extensions/deploy/backend/deployService.js extensions/deploy/backend/tests/deployManifestLive.test.js
git commit -m "feat(deploy): the manifest is read on every deployment, not only at creation"
```

---

## Task 3: The branch can declare its authentication method

**Files:**
- Modify: `extensions/deploy/backend/deployManifest.js`
- Modify: `extensions/deploy/backend/routes.js` (the create route, at the manifest merge)
- Test: `extensions/deploy/backend/tests/deployManifest.test.js` (append)

`authMethods.js` exports `NONE`, `LDAP`, `METHODS` and `isKnown`. The manifest may name the method and nothing else: who is allowed in stays in the Authentication tab, because a repository declaring which colleagues may read the site it produces is a decision made in the wrong place.

- [ ] **Step 1: Write the failing test**

Append to `extensions/deploy/backend/tests/deployManifest.test.js`:

```javascript
const authMethods = require('../authMethods');

test('a branch may declare the authentication method, and only the method', () => {
    const r = manifest.parse(JSON.stringify({ auth: authMethods.LDAP }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.config.auth, authMethods.LDAP);
});

test('a method nobody implements refuses rather than opening the site', () => {
    const r = manifest.parse(JSON.stringify({ auth: 'saml' }));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /auth/);
});

test('a branch cannot name who is allowed in', () => {
    const r = manifest.parse(JSON.stringify({ auth: 'ldap', allowedGroups: ['Domain Admins'] }));
    assert.strictEqual(r.ok, true);
    assert.ok(r.unsupported.includes('allowedGroups'),
        'a repository named the people who may read its site, and nobody was told');
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd extensions/deploy && node --test backend/tests/deployManifest.test.js
```

Expected: FAIL, `r.config.auth` is `undefined`.

- [ ] **Step 3: Implement**

In `extensions/deploy/backend/deployManifest.js`, add at the top:

```javascript
const authMethods = require('./authMethods');
```

Add `'auth'` to a new list and include it in `KNOWN`:

```javascript
const ENUM_KEYS = ['auth'];
const KNOWN = COMMAND_KEYS.concat(PATH_KEYS).concat(ENUM_KEYS);
```

In the `parse` loop, before the path check, add:

```javascript
        if (ENUM_KEYS.includes(key) && !authMethods.isKnown(value)) {
            return {
                ok: false, present: true, config: {}, unsupported: [],
                error: `auth must be one of ${authMethods.METHODS.join(', ')}`
            };
        }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd extensions/deploy && node --test backend/tests/deployManifest.test.js
```

Expected: `fail 0`.

- [ ] **Step 5: Apply it at creation**

In `extensions/deploy/backend/routes.js`, in the create route, after the record is built and before the project is saved, set the auth record when the manifest declared one and the operator did not:

```javascript
        if (body.auth && !record.auth) {
            record.auth = authMethods.record(body.auth, [], {});
        }
```

`authMethods` is already required at the top of `routes.js` (line 50).

- [ ] **Step 6: Run the whole backend suite and commit**

```bash
cd extensions/deploy && node --test backend/tests/*.test.js
git add extensions/deploy/backend/deployManifest.js extensions/deploy/backend/routes.js extensions/deploy/backend/tests/deployManifest.test.js
git commit -m "feat(deploy): a branch may declare its authentication method"
```

---

## Task 4: Settings a project can change after it exists

**Files:**
- Modify: `extensions/deploy/backend/routes.js` (new route beside `POST /api/deploy/projects/:id/branch`, line 1471)
- Test: `extensions/deploy/backend/tests/deployProjectPatch.test.js` (create)

This is the task that removes "delete and recreate" from the product. It is last of the backend tasks because Tasks 1 to 3 give the manifest somewhere to land.

- [ ] **Step 1: Write the failing test**

Create `extensions/deploy/backend/tests/deployProjectPatch.test.js`, following the harness in `backend/tests/deployGithubDisconnect.test.js` (same `collect()` / `call()` helpers, copy them):

```javascript
test('the route is mounted', () => {
    assert.ok(table.get('PATCH /api/deploy/projects/:id/settings'));
});

test('a start command added to a static project is refused when the host runs none', async () => {
    plant('site-a', { runtime: 'static', startCmd: null });
    const answer = await call('PATCH /api/deploy/projects/:id/settings',
        Object.assign(request({ startCmd: 'node server.js' }), { params: { id: 'site-a' } }));
    assert.strictEqual(answer.status, 403);
    assert.strictEqual(answer.body.error, 'runtime_disabled');
});

test('clearing the start command turns a process back into a static site', async () => {
    plant('site-b', { runtime: 'node', startCmd: 'node server.js' });
    const answer = await call('PATCH /api/deploy/projects/:id/settings',
        Object.assign(request({ startCmd: '' }), { params: { id: 'site-b' } }));
    assert.strictEqual(answer.status, 200);
    const after = projectStore.getProject(pathsFor('acme'), 'site-b');
    assert.strictEqual(after.runtime, 'static');
    assert.strictEqual(after.startCmd, null);
});

test('a dbFile that climbs out of the data folder is refused here too', async () => {
    plant('site-c', { runtime: 'node', startCmd: 'node s.js' });
    const answer = await call('PATCH /api/deploy/projects/:id/settings',
        Object.assign(request({ dbFile: '..\\..\\aegis.db' }), { params: { id: 'site-c' } }));
    assert.strictEqual(answer.status, 400);
    assert.strictEqual(answer.body.error, 'bad_db_file');
});

test("a preview's settings are its parent's, and are refused here", async () => {
    plant('site-d-preview', { runtime: 'static', parentId: 'site-d' });
    const answer = await call('PATCH /api/deploy/projects/:id/settings',
        Object.assign(request({ buildCmd: 'npm run build' }), { params: { id: 'site-d-preview' } }));
    assert.strictEqual(answer.status, 400);
    assert.strictEqual(answer.body.error, 'preview_settings_fixed');
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd extensions/deploy && node --test backend/tests/deployProjectPatch.test.js
```

Expected: FAIL on the first test, the route is not mounted.

- [ ] **Step 3: Implement the route**

In `extensions/deploy/backend/routes.js`, beside the branch route:

```javascript
    /**
     * The settings a project can change without being recreated.
     *
     * `startCmd` was written at creation and never again, so a project created
     * without one was a static site for ever and the only repair was deleting
     * it. That is the instruction an operator was given for a typo.
     *
     * Clearing it is allowed and stops the process on the next deployment;
     * setting it needs the host to allow processes, which is the same refusal
     * creation gives and for the same reason. Nothing here restarts anything:
     * the next deployment reads the record, which keeps one path into the
     * runtime instead of two.
     */
    router.patch('/api/deploy/projects/:id/settings', requireOptIn, requireRole('admin'), (req, res) => {
        if (!projectStore.PROJECT_ID_RE.test(req.params.id || '')) {
            return res.status(404).json({ success: false, error: 'unknown_project' });
        }
        const project = projectStore.getProject(req.tenantPaths, req.params.id);
        if (!project) return res.status(404).json({ success: false, error: 'unknown_project' });
        if (project.parentId) {
            return res.status(400).json({ success: false, error: 'preview_settings_fixed' });
        }

        const body = req.body || {};
        const patch = {};

        for (const key of ['installCmd', 'buildCmd', 'startCmd']) {
            if (!(key in body)) continue;
            patch[key] = String(body[key] || '').trim().slice(0, 500) || null;
        }
        for (const key of ['outputDir', 'rootDir']) {
            if (!(key in body)) continue;
            patch[key] = String(body[key] || '').trim().slice(0, 200) || null;
        }
        if ('dbFile' in body) {
            try {
                patch.dbFile = projectSettings.resolveDbFile(body.dbFile);
            } catch (e) {
                return res.status(400).json({ success: false, error: 'bad_db_file' });
            }
        }
        if ('migrationsDir' in body) {
            try {
                patch.migrationsDir = projectSettings.resolveMigrationsDir(body.migrationsDir);
            } catch (e) {
                return res.status(400).json({ success: false, error: 'bad_migrations_dir' });
            }
        }

        if ('startCmd' in patch) {
            const wantsProcess = !!patch.startCmd;
            if (wantsProcess && !runtime.isEnabled()) {
                return res.status(403).json({ success: false, error: 'runtime_disabled' });
            }
            patch.runtime = wantsProcess ? 'node' : 'static';
        }

        Object.assign(project, patch);
        projectStore.saveProject(req.tenantPaths, project);
        console.log(`[Deploy] ${req.tenant.slug}: ${project.id} settings changed by ${req.user.email}`);
        res.json({ success: true, changed: Object.keys(patch) });
    });
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd extensions/deploy && node --test backend/tests/deployProjectPatch.test.js
```

Expected: `fail 0`.

- [ ] **Step 5: Stop the process when a project stops being one**

`deployService.deployNow` starts a process when `project.runtime === 'node'`. It does not stop one when the record says `static` and a process is running. Add, in the branch that today reads `if (project.runtime === 'node')` at line 309:

```javascript
        } else {
            // The record says static and something may still be running from
            // when it did not. Stopping here and not in the route keeps one
            // path into the runtime.
            runtime.stop(slug, project.id);
        }
```

`runtime.stop(slug, projectId)` is synchronous and exported from `backend/runtime.js:243`. It returns `false` when nothing was running, which is the ordinary case and not an error: every static deployment reaches this line.

- [ ] **Step 6: Run the whole backend suite and commit**

```bash
cd extensions/deploy && node --test backend/tests/*.test.js
git add extensions/deploy/backend/routes.js extensions/deploy/backend/deployService.js extensions/deploy/backend/tests/deployProjectPatch.test.js
git commit -m "feat(deploy): a project's settings can be corrected without deleting it"
```

---

## Task 5: The Settings tab carries the form

**Files:**
- Modify: `extensions/deploy/frontend/src/js/deploy.js` (the settings panel, beside the branch form at line 2563)
- Modify: `frontend/src/js/translations.js` in the Aegis checkout (both language blocks)
- Test: `extensions/deploy/frontend/tests/deploy-page.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `extensions/deploy/frontend/tests/deploy-page.test.js`:

```javascript
test('the settings tab offers the start command, prefilled, and says what it costs', async () => {
    const { page, close } = await openPage(browser, detailUrl('project/site-a/settings'),
        Object.assign(stubs([PROJECT]), { '/auth/me': ME_ADMIN }));
    try {
        const seen = await page.evaluate(() => {
            const input = document.querySelector('#deploy-settings-startcmd');
            return {
                present: !!input,
                value: input && input.value,
                note: (document.querySelector('#deploy-settings-note') || {}).textContent
            };
        });
        assert.strictEqual(seen.present, true, 'the field that used to need a delete is still missing');
        assert.strictEqual(seen.value, PROJECT.startCmd || '');
    } finally {
        await close();
    }
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd extensions/deploy
AEGIS_TREE=<path to the Aegis checkout> node --test frontend/tests/deploy-page.test.js
```

Expected: FAIL, `the field that used to need a delete is still missing`.

- [ ] **Step 3: Add the form**

In `extensions/deploy/frontend/src/js/deploy.js`, in the settings panel beside the branch form, render one input per key with ids `deploy-settings-startcmd`, `deploy-settings-install`, `deploy-settings-build`, `deploy-settings-output`, `deploy-settings-root`, `deploy-settings-dbfile`, `deploy-settings-migrations`, a Save button and `#deploy-settings-note`. Save sends only the keys whose value changed:

```javascript
        window.api('/api/deploy/projects/' + encodeURIComponent(project.id) + '/settings', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch)
        })
            .then(function (r) { return readJson(r, 'settings'); })
            .then(function (d) {
                if (!(d && d.success)) throw new Error('refused');
                note.hidden = false;
                note.textContent = tr('deploy_settings_saved',
                    'Saved. The next deployment uses them.');
            })
            .catch(function (e) {
                note.hidden = false;
                note.textContent = tr('deploy_settings_failed', 'Aegis could not save those settings.');
                console.error('[Deploy] settings failed:', e);
            });
```

- [ ] **Step 4: Add the strings to core, both languages**

In the Aegis checkout, `frontend/src/js/translations.js`, add `deploy_settings_saved`, `deploy_settings_failed`, `deploy_settings_title`, `deploy_settings_body` and one label per field, to the English block and the French block. The parity test fails when a key is in one and not the other:

```bash
cd <Aegis checkout>/backend && node --test ../frontend/tests/translations.test.js
```

- [ ] **Step 5: Run both suites and commit**

```bash
cd extensions/deploy
AEGIS_TREE=<path to the Aegis checkout> node --test frontend/tests/*.test.js
git add extensions/deploy/frontend/src/js/deploy.js extensions/deploy/frontend/tests/deploy-page.test.js
git commit -m "feat(deploy): the Settings tab corrects a project instead of deleting it"
```

Commit the Aegis side separately, in that checkout.

---

## Task 6: A registered App with no installation stops reading as connected

**Files:**
- Modify: `extensions/deploy/frontend/src/js/deploy.js` (`renderReadiness`, line 327, and `renderInstallations`, which already knows the count)
- Test: `extensions/deploy/frontend/tests/deploy-actions.test.js` (append)

`machineStore.publicStatus` cannot answer this: it is synchronous and reads the local store, and the count of installations is a GitHub call. The page already makes that call, so the row is corrected when the answer arrives rather than being guessed at render.

- [ ] **Step 1: Write the failing test**

```javascript
test('an App installed nowhere is not reported as a connection that works', async () => {
    const { page, close } = await openPage(browser, `${server.url}/pages/deploy.html#github`, baseStubs([]));
    try {
        await page.waitForFunction(() => {
            const row = document.querySelector('#deploy-readiness .dep-row.dep-todo');
            return !!row && /install/i.test(row.textContent);
        }, { timeout: 5000 });
    } finally {
        await close();
    }
});
```

`baseStubs` leaves `/api/deploy/github/installations` on the harness default, which carries no `installations` array, so the page sees none.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd extensions/deploy
AEGIS_TREE=<path to the Aegis checkout> node --test frontend/tests/deploy-actions.test.js
```

Expected: FAIL on the 5000 ms timeout, because the row is `dep-ok` today.

- [ ] **Step 3: Tag the row when it is drawn**

`renderReadiness` builds the row with `row('ok', ...)` and keeps no handle on it. Give it one. In `extensions/deploy/frontend/src/js/deploy.js`, in `renderReadiness`, replace the `s.github && s.github.connected` branch's append with:

```javascript
        if (s.github && s.github.connected) {
            var ghRow = row(
                'ok',
                tr('deploy_gh_label', 'GitHub App registered'),
                s.github.slug || ('app ' + s.github.appId),
                ''
            );
            ghRow.id = 'deploy-readiness-github';
            readinessEl.appendChild(ghRow);
        } else {
```

- [ ] **Step 4: Correct it when the count arrives**

Add beside `renderNoInstallNotice`:

```javascript
    /**
     * A registered App is not a working connection until something installed it.
     *
     * `publicStatus` cannot answer this: it is synchronous and reads the local
     * store, while the count of installations is a call to GitHub. The page
     * already makes that call, so the row is corrected when the answer arrives
     * rather than guessed at render, and stays green in the case that is fine.
     */
    function markGithubRow(none) {
        var rowEl = document.getElementById('deploy-readiness-github');
        if (!rowEl || !none) return;
        rowEl.className = 'dep-row dep-todo';
        var detail = rowEl.querySelector('.dep-row-detail');
        if (detail) {
            detail.textContent = tr('deploy_gh_no_install',
                'Registered, but installed on no account, so Aegis can list no repository.');
        }
    }
```

and call it from `renderInstallations`, immediately after `renderNoInstallNotice(none)`:

```javascript
        markGithubRow(none);
```

Add `deploy_gh_no_install` to both language blocks of core's `frontend/src/js/translations.js`.

- [ ] **Step 5: Run it to verify it passes**

```bash
cd extensions/deploy
AEGIS_TREE=<path to the Aegis checkout> node --test frontend/tests/deploy-actions.test.js
```

Expected: `fail 0`.

- [ ] **Step 3: Commit**

```bash
git add extensions/deploy/frontend/src/js/deploy.js extensions/deploy/frontend/tests/deploy-actions.test.js
git commit -m "fix(deploy): an App installed nowhere no longer reads as connected"
```

---

## Task 7: Documentation, then the release

**Files:**
- Modify: `extensions/deploy/DEPLOY-CONTRACT.md`
- Modify: `extensions/deploy/ADDING-A-SITE.md`
- Modify: `extensions/deploy/CHANGELOG.md`
- Modify: `extensions/deploy/extension.json`

- [ ] **Step 1: The contract**

In **What `aegis.deploy.json` can say**, add the `auth` row to the key table, and a paragraph saying the manifest is read twice: through the API at creation, and out of the clone on every deployment. State which keys take effect on a live project and which are reported, and why the split is where it is.

In **Every refusal, and its fix**, add `preview_settings_fixed`.

- [ ] **Step 2: ADDING-A-SITE**

The KPI section already says the branch answers the form. Add that correcting a project is the Settings tab and no longer a delete.

- [ ] **Step 3: The changelog and the version**

Move the `## Unreleased` heading to `## 0.3.0`. This is a minor and not a patch: a new route, a new manifest key, and a behaviour that changes on every deployment rather than at creation.

Set `"release": "0.3.0"` in `extension.json`.

- [ ] **Step 4: Cut it**

```bash
cd <extensions checkout>
gh auth switch -h github.com -u Chase-perfection
AEGIS_TREE=<path to the Aegis checkout> node scripts/local/release.mjs deploy 0.3.0 --dry-run
AEGIS_TREE=<path to the Aegis checkout> node scripts/local/release.mjs deploy 0.3.0
gh auth switch -h github.com -u SI-BRI
```

Nothing else may run in the background while the release runs. It pushes a tag and a catalogue commit, and a background job that switches the active account mid-run fails the push with a 403, which is how 0.2.2 failed the first time.

---

## What this plan does not do, and why

**It does not detect a start command.** Outside `package.json` there is no convention for one, and starting the wrong process on a server holding directory audit data is worse than asking. `aegis.deploy.json` is the answer, and Task 3 puts the authentication method beside it.

**It does not let a branch name who may read the site.** The method is the branch's business, the people are the operator's. `aegis.access.json` already draws that line and this follows it.

**It does not change the host opt-in.** `AEGIS_DEPLOY_RUNTIME` and a provisioned runtime account stay a decision made on the machine. A file in a repository that could grant itself a process on an audit server is the vulnerability, not the feature.

---

## Execution Handoff

Plan saved to `docs/plans/2026-09-16-deploy-projets-declaratifs.md` in the `4.6-Aegis.extensions` checkout, which tracks it: both `docs/plans/` and `docs/superpowers/` are gitignored in the Aegis checkout, so a plan written there would not survive.

Two execution options:

1. **Subagent-driven (recommended)** — a fresh subagent per task, reviewed between tasks.
2. **Inline** — executed in this session with checkpoints.
