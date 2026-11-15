const db = require('../database');
async function log(req, action, target, meta) {
  try {
    await db.query('INSERT INTO audit_logs(user_id,action,target,ip,meta) VALUES($1,$2,$3,$4,$5)',
      [req && req.user ? req.user.id : null, action, target || null, req ? req.ip : null, meta ? JSON.stringify(meta) : null]);
  } catch (e) { console.error('audit failed', e.message); }
}
module.exports = { log };
