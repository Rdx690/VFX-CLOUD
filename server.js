const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { WebSocketServer } = require('ws');
const db = require('./database');
const { loadUser } = require('./lib/auth');
const ssh = require('./lib/ssh');
const vps = require('./lib/vps');
const audit = require('./lib/audit');

const prod = process.env.NODE_ENV === 'production';
for (const k of ['DATABASE_URL', 'SESSION_SECRET', 'ENCRYPTION_KEY']) {
  if (!process.env[k]) { console.error(`Missing required env var ${k}`); process.exit(1); }
}
if (process.env.SESSION_SECRET.length < 32) { console.error('SESSION_SECRET must be at least 32 characters'); process.exit(1); }

const app = express();
app.set('trust proxy', 1); // Railway terminates TLS in front of the app
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      imgSrc: ["'self'", 'data:'],
      frameAncestors: ["'none'"],
    },
  },
}));

// Health check (no auth, no session)
app.get('/health', async (req, res) => {
  try { await db.query('SELECT 1'); res.json({ status: 'ok' }); } catch { res.status(503).json({ status: 'db_unavailable' }); }
});

const sessionMiddleware = session({
  name: 'svx.sid',
  store: new PgStore({ pool: db.pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  rolling: true,
  cookie: { httpOnly: true, secure: prod, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 },
});

app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: prod ? '1h' : 0 }));

app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' } }));
app.use('/api/auth/register', rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many sign-ups from this address.' } }));

app.use('/api', sessionMiddleware, loadUser);

// CSRF: per-session token, required as a header on every state-changing request
app.use('/api', (req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex');
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const a = Buffer.from(req.get('x-csrf-token') || ''), b = Buffer.from(req.session.csrf);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).json({ error: 'Invalid CSRF token. Reload the page.' });
  next();
});
app.get('/api/csrf', (req, res) => res.json({ csrf: req.session.csrf, user: req.user ? { id: req.user.id, email: req.user.email, username: req.user.username, role: req.user.role } : null }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/servers', require('./routes/servers'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && prod ? 'Internal server error' : err.message });
});

// ---- Web terminal: a real SSH session to the user's own VPS, bridged over WebSocket ----
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const reject = (code) => { socket.write(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws/terminal') return reject('404 Not Found');
  if (!req.headers.origin || new URL(req.headers.origin).host !== req.headers.host) return reject('403 Forbidden'); // cross-site WebSocket hijacking guard
  sessionMiddleware(req, {}, async () => {
    try {
      const uid = req.session && req.session.uid;
      if (!uid) return reject('401 Unauthorized');
      const u = (await db.query("SELECT id,role FROM users WHERE id=$1 AND status='active'", [uid])).rows[0];
      if (!u) return reject('401 Unauthorized');
      const id = url.searchParams.get('server') || '';
      if (!/^[0-9a-f-]{36}$/.test(id)) return reject('400 Bad Request');
      const s = (await db.query("SELECT * FROM servers WHERE id=$1 AND status='running' AND ($2 OR user_id=$3)", [id, u.role === 'admin', u.id])).rows[0];
      if (!s) return reject('404 Not Found');
      wss.handleUpgrade(req, socket, head, (ws) => attachTerminal(ws, s, u));
    } catch (e) { console.error('ws upgrade', e.message); reject('500 Internal Server Error'); }
  });
});

async function attachTerminal(ws, s, u) {
  let conn;
  try {
    conn = await ssh.openShell(s, 100, 30);
  } catch (e) { ws.send('\r\n\x1b[31mCould not open SSH session: ' + e.message + '\x1b[0m\r\n'); return ws.close(); }
  audit.log({ user: u, ip: null }, 'terminal.open', s.id);
  conn.stream.on('data', (d) => ws.readyState === 1 && ws.send(d.toString('utf8')));
  conn.stream.on('close', () => { ws.close(); conn.client.end(); });
  ws.on('message', (m) => {
    try {
      const msg = JSON.parse(m.toString());
      if (msg.t === 'd' && typeof msg.d === 'string') conn.stream.write(msg.d);
      else if (msg.t === 'r') conn.stream.setWindow(Math.min(+msg.r || 30, 200), Math.min(+msg.c || 100, 400), 0, 0);
    } catch { /* ignore malformed frames */ }
  });
  ws.on('close', () => { conn.stream.end(); conn.client.end(); });
}

async function ensureAdmin() {
  const n = (await db.query("SELECT count(*)::int n FROM users WHERE role='admin'")).rows[0].n;
  if (n || !process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) return;
  if (process.env.ADMIN_PASSWORD.length < 12) { console.error('ADMIN_PASSWORD must be at least 12 characters'); return; }
  const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
  await db.query("INSERT INTO users(email,username,password_hash,role) VALUES($1,'sysadmin',$2,'admin') ON CONFLICT DO NOTHING", [process.env.ADMIN_EMAIL.toLowerCase(), hash]);
  console.log('Initial admin created. Remove ADMIN_PASSWORD from the environment.');
}

(async () => {
  await db.migrate();
  await ensureAdmin();
  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log('SOURAJITVFX CLOUD listening on', port));
  setInterval(() => vps.collectMetrics().catch((e) => console.error('collector', e.message)), 60000);
  setInterval(() => db.query('DELETE FROM session WHERE expire < now()').catch(() => {}), 3600000);
})().catch((e) => { console.error('Startup failed:', e); process.exit(1); });

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
