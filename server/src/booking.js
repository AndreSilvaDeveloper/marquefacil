import { readSettings } from './settings.js';
import { fail, isObj, uid, TIME_RE, DATE_RE, mins, hhmm, waNumber, norm } from './util.js';
import { nowIn, addDays, weekday, dayLabel } from './time.js';
import { applyChanges } from './db.js';
import { newPortalToken } from './portal.js';

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

/* Compromissos pessoais da profissional (agenda pessoal ligada) que ocupam o horário no link.
   Viram "horários ocupados" para computeSlots; o título nunca sai daqui (a cliente só vê que não está livre). */
export function personalBusy(db, tenantId, s, from, to) {
  if (!s.personal?.enabled) return [];
  return db.prepare(`SELECT data FROM records WHERE tenant_id = ? AND coll = 'personal' AND deleted = 0
                     AND json_extract(data, '$.date') BETWEEN ? AND ?`).all(tenantId, from, to)
    .map(r => JSON.parse(r.data))
    .filter(p => p.block !== false && p.date)
    .map(p => (p.allDay || !TIME_RE.test(p.time || '')
      ? { date: p.date, time: '00:00', duration: 24 * 60, status: 'marcado' }
      : { date: p.date, time: p.time, duration: p.duration || DEFAULT_SLOT, status: 'marcado' }));
}

export function registerBooking(app, { db, messenger, push, limitBook }) {
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
    // a cliente vê nome, descrição e o "a partir de"; o tempo fica aqui dentro para reservar a agenda
    .map(s => ({ id: s.id, name: s.name, description: s.description || '', duration: s.duration || null, priceFrom: s.priceFrom > 0 ? s.priceFrom : null }));
  // Um ou vários serviços (ids separados por vírgula, ou lista): o tempo é a soma dos tempos deles
  function durationFor(tenantId, s, ids, dur) {
    const list = [...new Set((Array.isArray(ids) ? ids : String(ids || '').split(',')).map(String).map(x => x.trim()).filter(Boolean))].slice(0, 10);
    const d = parseInt(dur, 10);
    if (!list.length && d >= 5 && d <= 600) return { services: [], duration: d }; // remarcar: tempo do horário
    if (!list.length) return { services: [], duration: s.booking.defaultDuration };
    const online = onlineServices(tenantId);
    const services = list.map(id => online.find(x => x.id === id) || fail(400, 'Serviço não encontrado.'));
    return { services, duration: services.reduce((t, x) => t + (x.duration || 0), 0) || s.booking.defaultDuration };
  }
  // remarcando: o próprio horário (e o pedido de troca dele) não conta como ocupado
  const notMine = except => a => !except || (a.id !== except && a.replaces !== except);
  const needOpen = s => { if (!s.booking.enabled) fail(403, 'Os agendamentos pelo link estão fechados no momento.'); };

  app.get('/api/public/:slug', async req => {
    const { t, s, now } = load(req.params.slug);
    return {
      name: t.name, slug: t.slug, enabled: s.booking.enabled, message: s.booking.message, approval: s.booking.requireApproval,
      services: s.booking.enabled ? onlineServices(t.id).map(({ id, name, description, priceFrom }) => ({ id, name, description, priceFrom: priceFrom > 0 ? priceFrom : null })) : [],
      today: now.date,
    };
  });

  // Quais dias têm pelo menos um horário livre
  app.get('/api/public/:slug/days', async req => {
    const { t, s, now } = load(req.params.slug);
    needOpen(s);
    const { duration } = durationFor(t.id, s, req.query.services ?? req.query.service, req.query.dur);
    const end = addDays(now.date, s.booking.maxDays);
    const appts = [...q.apptsBetween.all(t.id, now.date, end).map(r => JSON.parse(r.data)).filter(notMine(req.query.except)),
      ...personalBusy(db, t.id, s, now.date, end)];
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
    const { duration } = durationFor(t.id, s, req.query.services ?? req.query.service, req.query.dur);
    const appts = [...q.apptsBetween.all(t.id, date, date).map(r => JSON.parse(r.data)).filter(notMine(req.query.except)),
      ...personalBusy(db, t.id, s, date, date)];
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
    const { services, duration } = durationFor(t.id, s, b.serviceIds ?? b.serviceId ?? null);
    // Serviço que não está na lista, escrito pela cliente (a profissional decide ao confirmar)
    const serviceText = String(b.serviceText || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const names = [...services.map(x => x.name), serviceText].filter(Boolean);

    // Confere de novo e grava junto, para duas pessoas não pegarem o mesmo horário
    const result = db.transaction(() => {
      const appts = [...q.apptsBetween.all(t.id, date, date).map(r => JSON.parse(r.data)), ...personalBusy(db, t.id, s, date, date)];
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
        service: names.join(' + '), price: null, paid: false, // valor é por atendimento: a profissional coloca ao confirmar
        ...(names.length > 1 ? { items: names.map(name => ({ name, price: null })) } : {}),
        ...(serviceText ? { serviceCustom: true } : {}),
        status: s.booking.requireApproval ? 'pendente' : 'marcado',
        notes: String(b.notes || '').trim().slice(0, 300), source: 'online', createdAt: Date.now(),
      };
      changes.push({ coll: 'appts', id: appt.id, data: appt });
      applyChanges(db, t.id, changes);
      return { appt, client };
    })();
    const { appt, client } = result;
    const pending = appt.status === 'pendente';

    // Avisa a profissional em todos os aparelhos com avisos ligados
    push.notifyTenant(t.id, {
      title: pending ? '⏳ Novo pedido de agendamento' : '📅 Novo agendamento pelo link',
      body: `${client.name} — ${dayLabel(date)} às ${time}${appt.service ? ' · ' + appt.service : ''}`,
      url: `/#/agendamento/${appt.id}`, apptId: appt.id, pending,
    }).catch(() => {});
    if (s.whatsapp.notifyOwner) messenger.fire(t.id, appt.id, 'owner');
    if (!pending && s.whatsapp.confirmOnline) messenger.fire(t.id, appt.id, 'confirm');
    // link pessoal guardado neste aparelho, para ela ver/remarcar depois
    return { ok: true, pending, salon: t.name, date, label: dayLabel(date), time, service: appt.service, meus: newPortalToken(db, t.id, client.id) };
  });
}
