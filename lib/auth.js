const db = require('../database');
const { HttpError } = require('./http');
async function loadUser(req, res, next) {
  try {
    if (req.session && req.session.uid) {
      const r = await db.query('SELECT id,email,username,role,status,max_servers FROM users WHERE id=$1', [req.session.uid]);
      const u = r.rows[0];
      if (u && u.status === 'active') req.user = u;
      else req.session.destroy(() => {});
    }
    next();
  } catch (e) { next(e); }
}
const requireAuth = (req, res, next) => (req.user ? next() : next(new HttpError(401, 'Please sign in')));
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : next(new HttpError(403, 'Administrator access required')));
module.exports = { loadUser, requireAuth, requireAdmin };
