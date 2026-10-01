# Arbre des comptes (account-tiering) : conception

2026-09-30. Extension qui montre, pour chaque compte de l'AD, le tier qu'il
atteint réellement (T0, T1, T2), par quels groupes et quels droits il y arrive,
et l'écart avec le tier prévu pour lui. Elle s'affiche sous Gestion du parc, à
côté d'Inventaire AD.

## Décisions prises

| Question | Décision |
|---|---|
| Qui lit l'AD | L'extension, depuis le serveur Aegis, en lecture seule. Elle reste installable et retirable sans toucher au cœur. Le serveur doit être membre du domaine. |
| D'où vient le tier prévu | Des règles (OU, motif de nom, groupe), plus une correction manuelle par compte. Un compte qu'aucune règle ne couvre est Tier 2. |
| Remédiation | Afficher les étapes et la commande à copier. Rien n'est écrit dans l'AD. |
| Approche | Un script PowerShell relève les faits bruts, le JavaScript du serveur les analyse. |
| Numérotation | Celle de Microsoft : T0 contrôle le domaine, T1 administre des serveurs, T2 les postes et l'usage courant. Le catalogue de remédiation du cœur numérote T1/T2/T3 : l'extension ne le touche pas. |
| Emplacement | Une carte de menu dans Gestion du parc (`navSlot: "inventory"`), qui ouvre sa propre page. Le cœur n'offre pas d'onglet dans `ad-inventory.html` à une extension. |
| Accès | Page et routes réservées aux administrateurs du tenant, en lecture comme en écriture : la page décrit comment prendre le contrôle du domaine. |

## Périmètre

Dans la première version :

- la collecte (section « Collecte ») et l'analyse (section « Analyse ») ;
- la page, reprise de la maquette validée : arbre avec déplacement libre, zoom,
  mini-carte et regroupement au-delà de 8 groupes, vue Liste, vue d'ensemble
  (chiffres clés, matrice tier prévu × tier effectif, points de passage), arbre
  inversé, panneau « Pourquoi Tier N ? », filtre « Écarts seulement » ;
- l'écran « Règles de tiering » et la correction manuelle par compte ;
- la remédiation affichée, avec le marqueur « remédiation proposée » ;
- l'export CSV et JSON.

Hors de la première version :

- l'export PDF (il demande un gabarit de rapport) ;
- toute écriture dans l'AD ;
- l'envoi vers la file « actions proposées » du cœur (encore sur une branche) ;
- les filtres de sécurité et les filtres WMI des GPO (voir « Approximations »).

## Architecture

Dossier `extensions/account-tiering/` :

| Fichier | Rôle | Dépend de |
|---|---|---|
| `extension.json` | Manifeste : `id: account-tiering`, `version: 1`, `page: account-tiering.html`, `navSlot: inventory`, `routePrefixes: ["/api/account-tiering"]`, `backend: backend/routes.js` | |
| `collect/collect-tiering.ps1` | Lit l'AD, écrit le JSON des faits | Windows PowerShell 5.1, ADSI, compte machine |
| `backend/analyze.js` | Faits + tiers prévus vers modèle (nœuds, liens, tiers, écarts, points de passage, matrice) | rien |
| `backend/classify.js` | Règles + corrections vers tier prévu par SID | rien |
| `backend/remediation.js` | Mécanisme vers étape et commande à copier | rien |
| `backend/store.js` | Base SQLite de l'extension, par tenant | `extensionDb` |
| `backend/runner.js` | Lance le script, gère délai, blocage antivirus, progression | `child_process` |
| `backend/routes.js` | Routes HTTP, `register(router, context)` | tout ce qui précède, `requireRole` |
| `frontend/pages/account-tiering.html`, `frontend/src/js/account-tiering.js`, `frontend/src/css/account-tiering.css` | La page | socle du cœur (`navbar.js`, `translations.js`, `app.js`, `agTag`) |
| `store.json`, `CHANGELOG.md`, `card.png` | Catalogue | |

Côté cœur (`4.0-Aegis`), un seul changement : les clés de traduction EN et FR
dans `frontend/src/js/translations.js` (préfixe `at_`, plus `nav_account_tiering`
et `desc_account_tiering`). Le test de parité EN/FR du cœur les vérifie.

Préfixe `at-` sur les identifiants et classes du DOM : les pages d'extension
partagent l'espace d'URL du cœur.

## Parcours d'une analyse

1. L'administrateur clique « Relancer l'analyse » : `POST /api/account-tiering/scan`.
2. `runner.js` lance `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File collect-tiering.ps1 -Domain <d> -Passes <n> -OutFile <fichier>`.
   Le fichier va dans le dossier de l'extension du tenant. La progression passe
   par `broadcastLog` quand le cœur le fournit.
3. Le script écrit le JSON en UTF-8 avec BOM ; `runner.js` retire le BOM avant `JSON.parse`.
4. `store.js` enregistre les faits dans `scans`.
5. `GET /api/account-tiering/model` renvoie le modèle : faits de la dernière
   analyse réussie + tiers prévus, passés à `analyze.js`. Le modèle reste en
   mémoire tant que l'analyse, les règles et les corrections ne changent pas.

Modifier une règle ou une correction recalcule le modèle sans relire l'AD.

## Collecte

Le script part des cibles sensibles et remonte vers les membres. Il ne lit pas
les comptes sans privilège : le script en donne seulement le total
(`tier2Totals`), que `analyze.js` compte comme Tier 2.

Les groupes sont désignés par SID bien connu, jamais par nom (Windows en
français). DnsAdmins n'a pas de RID fixe : le script le trouve par
`sAMAccountName=DnsAdmins`.

### Cibles Tier 0

- Groupes : Admins du domaine (-512), Administrateurs de l'entreprise (-519),
  Administrateurs du schéma (-518), Contrôleurs de domaine (-516), Propriétaires
  créateurs de stratégie de groupe (-520), Administrateurs de clés (-526),
  Administrateurs de clés Enterprise (-527), Administrateurs (S-1-5-32-544),
  Opérateurs de compte (S-1-5-32-548), Opérateurs de serveur (S-1-5-32-549),
  Opérateurs d'impression (S-1-5-32-550), Opérateurs de sauvegarde
  (S-1-5-32-551), DnsAdmins. Un RID seul (-512) se lit après le SID du domaine.
- Objets : racine du domaine, `CN=AdminSDHolder,CN=System`, OU Domain
  Controllers, GPO liées à la racine ou à l'OU Domain Controllers.

### Appartenances

Pour chaque groupe cible, le script liste les membres directs, puis descend
dans chaque groupe membre, sans limite de profondeur, avec détection des
cycles. Il ajoute les comptes dont `primaryGroupID` vaut le RID d'un groupe
cible : ils n'apparaissent pas dans l'attribut `member`. Chaque maillon est
gardé, pour que l'arbre montre le groupe intermédiaire.

### Droits (ACE)

Le script lit la DACL (`nTSecurityDescriptor`, masque DACL seul) des objets
sensibles et ne garde que les ACE d'autorisation qui donnent l'un de ces droits :

| Droit | Détection |
|---|---|
| GenericAll, GenericWrite, WriteDacl, WriteOwner | `ActiveDirectoryRights` |
| Réinitialisation du mot de passe | ExtendedRight, `ObjectType` `00299570-246d-11d0-a768-00aa006e0529` ou GUID vide |
| Écriture de `member` | WriteProperty ou Self, `ObjectType` `bf9679c0-0de6-11d0-a285-00aa003049e2` ou GUID vide |
| DCSync | ExtendedRight `1131f6aa-9c07-11d1-f79f-00c04fc2dcd2` et `1131f6ad-9c07-11d1-f79f-00c04fc2dcd2` sur la racine, pour le même titulaire |

Pour une ACE héritée, le script remonte les OU parentes jusqu'à celle qui porte
l'ACE d'origine, pour que l'arbre affiche « OU=Comptes-Admin » et non l'objet final.

Titulaires ignorés : SYSTEM (S-1-5-18), Contrôleurs de domaine d'entreprise
(S-1-5-9), SELF (S-1-5-10), CREATOR OWNER (S-1-3-0), et tout titulaire déjà
Tier 0 par appartenance.

Titulaires trop larges : Tout le monde (S-1-1-0), Utilisateurs authentifiés
(S-1-5-11), Anonyme (S-1-5-7), Accès compatible pré-Windows 2000
(S-1-5-32-554), Utilisateurs du domaine (-513), Ordinateurs du domaine (-515).
Le script ne les développe pas en membres. L'analyse les montre comme un nœud
« Tous les comptes » et les place en tête des points de passage.

### Passes

- Passe 1 : appartenances aux groupes cibles et ACE sur les objets cibles.
- Passe n+1 : ACE sur les comptes et groupes trouvés à la passe n (Tier 0 et
  Tier 1), puis appartenances des titulaires qui sont des groupes.
- Arrêt quand une passe n'apporte rien, ou au nombre réglé (3 par défaut, 1 à 5).
  Si la dernière passe apportait encore des objets, le JSON porte
  `truncated: true` et l'arbre affiche « chaîne tronquée à N niveaux ».

### GPO de groupes locaux

Pour chaque GPO, le script lit dans SYSVOL :

- `Machine\Microsoft\Windows NT\SecEdit\GptTmpl.inf`, section `[Group Membership]` ;
- `Machine\Preferences\Groups\Groups.xml`.

Il garde les ajouts aux groupes locaux Administrateurs (S-1-5-32-544),
Utilisateurs du Bureau à distance (S-1-5-32-555) et Utilisateurs de gestion à
distance (S-1-5-32-580). Il lit les liens (`gPLink`), les liens appliqués
(enforced) et le blocage d'héritage (`gPOptions`). Pour chaque lien, il compte
les ordinateurs touchés par classe : DC, serveur (`operatingSystem` contient
« Server »), poste.

### Format des faits

```json
{
  "schema": 1,
  "domain": "corp.local",
  "domainSid": "S-1-5-21-…",
  "netbios": "CORP",
  "collectedAt": "2026-09-30T08:12:00Z",
  "passes": 3,
  "truncated": false,
  "principals": [{ "sid": "", "dn": "", "sam": "", "name": "", "kind": "user|computer|gmsa|group", "enabled": true, "primaryGroupRid": 513 }],
  "memberships": [{ "group": "<sid>", "member": "<sid>", "via": "member|primaryGroup" }],
  "aces": [{ "objectDn": "", "objectSid": "<sid ou null>", "objectKind": "domainRoot|adminSdHolder|dcOu|gpo|group|account|ou", "originDn": "", "trustee": "<sid>", "right": "GenericAll|GenericWrite|WriteDacl|WriteOwner|ResetPassword|WriteMember|DCSyncGetChanges|DCSyncGetChangesAll", "inherited": false, "pass": 1 }],
  "gpos": [{ "guid": "", "name": "", "editors": ["<sid>"], "links": [{ "somDn": "", "enforced": false, "computers": { "dc": 0, "server": 42, "workstation": 0 } }], "localGroups": [{ "localGroup": "S-1-5-32-544", "members": ["<sid>"], "source": "GptTmpl|GroupsXml" }] }],
  "tier2Totals": { "users": 1284, "computers": 910 },
  "unreadable": [{ "dn": "", "reason": "" }]
}
```

`analyze.js` refuse un `schema` inconnu (code `facts_schema`).

`netbios` est facultatif : sans lui, la remédiation prend le premier label DNS
en majuscules. Le script émet les deux moitiés de DCSync séparément, une ACE
par droit étendu, et `analyze.js` les apparie par titulaire : c'est ce qui rend
le cas « DCSync incomplet » vérifiable.

## Analyse

### Tier donné par chaque mécanisme

| Mécanisme | Tier |
|---|---|
| Appartenance, même imbriquée, à un groupe cible | 0 |
| DCSync, ou GenericAll / WriteDacl / WriteOwner sur la racine | 0 |
| Droit de la table « Droits » sur AdminSDHolder, sur un groupe ou compte Tier 0, ou sur l'OU d'origine | 0 |
| Modification d'une GPO liée à la racine ou à l'OU Domain Controllers | 0 |
| Modification d'une autre GPO | tier des machines où elle pose des groupes locaux |
| Droit de la table « Droits » sur une OU | tier le plus privilégié des comptes et groupes qu'elle contient |
| GPO de groupe local sur au moins un DC | 0 |
| GPO de groupe local sur au moins un serveur | 1 |
| Droit de la table « Droits » sur un groupe ou compte Tier 1 | 1 |
| GPO de groupe local sur des postes seulement | 2 |

Un titulaire qui contrôle un objet de tier N reçoit le tier N. `analyze.js`
calcule ce point fixe sur le graphe des faits.

### Par compte

- Tier atteint : le plus privilégié des mécanismes accessibles.
- Tier prévu : voir « Tier prévu ».
- Écart : atteint < prévu. Critique si atteint = 0, Élevé sinon. Atteint =
  prévu : conforme. Atteint > prévu : « sous le prévu », à titre d'information.

### Modèle renvoyé à la page

Comptes (SID, nom, tiers, écart, chemins), groupes, mécanismes et liens typés
(appartenance, ACL, GPO), points de passage (groupe ou droit, tier, membres
exposés, comptes en écart), matrice 3 × 3, chiffres clés, métadonnées
d'analyse (date, domaine, passes, `truncated`, `unreadable`). La page fait
elle-même la mise en page de l'arbre, le regroupement et l'arbre inversé,
comme dans la maquette.

### Approximations assumées

- Les filtres de sécurité et WMI des GPO ne sont pas évalués : un lien compte
  tous les ordinateurs sous l'OU. Cela peut surévaluer, jamais sous-évaluer.
- Les ACE de refus ne sont pas soustraites : même effet.
- La page affiche ces deux limites dans l'aide du panneau.

## Tier prévu

Table ordonnée `rules`. La première règle qui correspond l'emporte.

| Type | Motif | Exemple |
|---|---|---|
| `ou` | Suffixe de DN, sans casse | `OU=Admins-T0,DC=corp,DC=local` |
| `name` | Motif sur `sAMAccountName`, `*` et `?` | `*-adm` |
| `group` | SID d'un groupe, appartenance directe ou imbriquée | `S-1-5-21-…-1107` |

Chaque règle donne un tier 0, 1 ou 2. Correction manuelle par SID dans
`overrides`, avec motif obligatoire, auteur et date. Une correction passe avant
toute règle.

Sans aucune règle, la page affiche un bandeau : « Aucune règle de tiering :
tous les comptes sont considérés Tier 2, les administrateurs légitimes
apparaissent en écart. » avec un lien vers l'écran des règles.

## Stockage

Base de l'extension, par tenant, via `extensionDb.withRequest(req, …)` :

| Table | Colonnes |
|---|---|
| `scans` | `id`, `started_at`, `finished_at`, `status` (`running`, `ok`, `partial`, `failed`), `error_code`, `domain`, `facts_json` |
| `rules` | `id`, `position`, `kind`, `pattern`, `tier`, `created_by`, `updated_at` |
| `overrides` | `sid` (clé), `tier`, `reason`, `set_by`, `set_at` |
| `remediations` | `sid` (clé), `proposed_by`, `proposed_at` |
| `settings` | `key` (clé), `value` : `domain`, `passes` |

On garde les 5 dernières analyses. Au démarrage, une analyse restée `running`
passe à `failed` avec le code `scan_interrupted`.

## Routes

Toutes sous `/api/account-tiering`, toutes derrière `requireRole('admin')`.

| Méthode et chemin | Effet |
|---|---|
| `GET /model` | Modèle de la dernière analyse réussie, ou 404 `no_scan_yet` |
| `POST /scan` | Lance une analyse ; 409 `scan_running` si une tourne |
| `GET /scan/status` | État de l'analyse en cours ou de la dernière |
| `GET /rules`, `PUT /rules` | Lit ou remplace la liste ordonnée |
| `PUT /overrides/:sid`, `DELETE /overrides/:sid` | Correction manuelle |
| `POST /remediations/:sid` | Marque « remédiation proposée » |
| `GET /settings`, `PUT /settings` | Domaine et nombre de passes |
| `GET /export.csv`, `GET /export.json` | Téléchargement |

Validation : `:sid` contre `^S-1-5-21-\d+-\d+-\d+-\d+$` ou un SID bien connu
de la liste ; `tier` dans {0, 1, 2} ; `passes` entier de 1 à 5 ; `domain` nom
DNS ; motifs de règle limités à 256 caractères. Une capacité absente du cœur
(`extensionDb`) donne 501 `store_unavailable` sur la route concernée, jamais
une exception dans `register`.

## Remédiation

`remediation.js` associe à chaque type de mécanisme une étape et une commande :

| Mécanisme | Commande proposée |
|---|---|
| Appartenance | `Remove-ADGroupMember -Identity '<groupe parent>' -Members '<membre>'` |
| Groupe principal | `Set-ADObject -Identity '<DN du compte>' -Replace @{primaryGroupID=513}` (515 pour un ordinateur ou un gMSA) : `Remove-ADGroupMember` ne retire pas un groupe principal |
| ACE | `dsacls '<DN d'origine>' /R '<domaine>\<titulaire>'`, avec l'avertissement : retire toutes les ACE du titulaire sur l'objet |
| GPO de groupe local | Chemin GPMC de la GPO et du paramètre à retirer |
| Modification de GPO | Chemin GPMC, onglet Délégation |

Les valeurs insérées dans une commande sont échappées pour PowerShell
(apostrophe doublée, y compris les apostrophes typographiques U+2018 à U+201B,
que PowerShell lit aussi comme des guillemets simples).

## Erreurs

| Code | Cas | Détection |
|---|---|---|
| `domain_unreachable` | Serveur hors domaine, aucun DC joignable | code de sortie 2 du script |
| `collector_blocked` | L'antivirus bloque le script | sortie contenant `ScriptContainedMaliciousContent` ou code de sortie propre à AMSI |
| `powershell_missing` | `powershell.exe` introuvable | `ENOENT` au lancement |
| `scan_running` | Analyse déjà en cours | état en base |
| `scan_timeout` | Plus de 10 minutes | minuteur, processus tué |
| `scan_interrupted` | Service redémarré pendant l'analyse | état au démarrage |
| `partial` | Objets illisibles | `unreadable` non vide, statut `partial` |
| `facts_schema` | JSON d'un schéma inconnu | `analyze.js` |
| `no_scan_yet` | Aucune analyse | base vide |
| `collector_failed` | Le script échoue autrement, ou ses faits ne se lisent pas | autre code de sortie non nul, JSON illisible |
| `internal` | L'enregistrement du résultat échoue | erreur de la base, journalisée |

Une analyse restée `running` sans processus qui la porte passe à
`scan_interrupted` dès qu'on la consulte, pas seulement au démarrage. On garde
les 5 dernières analyses, plus la dernière réussie, pour qu'une série d'échecs
n'efface jamais le dernier arbre affichable.

Le script écrit ses erreurs sur stdout avec un préfixe fixe (`AT-ERROR <code>`),
jamais un message traduit : la page traduit le code.

## Tests

- `backend/tests/analyze.test.js`, un jeu de faits par cas : imbrication dans
  Admins du domaine, groupe principal, réinitialisation de mot de passe héritée
  d'une OU, DCSync complet et DCSync incomplet (une seule des deux ACE), GPO
  sur serveurs, GPO sur postes, GPO sur DC, titulaire trop large, chaîne de 3
  niveaux, chaîne tronquée, titulaires ignorés, cycle d'appartenance.
- `backend/tests/classify.test.js` : ordre des règles, chaque type, correction
  prioritaire, défaut Tier 2.
- `backend/tests/remediation.test.js` : une commande par mécanisme, échappement.
- `backend/tests/routes.test.js` : 403 hors admin, SID invalide, 409, 501 sans
  `extensionDb`, `no_scan_yet`.
- `backend/tests/runner.test.js` : BOM, délai, `collector_blocked`, code de
  sortie 2, avec un faux script.
- `frontend/tests/account-tiering.test.js` : la page charge un modèle fictif,
  l'arbre, la liste et la vue d'ensemble s'affichent (banc de test copié de
  network-inventory).
- Le script PowerShell n'a pas de test automatique : il se teste dans la VM
  corp.local, dans Windows PowerShell 5.1, avec un compte par cas de
  `analyze.test.js` créé dans l'AD de test.

## Livraisons

1. Analyse, règles, remédiation, stockage, routes, page. Tout se teste sans AD,
   sur des faits fictifs.
2. Script de collecte, puis test en VM.
3. Publication : clés de traduction dans le cœur, `store.json`, `CHANGELOG.md`,
   version 0.0.0 (PUBLISHING.md : la première sortie d'une extension est
   `0.0.0`), catégorie `Compliance`.

## Points à vérifier avant la livraison 3

- `minAppVersion` : la première version publiée d'Aegis qui fournit
  `extensionDb` à `register()`.
- L'icône : `users`, déjà présente dans `navbar.js` du cœur ; reste à
  regarder son rendu dans la carte du menu.
- La signature du script : le cœur signe-t-il les `.ps1` des extensions, ou
  seulement le manifeste ?
