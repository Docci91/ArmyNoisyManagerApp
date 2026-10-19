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

// Prénoms de l'équipe et jetons FCM par prénom.
async function loadMembersAndTokens(){
  const membersSnap = await db.collection('app_data').doc('members').get();
  const members = membersSnap.exists ? JSON.parse(membersSnap.data().value || '[]') : [];
  const tokensSnap = await db.collection('fcm_tokens').get();
  const tokensByMember = {};
  tokensSnap.forEach(doc=>{
    const {member, token} = doc.data();
    if(!member || !token) return;
    (tokensByMember[member] = tokensByMember[member] || []).push(token);
  });
  return {members, tokensByMember};
}

// Envoie une notification aux prénoms donnés ; ajoute les jetons invalides à `invalidTokens`.
// Message « data » uniquement : c'est le service worker qui affiche la notification
// (sinon elle apparaîtrait en double).
async function notifyMembers(names, tokensByMember, data, invalidTokens){
  const tokens = [...new Set(names.flatMap(name=>tokensByMember[name] || []))];
  if(tokens.length === 0) return;
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    data,
    webpush: { headers: { Urgency: 'high' } }
  });
  res.responses.forEach((r, i)=>{
    if(!r.success && r.error && INVALID_TOKEN_ERRORS.has(r.error.code)){
      invalidTokens.add(tokens[i]);
    }
  });
}

// Nettoie les jetons d'appareils désinstallés ou expirés.
function deleteTokens(invalidTokens){
  return Promise.all([...invalidTokens].map(t=>db.collection('fcm_tokens').doc(t).delete()));
}

const MAX_NEW_TASK_PUSHES = 5;
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

const assigneesOf = (task, members) => task.allTeam ? members : (task.assignees || []);
const whoLabel = task => task.allTeam ? "Toute l'équipe" : (task.assignees || []).join(', ');

exports.notifyNewTasks = functions.firestore
  .document('app_data/tasks')
  .onWrite(async (change)=>{
    const before = parseTasks(change.before);
    const after = parseTasks(change.after);
    const knownIds = new Set(before.map(t=>t.id));
    // Plafond : une écriture anormale (ou malveillante, les règles étant ouvertes)
    // ne doit pas inonder l'équipe de notifications.
    const newTasks = after.filter(t=>!knownIds.has(t.id)).slice(0, MAX_NEW_TASK_PUSHES);
    if(newTasks.length === 0) return;

    const {members, tokensByMember} = await loadMembersAndTokens();
    const invalidTokens = new Set();
    for(const task of newTasks){
      const recipients = assigneesOf(task, members)
        .filter(name=>name !== task.createdBy); // pas de push à l'auteur de la tâche
      await notifyMembers(recipients, tokensByMember, {
        title: 'Nouvelle tâche — ARMY NOÏSY',
        body: clip(`${task.title} — assignée à ${whoLabel(task)}`, 200),
        tag: String(task.id)
      }, invalidTokens);
    }
    await deleteTokens(invalidTokens);
  });

// ---------- Rappels d'échéance ----------
// Chaque matin à 9 h (heure de Paris) : rappel aux assignés des tâches non terminées
// dont l'échéance est demain ou aujourd'hui (tâches hebdomadaires comprises,
// même règle que taskOccursOn dans index.html).
const REMINDER_TZ = 'Europe/Paris';

function isoInZone(date, timeZone){
  // en-CA donne AAAA-MM-JJ.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function taskOccursOn(task, iso){
  if(!task.due) return false;
  if(task.due === iso) return true;
  if(task.repeat === 'weekly' && iso > task.due){
    const dueDay = new Date(task.due + 'T00:00:00Z').getUTCDay();
    return dueDay === new Date(iso + 'T00:00:00Z').getUTCDay();
  }
  return false;
}

exports.remindTasks = functions.pubsub
  .schedule('0 9 * * *')
  .timeZone(REMINDER_TZ)
  .onRun(async ()=>{
    const now = new Date();
    const today = isoInZone(now, REMINDER_TZ);
    const tomorrow = isoInZone(new Date(now.getTime() + 24 * 3600 * 1000), REMINDER_TZ);

    const tasks = parseTasks(await db.collection('app_data').doc('tasks').get())
      .filter(t=>t.status !== 'done');
    const {members, tokensByMember} = await loadMembersAndTokens();
    const invalidTokens = new Set();
    for(const task of tasks){
      const when = taskOccursOn(task, today) ? "aujourd'hui" : (taskOccursOn(task, tomorrow) ? 'demain' : null);
      if(!when) continue;
      await notifyMembers(assigneesOf(task, members), tokensByMember, {
        title: `Rappel : à faire ${when} — ARMY NOÏSY`,
        body: clip(`${task.title} — ${whoLabel(task)}`, 200),
        tag: `rappel-${task.id}-${when === 'demain' ? tomorrow : today}`
      }, invalidTokens);
    }
    await deleteTokens(invalidTokens);
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
// Scopes de l'app : read_orders, read_products, write_products (SKU et poids automatiques).

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
            variant { legacyResourceId sku }
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

async function shopifyGraphql(store, token, query, variables){
  const res = await fetch(`https://${store}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables })
  });
  const body = await res.json();
  if(!res.ok || body.errors) throw new Error(`Erreur Shopify : ${JSON.stringify(body.errors || res.status)}`);
  return body.data;
}

// Parcourt toutes les pages d'une requête GraphQL dont la racine est `field`.
async function shopifyQueryAll(store, token, query, field){
  const nodes = [];
  let cursor = null;
  for(let page = 0; page < 20; page++){
    const conn = (await shopifyGraphql(store, token, query, { cursor }))[field];
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
        // SKU actuel de la variante : la commande garde celui du jour de l'achat.
        sku: (li.variant && li.variant.sku) || li.sku || '',
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

// ---------- SKU et poids automatiques des nouveaux produits ----------
// À chaque synchro, les variantes des produits créés depuis AUTO_SKU_SINCE
// reçoivent un SKU au format de la boutique, TYPE-NOM-COULEUR-TAILLE
// (ex. TEE-PEARL-BLK-S ; sans couleur si le produit n'a pas d'option couleur,
// TU si pas de taille), et le poids habituel de leur type d'article.
// Chaque variante n'est traitée qu'une fois (collection shopify_auto_sku) :
// une correction faite ensuite à la main dans Shopify n'est pas écrasée.
// Les produits plus anciens ne sont jamais modifiés.
// Les codes type/couleur et les poids sont appris des produits actifs existants ;
// les tables ci-dessous servent quand la boutique n'a encore aucun exemple.

const AUTO_SKU_SINCE = '2026-10-19T00:00:00Z';
// Laisse le temps de finir la saisie du produit avant d'y toucher.
const AUTO_SKU_DELAY_MS = 5 * 60 * 1000;

const TYPE_CODES = [
  [/hoodie\s*zip|zipp|\bzip\b/, 'ZIP'],
  [/hoodie|capuche/, 'HOO'],
  [/sweat|crewneck/, 'SWT'],
  [/long\s*sleeve|longsleeve|manches?\s*longues?/, 'LGS'],
  [/polo/, 'POL'],
  [/jersey|maillot/, 'JRS'],
  [/t-?shirt|\btee\b/, 'TEE'],
  [/veste|jacket/, 'JKT'],
  [/jogg/, 'JOG'],
  [/short/, 'SHO'],
  [/pant|pantalon/, 'PNT'],
  [/bonnet|beanie/, 'BNE'],
  [/casquette|\bcap\b/, 'CAP']
];

// Poids en kg, relevés sur la boutique le 19/10/2026.
const DEFAULT_WEIGHTS = {
  TEE: 0.149, POL: 0.149, JRS: 0.149, LGS: 0.199, SHO: 0.249, JOG: 0.349, PNT: 0.349,
  SWT: 0.449, HOO: 0.449, ZIP: 0.449, JKT: 0.559, BNE: 0.1, CAP: 0.1
};

const COLOR_CODES = {
  NOIR: 'BLK', BLACK: 'BLK', BLANC: 'WHT', WHITE: 'WHT', ROUGE: 'RED', RED: 'RED',
  GRIS: 'GRY', GREY: 'GRY', GRAY: 'GRY', BLEU: 'BLU', BLUE: 'BLU', BEIGE: 'BEI',
  VIOLET: 'PRP', PURPLE: 'PRP', JAUNE: 'YLW', YELLOW: 'YLW', VERT: 'GRN', GREEN: 'GRN',
  ROSE: 'PNK', PINK: 'PNK', ORANGE: 'ORG', MARRON: 'BRN', BROWN: 'BRN', KAKI: 'KHK',
  KHAKI: 'KHK', CAMO: 'CAM', FLAMMES: 'FLM', 'NOIR & BLANC': 'KWH'
};

const AUTO_PRODUCTS_QUERY = `
  query($cursor: String) {
    products(first: 50, after: $cursor, query: "status:active OR status:draft") {
      nodes {
        id legacyResourceId title productType createdAt
        variants(first: 100) {
          nodes {
            id legacyResourceId sku selectedOptions { name value }
            inventoryItem { measurement { weight { value unit } } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const VARIANTS_UPDATE = `
  mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  }`;

const plain = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
const isColorOption = name => /COULEUR|COLOU?R/.test(plain(name));
const isSizeOption = name => /TAILLE|SIZE/.test(plain(name));

function weightKg(v){
  const w = v.inventoryItem && v.inventoryItem.measurement && v.inventoryItem.measurement.weight;
  if(!w || !w.value) return 0;
  const factor = { KILOGRAMS: 1, GRAMS: 0.001, POUNDS: 0.45359237, OUNCES: 0.028349523 }[w.unit] || 1;
  return Math.round(w.value * factor * 1000) / 1000;
}

function mostCommon(values){
  const counts = {};
  values.forEach(v=>{ counts[v] = (counts[v] || 0) + 1; });
  return Object.keys(counts).sort((a, b)=>counts[b] - counts[a])[0];
}

// Ce que les produits existants enseignent : code par type de produit,
// code par couleur et poids par code de type.
function learnNorms(products){
  const typeSeen = {}, colorSeen = {}, weightSeen = {};
  products.forEach(p=>{
    p.variants.nodes.forEach(v=>{
      const parts = (v.sku || '').split('-');
      if(parts.length < 3 || !/^[A-Z]{3}$/.test(parts[0])) return;
      const type = parts[0];
      if(p.productType) (typeSeen[plain(p.productType)] = typeSeen[plain(p.productType)] || []).push(type);
      const color = v.selectedOptions.find(o=>isColorOption(o.name));
      if(color && parts.length >= 4) (colorSeen[plain(color.value)] = colorSeen[plain(color.value)] || []).push(parts[2]);
      const w = weightKg(v);
      if(w > 0) (weightSeen[type] = weightSeen[type] || []).push(w);
    });
  });
  const pick = seen => Object.fromEntries(Object.entries(seen).map(([k, list])=>[k, mostCommon(list)]));
  const weights = pick(weightSeen);
  Object.keys(weights).forEach(k=>{ weights[k] = Number(weights[k]); });
  return { types: pick(typeSeen), colors: pick(colorSeen), weights };
}

function typeCode(product, norms){
  const learned = norms.types[plain(product.productType)];
  if(learned) return learned;
  const text = `${product.productType} ${product.title}`.toLowerCase();
  const rule = TYPE_CODES.find(([re])=>re.test(text));
  return rule ? rule[1] : '';
}

// Nom du modèle : premier mot du texte entre guillemets, 6 lettres max
// ("PEARL" TEE → PEARL, "CHOPPERS" BEANIE → CHOPPE, "NY LOGO" → NY).
function modelCode(title){
  const quoted = String(title).match(/["“”«»]\s*([^"“”«»]+?)\s*["“”«»]/);
  let text = quoted ? quoted[1] : String(title);
  if(!quoted) TYPE_CODES.forEach(([re])=>{ text = text.toLowerCase().replace(new RegExp(re.source, 'g'), ' '); });
  const word = plain(text).split(/[^A-Z0-9]+/).filter(Boolean)[0] || '';
  return word.slice(0, 6);
}

function colorCode(value, norms){
  const key = plain(value);
  return norms.colors[key] || COLOR_CODES[key] || key.replace(/[^A-Z]/g, '').slice(0, 3);
}

function sizeCode(variant){
  const size = variant.selectedOptions.find(o=>isSizeOption(o.name));
  return size ? plain(size.value).replace(/\s+/g, '') : 'TU';
}

async function autoSkuNewProducts(store, token){
  const products = await shopifyQueryAll(store, token, AUTO_PRODUCTS_QUERY, 'products');
  const now = Date.now();
  const isNew = p => p.createdAt >= AUTO_SKU_SINCE;
  const ready = products.filter(p=>isNew(p) && now - Date.parse(p.createdAt) > AUTO_SKU_DELAY_MS);
  if(!ready.length) return;

  const norms = learnNorms(products.filter(p=>!isNew(p)));
  // SKU déjà pris par d'autres produits, pour ne pas créer de doublon de modèle.
  const prefixOwner = {};
  products.filter(p=>!isNew(p)).forEach(p=>p.variants.nodes.forEach(v=>{
    const parts = (v.sku || '').split('-');
    if(parts.length >= 3) prefixOwner[`${parts[0]}-${parts[1]}`] = prefixOwner[`${parts[0]}-${parts[1]}`] || p.id;
  }));

  for(const p of ready){
    const ref = db.collection('shopify_auto_sku').doc(p.legacyResourceId);
    const snap = await ref.get();
    const done = snap.exists ? (snap.data().variants || {}) : {};
    const todo = p.variants.nodes.filter(v=>!done[v.legacyResourceId]);
    if(!todo.length) continue;

    const type = typeCode(p, norms);
    let model = modelCode(p.title);
    if(!type || !model){
      await ref.set({ title: p.title, skipped: 'Type ou nom introuvable', checkedAt: new Date().toISOString() }, { merge: true });
      continue;
    }
    // Deux produits différents du même type avec le même nom : on numérote (ex. TEE-KITTY2).
    for(let n = 2; prefixOwner[`${type}-${model}`] && prefixOwner[`${type}-${model}`] !== p.id && n < 10; n++){
      model = `${modelCode(p.title).slice(0, 5)}${n}`;
    }
    prefixOwner[`${type}-${model}`] = p.id;

    const weight = norms.weights[type] || DEFAULT_WEIGHTS[type] || 0;
    const changes = {};
    const variants = todo.map(v=>{
      const color = v.selectedOptions.find(o=>isColorOption(o.name));
      const sku = [type, model, color ? colorCode(color.value, norms) : '', sizeCode(v)].filter(Boolean).join('-');
      changes[v.legacyResourceId] = { oldSku: v.sku || '', sku, oldWeight: weightKg(v), weight: weight || weightKg(v), at: new Date().toISOString() };
      const measurement = weight ? { weight: { value: weight, unit: 'KILOGRAMS' } } : undefined;
      return { id: v.id, inventoryItem: { sku, ...(measurement ? { measurement } : {}) } };
    });

    const res = await shopifyGraphql(store, token, VARIANTS_UPDATE, { productId: p.id, variants });
    const errors = res.productVariantsBulkUpdate.userErrors;
    if(errors.length) throw new Error(`SKU automatiques « ${p.title} » : ${JSON.stringify(errors)}`);
    await ref.set({ title: p.title, variants: changes, skipped: admin.firestore.FieldValue.delete() }, { merge: true });
    console.log('auto-sku', p.title, Object.values(changes).map(c=>c.sku).join(' '));
  }
}

async function syncShopify(){
  const store = shopifyStore();
  const tokenPromise = shopifyToken(store);
  await writeSynced('shopify-orders', async ()=>({ orders: await fetchOpenOrders(store, await tokenPromise) }));
  // Avant la liste des produits, pour qu'elle contienne déjà les nouveaux SKU.
  try{ await autoSkuNewProducts(store, await tokenPromise); }
  catch(e){ console.error('auto-sku', e); }
  await writeSynced('shopify-products', async ()=>({ products: await fetchActiveProducts(store, await tokenPromise) }));
}

// Toutes les 15 minutes.
exports.syncShopifyScheduled = functions
  .runWith({ secrets: SHOPIFY_SECRETS })
  .pubsub.schedule('every 15 minutes')
  .onRun(()=>syncShopify());

// Boutons « Actualiser » des écrans Commandes et Stock : l'app écrit app_data/shopify-sync-request.
// Au plus une synchro par minute : n'importe qui peut écrire ce document (règles ouvertes),
// on évite qu'une rafale d'écritures multiplie les appels à Shopify et la facture.
const SYNC_REQUEST_MIN_GAP_MS = 60 * 1000;

async function claimSyncSlot(){
  const ref = db.collection('server_state').doc('sync-request');
  return db.runTransaction(async tx=>{
    const snap = await tx.get(ref);
    const last = snap.exists ? snap.data().lastRunAt || 0 : 0;
    if(Date.now() - last < SYNC_REQUEST_MIN_GAP_MS) return false;
    tx.set(ref, { lastRunAt: Date.now() });
    return true;
  });
}

exports.syncShopifyOnRequest = functions
  .runWith({ secrets: SHOPIFY_SECRETS })
  .firestore.document('app_data/shopify-sync-request')
  .onWrite(async ()=>{
    if(!(await claimSyncSlot())){
      console.log('sync-request ignorée : dernière synchro il y a moins d\'une minute');
      return;
    }
    await syncShopify();
  });

// ---------- Connexion (code à 4 chiffres vérifié ici, plus dans le navigateur) ----------
// Les codes sont dans la collection auth_pins (un document par prénom, hash scrypt salé),
// illisible depuis l'app. Après un bon code, la fonction renvoie un jeton Firebase
// Authentication (custom token, claim `member`) : les règles Firestore n'ouvrent
// les données qu'aux membres connectés.
// Blocage : 5 erreurs → 15 min, puis 30 min, 1 h… (24 h max) ; le membre reçoit une notification.
// Prérequis : Authentication activé dans la console, et le rôle « Créateur de jetons du
// compte de service » pour armynoisymanagerapp@appspot.gserviceaccount.com (createCustomToken).

const crypto = require('crypto');
const { HttpsError } = functions.https;

const PIN_RE = /^\d{4}$/;
const FAILS_PER_LOCK = 5;
const LEGACY_PINS_KEEP_MS = 24 * 3600 * 1000;

const pinRef = member => db.collection('auth_pins').doc(encodeURIComponent(member));
const uidOf = member => `member:${member}`;
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pin, salt) => crypto.scryptSync(pin, salt, 32).toString('hex');
const hasPin = rec => !!(rec && (rec.hash || rec.legacySha256));

function newPinRecord(pin){
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: scrypt(pin, salt), fails: 0, lockedUntil: 0, updatedAt: new Date().toISOString() };
}

function pinMatches(rec, pin){
  if(rec.hash) return crypto.timingSafeEqual(Buffer.from(scrypt(pin, rec.salt), 'hex'), Buffer.from(rec.hash, 'hex'));
  return !!rec.legacySha256 && sha256(pin) === rec.legacySha256;
}

function lockDurationMs(fails){
  if(fails % FAILS_PER_LOCK !== 0) return 0;
  return Math.min(15 * 60 * 1000 * 2 ** (fails / FAILS_PER_LOCK - 1), 24 * 3600 * 1000);
}

const hourInParis = ms => new Intl.DateTimeFormat('fr-FR', { timeZone: REMINDER_TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

async function readMembers(){
  const snap = await db.collection('app_data').doc('members').get();
  try{ return snap.exists ? JSON.parse(snap.data().value || '[]') : []; }
  catch(e){ return []; }
}

// Anciens codes (app_data/member-pins, SHA-256 sans sel, lisibles par tous) : recopiés une fois
// dans auth_pins, marqués à changer, puis le document est supprimé au bout de 24 h.
async function migrateLegacyPins(){
  const legacyRef = db.collection('app_data').doc('member-pins');
  const legacy = await legacyRef.get();
  if(!legacy.exists) return;
  const stateRef = db.collection('server_state').doc('pins-migration');
  const state = await stateRef.get();
  if(state.exists){
    if(Date.now() - state.data().at > LEGACY_PINS_KEEP_MS) await legacyRef.delete();
    return;
  }
  let pins = {};
  try{ pins = JSON.parse(legacy.data().value || '{}'); }catch(e){}
  const names = Object.keys(pins).filter(n=>typeof pins[n] === 'string');
  const existing = names.length ? await db.getAll(...names.map(pinRef)) : [];
  const batch = db.batch();
  names.forEach((name, i)=>{
    if(!existing[i].exists) batch.set(pinRef(name), { legacySha256: pins[name], fails: 0, lockedUntil: 0 });
  });
  batch.set(stateRef, { at: Date.now() });
  await batch.commit();
}

// Vérifie le code d'un membre en comptant les erreurs.
// Renvoie { ok, legacy } ou { noPin } ; lève une HttpsError si le code est faux ou le compte bloqué.
async function checkPin(member, pin){
  const ref = pinRef(member);
  const now = Date.now();
  const res = await db.runTransaction(async tx=>{
    const snap = await tx.get(ref);
    const rec = snap.exists ? snap.data() : {};
    if(!hasPin(rec)) return { noPin: true };
    if((rec.lockedUntil || 0) > now) return { lockedUntil: rec.lockedUntil };
    if(pinMatches(rec, pin)){
      if(rec.fails) tx.update(ref, { fails: 0, lockedUntil: 0 });
      return { ok: true, legacy: !rec.hash };
    }
    const fails = (rec.fails || 0) + 1;
    const lock = lockDurationMs(fails);
    tx.update(ref, { fails, lockedUntil: lock ? now + lock : 0 });
    return { justLocked: lock ? now + lock : 0, left: FAILS_PER_LOCK - (fails % FAILS_PER_LOCK) };
  });
  if(res.ok || res.noPin) return res;
  if(res.justLocked){
    const { tokensByMember } = await loadMembersAndTokens();
    await notifyMembers([member], tokensByMember, {
      title: 'Connexion bloquée — ARMY NOÏSY',
      body: `${FAILS_PER_LOCK} codes faux sur ton compte. Bloqué jusqu'à ${hourInParis(res.justLocked)}. Si ce n'était pas toi, change ton code.`,
      tag: `lock-${member}`
    }, new Set()).catch(e=>console.error('alerte blocage', e));
  }
  const until = res.lockedUntil || res.justLocked;
  if(until) throw new HttpsError('resource-exhausted', `Trop d'essais. Réessaie après ${hourInParis(until)}.`);
  throw new HttpsError('permission-denied', `Code incorrect (encore ${res.left} essai${res.left > 1 ? 's' : ''}).`);
}

// Écran de connexion : prénoms de l'équipe et qui a déjà un code.
exports.loginStatus = functions.https.onCall(async ()=>{
  await migrateLegacyPins();
  const members = await readMembers();
  const snaps = members.length ? await db.getAll(...members.map(pinRef)) : [];
  return { members, withPin: members.filter((m, i)=>snaps[i].exists && hasPin(snaps[i].data())) };
});

// Connexion, ou création du code d'un membre qui n'en a pas encore
// (ou du tout premier membre si l'équipe est vide).
exports.login = functions.https.onCall(async (data)=>{
  const member = String((data && data.member) || '').trim().slice(0, 40);
  const pin = String((data && data.pin) || '');
  if(!member || !PIN_RE.test(pin)) throw new HttpsError('invalid-argument', 'Code à 4 chiffres attendu.');
  await migrateLegacyPins();
  const members = await readMembers();
  const firstMember = members.length === 0;
  if(!firstMember && !members.includes(member)) throw new HttpsError('not-found', 'Membre inconnu.');

  let res = await checkPin(member, pin);
  if(res.noPin){
    if(!data.create) throw new HttpsError('failed-precondition', "Ce membre n'a pas encore de code.");
    // create() échoue si un autre appareil vient de créer le code entre-temps.
    try{ await pinRef(member).create(newPinRecord(pin)); }
    catch(e){ throw new HttpsError('already-exists', "Un code vient d'être créé pour ce membre."); }
    if(firstMember){
      await db.collection('app_data').doc('members').set({ value: JSON.stringify([member]), updatedAt: new Date().toISOString() });
    }
    res = { ok: true, legacy: false };
  }
  const token = await admin.auth().createCustomToken(uidOf(member), { member });
  return { token, mustChange: res.legacy };
});

// Changement de code par le membre connecté (obligatoire après un ancien code).
exports.changePin = functions.https.onCall(async (data, context)=>{
  const member = context.auth && context.auth.token.member;
  if(!member) throw new HttpsError('unauthenticated', "Connecte-toi d'abord.");
  const oldPin = String((data && data.oldPin) || '');
  const newPin = String((data && data.newPin) || '');
  if(!PIN_RE.test(oldPin) || !PIN_RE.test(newPin)) throw new HttpsError('invalid-argument', 'Code à 4 chiffres attendu.');
  if(oldPin === newPin) throw new HttpsError('invalid-argument', "Choisis un code différent de l'ancien.");
  const res = await checkPin(member, oldPin);
  if(res.noPin) throw new HttpsError('failed-precondition', "Ce membre n'a pas de code.");
  await pinRef(member).set(newPinRecord(newPin));
  return { ok: true };
});

// Membre retiré de l'équipe : ses sessions sont fermées (au plus 1 h après)
// et ses appareils ne reçoivent plus les notifications.
exports.onMembersChange = functions.firestore
  .document('app_data/members')
  .onWrite(async (change)=>{
    const list = snap => { try{ return snap.exists ? JSON.parse(snap.data().value || '[]') : []; }catch(e){ return []; } };
    const after = new Set(list(change.after));
    const removed = list(change.before).filter(m=>!after.has(m));
    for(const member of removed){
      await admin.auth().revokeRefreshTokens(uidOf(member)).catch(e=>{
        if(e.code !== 'auth/user-not-found') console.error('revoke', member, e);
      });
      const tokens = await db.collection('fcm_tokens').where('member', '==', member).get();
      await Promise.all(tokens.docs.map(d=>d.ref.delete()));
    }
  });
