import { readSettings } from './settings.js';
import { fail, isObj, uid, TIME_RE, DATE_RE, mins, hhmm, waNumber, norm } from './util.js';
import { nowIn, addDays, weekday, dayLabel } from './time.js';
import { applyChanges } from './db.js';

const DEFAULT_SLOT = 30; // horários sem duração ocupam 30 min (igual ao app)

// Horários livres de um dia. Função pura: recebe tudo o que precisa.
export function computeSlots({ booking, appts, date, duration, now }) {
  if (date < now.date || date > addDays(now.date, booking.maxDays)) return [];
  if (booking.closedDates.includes(date)) return [];
  const open = booking.days[weekday(date)];
  if (!open) return [];

  const busy = appts
    .filter(a => a.date === date && a.status !== 'cancelado' && TIME_RE.test(a.time || ''))
    .map(a => [mins(a.time), mins(a.time) + (a.duration || DEFAULT_SLOT)]);
  if (booking.lunch) busy.push([mins(booking.lunch[0]), mins(booking.lunch[1])]);

  const earliest = date === now.date ? now.minutes + booking.minAdvanceHours * 60 : -1;
  const out = [];
  for (let t = mins(open[0]); t + duration <= mins(open[1]); t += booking.interval) {
    if (t < earliest) continue;
    if (busy.some(([s, e]) => t < e && s < t + duration)) continue;
    out.push(hhmm(t));
  }
  return out;
}

export function registerBooking(app, { db, messenger, limitBook }) {
  const q = {
    tenant: db.prepare('SELECT id, name, slug, settings FROM tenants WHERE slug = ?'),
    coll: db.prepare('SELECT data FROM records WHERE tenant_id = ? AND coll = ? AND deleted = 0'),
    apptsBetween: db.prepare(`SELECT data FROM records WHERE tenant_id = ? AND coll = 'appts' AND deleted = 0
                              AND json_extract(data, '$.date') BETWEEN ? AND ?`),
  };
  const all = (tenantId, coll) => q.coll.all(tenantId, coll).map(r => JSON.parse(r.data));

  function load(slug) {
    const t = q.tenant.get(String(slug || '').toLowerCase());
    if (!t) fail(404, 'Esse link de agendamento não existe.');
    const s = readSettings(t.settings);
    return { t, s, now: nowIn(s.timezone) };
  }
  const onlineServices = tenantId => all(tenantId, 'services')
    .filter(s => s.online !== false && s.name)
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
    .map(s => ({ id: s.id, name: s.name, duration: s.duration || null, price: s.price || null }));
  function durationFor(tenantId, s, serviceId) {
    if (!serviceId) return { service: null, duration: s.booking.defaultDuration };
    const service = onlineServices(tenantId).find(x => x.id === serviceId);
    if (!service) fail(400, 'Serviço não encontrado.');
    return { service, duration: service.duration || s.booking.defaultDuration };
  }
  const needOpen = s => { if (!s.booking.enabled) fail(403, 'Os agendamentos pelo link estão fechados no momento.'); };

  app.get('/api/public/:slug', async req => {
    const { t, s, now } = load(req.params.slug);
    return {
      name: t.name, slug: t.slug, enabled: s.booking.enabled, message: s.booking.message,
      services: s.booking.enabled ? onlineServices(t.id) : [], today: now.date,
    };
  });

  // Quais dias têm pelo menos um horário livre
  app.get('/api/public/:slug/days', async req => {
    const { t, s, now } = load(req.params.slug);
    needOpen(s);
    const { duration } = durationFor(t.id, s, req.query.service);
    const end = addDays(now.date, s.booking.maxDays);
    const appts = q.apptsBetween.all(t.id, now.date, end).map(r => JSON.parse(r.data));
    const days = [];
    for (let d = now.date; d <= end; d = addDays(d, 1)) {
      days.push({ date: d, label: dayLabel(d), free: computeSlots({ booking: s.booking, appts, date: d, duration, now }).length });
    }
    return { days };
  });

  app.get('/api/public/:slug/slots', async req => {
    const { t, s, now } = load(req.params.slug);
    needOpen(s);
    const date = String(req.query.date || '');
    if (!DATE_RE.test(date)) fail(400, 'Data inválida.');
    const { duration } = durationFor(t.id, s, req.query.service);
    const appts = q.apptsBetween.all(t.id, date, date).map(r => JSON.parse(r.data));
    return { date, slots: computeSlots({ booking: s.booking, appts, date, duration, now }) };
  });

  app.post('/api/public/:slug/book', async req => {
    if (!limitBook(req.ip)) fail(429, 'Muitos agendamentos seguidos. Tente de novo mais tarde.');
    const b = isObj(req.body) ? req.body : {};
    if (b.website) fail(400, 'Não foi possível agendar.'); // campo escondido: só robô preenche
    const { t, s, now } = load(req.params.slug);
    needOpen(s);

    const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const phone = String(b.phone || '').trim().slice(0, 30);
    const date = String(b.date || ''), time = String(b.time || '');
    if (name.length < 2) fail(400, 'Escreva o seu nome.');
    if (!waNumber(phone)) fail(400, 'Escreva o seu WhatsApp com DDD. Exemplo: (11) 99999-9999');
    if (!DATE_RE.test(date) || !TIME_RE.test(time)) fail(400, 'Escolha o dia e o horário.');
    const { service, duration } = durationFor(t.id, s, b.serviceId || null);

    // Confere de novo e grava junto, para duas pessoas não pegarem o mesmo horário
    const result = db.transaction(() => {
      const appts = q.apptsBetween.all(t.id, date, date).map(r => JSON.parse(r.data));
      if (!computeSlots({ booking: s.booking, appts, date, duration, now }).includes(time)) {
        fail(409, 'Esse horário acabou de ser ocupado. Escolha outro, por favor.');
      }
      const changes = [];
      const wa = waNumber(phone);
      let client = all(t.id, 'clients').find(c => waNumber(c.phone) === wa)
        || all(t.id, 'clients').find(c => !c.phone && norm(c.name) === norm(name));
      if (!client) {
        client = { id: uid(), name, phone, notes: '', createdAt: Date.now(), source: 'online' };
        changes.push({ coll: 'clients', id: client.id, data: client });
      } else if (!client.phone) {
        client = { ...client, phone };
        changes.push({ coll: 'clients', id: client.id, data: client });
      }
      const appt = {
        id: uid(), clientId: client.id, date, time, duration,
        service: service?.name || '', price: service?.price ?? null, paid: false, status: 'marcado',
        notes: String(b.notes || '').trim().slice(0, 300), source: 'online', createdAt: Date.now(),
      };
      changes.push({ coll: 'appts', id: appt.id, data: appt });
      applyChanges(db, t.id, changes);
      return appt;
    })();

    if (s.whatsapp.confirmOnline) messenger.fire(t.id, result.id, 'confirm');
    if (s.whatsapp.notifyOwner) messenger.fire(t.id, result.id, 'owner');
    return { ok: true, salon: t.name, date, label: dayLabel(date), time, service: result.service };
  });
}
