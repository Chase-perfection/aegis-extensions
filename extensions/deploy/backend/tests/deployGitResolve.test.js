'use strict';

/**
 * The backend does not share the operator's PATH.
 *
 * Git for Windows installed without admin lands in one user's PATH, so the
 * account the backend runs under (SYSTEM on an installed host) never sees it
 * and every clone fails with ENOENT. Each case runs in a child process because
 * the resolver caches its answer for the life of the process, which is the
 * behaviour we want in production and the one thing a same-process test cannot
 * exercise twice.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CLONER = path.join(__dirname, '..', 'cloner.js');

/** Resolves git in a fresh node with the given environment. */
function resolveWith(env) {
    return execFileSync(
        process.execPath,
        ['-e', `process.stdout.write(require(${JSON.stringify(CLONER)}).gitExe())`],
        { env: Object.assign({}, process.env, env), encoding: 'utf8', windowsHide: true }
    ).trim();
}

test('AEGIS_GIT_EXE wins over everything else', () => {
    assert.strictEqual(resolveWith({ AEGIS_GIT_EXE: 'C:\somewhere\git.exe' }), 'C:\somewhere\git.exe');
});

test('git on PATH is used as the bare name', () => {
    assert.strictEqual(resolveWith({ AEGIS_GIT_EXE: '' }), 'git');
});

test('a PATH without git falls back to the install on disk', () => {
    const onDisk = path.join(process.env['ProgramFiles'] || 'C:\Program Files', 'Git', 'cmd', 'git.exe');
    const stripped = (process.env.Path || process.env.PATH || '')
        .split(path.delimiter)
        .filter((p) => p && !/git/i.test(p))
        .join(path.delimiter);

    const resolved = resolveWith({ AEGIS_GIT_EXE: '', Path: stripped, PATH: stripped });

    if (fs.existsSync(onDisk)) {
        assert.strictEqual(resolved, onDisk);
    } else {
        // No Git for Windows here: the bare name is kept so the ENOENT names
        // git and deployService reports tool_missing rather than a bad branch.
        assert.strictEqual(resolved, 'git');
    }
});
