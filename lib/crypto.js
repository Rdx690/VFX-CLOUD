const crypto = require('crypto');
function key() {
  const k = process.env.ENCRYPTION_KEY || '';
  if (!/^[0-9a-f]{64}$/i.test(k)) throw new Error('ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32)');
  return Buffer.from(k, 'hex');
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join(':');
}
function decrypt(blob) {
  const [iv, tag, ct] = blob.split(':').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
function randomPassword(len = 20) {
  let out = '';
  while (out.length < len) { const b = crypto.randomBytes(1)[0]; if (b < 256 - (256 % ALPHABET.length)) out += ALPHABET[b % ALPHABET.length]; }
  return out;
}
module.exports = { encrypt, decrypt, randomPassword };
