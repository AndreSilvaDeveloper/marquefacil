import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.statusCode = status; }
}
export const fail = (status, message) => { throw new HttpError(status, message); };

export const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
export const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
export const uid = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const mins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
export const pad = n => String(n).padStart(2, '0');
export const hhmm = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

// Telefone só com números, com 55 na frente (formato do WhatsApp)
export function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d.length >= 12 && d.length <= 13 ? d : '';
}
