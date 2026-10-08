import { readSettings, DEFAULTS } from './settings.js';
import { fail, isObj, waNumber } from './util.js';
import { nowIn, zonedEpoch, addDays, dayLabel, weekday } from './time.js';
import { newPortalToken, portalUrl } from './portal.js';
import { groupOrders, installments, productsText, leftOf, paidOf } from './sales.js';

/* ------------------------- cliente da Evolution API (v2) ------------------------- */
// O WhatsApp do salão não pode parecer "aberto" nem marcar mensagens como lidas: se a conta
// aparece online num aparelho conectado, o celular da profissional para de tocar as notificações.
export const QUIET = {
  rejectCall: false, msgCall: '', groupsIgnore: true, alwaysOnline: false,
  readMessages: false, readStatus: false, syncFullHistory: false,
};
export function evolutionClient({ url, apikey, fetchImpl = fetch, timeoutMs = 15000 }) {
  const base = String(url || '').replace(/\/+$/, '');
  async function call(method, path, body) {
    const r = await fetchImpl(base + path, {
      method,
      headers: { apikey, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = [].concat(j?.response?.message ?? j?.message ?? []).flat().join(', ');
      const e = new Error(msg || `A Evolution respondeu ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return j;
  }
  const enc = encodeURIComponent;
  return {
    enabled: !!(base && apikey),
    create: name => call('POST', '/instance/create', { instanceName: name, integration: 'WHATSAPP-BAILEYS', qrcode: true, ...QUIET }),
    // configurações da instância e presença ("offline" = o celular continua recebendo as notificações)
    setSettings: name => call('POST', `/settings/set/${enc(name)}`, QUIET),
    setPresence: (name, presence) => call('POST', `/instance/setPresence/${enc(name)}`, { presence }),
    // com `number`, a Evolution devolve também um código para "Conectar com número de telefone"
    connect: (name, number) => call('GET', `/instance/connect/${enc(name)}${number ? '?number=' + enc(number) : ''}`),
    state: name => call('GET', `/instance/connectionState/${enc(name)}`),
    info: name => call('GET', `/instance/fetchInstances?instanceName=${enc(name)}`),
    // delay (ms): o WhatsApp mostra "digitando…" antes de a mensagem chegar
    send: (name, number, text, delay = 0) => call('POST', `/message/sendText/${enc(name)}`, { number, text, ...(delay > 0 ? { delay } : {}) }),
    logout: name => call('DELETE', `/instance/logout/${enc(name)}`),
    remove: name => call('DELETE', `/instance/delete/${enc(name)}`),
  };
}

// Troca {nome}, {dia}… pelos valores. Linha com um campo vazio (ex.: sem serviço) some.
export function renderTemplate(tpl, vars) {
  return String(tpl).split('\n').filter(line => {
    const keys = [...line.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
    return keys.every(k => !(k in vars) || String(vars[k] ?? '').trim() !== '');
  }).join('\n').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m)).trim();
}

const brl = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/* ------------------------- envio das mensagens ------------------------- */
/* Para o WhatsApp não bloquear o número: as mensagens de cada número saem uma por vez, com um intervalo
   aleatório entre elas (sendGap) e "digitando…" antes de cada uma (typing). A primeira depois de um tempo
   parado sai na hora; numa leva grande (lembretes, resumo do mês) elas vão saindo espaçadas. */
export function createMessenger({ db, evo, publicUrl = '', log = console, sendGap = [0, 0], typing = [0, 0] }) {
  const rand = ([a, b]) => a + Math.random() * Math.max(0, b - a);
  const queues = new Map(), lastAt = new Map();
  function queuedSend(inst, number, text) {
    const run = (queues.get(inst) || Promise.resolve()).catch(() => {}).then(async () => {
      const wait = (lastAt.get(inst) || 0) + rand(sendGap) - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      try { return await evo.send(inst, number, text, Math.round(rand(typing))); }
      finally { lastAt.set(inst, Date.now()); }
    });
    queues.set(inst, run);
    return run;
  }
  const q = {
    tenant: db.prepare('SELECT id, name, slug, settings FROM tenants WHERE id = ?'),
    record: db.prepare('SELECT data FROM records WHERE tenant_id = ? AND coll = ? AND id = ? AND deleted = 0'),
    claim: db.prepare(`INSERT OR IGNORE INTO messages (tenant_id, appt_id, kind, phone, name, body, status, attempts, created_at)
                       VALUES (@tenantId, @apptId, @kind, @phone, @name, @body, 'sending', 1, @now)`),
    reclaim: db.prepare(`UPDATE messages SET status = 'sending', attempts = attempts + 1, created_at = @now, body = @body, phone = @phone
                         WHERE tenant_id = @tenantId AND appt_id = @apptId AND kind = @kind AND status = 'error' AND attempts < 3`),
    doneBy: db.prepare('UPDATE messages SET status = ?, error = ? WHERE tenant_id = ? AND appt_id = ? AND kind = ?'),
    log: db.prepare(`INSERT INTO messages (tenant_id, appt_id, kind, phone, name, body, status, error, attempts, created_at)
                     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 1, ?)`),
  };
  const getRecord = (t, coll, id) => { const r = q.record.get(t, coll, id); return r ? JSON.parse(r.data) : null; };

  // "Cronograma capilar — 2ª de 4": posição do horário no pacote, pela ordem das datas
  const pkgAppts = db.prepare(`SELECT data FROM records WHERE tenant_id = ? AND coll = 'appts' AND deleted = 0
                               AND json_extract(data, '$.packageId') = ?`);
  function packageLabel(tenantId, appt) {
    if (!appt.packageId) return '';
    const pkg = getRecord(tenantId, 'packages', appt.packageId);
    if (!pkg) return '';
    const list = pkgAppts.all(tenantId, appt.packageId).map(r => JSON.parse(r.data))
      .filter(a => a.status !== 'cancelado').sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const i = list.findIndex(a => a.id === appt.id);
    if (i < 0) return pkg.name;
    const n = (pkg.doneBefore || 0) + i + 1; // sessões feitas antes de entrar no app também contam
    return `${pkg.name} — ${n}ª sessão de ${pkg.total}`;
  }

  const payOn = db.prepare("SELECT 1 FROM kv WHERE key = ?");
  function varsFor(tenant, appt, client, kind) {
    const s = readSettings(tenant.settings);
    // links com o domínio do salão (ex.: studiokadosh.com), ou o endereço padrão do sistema
    const base = s.site || publicUrl;
    // link pessoal "ver ou remarcar" (só nas mensagens para a cliente)
    const meus = client && kind !== 'owner' && base ? portalUrl(base, tenant.slug, newPortalToken(db, tenant.id, client.id)) : '';
    // sinal pago pelo banco (Asaas): a cliente paga pela página dela e o horário confirma sozinho
    const pagar = appt.status === 'prereserva' && appt.price > 0 && s.payments.deposit && meus && payOn.get(`asaas:${tenant.id}`) ? meus : '';
    return {
      pagar,
      meus_horarios: meus,
      nome: (client?.name || '').split(' ')[0],
      nome_completo: client?.name || '',
      telefone: client?.phone || '',
      salao: tenant.name,
      dia: dayLabel(appt.date),
      hora: appt.time,
      servico: appt.service || '',
      valor: appt.price > 0 ? brl(appt.price) : appt.priceLater ? 'avaliado na hora do atendimento' : '',
      // chave Pix dos serviços (na pré-reserva com pagamento pelo banco, a chave some: o link já tem o Pix que confirma sozinho)
      pix: pagar && kind === 'prereserve' ? '' : s.whatsapp.pixKeyService || '',
      sinal: appt.price > 0 ? brl(Math.round(appt.price * (readSettings(tenant.settings).whatsapp.depositPercent / 100) * 100) / 100) : '',
      pacote: packageLabel(tenant.id, appt),
      link: base ? `${base.replace(/\/+$/, '')}/${tenant.slug}` : '',
    };
  }

  // kind: 'confirm' | 'reminder' | 'owner' | 'decline'. Cada combinação horário+tipo só é enviada uma vez.
  // key: identifica o envio (uma vez por horário+key). O aviso de mudança usa uma key por novo dia/hora/cliente.
  async function sendForAppt(tenantId, apptId, kind, key = kind) {
    const tenant = q.tenant.get(tenantId);
    if (!tenant || !evo.enabled) return 'off';
    const s = readSettings(tenant.settings);
    if (!s.whatsapp.instance) return 'off';
    const appt = getRecord(tenantId, 'appts', apptId);
    if (!appt || (appt.status === 'cancelado' && kind !== 'decline' && kind !== 'rescheduleNo')) return 'skip';
    const client = appt.clientId ? getRecord(tenantId, 'clients', appt.clientId) : null;

    const phone = kind === 'owner' ? waNumber(s.whatsapp.ownerPhone || s.whatsapp.number) : waNumber(client?.phone);
    const tpl = s.whatsapp.templates[kind] || DEFAULTS.whatsapp.templates[kind];
    const vars = varsFor(tenant, appt, client, kind);
    // horário de pacote: a cliente sempre fica sabendo em qual sessão está, mesmo se o texto foi editado sem {pacote}
    let tplFinal = vars.pacote && ['confirm', 'reminder', 'prereserve'].includes(kind) && !tpl.includes('{pacote}') ? `${tpl}\n📦 {pacote}` : tpl;
    // pré-reserva: a cliente precisa da chave para pagar o sinal, mesmo se o texto foi editado sem {pix}
    if (kind === 'prereserve' && vars.pix && !tplFinal.includes('{pix}')) tplFinal += '\n🔑 Pix para o sinal: {pix}';
    if (kind === 'prereserve' && vars.pagar && !tplFinal.includes('{pagar}')) tplFinal += '\n\n💳 Pague o sinal de {sinal} por aqui (Pix na hora) e o horário confirma sozinho:\n{pagar}';
    const body = renderTemplate(tplFinal, vars);
    const row = { tenantId, apptId, kind: key, phone, name: client?.name || '', body, now: Date.now() };

    if (!q.claim.run(row).changes && !q.reclaim.run(row).changes) return 'already';
    if (!phone) { q.doneBy.run('skipped', 'sem telefone', tenantId, apptId, key); return 'skip'; }
    try {
      await queuedSend(s.whatsapp.instance, phone, body);
      q.doneBy.run('sent', null, tenantId, apptId, key);
      return 'sent';
    } catch (e) {
      q.doneBy.run('error', String(e.message).slice(0, 300), tenantId, apptId, key);
      log.warn?.({ err: e.message, tenantId, apptId, kind }, 'whatsapp: falha ao enviar');
      return 'error';
    }
  }

  // Mensagem avulsa (teste), fica no histórico
  async function sendText(tenantId, phone, body, kind = 'test') {
    const tenant = q.tenant.get(tenantId);
    const s = readSettings(tenant.settings);
    if (!evo.enabled || !s.whatsapp.instance) fail(400, 'Conecte o WhatsApp primeiro.');
    const number = waNumber(phone);
    if (!number) fail(400, 'Telefone inválido. Exemplo: (11) 99999-9999');
    try {
      await queuedSend(s.whatsapp.instance, number, body);
      q.log.run(tenantId, kind, number, '', body, 'sent', null, Date.now());
    } catch (e) {
      q.log.run(tenantId, kind, number, '', body, 'error', String(e.message).slice(0, 300), Date.now());
      fail(502, 'Não foi possível enviar: ' + e.message);
    }
  }

  // Dispara sem esperar (a resposta para a cliente não fica presa no WhatsApp)
  const fire = (...args) => { sendForAppt(...args).catch(e => log.error?.(e)); };

  /* Lembretes: a cada minuto, procura horários que entraram na janela do lembrete */
  const tenantsOn = db.prepare("SELECT id, settings FROM tenants WHERE json_extract(settings, '$.whatsapp.instance') IS NOT NULL");
  const apptsBetween = db.prepare(`SELECT id, data FROM records WHERE tenant_id = ? AND coll = 'appts' AND deleted = 0
                                   AND json_extract(data, '$.date') BETWEEN ? AND ?`);
  const confirmSent = db.prepare("SELECT 1 FROM messages WHERE tenant_id = ? AND appt_id = ? AND kind = 'confirm' AND status = 'sent'");
  async function runReminders(now = Date.now()) {
    let sent = 0;
    for (const t of tenantsOn.all()) {
      const s = readSettings(t.settings);
      const R = s.whatsapp.reminderMinutes * 60e3; // quanto antes mandar (ms)
      if (!R) continue;
      // não manda se já estiver em cima da hora (para lembrete de 30 min: menos de 10 min antes)
      const tooLate = Math.min(20 * 60e3, R / 3);
      const today = nowIn(s.timezone, now).date;
      for (const r of apptsBetween.all(t.id, today, addDays(today, Math.ceil(R / 86400e3) + 1))) {
        const a = JSON.parse(r.data);
        if ((a.status && a.status !== 'marcado') || !a.time) continue; // só horário confirmado ganha lembrete
        const start = zonedEpoch(a.date, a.time, s.timezone);
        const left = start - now;
        if (left > R || left < tooLate) continue;                    // fora da janela
        // marcou já dentro da janela e recebeu a confirmação: não precisa de lembrete logo em seguida
        if (a.createdAt >= start - R && confirmSent.get(t.id, r.id)) continue;
        if (await sendForAppt(t.id, r.id, 'reminder') === 'sent') sent++;
      }
    }
    return sent;
  }
  /* Vendas pagas depois: cobrança pelo WhatsApp (a partir das 9h, no fuso do salão)
     - no 1º dia útil do mês: resumo do que a cliente ainda deve de compras;
     - no dia de cada vencimento: lembrete da parcela (ou do pagamento único).
     No 1º dia útil o resumo já cita o que vence no dia, então não manda os dois. */
  const salesOf = db.prepare("SELECT data FROM records WHERE tenant_id = ? AND coll = 'sales' AND deleted = 0");
  const DAY_START = 9 * 60;
  function firstBusinessDay(ym, closed = []) {
    for (let d = 1; d <= 7; d++) {
      const date = `${ym}-${String(d).padStart(2, '0')}`;
      if (weekday(date) !== 0 && weekday(date) !== 6 && !closed.includes(date)) return date;
    }
    return `${ym}-01`;
  }
  async function sendSale(t, s, { apptId, kind, client, body }) {
    const phone = waNumber(client?.phone);
    const row = { tenantId: t.id, apptId, kind, phone, name: client?.name || '', body, now: Date.now() };
    if (!q.claim.run(row).changes && !q.reclaim.run(row).changes) return 'already';
    if (!phone) { q.doneBy.run('skipped', 'sem telefone', t.id, apptId, kind); return 'skip'; }
    try {
      await queuedSend(s.whatsapp.instance, phone, body);
      q.doneBy.run('sent', null, t.id, apptId, kind);
      return 'sent';
    } catch (e) {
      q.doneBy.run('error', String(e.message).slice(0, 300), t.id, apptId, kind);
      log.warn?.({ err: e.message, tenantId: t.id, kind }, 'whatsapp: falha ao enviar cobrança');
      return 'error';
    }
  }
  // Comprovante da venda, logo depois de lançar: paga (forma de pagamento) ou a prazo (entrada e parcelas)
  // manual = a profissional pediu pelo botão: manda mesmo com a opção desligada e mesmo se já mandou antes
  async function sendSaleNew(tenantId, key, { manual = false } = {}) {
    const t = q.tenant.get(tenantId);
    if (!t || !evo.enabled) return 'off';
    const s = readSettings(t.settings);
    if (!s.whatsapp.instance || (!s.whatsapp.saleConfirm && !manual)) return 'off';
    const o = groupOrders(salesOf.all(tenantId).map(r => JSON.parse(r.data)).filter(x => (x.orderId || x.id) === key))[0];
    if (!o?.clientId) return 'skip';
    const client = getRecord(tenantId, 'clients', o.clientId);
    const d2 = d => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
    const METHOD = { pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão' };
    const parts = installments(o);
    let pagamento;
    if (parts.length) {
      pagamento = [
        o.plan.entrada > 0 ? `✅ Entrada: ${brl(Math.min(o.plan.entrada, o.total))}` : '',
        ...parts.map(p => `${p.of > 1 ? `${p.n}ª parcela` : 'Pagamento'}: ${brl(p.amount)} — vence ${d2(p.date)}`),
      ].filter(Boolean).join('\n');
    } else if (o.left <= 0) {
      const how = [...new Set(o.lines.flatMap(x => x.payments || []).map(p => METHOD[p.m]).filter(Boolean))].join(' + ');
      pagamento = `✅ Pago${how ? ` (${how})` : ''}`;
    } else {
      pagamento = `${o.paid > 0 ? `✅ Pago: ${brl(o.paid)}\n` : ''}⏳ Falta: ${brl(o.left)}`;
    }
    const tpl = s.whatsapp.templates.saleNew || DEFAULTS.whatsapp.templates.saleNew;
    const body = renderTemplate(tpl, {
      nome: (client?.name || '').split(' ')[0], salao: t.name, produtos: o.lines.map(x => `• ${x.product}${x.desc ? ` (${x.desc})` : ''}${x.qty > 1 ? ` (${x.qty}x)` : ''} — ${brl(valueOfSale(x))}`).join('\n'),
      total: brl(o.total), pagamento, pix: o.left > 0 ? s.whatsapp.pixKey || '' : '',
    });
    if (manual && !waNumber(client?.phone)) return 'nophone';
    return sendSale(t, s, { apptId: `sale:${key}`, kind: manual ? `salenew:${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : 'salenew', client, body });
  }
  const valueOfSale = x => ('total' in x ? x.total : x.price) || 0;

  // Recibo: a profissional registrou um pagamento (ou ele caiu pelo banco). coll 'appts' (id do horário) ou 'sales' (chave da compra).
  // Uma mensagem por "quanto já foi pago" daquele horário/compra: o mesmo pagamento não sai duas vezes.
  async function sendPaid(tenantId, { coll, id, amount, method }) {
    const t = q.tenant.get(tenantId);
    if (!t || !evo.enabled) return 'off';
    const s = readSettings(t.settings);
    const on = coll === 'appts' ? s.whatsapp.paidMessage : s.whatsapp.paidMessageSales; // serviços e compras ligam separado
    if (!s.whatsapp.instance || !on || !(amount > 0)) return 'off';
    const METHOD = { pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão' };
    let client, referente, restante, ref, kind;
    if (coll === 'appts') {
      const a = getRecord(tenantId, 'appts', id);
      if (!a?.clientId) return 'skip';
      client = getRecord(tenantId, 'clients', a.clientId);
      const left = leftOf(a);
      referente = `💇 ${a.service || 'Atendimento'} — ${dayLabel(a.date)}`;
      restante = left > 0 ? `⏳ Falta: ${brl(left)}` : '✅ Está tudo pago.';
      ref = id; kind = `paid:${paidOf(a)}`;
    } else {
      const o = groupOrders(salesOf.all(tenantId).map(r => JSON.parse(r.data)).filter(x => (x.orderId || x.id) === id))[0];
      if (!o?.clientId) return 'skip';
      client = getRecord(tenantId, 'clients', o.clientId);
      const next = installments(o).find(p => p.left > 0);
      referente = `🛍️ ${productsText(o)}`;
      restante = o.left <= 0 ? '✅ Compra quitada. Obrigada!'
        : `⏳ Falta: ${brl(o.left)}${next ? ` (próxima: ${brl(next.left)} em ${next.date.slice(8, 10)}/${next.date.slice(5, 7)})` : ''}`;
      ref = `sale:${id}`; kind = `paid:${o.paid}`;
    }
    const tpl = s.whatsapp.templates.paid || DEFAULTS.whatsapp.templates.paid;
    const body = renderTemplate(tpl, { nome: (client?.name || '').split(' ')[0], salao: t.name, valor: brl(amount), forma: METHOD[method] || '', referente, restante });
    return sendSale(t, s, { apptId: ref, kind, client, body });
  }

  async function runSaleReminders(now = Date.now()) {
    let sent = 0;
    for (const t of tenantsOn.all()) {
      const s = readSettings(t.settings);
      if (!s.whatsapp.saleReminders) continue;
      const here = nowIn(s.timezone, now);
      if (here.minutes < DAY_START) continue;
      const orders = groupOrders(salesOf.all(t.id).map(r => JSON.parse(r.data))).filter(o => o.clientId && o.left > 0);
      if (!orders.length) continue;
      const tenant = { ...t, ...q.tenant.get(t.id) };
      const clientOf = id => getRecord(t.id, 'clients', id);
      const base = { salao: tenant.name, pix: s.whatsapp.pixKey || '' };
      const tplOf = k => s.whatsapp.templates[k] || DEFAULTS.whatsapp.templates[k];
      const monthDay = here.date === firstBusinessDay(here.date.slice(0, 7), s.booking.closedDates);

      // 1º dia útil: um resumo por cliente
      const summarized = new Set();
      if (monthDay) {
        const byClient = new Map();
        for (const o of orders) byClient.set(o.clientId, [...(byClient.get(o.clientId) || []), o]);
        for (const [clientId, list] of byClient) {
          const client = clientOf(clientId);
          if (!client) continue;
          const lines = list.map(o => {
            const open = installments(o).filter(p => p.left > 0);
            const next = open[0];
            return next
              ? `• ${productsText(o)} — ${next.of > 1 ? `parcela ${next.n} de ${next.of}: ` : ''}${brl(next.left)} (vence ${next.date === here.date ? 'hoje' : next.date.slice(8, 10) + '/' + next.date.slice(5, 7)})`
              : `• ${productsText(o)} — ${brl(o.left)}`;
          });
          const body = renderTemplate(tplOf('saleMonth'), { ...base, nome: (client.name || '').split(' ')[0], lista: lines.join('\n'),
            total: brl(list.reduce((t2, o) => t2 + o.left, 0)) });
          const r = await sendSale(t, s, { apptId: `client:${clientId}`, kind: `salemonth:${here.date.slice(0, 7)}`, client, body });
          if (r === 'sent') sent++;
          if (r !== 'error') summarized.add(clientId);
        }
      }

      // Dia do vencimento
      for (const o of orders) {
        for (const p of installments(o)) {
          if (p.date !== here.date || p.left <= 0) continue;
          const apptId = `sale:${o.key}`, kind = `saledue:${p.date}`;
          const client = clientOf(o.clientId);
          if (summarized.has(o.clientId)) { // já foi no resumo do mês
            if (q.claim.run({ tenantId: t.id, apptId, kind, phone: '', name: client?.name || '', body: '', now }).changes) q.doneBy.run('skipped', 'já foi no resumo do mês', t.id, apptId, kind);
            continue;
          }
          const body = renderTemplate(tplOf('saleDue'), { ...base, nome: (client?.name || '').split(' ')[0],
            parcela: p.of > 1 ? `a parcela ${p.n} de ${p.of}` : 'o pagamento', produtos: productsText(o), valor: brl(p.left),
            vencimento: dayLabel(p.date), total: brl(o.left) });
          if (await sendSale(t, s, { apptId, kind, client, body }) === 'sent') sent++;
        }
      }
    }
    return sent;
  }

  // Deixa cada WhatsApp conectado "offline" (as notificações continuam chegando no celular)
  async function keepQuiet() {
    if (!evo.enabled) return 0;
    let n = 0;
    for (const t of tenantsOn.all()) {
      const name = readSettings(t.settings).whatsapp.instance;
      try {
        if (!quieted.has(name)) { await evo.setSettings(name); quieted.add(name); }
        await evo.setPresence(name, 'unavailable');
        n++;
      } catch (e) {
        if (e.status !== 404) log.warn?.({ err: e.message, name }, 'whatsapp: não consegui deixar offline');
      }
    }
    return n;
  }
  const quieted = new Set();
  function startScheduler(everyMs = 60_000) {
    let busy = false, ticks = 0;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        if (ticks++ % 10 === 0) await keepQuiet(); // logo ao ligar e depois a cada 10 minutos
        await runReminders();
        await runSaleReminders();
      } catch (e) { log.error?.(e); } finally { busy = false; }
    };
    tick();
    return setInterval(tick, everyMs);
  }

  return { sendForAppt, sendText, fire, runReminders, runSaleReminders, sendSaleNew, sendPaid, startScheduler, packageLabel, keepQuiet };
}

/* ------------------------- rotas (profissional logada) ------------------------- */
export function registerWhatsapp(app, { db, evo, messenger, auth, getSettings, saveSettings }) {
  const instanceName = tenantId => `mf-${tenantId}`.replace(/[^A-Za-z0-9_-]/g, '');
  const needEvo = () => { if (!evo.enabled) fail(503, 'O WhatsApp automático ainda não foi configurado no servidor.'); };
  const ownerNumber = info => {
    const list = Array.isArray(info) ? info : [info];
    const jid = list.map(x => x?.ownerJid || x?.instance?.owner || x?.owner).find(Boolean) || '';
    return String(jid).split('@')[0].replace(/\D/g, '');
  };

  const quietDone = new Set();
  app.get('/api/whatsapp/status', { preHandler: auth }, async req => {
    const s = getSettings(req.s.tenant_id);
    if (!evo.enabled || !s.whatsapp.instance) return { available: evo.enabled, state: 'off' };
    let state = 'close';
    try { state = (await evo.state(s.whatsapp.instance))?.instance?.state || 'close'; }
    catch (e) { if (e.status !== 404) return { available: true, state: 'error', error: e.message }; }
    if (state === 'open' && !quietDone.has(s.whatsapp.instance)) {
      quietDone.add(s.whatsapp.instance);
      evo.setSettings(s.whatsapp.instance).then(() => evo.setPresence(s.whatsapp.instance, 'unavailable')).catch(() => {});
    }
    if (state === 'open' && !s.whatsapp.number) {
      const number = ownerNumber(await evo.info(s.whatsapp.instance).catch(() => null));
      if (number) saveSettings(req.s.tenant_id, { ...s, whatsapp: { ...s.whatsapp, number } });
      s.whatsapp.number = number;
    }
    return { available: true, state, number: s.whatsapp.number || '' };
  });

  // Cria a instância (se precisar) e devolve o QR code — ou, com `phone`, o código de 8 dígitos
  app.post('/api/whatsapp/connect', { preHandler: auth }, async req => {
    needEvo();
    const tenantId = req.s.tenant_id;
    const s = getSettings(tenantId);
    const phone = isObj(req.body) && req.body.phone ? waNumber(req.body.phone) : '';
    if (isObj(req.body) && req.body.phone && !phone) fail(400, 'Telefone inválido. Exemplo: (11) 99999-9999');
    let pairingCode = null;
    const name = s.whatsapp.instance || instanceName(tenantId);
    let qr = null;
    let exists = true;
    try {
      const st = await evo.state(name);
      if (st?.instance?.state === 'open') return { state: 'open' };
    } catch (e) {
      if (e.status !== 404) fail(502, 'Não foi possível falar com o WhatsApp: ' + e.message);
      exists = false;
    }
    try {
      if (!exists) qr = (await evo.create(name))?.qrcode?.base64 || null;
      if (phone) {
        const r = await evo.connect(name, phone);
        pairingCode = r?.pairingCode || null;
        qr = r?.base64 || qr;
      } else if (!qr) qr = (await evo.connect(name))?.base64 || null;
    } catch (e) {
      fail(502, 'Não foi possível gerar o QR code: ' + e.message);
    }
    if (s.whatsapp.instance !== name) saveSettings(tenantId, { ...s, whatsapp: { ...s.whatsapp, instance: name, number: '' } });
    if (qr && !qr.startsWith('data:')) qr = 'data:image/png;base64,' + qr;
    return { state: 'connecting', qr, pairingCode };
  });

  app.post('/api/whatsapp/disconnect', { preHandler: auth }, async req => {
    const s = getSettings(req.s.tenant_id);
    if (s.whatsapp.instance && evo.enabled) {
      await evo.logout(s.whatsapp.instance).catch(() => {});
      await evo.remove(s.whatsapp.instance).catch(() => {});
    }
    saveSettings(req.s.tenant_id, { ...s, whatsapp: { ...s.whatsapp, instance: null, number: '' } });
    return { ok: true };
  });

  app.post('/api/whatsapp/test', { preHandler: auth }, async req => {
    const s = getSettings(req.s.tenant_id);
    const phone = (isObj(req.body) && req.body.phone) || s.whatsapp.ownerPhone || s.whatsapp.number;
    await messenger.sendText(req.s.tenant_id, phone, `✅ Teste do Marque Fácil: o WhatsApp automático do ${req.s.tenant_name} está funcionando!`);
    return { ok: true };
  });

  app.get('/api/messages', { preHandler: auth }, async req => {
    return db.prepare(`SELECT appt_id AS apptId, kind, phone, name, body, status, error, created_at AS createdAt
                       FROM messages WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 30`).all(req.s.tenant_id);
  });
}
