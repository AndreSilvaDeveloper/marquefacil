import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { cpfCnpjOk } from '../src/asaas.js';
import { nowIn, addDays, weekday } from '../src/time.js';

function client(app) {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const res = await app.inject({ method, url, payload: body, headers: { cookie, ...headers } });
    const set = res.headers['set-cookie'];
    if (set) cookie = [].concat(set).map(c => c.split(';')[0]).join('; ');
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
}

// Asaas de mentira: guarda as chamadas e as cobranças criadas
function fakeAsaas() {
  const calls = [], payments = {};
  let n = 0;
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (url, opts) => {
    const u = new URL(url), body = opts.body ? JSON.parse(opts.body) : null, path = u.pathname.replace(/^\/v3/, '');
    calls.push({ method: opts.method, path, body, key: opts.headers.access_token, host: u.host });
    if (opts.headers.access_token.includes('ruim')) return json(401, { errors: [{ description: 'invalid_access_token' }] });
    if (path === '/finance/balance') return json(200, { balance: 0 });
    if (path === '/myAccount/commercialInfo') return json(200, { companyName: 'Ana ME' });
    if (path === '/webhooks' && opts.method === 'POST') return json(200, { id: 'wh1', ...body });
    if (path.startsWith('/webhooks/') && opts.method === 'DELETE') return json(200, { deleted: true });
    if (path === '/customers') return json(200, { id: `cus_${++n}` });
    if (path === '/payments' && opts.method === 'POST') {
      const id = `pay_${++n}`;
      payments[id] = { id, status: 'PENDING', ...body, invoiceUrl: `https://sandbox.asaas.com/i/${id}` };
      return json(200, payments[id]);
    }
    let m = path.match(/^\/payments\/(\w+)\/pixQrCode$/);
    if (m) return json(200, { encodedImage: 'IMG', payload: `PIXCOPIA-${m[1]}` });
    m = path.match(/^\/payments\/(\w+)$/);
    if (m) return json(200, payments[m[1]]);
    return json(404, { errors: [{ description: 'not found' }] });
  };
  return { calls, payments, fetchImpl };
}

function fakeEvolution() {
  const sent = [], instances = {};
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (url, opts) => {
    const u = new URL(url), body = opts.body ? JSON.parse(opts.body) : null;
    const name = decodeURIComponent(u.pathname.split('/').pop());
    if (u.pathname === '/instance/create') { instances[body.instanceName] = 'connecting'; return json(201, { qrcode: { base64: 'QR' } }); }
    if (u.pathname.startsWith('/instance/connectionState/')) return json(200, { instance: { state: instances[name] || 'close' } });
    if (u.pathname.startsWith('/message/sendText/')) { sent.push(body); return json(201, {}); }
    return json(200, {});
  };
  return { sent, instances, fetchImpl };
}

const KEY = '$aact_hmlg_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OjA5';
const wait = (ms = 80) => new Promise(r => setTimeout(r, ms));

test('CPF/CNPJ: confere os dígitos', () => {
  assert.ok(cpfCnpjOk('529.982.247-25'));
  assert.ok(!cpfCnpjOk('529.982.247-24'));
  assert.ok(!cpfCnpjOk('111.111.111-11'));
  assert.ok(cpfCnpjOk('11.222.333/0001-81'));
  assert.ok(!cpfCnpjOk('123'));
});

test('Asaas: ligar, sinal da pré-reserva pago pelo link confirma o horário; compras parceladas; desligar', async () => {
  const bank = fakeAsaas(), evo = fakeEvolution(), pushed = [];
  const app = buildApp({
    publicUrl: 'https://maquefacil.com.br',
    evolution: { url: 'http://evo.test', apikey: 'k', fetchImpl: evo.fetchImpl },
    asaasFetch: bank.fetchImpl,
    pushSender: async (sub, body) => { pushed.push(JSON.parse(body)); },
  });
  const call = client(app), pub = client(app);
  await call('POST', '/api/signup', { salonName: 'Studio Ana', name: 'Ana', email: 'ana@x.com', password: 'segredo1' });
  const tid = (await call('GET', '/api/me')).body.tenant.id;
  await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://push.test/1', keys: { p256dh: 'a', auth: 'b' } } });
  await call('POST', '/api/whatsapp/connect');
  evo.instances[Object.keys(evo.instances)[0]] = 'open';
  await call('PUT', '/api/settings', { whatsapp: { pixKeyService: 'chave-servicos@x.com' } });

  // 1) chave errada / recusada
  assert.equal((await call('PUT', '/api/asaas', { apiKey: 'qualquer' })).status, 400);
  assert.match((await call('PUT', '/api/asaas', { apiKey: '$aact_ruim_0000000000000000000000000' })).body.error, /não aceitou/);
  assert.equal((await call('GET', '/api/asaas')).body.connected, false);

  // 2) liga: confere a chave, cria o webhook com senha, e a chave nunca volta para o app
  const on = await call('PUT', '/api/asaas', { apiKey: KEY });
  assert.equal(on.status, 200);
  assert.deepEqual([on.body.connected, on.body.env, on.body.name, on.body.webhook], [true, 'sandbox', 'Ana ME', true]);
  const wh = bank.calls.find(c => c.path === '/webhooks' && c.method === 'POST');
  assert.equal(wh.host, 'api-sandbox.asaas.com', 'chave de testes usa o sandbox');
  assert.match(wh.body.url, new RegExp(`/api/asaas/webhook/${tid}$`));
  assert.ok(wh.body.authToken.length >= 32);
  assert.deepEqual(wh.body.events, ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED']);
  const st = await call('GET', '/api/settings');
  assert.ok(!JSON.stringify(st.body).includes(KEY), 'a chave não aparece nas configurações');
  assert.equal(st.body.asaas.connected, true);
  assert.equal(st.body.payments.deposit, true);

  // 3) pré-reserva: a mensagem leva o link para pagar o sinal (e não a chave Pix, que não confirma sozinha)
  const d = addDays(nowIn('America/Sao_Paulo').date, 3);
  await call('POST', '/api/sync', { changes: [
    { coll: 'clients', id: 'c1', data: { name: 'Bia Lima', phone: '11955554444' } },
    { coll: 'appts', id: 'p1', data: { clientId: 'c1', date: d, time: '14:00', service: 'Mechas', price: 300, status: 'prereserva', createdAt: Date.now() } },
    { coll: 'appts', id: 'old', data: { clientId: 'c1', date: addDays(d, -20), time: '10:00', service: 'Corte', price: 80, status: 'feito', payments: [{ v: 30, m: 'pix', d: addDays(d, -20) }] } },
  ] });
  await wait();
  const pre = evo.sent.find(m => /pré-reservado/.test(m.text));
  assert.match(pre.text, /Pague o sinal de R\$\s?150,00/);
  assert.match(pre.text, /https:\/\/maquefacil\.com\.br\/studio-ana#meus=/);
  assert.ok(!pre.text.includes('chave-servicos@x.com'), 'sem a chave Pix manual');
  const token = pre.text.match(/#meus=([\w-]+)/)[1];

  // 4) página da cliente: só o sinal (serviços desligado); histórico com o que ficou em aberto
  let me = (await pub('GET', `/api/public/studio-ana/me?t=${token}`)).body;
  assert.deepEqual(me.pay.items.map(i => [i.kind, i.ref, i.options.map(o => [o.what, o.value])]), [['appt', 'p1', [['sinal', 150]]]]);
  assert.deepEqual(me.history.services.map(s => [s.service, s.price, s.left]), [['Corte', 80, 50]]);

  // 5) pagar: CPF na primeira vez, conferido; depois gera o Pix (e reaproveita se pedir de novo)
  const payReq = extra => pub('POST', '/api/public/studio-ana/me/pay', { t: token, kind: 'appt', ref: 'p1', what: 'sinal', ...extra });
  assert.equal((await payReq()).status, 428);
  assert.equal((await payReq({ cpf: '529.982.247-24' })).status, 400);
  const ch = await payReq({ cpf: '529.982.247-25' });
  assert.equal(ch.status, 200);
  assert.equal(ch.body.value, 150);
  assert.equal(ch.body.pix.payload, `PIXCOPIA-${ch.body.id}`);
  const created = bank.calls.find(c => c.path === '/payments' && c.method === 'POST').body;
  assert.equal(created.billingType, 'PIX');
  assert.equal(created.externalReference, 'appt:p1');
  assert.equal(bank.calls.find(c => c.path === '/customers').body.cpfCnpj, '52998224725');
  assert.equal((await payReq()).body.id, ch.body.id, 'mesma cobrança, sem pedir o CPF de novo');
  assert.equal((await pub('POST', '/api/public/studio-ana/me/pay', { t: token, kind: 'appt', ref: 'p1', what: 'tudo' })).status, 409, 'valor todo desligado');

  // 6) aviso do banco: senha errada não vale; o certo confirma o horário, guarda o pagamento e manda a confirmação
  const hook = (body, tok) => pub('POST', `/api/asaas/webhook/${tid}`, body, { 'asaas-access-token': tok });
  const paid = { event: 'PAYMENT_RECEIVED', payment: { id: ch.body.id, status: 'RECEIVED', value: 999, billingType: 'PIX', paymentDate: d } };
  assert.equal((await hook(paid, 'errada')).status, 401);
  const nMsg = evo.sent.length;
  assert.equal((await hook(paid, wh.body.authToken)).status, 200);
  await hook(paid, wh.body.authToken); // repetido: não paga duas vezes
  await wait();
  const changes = (await call('GET', '/api/changes?since=0')).body.changes;
  const p1 = changes.filter(c => c.id === 'p1').at(-1).data;
  assert.equal(p1.status, 'marcado');
  assert.equal(p1.confirmedBy, 'pagamento');
  assert.deepEqual(p1.payments.map(p => [p.v, p.m, p.via]), [[150, 'pix', 'asaas']], 'valor da cobrança, não o do aviso');
  assert.ok(evo.sent.slice(nMsg).some(m => /está marcado/.test(m.text) && m.number === '5511955554444'), 'confirmação no WhatsApp');
  assert.ok(pushed.some(p => /Sinal pago/.test(p.title)), 'aviso no celular da profissional');
  me = (await pub('GET', `/api/public/studio-ana/me?t=${token}`)).body;
  assert.equal(me.pay.items.length, 0);
  assert.equal(me.upcoming[0].status, 'marcado');

  // 6b) remarcou pelo link e o salão aceitou: o sinal pago vai junto para o horário novo
  await call('PUT', '/api/settings', { booking: { enabled: true, minAdvanceHours: 0 } });
  let nd = addDays(d, 1);
  while (weekday(nd) === 0 || weekday(nd) === 6) nd = addDays(nd, 1);
  const mv = await pub('POST', '/api/public/studio-ana/me/reschedule', { t: token, id: 'p1', date: nd, time: '10:00' });
  assert.equal(mv.status, 200);
  const newId = (await call('GET', '/api/changes?since=0')).body.changes.filter(c => c.data?.replaces === 'p1').at(-1).id;
  await call('POST', `/api/appts/${newId}/decision`, { decision: 'confirm' });
  const after = (await call('GET', '/api/changes?since=0')).body.changes;
  const lastOf = id => after.filter(c => c.id === id).at(-1).data;
  assert.deepEqual(lastOf(newId).payments.map(p => [p.v, p.via]), [[150, 'asaas']], 'pagamento foi para o horário novo');
  assert.deepEqual([lastOf('p1').status, lastOf('p1').payments], ['cancelado', []], 'e saiu do antigo');

  // 7) compras: liga produtos e serviços; parcela vencida + pagar tudo; o sistema confere sozinho no banco
  await call('PUT', '/api/settings', { payments: { products: true, services: true, card: true } });
  const today = nowIn('America/Sao_Paulo').date;
  const plan = { entrada: 0, dates: [addDays(today, -1), addDays(today, 30)] };
  await call('POST', '/api/sync', { changes: [
    { coll: 'sales', id: 's1', data: { clientId: 'c1', product: 'Shampoo', qty: 1, total: 80, date: addDays(today, -31), orderId: 'o1', plan, payments: [] } },
    { coll: 'sales', id: 's2', data: { clientId: 'c1', product: 'Máscara', qty: 1, total: 40, date: addDays(today, -31), orderId: 'o1', plan, payments: [] } },
  ] });
  me = (await pub('GET', `/api/public/studio-ana/me?t=${token}`)).body;
  const order = me.pay.items.find(i => i.kind === 'order');
  assert.deepEqual(order.options.map(o => [o.what, o.value]), [['parcela', 60], ['tudo', 120]]);
  assert.deepEqual(me.pay.items.find(i => i.ref === 'old').options.map(o => [o.what, o.value]), [['tudo', 50]], 'serviço em aberto');
  assert.deepEqual(me.history.purchases.map(p => [p.items, p.total, p.left]), [['Shampoo e Máscara', 120, 120]]);
  const och = (await pub('POST', '/api/public/studio-ana/me/pay', { t: token, kind: 'order', ref: 'o1', what: 'parcela' })).body;
  assert.equal(och.value, 60);
  assert.equal(bank.calls.filter(c => c.path === '/payments' && c.method === 'POST').at(-1).body.billingType, 'UNDEFINED', 'com cartão');
  assert.ok(och.invoiceUrl);
  // outro salão não consegue marcar esta cobrança
  assert.equal(app.payments.settle(och.id, {}, 'outro-salao'), false);
  bank.payments[och.id].status = 'RECEIVED';
  bank.payments[och.id].billingType = 'CREDIT_CARD';
  const status = (await pub('GET', `/api/public/studio-ana/me/pay/${och.id}?t=${token}`)).body;
  assert.equal(status.status, 'open', 'conferiu há pouco (ao criar): ainda não pergunta ao banco');
  app.db.prepare('UPDATE charges SET checked_at = 0').run();
  assert.equal((await pub('GET', `/api/public/studio-ana/me/pay/${och.id}?t=${token}`)).body.status, 'paid');
  const sales = (await call('GET', '/api/changes?since=0')).body.changes.filter(c => c.coll === 'sales');
  const last = id => sales.filter(c => c.id === id).at(-1).data;
  assert.deepEqual([last('s1').payments.map(p => [p.v, p.m]), last('s2').payments], [[[60, 'cartao']], []]);
  me = (await pub('GET', `/api/public/studio-ana/me?t=${token}`)).body;
  assert.equal(me.pay.items.find(i => i.kind === 'order').options[0].label.startsWith('Adiantar'), true, 'próxima parcela ainda não venceu');

  // 8) desliga: apaga o webhook no Asaas e some da página da cliente
  await call('DELETE', '/api/asaas');
  assert.ok(bank.calls.some(c => c.method === 'DELETE' && c.path === '/webhooks/wh1'));
  assert.equal((await call('GET', '/api/asaas')).body.connected, false);
  assert.equal((await pub('GET', `/api/public/studio-ana/me?t=${token}`)).body.pay.items.length, 0);
  assert.equal((await hook(paid, wh.body.authToken)).status, 401, 'webhook antigo não vale mais');
  await app.close();
});
