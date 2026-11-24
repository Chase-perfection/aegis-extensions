# Deploy : fréquentation de chaque site servi

Date : 2026-11-24. Statut : conception, en attente de validation par Paul.

## Intention

Paul veut savoir, pour chaque site que Deploy sert, s'il est utilisé : combien de
personnes l'ont visité et combien de temps. Quand il veut creuser : quelles pages
sont vues et combien de temps, et quels éléments reçoivent le plus de clics
(exemples cités : le bouton actualiser, le bouton login). Un tableau de bord par
site, sur une période qu'il choisit.

Le nom affiché est **Fréquentation** (EN : **Audience**). « Usage » est déjà pris :
le volet `#usage` de Deploy montre les ports et les comptes d'exécution consommés.

## Objectifs

1. Vue d'ensemble par site : visiteurs uniques, visites, durée totale et durée
   moyenne d'une visite, sur une période choisie.
2. Détail par page : vues, visiteurs, temps actif total et moyen par vue.
3. Détail par composant : les éléments les plus cliqués, avec la page où ils
   l'ont été.

## Non-objectifs

- Pas de liste nominative des visiteurs, même sur un site protégé (choix de Paul).
- Pas de provenance externe, de géolocalisation, d'appareil ou de navigateur.
- Pas de suivi d'un site à l'autre : l'identifiant d'un visiteur est propre à un site.
- Pas de rejeu de session, pas de carte de chaleur, pas de capture de saisie.
- Pas d'export dans cette livraison.

## Anti-objectifs

Ce qui ferait échouer la fonction même si elle tourne :

- un champ de saisie, un mot de passe ou une requête d'URL qui atterrit dans les
  données ;
- l'adresse IP stockée ;
- un nom d'utilisateur en clair dans les fichiers de fréquentation ;
- un cookie de fréquentation que l'application du site peut lire ;
- un point de collecte public qui laisse un inconnu remplir le disque ;
- un texte venu d'un visiteur rendu en HTML dans le tableau de bord ;
- une page du site plus lente ou cassée parce que le script a échoué.

## Contraintes

- Deploy 0.2.15 : le proxy retire tout cookie `aegis_*` / `aegis.*` dans les deux
  sens. Il vérifie l'`Origin` sur la connexion et la déconnexion. `/__aegis/`
  est réservé par `siteAuth`.
- RGPD et dispense de consentement CNIL pour la mesure d'audience. Finalité
  limitée aux statistiques du site. Cookie de 13 mois au plus, jamais prolongé.
  Données de 25 mois au plus. Pas de recoupement avec d'autres traitements.
- Pas de donnée réelle de tenant dans le code ni les tests (`corp.local`, noms
  inventés).
- Interface : pas de tiret cadratin, pas d'emoji, aucune animation en boucle.
- Fichiers de moins de 500 lignes.
- Un numéro de version de Deploy se propose à Paul avant d'être fixé.

## Décisions de Paul (2026-11-24)

| Sujet | Choix |
|---|---|
| Collecte | Script injecté par Deploy dans les pages HTML. Pas de journaux du proxy. |
| Compter une personne | Pseudonyme partout. Site protégé : empreinte HMAC du nom d'utilisateur. Site public : cookie aléatoire posé par Deploy, 13 mois. |
| Conservation | Événements bruts 90 jours. Totaux par jour, avec une esquisse anonyme des visiteurs (HyperLogLog), 25 mois. |
| Accès au tableau | Tout rôle qui ouvre Deploy. |
| Version | Deploy 0.2.16. |
| Nommer un composant | Chaîne automatique : `data-aegis-track`, `id`, `aria-label`, texte visible (40 caractères), sinon balise et chemin CSS court. Jamais la valeur d'un champ. |
| Stockage | Fichiers par jour dans `<tenant>/deploy/audience/<projet>/`. |

## Approches considérées

**Collecte.**
- Script injecté (retenu) : la seule source qui voit la durée active, la
  navigation interne d'une application d'une seule page et les clics.
- Script et journaux du proxy : rattrape les visiteurs sans JavaScript, au prix
  de deux sources à dédoublonner. Gain faible sur des applications qui exigent
  JavaScript.
- Journaux du proxy seuls : ne couvre ni les durées ni les clics.

**Stockage.**
- Fichiers par jour (retenu) : c'est la façon dont Deploy range déjà son état
  par tenant. Aucun schéma dans le cœur. Supprimer le projet supprime le dossier.
- SQLite du tenant : requêtes souples, mais migration dans le cœur pour une
  donnée propre à Deploy, et une base qui grossit à chaque clic.
- Totaux en mémoire : pas de brut, donc les 90 jours de détail sont impossibles.

## Conception

### 1. Activation, par site

`project.audience = { enabled: boolean }`. Absent vaut `false`. La valeur se
règle dans l'onglet Paramètres du projet, dans une section « Fréquentation »
placée sous les notifications. Elle s'enregistre par les routes existantes
`POST` et `PATCH /api/deploy/projects/:id/settings` (routes.js:2030 et 2137), qui
reçoivent le champ `audience`. `audience` s'ajoute à la liste des champs connus
du contrôle `no_settings` (routes.js:2042), pour qu'un corps qui ne porte que lui
soit accepté. Une valeur d'un autre type est refusée (`bad_audience`), sans
conversion. Le réglage prend effet sans redémarrage : `siteConfig.settingsFor`
est relu à chaque requête (siteServer.js:565), et la collecte y lit `enabled`.

Le texte d'aide dit en une phrase ce que le site doit faire : mentionner la mesure
d'audience dans sa page de confidentialité. Rien d'autre n'est imposé.

Désactiver arrête la collecte et garde les données jusqu'à leur échéance. Un
bouton « Effacer les données de fréquentation » les supprime tout de suite, après
confirmation.

### 2. Le script `/__aegis/audience.js`

C'est un fichier statique, servi par `siteAuth` comme `notices.js`, rangé dans
`frontend/site-auth/audience.js`. Il est injecté par la même fonction que les
notifications. `siteNotices.inject` devient une injection de balises : celle des
notifications si `notices.inject`, celle de la fréquentation si
`audience.enabled`. La balise d'un script déjà présent dans la page n'est pas
ajoutée une seconde fois. Les deux chemins d'injection, le fichier statique
(`siteServer.js:608`) et le proxy (`withNotices`), testent désormais « au moins
une balise à ajouter » au lieu de `notices.inject`.

Comportement :

- **Une vue** commence au chargement de la page. Elle recommence à chaque
  `pushState`, `replaceState` qui change le chemin, ou `popstate` : c'est la
  navigation d'une application d'une seule page. Chaque vue a un identifiant
  aléatoire `pv`.
- **Chemin** : `location.pathname` seul. Ni requête, ni fragment, ni titre de
  page. 200 caractères au plus.
- **Temps actif** : le temps compte quand l'onglet est visible et qu'une
  interaction (souris, clavier, défilement, toucher) a eu lieu dans les 30
  dernières secondes. Le compteur s'arrête sinon.
- **Clic** : un écouteur en phase de capture sur `document`. Il remonte de la
  cible jusqu'au premier élément interactif : `a`, `button`, `summary`,
  `select`, `label`, `[role=button|link|tab|menuitem|checkbox|switch]`,
  `input[type=button|submit|reset|checkbox|radio]`, ou un ancêtre portant
  `data-aegis-track`. Un clic hors de tout élément interactif n'est pas compté.
- **Nom du composant**, premier qui répond :
  1. `data-aegis-track` ;
  2. `#id`, sauf si l'id ressemble à un id généré (contient 4 chiffres d'affilée
     ou un segment hexadécimal de 8 caractères ou plus) ;
  3. `aria-label` ;
  4. texte visible, seulement pour `a`, `button`, `summary` et les rôles
     ci-dessus : `innerText` réduit aux espaces simples, 40 caractères ;
  5. `balise.classe` (première classe) suivi du chemin `nth-of-type` jusqu'au
     premier ancêtre qui a un id, 3 niveaux au plus.

  Le nom est préfixé par la balise, par exemple `button: Actualiser`. Une valeur
  de champ (`value`) n'est jamais lue, y compris pour `input[type=submit]`, dont
  le libellé passe par `aria-label` ou retombe au niveau 5. 80 caractères au plus.
- **Envoi** : les événements sont regroupés et envoyés par
  `navigator.sendBeacon` en `POST /__aegis/audience`, corps JSON en
  `text/plain`. L'envoi part toutes les 15 secondes s'il y a quelque chose à
  envoyer, et à `visibilitychange` vers `hidden` ou `pagehide`. Au plus 50
  événements par envoi. Le temps actif part dans un événement `time` qui porte
  le cumul de la vue en cours. Le serveur garde le plus grand cumul reçu pour un
  `pv`.
- **Signal de refus** : si `navigator.globalPrivacyControl === true`, le script
  ne fait rien. C'est mon choix : il respecte le visiteur qui a dit non, et la
  perte est faible en interne.
- **Robustesse** : tout est enfermé dans un `try`. Une erreur arrête la mesure,
  jamais la page. Aucune dépendance, aucun appel bloquant, aucune animation.

Format d'un envoi :

```json
{ "v": 1, "events": [
  { "k": "view",  "pv": "q1w2e3r4", "p": "/stock", "t": 1764000000000 },
  { "k": "click", "pv": "q1w2e3r4", "p": "/stock", "c": "button: Actualiser", "t": 1764000004000 },
  { "k": "time",  "pv": "q1w2e3r4", "p": "/stock", "ms": 41000, "t": 1764000041000 }
] }
```

### 3. Le point de collecte `POST /__aegis/audience`

Il est répondu par `siteServer.serve` avant l'application, comme
`/__aegis/notices`. `/__aegis/audience` s'ajoute à `isSitePath`
(siteAuth.js:119). Sur un site ouvert, le guard le laisse passer comme les autres
chemins du site. Sur un site protégé, la collecte exige une session valide : sans
elle, la réponse est `204` et rien n'est écrit. La collecte ne passe pas par le
chemin d'écriture de `gate`, qui attend l'annuaire, et elle ne demande pas de
jeton CSRF : `sendBeacon` ne peut pas poser d'en-tête. Le contrôle d'`Origin`
ci-dessous protège la collecte (mon choix). La page de connexion n'a pas de
script.

Contrôles, dans l'ordre :

1. `audience.enabled` est faux : réponse `204`, rien n'est écrit.
2. Méthode autre que `POST` : `405`.
3. `Origin` absent ou différent de l'hôte servi : `403`. La règle est la même
   qu'à la connexion, et la fonction est réutilisée, pas recopiée.
4. Corps de plus de 16 Kio : `413`. JSON invalide, `v` différent de 1, ou plus
   de 50 événements : `400`.
5. `User-Agent` d'un robot connu (`bot|crawler|spider|headless|curl|wget|python`) :
   `204`, rien n'est écrit.
6. Limite par visiteur : 240 événements `view` et `click` par minute, en
   mémoire. Au-delà, l'excédent est ignoré.
7. Limite par site : 200 000 événements `view` et `click` par jour. Au-delà,
   l'excédent est ignoré et un avertissement est écrit une fois par jour dans la
   console.
8. Les événements `time` ne comptent dans aucune des deux limites, pour que les
   durées ne soient pas sous-estimées. Leur limite est propre : un seul est
   gardé par `pv` et par tranche de 10 secondes, et seulement pour un `pv` déjà
   vu par une `view` acceptée (mon choix).

Chaque événement est validé un par un. Un événement invalide est ignoré, le reste
est gardé. `k` vaut `view`, `click` ou `time`. `pv` suit `/^[a-z0-9]{8,32}$/`.
`p` commence par `/`, sans caractère de contrôle, 200 caractères au plus. `c` ne
contient pas de caractère de contrôle, 80 caractères au plus. `ms` est un entier
entre 0 et 6 heures. L'heure `t` du client n'est jamais crue : le serveur
horodate.

**Le visiteur**, `vis`, fait 16 caractères hexadécimaux. C'est un
HMAC-SHA256 calculé avec une clé propre au tenant et à la fréquentation :

- site protégé : `HMAC(clé, "u:" + projet + ":" + username en minuscules)`.
  L'identité vient de `siteAuth.identityFor(req)`, jamais du navigateur ;
- site public : `HMAC(clé, "c:" + projet + ":" + cookie)`. Le cookie
  `aegis_aud_<projet>` contient 128 bits aléatoires en base64url. Il est posé par
  la réponse de collecte quand il manque, avec `Max-Age` de 13 mois, `Path=/`,
  `HttpOnly`, `SameSite=Lax` et `Secure` en HTTPS. Il n'est jamais reposé tant
  qu'il est présent, donc jamais prolongé. Son préfixe `aegis_` le fait retirer
  par le proxy dans les deux sens : l'application ne le voit pas.

La clé fait 32 octets aléatoires. Elle est créée au premier usage, chiffrée avec
`machineStore.encrypt()` comme le mot de passe de l'annuaire, et rangée dans
`<tenant>/deploy/audience/key.json`. Perdre la clé fait compter chaque visiteur
comme nouveau, rien de plus. L'adresse IP n'est utilisée que pour la limite en
mémoire et n'est jamais écrite.

Réponse : `204` sans corps, `Cache-Control: no-store`.

Connexion à la page d'Aegis : sur un site protégé, une connexion réussie est
comptée comme un clic sur le composant `aegis: Connexion`, page `/__aegis/login`.
`siteAuth` le fait au même endroit qu'il appelle déjà `audit(..., 'login')`
(siteAuth.js:1945). Il le fait par un puits injecté depuis `routes.register`, sur
le modèle de `setAuditSink`, et seulement si la fréquentation du site est activée.
C'est le « bouton login » que Paul cite. C'est mon choix, à retirer s'il ne le
veut pas.

### 4. Stockage

```
<tenant>/deploy/audience/
  key.json                         clé HMAC chiffrée
  <projet>/
    raw/2026-11-24.jsonl           une ligne par événement accepté, 90 jours
    days/2026-11-24.json           résumé du jour avec son esquisse, 25 mois
```

Une ligne brute ressemble à :
`{"t":1764000004123,"vis":"a1b2c3d4e5f60718","k":"click","pv":"q1w2e3r4","p":"/stock","c":"button: Actualiser"}`.
Les écritures se font par ajout. Une file par fichier évite les lignes
entrelacées. Le jour se découpe à minuit, heure locale du serveur.

**Visite** : une suite d'événements d'un même visiteur, sans trou de plus de 30
minutes. Elle se calcule à la lecture du brut, jamais côté navigateur.
**Visiteurs d'un jour**, d'une page ou d'un composant : les visiteurs distincts
qui ont au moins un événement ce jour-là, sur cette page ou sur ce composant
(mon choix).
**Durée d'une visite** : somme des temps actifs des vues de la visite, en
prenant le plus grand `ms` reçu pour chaque `pv`. Une visite qui commence avant
minuit est rangée dans le jour où elle commence.

**Résumé d'un jour**, écrit une fois le jour clos :

```json
{ "day": "2026-11-24", "visitors": 41, "visits": 63, "activeMs": 9120000,
  "sketch": "<1024 registres HyperLogLog, base64>",
  "pages":      { "/stock": { "views": 120, "visitors": 30, "activeMs": 6100000 } },
  "components": { "/stock\u0000button: Actualiser": { "clicks": 88, "visitors": 22 } } }
```

Il ne contient aucun identifiant de visiteur. Au plus 500 pages et 500
composants par jour sont gardés, les plus vus et les plus cliqués. Le reste est
cumulé sous `(autres)`.

**Esquisse** (choix de Paul, 2026-11-24) : un HyperLogLog de 1024 registres de
6 bits (p = 10, environ 3 % d'erreur type), rempli avec les `vis` du jour. Il ne
garde que des maxima de rangs de bits : aucun visiteur ne peut en être retrouvé,
ni testé. Les esquisses de plusieurs jours se fusionnent par maximum, registre
par registre. Ça donne les visiteurs uniques de n'importe quelle période jusqu'à
25 mois. Le module, `backend/hll.js`, ne dépend de rien et fait moins de 100
lignes.

**Clôture et purge** : un passage tourne à la première collecte ou lecture après
minuit, et toutes les heures par un minuteur. Il écrit les résumés des jours
clos qui manquent. Il supprime le brut de plus de 90 jours, et les résumés de
plus de 25 mois. Supprimer un projet supprime son
dossier `audience/<projet>/`.

### 5. Lecture : `GET /api/deploy/projects/:id/audience?from=AAAA-MM-JJ&to=AAAA-MM-JJ`

La route est privée et ouverte à tout rôle qui ouvre Deploy, comme l'aperçu et
les variables d'un projet (choix de Paul). Elle ne renvoie que des totaux. La
période fait au plus 25 mois. Par défaut, ce sont les 30 derniers jours.

- **Période entièrement dans les 90 jours** : tout est calculé depuis le brut.
  Les visiteurs uniques sont donc exacts sur la période.
- **Période qui dépasse 90 jours** : les totaux viennent des résumés de jours,
  et le jour en cours vient du brut. Les visiteurs uniques viennent de la fusion
  des esquisses, celle du jour en cours étant construite depuis le brut. La
  réponse porte `visitorsPrecision: "estimate"`, et l'écran écrit « estimation,
  environ 3 % près ».

Réponse :

```json
{ "from": "2026-10-26", "to": "2026-11-24", "enabled": true,
  "visitorsPrecision": "day",
  "totals":  { "visitors": 77, "visits": 310, "activeMs": 41000000, "avgVisitMs": 132000 },
  "series":  [ { "day": "2026-10-26", "visitors": 12, "visits": 15, "activeMs": 1900000 } ],
  "pages":      [ { "path": "/stock", "views": 900, "visitors": 60, "activeMs": 30000000 } ],
  "components": [ { "path": "/stock", "name": "button: Actualiser", "clicks": 640, "visitors": 51 } ] }
```

Les pages et les composants sont triés par vues et par clics, 100 au plus pour
chaque liste. Les visiteurs d'une page ou d'un composant sont exacts sur 90 jours.
Au-delà, c'est une somme par jour, signalée comme telle.

### 6. Tableau de bord : onglet « Fréquentation » du projet

Il est ajouté à `PROJECT_TABS`, après « Vue d'ensemble ». Le code vit dans un
nouveau fichier, `frontend/src/js/deploy-audience.js`, sur le modèle de
`deploy-notices.js` : `window.DeployKit` pour les outils, une table de textes EN
et FR propre au module, fusionnée dans `window.translations`. Ce choix permet de
livrer avec l'extension sans attendre une version du cœur, comme pour les
notifications. Tout texte venu d'un visiteur (chemin, nom de composant) est
écrit avec `textContent`.

```
Fréquentation                      [7 j] [30 j] [90 j] [12 mois] [Du __ au __]

 Visiteurs uniques   Visites   Durée moyenne d'une visite   Temps total
        77             310            2 min 12 s               11 h 23

 Visiteurs par jour
 ▁▂▂▃▅▄▂▁▁▃▄▆▅▃▂▁▂▃▄▅▆▇▅▃▂▁▂▃▄▅          (barres SVG statiques, filets, sans animation)

 Pages                         Vues   Visiteurs   Temps moyen / vue   Temps total
 /stock                         900       60          33 s              8 h 20
 /                              410       71          12 s              1 h 22
 (clic sur une ligne : filtre les composants sur cette page)

 Composants les plus cliqués       Page     Clics   Visiteurs
 button: Actualiser                /stock     640       51
 aegis: Connexion                  /__aegis/login 77    77
```

États :

- suivi désactivé : un texte et un lien vers l'onglet Paramètres ;
- activé sans données : « Aucune visite sur cette période » ;
- erreur de lecture : une ligne d'erreur et un bouton « Réessayer ».

Les chiffres sont en `tabular-nums`, les couleurs viennent des variables CSS
existantes de Deploy, et le graphique n'a ni animation ni dégradé.

### 7. Fichiers touchés

Le dépôt est `4.6-Aegis.extensions/extensions/deploy/`.

- Nouveaux : `backend/audience.js` (validation, visiteur, limites),
  `backend/audienceStore.js` (écriture, clôture, purge, lecture),
  `backend/hll.js` (esquisse HyperLogLog),
  `frontend/site-auth/audience.js`, `frontend/src/js/deploy-audience.js`,
  ainsi que leurs tests.
- Modifiés : `siteNotices.js` (injection de plusieurs balises), `siteServer.js`
  (route de collecte, condition d'injection), `siteAuth.js` (servir
  `audience.js`, compter la connexion, laisser passer la collecte),
  `routes.js` (champ `audience` dans les réglages, route de lecture, purge à la
  suppression), `siteConfig.js` (exposer `audience`),
  `frontend/pages/deploy.html` (balise du module), `frontend/src/js/deploy.js`
  (onglet), `CHANGELOG.md`, `DEPLOY-CONTRACT.md` (le contrat du script et de
  `data-aegis-track` pour les développeurs de sites), `ADDING-A-SITE.md` (une
  ligne sur `data-aegis-track`), `extension.json` et `store.json` (version).
- Cœur : aucun changement prévu. La suite du cœur est lancée pour vérifier que
  rien ne casse.

## Ce qui reste au constructeur

- Le découpage exact des fonctions entre `audience.js` et `audienceStore.js`.
- La forme du minuteur de clôture : un minuteur par tenant, ou le poller existant.
- Le composant de sélection de dates.
- Les noms des clés de texte, sous le préfixe `deploy_audience_`.

## Version

**Deploy 0.2.16**, validée par Paul le 2026-11-24.
</content>
</invoke>
