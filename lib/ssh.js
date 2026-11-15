const { Client, utils } = require('ssh2');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function platformKey() {
  const pem = (process.env.PLATFORM_SSH_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  if (!pem) return null;
  let k = utils.parseKey(pem);
  if (Array.isArray(k)) k = k[0];
  if (!k || k instanceof Error) return null;
  return { pem, pub: `${k.type} ${k.getPublicSSH().toString('base64')} sourajitvfx-panel` };
}

function connect({ host, port, username, key }) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => resolve(c)).on('error', reject);
    c.connect({ host, port, username, privateKey: key, readyTimeout: 15000, keepaliveInterval: 15000 });
  });
}

function run(c, cmd, stdin) {
  return new Promise((resolve, reject) => {
    c.exec(cmd, (err, s) => {
      if (err) return reject(err);
      let out = '', er = '';
      s.on('data', (d) => (out += d)).stderr.on('data', (d) => (er += d));
      s.on('close', (code) => resolve({ code, out, err: er }));
      if (stdin) s.end(stdin); else s.end();
    });
  });
}

// First-boot setup: reachable only with the panel key. Creates the customer user, sets auth policy, locks root.
async function bootstrap({ host, port, username, password, userPublicKey, allowPassword }) {
  const pk = platformKey();
  let c, lastErr;
  for (let i = 0; i < 30 && !c; i++) {
    try { c = await connect({ host, port, username: 'root', key: pk.pem }); } catch (e) { lastErr = e; await sleep(5000); }
  }
  if (!c) throw new Error('Could not reach new VPS over SSH: ' + (lastErr && lastErr.message));
  try {
    // username/password are validated upstream (^[a-z][a-z0-9_]{2,15}$ and alphanumeric) and also sent over stdin
    const script = `set -e
U='${username}'
command -v sudo >/dev/null || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sudo)
id -u "$U" >/dev/null 2>&1 || useradd -m -s /bin/bash "$U"
${password ? `echo "$U:${password}" | chpasswd` : `usermod -p '*' "$U"`}
usermod -aG sudo "$U"
echo "$U ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$U"; chmod 440 "/etc/sudoers.d/90-$U"
install -d -m 700 -o "$U" -g "$U" "/home/$U/.ssh"
cat > "/home/$U/.ssh/authorized_keys" <<'EOF_KEYS'
${pk.pub}
${userPublicKey || ''}
EOF_KEYS
chown "$U:$U" "/home/$U/.ssh/authorized_keys"; chmod 600 "/home/$U/.ssh/authorized_keys"
mkdir -p /etc/ssh/sshd_config.d
printf 'PasswordAuthentication ${allowPassword ? 'yes' : 'no'}\\nPermitRootLogin no\\n' > /etc/ssh/sshd_config.d/00-sourajitvfx.conf
(systemctl restart ssh || systemctl restart sshd) >/dev/null 2>&1
passwd -l root >/dev/null 2>&1 || true
: > /root/.ssh/authorized_keys
`;
    const r = await run(c, 'bash -s', script);
    if (r.code !== 0) throw new Error('Bootstrap failed: ' + (r.err || r.out).slice(0, 300));
  } finally { c.end(); }
}

async function userClient(server) {
  return connect({ host: server.ip, port: server.ssh_port, username: server.ssh_username, key: platformKey().pem });
}

async function changePassword(server, newPassword) {
  const c = await userClient(server);
  try {
    const r = await run(c, 'sudo -n chpasswd', `${server.ssh_username}:${newPassword}\n`);
    if (r.code !== 0) throw new Error('Password change failed: ' + r.err.slice(0, 200));
  } finally { c.end(); }
}

async function openShell(server, cols, rows) {
  const c = await userClient(server);
  return new Promise((resolve, reject) => {
    c.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => (err ? (c.end(), reject(err)) : resolve({ client: c, stream })));
  });
}

module.exports = { platformKey, bootstrap, changePassword, openShell };
