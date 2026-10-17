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

// ---------- Shopify : commandes à envoyer ----------
// Récupère les commandes ouvertes non (ou partiellement) expédiées et les écrit
// dans app_data/shopify-orders, que la page « Commandes » écoute en temps réel.
// Seuls le numéro, la date et les articles sont copiés : aucune donnée client,
// car les règles Firestore sont ouvertes.
//
// Secrets à définir une fois (firebase functions:secrets:set NOM) :
//   SHOPIFY_STORE          ex. army-noisy.myshopify.com
//   SHOPIFY_CLIENT_ID      identifiant client de l'app (Dev Dashboard Shopify)
//   SHOPIFY_CLIENT_SECRET  secret client de l'app

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
          nodes { title variantTitle sku unfulfilledQuantity }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

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

async function fetchOpenOrders(){
  const store = (process.env.SHOPIFY_STORE || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = await shopifyToken(store);
  const orders = [];
  let cursor = null;
  for(let page = 0; page < 20; page++){
    const res = await fetch(`https://${store}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: ORDERS_QUERY, variables: { cursor } })
    });
    const body = await res.json();
    if(!res.ok || body.errors) throw new Error(`Erreur Shopify : ${JSON.stringify(body.errors || res.status)}`);
    const conn = body.data.orders;
    conn.nodes.forEach(o=>{
      const items = o.lineItems.nodes
        .filter(li=>li.unfulfilledQuantity > 0)
        .map(li=>({ title: li.title, variant: li.variantTitle || '', sku: li.sku || '', qty: li.unfulfilledQuantity }));
      if(items.length) orders.push({
        id: o.legacyResourceId,
        name: o.name,
        createdAt: o.createdAt,
        url: `https://${store}/admin/orders/${o.legacyResourceId}`,
        items
      });
    });
    if(!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return orders;
}

async function syncShopifyOrders(){
  let payload;
  try{
    payload = { syncedAt: new Date().toISOString(), orders: await fetchOpenOrders() };
  }catch(e){
    console.error(e);
    // On garde les dernières commandes connues et on signale l'erreur.
    const prev = await db.collection('app_data').doc('shopify-orders').get();
    const old = prev.exists ? JSON.parse(prev.data().value || '{}') : {};
    payload = { ...old, error: e.message, errorAt: new Date().toISOString() };
  }
  await db.collection('app_data').doc('shopify-orders').set({
    value: JSON.stringify(payload),
    updatedAt: new Date().toISOString()
  });
}

// Toutes les 15 minutes.
exports.syncShopifyOrdersScheduled = functions
  .runWith({ secrets: SHOPIFY_SECRETS })
  .pubsub.schedule('every 15 minutes')
  .onRun(()=>syncShopifyOrders());

// Bouton « Actualiser » de la page : l'app écrit app_data/shopify-sync-request.
exports.syncShopifyOrdersOnRequest = functions
  .runWith({ secrets: SHOPIFY_SECRETS })
  .firestore.document('app_data/shopify-sync-request')
  .onWrite(()=>syncShopifyOrders());
