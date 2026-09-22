import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export async function hashPassword(pass) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pass, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function checkPassword(pass, stored) {
  const [alg, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const want = Buffer.from(key, 'base64');
  const got = await scrypt(pass, Buffer.from(salt, 'base64'), want.length);
  return crypto.timingSafeEqual(want, got);
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = t => crypto.createHash('sha256').update(t).digest('base64url');
export const newId = () => crypto.randomBytes(9).toString('base64url');

// Limite simples de tentativas por IP (login/cadastro), em memória.
export function rateLimiter({ max, windowMs }) {
  const hits = new Map();
  return key => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    h.n++;
    if (hits.size > 10000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    return h.n <= max;
  };
}
