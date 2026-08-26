'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const migrations = require('../migrations');

function workspace(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-mig-'));
    const migDir = path.join(dir, 'migrations');
    fs.mkdirSync(migDir, { recursive: true });
    Object.keys(files).forEach((name) => {
        fs.writeFileSync(path.join(migDir, name), files[name], 'utf8');
    });
    return { dir, migDir };
}

test('les fichiers sont ordonnes par nom, pas par date de fichier', () => {
    const { migDir } = workspace({
        '010-dix.sql': '-- dix',
        '002-deux.sql': '-- deux',
        '001-un.sql': '-- un'
    });

    assert.deepStrictEqual(migrations.list(migDir),
        ['001-un.sql', '002-deux.sql', '010-dix.sql']);
});

test('seuls les .sql sont pris ; le reste du dossier est ignore', () => {
    const { migDir } = workspace({
        '001-un.sql': '-- un',
        'README.md': '# notes',
        '002-deux.SQL': '-- deux en majuscules'
    });

    assert.deepStrictEqual(migrations.list(migDir), ['001-un.sql', '002-deux.SQL']);
});

test('un dossier absent n est pas une panne : un projet sans migrations est normal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-nomig-'));
    assert.deepStrictEqual(migrations.list(path.join(dir, 'migrations')), []);
});

test('un nom de fichier hostile est refuse et nomme', () => {
    const { migDir } = workspace({ '001-ok.sql': '-- ok' });
    fs.writeFileSync(path.join(migDir, '.cache.sql'), '-- cache', 'utf8');

    assert.deepStrictEqual(migrations.list(migDir), ['001-ok.sql'],
        'un nom commencant par un point n est pas une migration');
});

test('pending retire ce que le registre porte deja', () => {
    const { migDir } = workspace({
        '001-un.sql': '-- un',
        '002-deux.sql': '-- deux',
        '003-trois.sql': '-- trois'
    });

    assert.deepStrictEqual(
        migrations.pending(migDir, ['001-un.sql', '002-deux.sql']),
        ['003-trois.sql']);
});

test('un fichier disparu du depot mais deja applique ne fait pas echouer', () => {
    const { migDir } = workspace({ '002-deux.sql': '-- deux' });

    assert.deepStrictEqual(migrations.pending(migDir, ['001-supprime.sql']),
        ['002-deux.sql']);
});

test('run applique les fichiers en attente et inscrit chacun', async () => {
    const { migDir } = workspace({
        '001-un.sql': 'CREATE TABLE t (a TEXT);',
        '002-deux.sql': 'INSERT INTO t VALUES (\'x\');'
    });
    const played = [];
    const recorded = [];

    const result = await migrations.run({
        dbFile: 'C:\\faux\\app.db',
        dir: migDir,
        sha: 'abc1234',
        writableDb: {
            appliedMigrations: async () => [],
            execScript: async (file, sql) => { played.push(sql.trim()); },
            recordMigration: async (file, entry) => { recorded.push(entry.name); }
        }
    });

    assert.deepStrictEqual(played,
        ['CREATE TABLE t (a TEXT);', 'INSERT INTO t VALUES (\'x\');']);
    assert.deepStrictEqual(recorded, ['001-un.sql', '002-deux.sql']);
    assert.deepStrictEqual(result.applied, ['001-un.sql', '002-deux.sql']);
});

test('un echec arrete la serie, nomme le fichier, et n inscrit pas le fautif', async () => {
    const { migDir } = workspace({
        '001-un.sql': 'CREATE TABLE t (a TEXT);',
        '002-casse.sql': 'CE N EST PAS DU SQL;',
        '003-jamais.sql': 'INSERT INTO t VALUES (\'x\');'
    });
    const recorded = [];

    await assert.rejects(() => migrations.run({
        dbFile: 'C:\\faux\\app.db',
        dir: migDir,
        sha: 'abc1234',
        writableDb: {
            appliedMigrations: async () => [],
            execScript: async (file, sql) => {
                if (sql.includes('CE N EST PAS')) {
                    throw Object.assign(new Error('syntax error'), { code: 'db_write_failed' });
                }
            },
            recordMigration: async (file, entry) => { recorded.push(entry.name); }
        }
    }), (e) => {
        assert.strictEqual(e.code, 'migration_failed');
        assert.match(e.message, /002-casse\.sql/);
        return true;
    });

    assert.deepStrictEqual(recorded, ['001-un.sql'],
        'la premiere reste appliquee et inscrite : on ne defait pas une migration');
});

test('rien a faire est un succes, pas un saut', async () => {
    const { migDir } = workspace({ '001-un.sql': 'CREATE TABLE t (a TEXT);' });

    const result = await migrations.run({
        dbFile: 'C:\\faux\\app.db',
        dir: migDir,
        sha: 'abc',
        writableDb: {
            appliedMigrations: async () => ['001-un.sql'],
            execScript: async () => { throw new Error('ne doit pas etre appele'); },
            recordMigration: async () => { throw new Error('ne doit pas etre appele'); }
        }
    });

    assert.deepStrictEqual(result.applied, []);
});
