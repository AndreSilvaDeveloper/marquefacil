import crypto from 'node:crypto';
import { readSettings } from './settings.js';
import { fail, isObj, uid, TIME_RE, DATE_RE, waNumber } from './util.js';
import { nowIn, zonedEpoch, dayLabel } from './time.js';
import { applyChanges } from './db.js';
import { computeSlots } from './booking.js';

/* "Meus horários": a cliente vê, remarca e cancela os horários dela, sem senha.
   Ela entra por um link pessoal (token) que vai nas mensagens do WhatsApp, que o
   aparelho guarda quando ela pede um horário, ou que ela recebe no WhatsApp pedindo pelo telefone. */

const TOKEN_DAYS = 90;
const hash = t => crypto.createHash('sha256').update(t).digest('base64url');

// Cria um link pessoal para a cliente (vale 90 dias)
export function newPortalToken(db, tenantId, clientId) {
  const token = crypto.randomBytes(18).toString('base64url');
  db.prepare('INSERT INTO portal_tokens (token_hash, tenant_id, client_id, created_at) VALUES (?, ?, ?, ?)')
    .run(hash(token), tenantId, clientId, Date.now());
  return token;
}
export const portalUrl = (publicUrl, slug, token) => (publicUrl ? `${publicUrl.replace(/\/+$/, '')}/${slug}#meus=${token}` : '');

export function registerPortal(app, { db, messenger, push, publicUrl, limitBook, limitAccess }) {
  const q = {
    tenant: db.prepare('SELECT id, name, slug, settings FROM tenants WHERE slug = ?'),
    token: db.prepare('SELECT client_id FROM portal_tokens WHERE token_hash = ? AND tenant_id = ? AND created_at > ?'),
    record: db.prepare('SELECT data FROM records WHERE tenant_id = ? AND coll = ? AND id = ? AND deleted = 0'),
    clientAppts: db.prepare(`SELECT data FROM records WHERE tenant_id = ? AND coll = 'appts' AND deleted = 0
                             AND json_extract(data, '$.clientId') = ?`),
    clients: db.prepare("SELECT data FROM records WHERE tenant_id = ? AND coll = 'clients' AND deleted = 0"),
    dayAppts: db.prepare(`SELECT data FROM records WHERE tenant_id = ? AND coll = 'appts' AND deleted = 0
                          AND json_extract(data, '$.date') = ?`),
    cleanup: db.prepare('DELETE FROM portal_tokens WHERE created_at < ?'),
    clientPackages: db.prepare(`SELECT data FROM records WHERE tenant_id = ? AND coll = 'packages' AND deleted = 0
                                AND json_extract(data, '$.clientId') = ?`),
  };
  const get = (t, coll, id) => { const r = q.record.get(t, coll, id); return r ? JSON.parse(r.data) : null; };

  function load(slug, token) {
    const t = q.tenant.get(String(slug || '').toLowerCase());
    if (!t) fail(404, 'Esse link não existe.');
    const row = token && q.token.get(hash(String(token)), t.id, Date.now() - TOKEN_DAYS * 86400e3);
    if (!row) fail(401, 'Esse link expirou ou não vale mais. Peça um novo.');
    const client = get(t.id, 'clients', row.client_id);
    if (!client) fail(401, 'Esse link não vale mais. Peça um novo.');
    const s = readSettings(t.settings);
    return { t, s, client, now: nowIn(s.timezone) };
  }
  // Pode mexer? Só horário que ainda não passou e respeitando a antecedência do salão
  const canChange = (s, a) => (a.status === 'marcado' || a.status === 'pendente' || a.status === 'prereserva') &&
    zonedEpoch(a.date, a.time, s.timezone) - Date.now() > s.booking.minAdvanceHours * 3600e3;

  // Pedir o link pelo telefone: chega no WhatsApp (a resposta é sempre a mesma, para não revelar quem é cliente)
  app.post('/api/public/:slug/access', async req => {
    if (!limitAccess(req.ip)) fail(429, 'Muitas tentativas. Espere um pouco.');
    const t = q.tenant.get(String(req.params.slug || '').toLowerCase());
    if (!t) fail(404, 'Esse link não existe.');
    const wa = waNumber(isObj(req.body) ? req.body.phone : '');
    if (!wa) fail(400, 'Escreva o seu WhatsApp com DDD. Exemplo: (11) 99999-9999');
    const client = q.clients.all(t.id).map(r => JSON.parse(r.data)).find(c => waNumber(c.phone) === wa);
    if (client) {
      const link = portalUrl(readSettings(t.settings).site || publicUrl, t.slug, newPortalToken(db, t.id, client.id));
      const first = (client.name || '').split(' ')[0];
      messenger.sendText(t.id, client.phone, `Olá, ${first}! 📋 Aqui está o seu link para ver ou remarcar seus horários no *${t.name}*:\n${link}`, 'access')
        .catch(() => {});
    }
    return { ok: true };
  });

  app.get('/api/public/:slug/me', async req => {
    const { t, s, client, now } = load(req.params.slug, req.query.t);
    q.cleanup.run(Date.now() - TOKEN_DAYS * 86400e3);
    const all = q.clientAppts.all(t.id, client.id).map(r => JSON.parse(r.data));
    const byWhen = (a, b) => (a.date + a.time).localeCompare(b.date + b.time);
    const upcoming = all.filter(a => (a.date > now.date || (a.date === now.date && a.time >= `${String(Math.floor(now.minutes / 60)).padStart(2, '0')}:${String(now.minutes % 60).padStart(2, '0')}`))
      && (a.status === 'marcado' || a.status === 'pendente' || a.status === 'prereserva')
      && !(a.replaces && a.status === 'pendente' && all.some(o => o.id === a.replaces && o.status !== 'cancelado'))) // pedido de troca aparece no horário original
      .sort(byWhen);
    const pastDone = all.filter(a => !upcoming.includes(a) && !['cancelado', 'pendente', 'prereserva'].includes(a.status)).sort(byWhen).reverse().slice(0, 5);
    const view = a => ({
      id: a.id, date: a.date, time: a.time, label: dayLabel(a.date), service: a.service || '', status: a.status,
      duration: a.duration || null, canChange: canChange(s, a), replaces: a.replaces || null,
      // pedido de remarcação esperando o salão
      moving: all.find(x => x.replaces === a.id && x.status === 'pendente')?.id || null,
      pacote: messenger.packageLabel(t.id, a),
    });
    const packages = q.clientPackages.all(t.id, client.id).map(r => JSON.parse(r.data)).map(p => {
      const used = all.filter(a => a.packageId === p.id && a.status !== 'cancelado');
      const done = used.filter(a => a.status === 'feito' || zonedEpoch(a.date, a.time, s.timezone) < Date.now()).length;
      const before = p.doneBefore || 0;
      return { name: p.name, total: p.total, scheduled: before + used.length, done: before + done };
    }).filter(p => p.done < p.total);
    return {
      salon: t.name, name: client.name, approval: s.booking.requireApproval, enabled: s.booking.enabled,
      upcoming: upcoming.map(view), past: pastDone.map(view), packages,
    };
  });

  app.post('/api/public/:slug/me/cancel', async req => {
    if (!limitBook(req.ip)) fail(429, 'Muitas tentativas. Tente de novo mais tarde.');
    const b = isObj(req.body) ? req.body : {};
    const { t, s, client } = load(req.params.slug, b.t);
    const a = get(t.id, 'appts', String(b.id || ''));
    if (!a || a.clientId !== client.id) fail(404, 'Horário não encontrado.');
    if (!canChange(s, a)) fail(400, `Não dá mais para cancelar pelo link (faltam menos de ${s.booking.minAdvanceHours}h). Fale com o salão.`);
    const changes = [{ coll: 'appts', id: a.id, data: { ...a, status: 'cancelado', cancelledBy: 'cliente' } }];
    // se tinha um pedido de remarcação dele, cancela junto
    for (const r of q.clientAppts.all(t.id, client.id).map(x => JSON.parse(x.data))) {
      if (r.replaces === a.id && r.status === 'pendente') changes.push({ coll: 'appts', id: r.id, data: { ...r, status: 'cancelado', cancelledBy: 'cliente' } });
    }
    applyChanges(db, t.id, changes);
    push.notifyTenant(t.id, {
      title: '❌ Horário cancelado pela cliente',
      body: `${client.name} — ${dayLabel(a.date)} às ${a.time}${a.service ? ' · ' + a.service : ''}`,
      url: `/#/agendamento/${a.id}`,
    }).catch(() => {});
    return { ok: true };
  });

  app.post('/api/public/:slug/me/reschedule', async req => {
    if (!limitBook(req.ip)) fail(429, 'Muitas tentativas. Tente de novo mais tarde.');
    const b = isObj(req.body) ? req.body : {};
    const { t, s, client, now } = load(req.params.slug, b.t);
    if (!s.booking.enabled) fail(403, 'Remarcar pelo link está fechado no momento. Fale com o salão.');
    const old = get(t.id, 'appts', String(b.id || ''));
    if (!old || old.clientId !== client.id) fail(404, 'Horário não encontrado.');
    if (!canChange(s, old)) fail(400, `Não dá mais para remarcar pelo link (faltam menos de ${s.booking.minAdvanceHours}h). Fale com o salão.`);
    const date = String(b.date || ''), time = String(b.time || '');
    if (!DATE_RE.test(date) || !TIME_RE.test(time)) fail(400, 'Escolha o novo dia e horário.');
    const duration = old.duration || s.booking.defaultDuration;
    const pending = s.booking.requireApproval;

    const fresh = db.transaction(() => {
      // o horário antigo (e um pedido anterior de remarcação) não contam como ocupados
      const appts = q.dayAppts.all(t.id, date).map(r => JSON.parse(r.data)).filter(x => x.id !== old.id && x.replaces !== old.id);
      if (!computeSlots({ booking: s.booking, appts, date, duration, now }).includes(time)) {
        fail(409, 'Esse horário não está mais livre. Escolha outro, por favor.');
      }
      const changes = [];
      // um pedido de remarcação por vez: o anterior é trocado por este
      for (const r of q.clientAppts.all(t.id, client.id).map(x => JSON.parse(x.data))) {
        if (r.replaces === old.id && r.status === 'pendente') changes.push({ coll: 'appts', id: r.id, data: { ...r, status: 'cancelado', cancelledBy: 'cliente' } });
      }
      const appt = {
        ...old, id: uid(), date, time, duration, status: pending ? 'pendente' : 'marcado', paid: false, payments: [],
        replaces: old.id, source: 'online', createdAt: Date.now(),
      };
      delete appt.seriesId; delete appt.seriesIndex; delete appt.seriesEvery; delete appt.remindedAt;
      changes.push({ coll: 'appts', id: appt.id, data: appt });
      if (!pending) changes.push({ coll: 'appts', id: old.id, data: { ...old, status: 'cancelado', cancelledBy: 'remarcado', replacedBy: appt.id } });
      applyChanges(db, t.id, changes);
      return appt;
    })();

    push.notifyTenant(t.id, {
      title: pending ? '🔁 Pedido para remarcar' : '🔁 Horário remarcado pela cliente',
      body: `${client.name} — de ${dayLabel(old.date)} ${old.time} para ${dayLabel(date)} ${time}`,
      url: `/#/agendamento/${fresh.id}`, apptId: fresh.id, pending,
    }).catch(() => {});
    if (!pending && s.whatsapp.confirmOnline) messenger.fire(t.id, fresh.id, 'confirm');
    return { ok: true, pending, date, label: dayLabel(date), time };
  });
}
