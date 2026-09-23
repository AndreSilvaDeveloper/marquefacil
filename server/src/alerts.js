import { readSettings } from './settings.js';
import { nowIn, zonedEpoch, addDays, dayLabel } from './time.js';

/* Avisos (push) para a profissional, conferidos a cada minuto:
   - horário chegando (X min antes)
   - pedido do link esperando confirmação (depois de 30 min, e de novo perto do horário)
   - pré-reserva sem sinal para as próximas 24h
   - bom dia com o resumo do dia (e aniversariantes)
   - fim do dia: atendimentos sem valor
   - WhatsApp automático desconectado
   Cada aviso sai uma vez só (tabela push_log). */
const MIN = 60e3;

export function createAlerts({ db, push, evo, log = console }) {
  db.exec(`CREATE TABLE IF NOT EXISTS push_log (
    tenant_id TEXT NOT NULL, key TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (tenant_id, key))`);
  const q = {
    tenants: db.prepare('SELECT id, name, settings FROM tenants WHERE id IN (SELECT DISTINCT tenant_id FROM push_subs)'),
    appts: db.prepare(`SELECT id, data FROM records WHERE tenant_id = ? AND coll = 'appts' AND deleted = 0
                       AND json_extract(data, '$.date') BETWEEN ? AND ?`),
    client: db.prepare("SELECT data FROM records WHERE tenant_id = ? AND coll = 'clients' AND id = ? AND deleted = 0"),
    birthdays: db.prepare(`SELECT id, data FROM records WHERE tenant_id = ? AND coll = 'clients' AND deleted = 0
                           AND json_extract(data, '$.birthday') = ?`),
    claim: db.prepare('INSERT OR IGNORE INTO push_log (tenant_id, key, created_at) VALUES (?, ?, ?)'),
    cleanup: db.prepare('DELETE FROM push_log WHERE created_at < ?'),
  };
  const nameOf = (t, id) => { const r = id && q.client.get(t, id); return r ? JSON.parse(r.data).name || '' : ''; };
  const first = n => String(n || '').split(' ')[0];
  const short = date => dayLabel(date).replace(/-feira/, '');
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

  // Manda uma vez por key; devolve true se mandou
  async function once(tenantId, key, payload, now) {
    if (!q.claim.run(tenantId, key, now).changes) return false;
    await push.notifyTenant(tenantId, payload);
    return true;
  }

  async function run(now = Date.now()) {
    let sent = 0;
    const send = async (t, key, payload) => { if (await once(t, key, payload, now)) sent++; };
    for (const t of q.tenants.all()) {
      const s = readSettings(t.settings);
      const A = s.alerts, tz = s.timezone;
      const here = nowIn(tz, now);
      const list = q.appts.all(t.id, addDays(here.date, -1), addDays(here.date, 2)).map(r => ({ id: r.id, ...JSON.parse(r.data) }))
        .filter(a => a.date && a.time);
      const startOf = a => zonedEpoch(a.date, a.time, tz);
      const who = a => nameOf(t.id, a.clientId) || 'Cliente';

      for (const a of list) {
        const left = startOf(a) - now;
        const st = a.status || 'marcado';
        // horário chegando
        if (A.upcoming && (st === 'marcado' || st === 'prereserva') && left > 0 && left <= A.upcoming * MIN) {
          await send(t.id, `up:${a.id}:${a.date} ${a.time}`, {
            title: `⏰ Em ${Math.max(1, Math.round(left / MIN))} min: ${who(a)}`,
            body: `${a.time}${a.service ? ' · ' + a.service : ''}${st === 'prereserva' ? ' · 💳 ainda sem sinal' : ''}`,
            url: `/#/agendamento/${a.id}`, tag: `up-${a.id}`,
          });
        }
        // pedido do link esperando
        if (A.pending && st === 'pendente' && left > 0) {
          const waiting = now - (a.createdAt || now);
          const payload = {
            title: '⏳ Pedido esperando você confirmar',
            body: `${who(a)} — ${short(a.date)} às ${a.time}${a.service ? ' · ' + a.service : ''}`,
            url: `/#/agendamento/${a.id}`, apptId: a.id, pending: true, tag: `pend-${a.id}`,
          };
          if (waiting >= 30 * MIN && left > 3 * 60 * MIN) await send(t.id, `pend30:${a.id}`, payload);
          if (left <= 3 * 60 * MIN && waiting >= 10 * MIN) await send(t.id, `pend3h:${a.id}`, { ...payload, title: '⏳ Pedido ainda sem resposta (é hoje!)' });
        }
        // pré-reserva sem sinal perto do horário
        if (A.prereserve && st === 'prereserva' && left > 60 * MIN && left <= 24 * 60 * MIN) {
          await send(t.id, `pre24:${a.id}`, {
            title: '💳 Pré-reserva ainda sem sinal',
            body: `${who(a)} — ${short(a.date)} às ${a.time}. Confirme quando ela pagar o sinal.`,
            url: `/#/agendamento/${a.id}`, tag: `pre-${a.id}`,
          });
        }
      }

      // Bom dia: resumo de hoje (7h30–11h) + aniversariantes
      if (A.morning && here.minutes >= 7 * 60 + 30 && here.minutes < 11 * 60) {
        const todays = list.filter(a => a.date === here.date && ['marcado', 'prereserva', 'pendente', undefined].includes(a.status))
          .sort((a, b) => a.time.localeCompare(b.time));
        const ahead = todays.filter(a => startOf(a) > now);
        if (ahead.length) {
          const pend = todays.filter(a => a.status === 'pendente').length;
          await send(t.id, `morning:${here.date}`, {
            title: `☀️ Bom dia! Hoje você tem ${plural(todays.length, 'horário', 'horários')}`,
            body: `Próximo às ${ahead[0].time} com ${first(who(ahead[0]))}${pend ? ` · ${plural(pend, 'pedido esperando', 'pedidos esperando')}` : ''}`,
            url: '/#/agenda', tag: 'morning',
          });
        }
        const bdays = q.birthdays.all(t.id, here.date.slice(5)).map(r => ({ id: r.id, ...JSON.parse(r.data) }));
        for (const c of bdays) {
          await send(t.id, `bday:${c.id}:${here.date.slice(0, 4)}`, {
            title: `🎂 Hoje é aniversário da ${first(c.name)}`,
            body: 'Que tal mandar um parabéns? Toque para abrir a ficha dela.',
            url: `/#/cliente/${c.id}`, tag: `bday-${c.id}`,
          });
        }
      }

      // Fim do dia (20h–22h): atendimentos de hoje que ficaram sem valor
      if (A.evening && here.minutes >= 20 * 60 && here.minutes < 22 * 60) {
        const noValue = list.filter(a => a.date === here.date && (a.status === 'marcado' || a.status === 'feito' || !a.status)
          && startOf(a) < now && !(a.price > 0) && !a.paid && !a.packageId);
        if (noValue.length) {
          await send(t.id, `evening:${here.date}`, {
            title: `📝 ${plural(noValue.length, 'atendimento de hoje está', 'atendimentos de hoje estão')} sem valor`,
            body: 'Coloque quanto foi cobrado para o seu Dinheiro ficar certinho.',
            url: `/#/financeiro?f=semvalor`, tag: 'evening',
          });
        }
      }
    }
    q.cleanup.run(now - 7 * 86400e3);
    return sent;
  }

  // WhatsApp automático caiu: avisa uma vez por dia
  async function checkWhatsapp(now = Date.now()) {
    if (!evo?.enabled) return 0;
    let sent = 0;
    for (const t of q.tenants.all()) {
      const s = readSettings(t.settings);
      if (!s.alerts.whatsappDown || !s.whatsapp.instance) continue;
      let state = 'close';
      try { state = (await evo.state(s.whatsapp.instance))?.instance?.state || 'close'; } catch { continue; } // Evolution fora: não acusa
      if (state === 'open' || state === 'connecting') continue;
      if (await once(t.id, `wadown:${nowIn(s.timezone, now).date}`, {
        title: '⚠️ WhatsApp automático desconectado',
        body: 'As mensagens para as clientes não estão saindo. Toque para conectar de novo.',
        url: '/#/whatsapp', tag: 'wadown',
      }, now)) sent++;
    }
    return sent;
  }

  function start(everyMs = 60_000) {
    let busy = false, ticks = 0;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        await run();
        if (ticks++ % 15 === 5) await checkWhatsapp(); // a cada 15 minutos
      } catch (e) { log.error?.(e); } finally { busy = false; }
    };
    return setInterval(tick, everyMs);
  }

  return { run, checkWhatsapp, start };
}
