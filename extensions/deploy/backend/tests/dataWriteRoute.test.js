'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Les routes de donnees existantes sont couvertes par projectData.test.js pour
 * le confinement de chemin, qui est le point dur. Ici on verifie les proprietes
 * que les nouvelles routes ajoutent, et qu'un test de source suffit a etablir :
 * le role exige, et l'absence de toute route qui prendrait du SQL.
 */
function routesSrc() {
    return fs.readFileSync(path.join(__dirname, '..', 'routes.js'), 'utf8');
}

test('les trois routes d ecriture exigent le role admin', () => {
    const src = routesSrc();

    [
        /router\.patch\('\/api\/deploy\/projects\/:id\/data\/:file\/rows'[^)]*requireRole\('admin'\)/,
        /router\.post\('\/api\/deploy\/projects\/:id\/data\/:file\/rows'[^)]*requireRole\('admin'\)/,
        /router\.delete\('\/api\/deploy\/projects\/:id\/data\/:file\/rows'[^)]*requireRole\('admin'\)/
    ].forEach((re) => assert.match(src, re));
});

test('aucune route n expose execScript', () => {
    const src = routesSrc();
    assert.doesNotMatch(src, /execScript/,
        'execScript ne doit etre appele que par l executeur de migrations');
});

test('aucune route ne prend de SQL depuis le corps ou la requete', () => {
    const src = routesSrc();
    assert.doesNotMatch(src, /body\.sql|query\.sql/,
        'le modele de securite du module d ecriture repose sur l absence de SQL entrant');
});

test('chaque ecriture est journalisee avec l auteur', () => {
    const src = routesSrc();
    const writes = src.match(/data (write|insert|delete)/g) || [];
    assert.strictEqual(writes.length, 3,
        'les trois ecritures laissent une ligne nommant qui a modifie quoi');
});

test('la route data rend le chemin absolu du dossier, pour la tache planifiee', () => {
    const src = routesSrc();
    assert.match(src, /dataDir:\s*projectStore\.ensureDataDir\(/,
        'le chemin absolu est rendu : sans lui, aucune ACL ne peut etre posee');
});

/**
 * Le defaut de `dataError` est ce qui compte : un code absent de sa liste
 * devient un 500 « n a pas pu lire ce dossier ». Pour un refus d ecriture,
 * c est faux trois fois. Ce test tient la liste a jour avec `writableDb`.
 */
test('tout code de refus que writableDb leve est traite, aucun ne tombe en 500', () => {
    const src = routesSrc();
    const block = src.slice(src.indexOf('const dataError ='),
        src.indexOf('const dataError =') + 2000);

    // Les codes que writableDb.js leve a l ecriture, releves a la source.
    ['not_editable', 'bad_column', 'bad_value', 'bad_rowid', 'constraint', 'unknown_row']
        .forEach(function (code) {
            assert.ok(block.includes(`'${code}'`),
                `${code} tombe dans le 500 generique au lieu d etre un refus`);
        });
});

test('un 500 sur une ecriture ne dit pas qu il lisait', () => {
    const src = routesSrc();
    assert.match(src, /db_write_failed/,
        'le defaut doit distinguer lecture et ecriture');
    assert.match(src, /\['updateCell', 'insertRow', 'deleteRow'\]/,
        'les trois ecritures doivent etre nommees pour choisir le mot');
});
