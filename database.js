const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 10,
});
pool.on('error', (e) => console.error('pg pool error', e.message));

async function migrate() {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
  const dir = path.join(__dirname, 'migrations');
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
    if (done.rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [f]);
      await client.query('COMMIT');
      console.log('migrated', f);
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
}
module.exports = { pool, query: (t, p) => pool.query(t, p), migrate };
