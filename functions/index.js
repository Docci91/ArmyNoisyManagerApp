// Envoie une notification push (FCM) aux membres concernés par chaque
// nouvelle tâche, même quand l'app est fermée sur leur appareil.
// Déclenchée à chaque écriture du document app_data/tasks.

const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const INVALID_TOKEN_ERRORS = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument'
]);

function parseTasks(snap){
  if(!snap.exists) return [];
  try{ return JSON.parse(snap.data().value || '[]'); }
  catch(e){ return []; }
}

exports.notifyNewTasks = functions.firestore
  .document('app_data/tasks')
  .onWrite(async (change)=>{
    const before = parseTasks(change.before);
    const after = parseTasks(change.after);
    const knownIds = new Set(before.map(t=>t.id));
    const newTasks = after.filter(t=>!knownIds.has(t.id));
    if(newTasks.length === 0) return;

    const membersSnap = await db.collection('app_data').doc('members').get();
    const members = membersSnap.exists ? JSON.parse(membersSnap.data().value || '[]') : [];

    const tokensSnap = await db.collection('fcm_tokens').get();
    const tokensByMember = {};
    tokensSnap.forEach(doc=>{
      const {member, token} = doc.data();
      if(!member || !token) return;
      (tokensByMember[member] = tokensByMember[member] || []).push(token);
    });

    const invalidTokens = new Set();
    for(const task of newTasks){
      const recipients = (task.allTeam ? members : (task.assignees || []))
        .filter(name=>name !== task.createdBy); // pas de push à l'auteur de la tâche
      const tokens = [...new Set(recipients.flatMap(name=>tokensByMember[name] || []))];
      if(tokens.length === 0) continue;

      const who = task.allTeam ? "Toute l'équipe" : (task.assignees || []).join(', ');
      // Message « data » uniquement : c'est le service worker qui affiche la
      // notification (sinon elle apparaîtrait en double).
      const res = await admin.messaging().sendEachForMulticast({
        tokens,
        data: {
          title: 'Nouvelle tâche — ARMY NOÏSY',
          body: `${task.title} — assignée à ${who}`,
          tag: String(task.id)
        },
        webpush: { headers: { Urgency: 'high' } }
      });
      res.responses.forEach((r, i)=>{
        if(!r.success && r.error && INVALID_TOKEN_ERRORS.has(r.error.code)){
          invalidTokens.add(tokens[i]);
        }
      });
    }

    // Nettoie les jetons d'appareils désinstallés ou expirés.
    await Promise.all([...invalidTokens].map(t=>db.collection('fcm_tokens').doc(t).delete()));
  });

// ---------- Shopify : commandes à envoyer + produits actifs ----------
// Copie depuis Shopify, dans Firestore :
//  - app_data/shopify-orders   : commandes ouvertes non (ou partiellement) expédiées
//                                (numéro, date, articles ; aucune donnée client,
//                                car les règles Firestore sont ouvertes) ;
//  - app_data/shopify-products : produits actifs et leurs variantes, pour l'écran Stock.
// Les quantités de stock, elles, sont saisies à la main dans la collection stock_items.
//
// Secrets à définir une fois (firebase functions:secrets:set NOM) :
//   SHOPIFY_STORE          ex. army-noisy.myshopify.com
//   SHOPIFY_CLIENT_ID      identifiant client de l'app (Dev Dashboard Shopify)
//   SHOPIFY_CLIENT_SECRET  secret client de l'app
// Scopes de l'app : read_orders, read_products.

const SHOPIFY_SECRETS = ['SHOPIFY_STORE', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'];
const SHOPIFY_API_VERSION = '2026-07';

const ORDERS_QUERY = `
  query($cursor: String) {
    orders(first: 50, after: $cursor, sortKey: CREATED_AT,
           query: "status:open AND (fulfillment_status:unfulfilled OR fulfillment_status:partial)") {
      nodes {
        legacyResourceId
        name
        createdAt
        lineItems(first: 100) {
          nodes {
            title variantTitle sku unfulfilledQuantity
            variant { legacyResourceId }
            image { url(transform: { maxWidth: 160, maxHeight: 160 }) }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const PRODUCTS_QUERY = `
  query($cursor: String) {
    products(first: 50, after: $cursor, sortKey: TITLE, query: "status:active") {
      nodes {
        legacyResourceId
        title
        productType
        featuredMedia { preview { image { url(transform: { maxWidth: 160, maxHeight: 160 }) } } }
        variants(first: 100) {
          nodes {
            legacyResourceId title sku selectedOptions { name value }
            media(first: 1) { nodes { preview { image { url(transform: { maxWidth: 160, maxHeight: 160 }) } } } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

function shopifyStore(){
  return (process.env.SHOPIFY_STORE || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

async function shopifyToken(store){
  // Jeton valable 24 h, obtenu à chaque synchro (client credentials grant).
  const res = await fetch(`https://${store}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET
    })
  });
  if(!res.ok) throw new Error(`Connexion Shopify refusée (${res.status})`);
  return (await res.json()).access_token;
}

// Parcourt toutes les pages d'une requête GraphQL dont la racine est `field`.
async function shopifyQueryAll(store, token, query, field){
  const nodes = [];
  let cursor = null;
  for(let page = 0; page < 20; page++){
    const res = await fetch(`https://${store}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables: { cursor } })
    });
    const body = await res.json();
    if(!res.ok || body.errors) throw new Error(`Erreur Shopify : ${JSON.stringify(body.errors || res.status)}`);
    const conn = body.data[field];
    nodes.push(...conn.nodes);
    if(!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return nodes;
}

async function fetchOpenOrders(store, token){
  const nodes = await shopifyQueryAll(store, token, ORDERS_QUERY, 'orders');
  const orders = [];
  nodes.forEach(o=>{
    const items = o.lineItems.nodes
      .filter(li=>li.unfulfilledQuantity > 0)
      .map(li=>({
        title: li.title,
        variant: li.variantTitle || '',
        sku: li.sku || '',
        qty: li.unfulfilledQuantity,
        variantId: (li.variant && li.variant.legacyResourceId) || '',
        image: (li.image && li.image.url) || ''
      }));
    if(items.length) orders.push({
      id: o.legacyResourceId,
      name: o.name,
      createdAt: o.createdAt,
      url: `https://${store}/admin/orders/${o.legacyResourceId}`,
      items
    });
  });
  return orders;
}

function mediaUrl(media){
  return (media && media.preview && media.preview.image && media.preview.image.url) || '';
}

async function fetchActiveProducts(store, token){
  const nodes = await shopifyQueryAll(store, token, PRODUCTS_QUERY, 'products');
  return nodes.map(p=>({
    id: p.legacyResourceId,
    title: p.title,
    productType: p.productType || '',
    image: mediaUrl(p.featuredMedia),
    variants: p.variants.nodes.map(v=>({
      id: v.legacyResourceId,
      // Shopify nomme « Default Title » la variante unique d'un produit sans options.
      title: v.title === 'Default Title' ? '' : v.title,
      sku: v.sku || '',
      // Image de la variante (souvent la photo de la couleur) ; sinon on prend celle du produit.
      image: mediaUrl(v.media && v.media.nodes[0]),
      // Options (taille, couleur…) pour regrouper les tailles d'un article sur une ligne.
      options: v.selectedOptions.filter(o=>o.value !== 'Default Title').map(o=>({ name: o.name, value: o.value }))
    }))
  }));
}

// Écrit `build()` dans app_data/<key> ; en cas d'erreur, garde les dernières
// données connues et ajoute le message d'erreur.
async function writeSynced(key, build){
  let payload;
  try{
    payload = { syncedAt: new Date().toISOString(), ...(await build()) };
  }catch(e){
    console.error(key, e);
    const prev = await db.collection('app_data').doc(key).get();
    const old = prev.exists ? JSON.parse(prev.data().value || '{}') : {};
    payload = { ...old, error: e.message, errorAt: new Date().toISOString() };
  }
  await db.collection('app_data').doc(key).set({
    value: JSON.stringify(payload),
    updatedAt: new Date().toISOString()
  });
}

async function syncShopify(){
  const store = shopifyStore();
  const tokenPromise = shopifyToken(store);
  await writeSynced('shopify-orders', async ()=>({ orders: await fetchOpenOrders(store, await tokenPromise) }));
  await writeSynced('shopify-products', async ()=>({ products: await fetchActiveProducts(store, await tokenPromise) }));
}

// Toutes les 15 minutes.
exports.syncShopifyScheduled = functions
  .runWith({ secrets: SHOPIFY_SECRETS })
  .pubsub.schedule('every 15 minutes')
  .onRun(()=>syncShopify());

// Boutons « Actualiser » des écrans Commandes et Stock : l'app écrit app_data/shopify-sync-request.
exports.syncShopifyOnRequest = functions
  .runWith({ secrets: SHOPIFY_SECRETS })
  .firestore.document('app_data/shopify-sync-request')
  .onWrite(()=>syncShopify());
