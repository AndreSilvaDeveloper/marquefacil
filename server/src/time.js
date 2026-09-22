// Datas e horas no fuso do salão (o servidor roda em UTC).
const fmtCache = new Map();
function parts(ts, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(ts).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}

export function validTz(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

// "Agora" no fuso: { date: 'YYYY-MM-DD', minutes: minutos desde 00:00 }
export function nowIn(tz, now = Date.now()) {
  const p = parts(now, tz);
  const pad = n => String(n).padStart(2, '0');
  return { date: `${p.y}-${pad(p.m)}-${pad(p.d)}`, minutes: p.h * 60 + p.mi };
}

// Momento exato (ms) de uma data/hora "de parede" no fuso
export function zonedEpoch(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, h, mi);
  const offset = ts => { const p = parts(ts, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(ts / 60000) * 60000; };
  let t = wall - offset(wall);
  const o2 = offset(t);
  if (wall - o2 !== t) t = wall - o2;
  return t;
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return x.toISOString().slice(0, 10);
}
export const weekday = date => new Date(date + 'T12:00:00Z').getUTCDay();

// "sexta-feira, 25/09"
export function dayLabel(date) {
  const x = new Date(date + 'T12:00:00Z');
  return x.toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'long', day: '2-digit', month: '2-digit' });
}
