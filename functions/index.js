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
