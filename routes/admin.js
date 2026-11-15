const express = require('express');
const { z } = require('zod');
const db = require('../database');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const vps = require('../lib/vps');
const prov = require('../lib/provider');
const { wrap, validate, HttpError } = require('../lib/http');
const { requireAuth, requireAdmin } = require('../lib/auth');

const r = express.Router();
r.use(requireAuth, requireAdmin);

r.get('/users', wrap(async (req, res) => {
  const rows = (await db.query(`SELECT u.id,u.email,u.username,u.role,u.status,u.max_servers,u.created_at,
    (SELECT count(*)::int FROM servers s WHERE s.user_id=u.id AND s.status<>'deleted') AS servers FROM users u ORDER BY u.created_at DESC`)).rows;
  res.json({ users: rows });
}));

r.post('/users/:id/suspend', wrap(async (req, res) => {
  if (req.params.id === req.user.id) throw new HttpError(400, 'You cannot suspend yourself');
  await db.query("UPDATE users SET status='suspended' WHERE id=$1", [req.params.id]);
  await db.query("DELETE FROM session WHERE sess->>'uid' = $1", [req.params.id]);
  const running = (await db.query("SELECT * FROM servers WHERE user_id=$1 AND status='running'", [req.params.id])).rows;
  for (const s of running) { try { await vps.serverAction(s, 'stop'); } catch (e) { console.error('suspend stop', e.message); } }
  await audit.log(req, 'admin.user_suspend', req.params.id);
  res.json({ ok: true });
}));
r.post('/users/:id/restore', wrap(async (req, res) => {
  await db.query("UPDATE users SET status='active' WHERE id=$1", [req.params.id]);
  await audit.log(req, 'admin.user_restore', req.params.id);
  res.json({ ok: true });
}));
r.patch('/users/:id', wrap(async (req, res) => {
  const d = validate(z.object({ max_servers: z.number().int().min(0).max(100).nullable().optional(), role: z.enum(['user', 'admin']).optional() }), req.body);
  if (d.role && req.params.id === req.user.id) throw new HttpError(400, 'You cannot change your own role');
  if ('max_servers' in d) await db.query('UPDATE users SET max_servers=$2 WHERE id=$1', [req.params.id, d.max_servers]);
  if (d.role) await db.query('UPDATE users SET role=$2 WHERE id=$1', [req.params.id, d.role]);
  await audit.log(req, 'admin.user_update', req.params.id, d);
  res.json({ ok: true });
}));

r.get('/servers', wrap(async (req, res) => {
  const rows = (await db.query(`SELECT x.*, u.username AS owner FROM (${vps.SERVER_SELECT} WHERE s.status<>'deleted') x JOIN users u ON u.id=x.user_id ORDER BY x.created_at DESC`)).rows;
  res.json({ servers: rows });
}));
r.post('/servers', wrap(async (req, res) => {
  const d = validate(z.object({
    user_id: z.string().uuid(), name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{1,39}$/),
    os: z.enum(['ubuntu-24.04', 'debian-12']), cpu_cores: z.coerce.number().int().min(1), ram_mb: z.coerce.number().int().min(256), disk_gb: z.coerce.number().int().min(4),
    public_key: z.string().max(600).optional(),
  }), req.body);
  const owner = (await db.query("SELECT id,username,max_servers FROM users WHERE id=$1 AND status='active'", [d.user_id])).rows[0];
  if (!owner) throw new HttpError(404, 'Active user not found');
  const { server } = await vps.createServer({ owner, input: d });
  await audit.log(req, 'admin.server_create', server.id, { for: d.user_id });
  res.status(202).json({ id: server.id });
}));
async function anyServer(id) {
  const s = (await db.query("SELECT * FROM servers WHERE id=$1 AND status<>'deleted'", [id])).rows[0];
  if (!s) throw new HttpError(404, 'Server not found');
  return s;
}
r.post('/servers/:id/action', wrap(async (req, res) => {
  const { action } = validate(z.object({ action: z.enum(['start', 'stop', 'restart']) }), req.body);
  const s = await anyServer(req.params.id);
  res.json({ status: await vps.serverAction(s, action) });
  await audit.log(req, 'admin.server_' + action, s.id);
}));
r.delete('/servers/:id', wrap(async (req, res) => {
  const s = await anyServer(req.params.id);
  await vps.deleteServer(s);
  await audit.log(req, 'admin.server_delete', s.id);
  res.json({ ok: true });
}));

r.get('/audit', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = (await db.query(`SELECT a.id,a.action,a.target,a.ip,a.meta,a.created_at,u.username FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT $1`, [limit])).rows;
  res.json({ logs: rows });
}));

const settingsSchema = z.object({
  registration_open: z.boolean(), allow_password_auth: z.boolean(), max_servers_default: z.number().int().min(0).max(100),
  limits: z.object({ max_cpu: z.number().int().min(1).max(64), max_ram_mb: z.number().int().min(256), max_disk_gb: z.number().int().min(4) }),
  provider: z.object({
    node: z.string().regex(/^[A-Za-z0-9.-]{0,64}$/), storage: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), bridge: z.string().regex(/^[A-Za-z0-9._-]{1,16}$/),
    gateway: z.string().regex(/^(\d+\.){3}\d+$|^$/), cidr: z.number().int().min(8).max(30),
    ip_pool: z.array(z.string().regex(/^(\d+\.){3}\d+(-\d+)?$/)).max(512), public_host: z.string().max(120).regex(/^[A-Za-z0-9.-]*$/),
    ssh_port_base: z.number().int().min(0).max(65000),
    templates: z.object({ 'ubuntu-24.04': z.string().max(200), 'debian-12': z.string().max(200) }),
  }),
});
r.get('/settings', wrap(async (req, res) => res.json({ settings: await settings.getAll() })));
r.put('/settings', wrap(async (req, res) => {
  const d = validate(settingsSchema, req.body);
  for (const k of Object.keys(d)) await settings.set(k, k === 'provider' ? { type: 'proxmox', ...d.provider } : d[k]);
  await audit.log(req, 'admin.settings_update', null);
  res.json({ ok: true });
}));

r.get('/infra', wrap(async (req, res) => {
  const i = await vps.infraState();
  const out = { configured: i.ok, missing: i.missing, message: i.message, node: null, error: null };
  const counts = (await db.query("SELECT status, count(*)::int n, coalesce(sum(cpu_cores),0)::int cpu, coalesce(sum(ram_mb),0)::int ram, coalesce(sum(disk_gb),0)::int disk FROM servers WHERE status<>'deleted' GROUP BY status")).rows;
  out.allocated = counts;
  if (i.ok) { try { out.node = await prov.nodeStatus(i.cfg); } catch (e) { out.error = e.message; } }
  res.json(out);
}));

module.exports = r;
