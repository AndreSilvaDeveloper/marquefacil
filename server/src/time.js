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

// Feriados nacionais do Brasil (com o Carnaval, que quase ninguém trabalha). Páscoa pelo algoritmo de Meeus.
export function nationalHolidays(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = (h + l - 7 * m + 114) % 31 + 1;
  const easter = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return [
    ...['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'].map(x => `${year}-${x}`),
    ...[-48, -47, -2, 60].map(n => addDays(easter, n)), // Carnaval (seg e ter), Sexta-feira Santa, Corpus Christi
  ];
}

// 1º dia útil do mês 'YYYY-MM': sem fim de semana, feriado nacional nem as folgas do salão
export function firstBusinessDay(ym, closed = []) {
  const holidays = nationalHolidays(+ym.slice(0, 4));
  for (let d = 1; d <= 10; d++) {
    const date = `${ym}-${String(d).padStart(2, '0')}`;
    if (weekday(date) !== 0 && weekday(date) !== 6 && !holidays.includes(date) && !closed.includes(date)) return date;
  }
  return `${ym}-01`;
}
