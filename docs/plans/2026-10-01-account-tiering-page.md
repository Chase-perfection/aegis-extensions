# Arbre des comptes, livraison 1b : la page. Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** la page `account-tiering.html` de l'extension, reprise de la maquette validée, branchée sur les routes du plan 1a.

**Architecture:** un adaptateur pur transforme le modèle du backend en modèle de vue, un second module pur calcule la disposition de l'arbre. Les modules d'affichage (arbre et liste, panneau, vue d'ensemble, fenêtres) lisent ce modèle de vue. `account-tiering.js` tient l'état, appelle l'API et relance le rendu.

**Tech Stack:** JS natif sans bundler ni bibliothèque, CSS sur les variables du design system du cœur, `node:test`, banc puppeteer du cœur pour le test de page.

**Spécification:** `docs/plans/2026-09-30-account-tiering-conception.md`. Maquette : « Arbre des comptes », un export d'outil de design validé par Paul, gardé hors des dépôts.

---

## Pourquoi ce plan ne recopie pas le code

Le plan 1a embarquait chaque fichier. Ici la page pèse environ 2 500 lignes de
JS et de CSS : la recopier ferait un document de 4 000 lignes que personne ne
lirait. Le code a été écrit et testé avant ce plan, dans un prototype, puis posé
dans le dépôt par copie de fichiers. Ce document garde ce qu'un code ne dit pas :
les décisions, les écarts avec la maquette, ce que les tests couvrent ou non.

## Décisions validées par Paul le 2026-10-01

| Sujet | Décision |
|---|---|
| Règles de tiering | Une fenêtre ouverte depuis la barre de titre, tableau ordonné (type, motif, tier), monter, descendre, supprimer, ajouter. Un second onglet « Analyse » porte le domaine et le nombre de passes. |
| Correction manuelle | Dans le panneau de détail du compte : tier prévu et sa source, motif obligatoire, auteur et date d'une correction existante, retrait. |
| Bandeau sans règle | Sous la barre de titre quand `rulesCount` vaut 0, avec un lien qui ouvre la fenêtre des règles. |
| Export PDF | Retiré : la conception le place hors de la première version. |
| Sélecteur de domaine | Retiré : un seul domaine, réglé dans l'onglet « Analyse », rappelé sous le titre. |

## Écarts avec la maquette

| Point | Maquette | Page | Raison |
|---|---|---|---|
| Canevas | fixe, 1820 × 1144 | trois colonnes 320 / souple / 380 au-dessus de 1280 px ; en dessous le panneau passe sous l'arbre ; une colonne sous 760 px | la page vit dans le shell du cœur, à la largeur de la fenêtre. Requête de conteneur sur `#at-view`. |
| Barre d'outils | flottante sur le canevas | au-dessus du canevas, avec retour à la ligne | elle recouvrait l'arbre aux petites largeurs. |
| Plusieurs chemins par compte | une liste de mécanismes par compte | le chemin du backend, plus une chaîne reconstruite par autre groupe privilégié, à partir de `links` | le backend donne un chemin par compte. Une chaîne reconstruite s'arrête sur un groupe `target` et ne porte pas de remédiation. |
| Étapes de remédiation | une chaîne `fix` par mécanisme | une étape par lien du chemin qui part du compte ou d'un groupe ; un lien qui part d'un autre compte conforme est écarté | sinon le cas « helpdesk » proposait de retirer l'administrateur légitime des Admins du domaine. |
| Bouton de la fenêtre de remédiation | « Ajouter aux actions proposées » | « Marquer comme proposée » | la file des actions proposées du cœur est hors de la première version : le libellé de la maquette promettait ce qui n'existe pas. |
| Points de passage | exposition = membres du groupe | exposition = comptes en écart, ordre du backend (titulaires trop larges d'abord) | c'est ce que le modèle calcule, et ce qui se corrige. |
| Descriptions des groupes | texte rédigé à la main | une phrase générique | l'AD ne fournit pas ces textes. |
| Compte de service | type `service` | seuls les gMSA | le modèle ne distingue pas un compte de service de type utilisateur. |
| Couleurs, polices, rayons | valeurs en ligne | variables `--ag-*` du cœur, aucune couleur en dur | la maquette était dessinée sur le même design system : tout se retrouve, sauf le voile de fenêtre (`--ag-scrim`, plus clair). |
| Jauge de sévérité, toast | redessinés | composants du cœur (`.ag-sev`, `showToast`) | déjà fournis. |
| Textes statiques | sans objet | attribut `data-at-i18n`, pas `data-i18n` | `applyTranslations()` du cœur écrit la clé brute quand il ne la connaît pas. Les 338 clés `at_*` arrivent dans le cœur à la livraison 3 ; d'ici là le texte français de repli s'affiche dans les deux langues. |

Ajouts hors maquette, demandés par la conception : états chargement, erreur
(code traduit), première analyse, analyse en cours avec relevé toutes les 2 s,
analyse échouée, chaîne tronquée, objets illisibles, aide « Limites de
l'analyse », note sous la matrice sur les comptes non collectés.

## Ce que le backend a gagné en route

Le prototype a montré trois manques, corrigés dans le backend avant de poser la
page (commit `2d95df5`) : le détail d'une correction manuelle sur le compte
(`override`), le drapeau `target` sur les groupes cibles, et des points de
passage limités à ceux qui portent un écart ou un titulaire trop large.

## Structure des fichiers

Sous `extensions/account-tiering/frontend/` :

| Fichier | Rôle |
|---|---|
| `pages/account-tiering.html` | squelette de la page dans le shell du cœur |
| `src/css/account-tiering.css` | mise en page, variables `--ag-*` seulement |
| `src/js/account-tiering-model.js` | adaptateur pur : modèle du backend vers modèle de vue (Node et navigateur) |
| `src/js/account-tiering-graph.js` | disposition pure de l'arbre : colonnes, barycentres, repli au-delà de 8 groupes, arbre inversé, ajustement |
| `src/js/account-tiering-ui.js` | `T`, échappement, icônes, textes d'erreur, piège de focus des fenêtres |
| `src/js/account-tiering-tree.js` | arbre, liste, déplacement, zoom, mini-carte |
| `src/js/account-tiering-panel.js` | panneau de détail, correction manuelle |
| `src/js/account-tiering-overview.js` | chiffres clés, matrice, points de passage |
| `src/js/account-tiering-dialogs.js` | remédiation, règles, réglages d'analyse |
| `src/js/account-tiering-events.js` | écouteurs |
| `src/js/account-tiering.js` | état, appels d'API, relevé d'analyse, rendu |
| `tests/harness.js` | localise le banc puppeteer du cœur (`AEGIS_TREE`) |
| `tests/account-tiering-model.test.js`, `account-tiering-graph.test.js` | tests unitaires, tournent en CI |
| `tests/account-tiering.test.js` | test de page, sauté sans `AEGIS_TREE` |
| `tests/fixtures/build-fixture.js`, `model.json` | jeu d'essai produit par le vrai backend (`buildModel` de `routes.js`) |

`docs/plans/2026-10-01-account-tiering-i18n.md` : les 338 clés, français et
anglais, à verser dans `translations.js` du cœur à la livraison 3.

Aucun fichier ne dépasse 500 lignes.

## Tâches

Source : le prototype testé (47 tests : 22 adaptateur, 7 disposition, 18 page).

### Task 1: L'adaptateur, la disposition et leur jeu d'essai

- [ ] Copier `tests/fixtures/build-fixture.js`, remplacer son chemin absolu vers
  le backend par `path.join(__dirname, '..', '..', '..', 'backend')`, le lancer
  et vérifier que `model.json` régénéré est identique à celui du prototype.
- [ ] Copier les deux fichiers de test, constater l'échec (`Cannot find module`).
- [ ] Copier `account-tiering-model.js` et `account-tiering-graph.js`, constater 29 tests réussis.
- [ ] Commit : `feat(account-tiering): view model and tree layout, tested on real backend output`

### Task 2: La page

- [ ] Copier `harness.js` et `account-tiering.test.js`.
- [ ] Copier la page, le CSS et les neuf modules JS.
- [ ] Créer un dossier de données temporaire avec la jonction
  `extensions\account-tiering` vers le dossier de l'extension **dans le dépôt**,
  puis lancer avec `AEGIS_TREE` et `AEGIS_DATA_ROOT` : 18 tests de page réussis.
  Un délai dépassé de 15 s dans puppeteer se relance deux fois avant d'être
  pris au sérieux.
- [ ] Sans `AEGIS_TREE` : le fichier de page est sauté avec sa raison, 29 réussis.
- [ ] Commit : `feat(account-tiering): the page, from the validated mockup`

### Task 3: Les clés de traduction et ce plan

- [ ] Copier `i18n-keys.md` vers `docs/plans/2026-10-01-account-tiering-i18n.md`.
- [ ] Commit : `docs(account-tiering): the page plan and its translation keys`

### Task 4: Vérifications

- [ ] `npm test` sur le dépôt : rien de neuf en échec (`deployRuntime.test.js`
  échoue sur ce poste quand le port 3200 est pris, sans rapport).
- [ ] Recherche des interdits dans `frontend/` : tiret cadratin, emoji, couleur
  en dur, `@keyframes`, chemin absolu, nom réel.
- [ ] Relecture de qualité par un agent, corrections, nouvelle relecture.

### Task 5: Essai à l'écran, avec Paul

Ce que les tests ne couvrent pas : le glisser à la souris, la molette, le
presse-papiers, le relevé toutes les 2 s, le 403 réel, et l'allure générale.

- [ ] Jonction `C:\ProgramData\Aegis\extensions\account-tiering` vers le
  dossier de l'extension, puis redémarrage du backend par Paul.
- [ ] La carte « Arbre des comptes » apparaît sous Gestion du parc, la page
  s'ouvre sur « aucune analyse ».
- [ ] Sans collecteur (livraison 2), « Relancer l'analyse » finit en échec avec
  un message traduit. Pour voir l'arbre avant la livraison 2, insérer le jeu
  d'essai dans la base de l'extension (script à écrire à ce moment-là).
- [ ] Glisser, molette, zoom, mini-carte, les trois vues, l'arbre inversé, la
  fenêtre des règles, une correction manuelle, la remédiation.

## Points ouverts

| Point | Pour quand |
|---|---|
| Le voile des fenêtres est plus clair que la maquette (`--ag-scrim` du cœur à 0,18 contre 0,32) : garder le jeton ou en demander un second au cœur | essai à l'écran |
| Les chaînes reconstruites n'ont pas de remédiation : faut-il que le backend donne un chemin par groupe privilégié | après l'essai, selon l'usage |
| `matrix[2][2]` inclut les comptes non collectés, un clic sur la case n'en liste qu'une partie ; la page l'explique par une note | essai à l'écran |
| Valeurs sans jeton, laissées en nombres : nœud 220 × 72, mini-carte 200 × 136, colonnes 320 / 300 / 380, grille 24 px | à verser au design system si une autre page en a besoin |

## Execution Handoff

Exécution dans la foulée, par sous-agents, dans la session qui a écrit ce plan.
