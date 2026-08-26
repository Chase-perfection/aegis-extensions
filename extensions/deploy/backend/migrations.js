/**
 * Faire evoluer le schema d'un projet sans toucher a ses donnees.
 *
 * La question que ce module resout est celle que pose le dossier `data/` :
 * il survit a tous les deploiements, donc le depot ne peut pas y livrer une
 * base neuve a chaque push, donc un nouveau schema doit arriver autrement.
 * Il arrive par des `.sql` numerotes, joues une fois chacun, dans l'ordre de
 * leur nom.
 *
 * Le depot ne livre JAMAIS de fichier `.db`. Si un jour un `deploy.db` apparait
 * dans un depot, il ne sera pas copie : ce serait exactement l'ecrasement que
 * toute cette disposition existe pour empecher.
 *
 * L'ordre vient du nom et pas de la date du fichier : un clone git donne a tous
 * les fichiers la date du clone, donc trier par mtime rendrait un ordre
 * arbitraire, different a chaque deploiement.
 *
 * Ce module ne connait pas SQLite. `writableDb` lui est passe, comme le
 * chargeur le passe a l'extension, ce qui le rend testable sans base.
 *
 * ponytail : pas de migration descendante, pas de somme de controle sur un
 * fichier deja joue, pas d'application manuelle depuis la page. Les deux
 * premieres sont des fonctionnalites dont personne n'a encore eu besoin ; la
 * troisieme ferait diverger la base et le depot, ce que ce fichier existe pour
 * empecher.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Ce qu'un nom de migration peut etre.
 *
 * Pas de separateur, pas de point en tete, borne. Meme forme que `FILE_RE` dans
 * `projectData.js`, et pour la meme raison : ce nom finit dans une jointure de
 * chemin, et un nom qui traverse le dossier lirait un `.sql` que personne n'a
 * relu.
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.sql$/i;

/** Le dossier de migrations d'un projet, relatif a la racine de son clone. */
const DEFAULT_DIR = 'migrations';

/** Le fichier de base d'un projet, relatif a son dossier `data/`. */
const DEFAULT_DB = 'app.db';

function fail(code, message) {
    return Object.assign(new Error(message), { code });
}

/**
 * Les migrations presentes, triees par nom.
 *
 * `localeCompare` est ecarte volontairement : son ordre depend de la locale de
 * la machine, et deux serveurs joueraient alors deux ordres differents pour le
 * meme depot. Une comparaison de chaines brute est reproductible.
 */
function list(dir) {
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch (_) {
        return [];        // pas de dossier : un projet sans migrations est normal
    }
    return names
        .filter((n) => NAME_RE.test(n))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Ce qui reste a jouer.
 *
 * Un nom inscrit au registre mais absent du depot est ignore sans bruit : un
 * fichier peut avoir ete supprime apres coup, et la base porte deja son effet.
 * Le refuser bloquerait tout deploiement suivant pour une raison qu'on ne peut
 * plus corriger.
 */
function pending(dir, applied) {
    const done = new Set(applied || []);
    return list(dir).filter((n) => !done.has(n));
}

/**
 * Joue ce qui reste. Chaque fichier est une transaction, inscrite apres coup.
 *
 * L'inscription suit l'application et ne la precede pas : si le processus meurt
 * entre les deux, la migration sera rejouee. Une migration ecrite pour etre
 * rejouable s'en remet ; l'ordre inverse laisserait une migration inscrite et
 * jamais appliquee, dont plus rien ne signale l'absence.
 */
async function run(options) {
    const opts = options || {};
    const writable = opts.writableDb;
    if (!writable) throw fail('no_writer', 'writableDb non fourni');

    const dir = opts.dir;
    const dbFile = opts.dbFile;
    const applied = await writable.appliedMigrations(dbFile);
    const todo = pending(dir, applied);

    const done = [];
    for (const name of todo) {
        const full = path.join(dir, name);
        let sql;
        try {
            sql = fs.readFileSync(full, 'utf8');
        } catch (e) {
            throw fail('migration_failed', `${name} : illisible (${e.message})`);
        }
        try {
            await writable.execScript(dbFile, sql);
        } catch (e) {
            // Ce qui precede reste applique. On ne defait pas une migration :
            // personne ne sait le faire correctement, et le pretendre serait
            // pire que de le dire.
            throw fail('migration_failed', `${name} : ${e.message}`);
        }
        await writable.recordMigration(dbFile, { name, sha: opts.sha || null });
        done.push(name);
    }

    return { applied: done, alreadyApplied: applied };
}

module.exports = { list, pending, run, NAME_RE, DEFAULT_DIR, DEFAULT_DB };
