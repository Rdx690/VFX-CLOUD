const db = require('../database');
const DEFAULTS = {
  registration_open: true,
  allow_password_auth: true,
  max_servers_default: 2,
  limits: { max_cpu: 4, max_ram_mb: 8192, max_disk_gb: 100 },
  provider: {
    type: 'proxmox', node: '', storage: 'local-lvm', bridge: 'vmbr0', gateway: '', cidr: 24,
    ip_pool: [], public_host: '', ssh_port_base: 0,
    templates: {
      'ubuntu-24.04': 'local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst',
      'debian-12': 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst',
    },
  },
};
async function getAll() {
  const rows = (await db.query('SELECT key,value FROM admin_settings')).rows;
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  for (const { key, value } of rows) {
    if (!(key in DEFAULTS)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = { ...out[key], ...value };
      if (key === 'provider') out.provider.templates = { ...DEFAULTS.provider.templates, ...(value.templates || {}) };
    } else out[key] = value;
  }
  return out;
}
async function set(key, value) {
  if (!(key in DEFAULTS)) throw new Error('unknown setting');
  await db.query(`INSERT INTO admin_settings(key,value) VALUES($1,$2)
    ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`, [key, JSON.stringify(value)]);
}
module.exports = { getAll, set, DEFAULTS };
