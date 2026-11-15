const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { z } = require('zod');
const db = require('../database');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const { wrap, validate, HttpError } = require('../lib/http');
const { requireAuth } = require('../lib/auth');

const r = express.Router();
const RESERVED = ['root', 'admin', 'administrator', 'sudo', 'ubuntu', 'debian', 'daemon', 'nobody', 'www', 'sshd', 'bin', 'sys'];
const DUMMY = bcrypt.hashSync('dummy-password-for-timing', 12);

const registerSchema = z.object({
  email: z.string().email().max(120).transform((s) => s.toLowerCase()),
  username: z.string().regex(/^[a-z][a-z0-9_]{2,15}$/, 'use 3-16 lowercase letters, digits or _, starting with a letter'),
  password: z.string().min(10, 'at least 10 characters').max(128),
});
const loginSchema = z.object({ email: z.string().max(120), password: z.string().max(128) });

const pub = (u) => ({ id: u.id, email: u.email, username: u.username, role: u.role });

function startSession(req, user) {
  return new Promise((resolve, reject) => req.session.regenerate((err) => {
    if (err) return reject(err);
    req.session.uid = user.id;
    req.session.csrf = crypto.randomBytes(32).toString('hex');
    req.session.save((e) => (e ? reject(e) : resolve(req.session.csrf)));
  }));
}

r.post('/register', wrap(async (req, res) => {
  const s = await settings.getAll();
  if (!s.registration_open) throw new HttpError(403, 'Registration is closed');
  const d = validate(registerSchema, req.body);
  if (RESERVED.includes(d.username)) throw new HttpError(400, 'username: that name is reserved');
  const hash = await bcrypt.hash(d.password, 12);
  let u;
  try {
    u = (await db.query('INSERT INTO users(email,username,password_hash) VALUES($1,$2,$3) RETURNING id,email,username,role', [d.email, d.username, hash])).rows[0];
  } catch (e) { if (e.code === '23505') throw new HttpError(409, 'Email or username already in use'); throw e; }
  req.user = u;
  await audit.log(req, 'user.register', u.id);
  const csrf = await startSession(req, u);
  res.status(201).json({ user: pub(u), csrf });
}));

r.post('/login', wrap(async (req, res) => {
  const d = validate(loginSchema, req.body);
  const u = (await db.query('SELECT * FROM users WHERE email=$1', [d.email.toLowerCase()])).rows[0];
  const ok = await bcrypt.compare(d.password, u ? u.password_hash : DUMMY);
  if (!u || !ok) { await audit.log(req, 'user.login_failed', d.email.slice(0, 120)); throw new HttpError(401, 'Invalid email or password'); }
  if (u.status !== 'active') throw new HttpError(403, 'This account is suspended. Contact support.');
  req.user = u;
  await audit.log(req, 'user.login', u.id);
  const csrf = await startSession(req, u);
  res.json({ user: pub(u), csrf });
}));

r.post('/logout', wrap(async (req, res) => {
  await audit.log(req, 'user.logout', req.user && req.user.id);
  req.session.destroy(() => { res.clearCookie('svx.sid'); res.json({ ok: true }); });
}));

r.get('/me', requireAuth, (req, res) => res.json({ user: pub(req.user) }));

module.exports = r;
