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
