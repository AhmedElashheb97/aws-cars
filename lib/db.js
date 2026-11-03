/* Firestore access for the API (Firebase Admin, bypasses the browser rules).
   Needs the env var FIREBASE_SERVICE_ACCOUNT = the service-account JSON (plain or base64). */
let _db = null;
function setDb(d) { _db = d; } // used by tests
function db() {
  if (_db) return _db;
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    let raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set in Vercel');
    if (!raw.trim().startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
  const fs = admin.firestore();
  _db = {
    async all(c) { const s = await fs.collection(c).get(); return s.docs.map(d => ({ id: d.id, ...d.data() })); },
    async get(c, id) { const s = await fs.collection(c).doc(String(id)).get(); return s.exists ? { id: s.id, ...s.data() } : null; },
    async add(c, data) { return (await fs.collection(c).add(data)).id; },
    async merge(c, id, data) { await fs.collection(c).doc(String(id)).set(data, { merge: true }); },
    async update(c, id, data) { await fs.collection(c).doc(String(id)).update(data); },
    async del(c, id) { await fs.collection(c).doc(String(id)).delete(); }
  };
  return _db;
}
/* Firestore rejects undefined values */
const clean = o => JSON.parse(JSON.stringify(o, (k, v) => (v === undefined ? null : v)));
module.exports = { db, setDb, clean };
