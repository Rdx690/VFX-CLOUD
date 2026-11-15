# SOURAJITVFX CLOUD

A VPS management panel. The panel runs on **Railway**; the actual Ubuntu 24.04 / Debian 12 environments run on **your own Proxmox VE server**. Railway does not provide KVM, a Docker daemon, public IPv4 allocation or privileged SSH services, so the panel never hosts VPS instances itself. It only talks to Proxmox over its API and to each VPS over SSH.

If no infrastructure is configured, the panel shows: *"VPS infrastructure is not configured yet. Connect a supported Linux virtualization host to enable VPS creation."* and creates nothing. There are no fake terminals, credentials or instances.

## How it works

1. User clicks **Create VPS**. The panel allocates an IP from your pool and creates an **LXC container** (unprivileged, CPU/RAM/disk limits) on Proxmox from the Ubuntu/Debian template.
2. The panel's SSH key is the only way into the fresh container. It logs in as root once, creates the customer's Linux user (sudo), sets the password and/or the customer's public key, sets `PermitRootLogin no`, locks root and clears root's keys.
3. The customer connects with Termius or any SSH client to the displayed IP, port and username.
4. The web terminal is a real SSH session from the panel to the customer's VPS (using the panel key), bridged over WebSocket. It never touches the Railway host shell.

Note: the panel's public key stays in the customer user's `~/.ssh/authorized_keys` so the web terminal and password changes work. Disclose this to customers.

## 1. Prepare Proxmox VE

1. Download templates: *local storage → CT Templates → Templates*: `ubuntu-24.04-standard` and `debian-12-standard`. Copy the exact volume IDs (e.g. `local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst`) into the panel's *Infrastructure* settings later.
2. Create an API user and token with the minimum role:
   ```bash
   pveum user add svxpanel@pve
   pveum role add SVXPanel -privs "VM.Allocate VM.Audit VM.PowerMgmt VM.Config.Disk VM.Config.CPU VM.Config.Memory VM.Config.Network VM.Config.Options VM.Monitor Datastore.AllocateSpace Datastore.Audit SDN.Use Sys.Audit"
   pveum aclmod / -user svxpanel@pve -role SVXPanel
   pveum user token add svxpanel@pve panel --privsep 0
   ```
   Save the token secret. It is shown once. (`PROXMOX_TOKEN_ID=svxpanel@pve!panel`.)
3. Create the panel SSH key (on your computer, not the server):
   ```bash
   ssh-keygen -t ed25519 -N "" -f panel_key
   # Put the private key in one line with \n for newlines:
   awk 'NF {printf "%s\\n", $0}' panel_key
   ```
   Paste that into `PLATFORM_SSH_PRIVATE_KEY`.
4. Make the container IPs reachable from the internet. Pick one mode:
   - **Dedicated IPs (recommended):** put a pool of public IPs on the bridge (e.g. a routed /29 from your datacenter). Set gateway, CIDR and pool in the panel. Each VPS gets its own IP on port 22. Leave *SSH port base* at 0.
   - **Shared IP + port forwarding:** put containers on a private subnet (e.g. `10.10.10.0/24` on `vmbr1`, with NAT for outbound). Set *Public host* to your server's public IP/hostname and *SSH port base* to e.g. `20000`. A VPS at `10.10.10.N` is reached at port `20000+N`. Add forwarding rules once for the whole pool:
     ```bash
     for n in $(seq 10 250); do
       iptables -t nat -A PREROUTING -p tcp --dport $((20000+n)) -j DNAT --to 10.10.10.$n:22
     done
     iptables -A FORWARD -p tcp -d 10.10.10.0/24 --dport 22 -j ACCEPT
     ```
     Persist with `iptables-persistent`. Only SSH ports are exposed, never the Proxmox API port to users (restrict 8006 to the Railway egress or put it behind a reverse proxy/VPN with a valid certificate).
5. Containers need outbound internet during bootstrap (to install `sudo` on minimal images).

## 2. Deploy on Railway

1. Push this folder to a GitHub repository.
2. Railway → **New Project → Deploy from GitHub repo**. Railway detects `railway.json` and builds the `Dockerfile`.
3. In the same project: **New → Database → PostgreSQL**.
4. In the web service → **Variables**, add (see `.env.example`):
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `NODE_ENV` = `production`
   - `SESSION_SECRET` = `openssl rand -hex 32`
   - `ENCRYPTION_KEY` = `openssl rand -hex 32` (64 hex chars). **Back it up. Losing it makes stored SSH passwords unreadable.**
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD` (12+ chars). Creates the first admin (username `sysadmin`) on first boot. Remove `ADMIN_PASSWORD` afterwards.
   - `PROXMOX_URL`, `PROXMOX_TOKEN_ID`, `PROXMOX_TOKEN_SECRET`, `PLATFORM_SSH_PRIVATE_KEY`
   - `PROXMOX_CA_CERT` (PEM with `\n`) if you use a private CA, or `PROXMOX_INSECURE_TLS=true` for testing only.
5. **Settings → Networking → Generate Domain**. Health check path `/health` is set by `railway.json`.
6. Open the domain, sign in as admin → **Infrastructure**: enter node name, storage, bridge, gateway, CIDR, IP pool, templates, then **Save**. The status card shows live Proxmox CPU/RAM/disk once connected.
7. Migrations run automatically at startup. Tables: `users, servers, server_credentials, server_metrics, payments, audit_logs, admin_settings` (plus `session`).

The Railway app must be able to reach `PROXMOX_URL` and each VPS's `ip:port` from the internet. Railway has no fixed egress IP on standard plans, so firewall SSH/API by key, token and TLS rather than by source IP.

## 3. Connect with Termius

1. Create a VPS in the dashboard and wait until the status is **running** (1–2 minutes).
2. Open the server page. It shows IP, port and username. Press **Reveal** and confirm your account password to see the password.
3. Termius → **Hosts → New Host**: Address = IP, Port = SSH port, Username = username.
4. Password: enter the revealed password. Or **Keychain → Keys** and attach the key whose public half you pasted at creation.
5. Save and connect. If password login is disabled by the admin, only keys work.

## Security notes

- Passwords: bcrypt (cost 12). Sessions: server-side in PostgreSQL, HttpOnly + Secure + SameSite=Lax cookie, rotated on login.
- CSRF token required on every state-changing request; WebSocket checks `Origin` and the session.
- Rate limits on all API routes, with stricter limits on login, registration, password reveal and password change.
- Input validated with zod. SSH usernames/passwords are restricted to safe character sets.
- SSH passwords encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`). Revealing requires re-entering the account password and is audited.
- Roles: `user` and `admin`; all admin routes are server-side enforced. Suspending a user stops their servers and kills their sessions.
- No root credentials are ever shown to users. Container root is locked after bootstrap. The panel never runs shell commands on the Railway host.
- Audit log covers sign-ins, server lifecycle, password reveal/change, terminal opens and admin changes.

## Limitations (honest list)

- Only the Proxmox LXC backend is implemented. `lib/provider.js` is the adapter boundary for adding libvirt or other hosts. LXC containers are Linux environments, not KVM virtual machines with their own kernel.
- `payments` table exists, but no billing flow is wired.
- Host key pinning for new containers is not implemented (trust on first connect).
- Resource limits are applied at creation. Resizing existing servers is not implemented.

## Local development

```bash
cp .env.example .env   # fill in values, and point DATABASE_URL to a local Postgres
npm install
export $(grep -v '^#' .env | xargs) && node server.js
```
