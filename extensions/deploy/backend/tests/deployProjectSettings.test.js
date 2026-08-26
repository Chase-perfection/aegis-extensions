/**
 * `projectSettings` directly: no route, no filesystem, no network.
 *
 * `createRoute.test.js` reaches only the refusals that fire before GitHub is
 * contacted, so the defaults case (no clone ever succeeds against a
 * repository built to not exist) does not belong there. Testing the pure
 * module instead of the route is what makes that case observable offline.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const projectSettings = require('../projectSettings');

function refusalCode(fn) {
    try {
        fn();
    } catch (e) {
        return e.code;
    }
    return null;
}

test('no input at all gives the defaults', () => {
    assert.equal(projectSettings.resolveDbFile(undefined), 'app.db');
    assert.equal(projectSettings.resolveMigrationsDir(undefined), 'migrations');
});

test('empty strings give the same defaults', () => {
    assert.equal(projectSettings.resolveDbFile(''), 'app.db');
    assert.equal(projectSettings.resolveMigrationsDir(''), 'migrations');
});

test('a valid custom dbFile and migrationsDir come back as given', () => {
    assert.equal(projectSettings.resolveDbFile('deploy.sqlite'), 'deploy.sqlite');
    assert.equal(projectSettings.resolveMigrationsDir('db/migrations'), 'db/migrations');
});

test('trailing slashes are stripped from migrationsDir', () => {
    assert.equal(projectSettings.resolveMigrationsDir('migrations/'), 'migrations');
    assert.equal(projectSettings.resolveMigrationsDir('migrations\\'), 'migrations');
});

test('a dbFile that climbs out of the data folder is refused', () => {
    assert.equal(refusalCode(() => projectSettings.resolveDbFile('..\\..\\aegis.db')), 'bad_db_file');
});

test('a valid name that is not a database is refused the same way', () => {
    assert.equal(refusalCode(() => projectSettings.resolveDbFile('notes.txt')), 'bad_db_file');
});

test('a dbFile starting with a dot is refused', () => {
    assert.equal(refusalCode(() => projectSettings.resolveDbFile('.env.db')), 'bad_db_file');
});

test('a migrationsDir that climbs out of the clone is refused', () => {
    assert.equal(refusalCode(() => projectSettings.resolveMigrationsDir('../ailleurs')), 'bad_migrations_dir');
});

test('a .. in any segment is refused, not just the first', () => {
    assert.equal(refusalCode(() => projectSettings.resolveMigrationsDir('a/../../b')), 'bad_migrations_dir');
});

test('a nested migrations folder is accepted', () => {
    assert.equal(projectSettings.resolveMigrationsDir('sous/dossier'), 'sous/dossier');
});
