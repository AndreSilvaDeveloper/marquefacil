import { readSettings, DEFAULTS } from './settings.js';
import { fail, isObj, waNumber } from './util.js';
import { nowIn, zonedEpoch, addDays, dayLabel } from './time.js';

/* ------------------------- cliente da Evolution API (v2) ------------------------- */
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
    create: name => call('POST', '/instance/create', { instanceName: name, integration: 'WHATSAPP-BAILEYS', qrcode: true }),
    // com `number`, a Evolution devolve também um código para "Conectar com número de telefone"
    connect: (name, number) => call('GET', `/instance/connect/${enc(name)}${number ? '?number=' + enc(number) : ''}`),
    state: name => call('GET', `/instance/connectionState/${enc(name)}`),
    info: name => call('GET', `/instance/fetchInstances?instanceName=${enc(name)}`),
    send: (name, number, text) => call('POST', `/message/sendText/${enc(name)}`, { number, text }),
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
export function createMessenger({ db, evo, publicUrl = '', log = console }) {
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

  function varsFor(tenant, appt, client) {
    return {
      nome: (client?.name || '').split(' ')[0],
      nome_completo: client?.name || '',
      telefone: client?.phone || '',
      salao: tenant.name,
      dia: dayLabel(appt.date),
      hora: appt.time,
      servico: appt.service || '',
      valor: appt.price > 0 ? brl(appt.price) : appt.priceLater ? 'avaliado na hora do atendimento' : '',
      link: publicUrl ? `${publicUrl.replace(/\/+$/, '')}/${tenant.slug}` : '',
    };
  }

  // kind: 'confirm' | 'reminder' | 'owner' | 'decline'. Cada combinação horário+tipo só é enviada uma vez.
  async function sendForAppt(tenantId, apptId, kind) {
    const tenant = q.tenant.get(tenantId);
    if (!tenant || !evo.enabled) return 'off';
    const s = readSettings(tenant.settings);
    if (!s.whatsapp.instance) return 'off';
    const appt = getRecord(tenantId, 'appts', apptId);
    if (!appt || (appt.status === 'cancelado' && kind !== 'decline')) return 'skip';
    const client = appt.clientId ? getRecord(tenantId, 'clients', appt.clientId) : null;

    const phone = kind === 'owner' ? waNumber(s.whatsapp.ownerPhone || s.whatsapp.number) : waNumber(client?.phone);
    const tpl = s.whatsapp.templates[kind] || DEFAULTS.whatsapp.templates[kind];
    const body = renderTemplate(tpl, varsFor(tenant, appt, client));
    const row = { tenantId, apptId, kind, phone, name: client?.name || '', body, now: Date.now() };

    if (!q.claim.run(row).changes && !q.reclaim.run(row).changes) return 'already';
    if (!phone) { q.doneBy.run('skipped', 'sem telefone', tenantId, apptId, kind); return 'skip'; }
    try {
      await evo.send(s.whatsapp.instance, phone, body);
      q.doneBy.run('sent', null, tenantId, apptId, kind);
      return 'sent';
    } catch (e) {
      q.doneBy.run('error', String(e.message).slice(0, 300), tenantId, apptId, kind);
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
      await evo.send(s.whatsapp.instance, number, body);
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
  function startScheduler(everyMs = 60_000) {
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try { await runReminders(); } catch (e) { log.error?.(e); } finally { busy = false; }
    };
    return setInterval(tick, everyMs);
  }

  return { sendForAppt, sendText, fire, runReminders, startScheduler };
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

  app.get('/api/whatsapp/status', { preHandler: auth }, async req => {
    const s = getSettings(req.s.tenant_id);
    if (!evo.enabled || !s.whatsapp.instance) return { available: evo.enabled, state: 'off' };
    let state = 'close';
    try { state = (await evo.state(s.whatsapp.instance))?.instance?.state || 'close'; }
    catch (e) { if (e.status !== 404) return { available: true, state: 'error', error: e.message }; }
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
