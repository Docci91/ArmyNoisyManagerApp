# ARMY NOÏSY — app de gestion d'équipe

Outil interne pour la marque de vêtements ARMY NOÏSY (équipe de 2 à 5 personnes) : calendrier, tâches, notes, stock (notes Print/Blank), équipe. L'utilisateur s'appelle Dorian et parle français : l'interface et les échanges sont en français.

## Architecture

- **Une seule page** : `index.html` contient tout (HTML, CSS, JS). Pas de build, pas de framework.
- **Assets embarqués en base64** dans `index.html` : texture camouflage (`--camo`), logo, favicon, apple-touch-icon, manifest PWA. Les lignes sont énormes : ne jamais ouvrir le fichier en entier, utiliser `grep -n` et `sed -n 'A,Bp'`.
- **Hébergement** : GitHub Pages, branche `main`, racine. URL : https://docci91.github.io/ArmyNoisyManagerApp/
- **Base de données** : Firebase Firestore, projet `armynoisymanagerapp` (config dans `index.html` et `firebase-messaging-sw.js`).
- Tout le code applicatif est dans une IIFE dans le dernier bloc `<script>`.

## Données Firestore

Collection `app_data`, un document par clé, avec le champ `value` (chaîne JSON) et `updatedAt` :
- `tasks` : liste de tâches `{id, title, assignees[], allTeam, priority, due, status, repeat}`. `repeat` vaut `'weekly'` ou `null`. `status` vaut `todo`, `doing` ou `done`.
- `members` : liste de prénoms.
- `member-pins` : `{prénom: hash SHA-256 du code à 4 chiffres}`.
- `member-notes` : notes `{id, owner, title, content, updatedAt, pinned}`. `owner` vaut un prénom ou `__team__` (notes de toute l'équipe).
- `note-print`, `note-blank` : texte brut des deux notes de stock.

Collection `fcm_tokens` : un document par appareil `{member, token, updatedAt}`.

La session (qui est connecté) est dans `localStorage` (`current-user`), propre à chaque appareil.

## Fonctionnalités

- Connexion par choix du prénom + code à 4 chiffres, création de profil depuis l'écran de connexion.
- Accueil : calendrier mensuel, notes épinglées, prochaines tâches chronologiques, panneau du jour (ajout de tâche au clic sur un jour).
- Tâches : kanban 3 colonnes, assignation multiple ou « Toute l'équipe », répétition hebdomadaire, fenêtre de détail au clic.
- Notes : un onglet par membre plus un onglet « Toute l'équipe », plusieurs notes par onglet, épinglage vers l'accueil.
- Notifications : écoute temps réel de `tasks` (`watchTasks`) + notifications navigateur ; push FCM même app fermée via `firebase-messaging-sw.js` et la Cloud Function.
- Mise en page mobile (barre en bas) et bureau ≥ 900px (barre latérale fixe à gauche, accueil et notes sur deux colonnes).

## Design

Thème sombre façon app fitness : fond `#101114`, cartes `#1B1D22`, accent orange `#FF5A36`, coins arrondis (variables `--radius-*`), texture camouflage (branches/écorce) sur les éléments actifs et boutons. Logo ARMY NOÏSY dans l'en-tête et sur l'écran de connexion.

## État actuel et reste à faire

Le code client des notifications push est en ligne, avec la clé VAPID. **Reste à faire côté Firebase** (demande le compte de Dorian) :
1. Passer le projet au plan Blaze (gratuit à ce volume, carte requise).
2. Déployer la Cloud Function `notifyNewTasks` du dossier `functions/` : `firebase deploy --only functions`. Dorian a eu l'erreur « functions predeploy error: Command terminated with non-zero exit code 1 » : lancer `npm install` dans `functions/` et lire le message d'erreur en amont.
3. Publier les règles Firestore couvrant `app_data` et `fcm_tokens` (lecture/écriture ouvertes).

## Pièges connus

- **Dates** : ne jamais utiliser `toISOString().slice(0,10)` pour « aujourd'hui » (décalage UTC). Utiliser `isoLocal()` et `todayIsoLocal()`.
- Après un `Edit` sur le CSS, vérifier que les balises `<style>`/`</style>` sont équilibrées et que `.toast{` n'a pas disparu.
- Vérifier la syntaxe du JS après chaque modif : extraire les blocs `<script>` et lancer `node --check`.
- Les écrans sont des `<section class="screen">` ; les règles de grille bureau doivent cibler `#screen-xxx.active`, sinon l'écran reste visible.
- Les notes d'équipe utilisent la clé `__team__` comme `owner`.
- Sécurité faible par conception : règles Firestore ouvertes et code à 4 chiffres, suffisant pour un outil interne, pas pour des données sensibles. Si Dorian veut durcir, passer à Firebase Authentication.

## Déploiement

Un commit sur `main` met le site à jour en 1 à 2 minutes. Le site est installable sur l'écran d'accueil (iPhone : Safari → Partager → Sur l'écran d'accueil). Sur iPhone, les notifications web ne marchent qu'une fois le site installé de cette façon.
