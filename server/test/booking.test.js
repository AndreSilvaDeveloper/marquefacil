import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { computeSlots } from '../src/booking.js';
import { renderTemplate } from '../src/whatsapp.js';
import { DEFAULTS } from '../src/settings.js';
import { nowIn, addDays, weekday } from '../src/time.js';

function client(app) {
  let cookie = '';
  return async (method, url, body) => {
    const res = await app.inject({ method, url, payload: body, headers: { cookie } });
    const set = res.headers['set-cookie'];
    if (set) cookie = [].concat(set).map(c => c.split(';')[0]).join('; ');
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
}

// Evolution de mentira: guarda o que foi enviado
function fakeEvolution() {
  const sent = [], instances = {};
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (url, opts) => {
    const u = new URL(url), body = opts.body ? JSON.parse(opts.body) : null;
    const name = decodeURIComponent(u.pathname.split('/').pop());
    if (u.pathname === '/instance/create') { instances[body.instanceName] = 'connecting'; return json(201, { qrcode: { base64: 'data:image/png;base64,QR' } }); }
    if (u.pathname.startsWith('/instance/connectionState/')) return instances[name] ? json(200, { instance: { state: instances[name] } }) : json(404, { message: ['not found'] });
    if (u.pathname.startsWith('/instance/connect/')) return json(200, { base64: 'data:image/png;base64,QR2', pairingCode: u.searchParams.get('number') ? 'ABCD1234' : undefined });
    if (u.pathname === '/instance/fetchInstances') return json(200, [{ ownerJid: '5511900000000@s.whatsapp.net' }]);
    if (u.pathname.startsWith('/message/sendText/')) { sent.push({ instance: name, ...body }); return json(201, {}); }
    if (u.pathname.startsWith('/instance/logout/') || u.pathname.startsWith('/instance/delete/')) { delete instances[name]; return json(200, {}); }
    return json(404, {});
  };
  return { sent, instances, fetchImpl };
}

// Próxima data (a partir de amanhã) que cai no dia da semana pedido
function nextWeekday(wd) {
  let d = addDays(nowIn('America/Sao_Paulo').date, 1);
  while (weekday(d) !== wd) d = addDays(d, 1);
  return d;
}

async function salon(app, extra = {}) {
  const call = client(app);
  await call('POST', '/api/signup', { salonName: 'Studio Ana', name: 'Ana', email: 'ana@x.com', password: 'segredo1' });
  await call('PUT', '/api/settings', { booking: { enabled: true, ...extra } });
  await call('POST', '/api/sync', { changes: [
    { coll: 'services', id: 's1', data: { name: 'Escova', duration: 60, price: 50 } },
    { coll: 'services', id: 's2', data: { name: 'Só no salão', duration: 30, online: false } },
  ] });
  return call;
}

test('horários livres: expediente, almoço, ocupados, antecedência', () => {
  const booking = { ...structuredClone(DEFAULTS.booking), enabled: true, lunch: ['12:00', '13:00'] };
  const date = '2026-09-22'; // terça: 09:00–18:00
  const appts = [{ date, time: '10:00', duration: 60, status: 'marcado' }, { date, time: '15:00', status: 'cancelado' }];
  const now = { date: '2026-09-21', minutes: 0 };
  const slots = computeSlots({ booking, appts, date, duration: 60, now });
  assert.ok(slots.includes('09:00'));
  assert.ok(!slots.includes('09:30'), '09:30–10:30 bate com 10:00');
  assert.ok(!slots.includes('10:00'));
  assert.ok(slots.includes('11:00'));
  assert.ok(!slots.includes('11:30') && !slots.includes('12:00'), 'almoço');
  assert.ok(slots.includes('15:00'), 'cancelado não ocupa');
  assert.equal(slots.at(-1), '17:00', 'último que termina até 18:00');

  const sameDay = computeSlots({ booking, appts, date, duration: 60, now: { date, minutes: 13 * 60 } });
  assert.equal(sameDay[0], '15:00', 'hoje: 2h de antecedência a partir das 13:00');
  assert.deepEqual(computeSlots({ booking, appts, date: '2026-09-27', duration: 60, now }), [], 'domingo fechado');
  assert.deepEqual(computeSlots({ booking: { ...booking, closedDates: [date] }, appts, date, duration: 60, now }), [], 'folga');
});

test('mensagem: troca os campos e tira linha vazia', () => {
  const txt = renderTemplate('Olá, {nome}!\n💇 {servico}\n📅 {dia} às {hora}', { nome: 'Maria', servico: '', dia: 'sexta', hora: '14:00' });
  assert.equal(txt, 'Olá, Maria!\n📅 sexta às 14:00');
});

test('configurações: valida e guarda', async () => {
  const app = buildApp();
  const call = await salon(app);
  const bad = await call('PUT', '/api/settings', { booking: { days: { 1: ['18:00', '09:00'] } } });
  assert.equal(bad.status, 400);
  const ok = await call('PUT', '/api/settings', { booking: { days: { 0: ['10:00', '14:00'] }, interval: 15 }, whatsapp: { instance: 'hack' } });
  assert.deepEqual(ok.body.booking.days['0'], ['10:00', '14:00']);
  assert.equal(ok.body.booking.interval, 15);
  assert.equal(ok.body.whatsapp.instance, null, 'instância não muda por aqui');
  assert.equal(ok.body.slug, 'studio-ana');
  await app.close();
});

test('link público: serviços, dias, horários e agendar', async () => {
  const app = buildApp();
  const call = await salon(app);
  const pub = client(app);

  const info = await pub('GET', '/api/public/studio-ana');
  assert.equal(info.body.name, 'Studio Ana');
  assert.deepEqual(info.body.services.map(s => s.name), ['Escova'], 'serviço fora do link não aparece');
  assert.equal((await pub('GET', '/api/public/nao-existe')).status, 404);

  const days = (await pub('GET', '/api/public/studio-ana/days?service=s1')).body.days;
  const sunday = days.find(d => weekday(d.date) === 0);
  assert.equal(sunday.free, 0);

  const date = nextWeekday(2);
  const slots = (await pub('GET', `/api/public/studio-ana/slots?date=${date}&service=s1`)).body.slots;
  assert.ok(slots.includes('09:00'));

  const noPhone = await pub('POST', '/api/public/studio-ana/book', { date, time: '09:00', serviceId: 's1', name: 'Joana', phone: '123' });
  assert.equal(noPhone.status, 400);

  const b = await pub('POST', '/api/public/studio-ana/book', { date, time: '09:00', serviceId: 's1', name: 'Joana Lima', phone: '(11) 98888-7777' });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.service, 'Escova');

  const again = await pub('POST', '/api/public/studio-ana/book', { date, time: '09:30', serviceId: 's1', name: 'Outra', phone: '11977776666' });
  assert.equal(again.status, 409, 'horário ocupado pela Joana (09:00–10:00)');

  // A profissional recebe na sincronização
  const ch = (await call('GET', '/api/changes?since=0')).body.changes;
  const appt = ch.find(c => c.coll === 'appts');
  const cli = ch.find(c => c.coll === 'clients');
  assert.equal(appt.data.source, 'online');
  assert.equal(appt.data.duration, 60);
  assert.equal(appt.data.price, 50);
  assert.equal(cli.data.name, 'Joana Lima');

  // Mesma cliente (mesmo telefone) não é cadastrada de novo
  await pub('POST', '/api/public/studio-ana/book', { date, time: '14:00', name: 'Joana', phone: '11 98888 7777' });
  const clients = (await call('GET', '/api/changes?since=0')).body.changes.filter(c => c.coll === 'clients');
  assert.equal(clients.length, 1);

  // Robô (campo escondido preenchido) e link fechado
  assert.equal((await pub('POST', '/api/public/studio-ana/book', { date, time: '16:00', name: 'Bot', phone: '11977776666', website: 'x' })).status, 400);
  await call('PUT', '/api/settings', { booking: { enabled: false } });
  assert.equal((await pub('GET', `/api/public/studio-ana/slots?date=${date}`)).status, 403);
  await app.close();
});

test('WhatsApp: conectar, confirmação, aviso, lembrete sem repetir', async () => {
  const evo = fakeEvolution();
  const app = buildApp({ evolution: { url: 'http://evo.test', apikey: 'k', fetchImpl: evo.fetchImpl } });
  const call = await salon(app);
  const pub = client(app);

  assert.equal((await call('GET', '/api/whatsapp/status')).body.state, 'off');
  const c = await call('POST', '/api/whatsapp/connect');
  assert.equal(c.body.qr, 'data:image/png;base64,QR');
  const pc = await call('POST', '/api/whatsapp/connect', { phone: '(11) 90000-0000' });
  assert.equal(pc.body.pairingCode, 'ABCD1234', 'código para conectar pelo número');
  const inst = Object.keys(evo.instances)[0];
  evo.instances[inst] = 'open'; // escaneou o QR
  const st = await call('GET', '/api/whatsapp/status');
  assert.deepEqual([st.body.state, st.body.number], ['open', '5511900000000']);

  // Agendou pelo link: confirmação para a cliente + aviso para a profissional
  const date = nextWeekday(3);
  await pub('POST', '/api/public/studio-ana/book', { date, time: '10:00', serviceId: 's1', name: 'Joana Lima', phone: '(11) 98888-7777' });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(evo.sent.length, 2);
  const toClient = evo.sent.find(m => m.number === '5511988887777');
  const toOwner = evo.sent.find(m => m.number === '5511900000000');
  assert.match(toClient.text, /Olá, Joana! ✅/);
  assert.match(toClient.text, /Escova/);
  assert.match(toOwner.text, /Novo agendamento pelo link/);

  // Lembrete: horário marcado no app com antecedência, 24h antes
  const cid = (await call('GET', '/api/changes?since=0')).body.changes.find(x => x.coll === 'clients').id;
  const start = Date.parse(`${date}T15:00:00-03:00`); // 15:00 em São Paulo
  await call('POST', '/api/sync', { changes: [{ coll: 'appts', id: 'm1', data: { clientId: cid, date, time: '15:00', status: 'marcado', createdAt: start - 5 * 86400e3 } }] });
  assert.equal(evo.sent.length, 2, 'confirmação de agendamento manual vem desligada');
  const m = app.messenger;
  assert.equal(await m.runReminders(start - 30 * 3600e3), 0, 'ainda cedo');
  const n = await m.runReminders(start - 23 * 3600e3);
  assert.ok(n >= 1);
  assert.ok(evo.sent.some(x => /Passando para lembrar/.test(x.text)));
  const before = evo.sent.length;
  await m.runReminders(start - 22 * 3600e3);
  assert.equal(evo.sent.length, before, 'não repete o lembrete');

  // Histórico
  const msgs = (await call('GET', '/api/messages')).body;
  assert.ok(msgs.some(x => x.kind === 'reminder' && x.status === 'sent'));

  // Confirmação de agendamento manual, quando ligada
  await call('PUT', '/api/settings', { whatsapp: { confirmManual: true } });
  await call('POST', '/api/sync', { changes: [{ coll: 'appts', id: 'm2', data: { clientId: cid, date, time: '17:00', status: 'marcado', createdAt: Date.now() } }] });
  await new Promise(r => setTimeout(r, 50));
  assert.ok(evo.sent.some(x => /17:00/.test(x.text) && /✅/.test(x.text)));

  await call('POST', '/api/whatsapp/disconnect');
  assert.equal((await call('GET', '/api/whatsapp/status')).body.state, 'off');
  await app.close();
});

test('WhatsApp sem Evolution configurada', async () => {
  const app = buildApp();
  const call = await salon(app);
  assert.equal((await call('POST', '/api/whatsapp/connect')).status, 503);
  assert.equal((await call('GET', '/api/settings')).body.whatsappAvailable, false);
  await app.close();
});

test('páginas: app na raiz, link do salão, arquivos e link inexistente', async () => {
  const publicDir = new URL('../../public/', import.meta.url).pathname;
  const app = buildApp({ publicDir });
  await salon(app);
  const get = async url => { const r = await app.inject({ method: 'GET', url }); return { status: r.statusCode, body: r.body }; };
  const root = await get('/');
  assert.equal(root.status, 200);
  assert.match(root.body, /<script src="app\.js">/, 'raiz abre o app da profissional');
  const link = await get('/studio-ana');
  assert.equal(link.status, 200);
  assert.match(link.body, /agendar\.js/, 'link abre a página de agendamento');
  assert.equal((await get('/app.js')).status, 200);
  assert.equal((await get('/style.css')).status, 200);
  assert.equal((await get('/nao-existe')).status, 404);
  await app.close();
});
