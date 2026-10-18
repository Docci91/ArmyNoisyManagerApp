# ARMY NOÏSY — app de gestion d'équipe

Outil interne pour la marque de vêtements ARMY NOÏSY (équipe de 2 à 5 personnes) : calendrier, tâches, commandes Shopify à envoyer, stock, notes, équipe. L'utilisateur s'appelle Dorian et parle français : l'interface et les échanges sont en français.

## Architecture

- **Une seule page** : `index.html` contient tout (HTML, CSS, JS). Pas de build, pas de framework.
- **Assets embarqués en base64** dans `index.html` : favicon, apple-touch-icon et manifest PWA (lignes 7 à 9), texture camouflage `--camo` (ligne 31), logo (ligne 1016). Ces lignes font de 10 Ko à 270 Ko : ne jamais ouvrir le fichier en entier, utiliser `grep -n` et `sed -n 'A,Bp' | cut -c1-200`.
- **Autres fichiers à la racine** : `firebase-messaging-sw.js` (service worker FCM, doit rester à la racine) et `icon-192.png` (icône des notifications push, utilisée par le service worker).
- **Firebase** : `functions/` (Cloud Functions `notifyNewTasks`, `syncShopifyScheduled`, `syncShopifyOnRequest`), `firebase.json`, `.firebaserc` (projet par défaut) et `firestore.rules`. Ces fichiers ne servent pas au site, seulement à `firebase deploy`.
- **Hébergement** : GitHub Pages, branche `main`, racine. URL : https://docci91.github.io/ArmyNoisyManagerApp/
- **Base de données** : Firebase Firestore, projet `armynoisymanagerapp` (config dans `index.html` et `firebase-messaging-sw.js`).
- Trois blocs `<script>` en fin de page : SDK Firebase 10.12.0 (compat : app, firestore, messaging), puis la config Firebase + `VAPID_KEY` + `db`/`messaging` globaux, puis tout le code applicatif dans une IIFE (dernier bloc).
- Accès aux données via `dbGet(key)` / `dbSet(key, value)` ; `saveTasks()`, `saveMembers()`, `saveMemberNotes()` sauvegardent toute la liste d'un coup (pas de mise à jour partielle).

## Données Firestore

Collection `app_data`, un document par clé, avec le champ `value` (chaîne JSON) et `updatedAt` :
- `tasks` : liste de tâches `{id, title, assignees[], allTeam, priority, due, status, repeat, createdBy}`. `priority` vaut `low`, `med` ou `high` ; `due` est une date `AAAA-MM-JJ` (ou vide) ; `repeat` vaut `'weekly'` ou `null` ; `status` vaut `todo`, `doing` ou `done`. `createdBy` est le prénom de l'auteur (absent sur les anciennes tâches). `normalizeTask()` convertit les anciennes tâches (champ `assignee` unique).
- `members` : liste de prénoms.
- `member-pins` : `{prénom: hash SHA-256 du code à 4 chiffres}` (sans sel).
- `member-notes` : notes `{id, owner, title, content, updatedAt, pinned}`. `owner` vaut un prénom ou `__team__` (notes de toute l'équipe).
- `note-print`, `note-blank` : anciennes notes de stock Print/Blank, **plus utilisées** depuis le nouveau stock (données laissées en place).
- `shopify-orders` : écrit uniquement par la Cloud Function, `{syncedAt, orders:[{id, name, createdAt, url, items:[{title, variant, sku, qty}]}], error?, errorAt?}`. `qty` = quantité restant à expédier. Volontairement **aucune donnée client** (règles ouvertes).
- `shopify-products` : écrit uniquement par la Cloud Function, produits **actifs** de Shopify `{syncedAt, products:[{id, title, variants:[{id, title, sku}]}], error?, errorAt?}`. `title` de variante vide = produit sans options (« Default Title » chez Shopify).
- `shopify-sync-request` : horodatage écrit par les boutons « Actualiser » (Commandes et Stock), déclenche une synchro.

Collection `stock_items` : quantités de stock **saisies à la main**, un document par variante (id = id de variante Shopify) `{qty, productId, productTitle, variantTitle, sku, updatedAt, updatedBy}`. Les noms sont recopiés pour pouvoir afficher une variante qui n'est plus active sur Shopify. Les boutons +/− utilisent `FieldValue.increment` pour ne pas s'écraser entre deux personnes.

Collection `fcm_tokens` : un document par appareil, d'identifiant le jeton lui-même, `{member, token, updatedAt}`.

La session (qui est connecté) est dans `localStorage` (`current-user`), propre à chaque appareil.

Sont écoutés en temps réel : `tasks`, `shopify-orders`, `shopify-products` et la collection `stock_items` ; les autres clés sont lues une fois au chargement (`loadAll()`), il faut recharger la page pour voir les modifs des autres.

## Fonctionnalités

- Connexion par choix du prénom + code à 4 chiffres, création de profil depuis l'écran de connexion (code saisi deux fois).
- 6 écrans : `home`, `tasks`, `orders`, `stock`, `team`, `notes`, navigation par `goto(screen)` et attributs `data-goto`.
- Accueil : calendrier mensuel, notes épinglées, prochaines tâches chronologiques, panneau du jour (ajout de tâche au clic sur un jour).
- Tâches : kanban 3 colonnes, assignation multiple ou « Toute l'équipe », répétition hebdomadaire, fenêtre de détail au clic.
- Commandes (`#screen-orders`) : commandes Shopify ouvertes non expédiées, tableau regroupé par produit + variante (quantité à envoyer, nombre de commandes), puis détail par commande avec lien vers l'admin Shopify. Bouton « Actualiser ».
- Stock (`#screen-stock`) : liste des produits actifs Shopify et de leurs variantes, quantité gérée à la main (+/− ou saisie). Une variante qui n'est plus active sur Shopify mais avec du stock > 0 reste affichée avec le badge « Plus en vente » ; à 0, elle disparaît. Recherche par produit, taille ou SKU. Avant la première synchro Shopify, la liste est vide.
- Équipe : qui est connecté, déconnexion, activation des notifications, ajout et suppression de membres.
- Notes : un onglet par membre plus un onglet « Toute l'équipe », plusieurs notes par onglet, épinglage vers l'accueil.
- Notifications : écoute temps réel de `tasks` (`watchTasks`) + notifications navigateur ; push FCM même app fermée via `firebase-messaging-sw.js` et la Cloud Function.
- Mise en page mobile (barre en bas) et bureau ≥ 900px (barre latérale fixe à gauche, accueil et notes sur deux colonnes).

## Design

Thème sombre façon app fitness : fond `#101114`, cartes `#1B1D22`, accent orange `#FF5A36`, coins arrondis (variables `--radius-*`), texture camouflage (branches/écorce) sur les éléments actifs et boutons. Logo ARMY NOÏSY dans l'en-tête et sur l'écran de connexion.

## État actuel et reste à faire

Le code client des notifications push est en ligne, avec la clé VAPID : chaque appareil enregistre son jeton dans `fcm_tokens`. La Cloud Function `notifyNewTasks` (`functions/index.js`) est **déployée depuis le 18/10/2026** (avec `syncShopifyScheduled`, `syncShopifyOnRequest` et les règles Firestore).

Fonctionnement : à chaque écriture de `app_data/tasks`, elle compare avant/après, et pour chaque nouvelle tâche envoie un message FCM « data » (`title`, `body`, `tag`) aux jetons des assignés (tous les `members` si `allTeam`), sauf à `createdBy`. Le service worker affiche la notification ; ne pas passer à un message avec champ `notification`, sinon elle s'affiche en double. Les jetons invalides sont supprimés de `fcm_tokens`.

**Redéployer après une modif de `functions/` ou `firestore.rules`** (depuis le PC de Dorian, Windows/PowerShell, ou Cloud Shell) : télécharger le dépôt, `cd functions && npm install && cd ..`, puis `firebase deploy --only functions,firestore:rules`. Si « Authentication Error » : `firebase login --reauth`. `firebase.json` n'a volontairement pas d'étape `predeploy`.

Premier déploiement (18/10/2026), ce qui a été nécessaire : plan Blaze ; runtime Node 22 (`engines` dans `functions/package.json`) ; donner au compte de service `95639638697-compute@developer.gserviceaccount.com` les rôles Cloud Build Service Account, Lecteur des objets Storage, Rédacteur Artifact Registry et Rédacteur de journaux (sinon « Build failed: Access to bucket gcf-sources-… denied »). Les fonctions (1re génération) s'exécutent avec `armynoisymanagerapp@appspot.gserviceaccount.com`, qui n'avait aucun rôle : lui ont été donnés Utilisateur Cloud Datastore et Administrateur de l'API Firebase Cloud Messaging (sinon « 7 PERMISSION_DENIED » dans `firebase functions:log`). Synchro Shopify vérifiée en production le 18/10/2026. Diagnostic : `firebase functions:log --only <nom>`. Attention en saisissant un secret : rien ne s'affiche, et un double collage a déjà donné une adresse en double (vérifier avec `firebase functions:secrets:access NOM`).

### Shopify (commandes à faire et liste du stock)

`syncShopify` (dans `functions/index.js`, commandes + produits actifs) tourne toutes les 15 min et à chaque écriture de `app_data/shopify-sync-request`. Elle obtient un jeton (valable 24 h) par *client credentials grant* puis lit l'API Admin GraphQL (`SHOPIFY_API_VERSION`, à remonter quand Shopify retire la version). Le jeton Shopify ne doit **jamais** être dans `index.html` (site public) : tout passe par la fonction.

Mise en place (**faite le 18/10/2026** : app « ARMY NOISY Manager » sur le Dev Dashboard, boutique `mstwntdnetwork.myshopify.com`, 3 secrets enregistrés) :
1. Sur https://dev.shopify.com (Dev Dashboard, même organisation que la boutique) : créer une app, lui donner les scopes `read_orders` et `read_products`, publier une version et l'installer sur la boutique. Récupérer l'identifiant client et le secret client dans les paramètres de l'app.
2. `firebase functions:secrets:set SHOPIFY_STORE` (ex. `army-noisy.myshopify.com`), puis `SHOPIFY_CLIENT_ID`, puis `SHOPIFY_CLIENT_SECRET`.
3. Déployer (étape 2 ci-dessus). Pour ne déployer que les notifications sans Shopify : `firebase deploy --only functions:notifyNewTasks,firestore:rules`.

`read_orders` ne donne accès qu'aux 60 derniers jours de commandes, suffisant pour des commandes à expédier.

### Prochaine tâche : refaire les SKU Shopify (demandé par Dorian le 17/10/2026)

Format `TNOM-COL-TAILLE`, ex. t-shirt « Grillz » blanc S → `TGRLZ-WHT-S` :
- **T** = une lettre par type d'article, commune à tous les articles du même type (H hoodie, T t-shirt, C casquette, S sweat…) ; signaler à Dorian si deux types tombent sur la même lettre.
- **NOM** : 5 lettres max (diminutif reconnaissable, ex. GRLZ) ; différencier deux produits qui donneraient le même.
- **COL** : couleur en **3 lettres** (validé par Dorian) : BLK, WHT, RED, BLU, GRY, BEI…
- **TAILLE** : telle quelle (XS, S, M, L, XL, XXL).

Procédure : lire tous les produits et variantes via le connecteur Shopify, montrer à Dorian un tableau ancien SKU → nouveau SKU, **ne rien modifier avant sa validation**, garder une copie des anciens SKU, puis appliquer. Les SKU sont recopiés dans `stock_items` (champ `sku`) : ils se mettront à jour au prochain +/− ; l'affichage du Stock prend ceux de `shopify-products` (synchro toutes les 15 min).

Notifications push vérifiées en production le 18/10/2026 (app fermée sur iPhone).

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
