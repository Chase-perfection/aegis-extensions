# Deploy: corrections livrées, et qui ne reviennent pas

Date: 2026-11-25. Taille: petit changement. Approuvé ("go") le 2026-11-25.

## Pourquoi

Les défauts d'interface signalés sur Deploy reviennent à chaque release. Cause
établie: les corrections étaient faites puis restaient sur des branches jamais
fusionnées (`fix/deploy-page-spacing`, `dd3f7c3`, 2026-10-20, portait déjà le
badge Protégé sur la ligne du nom et l'espacement), et rien dans ce dépôt ne
refuse une release dans cet état. Les tests de page sautent sans `AEGIS_TREE`,
et aucun ne vérifie une règle de mise en page.

## Objectifs

1. Livrer les défauts signalés le 2026-11-25:
   - lien du site: adresse réseau de la machine quand le tableau de bord est
     ouvert en boucle locale (`127.0.0.1`, `localhost`, `::1`);
   - erreur `poll_failed` effacée dès qu'un sondage réussit;
   - carte projet: boutons ancrés en bas, badge Protégé sur la ligne du titre,
     titre tronqué par `...` avec une marge avant le badge, boutons jamais sur
     deux lignes, grille 3/2/1 colonnes selon la largeur;
   - espacement de la page (`dd3f7c3` fusionné).
2. Empêcher le retour:
   - garde `stranded-fixes` dans ce dépôt (porté de core, élargi aux branches
     distantes et aux branches `fix/*` même en conflit), appelé par un
     `pre-push` vers `main` et par la release;
   - chaque règle visuelle signalée devient un test navigateur à trois largeurs
     (1280, 768, 390 px);
   - en release, un test de page qui saute est un échec, pas un saut.

## Non-objectifs

- Fusionner `feat/deploy-side-by-side` (0.3.0) ou `feature/deploy-audience`:
  fonctionnalités, décision de Paul. Elles vont dans la liste d'exceptions avec
  leur raison.
- Comparaison de captures d'écran à une référence (instable, écartée).
- La pop-up "ancienne version" : rien n'en dit encore ce qui est cassé, une
  capture est demandée.

## Approches

1. Bloquer la release sur les correctifs restés en branche. Retenu.
2. Un défaut signalé devient un test de mise en page, obligatoire en release.
   Retenu.
3. Captures de référence. Écarté: bruit (polices, images de sites).

## Laissé au constructeur

Adresse réseau choisie: première IPv4 privée non interne, sinon la première
IPv4 non interne, sinon l'hôte reçu. Une adresse configurée explicitement n'est
pas ajoutée.
