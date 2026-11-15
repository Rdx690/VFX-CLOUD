// Orchestration: provider (Proxmox) + SSH bootstrap + database.
const db = require('../database');
const settings = require('./settings');
const prov = require('./provider');
const ssh = require('./ssh');
const { encrypt, randomPassword } = require('./crypto');
const { HttpError } = require('./http');

const NOT_CONFIGURED = 'VPS infrastructure is not configured yet. Connect a supported Linux virtualization host to enable VPS creation.';

function expandPool(list) {
  const out = [];
  for (const raw of list || []) {
    const s = String(raw).trim();
    const m = s.match(/^(\d+\.\d+\.\d+\.)(\d+)-(\d+)$/);
    if (m) for (let i = +m[2]; i <= +m[3] && i < 255; i++) out.push(m[1] + i);
    else if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) out.push(s);
  }
  return out;
}

async function infraState() {
  const cfg = (await settings.getAll()).provider;
  const st = prov.configState(cfg, !!ssh.platformKey());
  return { cfg, ...st, message: st.ok ? null : NOT_CONFIGURED };
}

async function createServer({ owner, input }) {
  const all = await settings.getAll();
  const infra = await infraState();
  if (!infra.ok) throw new HttpError(503, NOT_CONFIGURED);
  const cfg = infra.cfg;
  if (!cfg.templates[input.os]) throw new HttpError(400, 'Unsupported operating system');
  const L = all.limits;
  if (input.cpu_cores > L.max_cpu || input.ram_mb > L.max_ram_mb || input.disk_gb > L.max_disk_gb)
    throw new HttpError(400, `Limits: ${L.max_cpu} CPU, ${L.max_ram_mb} MB RAM, ${L.max_disk_gb} GB disk`);
  const quota = owner.max_servers ?? all.max_servers_default;
  const have = (await db.query("SELECT count(*)::int n FROM servers WHERE user_id=$1 AND status<>'deleted'", [owner.id])).rows[0].n;
  if (have >= quota) throw new HttpError(409, `Server limit reached (${quota})`);
  const allowPw = all.allow_password_auth;
  if (!allowPw && !input.public_key) throw new HttpError(400, 'An SSH public key is required (password login is disabled)');

  const used = new Set((await db.query("SELECT private_ip FROM servers WHERE status<>'deleted' AND private_ip IS NOT NULL")).rows.map((r) => r.private_ip));
  const candidates = expandPool(cfg.ip_pool).filter((ip) => !used.has(ip));
  const base = Number(cfg.ssh_port_base) || 0;
  let server;
  for (const ip of candidates) {
    const port = base ? base + Number(ip.split('.')[3]) : 22;
    const pub = base ? cfg.public_host : ip;
    if (base && !cfg.public_host) throw new HttpError(503, NOT_CONFIGURED);
    try {
      server = (await db.query(
        `INSERT INTO servers(user_id,name,os,private_ip,ip,ssh_port,ssh_username,cpu_cores,ram_mb,disk_gb)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [owner.id, input.name, input.os, ip, pub, port, owner.username, input.cpu_cores, input.ram_mb, input.disk_gb])).rows[0];
      break;
    } catch (e) { if (e.code !== '23505') throw e; }
  }
  if (!server) throw new HttpError(409, 'No free IP addresses in the pool');

  const password = allowPw ? randomPassword(20) : null;
  await db.query('INSERT INTO server_credentials(server_id,username,password_enc,public_key) VALUES($1,$2,$3,$4)',
    [server.id, owner.username, password ? encrypt(password) : null, input.public_key || null]);
  provision(server, cfg, password, input.public_key, allowPw).catch(() => {});
  return { server, temp_password: password };
}

async function provision(s, cfg, password, pubKey, allowPw) {
  try {
    const vmid = await prov.nextId();
    await db.query('UPDATE servers SET vmid=$2 WHERE id=$1', [s.id, vmid]);
    await prov.create(cfg, { vmid, os: s.os, cpu_cores: s.cpu_cores, ram_mb: s.ram_mb, disk_gb: s.disk_gb, private_ip: s.private_ip,
      root_password: randomPassword(32), panel_public_key: ssh.platformKey().pub });
    await ssh.bootstrap({ host: s.ip, port: s.ssh_port, username: s.ssh_username, password, userPublicKey: pubKey, allowPassword: allowPw });
    await db.query("UPDATE servers SET status='running', error=NULL WHERE id=$1", [s.id]);
  } catch (e) {
    console.error('provision failed', s.id, e.message);
    await db.query("UPDATE servers SET status='error', error=$2 WHERE id=$1", [s.id, e.message.slice(0, 300)]);
    throw e;
  }
}

async function serverAction(server, act) {
  if (!['start', 'stop', 'restart'].includes(act)) throw new HttpError(400, 'Invalid action');
  if (!server.vmid || server.status === 'creating') throw new HttpError(409, 'Server is not ready');
  const cfg = (await settings.getAll()).provider;
  try { await prov.action(cfg, server.vmid, act); } catch (e) { throw new HttpError(502, 'Infrastructure error: ' + e.message); }
  const status = act === 'stop' ? 'stopped' : 'running';
  await db.query('UPDATE servers SET status=$2, error=NULL WHERE id=$1', [server.id, status]);
  return status;
}

async function deleteServer(server) {
  const cfg = (await settings.getAll()).provider;
  if (server.vmid) {
    try { await prov.destroy(cfg, server.vmid); } catch (e) { throw new HttpError(502, 'Infrastructure error: ' + e.message); }
  }
  await db.query("UPDATE servers SET status='deleted', private_ip=NULL WHERE id=$1", [server.id]);
  await db.query('DELETE FROM server_credentials WHERE server_id=$1', [server.id]);
  await db.query('DELETE FROM server_metrics WHERE server_id=$1', [server.id]);
}

async function collectMetrics() {
  const infra = await infraState();
  if (!infra.ok) return;
  const rows = (await db.query("SELECT id,vmid,status FROM servers WHERE vmid IS NOT NULL AND status IN ('running','stopped')")).rows;
  for (const s of rows) {
    try {
      const m = await prov.state(infra.cfg, s.vmid);
      if (m.status !== s.status) await db.query('UPDATE servers SET status=$2 WHERE id=$1', [s.id, m.status]);
      if (m.status === 'running')
        await db.query('INSERT INTO server_metrics(server_id,cpu,mem_used,mem_total,disk_used,disk_total) VALUES($1,$2,$3,$4,$5,$6)',
          [s.id, m.cpu, m.mem_used, m.mem_total, m.disk_used, m.disk_total]);
    } catch (e) { console.error('metrics', s.id, e.message); }
  }
  await db.query("DELETE FROM server_metrics WHERE created_at < now() - interval '24 hours'");
}

const SERVER_SELECT = `SELECT s.id,s.user_id,s.name,s.os,s.vmid,s.status,s.ip,s.ssh_port,s.ssh_username,s.cpu_cores,s.ram_mb,s.disk_gb,s.error,s.created_at,
  m.cpu,m.mem_used,m.mem_total,m.disk_used,m.disk_total
  FROM servers s LEFT JOIN LATERAL (SELECT cpu,mem_used,mem_total,disk_used,disk_total FROM server_metrics WHERE server_id=s.id ORDER BY created_at DESC LIMIT 1) m ON true`;

module.exports = { NOT_CONFIGURED, infraState, createServer, serverAction, deleteServer, collectMetrics, SERVER_SELECT };
