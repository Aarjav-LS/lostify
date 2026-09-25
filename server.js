import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import crypto from 'node:crypto';

const app = express();
const port = Number(process.env.PORT || 3000);
const mongoUri = process.env.MONGODB_URI;
let db = null;
let dbError = null;

const sessions = new Map();
const loginAttempts = new Map();
const reportAttempts = new Map();
const adminEmail = process.env.ADMIN_EMAIL || 'admin@lostify.local';

app.use(express.json({ limit: '8mb' }));

const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', corsOrigin);
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function sqlDate(value) { return value ? new Date(value) : new Date(); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function token() { return crypto.randomBytes(32).toString('hex'); }
function currentUser(req) {
  const key = req.headers.authorization?.replace('Bearer ', '');
  return key ? sessions.get(key) : null;
}
function requireUser(req, res, next) { req.user = currentUser(req); if (!req.user) return res.status(401).json({ error: 'Please sign in first.' }); next(); }
function requireAdmin(req, res, next) { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' }); next(); }

async function connectDB() {
  if (!mongoUri) throw new Error('MONGODB_URI is not configured.');
  let uri = mongoUri.trim();
  if (!uri.includes('retryWrites=')) uri += (uri.includes('?') ? '&' : '?') + 'retryWrites=true&w=majority';
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10 });
  try {
    await client.connect();
    db = client.db('lostify');
    dbError = null;
  } catch (error) {
    dbError = error;
    console.error('MongoDB connection failed:', error.message);
  }
}

function users() { if (!db) throw new Error(dbError || 'Database is not connected.'); return db.collection('users'); }
function lostItems() { if (!db) throw new Error(dbError || 'Database is not connected.'); return db.collection('lost_items'); }

function publicColumns() {
  return { id: '$_id', type: 1, title: 1, description: 1, model: 1, color: 1, size: 1, category: 1, location: 1, dateOccurred: 1, photoUrl: 1, status: 1, claimRequestStatus: 1, createdAt: 1 };
}

app.get('/api/session', (req, res) => res.json({ user: currentUser(req) || null }));
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password || password.length < 8) return res.status(400).json({ error: 'Name, email, and a password of at least 8 characters are required.' });
  try {
    const existing = await users().findOne({ email: email.toLowerCase().trim() });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });
    const role = email.toLowerCase().trim() === adminEmail.toLowerCase().trim() ? 'admin' : 'user';
    const result = await users().insertOne({ openId: hash(email.toLowerCase()), name: name.trim(), email: email.toLowerCase().trim(), loginMethod: 'password', role, passwordHash: hash(password), createdAt: new Date(), lastSignedIn: new Date() });
    const user = { id: String(result.insertedId), name: name.trim(), email: email.toLowerCase().trim(), role };
    const session = token(); sessions.set(session, user); res.json({ user, session });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {}; const key = String(email || '').toLowerCase().trim(); const now = Date.now();
  if ((loginAttempts.get(key) || 0) > now) return res.status(429).json({ error: 'Please wait 15 seconds before trying again.' });
  loginAttempts.set(key, now + 15000);
  if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });
  try {
    const user = await users().findOne({ email: key });
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
    if (user.passwordHash !== hash(password)) return res.status(401).json({ error: 'Invalid email or password.' });
    delete user.passwordHash;
    const session = token(); sessions.set(session, user); res.json({ user: { id: String(user._id), name: user.name, email: user.email, role: user.role }, session });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/auth/logout', requireUser, (req, res) => { const key = req.headers.authorization?.replace('Bearer ', ''); sessions.delete(key); res.json({ ok: true }); });

app.get('/api/reports', async (req, res) => {
  try { const q = String(req.query.q || '').trim(); const category = String(req.query.category || ''); const filter = { status: 'approved' };
    if (q) filter.$or = [{ title: { $regex: q, $options: 'i' } }, { description: { $regex: q, $options: 'i' } }, { location: { $regex: q, $options: 'i' } }];
    if (category && category !== 'all') filter.category = category;
    const reports = await lostItems().find(filter).sort({ createdAt: -1 }).limit(60).project(publicColumns()).toArray();
    res.json(reports.map(r => ({ ...r, id: String(r.id) })));
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/reports/mine', requireUser, async (req, res) => {
  try {
    const mine = await lostItems().find({ reporterId: req.user.id }).sort({ createdAt: -1 }).project({ id: '$_id', type: 1, title: 1, location: 1, status: 1, claimRequestStatus: 1, claimMessage: 1, createdAt: 1 }).toArray();
    res.json(mine.map(r => ({ ...r, id: String(r.id) })));
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/reports', requireUser, async (req, res) => {
  const now = Date.now(); if (req.user.role !== 'admin' && (reportAttempts.get(req.user.id) || 0) > now) return res.status(429).json({ error: 'Report limit reached. You can submit up to 5 reports every 24 hours.' });
  try {
    const recent = await lostItems().countDocuments({ reporterId: req.user.id, createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
    if (req.user.role !== 'admin' && Number(recent) >= 5) return res.status(429).json({ error: 'Report limit reached. You can submit up to 5 reports every 24 hours.' });
    const { type, title, description, model, color, size, category, location, dateOccurred, contactEmail, photoUrl } = req.body || {};
    if (!type || !title || !description || !model || !color || !size || !category || !location || !dateOccurred || !contactEmail) return res.status(400).json({ error: 'Complete all required report fields.' });
    await lostItems().insertOne({ reporterId: req.user.id, type, title, description, model, color, size, category, location, dateOccurred: sqlDate(dateOccurred), contactEmail, photoUrl: photoUrl || null, status: 'pending', createdAt: new Date() });
    reportAttempts.set(req.user.id, now + 1000); res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/reports/:id/claim', requireUser, async (req, res) => {
  const { claimMessage } = req.body || {}; if (!claimMessage || claimMessage.trim().length < 10) return res.status(400).json({ error: 'Explain why this item belongs to you in at least 10 characters.' });
  try {
    const item = await lostItems().findOne({ _id: new ObjectId(req.params.id) });
    if (!item || item.type !== 'found' || item.status !== 'approved') return res.status(400).json({ error: 'This item is not available for a claim request.' });
    if (item.claimRequestStatus) return res.status(409).json({ error: 'This item already has a claim request.' });
    await lostItems().updateOne({ _id: item._id }, { $set: { claimRequestStatus: 'pending', claimRequestedBy: req.user.id, claimMessage: claimMessage.trim() } });
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/admin/reports', requireUser, requireAdmin, async (req, res) => {
  try {
    const reports = await lostItems().find({}).sort({ createdAt: -1 }).limit(200).toArray();
    res.json(reports.map(r => ({ ...r, id: String(r._id) })));
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.patch('/api/admin/reports/:id/status', requireUser, requireAdmin, async (req, res) => {
  const { status } = req.body || {}; if (!['pending','approved','rejected'].includes(status)) return res.status(400).json({ error: 'Only review statuses can be changed here. Claims require a request.' });
  try {
    await lostItems().updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status } });
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.patch('/api/admin/reports/:id/private', requireUser, requireAdmin, async (req, res) => {
  try {
    await lostItems().updateOne({ _id: new ObjectId(req.params.id) }, { $set: { smallDetails: String(req.body.smallDetails || ''), returnedTo: String(req.body.returnedTo || '') } });
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/admin/reports/:id/claim-decision', requireUser, requireAdmin, async (req, res) => {
  const decision = req.body?.decision; if (!['approved','rejected'].includes(decision)) return res.status(400).json({ error: 'Choose approve or reject.' });
  try {
    const item = await lostItems().findOne({ _id: new ObjectId(req.params.id) });
    if (!item || item.claimRequestStatus !== 'pending') return res.status(400).json({ error: 'There is no pending claim request.' });
    await lostItems().updateOne({ _id: item._id }, { $set: { claimRequestStatus: decision, status: decision === 'approved' ? 'claimed' : 'approved' } });
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

async function start() {
  await connectDB();
  app.listen(port, '0.0.0.0', () => console.log(`Lostify vanilla server listening on port ${port}`));
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
