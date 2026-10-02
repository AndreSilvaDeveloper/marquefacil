import crypto from 'node:crypto';
import { readSettings } from './settings.js';
import { fail, isObj } from './util.js';
import { nowIn, addDays, dayLabel, zonedEpoch } from './time.js';
import { applyChanges } from './db.js';
import { groupOrders, installments, productsText, r2, valueOf, leftOf, paidOf, withPayment, payOrderLines } from './sales.js';

/* Pagamento online pelo Asaas (banco da profissional).
   - A profissional cola a chave de API da conta Asaas dela (Mais → Pagamentos online). A chave fica só no
     servidor (tabela kv, 'asaas:<salão>') e nunca volta para o app. O sistema cria sozinho o webhook no Asaas.
   - Na página "Meus horários" a cliente vê o que tem em aberto e paga por Pix (QR code / copia e cola) ou cartão,
     conforme o que a profissional ligou: sinal da pré-reserva, serviços, compras de produtos.
   - Quando o Asaas avisa que caiu (webhook, ou a conferência pelo próprio sistema), o pagamento entra no
     horário/compra; pré-reserva com sinal pago vira horário confirmado e a cliente recebe a confirmação. */

const BASE = { prod: 'https://api.asaas.com/v3', sandbox: 'https://api-sandbox.asaas.com/v3' };
export const asaasEnv = key => (/_hmlg_/.test(key) ? 'sandbox' : 'prod');
const PAID = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);
const EVENTS = ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'];

export function asaasClient({ fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  return async function call(key, method, path, body) {
    let r;
    try {
      r = await fetchImpl(BASE[asaasEnv(key)] + path, {
        method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
        headers: { access_token: key, 'Content-Type': 'application/json', 'User-Agent': 'MarqueFacil' },
      });
    } catch {
      throw Object.assign(new Error('Não foi possível falar com o Asaas agora. Tente de novo em instantes.'), { asaas: true });
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(j.errors?.[0]?.description || `O Asaas recusou (${r.status}).`);
      Object.assign(e, { asaas: true, status: r.status });
      throw e;
    }
    return j;
  };
}

// CPF ou CNPJ com os dígitos verificadores certos
export function cpfCnpjOk(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (/^(\d)\1+$/.test(d)) return false;
  const dv = (base, weights) => { const s = base.split('').reduce((t, n, i) => t + n * weights[i], 0) % 11; return s < 2 ? 0 : 11 - s; };
  if (d.length === 11) {
    const w = n => Array.from({ length: n }, (_, i) => n + 1 - i);
    return dv(d.slice(0, 9), w(9)) === +d[9] && dv(d.slice(0, 10), w(10)) === +d[10];
  }
  if (d.length === 14) {
    const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], w2 = [6, ...w1];
    return dv(d.slice(0, 12), w1) === +d[12] && dv(d.slice(0, 13), w2) === +d[13];
  }
  return false;
}

// Senha do webhook: só letras e números, sem repetir o mesmo caractere 3 vezes seguidas
function webhookToken() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let t = '';
  while (t.length < 40) {
    const c = abc[crypto.randomInt(abc.length)];
    if (t.length >= 2 && t.at(-1) === c && t.at(-2) === c) continue;
    t += c;
  }
  return t;
}

export function createPayments({ db, call, messenger, push, log = console }) {
  const q = {
    secret: db.prepare('SELECT value FROM kv WHERE key = ?'),
    setSecret: db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
    delSecret: db.prepare('DELETE FROM kv WHERE key = ?'),
    tenant: db.prepare('SELECT id, name, slug, settings FROM tenants WHERE id = ?'),
    record: db.prepare('SELECT data FROM records WHERE tenant_id = ? AND coll = ? AND id = ? AND deleted = 0'),
    clientAppts: db.prepare(`SELECT data FROM records WHERE tenant_id = ? AND coll = 'appts' AND deleted = 0
                             AND json_extract(data, '$.clientId') = ?`),
    clientSales: db.prepare(`SELECT data FROM records WHERE tenant_id = ? AND coll = 'sales' AND deleted = 0
                             AND json_extract(data, '$.clientId') = ?`),
    customer: db.prepare('SELECT customer_id FROM pay_customers WHERE tenant_id = ? AND client_id = ? AND env = ?'),
    addCustomer: db.prepare('INSERT OR REPLACE INTO pay_customers (tenant_id, client_id, env, customer_id) VALUES (?, ?, ?, ?)'),
    charge: db.prepare('SELECT * FROM charges WHERE id = ?'),
    reuse: db.prepare(`SELECT * FROM charges WHERE tenant_id = ? AND client_id = ? AND kind = ? AND ref = ? AND what = ?
                       AND value = ? AND status = 'open' AND created_at > ? ORDER BY created_at DESC LIMIT 1`),
    addCharge: db.prepare(`INSERT INTO charges (id, tenant_id, client_id, kind, ref, what, value, status, data, created_at, checked_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`),
    markPaid: db.prepare("UPDATE charges SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'open'"),
    checked: db.prepare('UPDATE charges SET checked_at = ? WHERE id = ?'),
    toCheck: db.prepare("SELECT * FROM charges WHERE status = 'open' AND created_at > ? AND checked_at < ? ORDER BY checked_at LIMIT 30"),
  };
  const get = (t, coll, id) => { const r = q.record.get(t, coll, id); return r ? JSON.parse(r.data) : null; };
  const secretOf = tenantId => { const r = q.secret.get(`asaas:${tenantId}`); return r ? JSON.parse(r.value) : null; };
  const connected = tenantId => !!secretOf(tenantId)?.key;

  /* --------------------------- o que a cliente pode pagar --------------------------- */
  // Sinal da pré-reserva (a % das configurações do WhatsApp)
  const depositOf = (s, a) => (a.price > 0 ? r2(a.price * s.whatsapp.depositPercent / 100) : 0);
  const d2 = d => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

  // Lista do que está em aberto e pode ser pago online (só o que a profissional ligou)
  // [{ kind, ref, title, sub, options: [{ what, label, value }] }]
  function openItems(tenantId, s, clientId) {
    if (!connected(tenantId)) return [];
    const P = s.payments, out = [];
    const now = nowIn(s.timezone), nowMs = Date.now();
    const appts = q.clientAppts.all(tenantId, clientId).map(r => JSON.parse(r.data))
      .filter(a => a.status !== 'cancelado' && a.status !== 'pendente' && a.price > 0)
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    for (const a of appts) {
      const left = leftOf(a), paid = paidOf(a);
      if (left <= 0) continue;
      const future = a.date && a.time && zonedEpoch(a.date, a.time, s.timezone) > nowMs;
      const options = [];
      if (a.status === 'prereserva') {
        if (!future) continue;
        const dep = Math.max(0, r2(depositOf(s, a) - paid));
        if (P.deposit && dep > 0) options.push({ what: 'sinal', label: `Pagar o sinal (${s.whatsapp.depositPercent}%)`, value: dep });
        if (P.services && left > dep) options.push({ what: 'tudo', label: 'Pagar o valor todo', value: left });
      } else if (P.services) {
        options.push({ what: 'tudo', label: future ? 'Pagar adiantado' : 'Pagar', value: left });
      }
      if (!options.length) continue;
      out.push({
        kind: 'appt', ref: a.id, title: a.service || 'Atendimento',
        sub: `${dayLabel(a.date)} às ${a.time}${a.status === 'prereserva' ? ' · pré-reserva' : ''}${paid > 0 ? ` · já pago ${brl(paid)}` : ''}`,
        prereserve: a.status === 'prereserva', options,
      });
    }
    // sinal da pré-reserva primeiro: é o que confirma o horário
    out.sort((a, b) => (b.prereserve ? 1 : 0) - (a.prereserve ? 1 : 0));
    if (P.products) {
      const orders = groupOrders(q.clientSales.all(tenantId, clientId).map(r => JSON.parse(r.data))).filter(o => o.left > 0);
      for (const o of orders.sort((a, b) => a.date.localeCompare(b.date))) {
        const parts = installments(o), open = parts.filter(p => p.left > 0);
        const options = [];
        if (open.length) {
          const dueNow = r2(open.filter(p => p.date <= now.date).reduce((t, p) => t + p.left, 0));
          const first = dueNow > 0 ? dueNow : open[0].left;
          const label = dueNow > 0 ? (open.filter(p => p.date <= now.date).length > 1 ? 'Pagar as parcelas vencidas' : 'Pagar a parcela') : `Adiantar a próxima parcela (vence ${d2(open[0].date)})`;
          options.push({ what: 'parcela', label, value: first });
          if (o.left > first) options.push({ what: 'tudo', label: 'Pagar tudo', value: o.left });
        } else {
          options.push({ what: 'tudo', label: 'Pagar', value: o.left });
        }
        out.push({
          kind: 'order', ref: o.key, title: productsText(o),
          sub: `Compra de ${d2(o.date)} · falta ${brl(o.left)}${open.length ? ` · ${open.length === 1 ? '1 parcela' : `${open.length} parcelas`}` : ''}`,
          options,
        });
      }
    }
    return out;
  }

  /* --------------------------- cobrança --------------------------- */
  async function customerFor(tenantId, key, client, cpf) {
    const env = asaasEnv(key);
    const row = q.customer.get(tenantId, client.id, env);
    if (row) return row.customer_id;
    if (!cpf) fail(428, 'Para pagar online, o banco pede o seu CPF (só na primeira vez).');
    if (!cpfCnpjOk(cpf)) fail(400, 'O CPF não está certo. Confira os números.');
    const phone = String(client.phone || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
    const c = await call(key, 'POST', '/customers', {
      name: client.name || 'Cliente', cpfCnpj: String(cpf).replace(/\D/g, ''), externalReference: client.id,
      notificationDisabled: true, // quem avisa a cliente é o salão (WhatsApp), não o Asaas
      ...(phone.length >= 10 ? { mobilePhone: phone } : {}),
    });
    q.addCustomer.run(tenantId, client.id, env, c.id);
    return c.id;
  }

  const view = row => {
    const d = JSON.parse(row.data || '{}');
    return { id: row.id, value: row.value, status: row.status, title: d.title, pix: d.payload ? { image: d.image, payload: d.payload } : null, invoiceUrl: d.invoiceUrl || null };
  };

  // Gera (ou reaproveita) a cobrança de um item em aberto. O valor é sempre calculado aqui.
  async function createCharge(tenant, client, { kind, ref, what, cpf }) {
    const sec = secretOf(tenant.id);
    if (!sec?.key) fail(400, 'O pagamento online não está ligado neste salão.');
    const s = readSettings(tenant.settings);
    const item = openItems(tenant.id, s, client.id).find(i => i.kind === kind && i.ref === ref);
    const opt = item?.options.find(o => o.what === what);
    if (!opt) fail(409, 'Esse pagamento não está mais em aberto. Atualize a página.');
    const old = q.reuse.get(tenant.id, client.id, kind, ref, what, opt.value, Date.now() - 20 * 3600e3);
    if (old) return view(old);

    const customer = await customerFor(tenant.id, sec.key, client, cpf);
    const today = nowIn(s.timezone).date;
    const title = kind === 'appt' ? `${what === 'sinal' ? 'Sinal — ' : ''}${item.title} (${item.sub.split(' · ')[0]})` : `Compra: ${item.title}`;
    let p;
    try {
      p = await call(sec.key, 'POST', '/payments', {
        customer, billingType: s.payments.card ? 'UNDEFINED' : 'PIX', value: opt.value, dueDate: addDays(today, 1),
        description: `${tenant.name} — ${title}`.slice(0, 480), externalReference: `${kind}:${ref}`.slice(0, 100),
      });
    } catch (e) {
      if (e.asaas) fail(502, `O banco não gerou o pagamento: ${e.message}`);
      throw e;
    }
    let pix = {};
    try {
      const qr = await call(sec.key, 'GET', `/payments/${p.id}/pixQrCode`);
      pix = { image: qr.encodedImage, payload: qr.payload };
    } catch (e) {
      log.warn?.({ err: e.message, tenantId: tenant.id }, 'asaas: sem QR code Pix');
      if (!s.payments.card) fail(502, 'O banco não gerou o Pix. O salão precisa ter uma chave Pix cadastrada no Asaas.');
    }
    const data = { title, invoiceUrl: p.invoiceUrl || '', ...pix };
    q.addCharge.run(p.id, tenant.id, client.id, kind, ref, what, opt.value, JSON.stringify(data), Date.now(), Date.now());
    return view(q.charge.get(p.id));
  }

  /* --------------------------- pagamento caiu --------------------------- */
  // Idempotente: a mesma cobrança só entra uma vez (webhook repetido, conferência e webhook juntos…)
  // tenantId: quem avisou (webhook de um salão não mexe em cobrança de outro)
  function settle(chargeId, payment = {}, tenantId = null) {
    const row = q.charge.get(chargeId);
    if (!row || row.status !== 'open' || (tenantId && row.tenant_id !== tenantId)) return false;
    if (!q.markPaid.run(Date.now(), chargeId).changes) return false;
    const tenant = q.tenant.get(row.tenant_id);
    if (!tenant) return false;
    const s = readSettings(tenant.settings);
    const m = /CARD/.test(payment.billingType || '') ? 'cartao' : 'pix';
    const d = String(payment.clientPaymentDate || payment.paymentDate || payment.confirmedDate || '').slice(0, 10) || nowIn(s.timezone).date;
    const v = row.value; // o valor que o sistema cobrou (não o que vem no aviso)
    const extra = { via: 'asaas', ref: chargeId };
    const client = get(row.tenant_id, 'clients', row.client_id);
    const who = client?.name || 'Cliente';

    if (row.kind === 'appt') {
      const a = get(row.tenant_id, 'appts', row.ref);
      if (!a) return true;
      let next = withPayment(a, v, m, d, extra);
      const wasPre = a.status === 'prereserva';
      if (wasPre) next = { ...next, status: 'marcado', confirmedBy: 'pagamento' };
      applyChanges(db, row.tenant_id, [{ coll: 'appts', id: a.id, data: next }]);
      push.notifyTenant(row.tenant_id, {
        title: wasPre ? '💰 Sinal pago — horário confirmado' : '💰 Pagamento recebido',
        body: `${who} pagou ${brl(v)} (${m === 'cartao' ? 'cartão' : 'Pix'}) · ${dayLabel(a.date)} às ${a.time}`,
        url: `/#/agendamento/${a.id}`, tag: `pay:${chargeId}`,
      }).catch(() => {});
      // pré-reserva que virou confirmada: a cliente recebe a confirmação (igual quando a profissional confirma no app)
      if (wasPre && s.whatsapp.confirmManual) messenger.fire(row.tenant_id, a.id, 'confirm');
    } else {
      const lines = q.clientSales.all(row.tenant_id, row.client_id).map(r => JSON.parse(r.data)).filter(x => (x.orderId || x.id) === row.ref);
      const changed = payOrderLines(lines, v, m, d, extra);
      if (changed.length) applyChanges(db, row.tenant_id, changed.map(x => ({ coll: 'sales', id: x.id, data: x })));
      push.notifyTenant(row.tenant_id, {
        title: '💰 Pagamento de compra recebido',
        body: `${who} pagou ${brl(v)} (${m === 'cartao' ? 'cartão' : 'Pix'}) · ${lines.length ? productsText({ lines }) : 'compra'}`,
        url: lines[0] ? `/#/venda?id=${lines[0].id}` : '/#/financeiro', tag: `pay:${chargeId}`,
      }).catch(() => {});
    }
    return true;
  }

  // Pergunta ao Asaas se a cobrança já foi paga (quando o webhook não chegou)
  async function check(row) {
    const sec = secretOf(row.tenant_id);
    if (!sec?.key) return row.status;
    q.checked.run(Date.now(), row.id);
    try {
      const p = await call(sec.key, 'GET', `/payments/${row.id}`);
      if (PAID.has(p.status)) settle(row.id, p, row.tenant_id);
    } catch (e) {
      log.warn?.({ err: e.message, charge: row.id }, 'asaas: falha ao conferir cobrança');
    }
    return q.charge.get(row.id).status;
  }

  async function status(tenantId, clientId, id) {
    const row = q.charge.get(String(id || ''));
    if (!row || row.tenant_id !== tenantId || row.client_id !== clientId) fail(404, 'Pagamento não encontrado.');
    // a página pergunta a cada poucos segundos; o banco é consultado no máximo a cada 8 s
    if (row.status === 'open' && Date.now() - row.checked_at > 8000) await check(row);
    return view(q.charge.get(row.id));
  }

  async function checkOpen() {
    const rows = q.toCheck.all(Date.now() - 3 * 86400e3, Date.now() - 2 * 60e3);
    for (const r of rows) await check(r);
    return rows.length;
  }
  let timer = null;
  const start = (everyMs = 2 * 60e3) => { timer = setInterval(() => checkOpen().catch(e => log.error?.(e)), everyMs); timer.unref?.(); };
  const stop = () => clearInterval(timer);

  /* --------------------------- ligar / desligar --------------------------- */
  async function connect(tenantId, apiKey, { webhookUrl, email }) {
    const key = String(apiKey || '').trim();
    if (!/^\$aact_[A-Za-z0-9_$:\-.=]{20,}$/.test(key)) fail(400, 'Essa chave não parece do Asaas. Ela começa com $aact_');
    try {
      await call(key, 'GET', '/finance/balance');
    } catch (e) {
      if (e.status === 401 || e.status === 403) fail(400, 'O Asaas não aceitou essa chave. Confira se copiou inteira.');
      fail(502, e.message);
    }
    let name = '';
    try { const ci = await call(key, 'GET', '/myAccount/commercialInfo'); name = ci.companyName || ci.name || ''; } catch { /* só o nome */ }
    const old = secretOf(tenantId);
    if (old?.webhookId && old.key) await call(old.key, 'DELETE', `/webhooks/${old.webhookId}`).catch(() => {});
    const sec = { key, env: asaasEnv(key), name, connectedAt: Date.now(), webhookToken: webhookToken(), webhookId: null, webhookError: '' };
    try {
      const w = await call(key, 'POST', '/webhooks', {
        name: 'Marque Fácil', url: webhookUrl, email, enabled: true, interrupted: false, apiVersion: 3,
        authToken: sec.webhookToken, sendType: 'SEQUENTIALLY', events: EVENTS,
      });
      sec.webhookId = w.id || null;
    } catch (e) {
      // sem webhook ainda funciona: o sistema confere as cobranças sozinho (mais devagar)
      sec.webhookError = e.message;
      log.warn?.({ err: e.message, tenantId }, 'asaas: webhook não criado');
    }
    q.setSecret.run(`asaas:${tenantId}`, JSON.stringify(sec));
    return info(tenantId);
  }
  async function disconnect(tenantId) {
    const sec = secretOf(tenantId);
    if (sec?.webhookId) await call(sec.key, 'DELETE', `/webhooks/${sec.webhookId}`).catch(() => {});
    q.delSecret.run(`asaas:${tenantId}`);
  }
  function info(tenantId) {
    const sec = secretOf(tenantId);
    if (!sec?.key) return { connected: false };
    return { connected: true, env: sec.env, name: sec.name || '', webhook: !!sec.webhookId, webhookError: sec.webhookError || '', keyEnd: sec.key.slice(-4) };
  }
  // Webhook: confere a senha que o Asaas manda no cabeçalho
  function webhookOk(tenantId, token) {
    const want = secretOf(tenantId)?.webhookToken;
    if (!want || typeof token !== 'string' || token.length !== want.length) return false;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(want));
  }

  return { connected, openItems, createCharge, settle, status, check, checkOpen, start, stop, connect, disconnect, info, webhookOk, depositOf };
}

const brl = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function registerPayments(app, { pay, auth }) {
  app.get('/api/asaas', { preHandler: auth }, async req => pay.info(req.s.tenant_id));

  app.put('/api/asaas', { preHandler: auth }, async req => {
    const b = isObj(req.body) ? req.body : {};
    // o Asaas avisa os pagamentos neste endereço (o domínio em que a profissional está usando o app)
    const webhookUrl = `https://${req.hostname.replace(/:\d+$/, '')}/api/asaas/webhook/${req.s.tenant_id}`;
    return pay.connect(req.s.tenant_id, b.apiKey, { webhookUrl, email: req.s.email });
  });

  app.delete('/api/asaas', { preHandler: auth }, async req => { await pay.disconnect(req.s.tenant_id); return { connected: false }; });

  app.post('/api/asaas/webhook/:tenant', async (req, reply) => {
    if (!pay.webhookOk(String(req.params.tenant), req.headers['asaas-access-token'])) return reply.code(401).send({ error: 'token' });
    const b = isObj(req.body) ? req.body : {};
    if (EVENTS.includes(b.event) && isObj(b.payment) && b.payment.id) pay.settle(String(b.payment.id), b.payment, String(req.params.tenant));
    return { ok: true }; // sempre 200: senão o Asaas pausa a fila de avisos
  });
}
