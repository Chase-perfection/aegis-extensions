/**
 * Working out what a branch needs run, from what is in it.
 *
 * Last of the three answers to a form full of fields, under what the operator
 * typed and under `aegis.deploy.json`. Every rule here rests on a signal that
 * says one thing only: a lockfile names its package manager, and package.json
 * names its own build script. Nothing maps a framework to an output directory,
 * which is the mapping a wrong answer would use to serve a site's source.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const detect = require('../detectProject');

const PKG_WITH_BUILD = { scripts: { build: 'vite build', dev: 'vite' } };
const PKG_NO_BUILD = { scripts: { start: 'node server.js' } };

test('a lockfile names the package manager, and it is not guessed', () => {
    const cases = [
        ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile', 'pnpm run build'],
        ['yarn.lock', 'yarn install --frozen-lockfile', 'yarn build'],
        ['bun.lockb', 'bun install --frozen-lockfile', 'bun run build'],
        ['package-lock.json', 'npm ci', 'npm run build']
    ];
    for (const [lock, install, build] of cases) {
        const r = detect.detect(['package.json', lock, 'src'], PKG_WITH_BUILD);
        assert.strictEqual(r.installCmd, install, `${lock} chose the wrong install`);
        assert.strictEqual(r.buildCmd, build, `${lock} chose the wrong build`);
        assert.match(r.why, new RegExp(lock.replace('.', '\\.')));
    }
});

test('the most specific lockfile wins when a repository carries two', () => {
    const r = detect.detect(['package.json', 'package-lock.json', 'pnpm-lock.yaml'], PKG_WITH_BUILD);
    assert.strictEqual(r.installCmd, 'pnpm install --frozen-lockfile');
});

test('no lockfile still installs, without pretending there is one', () => {
    const r = detect.detect(['package.json'], PKG_WITH_BUILD);
    assert.strictEqual(r.installCmd, 'npm install', 'npm ci needs a lockfile it does not have');
    assert.strictEqual(r.buildCmd, 'npm run build');
    assert.match(r.why, /no lockfile/);
});

test('no build script means no build command, invented or otherwise', () => {
    const r = detect.detect(['package.json', 'package-lock.json'], PKG_NO_BUILD);
    assert.strictEqual(r.installCmd, 'npm ci');
    assert.strictEqual(r.buildCmd, '', 'a build command was invented for a package with no build script');
    assert.match(r.why, /no build script/);
});

test('an empty build script is not a build script', () => {
    const r = detect.detect(['package.json'], { scripts: { build: '   ' } });
    assert.strictEqual(r.buildCmd, '');
});

test('requirements.txt means pip, and never a start command', () => {
    const r = detect.detect(['requirements.txt', 'app.py'], null);
    assert.strictEqual(r.installCmd, 'pip install --no-cache-dir -r requirements.txt --target .');
    assert.strictEqual(r.buildCmd, '');
    assert.match(r.why, /start command is never detected/);
});

test('a branch that says nothing gets nothing, which is the old behaviour', () => {
    const r = detect.detect(['index.html', 'style.css'], null);
    assert.strictEqual(r.installCmd, '');
    assert.strictEqual(r.buildCmd, '');
    assert.strictEqual(r.why, null);
});

test('an unreadable package.json is a repository detection stays out of', () => {
    // The route passes null when JSON.parse threw. A lockfile beside it must not
    // be enough on its own: without the scripts there is no build to run.
    const r = detect.detect(['package.json', 'package-lock.json'], null);
    assert.strictEqual(r.installCmd, '');
    assert.strictEqual(r.buildCmd, '');
});

test('no output directory is ever proposed', () => {
    for (const names of [['package.json', 'package-lock.json'], ['requirements.txt']]) {
        const r = detect.detect(names, PKG_WITH_BUILD);
        assert.ok(!('outputDir' in r) || !r.outputDir,
            'detection proposed an output directory, which is the guess it exists to avoid');
    }
});

test('what the operator typed is never replaced by detection', () => {
    const guess = detect.detect(['package.json', 'package-lock.json'], PKG_WITH_BUILD);
    const { values, from } = detect.merge({ installCmd: 'npm ci --omit=dev', buildCmd: '' }, guess);
    assert.strictEqual(values.installCmd, 'npm ci --omit=dev');
    assert.strictEqual(values.buildCmd, 'npm run build');
    assert.deepStrictEqual(from, ['buildCmd']);
});

test('detection fills nothing when it detected nothing', () => {
    const { values, from } = detect.merge({ installCmd: '', buildCmd: '' },
        detect.detect(['index.html'], null));
    assert.strictEqual(values.installCmd, '');
    assert.deepStrictEqual(from, []);
});
