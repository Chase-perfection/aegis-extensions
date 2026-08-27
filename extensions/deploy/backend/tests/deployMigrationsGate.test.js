/**
 * Ce qu'un deploiement fait des migrations, vu du deploiement.
 *
 * `deployMigrations.test.js` teste l'executeur : il joue les bons fichiers dans
 * le bon ordre et refuse ce qu'il faut refuser. Ce fichier teste la decision
 * autour de lui, qui est celle qui a mal tourne en production : une version dont
 * les migrations n'avaient pas ete jouees passait toutes les etapes en vert, se
 * publiait, et laissait sur la console une phrase que personne ne pouvait
 * corriger. La verification etait imprimee, pas appliquee.
 *
 * Trois choses a prouver ici, et aucune ne se voit dans l'executeur :
 *
 *   - un projet sans migrations ne dit rien du tout ;
 *   - un projet qui en a et un Aegis qui ne sait pas les jouer est un echec ;
 *   - un echec remet la version precedente sur le port.
 *
 * `cloner` et `runtime` sont remplaces sur l'objet de module : `deployService`
 * les lit en propriete a l'appel, donc les substituer ici suffit et evite un
 * clone git, un compte de bac a sable et un processus -- une minute par
 * execution pour prouver un ordre d'appel.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-miggate-'));
process.env.AEGIS_DATA_ROOT = DATA_ROOT;

const test = require('node:test');
const assert = require('node:assert');

const cloner = require('../cloner');
const projectStore = require('../projectStore');
const runs = require('../runs');
const deployService = require('../deployService');

console.log = () => { };
console.warn = () => { };

const TENANTS_ROOT = path.join(DATA_ROOT, 'tenants');

function pathsFor(slug) {
    const root = path.join(TENANTS_ROOT, slug);
    return { root, deploy: path.join(root, 'deploy') };
}

/**
 * Un projet, ses dossiers, et le clone que `cloneToCurrent` aurait publie.
 *
 * `migrations` nomme les fichiers a poser dans `current/migrations/` : c'est la
 * ou `deployNow` les cherche, parce que les `.sql` arrivent par le depot.
 */
function fixture(options) {
    const opts = options || {};
    const slug = `t${Math.random().toString(36).slice(2, 8)}`;
    const tenantPaths = pathsFor(slug);
    const project = Object.assign({
        id: 'site',
        name: 'Site',
        repoFullName: 'acme/site',
        branch: 'main',
        runtime: 'static',
        installationId: null,
        lastSha: null
    }, opts.project || {});

    const currentDir = projectStore.currentDir(tenantPaths, project.id);
    fs.mkdirSync(currentDir, { recursive: true });
    fs.writeFileSync(path.join(currentDir, 'index.html'), '<h1>ok</h1>', 'utf8');

    const names = Object.keys(opts.migrations || {});
    if (names.length) {
        const migDir = path.join(currentDir, 'migrations');
        fs.mkdirSync(migDir, { recursive: true });
        names.forEach((n) => fs.writeFileSync(path.join(migDir, n), opts.migrations[n], 'utf8'));
    }

    return { slug, tenantPaths, project };
}

/** Remplace `cloneToCurrent` et `rollback`, et rend ce qu'ils ont recu. */
function stubCloner(sha) {
    const calls = { rollbacks: [] };
    const realClone = cloner.cloneToCurrent;
    const realRollback = cloner.rollback;

    cloner.cloneToCurrent = async () => ({ sha });
    cloner.rollback = (args) => { calls.rollbacks.push(args); return sha; };

    calls.restore = () => {
        cloner.cloneToCurrent = realClone;
        cloner.rollback = realRollback;
    };
    return calls;
}

/** Un run reel, pour lire les etapes et les lignes que la console aurait vues. */
function record(slug, tenantPaths, project) {
    return runs.start({
        slug, tenantPaths, projectId: project.id, projectName: project.name,
        branch: project.branch, trigger: 'manual'
    });
}

function stageOf(run, key) {
    return run.stages.find((s) => s.key === key) || null;
}

function text(run) {
    return run.lines.map((l) => l.text).join('\n');
}

// Le cas qui a mis la phrase a l'ecran. Un site statique n'a pas de dossier
// `migrations/`, donc il n'a rien a dire des migrations : jusqu'a 0.1.3 il
// annoncait « cette version d Aegis ne sait pas jouer de migration » a chaque
// deploiement, une phrase alarmante qui ne parlait de rien.
test('un projet sans migrations ne parle pas de migrations', async () => {
    const { slug, tenantPaths, project } = fixture({});
    const stub = stubCloner('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');
    deployService.useWritableDb(null);
    const run = record(slug, tenantPaths, project);

    try {
        const result = await deployService.deployNow({
            app: null, slug, tenantPaths, project, trigger: 'manual', run
        });
        assert.strictEqual(result.deployed, true);
    } finally {
        stub.restore();
    }

    assert.doesNotMatch(text(run), /migration/i,
        'aucune ligne de journal ne doit parler de migrations');
    assert.strictEqual(stageOf(run, 'migrate').status, 'skipped',
        'une etape sautee ne s affiche pas sur la console');
    assert.strictEqual(run.status, 'ready');
});

// Le coeur du bug. Une verification qu on ne sait pas faire est un echec, pas
// un commentaire : sinon une version dont le code attend une colonne absente
// repond au health check et tombe a la premiere requete d un utilisateur.
test('des migrations et un Aegis qui ne sait pas les jouer refusent le deploiement', async () => {
    const { slug, tenantPaths, project } = fixture({
        migrations: { '001-un.sql': 'CREATE TABLE t (a TEXT);' }
    });
    const stub = stubCloner('bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222');
    deployService.useWritableDb(null);
    const run = record(slug, tenantPaths, project);

    try {
        await assert.rejects(
            () => deployService.deployNow({
                app: null, slug, tenantPaths, project, trigger: 'manual', run
            }),
            (e) => {
                assert.strictEqual(e.reason, 'migrations_unsupported',
                    'la raison doit nommer ce qui manque, pas la branche');
                return true;
            });
    } finally {
        stub.restore();
    }

    assert.strictEqual(run.status, 'failed');
    assert.strictEqual(stageOf(run, 'migrate').status, 'failed',
        'la console doit montrer l etape qui a refuse');
    assert.match(text(run), /mettre a jour Aegis/,
        'le journal doit dire quoi faire sur l hote');
    assert.strictEqual(stub.rollbacks.length, 1,
        'le dossier vient d etre echange : la version qui servait repart sur le port');
});

test('une migration refusee par SQLite refuse le deploiement et remet l ancienne version', async () => {
    const { slug, tenantPaths, project } = fixture({
        project: { lastSha: 'cccc3333cccc3333cccc3333cccc3333cccc3333' },
        migrations: { '001-casse.sql': 'CE N EST PAS DU SQL;' }
    });
    const sha = 'dddd4444dddd4444dddd4444dddd4444dddd4444';
    const stub = stubCloner(sha);
    deployService.useWritableDb({
        appliedMigrations: async () => [],
        execScript: async () => {
            throw Object.assign(new Error('syntax error'), { code: 'db_write_failed' });
        },
        recordMigration: async () => { throw new Error('ne doit pas etre appele'); }
    });
    const run = record(slug, tenantPaths, project);

    try {
        await assert.rejects(
            () => deployService.deployNow({
                app: null, slug, tenantPaths, project, trigger: 'manual', run
            }),
            (e) => {
                assert.strictEqual(e.reason, 'migration_failed');
                return true;
            });
    } finally {
        stub.restore();
        deployService.useWritableDb(null);
    }

    assert.match(text(run), /001-casse\.sql/,
        'le journal doit nommer le fichier refuse');
    assert.strictEqual(stageOf(run, 'migrate').status, 'failed');
    assert.deepStrictEqual(
        stub.rollbacks.map((r) => r.previousSha),
        ['cccc3333cccc3333cccc3333cccc3333cccc3333'],
        'la version remise est celle qui servait avant ce deploiement');
});

test('des migrations jouees passent l etape en vert et nomment chaque fichier', async () => {
    const { slug, tenantPaths, project } = fixture({
        migrations: {
            '001-un.sql': 'CREATE TABLE t (a TEXT);',
            '002-deux.sql': "INSERT INTO t VALUES ('x');"
        }
    });
    const sha = 'eeee5555eeee5555eeee5555eeee5555eeee5555';
    const stub = stubCloner(sha);
    const played = [];
    deployService.useWritableDb({
        appliedMigrations: async () => [],
        execScript: async (file, sql) => { played.push(sql.trim()); },
        recordMigration: async () => { }
    });
    const run = record(slug, tenantPaths, project);

    try {
        const result = await deployService.deployNow({
            app: null, slug, tenantPaths, project, trigger: 'manual', run
        });
        assert.strictEqual(result.deployed, true);
    } finally {
        stub.restore();
        deployService.useWritableDb(null);
    }

    assert.strictEqual(played.length, 2, 'les deux fichiers sont joues');
    assert.strictEqual(stageOf(run, 'migrate').status, 'done');
    assert.match(text(run), /migration appliquee : 001-un\.sql/);
    assert.match(text(run), /migration appliquee : 002-deux\.sql/);
    assert.strictEqual(stub.rollbacks.length, 0, 'rien a defaire');
    assert.strictEqual(run.status, 'ready');
});

// Un projet dont le schema est deja a jour ne doit pas passer pour un projet
// sans migrations : l etape existe, elle est verte, et elle dit pourquoi.
test('des migrations deja jouees laissent l etape verte sans rien rejouer', async () => {
    const { slug, tenantPaths, project } = fixture({
        migrations: { '001-un.sql': 'CREATE TABLE t (a TEXT);' }
    });
    const stub = stubCloner('ffff6666ffff6666ffff6666ffff6666ffff6666');
    deployService.useWritableDb({
        appliedMigrations: async () => ['001-un.sql'],
        execScript: async () => { throw new Error('ne doit pas etre appele'); },
        recordMigration: async () => { throw new Error('ne doit pas etre appele'); }
    });
    const run = record(slug, tenantPaths, project);

    try {
        await deployService.deployNow({
            app: null, slug, tenantPaths, project, trigger: 'manual', run
        });
    } finally {
        stub.restore();
        deployService.useWritableDb(null);
    }

    assert.strictEqual(stageOf(run, 'migrate').status, 'done');
    assert.match(text(run), /deja jouee/);
    assert.strictEqual(run.status, 'ready');
});

// Ce que le poller a besoin de savoir. Un clone refuse ne connait pas de
// commit, donc `deployNow` le prend de son appelant : sans cela le meme commit
// serait retente indefiniment, ce qui est la boucle que 0.1.3 ferme.
test('un echec est classe sous le commit que l appelant a decide de deployer', async () => {
    const { slug, tenantPaths, project } = fixture({});
    const realClone = cloner.cloneToCurrent;
    cloner.cloneToCurrent = async () => {
        throw Object.assign(new Error('fatal: repository not found'), { code: 'ENOENT' });
    };
    const run = record(slug, tenantPaths, project);

    try {
        await assert.rejects(() => deployService.deployNow({
            app: null, slug, tenantPaths, project, trigger: 'poll', run,
            headSha: '9999aaaa9999aaaa9999aaaa9999aaaa9999aaaa'
        }));
    } finally {
        cloner.cloneToCurrent = realClone;
    }

    const stored = projectStore.getProject(tenantPaths, project.id);
    assert.strictEqual(stored.lastFailedSha, '9999aaaa9999aaaa9999aaaa9999aaaa9999aaaa');
    assert.strictEqual(stored.failedShaAttempts, 1);
});

test('le meme commit qui echoue a nouveau compte une tentative de plus', async () => {
    const failed = '9999aaaa9999aaaa9999aaaa9999aaaa9999aaaa';
    const { slug, tenantPaths, project } = fixture({
        project: { lastFailedSha: failed, failedShaAttempts: 1 }
    });
    const realClone = cloner.cloneToCurrent;
    cloner.cloneToCurrent = async () => {
        throw Object.assign(new Error('fatal: repository not found'), { code: 'ENOENT' });
    };

    try {
        await assert.rejects(() => deployService.deployNow({
            app: null, slug, tenantPaths, project, trigger: 'poll',
            run: record(slug, tenantPaths, project), headSha: failed
        }));
    } finally {
        cloner.cloneToCurrent = realClone;
    }

    assert.strictEqual(
        projectStore.getProject(tenantPaths, project.id).failedShaAttempts, 2);
});

// Le compteur est par commit et pas par projet : un commit different repart de
// un, sinon un projet qui a mal tourne une fois bloquerait la branche entiere.
test('un autre commit qui echoue repart a une tentative', async () => {
    const { slug, tenantPaths, project } = fixture({
        project: { lastFailedSha: '1111bbbb1111bbbb1111bbbb1111bbbb1111bbbb', failedShaAttempts: 3 }
    });
    const realClone = cloner.cloneToCurrent;
    cloner.cloneToCurrent = async () => {
        throw Object.assign(new Error('fatal: repository not found'), { code: 'ENOENT' });
    };

    try {
        await assert.rejects(() => deployService.deployNow({
            app: null, slug, tenantPaths, project, trigger: 'poll',
            run: record(slug, tenantPaths, project),
            headSha: '2222cccc2222cccc2222cccc2222cccc2222cccc'
        }));
    } finally {
        cloner.cloneToCurrent = realClone;
    }

    const stored = projectStore.getProject(tenantPaths, project.id);
    assert.strictEqual(stored.lastFailedSha, '2222cccc2222cccc2222cccc2222cccc2222cccc');
    assert.strictEqual(stored.failedShaAttempts, 1);
});

// Un deploiement qui marche efface le blocage, sinon un projet repare resterait
// bloque sur le commit qui avait echoue.
test('un deploiement reussi efface le commit en echec', async () => {
    const failed = '3333dddd3333dddd3333dddd3333dddd3333dddd';
    const { slug, tenantPaths, project } = fixture({
        project: { lastFailedSha: failed, failedShaAttempts: 3 }
    });
    const stub = stubCloner('4444eeee4444eeee4444eeee4444eeee4444eeee');
    deployService.useWritableDb(null);

    try {
        await deployService.deployNow({
            app: null, slug, tenantPaths, project, trigger: 'manual',
            run: record(slug, tenantPaths, project)
        });
    } finally {
        stub.restore();
    }

    const stored = projectStore.getProject(tenantPaths, project.id);
    assert.strictEqual(stored.lastFailedSha, null);
    assert.strictEqual(stored.failedShaAttempts, 0);
});
