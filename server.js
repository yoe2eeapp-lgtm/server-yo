/**
 * Yo! — Self-Hosted Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Stack : Node.js + Express + Socket.IO + sql.js (pure JS SQLite — NO native deps)
 * Auth  : JWT
 * Cost  : $0 — works on Railway, Fly.io, Render, Raspberry Pi, anything
 *
 * WHY sql.js instead of better-sqlite3:
 *   better-sqlite3 needs C++ compilation (gyp) which fails on Railway/Nixpacks.
 *   sql.js is 100% JavaScript WebAssembly — installs and runs everywhere instantly.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express        = require('express');
const http           = require('http');
const { Server }     = require('socket.io');
const initSqlJs      = require('sql.js');
const bcrypt         = require('bcryptjs');
const jwt            = require('jsonwebtoken');
const cors           = require('cors');
const { v4: uuidv4 } = require('uuid');
const path           = require('path');
const fs             = require('fs');

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT    = process.env.PORT    || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'yo.db');

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const f = path.join(__dirname, '.jwt_secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = require('crypto').randomBytes(64).toString('hex');
  fs.writeFileSync(f, s);
  console.log('✅ Generated JWT secret');
  return s;
})();

// ─── Database ─────────────────────────────────────────────────────────────────

let db;

async function initDb() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
    console.log('📂 Loaded database:', DB_PATH);
  } else {
    db = new SQL.Database();
    console.log('🆕 Created new database');
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id               TEXT PRIMARY KEY,
      username         TEXT UNIQUE NOT NULL COLLATE NOCASE,
      display_name     TEXT NOT NULL,
      bio              TEXT DEFAULT '',
      password_hash    TEXT NOT NULL,
      public_key       TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      connection_count INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
      UNIQUE(from_id, to_id)
    );
    CREATE TABLE IF NOT EXISTS connections (
      user_a TEXT NOT NULL, user_b TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(user_a, user_b)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
      sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
      sender_public_key TEXT NOT NULL, iv TEXT NOT NULL, ciphertext TEXT NOT NULL,
      sent_at INTEGER NOT NULL, delivered INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv  ON messages(conversation_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_req_to    ON requests(to_id, status);
    CREATE INDEX IF NOT EXISTS idx_req_from  ON requests(from_id, status);
    CREATE INDEX IF NOT EXISTS idx_users_usr ON users(username);
  `);

  save();
  setInterval(save, 30_000); // auto-save every 30s
}

function save() {
  try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }
  catch (e) { console.error('DB save error:', e.message); }
}

// ─── Query helpers ────────────────────────────────────────────────────────────

function one(sql, p = []) {
  const s = db.prepare(sql);
  s.bind(p);
  const row = s.step() ? s.getAsObject() : null;
  s.free();
  return row;
}

function all(sql, p = []) {
  const rows = [], s = db.prepare(sql);
  s.bind(p);
  while (s.step()) rows.push(s.getAsObject());
  s.free();
  return rows;
}

function run(sql, p = []) { db.run(sql, p); save(); }

function tx(fn) {
  db.run('BEGIN');
  try { fn(); db.run('COMMIT'); save(); }
  catch (e) { db.run('ROLLBACK'); throw e; }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try { req.userId = jwt.verify(h.slice(7), JWT_SECRET).userId; next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function socketAuth(socket, next) {
  try { socket.userId = jwt.verify(socket.handshake.auth?.token, JWT_SECRET).userId; next(); }
  catch { next(new Error('Invalid token')); }
}

function fmt(u) {
  return { id: u.id, username: u.username, displayName: u.display_name,
    bio: u.bio || '', publicKey: u.public_key,
    createdAt: u.created_at, connectionCount: u.connection_count || 0 };
}

function convId(a, b) { return [a, b].sort().join('_'); }
function token(id) { return jwt.sign({ userId: id }, JWT_SECRET, { expiresIn: '30d' }); }

// ─── Express App ──────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' }, transports: ['websocket', 'polling'],
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Health
app.get('/health', (_, res) => res.json({ status: 'ok', time: Date.now() }));

// ── Signup ────────────────────────────────────────────────────────────────────
app.post('/auth/signup', async (req, res) => {
  try {
    const { username, displayName, password, publicKey } = req.body;
    if (!username || !displayName || !password || !publicKey)
      return res.status(400).json({ error: 'Missing fields' });
    if (username.length < 3 || username.length > 30)
      return res.status(400).json({ error: 'Username must be 3–30 characters' });
    if (!/^[a-zA-Z0-9_]+$/.test(username))
      return res.status(400).json({ error: 'Letters, numbers, underscores only' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be ≥8 characters' });
    if (one('SELECT id FROM users WHERE username = ?', [username.toLowerCase()]))
      return res.status(409).json({ error: 'Username already taken' });

    const id = uuidv4();
    run('INSERT INTO users (id,username,display_name,bio,password_hash,public_key,created_at) VALUES (?,?,?,?,?,?,?)',
      [id, username.toLowerCase(), displayName, '', await bcrypt.hash(password, 12), publicKey, Date.now()]);

    res.status(201).json({ token: token(id), user: fmt(one('SELECT * FROM users WHERE id=?', [id])) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Login ─────────────────────────────────────────────────────────────────────
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = one('SELECT * FROM users WHERE username = ?', [(username || '').toLowerCase()]);
    if (!user || !(await bcrypt.compare(password || '', user.password_hash)))
      return res.status(401).json({ error: 'Invalid username or password' });
    res.json({ token: token(user.id), user: fmt(user) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Me ────────────────────────────────────────────────────────────────────────
app.get('/me', auth, (req, res) => {
  const u = one('SELECT * FROM users WHERE id=?', [req.userId]);
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json(fmt(u));
});

app.patch('/me', auth, (req, res) => {
  const { displayName, bio } = req.body;
  if (displayName !== undefined) run('UPDATE users SET display_name=? WHERE id=?', [displayName, req.userId]);
  if (bio !== undefined)         run('UPDATE users SET bio=? WHERE id=?', [bio, req.userId]);
  res.json(fmt(one('SELECT * FROM users WHERE id=?', [req.userId])));
});

app.patch('/me/publickey', auth, (req, res) => {
  if (!req.body.publicKey) return res.status(400).json({ error: 'Missing publicKey' });
  run('UPDATE users SET public_key=? WHERE id=?', [req.body.publicKey, req.userId]);
  res.json({ ok: true });
});

// ── Users ─────────────────────────────────────────────────────────────────────
app.get('/users/search', auth, (req, res) => {
  const q = ((req.query.q || '') + '').toLowerCase().trim();
  if (q.length < 2) return res.json([]);
  res.json(all('SELECT * FROM users WHERE username LIKE ? AND id!=? LIMIT 20',
    [`${q}%`, req.userId]).map(fmt));
});

app.get('/users/:id', auth, (req, res) => {
  const u = one('SELECT * FROM users WHERE id=?', [req.params.id]);
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json(fmt(u));
});

// ── Requests ──────────────────────────────────────────────────────────────────
app.post('/requests', auth, (req, res) => {
  const { toId } = req.body;
  if (!toId || toId === req.userId) return res.status(400).json({ error: 'Invalid toId' });
  if (!one('SELECT id FROM users WHERE id=?', [toId]))
    return res.status(404).json({ error: 'User not found' });
  if (one('SELECT 1 FROM connections WHERE (user_a=? AND user_b=?) OR (user_a=? AND user_b=?)',
    [req.userId, toId, toId, req.userId]))
    return res.status(409).json({ error: 'Already connected' });
  try {
    const id = uuidv4(), now = Date.now();
    run('INSERT INTO requests (id,from_id,to_id,status,created_at) VALUES (?,?,?,?,?)',
      [id, req.userId, toId, 'pending', now]);
    const from = one('SELECT username, display_name FROM users WHERE id=?', [req.userId]);
    const rq = { id, fromId: req.userId, fromUsername: from.username,
      fromDisplayName: from.display_name, toId, status: 'pending', createdAt: now };
    io.to(`user:${toId}`).emit('connection_request', rq);
    res.status(201).json(rq);
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Already sent' });
    throw e;
  }
});

app.get('/requests/incoming', auth, (req, res) => {
  res.json(all(`SELECT r.*,u.username as fu,u.display_name as fd
    FROM requests r JOIN users u ON r.from_id=u.id
    WHERE r.to_id=? AND r.status='pending' ORDER BY r.created_at DESC`, [req.userId])
    .map(r => ({ id:r.id, fromId:r.from_id, fromUsername:r.fu,
      fromDisplayName:r.fd, toId:r.to_id, status:r.status, createdAt:r.created_at })));
});

app.get('/requests/outgoing', auth, (req, res) => {
  res.json(all(`SELECT r.*,u.username as tu,u.display_name as td
    FROM requests r JOIN users u ON r.to_id=u.id
    WHERE r.from_id=? AND r.status='pending' ORDER BY r.created_at DESC`, [req.userId])
    .map(r => ({ id:r.id, fromId:r.from_id, fromUsername:r.tu,
      fromDisplayName:r.td, toId:r.to_id, status:r.status, createdAt:r.created_at })));
});

app.post('/requests/:id/accept', auth, (req, res) => {
  const rq = one("SELECT * FROM requests WHERE id=? AND to_id=? AND status='pending'",
    [req.params.id, req.userId]);
  if (!rq) return res.status(404).json({ error: 'Request not found' });
  const now = Date.now();
  tx(() => {
    db.run("UPDATE requests SET status='accepted' WHERE id=?", [rq.id]);
    db.run('INSERT OR IGNORE INTO connections (user_a,user_b,created_at) VALUES (?,?,?)', [rq.from_id, rq.to_id, now]);
    db.run('INSERT OR IGNORE INTO connections (user_a,user_b,created_at) VALUES (?,?,?)', [rq.to_id, rq.from_id, now]);
    db.run('UPDATE users SET connection_count=connection_count+1 WHERE id=?', [rq.from_id]);
    db.run('UPDATE users SET connection_count=connection_count+1 WHERE id=?', [rq.to_id]);
  });
  const me = one('SELECT display_name FROM users WHERE id=?', [req.userId]);
  io.to(`user:${rq.from_id}`).emit('request_accepted',
    { requestId: rq.id, byId: req.userId, byDisplayName: me?.display_name });
  res.json({ ok: true });
});

app.post('/requests/:id/reject', auth, (req, res) => {
  const rq = one("SELECT id FROM requests WHERE id=? AND to_id=? AND status='pending'",
    [req.params.id, req.userId]);
  if (!rq) return res.status(404).json({ error: 'Not found' });
  run("UPDATE requests SET status='rejected' WHERE id=?", [rq.id]);
  res.json({ ok: true });
});

// ── Connections ───────────────────────────────────────────────────────────────
app.get('/connections', auth, (req, res) => {
  res.json(all('SELECT u.* FROM connections c JOIN users u ON c.user_b=u.id WHERE c.user_a=?',
    [req.userId]).map(fmt));
});

app.get('/connections/status/:userId', auth, (req, res) => {
  const o = req.params.userId;
  if (one('SELECT 1 FROM connections WHERE user_a=? AND user_b=?', [req.userId, o]))
    return res.json({ status: 'connected' });
  if (one("SELECT 1 FROM requests WHERE from_id=? AND to_id=? AND status='pending'", [req.userId, o]))
    return res.json({ status: 'pending_sent' });
  if (one("SELECT 1 FROM requests WHERE from_id=? AND to_id=? AND status='pending'", [o, req.userId]))
    return res.json({ status: 'pending_received' });
  res.json({ status: 'none' });
});

app.delete('/connections/:userId', auth, (req, res) => {
  tx(() => {
    db.run('DELETE FROM connections WHERE (user_a=? AND user_b=?) OR (user_a=? AND user_b=?)',
      [req.userId, req.params.userId, req.params.userId, req.userId]);
    db.run('UPDATE users SET connection_count=MAX(0,connection_count-1) WHERE id=?', [req.userId]);
    db.run('UPDATE users SET connection_count=MAX(0,connection_count-1) WHERE id=?', [req.params.userId]);
  });
  res.json({ ok: true });
});

// ── Messages ──────────────────────────────────────────────────────────────────
app.get('/messages/:contactId', auth, (req, res) => {
  const cid    = convId(req.userId, req.params.contactId);
  const before = parseInt(req.query.before) || Date.now() + 9999;
  const limit  = Math.min(parseInt(req.query.limit) || 50, 100);
  const rows   = all('SELECT * FROM messages WHERE conversation_id=? AND sent_at<? ORDER BY sent_at DESC LIMIT ?',
    [cid, before, limit]);
  run('UPDATE messages SET delivered=1 WHERE conversation_id=? AND recipient_id=? AND delivered=0',
    [cid, req.userId]);
  res.json(rows.reverse().map(m => ({
    id: m.id, senderId: m.sender_id, recipientId: m.recipient_id,
    encryptedPayload: { senderPublicKey: m.sender_public_key, iv: m.iv, ciphertext: m.ciphertext },
    timestamp: m.sent_at, delivered: !!m.delivered,
  })));
});

app.get('/conversations', auth, (req, res) => {
  const conns = all('SELECT u.* FROM connections c JOIN users u ON c.user_b=u.id WHERE c.user_a=?',
    [req.userId]).map(fmt);
  const previews = conns.map(contact => {
    const last = one('SELECT * FROM messages WHERE conversation_id=? ORDER BY sent_at DESC LIMIT 1',
      [convId(req.userId, contact.id)]);
    return {
      contact,
      lastMessage: last ? {
        id: last.id, senderId: last.sender_id, recipientId: last.recipient_id,
        encryptedPayload: { senderPublicKey: last.sender_public_key, iv: last.iv, ciphertext: last.ciphertext },
        timestamp: last.sent_at, isMine: last.sender_id === req.userId,
      } : null,
    };
  });
  previews.sort((a, b) => (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0));
  res.json(previews);
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.use(socketAuth);
const online = new Map();

io.on('connection', socket => {
  const uid = socket.userId;
  socket.join(`user:${uid}`);
  if (!online.has(uid)) online.set(uid, new Set());
  online.get(uid).add(socket.id);
  io.emit('user_online', { userId: uid, online: true });

  socket.on('send_message', (data, ack) => {
    try {
      const { recipientId, encryptedPayload: ep } = data;
      if (!recipientId || !ep?.senderPublicKey)
        return ack?.({ error: 'Invalid data' });
      if (!one('SELECT 1 FROM connections WHERE user_a=? AND user_b=?', [uid, recipientId]))
        return ack?.({ error: 'Not connected' });

      const id = uuidv4(), now = Date.now(), cid = convId(uid, recipientId);
      run('INSERT INTO messages (id,conversation_id,sender_id,recipient_id,sender_public_key,iv,ciphertext,sent_at) VALUES (?,?,?,?,?,?,?,?)',
        [id, cid, uid, recipientId, ep.senderPublicKey, ep.iv, ep.ciphertext, now]);

      io.to(`user:${recipientId}`).emit('message', { id, senderId: uid, recipientId, encryptedPayload: ep, timestamp: now });
      ack?.({ ok: true, id, timestamp: now });
    } catch (e) { console.error(e); ack?.({ error: 'Server error' }); }
  });

  socket.on('typing', ({ recipientId, isTyping }) => {
    io.to(`user:${recipientId}`).emit('typing', { fromId: uid, isTyping });
  });

  socket.on('disconnect', () => {
    const s = online.get(uid);
    if (s) { s.delete(socket.id); if (!s.size) { online.delete(uid); io.emit('user_online', { userId: uid, online: false }); } }
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

initDb().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  🔐 Yo! Server  →  port ${PORT}\n  DB: ${DB_PATH}\n  No Google. No Firebase. Just yours.\n`);
  });
}).catch(e => { console.error('Startup failed:', e); process.exit(1); });

process.on('SIGTERM', () => { save(); process.exit(0); });
process.on('SIGINT',  () => { save(); process.exit(0); });
