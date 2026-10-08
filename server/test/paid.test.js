import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { nowIn, addDays } from '../src/time.js';

function client(app) {
  let cookie = '';
  return async (method, url, body) => {
    const res = await app.inject({ method, url, payload: body, headers: { cookie } });
    const set = res.headers['set-cookie'];
    if (set) cookie = [].concat(set).map(c => c.split(';')[0]).join('; ');
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
}
function fakeEvolution() {
  const sent = [], instances = {};
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (url, opts) => {
    const u = new URL(url), body = opts.body ? JSON.parse(opts.body) : null;
    const name = decodeURIComponent(u.pathname.split('/').pop());
    if (u.pathname === '/instance/create') { instances[body.instanceName] = 'connecting'; return json(201, {}); }
    if (u.pathname.startsWith('/instance/connectionState/')) return json(200, { instance: { state: instances[name] || 'close' } });
    if (u.pathname.startsWith('/message/sendText/')) { sent.push(body); return json(201, {}); }
    return json(200, {});
  };
  return { sent, instances, fetchImpl };
}
const wait = (ms = 60) => new Promise(r => setTimeout(r, ms));

test('recibo de pagamento: opcional, uma vez por pagamento, só pagamento recente, compra junta numa mensagem', async () => {
  const evo = fakeEvolution();
  const app = buildApp({ evolution: { url: 'http://evo.test', apikey: 'k', fetchImpl: evo.fetchImpl }, saleDelay: 0 });
  const call = client(app);
  await call('POST', '/api/signup', { salonName: 'Studio Ana', name: 'Ana', email: 'ana@x.com', password: 'segredo1' });
  await call('POST', '/api/whatsapp/connect');
  evo.instances[Object.keys(evo.instances)[0]] = 'open';
  const T = nowIn('America/Sao_Paulo').date, past = addDays(T, -1);
  const appt = { clientId: 'c1', date: past, time: '10:00', service: 'Escova', price: 100, status: 'feito', payments: [] };
  await call('POST', '/api/sync', { changes: [
    { coll: 'clients', id: 'c1', data: { name: 'Bia Lima', phone: '11955554444' } },
    { coll: 'appts', id: 'a1', data: appt },
  ] });
  const sync = changes => call('POST', '/api/sync', { changes });
  const pay = (pays) => ({ coll: 'appts', id: 'a1', data: { ...appt, payments: pays } });

  // desligado (padrão): nada
  assert.equal((await call('GET', '/api/settings')).body.whatsapp.paidMessage, false);
  await sync([pay([{ v: 40, m: 'pix', d: T }])]);
  await wait();
  assert.equal(evo.sent.length, 0);

  // só serviços ligado
  await call('PUT', '/api/settings', { whatsapp: { paidMessage: true, paidMessageSales: false } });
  await sync([pay([{ v: 40, m: 'pix', d: T }, { v: 60, m: 'dinheiro', d: T }])]);
  await wait();
  assert.equal(evo.sent.length, 1);
  const m = evo.sent[0];
  assert.equal(m.number, '5511955554444');
  assert.match(m.text, /Recebemos o seu pagamento no \*Studio Ana\*/);
  assert.match(m.text, /💰 R\$\s?60,00/);
  assert.match(m.text, /💳 Dinheiro/);
  assert.match(m.text, /💇 Escova/);
  assert.match(m.text, /✅ Está tudo pago/);
  await sync([pay([{ v: 40, m: 'pix', d: T }, { v: 60, m: 'dinheiro', d: T }])]); // mesmo de novo
  await wait();
  assert.equal(evo.sent.length, 1, 'não repete');

  // pagamento com data antiga (acertando o caixa): não manda
  const a2 = { clientId: 'c1', date: addDays(T, -30), time: '10:00', service: 'Corte', price: 50, status: 'feito', payments: [] };
  await sync([{ coll: 'appts', id: 'a2', data: a2 }]);
  await sync([{ coll: 'appts', id: 'a2', data: { ...a2, payments: [{ v: 50, m: 'pix', d: addDays(T, -30) }] } }]);
  await wait();
  assert.equal(evo.sent.length, 1);

  // compra a prazo: dois produtos pagos de uma vez → uma mensagem com o total e o que falta
  const plan = { entrada: 0, dates: [T, addDays(T, 30)] };
  const s1 = { clientId: 'c1', product: 'Shampoo', qty: 1, total: 80, date: past, orderId: 'o1', plan, payments: [], createdAt: Date.now() - 5 * 86400e3 };
  const s2 = { ...s1, product: 'Máscara', total: 40 };
  await sync([{ coll: 'sales', id: 's1', data: s1 }, { coll: 'sales', id: 's2', data: s2 }]);
  await wait();
  const n = evo.sent.length;
  await sync([{ coll: 'sales', id: 's1', data: { ...s1, payments: [{ v: 20, m: 'pix', d: T }] } }]);
  await wait();
  assert.equal(evo.sent.length, n, 'compras desligado: sem recibo');
  await call('PUT', '/api/settings', { whatsapp: { paidMessageSales: true } });
  await sync([
    { coll: 'sales', id: 's1', data: { ...s1, payments: [{ v: 20, m: 'pix', d: T }, { v: 30, m: 'cartao', d: T }] } },
    { coll: 'sales', id: 's2', data: { ...s2, payments: [{ v: 10, m: 'cartao', d: T }] } },
  ]);
  await wait();
  const got = evo.sent.slice(n);
  assert.equal(got.length, 1);
  assert.match(got[0].text, /💰 R\$\s?40,00/, 'só o que entrou agora (os 20 já tinham ido)');
  assert.match(got[0].text, /🛍️ Shampoo e Máscara/);
  assert.match(got[0].text, /Falta: R\$\s?60,00 \(próxima: R\$\s?60,00 em /);
  // só compras: o recibo de serviço para
  await call('PUT', '/api/settings', { whatsapp: { paidMessage: false } });
  const a3 = { clientId: 'c1', date: past, time: '15:00', service: 'Hidratação', price: 70, status: 'feito', payments: [] };
  await sync([{ coll: 'appts', id: 'a3', data: a3 }]);
  const n2 = evo.sent.length;
  await sync([{ coll: 'appts', id: 'a3', data: { ...a3, payments: [{ v: 70, m: 'pix', d: T }] } }]);
  await wait();
  assert.equal(evo.sent.length, n2);
  await app.close();
});

test('recibo: quem tinha a opção única ligada continua com serviços e compras', async () => {
  const { readSettings } = await import('../src/settings.js');
  const s = readSettings(JSON.stringify({ whatsapp: { paidMessage: true } }));
  assert.deepEqual([s.whatsapp.paidMessage, s.whatsapp.paidMessageSales], [true, true]);
  const s2 = readSettings(JSON.stringify({ whatsapp: { paidMessage: true, paidMessageSales: false } }));
  assert.deepEqual([s2.whatsapp.paidMessage, s2.whatsapp.paidMessageSales], [true, false]);
  const s3 = readSettings('{}');
  assert.deepEqual([s3.whatsapp.paidMessage, s3.whatsapp.paidMessageSales], [false, false]);
});
