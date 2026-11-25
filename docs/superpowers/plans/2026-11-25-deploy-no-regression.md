# Deploy: corrections livrées et gardées — plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** livrer les défauts Deploy du 2026-11-25 et empêcher qu'un correctif reste hors de `main`.
**Architecture:** correctifs dans l'extension (backend + carte), garde shell `stranded-fixes` porté de core, tests navigateur de mise en page à trois largeurs, harness qui échoue au lieu de sauter en release.
**Tech Stack:** Node 20 CommonJS, vanilla JS/CSS, node:test, Puppeteer via le harness de core, sh.
**Spec:** `docs/superpowers/specs/2026-11-25-deploy-no-regression-design.md`
**Branche:** `fix/deploy-card-layout` (depuis `main` 879a556+feed3b9).

## Global Constraints
- Pas de couleur, rayon, police en dur nouveaux dans la carte : variables existantes de `deploy.css`.
- Pas de tiret cadratin ni d'emoji dans un texte affiché. Aucune animation.
- Aucun nom d'entreprise ou d'hôte réel dans le code ou les tests (corp.local, acme).

## Review Focus
- Hôte `[::1]` (Express 5 garde les crochets) : traité comme boucle locale.
- Machine sans IPv4 non interne : on garde l'hôte reçu, jamais `null`.
- Nom de projet très long + badge Protégé : le badge reste visible, le nom finit par `...`.
- Carte sans `lastSha` (pas de lien) dans la même rangée qu'une carte complète : boutons alignés en bas.
- `branch_gone` puis branche revenue : l'erreur s'efface aussi.

---

### Task 1: adresse partageable du site
**Files:** Create `extensions/deploy/backend/siteAddress.js`; Modify `backend/routes.js:515-519`; Test `backend/tests/deploySiteAddress.test.js`
**Produces:** `shareableHost(hostname: string, interfaces?: object) -> string`, `isLoopback(hostname) -> boolean`.
- [ ] Test : `shareableHost('127.0.0.1', nics)` → `192.168.1.103` (nics : loopback + `192.168.1.103` + `169.254.x`); `localhost`, `[::1]`, `::1` idem; `shareableHost('10.0.0.5', nics)` → `10.0.0.5`; sans IPv4 externe → hôte reçu; privée préférée à publique.
- [ ] Rouge, puis implémenter (ordre : RFC1918 non interne, sinon première IPv4 non interne hors 169.254, sinon l'hôte reçu). `siteUrl` utilise `shareableHost(req.hostname)`.
- [ ] Vert. Commit `fix(deploy): a site link opened on the server itself names its network address`.

### Task 2: `poll_failed` effacé par un sondage qui réussit
**Files:** Modify `backend/poller.js:119-145`; Test `backend/tests/deployPoller.test.js`
- [ ] Test : projet `{lastError:'poll_failed', failureCount:3}`, `branchHead` renvoie `{moved:false}` → enregistré avec `lastError:null`, `failureCount:0`. Même chose pour `branch_gone`. Une autre erreur (`build_failed`) n'est pas touchée.
- [ ] Implémenter, vert. Commit `fix(deploy): a poll that succeeds clears the poll error it left`.

### Task 3: espacement de la page (`dd3f7c3`)
- [ ] `git merge fix/deploy-page-spacing`, résoudre, `deploy-skin-margins.test.js` vert. Commit de merge.

### Task 4: carte projet
**Files:** Modify `frontend/src/js/deploy.js` (`projectCard`), `frontend/src/css/deploy.css` (cartes, grille); Test `frontend/tests/deploy-card-layout.test.js`
- [ ] Test navigateur à 1280, 768, 390 px, deux cartes (une protégée au nom de 80 caractères avec erreur, une simple) :
  bas des `.dep-card-actions` égal à ±1 px dans une rangée; chaque bouton de `.dep-card-actions` sur une ligne (hauteur ≤ 34 px); badge `.dep-card-lock` même `top` ±4 px que `.dep-card-name`; `.dep-card-name-text` `scrollWidth > clientWidth` et `text-overflow: ellipsis`; écart badge-nom ≥ 8 px; colonnes 3/2/1.
- [ ] Implémenter : `.dep-card-head` (nom + badge), `.dep-card-body{flex:1}`, `.dep-card-actions{margin-top:auto}`, boutons `white-space:nowrap`, grille 2 colonnes ≤ 75rem, 1 ≤ 40rem.
- [ ] Vert. Commit `fix(deploy): card actions sit at the bottom, Protected shares the name line`.

### Task 5: garde contre les correctifs restés en branche
**Files:** Create `.githooks/stranded-fixes`, `.githooks/stranded-fixes.allow`, `.githooks/pre-push`; Modify `frontend/tests/harness.js`, `scripts/local/release.mjs` (gitignoré), `PUBLISHING.md`.
- [ ] `stranded-fixes` : règle de core + branches `origin/*` + toute branche `fix/*`/`hotfix/*` ayant des commits hors `main`, conflit ou non.
- [ ] `.allow` : chaque branche de fonctionnalité restante avec sa raison.
- [ ] `harness.js` : avec `AEGIS_REQUIRE_PAGE_TESTS=1`, indisponible = échec. `release.mjs` : appelle `stranded-fixes`, passe la variable.
- [ ] `sh .githooks/stranded-fixes` sort 0 sur la branche finale. `git config core.hooksPath .githooks`. Commit `chore: refuse a push or release that strands a fix`.

### Task 6: vérification
- [ ] Suite backend + frontend de Deploy avec `AEGIS_TREE`, tout vert. Captures de la page à 1280/768 regardées.
