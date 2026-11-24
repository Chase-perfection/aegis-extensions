# Deploy : fréquentation par site, plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** chaque site servi par Deploy mesure ses visiteurs, ses visites, ses durées, ses pages et ses composants cliqués, et le projet affiche ces chiffres dans un onglet « Fréquentation ».

**Architecture:** le script `/__aegis/audience.js` est injecté dans les pages HTML par le mécanisme des notifications. Il envoie des lots d'événements à `POST /__aegis/audience`, que `siteServer` valide, pseudonymise (HMAC) et ajoute à un fichier brut par jour. `audienceReport` calcule visites, durées et totaux depuis le brut, et écrit à la clôture d'un jour un résumé avec une esquisse HyperLogLog. La route privée `GET /api/deploy/projects/:id/audience` les lit pour l'onglet.

**Tech Stack:** Node ≥ 20.19 (`node:test`, `node:crypto`, `fs`), JavaScript navigateur ES5 (comme `notices.js` et `deploy-notices.js`), aucune dépendance nouvelle.

**Spec:** `docs/superpowers/specs/2026-11-24-deploy-site-audience-design.md`. L'exécutant lit le spec et ce plan.

Racine du code : `4.6-Aegis.extensions/extensions/deploy/` (noté `deploy/`). Les commandes se lancent depuis `4.6-Aegis.extensions/`.

## Global Constraints

- Version : Deploy **0.2.16**, dans `deploy/extension.json` (`release`) et `deploy/store.json`.
- Aucune dépendance npm. Une extension n'importe que ses fichiers et la bibliothèque standard de Node (`CONTRACT.md`).
- Aucune donnée réelle de tenant : `corp.local`, `alice.martin`, `dt-plain`, slugs et noms inventés.
- Interface : pas de tiret cadratin (`—`), pas d'emoji, aucune animation en boucle, chiffres en `tabular-nums`.
- Tout texte venu d'un visiteur (chemin, nom de composant) s'écrit avec `textContent`, jamais `innerHTML`.
- Fichiers de moins de 500 lignes.
- Ne jamais écrire : adresse IP, nom d'utilisateur en clair, requête d'URL, fragment, titre de page, valeur d'un champ.
- Cookie `aegis_aud_<projet>` : 128 bits aléatoires en base64url, `Max-Age=34214400` (13 mois de 30,5 jours, soit 396 jours), `Path=/; HttpOnly; SameSite=Lax`, plus `; Secure` en HTTPS. Jamais reposé tant qu'il est présent.
- Conservation : brut 90 jours, résumés de jours 25 mois (760 jours).
- Limites : corps ≤ 16 384 octets, ≤ 50 événements par lot, `p` ≤ 200 caractères, `c` ≤ 80 caractères, `ms` entre 0 et 21 600 000. 240 `view`+`click` par visiteur et par minute, 200 000 `view`+`click` par site et par jour. Un `time` par `pv` et par tranche de 10 s, seulement pour un `pv` déjà accepté.
- Visite : trou > 30 min (1 800 000 ms) entre deux événements d'un même visiteur. Temps actif : interaction dans les 30 dernières secondes et onglet visible.
- Les textes du tableau de bord vivent dans `deploy-audience.js` (EN et FR), sous le préfixe `deploy_audience_`, fusionnés dans `window.translations` comme `deploy-notices.js`.
- Branche : `feature/deploy-audience` dans `4.6-Aegis.extensions`, créée depuis `main` seulement si `git status` est propre. Sinon, demander avant de toucher le dépôt.
- Les fichiers `.md` de `deploy/` peuvent porter des tirets cadratins anciens. N'en ajouter aucun.

## Review Focus

1. **Application d'une seule page qui change de chemin sans recharger** : une vue par chemin, temps attribué à la bonne vue. Test dans la tâche 8 (`pushState` change la vue, `replaceState` sur le même chemin ne la change pas).
2. **Visite à cheval sur minuit** : rangée dans le jour où elle commence, et comptée une seule fois sur une période de deux jours. Test dans la tâche 3.
3. **Site protégé, session expirée pendant que la page reste ouverte** : le lot reçoit `204`, rien n'est écrit, aucune page d'erreur HTML. Test dans la tâche 5.
4. **Nom de composant venu d'une page hostile** (`<img onerror>` dans `aria-label`, caractères de contrôle, 10 000 caractères) : tronqué, nettoyé, rendu en texte. Tests dans les tâches 2 et 9.
5. **Jour clos alors que le serveur était arrêté** (plusieurs jours sans requête) : la clôture rattrape chaque jour manquant, une seule fois. Test dans la tâche 3.

---

### Task 1 : esquisse HyperLogLog

**Files:**
- Create: `deploy/backend/hll.js`
- Test: `deploy/backend/tests/deployHll.test.js`

**Interfaces:**
- Produces :
  - `create() -> Uint8Array(1024)` : registres à zéro.
  - `add(sketch: Uint8Array, hex: string) -> void` : `hex` fait au moins 16 caractères hexadécimaux, ceux d'un `vis`.
  - `merge(into: Uint8Array, other: Uint8Array) -> void` : maximum registre par registre.
  - `count(sketch: Uint8Array) -> number` : entier arrondi.
  - `encode(sketch) -> string` (base64) et `decode(b64: string) -> Uint8Array | null` (null si la longueur ne vaut pas 1024).

Algorithme : p = 10, m = 1024. Les 64 bits de `hex` sont lus comme `BigInt('0x' + hex.slice(0, 16))`. Les 10 bits de poids fort donnent l'index. Le registre reçoit le rang du premier bit à 1 dans les 54 bits restants, plus 1, plafonné à 55. Estimation : `alpha = 0.7213 / (1 + 1.079 / m)`, `E = alpha * m² / Σ 2^-M[j]`. Si `E ≤ 2,5 m` et qu'il y a V registres à zéro, la valeur est `m * ln(m / V)`.

- [ ] **Step 1 : écrire les tests qui échouent**

```js
test('an empty sketch counts zero', () => assert.strictEqual(hll.count(hll.create()), 0));
test('the same visitor added twice counts once', () => { const s = hll.create(); hll.add(s, 'a1b2c3d4e5f60718'); hll.add(s, 'a1b2c3d4e5f60718'); assert.strictEqual(hll.count(s), 1); });
test('10 000 distinct visitors count within 5 %', () => { /* vis = sha256(String(i)).slice(0,16) */ assert.ok(Math.abs(n - 10000) / 10000 < 0.05); });
test('merging two halves equals adding everything to one sketch', () => { assert.deepStrictEqual(merged, whole); });
test('a sketch survives encode then decode', () => { assert.deepStrictEqual(hll.decode(hll.encode(s)), s); });
test('decode refuses a wrong length', () => assert.strictEqual(hll.decode(Buffer.alloc(10).toString('base64')), null));
```

- [ ] **Step 2 : lancer, vérifier l'échec** — `node --test extensions/deploy/backend/tests/deployHll.test.js`. Attendu : FAIL, `Cannot find module '../hll'`.
- [ ] **Step 3 : implémenter `hll.js`** comme décrit ci-dessus.
- [ ] **Step 4 : relancer** — attendu : 6 tests PASS.
- [ ] **Step 5 : commit** — `git add extensions/deploy/backend/hll.js extensions/deploy/backend/tests/deployHll.test.js && git commit -m "feat(deploy): anonymous visitor sketch for audience counts"`

### Task 2 : validation d'un lot, visiteur, limites

**Files:**
- Create: `deploy/backend/audience.js`
- Test: `deploy/backend/tests/deployAudience.test.js`

**Interfaces:**
- Produces :
  - `AUDIENCE_PATH = '/__aegis/audience'`, `SCRIPT_PATH = '/__aegis/audience.js'`, `LIMITS` (valeurs des Global Constraints).
  - `parseBatch(buf: Buffer) -> { events: Event[] } | { error: 'too_large' | 'bad_json' | 'bad_version' | 'too_many' }`. `Event = { k: 'view'|'click'|'time', pv: string, p: string, c?: string, ms?: number }`. Un événement invalide est retiré sans faire échouer le lot.
  - `cleanText(raw: string, max: number) -> string` : caractères de contrôle (U+0000-U+001F, U+007F-U+009F, U+2028, U+2029) remplacés par une espace, espaces réduites, coupé à `max`.
  - `isBot(userAgent: string) -> boolean` : `/bot|crawler|spider|headless|curl|wget|python/i`.
  - `visitorId(key: Buffer, projectId: string, who: { username?: string, cookie?: string }) -> string` : 16 hex. Calcule `HMAC-SHA256(key, 'u:' + projectId + ':' + username.toLowerCase())` si `username`, sinon `'c:' + projectId + ':' + cookie`.
  - `newCookieValue() -> string` : 22 caractères base64url de 16 octets aléatoires.
  - `cookieName(projectId) -> 'aegis_aud_' + projectId`. `cookieHeader(projectId, value, secure) -> string`.
  - `createLimiter({ now?: () => number }) -> { admit(slug, projectId, vis, events: Event[]) -> Event[] }`. Applique les trois limites des Global Constraints. Avertit une fois par jour et par site, par `console.warn`, quand la limite du site est atteinte.
  - `COOKIE_RE = /^[A-Za-z0-9_-]{22}$/` : un cookie qui ne respecte pas cette forme est traité comme absent.

- [ ] **Step 1 : écrire les tests qui échouent**

```js
test('a valid batch keeps its three kinds', ...)                      // view, click, time
test('a batch over 16 KiB is too_large', ...)
test('a batch of 51 events is too_many', ...)
test('v other than 1 is bad_version', ...)
test('an event with a query or fragment keeps the path only', ...)    // p:'/a?x=1#y' -> '/a'
test('a path that does not start with / is dropped, the rest kept', ...)
test('a 10 000 character component is cut to 80', ...)
test('control characters in a component become spaces', ...)        // 'a\u0000b c' -> 'a b c'
test('ms above six hours or negative drops the event', ...)
test('the same username in two cases is the same visitor', ...)
test('the same username on two projects is two visitors', ...)
test('a cookie visitor never equals a username visitor', ...)
test('the visitor id holds no part of the username', ...)            // !id.includes('alice')
test('the 241st view in one minute is refused, a time event still passes', ...)
test('a time event for an unknown pv is refused', ...)
test('two time events for one pv within 10 s keep the first', ...)
test('the site cap counts view and click only, and warns once a day', ...)
test('curl and HeadlessChrome are bots, a desktop browser is not', ...)
test('the cookie header carries Max-Age=34214400, HttpOnly, SameSite=Lax, and Secure only when asked', ...)
```

- [ ] **Step 2 : lancer, vérifier l'échec** — `node --test extensions/deploy/backend/tests/deployAudience.test.js`. Attendu : FAIL, module introuvable.
- [ ] **Step 3 : implémenter `audience.js`** selon les interfaces. `parseBatch` lit `JSON.parse(buf.toString('utf8'))` dans un `try`. `pv` suit `/^[a-z0-9]{8,32}$/`.
- [ ] **Step 4 : relancer** — attendu : tous PASS.
- [ ] **Step 5 : commit** — `feat(deploy): validate and pseudonymise audience batches`

### Task 3 : stockage, visites, clôture, purge

**Files:**
- Create: `deploy/backend/audienceStore.js` (fichiers : clé, ajout, lecture, clôture, purge, suppression)
- Create: `deploy/backend/audienceReport.js` (calculs purs, sans `fs`)
- Test: `deploy/backend/tests/deployAudienceStore.test.js`, `deploy/backend/tests/deployAudienceReport.test.js`

**Interfaces:**
- Consumes : `hll.*` (tâche 1), `machineStore.encrypt(plaintext) / decrypt(packed)` (`machineStore.js:290`), `projectStore.deployRoot(tenantPaths)` (`projectStore.js:32`, à exporter s'il ne l'est pas).
- Produces, `audienceReport.js` :
  - `Line = { t: number, vis: string, k, pv, p, c?, ms? }`.
  - `summarize(lines: Line[], { dayOf: (t) => 'AAAA-MM-JJ' }) -> { byDay: { [day]: DaySummary }, totals, pages, components, visitorSet: Set<string> }`. `DaySummary = { day, visitors, visits, activeMs, sketch: string, pages: { [path]: { views, visitors, activeMs } }, components: { [path + '\u0000' + name]: { clicks, visitors } } }`.
  - Visites : les lignes sont triées par `vis` puis par `t`. Une nouvelle visite commence quand l'écart dépasse 1 800 000 ms. La visite appartient au `dayOf(t)` de sa première ligne. Sa durée est la somme, sur ses `pv`, du plus grand `ms`. Le temps d'une `pv` va à sa page, celle de sa ligne `view`.
  - `capDay(summary, 500) -> DaySummary` : au-delà de 500 pages ou composants, le reste est cumulé sous la clé `(autres)`.
  - `combine(daySummaries: DaySummary[], liveLines: Line[]) -> Report` : totaux additionnés, visiteurs par fusion d'esquisses, visiteurs de page et de composant additionnés par jour.
- Produces, `audienceStore.js` :
  - `dirFor(tenantPaths, projectId) -> string` : `<deployRoot>/audience/<projectId>`.
  - `keyFor(tenantPaths) -> Buffer` : lit `<deployRoot>/audience/key.json`, `{ v: 1, key: encrypt(hex) }`, ou le crée (32 octets). En cache par tenant.
  - `append(tenantPaths, projectId, lines: Line[]) -> Promise<void>` : `raw/<jour>.jsonl`, une file de promesses par fichier.
  - `readRaw(tenantPaths, projectId, day) -> Line[]` : ignore une ligne illisible.
  - `close(tenantPaths, projectId, today: string) -> number` : écrit `days/<jour>.json` pour chaque jour brut antérieur à `today` sans résumé. Retourne le nombre écrit. Une visite qui commence la veille et finit après minuit reste dans le jour où elle commence. Pour cela, `close` lit aussi le brut du jour suivant quand il existe.
  - `purge(tenantPaths, projectId, today) -> void` : brut de plus de 90 jours, `days/` de plus de 760 jours.
  - `removeProject(tenantPaths, projectId) -> void` : `fs.rmSync(dir, { recursive: true, force: true })`.
  - `report(tenantPaths, projectId, from: string, to: string, today: string) -> Report`. `Report = { from, to, visitorsPrecision: 'day' | 'estimate', totals: { visitors, visits, activeMs, avgVisitMs }, series: [{ day, visitors, visits, activeMs }], pages: [{ path, views, visitors, activeMs }], components: [{ path, name, clicks, visitors }] }`. Si `from ≥ today - 89 jours`, tout vient du brut (`'day'`). Sinon, résumés plus brut du jour (`'estimate'`). Listes triées par vues et par clics, 100 au plus. Chaque jour de la période figure dans `series`, à zéro s'il est vide.
  - `dayOf(t) -> 'AAAA-MM-JJ'` en heure locale du serveur.

- [ ] **Step 1 : tests de `audienceReport` qui échouent**

```js
test('two events 29 min apart are one visit, 31 min apart are two', ...)
test('a visit lasts the sum of the largest ms of each pv', ...)        // pv1: 10s puis 25s, pv2: 5s -> 30 000
test('a visit that starts at 23:50 and runs past midnight belongs to its first day and counts once over two days', ...)
test('page visitors count distinct vis with a view on that page', ...)
test('component clicks group by path and name', ...)
test('capDay keeps 500 pages and folds the rest under (autres)', ...)
test('combine over three days estimates visitors from the sketches, not by summing', ...)  // même vis sur 3 jours -> 1
```

- [ ] **Step 2 : tests de `audienceStore` qui échouent** (`AEGIS_DATA_ROOT` dans `os.tmpdir()`, comme `deployNotices.test.js`)

```js
test('the key is created once, stored encrypted, and read back the same', ...)  // le fichier ne contient pas la clé en hex
test('two concurrent appends to one day give whole lines', ...)
test('close writes one summary per closed day and none for today', ...)
test('close after five silent days catches up every day once', ...)      // Review Focus 5
test('purge removes raw older than 90 days and summaries older than 760 days', ...)
test('report within 90 days is exact, beyond is an estimate', ...)
test('report lists every day of the period, empty ones at zero', ...)
test('removeProject deletes the project folder and nothing else', ...)
test('a raw file holds no ip, no username and no query', ...)
```

- [ ] **Step 3 : lancer, vérifier l'échec** — `node --test extensions/deploy/backend/tests/deployAudienceReport.test.js extensions/deploy/backend/tests/deployAudienceStore.test.js`. Attendu : FAIL.
- [ ] **Step 4 : implémenter `audienceReport.js` puis `audienceStore.js`**.
- [ ] **Step 5 : relancer** — attendu : tous PASS.
- [ ] **Step 6 : commit** — `feat(deploy): store, close and report audience by day`

### Task 4 : réglage `audience` et injection du script

**Files:**
- Modify: `deploy/backend/siteNotices.js` (`inject`, `scriptTag`, lignes 207-231)
- Modify: `deploy/backend/siteConfig.js` (`settingsFor`, lignes 252-268)
- Modify: `deploy/backend/siteServer.js` (`proxyTo` ligne 294, `withNotices` ligne 430, chemin statique lignes 608-610, `serve` ligne 576)
- Modify: `deploy/backend/routes.js` (`POST /api/deploy/projects/:id/settings`, lignes 2030-2115 ; vue projet ligne 1180)
- Test: `deploy/backend/tests/deployNotices.test.js` (ajouts), `deploy/backend/tests/deployAudienceInject.test.js`

**Interfaces:**
- Consumes : `audience.SCRIPT_PATH` (tâche 2).
- Produces :
  - `siteNotices.inject(buf, release, { notices = true, audience = false } = {}) -> Buffer`. Ajoute `<script src="/__aegis/notices.js" data-release=… defer></script>` si `notices`, et `<script src="/__aegis/audience.js" defer></script>` si `audience`. Une balise déjà présente dans la page n'est pas répétée. L'appel à deux arguments garde son comportement actuel.
  - `siteNotices.wantsInjection(settings) -> boolean` : `settings.notices.inject || settings.audience.enabled`.
  - `siteConfig.settingsFor(...)` renvoie en plus `audience: { enabled: boolean }`, `false` par défaut.
  - `normalizeAudience(raw) -> { enabled: boolean }`, dans `audience.js`. Elle lève `{ code: 'bad_audience' }` si `raw` n'est pas un objet ou si `enabled` n'est pas un booléen.
  - Route des réglages : `body.audience` est accepté seul (ajouté au contrôle `no_settings`), validé avant toute écriture, et stocké dans `project.audience`. `siteConfig.invalidate(slug, id)` est appelé comme pour les notifications. La vue projet expose `audience: { enabled }`.
  - `proxyTo` reçoit `ctx.audience` à côté de `ctx.notices`. La condition `addNotices` devient `wantsInjection` et `wantsPage(req)`.

- [ ] **Step 1 : tests qui échouent**

```js
test('inject with two arguments is unchanged', ...)                       // non-régression de deployNotices.test.js
test('inject adds the audience tag only when audience is on', ...)
test('inject with notices off and audience on adds the audience tag alone', ...)
test('a page that already carries audience.js is left alone', ...)
test('a static page gets the audience tag when notices.inject is false and audience is on', ...)
test('a proxied page gets the tag under the same rule', ...)
test('settings accept { audience: { enabled: true } } alone and the next request sees it', ...)
test('settings refuse audience.enabled = "yes" with bad_audience and write nothing', ...)
test('a project that never saved audience reads enabled false', ...)
```

- [ ] **Step 2 : lancer, vérifier l'échec**.
- [ ] **Step 3 : implémenter** les quatre modifications.
- [ ] **Step 4 : relancer** les deux fichiers, puis `deploySiteConfig.test.js` et `deployProxyIdentity.test.js`. Attendu : tous PASS.
- [ ] **Step 5 : commit** — `feat(deploy): per-site audience switch and script injection`

### Task 5 : point de collecte et guard

**Files:**
- Modify: `deploy/backend/siteAuth.js` (`ASSETS` ligne 93, `isSitePath` ligne 119, `gate` : site ouvert ligne 1497, site protégé avant le bloc `write` ligne 1631)
- Modify: `deploy/backend/siteServer.js` (`serve`, à côté de `DATA_PATH` ligne 564)
- Create: `deploy/frontend/site-auth/audience.js` (vide à cette étape : `'use strict';`, rempli en tâche 8)
- Test: `deploy/backend/tests/deployAudienceCollect.test.js`

**Interfaces:**
- Consumes : tâches 2, 3 et 4. `siteAuth.fromOwnOrigin(req)` (ligne 1431, à exporter), `siteAuth.identityFor(req, ctx)`, `siteAuth.readCookie`.
- Produces :
  - `ASSETS['/__aegis/audience.js'] = { file: 'audience.js', type: 'text/javascript; charset=utf-8' }`. Il est servi comme `notices.js` sur un site ouvert, et derrière la porte sur un site protégé.
  - `isSitePath` inclut `audience.AUDIENCE_PATH`.
  - Dans `gate`, sur un site protégé : un `POST` vers `AUDIENCE_PATH` avec une session passe à `siteServer` sans `recheckWrite`. Sans session, la réponse est `204` sans corps et rien d'autre.
  - `siteServer.serveAudience(req, res, ctx) -> void` applique l'ordre des contrôles du spec §3 : désactivé, puis `204` ; méthode autre que POST, puis `405` ; `fromOwnOrigin` faux, puis `403` ; `parseBatch` en erreur, puis `413` ou `400` ; robot, puis `204` ; ensuite limites, horodatage serveur, `visitorId`, `append`. Le corps est lu jusqu'à 16 385 octets, au-delà la lecture s'arrête. La réponse est `204` avec `Cache-Control: no-store`, et le cookie est posé s'il manquait, uniquement sur un site ouvert. Le module garde un `createLimiter()` partagé. Un `audienceStore.close` pour ce projet est lancé au premier lot après minuit.

- [ ] **Step 1 : tests qui échouent** (requêtes simulées comme `deployNotices.test.js`, projets `dt-plain` ouvert et protégé)

```js
test('audience off: 204 and no file', ...)
test('GET on /__aegis/audience: 405', ...)
test('foreign Origin: 403 and no file', ...)
test('open site, first batch: 204, sets aegis_aud_<id> once, writes lines with server time', ...)
test('open site, batch with the cookie: no Set-Cookie', ...)
test('a malformed cookie is replaced, not hashed', ...)
test('protected site, signed in: the line carries the HMAC of the username, never the name', ...)
test('protected site, no session or expired session: 204, no file, no HTML', ...)   // Review Focus 3
test('protected site, signed in: no directory call is made for a batch', ...)      // _setVerifier compte les appels
test('bot user agent: 204, no file', ...)
test('a 17 KiB body: 413', ...)
test('the application behind the proxy never sees aegis_aud_ in its Cookie header', ...)
test('/__aegis/audience.js is served on an open site and 404 on a protected one without a session', ...)
```

- [ ] **Step 2 : lancer, vérifier l'échec**.
- [ ] **Step 3 : implémenter**.
- [ ] **Step 4 : relancer** ce fichier et `siteAuth.test.js`, `siteAuthOrigin.test.js`, `deployProxyCookies.test.js`. Attendu : tous PASS.
- [ ] **Step 5 : commit** — `feat(deploy): audience collection point behind the site guard`

### Task 6 : connexion comptée comme composant

**Files:**
- Modify: `deploy/backend/siteAuth.js` (à côté de `setAuditSink` ligne 606 ; appel ligne 1945)
- Modify: `deploy/backend/routes.js` (ligne 666, à côté de `siteAuth.setAuditSink`)
- Test: `deploy/backend/tests/deployAudienceCollect.test.js` (ajouts)

**Interfaces:**
- Produces : `siteAuth.setAudienceSink(fn | null)`. Après `audit(..., 'login', ...)`, l'appel est `audienceSink(slug, tenantPaths, projectId, login)`, dans un `try`. `routes.register` branche un puits qui ne fait rien si `settingsFor(...).audience.enabled` est faux. Sinon il ajoute une ligne `{ k: 'click', pv: <aléatoire>, p: '/__aegis/login', c: 'aegis: Connexion', vis: visitorId(key, id, { username: login }) }`.

- [ ] **Step 1 : tests qui échouent** — `a successful sign-in adds one aegis: Connexion click when audience is on`, `no line when audience is off`, `a refused sign-in adds nothing`, `a sink that throws does not break the sign-in`.
- [ ] **Step 2 : lancer, vérifier l'échec**.
- [ ] **Step 3 : implémenter**.
- [ ] **Step 4 : relancer** ce fichier et `siteAuthJournal.test.js`. Attendu : PASS.
- [ ] **Step 5 : commit** — `feat(deploy): count site sign-ins in the audience`

### Task 7 : routes de lecture, d'effacement, et clôture planifiée

**Files:**
- Modify: `deploy/backend/routes.js` (nouvelles routes près de `preview.png`, ligne 2322 ; suppression de projet, ligne 1561 ; minuteur dans `register`)
- Test: `deploy/backend/tests/deployAudienceRoutes.test.js`

**Interfaces:**
- Consumes : `audienceStore.report / close / purge / removeProject` (tâche 3).
- Produces :
  - `GET /api/deploy/projects/:id/audience?from&to`, avec `requireOptIn` et sans `requireRole`, comme `preview.png`. `from` et `to` suivent `/^\d{4}-\d{2}-\d{2}$/` et doivent être des dates réelles. Valeurs par défaut : `to` aujourd'hui, `from` 29 jours avant. Refus `400 bad_period` si `from > to`, si la période dépasse 760 jours, ou si `to` est dans le futur. Réponse : `{ success: true, enabled, ...Report }`.
  - `DELETE /api/deploy/projects/:id/audience`, avec `requireRole('admin')`, appelle `removeProject` et répond `{ success: true }`.
  - La suppression d'un projet appelle aussi `audienceStore.removeProject`.
  - Minuteur : `setInterval(…, 3600000).unref()` dans `register`. Il appelle `close` et `purge` pour chaque projet de chaque tenant qui a un dossier `audience/`.

- [ ] **Step 1 : tests qui échouent** — `report defaults to the last 30 days`, `a viewer role reads the report`, `from after to is bad_period`, `a 761 day period is bad_period`, `an impossible date 2026-02-30 is bad_period`, `DELETE needs admin and empties the folder`, `deleting the project removes its audience folder`, `the report never contains a vis value`.
- [ ] **Step 2 : lancer, vérifier l'échec**.
- [ ] **Step 3 : implémenter**.
- [ ] **Step 4 : relancer** — attendu : PASS.
- [ ] **Step 5 : commit** — `feat(deploy): audience report and erase routes`

### Task 8 : script de mesure dans la page

**Files:**
- Modify: `deploy/frontend/site-auth/audience.js`
- Test: `deploy/backend/tests/deployAudienceScript.test.js`. Le script est chargé dans `vm` avec un faux `window`, `document`, `history` et `navigator`, sur le modèle des tests de `notices.js`, s'il y en a. Sinon les faux objets sont construits dans le test.

**Interfaces:**
- Produces : un IIFE ES5. Pour les tests, il expose `window.__aegisAudience = { nameOf(el) -> string|null, flush() }` seulement si `window.__aegisAudienceTest === true` avant le chargement.
- `nameOf` suit la chaîne du spec §2. Un id est « généré » s'il correspond à `/\d{4}|[0-9a-f]{8,}/i`. Le texte vient de `innerText || textContent`. Le préfixe est `tagName.toLowerCase() + ': '`. Le résultat fait 80 caractères au plus. `value` n'est jamais lue.
- Envoi : `navigator.sendBeacon('/__aegis/audience', new Blob([json], { type: 'text/plain' }))`. Repli : `fetch(..., { method: 'POST', keepalive: true, credentials: 'same-origin' })`. Le minuteur d'envoi vaut 15 s. Un lot fait 50 événements au plus, le reste attend l'envoi suivant.
- `navigator.globalPrivacyControl === true` : aucun écouteur, aucun envoi.

- [ ] **Step 1 : tests qui échouent**

```js
test('data-aegis-track wins over id and text', ...)
test('a generated id like btn-8f3a9c21d0 is skipped for aria-label', ...)
test('a button with text gives "button: Actualiser"', ...)
test('an input type=submit never exposes its value', ...)
test('a click inside a span inside a button names the button', ...)
test('a click on plain text outside any control sends nothing', ...)
test('pushState to a new path ends the view and starts another', ...)    // Review Focus 1
test('replaceState on the same path keeps the view', ...)
test('no interaction for 30 s stops the active time', ...)
test('a hidden tab does not count time', ...)
test('pagehide sends the pending events with sendBeacon', ...)
test('the path sent never carries ?query or #hash', ...)
test('GPC on: no listener and no beacon', ...)
test('a throwing sendBeacon does not throw into the page', ...)
```

- [ ] **Step 2 : lancer, vérifier l'échec**.
- [ ] **Step 3 : implémenter**, sans aucune animation ni élément visible.
- [ ] **Step 4 : relancer** — attendu : PASS.
- [ ] **Step 5 : commit** — `feat(deploy): in-page audience script`

### Task 9 : onglet Fréquentation et réglage dans Paramètres

**Files:**
- Create: `deploy/frontend/src/js/deploy-audience.js`
- Modify: `deploy/frontend/src/js/deploy.js` (`PROJECT_TABS` ligne 2896 : `{ id: 'audience', labelKey: 'deploy_tab_audience', labelFallback: 'Audience', render: audienceTab, hiddenForPreview: false }` après `overview` ; `audienceTab(project)` délègue à `window.DeployAudience.tab(project)` ; `settingsTab` ligne 3268 ajoute `window.DeployAudience.section(project)` après les notifications ; `DeployKit` ligne 7400 inchangé sauf besoin réel)
- Modify: `deploy/frontend/pages/deploy.html` (ligne 790 : `<script defer src="../src/js/deploy-audience.js"></script>`)
- Modify: `deploy/frontend/src/css/deploy.css` (classes `dep-aud-*`, variables existantes seulement)
- Test: `deploy/frontend/tests/deploy-audience.test.js` (harnais de `harness.js`, `AEGIS_TREE` pointé sur une copie du cœur)

**Interfaces:**
- Consumes : `GET/DELETE /api/deploy/projects/:id/audience`, `POST .../settings { audience }` (tâches 4 et 7), `window.DeployKit.{ tr, el, isAdmin }`.
- Produces : `window.DeployAudience = { tab(project) -> HTMLElement, section(project) -> HTMLElement }`.
- Écran selon le croquis du spec §6. Périodes : 7 j, 30 j, 90 j, 12 mois, plus une plage libre avec deux `<input type="date">`. Indicateurs : visiteurs uniques, visites, durée moyenne d'une visite, temps total. Graphique en barres SVG statique, une barre par jour, sans transition. Tables des pages et des composants. Un clic sur une page filtre les composants, un second clic retire le filtre. Mention « estimation, environ 3 % près » quand `visitorsPrecision === 'estimate'`. États : désactivé (lien vers `#project/<id>/settings`), vide, erreur avec « Réessayer ».
- Section Paramètres : une case « Mesurer la fréquentation de ce site », désactivée pour un rôle non administrateur. Un texte d'aide : « Mentionnez la mesure d'audience dans la page de confidentialité du site. » Un bouton « Effacer les données de fréquentation », avec une confirmation qui nomme le site.
- Durées : `formatDuration(ms)` en `s`, `min s`, `h min`.

- [ ] **Step 1 : tests qui échouent** — `the Audience tab sits after Overview`, `audience off shows the link to Settings`, `KPIs read the totals of the stubbed report`, `a component name with <img onerror> is shown as text`, `clicking a page filters the components`, `the estimate note shows past 90 days`, `the switch is disabled for a non-admin`, `erase asks first, then calls DELETE`, `no element on the tab has an animation or transition`.
- [ ] **Step 2 : lancer, vérifier l'échec** — `$env:AEGIS_TREE = "<chemin du cœur>"; node --test extensions/deploy/frontend/tests/deploy-audience.test.js`.
- [ ] **Step 3 : implémenter**. Textes EN et FR dans `STRINGS`, sans tiret cadratin.
- [ ] **Step 4 : relancer** ce fichier et `deploy-page.test.js`. Attendu : PASS.
- [ ] **Step 5 : commit** — `feat(deploy): audience tab and settings switch`

### Task 10 : documentation, version, suites, essai réel

**Files:**
- Modify: `deploy/CHANGELOG.md` (section `## 0.2.16`), `deploy/DEPLOY-CONTRACT.md` (le script, `/__aegis/audience`, `data-aegis-track`, le cookie), `deploy/ADDING-A-SITE.md` (une ligne sur `data-aegis-track`), `deploy/extension.json` et `deploy/store.json` (`0.2.16`).

- [ ] **Step 1 : rédiger** CHANGELOG, contrat et guide, sans tiret cadratin dans les lignes ajoutées.
- [ ] **Step 2 : passer la version à 0.2.16** dans `extension.json` et `store.json`.
- [ ] **Step 3 : suite de l'extension** — `npm test` dans `4.6-Aegis.extensions` (lancé en arrière-plan). Attendu : 0 échec. Un échec `EBUSY` ou un dépassement à 15 s d'un test Puppeteer se relance seul, deux fois, avant d'être considéré comme réel.
- [ ] **Step 4 : suites navigateur** — `$env:AEGIS_TREE = "<cœur>"; node --test extensions/deploy/frontend/tests/`. Attendu : 0 échec.
- [ ] **Step 5 : suite du cœur** — dans le worktree du cœur, `npm test` dans `backend/` puis dans `frontend/` (en arrière-plan). Attendu : 0 échec, ou seulement les échecs déjà présents sur `main`, listés avec leur sortie.
- [ ] **Step 6 : essai réel sur l'env de test** (`http://127.0.0.1:4810`, tenants `dt-plain` et `dt-tls`). Activer la fréquentation sur un site de `dt-plain`, naviguer sur trois pages, cliquer deux boutons, fermer l'onglet. Ouvrir l'onglet Fréquentation : 1 visiteur, 1 visite, 3 pages, 2 composants. Refaire l'essai sur un site protégé de `dt-tls` après connexion : `aegis: Connexion` apparaît.
- [ ] **Step 7 : commit** — `docs(deploy): audience in contract, guide and changelog; 0.2.16`. Rien n'est poussé ni publié sans l'accord de Paul.
</content>
</invoke>
