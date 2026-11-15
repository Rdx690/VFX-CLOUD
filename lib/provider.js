// Infrastructure adapter. Talks to a REAL Proxmox VE host through its API token.
// Other backends (libvirt, remote Linux) can be added by implementing the same interface:
//   status(cfg) / nextId / create / action / destroy / state / nodeStatus
const https = require('https');
const { URL } = require('url');
const env = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(env.PROXMOX_URL.replace(/\/$/, '') + '/api2/json' + path);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      method, hostname: u.hostname, port: u.port || 8006, path: u.pathname + u.search, timeout: 30000,
      rejectUnauthorized: env.PROXMOX_INSECURE_TLS !== 'true',
      ca: env.PROXMOX_CA_CERT ? env.PROXMOX_CA_CERT.replace(/\\n/g, '\n') : undefined,
      headers: {
        Authorization: `PVEAPIToken=${env.PROXMOX_TOKEN_ID}=${env.PROXMOX_TOKEN_SECRET}`,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => {
        let j; try { j = JSON.parse(b); } catch { /* ignore */ }
        if (r.statusCode >= 400) return reject(new Error(`Proxmox ${r.statusCode}: ${r.statusMessage}${j && j.errors ? ' ' + JSON.stringify(j.errors) : ''}`));
        resolve(j ? j.data : null);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Proxmox request timed out')));
    if (data) req.write(data);
    req.end();
  });
}

async function waitTask(node, upid, timeoutMs = 300000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    const s = await call('GET', `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`);
    if (s.status === 'stopped') {
      if (s.exitstatus !== 'OK') throw new Error('Proxmox task failed: ' + s.exitstatus);
      return;
    }
    await sleep(2000);
  }
  throw new Error('Proxmox task timed out');
}

// Returns { ok, message }. `cfg` = provider settings from admin_settings.
function configState(cfg, platformKeyOk) {
  const missing = [];
  if (!env.PROXMOX_URL || !env.PROXMOX_TOKEN_ID || !env.PROXMOX_TOKEN_SECRET) missing.push('PROXMOX_* environment variables');
  if (!platformKeyOk) missing.push('PLATFORM_SSH_PRIVATE_KEY');
  if (!cfg.node) missing.push('Proxmox node name');
  if (!cfg.gateway) missing.push('gateway');
  if (!cfg.ip_pool || !cfg.ip_pool.length) missing.push('IP pool');
  return missing.length ? { ok: false, missing } : { ok: true, missing: [] };
}

const nextId = () => call('GET', '/cluster/nextid').then(Number);

async function create(cfg, o) {
  const tpl = cfg.templates[o.os];
  if (!tpl) throw new Error('No template configured for ' + o.os);
  const upid = await call('POST', `/nodes/${cfg.node}/lxc`, {
    vmid: o.vmid,
    hostname: `svx-${o.vmid}`,
    ostemplate: tpl,
    rootfs: `${cfg.storage}:${o.disk_gb}`,
    cores: o.cpu_cores,
    memory: o.ram_mb,
    swap: 512,
    unprivileged: 1,
    features: 'nesting=1',
    net0: `name=eth0,bridge=${cfg.bridge},ip=${o.private_ip}/${cfg.cidr},gw=${cfg.gateway}`,
    nameserver: '1.1.1.1 8.8.8.8',
    password: o.root_password,                       // random, discarded; root is locked during bootstrap
    // Proxmox stores this URL-encoded, so the REST API expects it encoded
    'ssh-public-keys': encodeURIComponent(o.panel_public_key + '\n'),
    onboot: 1,
    start: 1,
  });
  await waitTask(cfg.node, upid);
}

async function action(cfg, vmid, act) {
  const map = { start: 'start', stop: 'stop', restart: 'reboot' };
  const upid = await call('POST', `/nodes/${cfg.node}/lxc/${vmid}/status/${map[act]}`);
  await waitTask(cfg.node, upid, 120000);
}

async function destroy(cfg, vmid) {
  try {
    const st = await call('GET', `/nodes/${cfg.node}/lxc/${vmid}/status/current`);
    if (st.status === 'running') await action(cfg, vmid, 'stop');
  } catch (e) { if (/does not exist|500|404/.test(e.message)) return; throw e; }
  const upid = await call('DELETE', `/nodes/${cfg.node}/lxc/${vmid}?purge=1&destroy-unreferenced-disks=1`);
  await waitTask(cfg.node, upid, 180000);
}

async function state(cfg, vmid) {
  const s = await call('GET', `/nodes/${cfg.node}/lxc/${vmid}/status/current`);
  return {
    status: s.status === 'running' ? 'running' : 'stopped',
    cpu: (s.cpu || 0) * 100, mem_used: s.mem || 0, mem_total: s.maxmem || 0,
    disk_used: s.disk || 0, disk_total: s.maxdisk || 0,
  };
}

async function nodeStatus(cfg) {
  const [version, node] = await Promise.all([call('GET', '/version'), call('GET', `/nodes/${cfg.node}/status`)]);
  return {
    version: version.version, uptime: node.uptime, cpu: (node.cpu || 0) * 100,
    cpus: node.cpuinfo && node.cpuinfo.cpus, mem_used: node.memory.used, mem_total: node.memory.total,
    disk_used: node.rootfs && node.rootfs.used, disk_total: node.rootfs && node.rootfs.total,
  };
}

module.exports = { configState, nextId, create, action, destroy, state, nodeStatus };
