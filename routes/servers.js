const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const db = require('../database');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const vps = require('../lib/vps');
const ssh = require('../lib/ssh');
const { encrypt, decrypt, randomPassword } = require('../lib/crypto');
const { wrap, validate, HttpError } = require('../lib/http');
const { requireAuth } = require('../lib/auth');

const r = express.Router();
r.use(requireAuth);

const PUBKEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+( [^\r\n]{0,80})?$/;
const createSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{1,39}$/, '2-40 letters, digits, space, - or _'),
  os: z.enum(['ubuntu-24.04', 'debian-12']),
  cpu_cores: z.coerce.number().int().min(1).max(64),
  ram_mb: z.coerce.number().int().min(256).max(262144),
  disk_gb: z.coerce.number().int().min(4).max(2048),
  public_key: z.string().trim().max(600).regex(PUBKEY, 'not a valid OpenSSH public key').optional().or(z.literal('').transform(() => undefined)),
});
const pwSchema = z.object({ new_password: z.string().min(12, 'at least 12 characters').max(64).regex(/^[A-Za-z0-9!@#%^&*_+=.-]+$/, 'letters, digits and !@#%^&*_+=.- only').optional() });

async function own(req) {
  const s = (await db.query("SELECT * FROM servers WHERE id=$1 AND user_id=$2 AND status<>'deleted'", [req.params.id, req.user.id])).rows[0];
  if (!s) throw new HttpError(404, 'Server not found');
  return s;
}

r.get('/infra', wrap(async (req, res) => {
  const all = await settings.getAll();
  const i = await vps.infraState();
  res.json({ configured: i.ok, message: i.message, os: Object.keys(all.provider.templates), limits: all.limits, allow_password_auth: all.allow_password_auth,
    quota: req.user.max_servers ?? all.max_servers_default });
}));

r.get('/', wrap(async (req, res) => {
  const rows = (await db.query(`${vps.SERVER_SELECT} WHERE s.user_id=$1 AND s.status<>'deleted' ORDER BY s.created_at DESC`, [req.user.id])).rows;
  res.json({ servers: rows });
}));

r.get('/:id', wrap(async (req, res) => {
  const s = await own(req);
  const row = (await db.query(`${vps.SERVER_SELECT} WHERE s.id=$1`, [s.id])).rows[0];
  const hist = (await db.query('SELECT cpu,mem_used,mem_total,created_at FROM server_metrics WHERE server_id=$1 ORDER BY created_at DESC LIMIT 60', [s.id])).rows.reverse();
  const cred = (await db.query('SELECT password_enc IS NOT NULL AS has_password FROM server_credentials WHERE server_id=$1', [s.id])).rows[0];
  res.json({ server: row, history: hist, has_password: !!(cred && cred.has_password) });
}));

r.post('/', wrap(async (req, res) => {
  const input = validate(createSchema, req.body);
  const { server, temp_password } = await vps.createServer({ owner: req.user, input });
  await audit.log(req, 'server.create', server.id, { os: input.os, cpu: input.cpu_cores, ram: input.ram_mb, disk: input.disk_gb });
  res.status(202).json({ server: { id: server.id, name: server.name, status: server.status, ip: server.ip, ssh_port: server.ssh_port, ssh_username: server.ssh_username, os: server.os }, temp_password });
}));

r.post('/:id/action', wrap(async (req, res) => {
  const { action } = validate(z.object({ action: z.enum(['start', 'stop', 'restart']) }), req.body);
  const s = await own(req);
  const status = await vps.serverAction(s, action);
  await audit.log(req, 'server.' + action, s.id);
  res.json({ status });
}));

r.delete('/:id', wrap(async (req, res) => {
  const s = await own(req);
  await vps.deleteServer(s);
  await audit.log(req, 'server.delete', s.id);
  res.json({ ok: true });
}));

const sensitive = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Try again later.' } });

r.post('/:id/reveal-password', sensitive, wrap(async (req, res) => {
  const { account_password } = validate(z.object({ account_password: z.string().max(128) }), req.body);
  const u = (await db.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id])).rows[0];
  if (!(await bcrypt.compare(account_password, u.password_hash))) { await audit.log(req, 'server.reveal_failed', req.params.id); throw new HttpError(401, 'Account password is incorrect'); }
  const s = await own(req);
  const c = (await db.query('SELECT password_enc FROM server_credentials WHERE server_id=$1', [s.id])).rows[0];
  if (!c || !c.password_enc) throw new HttpError(404, 'This server uses SSH key login only');
  await audit.log(req, 'server.reveal_password', s.id);
  res.json({ password: decrypt(c.password_enc) });
}));

r.post('/:id/ssh-password', sensitive, wrap(async (req, res) => {
  if (!(await settings.getAll()).allow_password_auth) throw new HttpError(403, 'Password login is disabled by the administrator');
  const { new_password } = validate(pwSchema, req.body);
  const s = await own(req);
  if (s.status !== 'running') throw new HttpError(409, 'Start the server first');
  const pw = new_password || randomPassword(20);
  try { await ssh.changePassword(s, pw); } catch (e) { throw new HttpError(502, 'Could not change the password: ' + e.message); }
  await db.query('UPDATE server_credentials SET password_enc=$2, updated_at=now() WHERE server_id=$1', [s.id, encrypt(pw)]);
  await audit.log(req, 'server.change_password', s.id);
  res.json({ password: new_password ? undefined : pw });
}));

module.exports = r;
