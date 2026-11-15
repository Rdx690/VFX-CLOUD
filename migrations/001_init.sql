CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  max_servers int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  os text NOT NULL,
  vmid int,
  provider text NOT NULL DEFAULT 'proxmox',
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','running','stopped','error','deleted')),
  private_ip text,
  ip text,
  ssh_port int,
  ssh_username text,
  cpu_cores int NOT NULL,
  ram_mb int NOT NULL,
  disk_gb int NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS servers_private_ip_active ON servers(private_ip) WHERE status <> 'deleted';
CREATE INDEX IF NOT EXISTS servers_user ON servers(user_id);
CREATE TABLE IF NOT EXISTS server_credentials (
  server_id uuid PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  username text NOT NULL,
  password_enc text,
  public_key text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS server_metrics (
  id bigserial PRIMARY KEY,
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  cpu real, mem_used bigint, mem_total bigint, disk_used bigint, disk_total bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS server_metrics_lookup ON server_metrics(server_id, created_at DESC);
CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents int NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'pending',
  provider_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY,
  user_id uuid,
  action text NOT NULL,
  target text,
  ip text,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_created ON audit_logs(created_at DESC);
CREATE TABLE IF NOT EXISTS admin_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS session (
  sid varchar NOT NULL PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS session_expire ON session(expire);
