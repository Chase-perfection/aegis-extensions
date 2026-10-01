# Arbre des comptes, livraison 1a : le backend. Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** le backend de l'extension `account-tiering` (analyse, règles, remédiation, stockage, lanceur, routes), testé sans AD sur des faits fictifs.

**Architecture:** des modules purs (`sids`, `classify`, `analyze`, `remediation`, `exportCsv`) transforment les faits en modèle. `store.js` garde analyses, règles et corrections dans la base par tenant que le cœur fournit (`extensionDb`). `runner.js` lance le collecteur et ramène chaque échec à un code. `routes.js` assemble le tout sous `/api/account-tiering`, réservé aux administrateurs.

**Tech Stack:** Node 20+ en CommonJS, `node:test`, aucune dépendance. `node:sqlite` sert seulement aux tests, sur Node 22.5 et plus.

**Spécification:** `docs/plans/2026-09-30-account-tiering-conception.md`, ci-après « la conception ».

---

## Où en est-on

Le code de ce plan a tourné avant d'être écrit ici. Le prototype complet donne
56 tests réussis sur Node 24. Sans `node:sqlite`, comme en CI sur Node 20.19.1,
il donne 43 tests réussis, 13 sautés et aucun échec. Deux mutations de
`analyze.js` font échouer les tests visés (tâche 5, étape 6).

## Périmètre

La conception prévoit trois livraisons. La livraison 1 (analyse, règles,
remédiation, stockage, routes, page) se coupe ici en deux plans :

- **1a, ce plan** : tout le backend ;
- **1b, plan suivant** : la page, reprise de la maquette validée
  (`C:\Users\PV\Downloads\Arbre des comptes.html`, hors des dépôts).

Hors de ce plan : le script de collecte (livraison 2), les clés de traduction
dans le cœur, la vignette et la publication (livraison 3).

## Écarts avec la conception

Chacun est voulu. Le reporter dans la conception au moment du commit de la tâche 9.

| Point | Conception | Ce plan | Raison |
|---|---|---|---|
| DCSync dans les faits | un droit `DCSync` | deux droits, `DCSyncGetChanges` et `DCSyncGetChangesAll` | sinon le test « DCSync incomplet » de la conception ne peut rien vérifier : l'analyse ne verrait jamais une moitié seule. Le script de la livraison 2 émet les deux moitiés. |
| Nom NetBIOS | absent | champ facultatif `netbios` dans les faits, sinon le premier label DNS en majuscules | `dsacls ... /R 'DOMAINE\compte'` demande le nom NetBIOS, qui ne se déduit pas toujours du nom DNS. |
| Groupe principal | `Remove-ADGroupMember` | `Set-ADObject -Replace @{primaryGroupID=513}` (515 pour un ordinateur ou un gMSA) | `Remove-ADGroupMember` ne retire pas un groupe principal. |
| Titulaires trop larges | nœud « Tous les comptes », en tête des points de passage | idem, mais leur tier ne descend sur aucun compte | le collecteur ne lit pas les comptes qu'ils couvrent ; les compter en écart ferait de chaque compte un Tier 0. |
| Modification d'une GPO | Tier 0 si la GPO est liée à la racine ou à l'OU Domain Controllers, rien d'autre | Tier 0 dans ce cas, sinon le tier des machines où la GPO pose des groupes locaux (DC 0, serveur 1, poste 2) | règle de la conception elle-même : « un titulaire qui contrôle un objet de tier N reçoit le tier N ». Modifier une GPO qui fait des administrateurs locaux sur des serveurs, c'est administrer ces serveurs. |
| DnsAdmins | trouvé par le script | l'analyse le reconnaît par `sAMAccountName` | le format des faits ne porte pas de liste de cibles. |
| Codes d'erreur | liste fermée | plus `collector_failed` (sortie non nulle ou faits illisibles), `internal`, et `invalid_sid`, `invalid_tier`, `reason_required`, `invalid_rules`, `invalid_domain`, `invalid_passes` | la conception ne nomme ni l'échec générique ni les refus de validation. |
| Fichiers | `analyze`, `classify`, `remediation`, `store`, `runner`, `routes` | plus `sids.js` et `exportCsv.js` | la validation des SID sert à trois modules, et l'échappement CSV demande ses propres tests. |

## Stockage et Postgres : ce que le code du cœur montre

Une note de la session précédente annonçait des schémas jumeaux `.sqlite.sql` et
`.pg.sql`, `RETURNING id` et un choix d'après le dialecte de la connexion. C'est
la règle des bases **du cœur** (`backend/migrations/`). La base d'extension n'en
offre rien : `backend/src/lib/extensionDb.js` ouvre SQLite par `sqlite3` et
remet une façade à quatre méthodes (`run`, `get`, `all`, `exec`), sans dialecte.
`run` renvoie l'objet `this` de sqlite3. Ce plan en tire trois choix :

- les identifiants viennent de `crypto.randomUUID()`, aucune insertion ne lit
  `lastID` ni `RETURNING` ;
- un seul schéma, en SQL que les deux moteurs acceptent : `TEXT` et `INTEGER`,
  dates ISO en texte, `?`, `INSERT ... ON CONFLICT (...) DO UPDATE` ;
- pas de choix de dialecte tant que le cœur n'en annonce pas.

Une extension ne peut pas charger `sqlite3` (CONTRACT.md, « What an extension
may import »). Les tests utilisent donc `node:sqlite`, présent à partir de
Node 22.5 : ils tournent sur le poste et sont sautés en CI.

## Structure des fichiers

Tout sous `extensions/account-tiering/` :

| Fichier | Rôle |
|---|---|
| `extension.json` | manifeste lu par le chargeur du cœur |
| `store.json` | fiche du catalogue, sans bloc `latest` tant que rien n'est publié |
| `backend/sids.js` | SID cibles, ignorés, trop larges ; `isSid` |
| `backend/classify.js` | règles et corrections vers tier prévu |
| `backend/analyze.js` | faits et tiers prévus vers modèle |
| `backend/remediation.js` | lien d'un chemin vers commande ou section GPMC |
| `backend/exportCsv.js` | modèle vers CSV sans injection de formule |
| `backend/store.js` | tables de l'extension sur `extensionDb` |
| `backend/runner.js` | lancement du collecteur, codes d'erreur |
| `backend/routes.js` | `register(router, context)` |
| `backend/tests/*.test.js` | un fichier par module |
| `backend/tests/facts.js`, `sqliteDb.js`, `fakeCollector.js` | aides de test |

Style du dépôt : `'use strict'`, quatre espaces, un commentaire en tête de
fichier qui dit pourquoi, commentaires en anglais.

### Task 0: La branche

**Files:** aucun.

La branche `feature/account-tiering` existe sur GitHub, au commit de la
conception (`d555eca`), trois commits Deploy derrière `main`. Elle ne porte
aucun commit propre, donc l'avance rapide est sans risque.

Une autre session travaille sur Deploy dans ce même dépôt. Vérifier d'abord
que l'arbre est propre, et ne pas changer de branche sous ses pieds.

- [ ] **Step 1: Check the tree is clean**

Run: `git -C ..\4.6-Aegis.extensions status -sb`
Expected: `## main...origin/main` and no other line.

- [ ] **Step 2: Move to the branch and catch up with main**

```powershell
git switch feature/account-tiering
git merge --ff-only main
```

Expected: `Fast-forward`, then `git log --oneline -1` shows the same commit as `main`.

### Task 1: Le manifeste et la fiche du catalogue

**Files:**
- Create: `extensions/account-tiering/extension.json`
- Create: `extensions/account-tiering/store.json`

Sans `store.json`, `scripts/validate-catalog.mjs` et `scripts/build-index.mjs`
échouent : ils lisent ce fichier dans chaque dossier de `extensions/`. Sans bloc
`latest`, `build-index.mjs` saute l'extension et `index.json` ne change pas.

- [ ] **Step 1: Write the manifest**

`extensions/account-tiering/extension.json`

```json
{
  "id": "account-tiering",
  "name": "Account Tiering",
  "version": 1,
  "release": "0.0.0",
  "page": "account-tiering.html",
  "icon": "users",
  "labelKey": "nav_account_tiering",
  "descKey": "desc_account_tiering",
  "routePrefixes": ["/api/account-tiering"],
  "backend": "backend/routes.js",
  "navSlot": "inventory",
  "requiresHostOptIn": false,
  "signature": null
}
```

- [ ] **Step 2: Write the catalogue entry**

`extensions/account-tiering/store.json`

```json
{
  "id": "account-tiering",
  "name": "Account Tiering",
  "labelKey": "nav_account_tiering",
  "descKey": "desc_account_tiering",
  "icon": "users",
  "page": "account-tiering.html",
  "category": "Compliance",
  "manifestVersion": 1,
  "routePrefixes": ["/api/account-tiering"],
  "requiresHostOptIn": false,
  "channel": "stable"
}
```

- [ ] **Step 3: Check the catalogue still builds the same index**

Run: `node scripts/build-index.mjs; git diff index.json; node scripts/validate-catalog.mjs; git checkout -- index.json`
Expected: `prepared, no release yet: account-tiering, ...`; the only line that
changes in `index.json` is `generatedAt` (the script stamps every run); the
validator prints `catalogue valid`. The checkout drops the timestamp.

- [ ] **Step 4: Commit**

```powershell
git add extensions/account-tiering/extension.json extensions/account-tiering/store.json
git commit -m "feat(account-tiering): manifest and unpublished catalogue entry"
```

### Task 2: Les SID nommés et leur validation

**Files:**
- Create: `extensions/account-tiering/backend/sids.js`
- Test: `extensions/account-tiering/backend/tests/sids.test.js`

- [ ] **Step 1: Write the failing test**

`extensions/account-tiering/backend/tests/sids.test.js`

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { isSid, targetSids, broadSids } = require('../sids');

test('isSid accepts domain SIDs and the well-known SIDs the analysis names', () => {
    for (const ok of ['S-1-5-21-1004336348-1177238915-682003330-512', 'S-1-5-21-1-2-3-4', 'S-1-5-32-544', 'S-1-1-0', 'S-1-5-18']) {
        assert.ok(isSid(ok), ok);
    }
});

test('isSid refuses anything else, including what a route parameter could smuggle', () => {
    const bad = ['S-1-5-21-1-2-3', 'S-1-5-21-1-2-3-4-5', 'S-1-5-21-1-2-3-4\n', 'S-1-5-21-1-2-3-4/../x',
        's-1-5-21-1-2-3-4', 'S-1-5-32-999', '', null, undefined, 42, 'S-1-5-21-12345678901-1-1-1'];
    for (const value of bad) assert.ok(!isSid(value), JSON.stringify(value));
});

test('target and broad SIDs are built under the domain SID', () => {
    const targets = targetSids('S-1-5-21-1-2-3');
    assert.ok(targets.has('S-1-5-21-1-2-3-512'));
    assert.ok(targets.has('S-1-5-32-544'));
    assert.ok(!targets.has('S-1-5-21-1-2-3-513'));
    const broad = broadSids('S-1-5-21-1-2-3');
    assert.ok(broad.has('S-1-5-21-1-2-3-513'));
    assert.ok(broad.has('S-1-5-11'));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test extensions/account-tiering/backend/tests/sids.test.js`
Expected: FAIL, `Cannot find module '../sids'`

- [ ] **Step 3: Write the implementation**

`extensions/account-tiering/backend/sids.js`

```js
/**
 * The SIDs the analysis gives a meaning to, and the one validator every route
 * uses on a SID it receives.
 *
 * Groups are named by SID and never by name: the hosts run French Windows, and
 * "Domain Admins" there is "Admins du domaine". A RID alone (512) is read after
 * the domain SID the facts carry.
 */

'use strict';

/** Domain groups that are Tier 0 by membership, as RIDs under the domain SID. */
const TARGET_RIDS = [512, 516, 518, 519, 520, 526, 527];

/** Builtin groups that are Tier 0 by membership. */
const BUILTIN_TARGETS = ['S-1-5-32-544', 'S-1-5-32-548', 'S-1-5-32-549', 'S-1-5-32-550', 'S-1-5-32-551'];

/** Trustees whose rights say nothing about an account: the system acting on itself. */
const IGNORED = new Set(['S-1-5-18', 'S-1-5-9', 'S-1-5-10', 'S-1-3-0']);

/** Trustees that stand for every account, never expanded into members. */
const BROAD_WELL_KNOWN = ['S-1-1-0', 'S-1-5-11', 'S-1-5-7', 'S-1-5-32-554'];
const BROAD_RIDS = [513, 515];

/** Local groups a GPO can fill that hand control of the machine. */
const LOCAL_GROUPS = new Set(['S-1-5-32-544', 'S-1-5-32-555', 'S-1-5-32-580']);

const WELL_KNOWN = new Set([
    ...BUILTIN_TARGETS, ...IGNORED, ...BROAD_WELL_KNOWN, ...LOCAL_GROUPS
]);

/**
 * A domain SID has exactly four sub-authorities after S-1-5-21. Each part is
 * capped at ten digits because a sub-authority is a 32-bit integer, and the
 * anchors keep a trailing newline or a path out of a route parameter.
 */
const DOMAIN_SID_RE = /^S-1-5-21-\d{1,10}-\d{1,10}-\d{1,10}-\d{1,10}$/;

function isSid(value) {
    return typeof value === 'string' && (DOMAIN_SID_RE.test(value) || WELL_KNOWN.has(value));
}

function targetSids(domainSid) {
    return new Set([...TARGET_RIDS.map((rid) => `${domainSid}-${rid}`), ...BUILTIN_TARGETS]);
}

function broadSids(domainSid) {
    return new Set([...BROAD_WELL_KNOWN, ...BROAD_RIDS.map((rid) => `${domainSid}-${rid}`)]);
}

module.exports = { isSid, targetSids, broadSids, IGNORED, LOCAL_GROUPS };
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test extensions/account-tiering/backend/tests/sids.test.js`
Expected: 3 tests pass

- [ ] **Step 5: Commit**

```powershell
git add extensions/account-tiering/backend/tests/sids.test.js extensions/account-tiering/backend/sids.js
git commit -m "feat(account-tiering): name the SIDs the analysis gives a meaning to"
```


### Task 3: Le jeu de faits des tests

**Files:**
- Create: `extensions/account-tiering/backend/tests/facts.js`

Aucun test propre : ce module construit les faits des tâches 4 à 9. Domaine
`corp.local` et SID inventés (règle : aucune donnée de client dans le code).

- [ ] **Step 1: Write the helper**

```js
/**
 * Builds a facts document for one test case.
 *
 * Every test reads as "this domain, plus these few objects". The domain is the
 * invented corp.local and its SID an invented one, so no fixture names a real
 * directory.
 */

'use strict';

const DOMAIN_SID = 'S-1-5-21-1000-2000-3000';
const sid = (rid) => `${DOMAIN_SID}-${rid}`;
const ROOT_DN = 'DC=corp,DC=local';

function user(rid, sam, extra = {}) {
    return { sid: sid(rid), dn: `CN=${sam},OU=Users,${ROOT_DN}`, sam, name: sam, kind: 'user', enabled: true, primaryGroupRid: 513, ...extra };
}

function group(rid, sam, extra = {}) {
    return { sid: sid(rid), dn: `CN=${sam},OU=Groups,${ROOT_DN}`, sam, name: sam, kind: 'group', enabled: true, ...extra };
}

function facts(parts = {}) {
    return {
        schema: 1,
        domain: 'corp.local',
        domainSid: DOMAIN_SID,
        collectedAt: '2026-10-01T08:00:00Z',
        passes: 3,
        truncated: false,
        principals: [group(512, 'Domain Admins'), ...(parts.principals || [])],
        memberships: parts.memberships || [],
        aces: parts.aces || [],
        gpos: parts.gpos || [],
        tier2Totals: parts.tier2Totals || { users: 0, computers: 0 },
        unreadable: parts.unreadable || [],
        ...(parts.extra || {})
    };
}

module.exports = { DOMAIN_SID, ROOT_DN, sid, user, group, facts };
```

- [ ] **Step 2: Commit**

```powershell
git add extensions/account-tiering/backend/tests/facts.js
git commit -m "test(account-tiering): a facts builder for one case per test"
```


### Task 4: Le tier prévu (classify.js)

**Files:**
- Create: `extensions/account-tiering/backend/classify.js`
- Test: `extensions/account-tiering/backend/tests/classify.test.js`

- [ ] **Step 1: Write the failing test**

`extensions/account-tiering/backend/tests/classify.test.js`

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { classify, ouMatches, globToRegExp } = require('../classify');
const { ROOT_DN, sid, user, group, facts } = require('./facts');

const F = facts({
    principals: [
        group(1100, 'T0-Admins'), group(1101, 'Nested'),
        { ...user(1200, 'alice-adm'), dn: `CN=alice-adm,OU=Admins-T0,${ROOT_DN}` },
        user(1201, 'bob'), user(1202, 'carol')
    ],
    memberships: [
        { group: sid(1100), member: sid(1101), via: 'member' },
        { group: sid(1101), member: sid(1202), via: 'member' }
    ]
});
const rule = (id, position, kind, pattern, tier) => ({ id, position, kind, pattern, tier });

test('each rule kind matches what it should', () => {
    const out = classify(F, [
        rule('ou', 1, 'ou', `OU=Admins-T0,${ROOT_DN}`, 0),
        rule('grp', 2, 'group', sid(1100), 1),
        rule('nm', 3, 'name', 'bo?', 1)
    ], []);
    assert.deepStrictEqual(out.get(sid(1200)), { tier: 0, source: { type: 'rule', ruleId: 'ou' } });
    assert.deepStrictEqual(out.get(sid(1202)), { tier: 1, source: { type: 'rule', ruleId: 'grp' } });
    assert.deepStrictEqual(out.get(sid(1201)), { tier: 1, source: { type: 'rule', ruleId: 'nm' } });
});

test('the first rule by position wins, whatever the array order', () => {
    const out = classify(F, [rule('late', 2, 'name', '*-adm', 1), rule('early', 1, 'name', 'alice*', 0)], []);
    assert.strictEqual(out.get(sid(1200)).source.ruleId, 'early');
});

test('an override beats every rule', () => {
    const out = classify(F, [rule('ou', 1, 'ou', `OU=Admins-T0,${ROOT_DN}`, 0)], [{ sid: sid(1200), tier: 2, reason: 'test' }]);
    assert.deepStrictEqual(out.get(sid(1200)), { tier: 2, source: { type: 'override' } });
});

test('no rule means Tier 2 by default', () => {
    assert.deepStrictEqual(classify(F, [], []).get(sid(1201)), { tier: 2, source: { type: 'default' } });
});

test('ouMatches only on an RDN boundary, case-insensitive', () => {
    const p = `OU=Admins-T0,${ROOT_DN}`;
    assert.ok(ouMatches(`CN=a,OU=Admins-T0,${ROOT_DN}`, p));
    assert.ok(ouMatches(`CN=a,OU=Sub,OU=Admins-T0,${ROOT_DN}`, p.toLowerCase()));
    assert.ok(!ouMatches(`CN=a,OU=XAdmins-T0,${ROOT_DN}`, p));
    assert.ok(!ouMatches('CN=a,OU=Admins-T0,DC=corp,DC=localhost', p));
    assert.ok(!ouMatches(`CN=a,OU=Users,${ROOT_DN}`, p));
});

test('a name glob treats * and ? as wildcards and every other character literally', () => {
    const yes = [['paul-adm', '*-adm'], ['PAUL-ADM', '*-adm'], ['t0-a', 't0-?'], ['a.b', 'a.b'], ['svc(x)', 'svc(x)']];
    const no = [['paul-adm2', '*-adm'], ['paul.adm', '*-adm'], ['t0-ab', 't0-?'], ['axb', 'a.b'], ['xpaul-adm', 'paul-adm']];
    for (const [sam, glob] of yes) assert.ok(globToRegExp(glob).test(sam), `${glob} should match ${sam}`);
    for (const [sam, glob] of no) assert.ok(!globToRegExp(glob).test(sam), `${glob} should not match ${sam}`);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test extensions/account-tiering/backend/tests/classify.test.js`
Expected: FAIL, `Cannot find module '../classify'`

- [ ] **Step 3: Write the implementation**

`extensions/account-tiering/backend/classify.js`

```js
/**
 * The tier each account is meant to have.
 *
 * An override set by hand wins. Otherwise the rules are tried in order and the
 * first that matches gives the tier. An account no rule covers is Tier 2: the
 * safe default, because it makes an unclassified administrator show up as a
 * gap instead of hiding it.
 *
 * Three kinds of rule:
 * - `ou`: the account's DN ends with the pattern, case-insensitive, on an RDN
 *   boundary, so `OU=Admins-T0,...` does not match `OU=XAdmins-T0,...`;
 * - `name`: `sAMAccountName` matches a glob where `*` is any run and `?` one
 *   character, case-insensitive, every other character literal;
 * - `group`: the account is a member of that group SID, directly, through
 *   nested groups, or through its primary group.
 */

'use strict';

function ouMatches(dn, pattern) {
    const d = String(dn || '').toLowerCase();
    const p = String(pattern).toLowerCase();
    return d === p || d.endsWith(',' + p);
}

function globToRegExp(glob) {
    const body = String(glob)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp('^' + body + '$', 'i');
}

/** Every group a principal belongs to, nested membership included, cycles cut. */
function groupsOf(sid, parents, cache) {
    if (cache.has(sid)) return cache.get(sid);
    const found = new Set();
    const stack = [...(parents.get(sid) || [])];
    while (stack.length) {
        const group = stack.pop();
        if (found.has(group)) continue;
        found.add(group);
        for (const next of parents.get(group) || []) stack.push(next);
    }
    cache.set(sid, found);
    return found;
}

/**
 * @param facts      the collected facts (`principals`, `memberships`)
 * @param rules      `[{ id, position, kind, pattern, tier }]`, any order
 * @param overrides  `[{ sid, tier, reason, set_by, set_at }]`
 * @returns Map sid -> `{ tier, source: { type: 'override'|'rule'|'default', ruleId? } }`
 */
function classify(facts, rules, overrides) {
    const parents = new Map();
    for (const m of facts.memberships || []) {
        if (!parents.has(m.member)) parents.set(m.member, []);
        parents.get(m.member).push(m.group);
    }
    const byOverride = new Map((overrides || []).map((o) => [o.sid, o]));
    const ordered = [...(rules || [])].sort((a, b) => a.position - b.position);
    const compiled = ordered.map((rule) => ({
        rule,
        test: rule.kind === 'name' ? globToRegExp(rule.pattern) : null
    }));
    const cache = new Map();

    const out = new Map();
    for (const p of facts.principals || []) {
        const override = byOverride.get(p.sid);
        if (override) {
            out.set(p.sid, { tier: override.tier, source: { type: 'override' } });
            continue;
        }
        const hit = compiled.find(({ rule, test }) => {
            if (rule.kind === 'ou') return ouMatches(p.dn, rule.pattern);
            if (rule.kind === 'name') return test.test(p.sam || '');
            if (rule.kind === 'group') return groupsOf(p.sid, parents, cache).has(rule.pattern);
            return false;
        });
        out.set(p.sid, hit
            ? { tier: hit.rule.tier, source: { type: 'rule', ruleId: hit.rule.id } }
            : { tier: 2, source: { type: 'default' } });
    }
    return out;
}

module.exports = { classify, ouMatches, globToRegExp };
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test extensions/account-tiering/backend/tests/classify.test.js`
Expected: 6 tests pass

- [ ] **Step 5: Commit**

```powershell
git add extensions/account-tiering/backend/tests/classify.test.js extensions/account-tiering/backend/classify.js
git commit -m "feat(account-tiering): planned tier from ordered rules and overrides"
```


### Task 5: L'analyse (analyze.js)

**Files:**
- Create: `extensions/account-tiering/backend/analyze.js`
- Test: `extensions/account-tiering/backend/tests/analyze.test.js`

- [ ] **Step 1: Write the failing test**

`extensions/account-tiering/backend/tests/analyze.test.js`

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { analyze } = require('../analyze');
const { ROOT_DN, sid, user, group, facts } = require('./facts');

const NO_PLAN = new Map();
const account = (model, rid) => model.accounts.find((a) => a.sid === sid(rid));

test('a member of a group nested in Domain Admins is Tier 0, and the path shows the middle group', () => {
    const model = analyze(facts({
        principals: [group(1100, 'IT-Admins'), user(1200, 'alice')],
        memberships: [
            { group: sid(512), member: sid(1100), via: 'member' },
            { group: sid(1100), member: sid(1200), via: 'member' }
        ]
    }), NO_PLAN);
    const alice = account(model, 1200);
    assert.strictEqual(alice.effective, 0);
    assert.deepStrictEqual(alice.path.map((e) => e.to), [sid(1100), sid(512)]);
    assert.strictEqual(alice.status, 'gap');
    assert.strictEqual(alice.severity, 'critical');
});

test('a primary group membership counts like a member entry', () => {
    const model = analyze(facts({
        principals: [user(1200, 'alice', { primaryGroupRid: 512 })],
        memberships: [{ group: sid(512), member: sid(1200), via: 'primaryGroup' }]
    }), NO_PLAN);
    assert.strictEqual(account(model, 1200).effective, 0);
    assert.strictEqual(account(model, 1200).path[0].detail.via, 'primaryGroup');
});

test('a password reset inherited from an OU on a Tier 0 account makes the trustee Tier 0, origin kept', () => {
    const model = analyze(facts({
        principals: [user(1200, 'alice'), user(1300, 'helpdesk')],
        memberships: [{ group: sid(512), member: sid(1200), via: 'member' }],
        aces: [{
            objectDn: `CN=alice,OU=Users,${ROOT_DN}`, objectSid: sid(1200), objectKind: 'account',
            originDn: `OU=Users,${ROOT_DN}`, trustee: sid(1300), right: 'ResetPassword', inherited: true, pass: 2
        }]
    }), NO_PLAN);
    const helpdesk = account(model, 1300);
    assert.strictEqual(helpdesk.effective, 0);
    assert.strictEqual(helpdesk.path[0].detail.originDn, `OU=Users,${ROOT_DN}`);
});

test('DCSync needs both halves on the root for the same trustee', () => {
    const half = (trustee, right) => ({
        objectDn: ROOT_DN, objectSid: null, objectKind: 'domainRoot', originDn: ROOT_DN,
        trustee, right, inherited: false, pass: 1
    });
    const model = analyze(facts({
        principals: [user(1200, 'full'), user(1300, 'half')],
        aces: [
            half(sid(1200), 'DCSyncGetChanges'), half(sid(1200), 'DCSyncGetChangesAll'),
            half(sid(1300), 'DCSyncGetChanges')
        ]
    }), NO_PLAN);
    assert.strictEqual(account(model, 1200).effective, 0);
    assert.strictEqual(account(model, 1200).path[0].detail.right, 'DCSync');
    assert.strictEqual(account(model, 1300).effective, 2);
});

test('GenericWrite on the root alone gives nothing; GenericAll does', () => {
    const ace = (rid, right) => ({
        objectDn: ROOT_DN, objectSid: null, objectKind: 'domainRoot', originDn: ROOT_DN,
        trustee: sid(rid), right, inherited: false, pass: 1
    });
    const model = analyze(facts({
        principals: [user(1200, 'writer'), user(1300, 'owner')],
        aces: [ace(1200, 'GenericWrite'), ace(1300, 'GenericAll')]
    }), NO_PLAN);
    assert.strictEqual(account(model, 1200).effective, 2);
    assert.strictEqual(account(model, 1300).effective, 0);
});

function gpo(guid, links, localGroups = [], editors = []) {
    return { guid, name: 'GPO ' + guid.slice(1, 5), editors, links, localGroups };
}
const G1 = '{11111111-1111-1111-1111-111111111111}';
const serversLink = { somDn: `OU=Servers,${ROOT_DN}`, enforced: false, computers: { dc: 0, server: 4, workstation: 0 } };
const stationsLink = { somDn: `OU=Stations,${ROOT_DN}`, enforced: false, computers: { dc: 0, server: 0, workstation: 90 } };
const dcLink = { somDn: `OU=Domain Controllers,${ROOT_DN}`, enforced: false, computers: { dc: 2, server: 0, workstation: 0 } };
const admins = (rid) => [{ localGroup: 'S-1-5-32-544', members: [sid(rid)], source: 'GptTmpl' }];

test('a GPO local group on servers is Tier 1, on workstations Tier 2, on a DC Tier 0', () => {
    for (const [link, expected] of [[serversLink, 1], [stationsLink, 2], [dcLink, 0]]) {
        const model = analyze(facts({ principals: [user(1200, 'alice')], gpos: [gpo(G1, [link], admins(1200))] }), NO_PLAN);
        assert.strictEqual(account(model, 1200).effective, expected, link.somDn);
        assert.strictEqual(account(model, 1200).path[0].kind, 'gpoLocal');
    }
});

test('editing a GPO linked to the Domain Controllers OU is Tier 0', () => {
    const model = analyze(facts({ principals: [user(1200, 'editor')], gpos: [gpo(G1, [dcLink], [], [sid(1200)])] }), NO_PLAN);
    assert.strictEqual(account(model, 1200).effective, 0);
    assert.strictEqual(account(model, 1200).path[0].kind, 'gpoEdit');
});

test('a broad trustee is a chokepoint listed first, and is not pushed onto accounts', () => {
    const model = analyze(facts({
        principals: [user(1200, 'alice'), group(1100, 'IT-Admins')],
        memberships: [{ group: sid(512), member: sid(1100), via: 'member' }, { group: sid(1100), member: sid(1200), via: 'member' }],
        aces: [{
            objectDn: 'CN=AdminSDHolder,CN=System,' + ROOT_DN, objectSid: null, objectKind: 'adminSdHolder',
            originDn: 'CN=AdminSDHolder,CN=System,' + ROOT_DN, trustee: 'S-1-5-11', right: 'WriteDacl', inherited: false, pass: 1
        }]
    }), NO_PLAN);
    assert.strictEqual(model.chokepoints[0].broad, true);
    assert.strictEqual(model.chokepoints[0].from, 'S-1-5-11');
    assert.ok(model.accounts.every((a) => a.path.every((e) => e.from !== 'S-1-5-11')));
});

test('a three-link chain: ACE on a Tier 1 group held by a member of another group', () => {
    const model = analyze(facts({
        principals: [group(1100, 'ServerAdmins'), group(1101, 'Delegates'), user(1200, 'bob')],
        memberships: [{ group: sid(1101), member: sid(1200), via: 'member' }],
        aces: [{
            objectDn: `CN=ServerAdmins,OU=Groups,${ROOT_DN}`, objectSid: sid(1100), objectKind: 'group',
            originDn: `CN=ServerAdmins,OU=Groups,${ROOT_DN}`, trustee: sid(1101), right: 'WriteMember', inherited: false, pass: 2
        }],
        gpos: [gpo(G1, [serversLink], [{ localGroup: 'S-1-5-32-544', members: [sid(1100)], source: 'GroupsXml' }])]
    }), NO_PLAN);
    const bob = account(model, 1200);
    assert.strictEqual(bob.effective, 1);
    assert.deepStrictEqual(bob.path.map((e) => e.kind), ['membership', 'acl', 'gpoLocal']);
    assert.strictEqual(bob.severity, 'high');
});

test('a truncated scan is reported as such', () => {
    const model = analyze(facts({ extra: { truncated: true } }), NO_PLAN);
    assert.strictEqual(model.scan.truncated, true);
});

test('ignored trustees and Tier 0 members leave no ACE behind', () => {
    const model = analyze(facts({
        principals: [user(1200, 'da')],
        memberships: [{ group: sid(512), member: sid(1200), via: 'member' }],
        aces: [
            { objectDn: ROOT_DN, objectSid: null, objectKind: 'domainRoot', originDn: ROOT_DN, trustee: 'S-1-5-18', right: 'GenericAll', inherited: false, pass: 1 },
            { objectDn: ROOT_DN, objectSid: null, objectKind: 'domainRoot', originDn: ROOT_DN, trustee: sid(512), right: 'GenericAll', inherited: false, pass: 1 },
            { objectDn: ROOT_DN, objectSid: null, objectKind: 'domainRoot', originDn: ROOT_DN, trustee: sid(1200), right: 'WriteDacl', inherited: false, pass: 1 }
        ]
    }), NO_PLAN);
    assert.strictEqual(model.links.filter((l) => l.type === 'acl').length, 0);
    assert.strictEqual(account(model, 1200).path[0].kind, 'membership');
});

test('a membership cycle ends', () => {
    const model = analyze(facts({
        principals: [group(1100, 'A'), group(1101, 'B'), user(1200, 'carol')],
        memberships: [
            { group: sid(1100), member: sid(1101), via: 'member' },
            { group: sid(1101), member: sid(1100), via: 'member' },
            { group: sid(1100), member: sid(1200), via: 'member' }
        ]
    }), NO_PLAN);
    assert.strictEqual(account(model, 1200).effective, 2);
    assert.deepStrictEqual(account(model, 1200).path, []);
});

test('DnsAdmins is a Tier 0 target, found by name', () => {
    const model = analyze(facts({
        principals: [group(1101, 'DnsAdmins'), user(1200, 'dns')],
        memberships: [{ group: sid(1101), member: sid(1200), via: 'member' }]
    }), NO_PLAN);
    assert.strictEqual(account(model, 1200).effective, 0);
});

test('planned tier against effective tier: gap, ok, below, matrix and uncollected totals', () => {
    const planned = new Map([
        [sid(1200), { tier: 0, source: { type: 'rule', ruleId: 'r1' } }],
        [sid(1300), { tier: 0, source: { type: 'override' } }]
    ]);
    const model = analyze(facts({
        principals: [user(1200, 'da'), user(1300, 'idle')],
        memberships: [{ group: sid(512), member: sid(1200), via: 'member' }],
        tier2Totals: { users: 10, computers: 5 }
    }), planned);
    assert.strictEqual(account(model, 1200).status, 'ok');
    assert.strictEqual(account(model, 1300).status, 'below');
    assert.deepStrictEqual(model.matrix, [[1, 0, 1], [0, 0, 0], [0, 0, 15]]);
    assert.strictEqual(model.keyFigures.accounts, 17);
    assert.deepStrictEqual(model.keyFigures.byEffective, [1, 0, 16]);
});

test('an unknown schema is refused with facts_schema', () => {
    assert.throws(() => analyze({ schema: 2 }, NO_PLAN), (e) => e.code === 'facts_schema');
});

test('a chokepoint counts the exposed accounts and the gaps through it', () => {
    const model = analyze(facts({
        principals: [group(1100, 'IT-Admins'), user(1200, 'a'), user(1201, 'b')],
        memberships: [
            { group: sid(512), member: sid(1100), via: 'member' },
            { group: sid(1100), member: sid(1200), via: 'member' },
            { group: sid(1100), member: sid(1201), via: 'member' }
        ]
    }), new Map([[sid(1200), { tier: 0, source: { type: 'override' } }]]));
    const point = model.chokepoints.find((p) => p.key === 'group:' + sid(1100));
    assert.strictEqual(point.exposed.length, 2);
    assert.deepStrictEqual(point.gaps, [sid(1201)]);
});

test('the proposed-remediation marker is carried onto the account', () => {
    const model = analyze(facts({ principals: [user(1200, 'a')] }), NO_PLAN, { remediations: new Set([sid(1200)]) });
    assert.strictEqual(account(model, 1200).remediationProposed, true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test extensions/account-tiering/backend/tests/analyze.test.js`
Expected: FAIL, `Cannot find module '../analyze'`

- [ ] **Step 3: Write the implementation**

`extensions/account-tiering/backend/analyze.js`

```js
/**
 * Facts plus planned tiers in, the model the page draws out.
 *
 * The facts are a graph. Every mechanism is an edge from the principal that
 * holds it to the thing it controls: a member to its group, an ACE trustee to
 * the object, a GPO editor to the GPO, a GPO's local-group member to the
 * machines it lands on. A few nodes start with a tier (the Tier 0 groups, the
 * domain root, AdminSDHolder, the Domain Controllers OU, each GPO by where it
 * is linked). Then the rule "whoever controls a tier-N thing is tier N" runs to
 * a fixed point. Tiers only go down and there are three, so it ends fast.
 *
 * For each node the edge that last lowered its tier is kept. Following those
 * edges from an account back to a seed is the "why Tier N" path the page shows,
 * intermediate groups included.
 *
 * Two families of trustee get special handling:
 * - ignored (SYSTEM, Enterprise DCs, SELF, CREATOR OWNER), and any trustee
 *   already Tier 0 by membership alone: their ACEs are dropped, otherwise every
 *   path would run through Domain Admins' own rights;
 * - broad (Everyone, Authenticated Users, Domain Users...): kept as one node
 *   each and listed first among the chokepoints, never pushed onto accounts,
 *   because the collector does not read the unprivileged accounts they cover.
 *
 * Nothing here reads a clock, a file or the network: same input, same model.
 */

'use strict';

const { targetSids, broadSids, IGNORED, LOCAL_GROUPS } = require('./sids');

const SCHEMA = 1;
const INF = 3;

const ACL_RIGHTS = new Set(['GenericAll', 'GenericWrite', 'WriteDacl', 'WriteOwner', 'ResetPassword', 'WriteMember']);
const ROOT_RIGHTS = new Set(['GenericAll', 'WriteDacl', 'WriteOwner']);
const DCSYNC_HALVES = ['DCSyncGetChanges', 'DCSyncGetChangesAll'];

const ACCOUNT_KINDS = new Set(['user', 'computer', 'gmsa']);

function factsError(message) {
    const error = new Error(message);
    error.code = 'facts_schema';
    return error;
}

function rootDnOf(domain) {
    return 'DC=' + String(domain).split('.').join(',DC=');
}

function sameDn(a, b) {
    return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function guidFromDn(dn) {
    const match = /CN=(\{[0-9a-f-]{36}\})/i.exec(String(dn || ''));
    return match ? match[1].toLowerCase() : null;
}

/** Most privileged class of machine a link reaches: DC 0, server 1, workstation 2. */
function linkTier(link) {
    const c = link.computers || {};
    if (c.dc > 0) return 0;
    if (c.server > 0) return 1;
    if (c.workstation > 0) return 2;
    return INF;
}

function analyze(facts, planned, options = {}) {
    if (!facts || facts.schema !== SCHEMA) throw factsError(`unknown facts schema ${facts && facts.schema}`);
    const proposed = options.remediations || new Set();

    const principals = new Map((facts.principals || []).map((p) => [p.sid, p]));
    const targets = targetSids(facts.domainSid);
    for (const p of principals.values()) {
        // DnsAdmins has no fixed RID, so the collector finds it by name.
        if (p.kind === 'group' && String(p.sam).toLowerCase() === 'dnsadmins') targets.add(p.sid);
    }
    const broad = broadSids(facts.domainSid);
    const rootDn = rootDnOf(facts.domain);
    const dcOuDn = 'OU=Domain Controllers,' + rootDn;

    const seeds = new Map();
    const labels = new Map([['root', facts.domain], ['adminSdHolder', 'AdminSDHolder'], ['dcOu', 'Domain Controllers']]);
    for (const sid of targets) seeds.set(sid, 0);
    for (const key of ['root', 'adminSdHolder', 'dcOu']) seeds.set(key, 0);

    const gpos = new Map();
    for (const gpo of facts.gpos || []) {
        const guid = String(gpo.guid).toLowerCase();
        gpos.set(guid, gpo);
        const local = Math.min(INF, ...(gpo.links || []).map(linkTier));
        const top = (gpo.links || []).some((l) => sameDn(l.somDn, rootDn) || sameDn(l.somDn, dcOuDn));
        seeds.set('gpo:' + guid, top ? 0 : local);
        seeds.set('gpolocal:' + guid, local);
        labels.set('gpo:' + guid, gpo.name);
        labels.set('gpolocal:' + guid, gpo.name);
    }

    const membershipEdges = (facts.memberships || []).map((m) => ({
        from: m.member, to: m.group, kind: 'membership', detail: { via: m.via }
    }));

    // Tier 0 by membership alone, to know whose ACEs to drop.
    const byMembership = fixedPoint(seeds, membershipEdges).tier;

    const controlEdges = [];
    const dcsync = new Map();
    for (const ace of facts.aces || []) {
        const trustee = ace.trustee;
        if (IGNORED.has(trustee) || byMembership.get(trustee) === 0) continue;
        if (DCSYNC_HALVES.includes(ace.right)) {
            if (ace.objectKind !== 'domainRoot') continue;
            if (!dcsync.has(trustee)) dcsync.set(trustee, new Map());
            dcsync.get(trustee).set(ace.right, ace);
            continue;
        }
        if (!ACL_RIGHTS.has(ace.right)) continue;
        const to = aceTarget(ace);
        if (!to) continue;
        controlEdges.push({ from: trustee, to, kind: 'acl', detail: aceDetail(ace) });
    }
    for (const [trustee, halves] of dcsync) {
        if (DCSYNC_HALVES.every((h) => halves.has(h))) {
            controlEdges.push({
                from: trustee, to: 'root', kind: 'acl',
                detail: { right: 'DCSync', objectDn: rootDn, originDn: rootDn, inherited: false }
            });
        }
    }
    for (const [guid, gpo] of gpos) {
        for (const editor of gpo.editors || []) {
            if (IGNORED.has(editor) || byMembership.get(editor) === 0) continue;
            controlEdges.push({ from: editor, to: 'gpo:' + guid, kind: 'gpoEdit', detail: { gpo: guid } });
        }
        for (const lg of gpo.localGroups || []) {
            if (!LOCAL_GROUPS.has(lg.localGroup)) continue;
            for (const member of lg.members || []) {
                controlEdges.push({
                    from: member, to: 'gpolocal:' + guid, kind: 'gpoLocal',
                    detail: { gpo: guid, localGroup: lg.localGroup, source: lg.source }
                });
            }
        }
    }

    const edges = [...membershipEdges, ...controlEdges];
    const { tier, best } = fixedPoint(seeds, edges);

    const accounts = [];
    for (const p of principals.values()) {
        if (!ACCOUNT_KINDS.has(p.kind)) continue;
        const effective = tier.has(p.sid) && tier.get(p.sid) < INF ? tier.get(p.sid) : 2;
        const plan = planned.get(p.sid) || { tier: 2, source: { type: 'default' } };
        accounts.push({
            sid: p.sid, sam: p.sam, name: p.name, dn: p.dn, kind: p.kind, enabled: p.enabled,
            planned: plan.tier, plannedSource: plan.source, effective,
            ...status(effective, plan.tier),
            path: pathOf(p.sid, best),
            remediationProposed: proposed.has(p.sid)
        });
    }
    accounts.sort((a, b) => a.effective - b.effective || String(a.sam).localeCompare(String(b.sam)));

    const groups = [...principals.values()]
        .filter((p) => p.kind === 'group')
        .map((p) => ({ sid: p.sid, sam: p.sam, name: p.name, dn: p.dn, tier: tierOr(tier, p.sid), broad: broad.has(p.sid) }));

    const objects = [...labels.entries()].map(([key, label]) => ({ key, label, tier: tierOr(tier, key) }));

    const links = edges.map((e) => ({
        from: e.from, to: e.to,
        type: e.kind === 'membership' ? 'membership' : (e.kind === 'acl' ? 'acl' : 'gpo'),
        kind: e.kind, detail: e.detail
    }));

    const tier2 = facts.tier2Totals || { users: 0, computers: 0 };
    const uncollected = (tier2.users || 0) + (tier2.computers || 0);
    const matrix = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const a of accounts) matrix[a.planned][a.effective] += 1;
    matrix[2][2] += uncollected;

    const chokepoints = chokepointsOf(accounts, edges, tier, broad);

    return {
        scan: {
            domain: facts.domain, domainSid: facts.domainSid, collectedAt: facts.collectedAt,
            passes: facts.passes, truncated: Boolean(facts.truncated), unreadable: facts.unreadable || []
        },
        accounts, groups, objects, links, chokepoints, matrix,
        keyFigures: {
            accounts: accounts.length + uncollected,
            byEffective: [0, 1, 2].map((t) => accounts.filter((a) => a.effective === t).length + (t === 2 ? uncollected : 0)),
            gapsCritical: accounts.filter((a) => a.severity === 'critical').length,
            gapsHigh: accounts.filter((a) => a.severity === 'high').length,
            chokepoints: chokepoints.length
        }
    };

    function aceTarget(ace) {
        switch (ace.objectKind) {
            case 'domainRoot': return ROOT_RIGHTS.has(ace.right) ? 'root' : null;
            case 'adminSdHolder': return 'adminSdHolder';
            case 'dcOu': return 'dcOu';
            case 'gpo': {
                const guid = guidFromDn(ace.objectDn);
                return guid && gpos.has(guid) ? 'gpo:' + guid : null;
            }
            case 'group':
            case 'account': return ace.objectSid || null;
            default: return null;
        }
    }
}

function aceDetail(ace) {
    return { right: ace.right, objectDn: ace.objectDn, originDn: ace.originDn || ace.objectDn, inherited: Boolean(ace.inherited) };
}

function tierOr(tier, key) {
    return tier.has(key) && tier.get(key) < INF ? tier.get(key) : null;
}

function status(effective, planned) {
    if (effective < planned) return { status: 'gap', severity: effective === 0 ? 'critical' : 'high' };
    if (effective > planned) return { status: 'below', severity: null };
    return { status: 'ok', severity: null };
}

/** Whoever controls a tier-N node becomes tier N, until nothing moves. */
function fixedPoint(seeds, edges) {
    const tier = new Map(seeds);
    const best = new Map();
    let changed = true;
    while (changed) {
        changed = false;
        for (const edge of edges) {
            const reach = tier.has(edge.to) ? tier.get(edge.to) : INF;
            const own = tier.has(edge.from) ? tier.get(edge.from) : INF;
            if (reach < own) {
                tier.set(edge.from, reach);
                best.set(edge.from, edge);
                changed = true;
            }
        }
    }
    return { tier, best };
}

function pathOf(sid, best) {
    const path = [];
    const seen = new Set([sid]);
    let edge = best.get(sid);
    while (edge && !seen.has(edge.to)) {
        path.push({ from: edge.from, to: edge.to, kind: edge.kind, detail: edge.detail });
        seen.add(edge.to);
        edge = best.get(edge.to);
    }
    return path;
}

function chokepointKey(edge) {
    if (edge.kind === 'membership') return 'group:' + edge.to;
    return `${edge.kind}:${edge.from}:${edge.to}:${edge.detail.right || edge.detail.localGroup || ''}`;
}

function chokepointsOf(accounts, edges, tier, broad) {
    const points = new Map();
    const touch = (edge, broadPoint) => {
        const key = chokepointKey(edge);
        if (!points.has(key)) {
            points.set(key, {
                key, kind: edge.kind, from: edge.from, to: edge.to, detail: edge.detail,
                tier: tierOr(tier, edge.to), broad: broadPoint, exposed: new Set(), gaps: new Set()
            });
        }
        return points.get(key);
    };
    for (const a of accounts) {
        for (const edge of a.path) {
            const point = touch(edge, false);
            point.exposed.add(a.sid);
            if (a.status === 'gap') point.gaps.add(a.sid);
        }
    }
    for (const edge of edges) {
        if (edge.kind !== 'membership' && broad.has(edge.from) && tierOr(tier, edge.to) !== null) touch(edge, true).broad = true;
    }
    return [...points.values()]
        .map((p) => ({ ...p, exposed: [...p.exposed], gaps: [...p.gaps] }))
        .sort((a, b) => (b.broad - a.broad) || (b.gaps.length - a.gaps.length)
            || (b.exposed.length - a.exposed.length) || a.key.localeCompare(b.key));
}

module.exports = { analyze, SCHEMA };
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test extensions/account-tiering/backend/tests/analyze.test.js`
Expected: 17 tests pass

- [ ] **Step 5: Commit**

```powershell
git add extensions/account-tiering/backend/tests/analyze.test.js extensions/account-tiering/backend/analyze.js
git commit -m "feat(account-tiering): effective tier by fixed point over the facts graph"
```

- [ ] **Step 6: Prove the tests can go red**

Two mutations, one at a time, each reverted right after:

1. In `analyze.js`, replace `DCSYNC_HALVES.every((h)` with `DCSYNC_HALVES.some((h)`.
   Expected: `DCSync needs both halves on the root for the same trustee` fails.
2. Delete the line `if (IGNORED.has(trustee) || byMembership.get(trustee) === 0) continue;`.
   Expected: `ignored trustees and Tier 0 members leave no ACE behind` fails.

Restore the file (`git checkout -- extensions/account-tiering/backend/analyze.js`) and rerun: 17 pass.


### Task 6: La remédiation affichée et l'export CSV

**Files:**
- Create: `extensions/account-tiering/backend/remediation.js`
- Create: `extensions/account-tiering/backend/exportCsv.js`
- Test: `extensions/account-tiering/backend/tests/remediation.test.js`

- [ ] **Step 1: Write the failing test**

`extensions/account-tiering/backend/tests/remediation.test.js`

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { remediationFor, psQuote } = require('../remediation');
const { toCsv, csvCell } = require('../exportCsv');
const { ROOT_DN, sid, user, group, facts } = require('./facts');

const F = facts({
    principals: [group(1100, "IT-Admins"), user(1200, "o'brien"), { ...user(1300, 'pc01$'), kind: 'computer' }],
    gpos: [{ guid: '{11111111-1111-1111-1111-111111111111}', name: 'Serveurs - admins', editors: [], links: [], localGroups: [] }]
});

test('a membership link gives Remove-ADGroupMember with both names quoted', () => {
    const r = remediationFor({ from: sid(1200), to: sid(1100), kind: 'membership', detail: { via: 'member' } }, F);
    assert.strictEqual(r.command, "Remove-ADGroupMember -Identity 'IT-Admins' -Members 'o''brien'");
});

test('a primary group link resets primaryGroupID to the default for the kind', () => {
    const u = remediationFor({ from: sid(1200), to: sid(512), kind: 'membership', detail: { via: 'primaryGroup' } }, F);
    assert.match(u.command, /primaryGroupID=513\}$/);
    const c = remediationFor({ from: sid(1300), to: sid(512), kind: 'membership', detail: { via: 'primaryGroup' } }, F);
    assert.match(c.command, /primaryGroupID=515\}$/);
    assert.strictEqual(c.warning, 'primary_group');
});

test('an ACE link gives dsacls on the origin DN, with the warning', () => {
    const r = remediationFor({
        from: sid(1200), to: sid(1100), kind: 'acl',
        detail: { right: 'WriteMember', objectDn: 'CN=x,' + ROOT_DN, originDn: 'OU=Groups,' + ROOT_DN, inherited: true }
    }, F);
    assert.strictEqual(r.command, `dsacls 'OU=Groups,${ROOT_DN}' /R 'CORP\\o''brien'`);
    assert.strictEqual(r.warning, 'removes_all_aces');
});

test('GPO links give a console section, not a command', () => {
    const g = '{11111111-1111-1111-1111-111111111111}';
    assert.deepStrictEqual(
        remediationFor({ from: sid(1200), to: 'gpo:' + g, kind: 'gpoEdit', detail: { gpo: g } }, F),
        { mechanism: 'gpoEdit', gpo: 'Serveurs - admins', section: 'delegation' });
    const local = remediationFor({ from: sid(1200), to: 'gpolocal:' + g, kind: 'gpoLocal', detail: { gpo: g, localGroup: 'S-1-5-32-544', source: 'GroupsXml' } }, F);
    assert.strictEqual(local.section, 'localUsersAndGroups');
});

test('psQuote doubles straight and curly single quotes and leaves the rest alone', () => {
    const cases = [
        ['Admins du domaine', "'Admins du domaine'"],
        ["O'Brien", "'O''Brien'"],
        ['O’Brien', "'O’’Brien'"],
        ['‘x‛', "'‘‘x‛‛'"],
        ['a$b`c"d', "'a$b`c\"d'"],
        ['', "''"]
    ];
    for (const [input, expected] of cases) assert.strictEqual(psQuote(input), expected, input);
});

test('csvCell neutralises formulas, quotes separators, and leaves plain values alone', () => {
    const cases = [
        ['=cmd|calc', "'=cmd|calc"], ['+1', "'+1"], ['-1', "'-1"], ['@x', "'@x"],
        ['a,b', '"a,b"'], ['a;b', '"a;b"'], ['a"b', '"a""b"'], ['CN=x,OU=y', '"CN=x,OU=y"'],
        ['paul', 'paul'], [0, '0'], [null, ''], ['S-1-5-21-1-2-3-4', 'S-1-5-21-1-2-3-4'], ['été', 'été']
    ];
    for (const [input, expected] of cases) assert.strictEqual(csvCell(input), expected, String(input));
});

test('toCsv writes a BOM, a header and one row per account', () => {
    const csv = toCsv({ accounts: [{ sid: sid(1200), sam: '=evil', name: 'x', kind: 'user', enabled: true, planned: 2, effective: 0, status: 'gap', severity: 'critical', path: [{ kind: 'membership', to: sid(512) }], remediationProposed: false }] });
    const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
    assert.ok(csv.startsWith('﻿'));
    assert.strictEqual(lines.length, 2);
    assert.ok(lines[1].includes(",'=evil,"));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test extensions/account-tiering/backend/tests/remediation.test.js`
Expected: FAIL, `Cannot find module '../remediation'`

- [ ] **Step 3: Write the implementation**

`extensions/account-tiering/backend/remediation.js`

```js
/**
 * The step that cuts one link of a path, as text to copy. Nothing here runs.
 *
 * A command is built from names read out of the directory, and an AD name may
 * hold an apostrophe. Every value goes through `psQuote`, which wraps it in
 * single quotes and doubles any quote inside. PowerShell also reads the curly
 * quotes U+2018 to U+201B as single quotes, so those are doubled too: a name
 * typed in Word with "O’Brien" would otherwise close the string early.
 *
 * GPO steps are not commands: a GPO is fixed in the management console. They
 * come back as a GPO name plus a section code, and the page translates the
 * section, so this file emits no French or English prose.
 */

'use strict';

const PRIMARY_DEFAULT = { user: 513, gmsa: 515, computer: 515 };

function psQuote(value) {
    return "'" + String(value).replace(/['‘’‚‛]/g, '$&$&') + "'";
}

function netbiosOf(facts) {
    return facts.netbios || String(facts.domain).split('.')[0].toUpperCase();
}

/**
 * @param edge  one link of an account's path (`from`, `to`, `kind`, `detail`)
 * @param facts the facts the model came from, for names, DNs and GPOs
 * @returns `{ mechanism, command?, gpo?, section?, warning? }`
 */
function remediationFor(edge, facts) {
    const principals = new Map((facts.principals || []).map((p) => [p.sid, p]));
    const nameOf = (sid) => {
        const p = principals.get(sid);
        return p ? (p.sam || p.name || sid) : sid;
    };

    if (edge.kind === 'membership' && edge.detail.via === 'primaryGroup') {
        const member = principals.get(edge.from) || {};
        const rid = PRIMARY_DEFAULT[member.kind] || 513;
        return {
            mechanism: 'primaryGroup',
            command: `Set-ADObject -Identity ${psQuote(member.dn || edge.from)} -Replace @{primaryGroupID=${rid}}`,
            warning: 'primary_group'
        };
    }
    if (edge.kind === 'membership') {
        return {
            mechanism: 'membership',
            command: `Remove-ADGroupMember -Identity ${psQuote(nameOf(edge.to))} -Members ${psQuote(nameOf(edge.from))}`
        };
    }
    if (edge.kind === 'acl') {
        const dn = edge.detail.originDn || edge.detail.objectDn;
        return {
            mechanism: 'acl',
            command: `dsacls ${psQuote(dn)} /R ${psQuote(netbiosOf(facts) + '\\' + nameOf(edge.from))}`,
            warning: 'removes_all_aces'
        };
    }
    const gpo = (facts.gpos || []).find((g) => String(g.guid).toLowerCase() === edge.detail.gpo);
    const gpoName = gpo ? gpo.name : edge.detail.gpo;
    if (edge.kind === 'gpoEdit') {
        return { mechanism: 'gpoEdit', gpo: gpoName, section: 'delegation' };
    }
    if (edge.kind === 'gpoLocal') {
        return {
            mechanism: 'gpoLocal', gpo: gpoName, localGroup: edge.detail.localGroup,
            section: edge.detail.source === 'GptTmpl' ? 'restrictedGroups' : 'localUsersAndGroups'
        };
    }
    return { mechanism: edge.kind };
}

module.exports = { remediationFor, psQuote };
```

`extensions/account-tiering/backend/exportCsv.js`

```js
/**
 * The model's accounts as CSV, one row per account.
 *
 * The file opens in Excel, and Excel runs a cell that starts with `=`, `+`,
 * `-` or `@` as a formula. Account names come from the directory, where anyone
 * allowed to create an account picks the name, so a leading quote neutralises
 * those cells. The separator is a comma, and a cell holding a comma, a
 * semicolon (the French Excel separator), a quote or a line break is quoted.
 */

'use strict';

const COLUMNS = ['sid', 'sam', 'name', 'kind', 'enabled', 'planned', 'effective', 'status', 'severity', 'path', 'remediationProposed'];

function csvCell(value) {
    let s = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function pathText(path) {
    return path.map((e) => `${e.kind}>${e.to}`).join(' | ');
}

function toCsv(model) {
    const rows = [COLUMNS.join(',')];
    for (const a of model.accounts) {
        rows.push(COLUMNS.map((c) => csvCell(c === 'path' ? pathText(a.path) : a[c])).join(','));
    }
    // A BOM so Excel reads the file as UTF-8 and keeps the accents in names.
    return '﻿' + rows.join('\r\n') + '\r\n';
}

module.exports = { toCsv, csvCell };
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test extensions/account-tiering/backend/tests/remediation.test.js`
Expected: 7 tests pass

- [ ] **Step 5: Commit**

```powershell
git add extensions/account-tiering/backend/tests/remediation.test.js extensions/account-tiering/backend/remediation.js extensions/account-tiering/backend/exportCsv.js
git commit -m "feat(account-tiering): remediation commands to copy, CSV export"
```


### Task 7: Le stockage (store.js)

**Files:**
- Create: `extensions/account-tiering/backend/tests/sqliteDb.js`
- Create: `extensions/account-tiering/backend/store.js`
- Test: `extensions/account-tiering/backend/tests/store.test.js`

Les tests de cette tâche tournent sur `node:sqlite` (Node 22.5 et plus). En CI,
Node 20.19.1, ils sont sautés avec leur raison. C'est attendu, pas un échec.

- [ ] **Step 1: Write the test adapter**

`extensions/account-tiering/backend/tests/sqliteDb.js`

```js
/**
 * A real SQLite handle shaped like the one `extensionDb` hands over, for tests.
 *
 * Core opens extension databases with the `sqlite3` package, which an
 * extension may not require. `node:sqlite` ships with Node 22.5 and later, so
 * on a developer machine the store runs against a real engine. This
 * repository's CI pins Node 20.19.1, which has no `node:sqlite`: there
 * `available` is false and the tests that need it skip with that reason, and
 * the pure modules keep their coverage.
 */

'use strict';

let DatabaseSync = null;
try {
    ({ DatabaseSync } = require('node:sqlite'));
} catch (_) {
    DatabaseSync = null;
}

const available = DatabaseSync !== null;
const why = available ? null : `node:sqlite needs Node 22.5 or later, this is ${process.version}`;

/** An in-memory database with core's facade: async `run`, `get`, `all`, `exec`. */
function openMemoryDb() {
    const raw = new DatabaseSync(':memory:');
    const bind = (params) => (params || []).map((v) => (v === undefined ? null : v));
    return Object.freeze({
        async run(sql, params) {
            const r = raw.prepare(sql).run(...bind(params));
            return { lastID: Number(r.lastInsertRowid), changes: Number(r.changes) };
        },
        async get(sql, params) { return raw.prepare(sql).get(...bind(params)); },
        async all(sql, params) { return raw.prepare(sql).all(...bind(params)); },
        async exec(sql) { raw.exec(sql); }
    });
}

module.exports = { available, why, openMemoryDb };
```

- [ ] **Step 2: Write the failing test**

`extensions/account-tiering/backend/tests/store.test.js`

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const sqlite = require('./sqliteDb');
const store = require('../store');

const opts = { skip: sqlite.why || false };

async function fresh() {
    const db = sqlite.openMemoryDb();
    await store.ensure(db);
    return db;
}

test('a scan runs, finishes, and its facts come back', opts, async () => {
    const db = await fresh();
    const id = await store.startScan(db, 'corp.local');
    assert.strictEqual((await store.runningScan(db)).id, id);
    await store.finishScan(db, id, { status: 'ok', facts: { schema: 1 } });
    assert.strictEqual(await store.runningScan(db), undefined);
    assert.deepStrictEqual(await store.latestFacts(db), { id, facts: { schema: 1 } });
});

test('a failed scan is not shown as facts', opts, async () => {
    const db = await fresh();
    const id = await store.startScan(db, null);
    await store.finishScan(db, id, { status: 'failed', errorCode: 'domain_unreachable' });
    assert.strictEqual(await store.latestFacts(db), null);
    assert.strictEqual((await store.latestScan(db)).error_code, 'domain_unreachable');
});

test('only the last five scans are kept', opts, async () => {
    const db = await fresh();
    for (let i = 0; i < 7; i += 1) {
        const id = await store.startScan(db, null);
        await store.finishScan(db, id, { status: 'ok', facts: { schema: 1, i } });
    }
    const { n } = await db.get('SELECT COUNT(*) AS n FROM scans');
    assert.strictEqual(n, store.KEEP_SCANS);
});

test('a running row left by a stopped service becomes scan_interrupted on the next open', opts, async () => {
    const db = sqlite.openMemoryDb();
    await db.exec("CREATE TABLE scans (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, error_code TEXT, domain TEXT, facts_json TEXT)");
    await db.run("INSERT INTO scans (id, started_at, status) VALUES ('old', '2026-01-01T00:00:00Z', 'running')");
    await store.ensure(db);
    const row = await db.get("SELECT status, error_code FROM scans WHERE id = 'old'");
    assert.deepStrictEqual({ ...row }, { status: 'failed', error_code: 'scan_interrupted' });
});

test('a scan running in this process survives a reopened handle', opts, async () => {
    const first = await fresh();
    const id = await store.startScan(first, null);
    const raw = await first.all('SELECT * FROM scans');
    const second = sqlite.openMemoryDb();
    await second.exec("CREATE TABLE scans (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, error_code TEXT, domain TEXT, facts_json TEXT)");
    for (const r of raw) await second.run('INSERT INTO scans (id, started_at, status) VALUES (?, ?, ?)', [r.id, r.started_at, r.status]);
    await store.ensure(second);
    assert.strictEqual((await second.get('SELECT status FROM scans WHERE id = ?', [id])).status, 'running');
    await store.finishScan(first, id, { status: 'failed', errorCode: 'x' });
});

test('rules are replaced as a whole, in the order given', opts, async () => {
    const db = await fresh();
    await store.replaceRules(db, [{ kind: 'name', pattern: '*-adm', tier: 0 }, { kind: 'ou', pattern: 'OU=X,DC=corp,DC=local', tier: 1 }], 'ops@corp.local');
    await store.replaceRules(db, [{ kind: 'name', pattern: 'svc-*', tier: 1 }], 'ops@corp.local');
    const rules = await store.getRules(db);
    assert.deepStrictEqual(rules.map((r) => [r.position, r.pattern]), [[0, 'svc-*']]);
});

test('a failing rule replacement leaves the old rules in place', opts, async () => {
    const db = await fresh();
    await store.replaceRules(db, [{ kind: 'name', pattern: 'keep', tier: 0 }], null);
    await assert.rejects(store.replaceRules(db, [{ kind: 'name', pattern: null, tier: 0 }], null));
    assert.deepStrictEqual((await store.getRules(db)).map((r) => r.pattern), ['keep']);
});

test('overrides, remediations and settings round-trip', opts, async () => {
    const db = await fresh();
    await store.setOverride(db, 'S-1-5-21-1-2-3-1200', { tier: 0, reason: 'admin', by: 'a' });
    await store.setOverride(db, 'S-1-5-21-1-2-3-1200', { tier: 1, reason: 'changed', by: 'b' });
    assert.deepStrictEqual((await store.getOverrides(db)).map((o) => [o.tier, o.reason]), [[1, 'changed']]);
    await store.deleteOverride(db, 'S-1-5-21-1-2-3-1200');
    assert.deepStrictEqual(await store.getOverrides(db), []);

    await store.markRemediation(db, 'S-1-5-21-1-2-3-1200', 'a');
    await store.markRemediation(db, 'S-1-5-21-1-2-3-1200', 'a');
    assert.strictEqual((await store.getRemediations(db)).length, 1);

    assert.deepStrictEqual(await store.getSettings(db), { domain: null, passes: 3 });
    await store.putSettings(db, { domain: 'corp.local', passes: 4 });
    assert.deepStrictEqual(await store.getSettings(db), { domain: 'corp.local', passes: 4 });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node --test extensions/account-tiering/backend/tests/store.test.js`
Expected: FAIL, `Cannot find module '../store'`

- [ ] **Step 4: Write the implementation**

`extensions/account-tiering/backend/store.js`

```js
/**
 * The extension's tables, in the per-tenant database core hands over.
 *
 * `extensionDb.withRequest(req, fn)` gives `fn` a handle with `run`, `get`,
 * `all` and `exec`, opened on `<tenant data>/extensions/account-tiering/
 * extension.db`. Today that is SQLite through the `sqlite3` package. Core runs
 * its own databases on Postgres in tests and may hand an extension Postgres one
 * day, so the SQL here is the subset both accept:
 * - `?` placeholders, which core's Postgres driver rewrites;
 * - ids minted with `crypto.randomUUID()` rather than read back from
 *   `lastID` or `RETURNING`, so no insert depends on the engine;
 * - `TEXT` and `INTEGER` columns only, ISO-8601 timestamps as text;
 * - `INSERT ... ON CONFLICT (...) DO UPDATE`, which both engines know.
 *
 * The schema is created on the first use of each handle. A handle is cached by
 * core and may be evicted and reopened, so "first use" can happen while a scan
 * runs in this process: `activeScans` keeps that scan from being marked as
 * interrupted. A `running` row nobody in this process owns is left over from a
 * service that stopped mid-scan.
 */

'use strict';

const crypto = require('crypto');

const KEEP_SCANS = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scans (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    error_code TEXT,
    domain TEXT,
    facts_json TEXT
);
CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL,
    pattern TEXT NOT NULL,
    tier INTEGER NOT NULL,
    created_by TEXT,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS overrides (
    sid TEXT PRIMARY KEY,
    tier INTEGER NOT NULL,
    reason TEXT NOT NULL,
    set_by TEXT,
    set_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS remediations (
    sid TEXT PRIMARY KEY,
    proposed_by TEXT,
    proposed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
`;

const ready = new WeakSet();
const writing = new WeakMap();
const activeScans = new Set();

const now = () => new Date().toISOString();

async function ensure(db) {
    if (ready.has(db)) return;
    await db.exec(SCHEMA);
    const active = [...activeScans];
    const notActive = active.length ? ` AND id NOT IN (${active.map(() => '?').join(', ')})` : '';
    await db.run(
        `UPDATE scans SET status = 'failed', error_code = 'scan_interrupted', finished_at = ? WHERE status = 'running'${notActive}`,
        [now(), ...active]
    );
    ready.add(db);
}

/**
 * One write transaction at a time per handle. The handle is one connection
 * shared by every request of the tenant, so two interleaved BEGINs would fail
 * and a ROLLBACK could undo the other request's statements.
 */
function serialized(db, work) {
    const previous = writing.get(db) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    writing.set(db, next);
    return next;
}

async function transaction(db, work) {
    return serialized(db, async () => {
        await db.exec('BEGIN');
        try {
            const result = await work();
            await db.exec('COMMIT');
            return result;
        } catch (error) {
            await db.exec('ROLLBACK');
            throw error;
        }
    });
}

async function runningScan(db) {
    return db.get("SELECT id, started_at, status, domain FROM scans WHERE status = 'running' ORDER BY started_at DESC LIMIT 1");
}

async function startScan(db, domain) {
    const id = crypto.randomUUID();
    await db.run("INSERT INTO scans (id, started_at, status, domain) VALUES (?, ?, 'running', ?)", [id, now(), domain || null]);
    activeScans.add(id);
    return id;
}

async function finishScan(db, id, { status, errorCode = null, facts = null }) {
    try {
        await db.run(
            'UPDATE scans SET status = ?, error_code = ?, finished_at = ?, facts_json = ? WHERE id = ?',
            [status, errorCode, now(), facts ? JSON.stringify(facts) : null, id]
        );
        await db.run(
            `DELETE FROM scans WHERE id NOT IN (SELECT id FROM scans ORDER BY started_at DESC LIMIT ${KEEP_SCANS})`
        );
    } finally {
        activeScans.delete(id);
    }
}

async function latestScan(db) {
    return db.get('SELECT id, started_at, finished_at, status, error_code, domain FROM scans ORDER BY started_at DESC LIMIT 1');
}

/** The last scan whose facts can be shown: `ok`, or `partial` with some objects unread. */
async function latestFacts(db) {
    const row = await db.get(
        "SELECT id, facts_json FROM scans WHERE status IN ('ok', 'partial') ORDER BY started_at DESC LIMIT 1"
    );
    return row ? { id: row.id, facts: JSON.parse(row.facts_json) } : null;
}

async function getRules(db) {
    return db.all('SELECT id, position, kind, pattern, tier, created_by, updated_at FROM rules ORDER BY position');
}

async function replaceRules(db, rules, by) {
    return transaction(db, async () => {
        await db.run('DELETE FROM rules');
        const at = now();
        for (const [position, rule] of rules.entries()) {
            await db.run(
                'INSERT INTO rules (id, position, kind, pattern, tier, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [crypto.randomUUID(), position, rule.kind, rule.pattern, rule.tier, by || null, at]
            );
        }
    });
}

async function getOverrides(db) {
    return db.all('SELECT sid, tier, reason, set_by, set_at FROM overrides ORDER BY sid');
}

async function setOverride(db, sid, { tier, reason, by }) {
    await db.run(
        `INSERT INTO overrides (sid, tier, reason, set_by, set_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (sid) DO UPDATE SET tier = excluded.tier, reason = excluded.reason, set_by = excluded.set_by, set_at = excluded.set_at`,
        [sid, tier, reason, by || null, now()]
    );
}

async function deleteOverride(db, sid) {
    await db.run('DELETE FROM overrides WHERE sid = ?', [sid]);
}

async function getRemediations(db) {
    return db.all('SELECT sid, proposed_by, proposed_at FROM remediations ORDER BY sid');
}

async function markRemediation(db, sid, by) {
    await db.run(
        `INSERT INTO remediations (sid, proposed_by, proposed_at) VALUES (?, ?, ?)
         ON CONFLICT (sid) DO UPDATE SET proposed_by = excluded.proposed_by, proposed_at = excluded.proposed_at`,
        [sid, by || null, now()]
    );
}

const DEFAULT_SETTINGS = { domain: null, passes: 3 };

async function getSettings(db) {
    const rows = await db.all('SELECT key, value FROM settings');
    const out = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
        if (row.key === 'domain') out.domain = row.value || null;
        if (row.key === 'passes') out.passes = Number(row.value);
    }
    return out;
}

async function putSettings(db, { domain, passes }) {
    return transaction(db, async () => {
        for (const [key, value] of [['domain', domain || ''], ['passes', String(passes)]]) {
            await db.run(
                'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
                [key, value]
            );
        }
    });
}

module.exports = {
    ensure, runningScan, startScan, finishScan, latestScan, latestFacts,
    getRules, replaceRules, getOverrides, setOverride, deleteOverride,
    getRemediations, markRemediation, getSettings, putSettings,
    KEEP_SCANS
};
```

- [ ] **Step 5: Run it and watch it pass**

Run: `node --test extensions/account-tiering/backend/tests/store.test.js`
Expected: 8 tests pass on Node 24; on Node 20 the 8 are skipped with "node:sqlite needs Node 22.5 or later"

- [ ] **Step 6: Commit**

```powershell
git add extensions/account-tiering/backend/tests/sqliteDb.js extensions/account-tiering/backend/tests/store.test.js extensions/account-tiering/backend/store.js
git commit -m "feat(account-tiering): per-tenant store on extensionDb, portable SQL"
```


### Task 8: Le lanceur du collecteur (runner.js)

**Files:**
- Create: `extensions/account-tiering/backend/tests/fakeCollector.js`
- Create: `extensions/account-tiering/backend/runner.js`
- Test: `extensions/account-tiering/backend/tests/runner.test.js`

Le vrai `collect/collect-tiering.ps1` arrive avec la livraison 2. Ici, un script
Node le remplace, pour que la suite tourne sans PowerShell et sans domaine.

- [ ] **Step 1: Write the fake collector**

`extensions/account-tiering/backend/tests/fakeCollector.js`

```js
/**
 * Stands in for collect-tiering.ps1. The behaviour comes from FAKE_MODE, the
 * arguments are the collector's own (-Passes, -OutFile, -Domain).
 */

'use strict';

const fs = require('fs');

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const outFile = arg('-OutFile');
const facts = (extra = {}) => JSON.stringify({ schema: 1, domain: arg('-Domain') || 'corp.local', passes: Number(arg('-Passes')), ...extra });

switch (process.env.FAKE_MODE) {
    case 'ok':
        process.stdout.write('pass 1\r\npass 2\r\n');
        fs.writeFileSync(outFile, '﻿' + facts());
        break;
    case 'partial':
        fs.writeFileSync(outFile, '﻿' + facts({ unreadable: [{ dn: 'OU=X', reason: 'denied' }] }));
        break;
    case 'unreachable':
        process.stdout.write('AT-ERROR domain_unreachable\r\n');
        process.exit(2);
        break;
    case 'exit2':
        process.exit(2);
        break;
    case 'amsi':
        process.stderr.write("Ce script contient du contenu malveillant.\r\n    + FullyQualifiedErrorId : ScriptContainedMaliciousContent\r\n");
        process.exit(1);
        break;
    case 'garbage':
        fs.writeFileSync(outFile, 'not json');
        break;
    case 'unknown-code':
        process.stdout.write('AT-ERROR rm_rf\r\n');
        process.exit(1);
        break;
    case 'hang':
        setTimeout(() => {}, 60000);
        break;
    default:
        process.exit(9);
}
```

- [ ] **Step 2: Write the failing test**

`extensions/account-tiering/backend/tests/runner.test.js`

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runCollector } = require('../runner');

const FAKE = { exe: process.execPath, prefix: [path.join(__dirname, 'fakeCollector.js')] };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-runner-'));
let n = 0;

function run(mode, extra = {}) {
    process.env.FAKE_MODE = mode;
    const outFile = path.join(dir, `facts-${n++}.json`);
    return runCollector({ passes: 3, outFile, command: FAKE, ...extra }).then((r) => ({ ...r, outFile }));
}

test('facts written with a BOM are read, progress lines are passed on, the file is removed', async () => {
    const seen = [];
    const r = await run('ok', { domain: 'corp.local', onLine: (l) => seen.push(l) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 'ok');
    assert.deepStrictEqual(r.facts, { schema: 1, domain: 'corp.local', passes: 3 });
    assert.deepStrictEqual(seen, ['pass 1', 'pass 2']);
    await new Promise((done) => setTimeout(done, 50));
    assert.strictEqual(fs.existsSync(r.outFile), false);
});

test('unreadable objects make the scan partial', async () => {
    assert.strictEqual((await run('partial')).status, 'partial');
});

test('an AT-ERROR line and exit code 2 both give domain_unreachable', async () => {
    assert.strictEqual((await run('unreachable')).code, 'domain_unreachable');
    assert.strictEqual((await run('exit2')).code, 'domain_unreachable');
});

test('the AMSI error id gives collector_blocked, whatever the language around it', async () => {
    assert.strictEqual((await run('amsi')).code, 'collector_blocked');
});

test('a code the collector may not send is not passed through', async () => {
    assert.strictEqual((await run('unknown-code')).code, 'collector_failed');
});

test('facts that do not parse give collector_failed', async () => {
    assert.strictEqual((await run('garbage')).code, 'collector_failed');
});

test('a run past the timeout is killed and gives scan_timeout', async () => {
    assert.strictEqual((await run('hang', { timeoutMs: 300 })).code, 'scan_timeout');
});

test('a missing executable gives powershell_missing', async () => {
    const r = await runCollector({ passes: 1, outFile: path.join(dir, 'x.json'), command: { exe: 'no-such-powershell-exe', prefix: [] } });
    assert.strictEqual(r.code, 'powershell_missing');
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node --test extensions/account-tiering/backend/tests/runner.test.js`
Expected: FAIL, `Cannot find module '../runner'`

- [ ] **Step 4: Write the implementation**

`extensions/account-tiering/backend/runner.js`

```js
/**
 * Runs the collector and turns whatever happens into facts or one error code.
 *
 * The collector is `collect/collect-tiering.ps1`, run by `powershell.exe`
 * (Windows PowerShell 5.1, the version every Windows server has). It writes its
 * facts to `-OutFile` as UTF-8 with a BOM, because 5.1's `Out-File -Encoding
 * UTF8` always writes one, and the BOM is stripped here before `JSON.parse`.
 *
 * The collector says what went wrong with a fixed line, `AT-ERROR <code>`, on
 * stdout, never a translated message: the page translates the code. Other
 * stdout lines are progress and go to `onLine`, which the routes hand to
 * `broadcastLog`.
 *
 * The codes, checked in this order:
 * - `powershell_missing`: the executable is not there (ENOENT on spawn);
 * - `scan_timeout`: the run passed `timeoutMs` and was killed;
 * - `collector_blocked`: the antivirus refused the script. AMSI's refusal
 *   carries the error id `ScriptContainedMaliciousContent` whatever the
 *   language of the host, so that id is what is matched, never the French
 *   or English sentence around it;
 * - the code of an `AT-ERROR` line, when it is one of `COLLECTOR_CODES`;
 * - `domain_unreachable`: exit code 2, the collector's own convention;
 * - `collector_failed`: any other non-zero exit, or facts that do not parse.
 *
 * `command` exists for the tests, which run a Node script in place of
 * PowerShell so the suite needs neither Windows PowerShell nor a domain.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SCRIPT_PATH = path.join(__dirname, '..', 'collect', 'collect-tiering.ps1');
const TIMEOUT_MS = 10 * 60 * 1000;
const COLLECTOR_CODES = new Set(['domain_unreachable', 'collector_blocked']);
const AMSI_ID = 'ScriptContainedMaliciousContent';

const POWERSHELL = {
    exe: 'powershell.exe',
    prefix: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH]
};

function runCollector({ domain, passes, outFile, onLine = () => {}, timeoutMs = TIMEOUT_MS, command = POWERSHELL }) {
    const args = [...command.prefix, '-Passes', String(passes), '-OutFile', outFile];
    if (domain) args.push('-Domain', domain);

    return new Promise((resolve) => {
        let reported = null;
        let pending = '';
        const lines = (chunk) => {
            pending += chunk;
            const parts = pending.split(/\r?\n/);
            pending = parts.pop();
            for (const raw of parts) line(raw.trim());
        };
        const line = (text) => {
            if (!text) return;
            const match = /^AT-ERROR ([a-z_]{1,40})$/.exec(text);
            if (match) {
                if (!reported && COLLECTOR_CODES.has(match[1])) reported = match[1];
                return;
            }
            onLine(text);
        };

        const child = execFile(command.exe, args, {
            timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024
        }, (error, stdout, stderr) => {
            line(pending.trim());
            const output = `${stdout}\n${stderr}`;
            if (error && error.code === 'ENOENT') return resolve({ ok: false, code: 'powershell_missing' });
            if (error && error.killed) return resolve({ ok: false, code: 'scan_timeout' });
            if (output.includes(AMSI_ID)) return resolve({ ok: false, code: 'collector_blocked' });
            if (reported) return resolve({ ok: false, code: reported });
            if (error && error.code === 2) return resolve({ ok: false, code: 'domain_unreachable' });
            if (error) return resolve({ ok: false, code: 'collector_failed' });
            resolve(readFacts(outFile));
        });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', lines);
    });
}

function readFacts(outFile) {
    try {
        const facts = JSON.parse(fs.readFileSync(outFile, 'utf8').replace(/^﻿/, ''));
        const partial = Array.isArray(facts.unreadable) && facts.unreadable.length > 0;
        return { ok: true, status: partial ? 'partial' : 'ok', facts };
    } catch (_) {
        return { ok: false, code: 'collector_failed' };
    } finally {
        fs.rm(outFile, { force: true }, () => {});
    }
}

module.exports = { runCollector, SCRIPT_PATH, TIMEOUT_MS };
```

- [ ] **Step 5: Run it and watch it pass**

Run: `node --test extensions/account-tiering/backend/tests/runner.test.js`
Expected: 8 tests pass

- [ ] **Step 6: Commit**

```powershell
git add extensions/account-tiering/backend/tests/fakeCollector.js extensions/account-tiering/backend/tests/runner.test.js extensions/account-tiering/backend/runner.js
git commit -m "feat(account-tiering): collector runner, one error code per failure"
```


### Task 9: Les routes (routes.js)

**Files:**
- Create: `extensions/account-tiering/backend/routes.js`
- Test: `extensions/account-tiering/backend/tests/routes.test.js`

- [ ] **Step 1: Write the failing test**

`extensions/account-tiering/backend/tests/routes.test.js`

```js
/**
 * The routes' contract, without express and without a network.
 *
 * `register` gets a router that records its handlers, and each chain is run
 * with a request built here: the same shape as deploy's createRoute.test.js.
 * Tests that need a database use `node:sqlite` and skip on Node 20.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const routes = require('../routes');
const store = require('../store');
const sqlite = require('./sqliteDb');
const { sid, user, group, facts } = require('./facts');

const BASE = '/api/account-tiering';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'at-routes-'));
console.error = () => {};

/** Lets the chain through only for `req.user.role === role`, like core's requireRole. */
const requireRole = (role) => (req, res, next) => (req.user && req.user.role === role
    ? next()
    : res.status(403).json({ success: false, error: 'forbidden' }));

function fakeExtensionDb(db) {
    return {
        withRequest: async (req, work) => work(db),
        pathForRequest: () => path.join(DIR, 'extension.db')
    };
}

function mount(context) {
    const table = new Map();
    const add = (method) => (routePath, ...chain) => table.set(`${method} ${routePath}`, chain);
    routes.register({ get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE') }, { requireRole, ...context });
    return table;
}

function call(table, key, req) {
    const chain = table.get(key);
    assert.ok(chain, `${key} is not mounted`);
    return new Promise((resolve, reject) => {
        const res = {
            statusCode: 200, headers: {}, headersSent: false,
            status(code) { this.statusCode = code; return this; },
            setHeader(k, v) { this.headers[k] = v; },
            json(body) { this.headersSent = true; resolve({ status: this.statusCode, body, headers: this.headers }); return this; },
            send(body) { this.headersSent = true; resolve({ status: this.statusCode, body, headers: this.headers }); return this; }
        };
        let i = 0;
        const next = () => Promise.resolve(chain[i++](req, res, next)).catch(reject);
        next();
    });
}

const request = (extra = {}) => ({
    body: {}, params: {}, query: {},
    tenant: { slug: 'acme' },
    user: { email: 'ops@corp.local', role: 'admin' },
    ...extra
});

test('every route is refused to a non-admin', async () => {
    const table = mount({});
    for (const key of table.keys()) {
        const r = await call(table, key, request({ user: { role: 'viewer' }, params: { sid: sid(1200) } }));
        assert.strictEqual(r.status, 403, key);
    }
});

test('without extensionDb, register does not throw and every route answers 501 store_unavailable', async () => {
    const table = mount({});
    assert.ok(table.size >= 12);
    for (const key of table.keys()) {
        const r = await call(table, key, request({ params: { sid: sid(1200) } }));
        assert.deepStrictEqual([r.status, r.body.error], [501, 'store_unavailable'], key);
    }
});

const db = (opts) => ({ skip: sqlite.why || false, ...opts });

test('an invalid SID is refused before any write', db(), async () => {
    const table = mount({ extensionDb: fakeExtensionDb(sqlite.openMemoryDb()) });
    for (const bad of ['S-1-5-21-1-2-3', '../etc', 'S-1-5-21-1-2-3-4\n']) {
        const r = await call(table, `PUT ${BASE}/overrides/:sid`, request({ params: { sid: bad }, body: { tier: 0, reason: 'x' } }));
        assert.deepStrictEqual([r.status, r.body.error], [400, 'invalid_sid'], JSON.stringify(bad));
    }
});

test('no scan yet gives 404 no_scan_yet on the model and on both exports', db(), async () => {
    const table = mount({ extensionDb: fakeExtensionDb(sqlite.openMemoryDb()) });
    for (const key of [`GET ${BASE}/model`, `GET ${BASE}/export.json`, `GET ${BASE}/export.csv`]) {
        const r = await call(table, key, request());
        assert.deepStrictEqual([r.status, r.body.error], [404, 'no_scan_yet'], key);
    }
});

test('a second scan while one runs gives 409 scan_running', db(), async () => {
    const memory = sqlite.openMemoryDb();
    await store.ensure(memory);
    const id = await store.startScan(memory, null);
    const table = mount({ extensionDb: fakeExtensionDb(memory) });
    const r = await call(table, `POST ${BASE}/scan`, request());
    assert.deepStrictEqual([r.status, r.body.error], [409, 'scan_running']);
    await store.finishScan(memory, id, { status: 'failed', errorCode: 'x' });
});

test('the model follows a rule change without a new scan, and carries remediations', db(), async () => {
    const memory = sqlite.openMemoryDb();
    await store.ensure(memory);
    const id = await store.startScan(memory, null);
    await store.finishScan(memory, id, {
        status: 'ok',
        facts: facts({
            principals: [group(1100, 'IT-Admins'), user(1200, 'alice')],
            memberships: [{ group: sid(512), member: sid(1100), via: 'member' }, { group: sid(1100), member: sid(1200), via: 'member' }]
        })
    });
    const table = mount({ extensionDb: fakeExtensionDb(memory) });

    const before = await call(table, `GET ${BASE}/model`, request());
    const alice = (m) => m.accounts.find((a) => a.sid === sid(1200));
    assert.strictEqual(alice(before.body.model).status, 'gap');
    assert.strictEqual(before.body.model.rulesCount, 0);
    assert.match(alice(before.body.model).path[0].remediation.command, /^Remove-ADGroupMember/);

    const put = await call(table, `PUT ${BASE}/rules`, request({ body: { rules: [{ kind: 'name', pattern: 'alice', tier: 0 }] } }));
    assert.strictEqual(put.status, 200);
    const after = await call(table, `GET ${BASE}/model`, request());
    assert.strictEqual(alice(after.body.model).status, 'ok');

    const csv = await call(table, `GET ${BASE}/export.csv`, request());
    assert.match(csv.headers['Content-Type'], /^text\/csv/);
    assert.ok(csv.body.includes('alice'));
});

test('rules, overrides and settings refuse what the spec forbids', db(), async () => {
    const table = mount({ extensionDb: fakeExtensionDb(sqlite.openMemoryDb()) });
    const refused = [
        [`PUT ${BASE}/rules`, { rules: [{ kind: 'regex', pattern: 'x', tier: 0 }] }, 'invalid_rules'],
        [`PUT ${BASE}/rules`, { rules: [{ kind: 'name', pattern: 'x'.repeat(257), tier: 0 }] }, 'invalid_rules'],
        [`PUT ${BASE}/rules`, { rules: [{ kind: 'group', pattern: 'Domain Admins', tier: 0 }] }, 'invalid_rules'],
        [`PUT ${BASE}/rules`, { rules: [{ kind: 'name', pattern: 'x', tier: 3 }] }, 'invalid_rules'],
        [`PUT ${BASE}/settings`, { domain: 'corp.local;calc', passes: 3 }, 'invalid_domain'],
        [`PUT ${BASE}/settings`, { domain: 'corp.local', passes: 6 }, 'invalid_passes'],
        [`PUT ${BASE}/settings`, { domain: 'corp.local', passes: '3' }, 'invalid_passes']
    ];
    for (const [key, body, error] of refused) {
        const r = await call(table, key, request({ body }));
        assert.deepStrictEqual([r.status, r.body.error], [400, error], JSON.stringify(body));
    }
    const noReason = await call(table, `PUT ${BASE}/overrides/:sid`, request({ params: { sid: sid(1200) }, body: { tier: 0, reason: '  ' } }));
    assert.deepStrictEqual([noReason.status, noReason.body.error], [400, 'reason_required']);

    const ok = await call(table, `PUT ${BASE}/settings`, request({ body: { domain: '', passes: 2 } }));
    assert.deepStrictEqual(ok.body.settings, { domain: null, passes: 2 });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test extensions/account-tiering/backend/tests/routes.test.js`
Expected: FAIL, `Cannot find module '../routes'`

- [ ] **Step 3: Write the implementation**

`extensions/account-tiering/backend/routes.js`

```js
/**
 * The routes behind the account-tiering page, all under /api/account-tiering.
 *
 * Every route is behind `requireRole('admin')`, reads included: the model is a
 * list of the ways to take control of the domain, and a reader who is not an
 * administrator of the tenant has no use for it that is not an attack.
 *
 * Storage is core's `extensionDb`, bound to this extension by the loader. A
 * core that does not hand it over gets a 501 `store_unavailable` on each route
 * that needs it, and `register` itself never throws: CONTRACT.md asks for a
 * refused feature, not an inert extension.
 *
 * A scan answers 202 at once and runs in the background. The page polls
 * `GET /scan/status`. The model is rebuilt only when the scan, the rules, the
 * overrides or the remediation markers change, so editing a rule recomputes the
 * tiers without reading the directory again.
 */

'use strict';

const path = require('path');

const store = require('./store');
const { runCollector } = require('./runner');
const { analyze } = require('./analyze');
const { classify } = require('./classify');
const { remediationFor } = require('./remediation');
const { toCsv } = require('./exportCsv');
const { isSid } = require('./sids');

const BASE = '/api/account-tiering';
const RULE_KINDS = new Set(['ou', 'name', 'group']);
const MAX_RULES = 200;
const MAX_TEXT = 256;
const DNS_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

const isTier = (v) => v === 0 || v === 1 || v === 2;
const isText = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_TEXT;

function validRules(body) {
    if (!Array.isArray(body) || body.length > MAX_RULES) return null;
    const rules = [];
    for (const r of body) {
        if (!r || !RULE_KINDS.has(r.kind) || !isText(r.pattern) || !isTier(r.tier)) return null;
        if (r.kind === 'group' && !isSid(r.pattern)) return null;
        rules.push({ kind: r.kind, pattern: r.pattern.trim(), tier: r.tier });
    }
    return rules;
}

function register(router, context) {
    const { requireRole } = context;
    const admin = requireRole('admin');
    const edb = context.extensionDb && typeof context.extensionDb.withRequest === 'function'
        ? context.extensionDb
        : null;
    const log = typeof context.broadcastLog === 'function' ? context.broadcastLog : () => {};
    const models = new Map();

    const fail = (res, status, error) => res.status(status).json({ success: false, error });

    /** Runs `work(db)` on the tenant's store, or answers 501 without one. */
    const withStore = (handler) => async (req, res) => {
        if (!edb) return fail(res, 501, 'store_unavailable');
        try {
            await edb.withRequest(req, async (db) => {
                await store.ensure(db);
                await handler(req, res, db);
            });
        } catch (error) {
            console.error('[account-tiering]', error);
            if (!res.headersSent) fail(res, 500, 'internal');
        }
    };

    const sidParam = (handler) => (req, res, db) => (isSid(req.params.sid)
        ? handler(req, res, db)
        : fail(res, 400, 'invalid_sid'));

    async function modelFor(req, db) {
        const latest = await store.latestFacts(db);
        if (!latest) return null;
        const [rules, overrides, remediations] = await Promise.all([
            store.getRules(db), store.getOverrides(db), store.getRemediations(db)
        ]);
        const key = JSON.stringify([latest.id, rules, overrides, remediations]);
        const cached = models.get(req.tenant.slug);
        if (cached && cached.key === key) return cached.model;
        const planned = classify(latest.facts, rules, overrides);
        const model = analyze(latest.facts, planned, { remediations: new Set(remediations.map((r) => r.sid)) });
        for (const account of model.accounts) {
            for (const edge of account.path) edge.remediation = remediationFor(edge, latest.facts);
        }
        model.rulesCount = rules.length;
        models.set(req.tenant.slug, { key, model });
        return model;
    }

    async function answerModel(req, res, db, send) {
        let model;
        try {
            model = await modelFor(req, db);
        } catch (error) {
            if (error.code === 'facts_schema') return fail(res, 422, 'facts_schema');
            throw error;
        }
        if (!model) return fail(res, 404, 'no_scan_yet');
        return send(model);
    }

    router.get(`${BASE}/model`, admin, withStore((req, res, db) =>
        answerModel(req, res, db, (model) => res.json({ success: true, model }))));

    router.post(`${BASE}/scan`, admin, withStore(async (req, res, db) => {
        if (await store.runningScan(db)) return fail(res, 409, 'scan_running');
        const settings = await store.getSettings(db);
        const id = await store.startScan(db, settings.domain);
        const slug = req.tenant.slug;
        const outFile = path.join(path.dirname(edb.pathForRequest(req)), `scan-${id}.json`);
        res.status(202).json({ success: true, id });

        runCollector({ domain: settings.domain, passes: settings.passes, outFile, onLine: (l) => log(slug, l) })
            .then((result) => edb.withRequest(req, (later) => store.finishScan(later, id, result.ok
                ? { status: result.status, facts: result.facts }
                : { status: 'failed', errorCode: result.code })))
            .catch((error) => console.error('[account-tiering] scan', error));
    }));

    router.get(`${BASE}/scan/status`, admin, withStore(async (req, res, db) => {
        res.json({ success: true, scan: (await store.latestScan(db)) || null });
    }));

    router.get(`${BASE}/rules`, admin, withStore(async (req, res, db) => {
        res.json({ success: true, rules: await store.getRules(db) });
    }));

    router.put(`${BASE}/rules`, admin, withStore(async (req, res, db) => {
        const rules = validRules(req.body && req.body.rules);
        if (!rules) return fail(res, 400, 'invalid_rules');
        await store.replaceRules(db, rules, req.user && req.user.email);
        res.json({ success: true, rules: await store.getRules(db) });
    }));

    router.put(`${BASE}/overrides/:sid`, admin, withStore(sidParam(async (req, res, db) => {
        const { tier, reason } = req.body || {};
        if (!isTier(tier)) return fail(res, 400, 'invalid_tier');
        if (!isText(reason)) return fail(res, 400, 'reason_required');
        await store.setOverride(db, req.params.sid, { tier, reason: reason.trim(), by: req.user && req.user.email });
        res.json({ success: true });
    })));

    router.delete(`${BASE}/overrides/:sid`, admin, withStore(sidParam(async (req, res, db) => {
        await store.deleteOverride(db, req.params.sid);
        res.json({ success: true });
    })));

    router.post(`${BASE}/remediations/:sid`, admin, withStore(sidParam(async (req, res, db) => {
        await store.markRemediation(db, req.params.sid, req.user && req.user.email);
        res.json({ success: true });
    })));

    router.get(`${BASE}/settings`, admin, withStore(async (req, res, db) => {
        res.json({ success: true, settings: await store.getSettings(db) });
    }));

    router.put(`${BASE}/settings`, admin, withStore(async (req, res, db) => {
        const { domain, passes } = req.body || {};
        if (domain !== null && domain !== '' && !(typeof domain === 'string' && DNS_RE.test(domain))) {
            return fail(res, 400, 'invalid_domain');
        }
        if (!Number.isInteger(passes) || passes < 1 || passes > 5) return fail(res, 400, 'invalid_passes');
        await store.putSettings(db, { domain: domain || null, passes });
        res.json({ success: true, settings: await store.getSettings(db) });
    }));

    router.get(`${BASE}/export.json`, admin, withStore((req, res, db) =>
        answerModel(req, res, db, (model) => {
            res.setHeader('Content-Disposition', 'attachment; filename="account-tiering.json"');
            res.json(model);
        })));

    router.get(`${BASE}/export.csv`, admin, withStore((req, res, db) =>
        answerModel(req, res, db, (model) => {
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="account-tiering.csv"');
            res.send(toCsv(model));
        })));
}

module.exports = { register };
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test extensions/account-tiering/backend/tests/routes.test.js`
Expected: 7 tests pass on Node 24; on Node 20, 2 pass (403 and 501) and 5 are skipped

- [ ] **Step 5: Commit**

```powershell
git add extensions/account-tiering/backend/tests/routes.test.js extensions/account-tiering/backend/routes.js
git commit -m "feat(account-tiering): admin-only routes, 501 without extensionDb"
```


### Task 10: La suite complète, et le chemin de la CI

**Files:** aucun.

- [ ] **Step 1: Run the whole repository suite on Node 24**

Run: `npm test`
Expected: the 56 new tests pass, and every existing suite keeps its count.

- [ ] **Step 2: Rehearse the CI path without node:sqlite**

Write `no-sqlite.cjs` in a temporary folder **outside the repository**:

```js
'use strict';
const Module = require('module');
const load = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'node:sqlite') throw new Error('simulated: no node:sqlite');
    return load.call(this, request, ...rest);
};
```

Run: `$env:NODE_OPTIONS = "--require=<temp folder>\no-sqlite.cjs"; node --test "extensions/account-tiering/**/*.test.js"; $env:NODE_OPTIONS = $null`
(the path must hold no space: NODE_OPTIONS does not take quotes)
Expected: `pass 43`, `skipped 13`, `fail 0`.

- [ ] **Step 3: Update the conception with the deviations**

In `docs/plans/2026-09-30-account-tiering-conception.md`:
- in « Format des faits », replace `DCSync` in the `right` list with
  `DCSyncGetChanges|DCSyncGetChangesAll` and add `"netbios": "CORP"` as an
  optional field;
- in « Erreurs », add `collector_failed`;
- in « Remédiation », add the primary group row;
- in « Livraisons », item 3, replace `version 0.1.0` with `version 0.0.0`
  (PUBLISHING.md: an extension's first release is `0.0.0`).

```powershell
git add docs/plans/2026-09-30-account-tiering-conception.md docs/plans/2026-10-01-account-tiering-backend.md
git commit -m "docs(account-tiering): the backend plan, and the facts format it settled"
```

### Task 11: Essai manuel sur le poste

**Files:** aucun.

Ce que la suite ne couvre pas : le chargeur réel du cœur, sa vraie base
`sqlite3` et sa vraie session. La page n'existe pas encore, donc l'essai passe
par les routes.

- [ ] **Step 1: Junction the extension into the data root**

```powershell
New-Item -ItemType Junction -Path 'C:\ProgramData\Aegis\extensions\account-tiering' -Target '<repo>\extensions\account-tiering'
```

- [ ] **Step 2: Ask Paul to restart the backend**

Le tableau de bord tourne en administrateur et le shell de Claude non : Claude
ne peut pas le relancer. Le chargeur lit les extensions au démarrage.
Expected in the log: no `[extensions]` error naming `account-tiering`.

- [ ] **Step 3: Call the routes from the browser, logged in as a tenant admin**

Open, in the devtools console of any Aegis page:

```js
await (await fetch('/api/account-tiering/scan/status')).json()
await (await fetch('/api/account-tiering/model')).json()
await (await fetch('/api/account-tiering/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: 'corp.local', passes: 3 }) })).json()
```

Expected: `{ success: true, scan: null }`, then `404 no_scan_yet`, then the
settings echoed back. Then check that the file
`<tenant data>\extensions\account-tiering\extension.db` exists.

- [ ] **Step 4: Same calls as a non-admin user**

Expected: 403 on all three.

- [ ] **Step 5: Start a scan**

`POST /api/account-tiering/scan` answers 202. As long as the collector does
not exist, powershell.exe exits non-zero on the missing `-File`, so
`GET /scan/status` should show `failed` with `collector_failed`. Not verified
on this machine yet: if the status stays `running`, the runner has a gap to
fix before livraison 2.

## Points ouverts

| Point | Pour quand | Qui |
|---|---|---|
| Maquette de la page : `C:\Users\PV\Downloads\Arbre des comptes.html`, à copier dans le dépôt par le plan 1b | plan 1b | Claude |
| Catégorie et version : tranché le 2026-10-01, on suit PUBLISHING.md (`Compliance`, liste fermée ; première sortie `0.0.0`, la conception est à corriger) | fait | Paul |
| Icône `users` : présente dans `navbar.js` du cœur (ligne 21), rendu à regarder | livraison 3 | Paul |
| `minAppVersion` : première version publiée d'Aegis qui passe `extensionDb` | livraison 3 | vérification |
| `dsacls /R` accepte-t-il `compte@domaine` quand le NetBIOS manque | livraison 2, en VM | test |
| Code de sortie propre à AMSI, en plus du texte `ScriptContainedMaliciousContent` | livraison 2, en VM | test |
| Le journal en direct du cœur (`broadcastLog`) affiche-t-il les lignes en texte, sans HTML ? Le collecteur y envoie des noms lus dans l'AD, comme le fait déjà network-inventory | livraison 2 | vérification dans le cœur |

## Après les relectures

Le code des tâches 2 à 9 ci-dessus est celui qui a été posé. Les relectures
l'ont ensuite modifié, et le code de référence est celui du dépôt :

- conformité, analyse : un droit sur une OU atteint les comptes et groupes
  qu'elle contient ; le test des titulaires trop larges peut désormais échouer ;
- conformité, stockage et routes : une analyse ne reste jamais `running`, une
  série d'échecs n'efface plus la dernière analyse réussie, deux lancements
  simultanés donnent 202 puis 409, le lancement réussi est testé ;
- qualité : une seule file d'attente par connexion pour toutes les opérations
  du stockage, motif de nom comparé en temps linéaire (plus d'expression
  régulière à retour arrière), index construits une fois par modèle, faits
  relus seulement quand le cache du modèle est périmé, fichier de faits effacé
  quelle que soit l'issue de l'analyse.

Le journal git de la branche garde l'ordre réel des commits.

## Execution Handoff

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)**: one fresh subagent per task, review between tasks.
2. **Inline Execution**: tasks in this session with superpowers:executing-plans, with checkpoints.
