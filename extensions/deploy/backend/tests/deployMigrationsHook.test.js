'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Ce test lit le source plutot que d'executer un deploiement complet : monter
 * un clone git, un compte de bac a sable et un processus pour verifier un ordre
 * d'appel couterait une minute par execution et prouverait la meme chose.
 * L'executeur lui-meme est teste en isolation dans deployMigrations.test.js.
 */
test('les migrations tournent apres le code et avant le processus', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'deployService.js'), 'utf8');

    const posDeploy = src.indexOf('await cloner.cloneToCurrent(');
    const posMigrate = src.indexOf('migrations.run(');
    const posRestart = src.indexOf('runtime.restart(');

    assert.ok(posDeploy > -1, 'cloner.cloneToCurrent introuvable');
    assert.ok(posMigrate > -1, 'migrations.run introuvable');
    assert.ok(posRestart > -1, 'runtime.restart introuvable');

    assert.ok(posDeploy < posMigrate,
        'une migration a besoin du code deploye : elle vient apres cloneToCurrent');
    assert.ok(posMigrate < posRestart,
        'le nouveau processus doit trouver le schema deja migre');
});

test('le dossier de migrations est lu dans le clone, pas dans data', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'deployService.js'), 'utf8');

    assert.match(src, /currentDir\([^)]*\)[^;]*project\.migrationsDir/s,
        'le chemin des migrations part de currentDir');
});
