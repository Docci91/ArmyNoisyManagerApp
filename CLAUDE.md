# ARMY NOÏSY — app de gestion d'équipe

Outil interne pour la marque de vêtements ARMY NOÏSY (équipe de 2 à 5 personnes) : calendrier, tâches, notes, stock (notes Print/Blank), équipe. L'utilisateur s'appelle Dorian et parle français : l'interface et les échanges sont en français.

## Architecture

- **Une seule page** : `index.html` contient tout (HTML, CSS, JS). Pas de build, pas de framework.
- **Assets embarqués en base64** dans `index.html` : favicon, apple-touch-icon et manifest PWA (lignes 7 à 9), texture camouflage `--camo` (ligne 31), logo (ligne 1016). Ces lignes font de 10 Ko à 270 Ko : ne jamais ouvrir le fichier en entier, utiliser `grep -n` et `sed -n 'A,Bp' | cut -c1-200`.
- **Autres fichiers à la racine** : `firebase-messaging-sw.js` (service worker FCM, doit rester à la racine) et `icon-192.png` (icône des notifications push, utilisée par le service worker).
- **Hébergement** : GitHub Pages, branche `main`, racine. URL : https://docci91.github.io/ArmyNoisyManagerApp/
- **Base de données** : Firebase Firestore, projet `armynoisymanagerapp` (config dans `index.html` et `firebase-messaging-sw.js`).
- Trois blocs `<script>` en fin de page : SDK Firebase 10.12.0 (compat : app, firestore, messaging), puis la config Firebase + `VAPID_KEY` + `db`/`messaging` globaux, puis tout le code applicatif dans une IIFE (dernier bloc).
- Accès aux données via `dbGet(key)` / `dbSet(key, value)` ; `saveTasks()`, `saveMembers()`, `saveMemberNotes()` sauvegardent toute la liste d'un coup (pas de mise à jour partielle).

## Données Firestore

Collection `app_data`, un document par clé, avec le champ `value` (chaîne JSON) et `updatedAt` :
- `tasks` : liste de tâches `{id, title, assignees[], allTeam, priority, due, status, repeat}`. `priority` vaut `low`, `med` ou `high` ; `due` est une date `AAAA-MM-JJ` (ou vide) ; `repeat` vaut `'weekly'` ou `null` ; `status` vaut `todo`, `doing` ou `done`. `normalizeTask()` convertit les anciennes tâches (champ `assignee` unique).
- `members` : liste de prénoms.
- `member-pins` : `{prénom: hash SHA-256 du code à 4 chiffres}` (sans sel).
- `member-notes` : notes `{id, owner, title, content, updatedAt, pinned}`. `owner` vaut un prénom ou `__team__` (notes de toute l'équipe).
- `note-print`, `note-blank` : texte brut des deux notes de stock.

Collection `fcm_tokens` : un document par appareil, d'identifiant le jeton lui-même, `{member, token, updatedAt}`.

La session (qui est connecté) est dans `localStorage` (`current-user`), propre à chaque appareil.

Seule `tasks` est écoutée en temps réel ; les autres clés sont lues une fois au chargement (`loadAll()`), il faut recharger la page pour voir les modifs des autres.

## Fonctionnalités

- Connexion par choix du prénom + code à 4 chiffres, création de profil depuis l'écran de connexion (code saisi deux fois).
- 5 écrans : `home`, `tasks`, `stock`, `team`, `notes`, navigation par `goto(screen)` et attributs `data-goto`.
- Accueil : calendrier mensuel, notes épinglées, prochaines tâches chronologiques, panneau du jour (ajout de tâche au clic sur un jour).
- Tâches : kanban 3 colonnes, assignation multiple ou « Toute l'équipe », répétition hebdomadaire, fenêtre de détail au clic.
- Stock : deux zones de texte libre (Print, Blank), sauvegarde automatique 700 ms après la frappe.
- Équipe : qui est connecté, déconnexion, activation des notifications, ajout et suppression de membres.
- Notes : un onglet par membre plus un onglet « Toute l'équipe », plusieurs notes par onglet, épinglage vers l'accueil.
- Notifications : écoute temps réel de `tasks` (`watchTasks`) + notifications navigateur ; push FCM même app fermée via `firebase-messaging-sw.js` et la Cloud Function.
- Mise en page mobile (barre en bas) et bureau ≥ 900px (barre latérale fixe à gauche, accueil et notes sur deux colonnes).

## Design

Thème sombre façon app fitness : fond `#101114`, cartes `#1B1D22`, accent orange `#FF5A36`, coins arrondis (variables `--radius-*`), texture camouflage (branches/écorce) sur les éléments actifs et boutons. Logo ARMY NOÏSY dans l'en-tête et sur l'écran de connexion.

## État actuel et reste à faire

Le code client des notifications push est en ligne, avec la clé VAPID : chaque appareil enregistre son jeton dans `fcm_tokens`. Mais **rien n'envoie encore de push** : sans Cloud Function, seules les notifications navigateur de `watchTasks` marchent, et seulement quand l'app est ouverte.

**Le dossier `functions/` n'est pas dans le dépôt** (il n'y a jamais été, ni `firebase.json`, ni `firestore.rules`) : il n'existe que sur l'ordinateur de Dorian, s'il existe encore. Reste à faire (demande le compte de Dorian) :
1. Passer le projet au plan Blaze (gratuit à ce volume, carte requise).
2. Récupérer ou réécrire la Cloud Function `notifyNewTasks` (déclenchée à l'écriture de `app_data/tasks`, envoie un push aux jetons `fcm_tokens` des membres concernés par les nouvelles tâches) et la committer dans `functions/` avec `firebase.json`.
3. La déployer : `npm install` dans `functions/`, puis `firebase deploy --only functions`. Dorian a eu l'erreur « functions predeploy error: Command terminated with non-zero exit code 1 » : lire le message d'erreur affiché juste avant.
4. Publier les règles Firestore couvrant `app_data` et `fcm_tokens` (lecture/écriture ouvertes).

## Pièges connus

- **Dates** : ne jamais utiliser `toISOString().slice(0,10)` pour « aujourd'hui » (décalage UTC). Utiliser `isoLocal()` et `todayIsoLocal()`.
- Après un `Edit` sur le CSS, vérifier que les balises `<style>`/`</style>` sont équilibrées et que `.toast{` n'a pas disparu.
- Vérifier la syntaxe du JS après chaque modif : extraire les blocs `<script>` et lancer `node --check`.
- Les écrans sont des `<section class="screen">` ; les règles de grille bureau doivent cibler `#screen-xxx.active`, sinon l'écran reste visible.
- Les notes d'équipe utilisent la clé `__team__` comme `owner`.
- Deux listes de membres coexistent : `members` (données de l'app) et `authMembers` (écran de connexion), toutes deux issues de la clé `members`. Les garder synchronisées si on touche à l'une.
- Supprimer un membre (✕ dans Équipe, sans confirmation) le retire seulement de `members` : son code dans `member-pins`, ses notes et ses assignations de tâches restent.
- `searchTerm` est un reste de l'ancienne barre de recherche (supprimée) : toujours vide, le filtre de `renderBoard` ne fait rien.
- Les jetons FCM ne sont jamais supprimés (ni à la déconnexion, ni s'ils expirent) : la Cloud Function devra ignorer ou nettoyer les jetons invalides.
- Sécurité faible par conception : règles Firestore ouvertes et code à 4 chiffres, suffisant pour un outil interne, pas pour des données sensibles. Si Dorian veut durcir, passer à Firebase Authentication.

## Déploiement

Un commit sur `main` met le site à jour en 1 à 2 minutes. Le site est installable sur l'écran d'accueil (iPhone : Safari → Partager → Sur l'écran d'accueil). Sur iPhone, les notifications web ne marchent qu'une fois le site installé de cette façon.
