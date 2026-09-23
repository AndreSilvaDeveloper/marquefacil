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

test('WhatsApp: conectar, pedido pelo link, confirmar/recusar, agendamento no app, lembrete', async () => {
  const evo = fakeEvolution();
  const pushed = [];
  const app = buildApp({
    evolution: { url: 'http://evo.test', apikey: 'k', fetchImpl: evo.fetchImpl },
    publicUrl: 'https://maquefacil.com.br',
    pushSender: async (sub, body) => { pushed.push({ sub, ...JSON.parse(body) }); },
  });
  const call = await salon(app);
  const pub = client(app);
  const wait = () => new Promise(r => setTimeout(r, 50));

  assert.equal((await call('GET', '/api/whatsapp/status')).body.state, 'off');
  const c = await call('POST', '/api/whatsapp/connect');
  assert.equal(c.body.qr, 'data:image/png;base64,QR');
  const pc = await call('POST', '/api/whatsapp/connect', { phone: '(11) 90000-0000' });
  assert.equal(pc.body.pairingCode, 'ABCD1234', 'código para conectar pelo número');
  evo.instances[Object.keys(evo.instances)[0]] = 'open'; // conectou
  const st = await call('GET', '/api/whatsapp/status');
  assert.deepEqual([st.body.state, st.body.number], ['open', '5511900000000']);
  await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://push.test/1', keys: { p256dh: 'a', auth: 'b' } } });

  // 1) Pedido pelo link: fica pendente, profissional é avisada (push + WhatsApp), cliente ainda não recebe nada
  const date = nextWeekday(3);
  const b = await pub('POST', '/api/public/studio-ana/book', { date, time: '10:00', serviceId: 's1', name: 'Joana Lima', phone: '(11) 98888-7777' });
  assert.equal(b.body.pending, true);
  await wait();
  assert.equal(pushed.length, 1);
  assert.match(pushed[0].title, /Novo pedido/);
  assert.match(pushed[0].body, /Joana Lima/);
  assert.ok(!evo.sent.some(m => m.number === '5511988887777'), 'cliente só recebe depois de confirmar');
  assert.ok(evo.sent.some(m => m.number === '5511900000000' && /Novo pedido/.test(m.text)), 'aviso para a profissional');
  const busy = (await pub('GET', `/api/public/studio-ana/slots?date=${date}&service=s1`)).body.slots;
  assert.ok(!busy.includes('10:00'), 'pedido pendente já segura o horário');

  // 2) Confirma pelo botão da notificação → cliente recebe a confirmação
  const apptId = pushed[0].apptId;
  const d = await call('POST', `/api/appts/${apptId}/decision`, { decision: 'confirm' });
  assert.equal(d.body.status, 'marcado');
  await wait();
  const conf = evo.sent.find(m => m.number === '5511988887777');
  assert.match(conf.text, /Olá, Joana! ✅/);
  assert.match(conf.text, /Escova/);
  assert.equal((await call('POST', `/api/appts/${apptId}/decision`, { decision: 'confirm' })).body.already, true);

  // 3) Outro pedido, recusado pelo app (sincronização) → cliente recebe o aviso com o link
  await pub('POST', '/api/public/studio-ana/book', { date, time: '14:00', name: 'Bia', phone: '21977776666' });
  await wait();
  const pend = (await call('GET', '/api/changes?since=0')).body.changes.find(x => x.coll === 'appts' && x.data.time === '14:00');
  assert.equal(pend.data.status, 'pendente');
  await call('POST', '/api/sync', { changes: [{ coll: 'appts', id: pend.id, data: { ...pend.data, status: 'cancelado' } }] });
  await wait();
  const dec = evo.sent.find(m => m.number === '5521977776666');
  assert.match(dec.text, /Infelizmente/);
  assert.match(dec.text, /https:\/\/maquefacil\.com\.br\/studio-ana/);

  // 4) Profissional agenda no app com telefone → confirmação sai sozinha (ligada por padrão)
  await call('POST', '/api/sync', { changes: [
    { coll: 'clients', id: 'cm', data: { name: 'Carla Dias', phone: '(31) 95555-4444' } },
    { coll: 'appts', id: 'm1', data: { clientId: 'cm', date, time: '16:00', status: 'marcado', service: 'Corte', createdAt: Date.now() } },
  ] });
  await wait();
  assert.ok(evo.sent.some(m => m.number === '5531955554444' && /✅/.test(m.text) && /16:00/.test(m.text)));
  // sem telefone: não manda nada (fica registrado como "sem telefone")
  await call('POST', '/api/sync', { changes: [
    { coll: 'clients', id: 'cx', data: { name: 'Sem Fone' } },
    { coll: 'appts', id: 'm2', data: { clientId: 'cx', date, time: '17:00', status: 'marcado', createdAt: Date.now() } },
  ] });
  await wait();
  const msgs = (await call('GET', '/api/messages')).body;
  assert.ok(msgs.some(x => x.apptId === 'm2' && x.status === 'skipped'));

  // 5) Lembrete 24h antes, uma vez só; pedido pendente não ganha lembrete
  const start = Date.parse(`${date}T15:00:00-03:00`);
  await call('POST', '/api/sync', { changes: [
    { coll: 'appts', id: 'r1', data: { clientId: 'cm', date, time: '15:00', status: 'marcado', createdAt: start - 5 * 86400e3 } },
  ] });
  await pub('POST', '/api/public/studio-ana/book', { date, time: '09:00', name: 'Pendente', phone: '11966665555' });
  const m = app.messenger;
  assert.equal(await m.runReminders(start - 30 * 3600e3), 0, 'ainda cedo');
  const before = evo.sent.length;
  await m.runReminders(start - 23 * 3600e3);
  const reminders = evo.sent.slice(before).filter(x => /Passando para lembrar/.test(x.text));
  assert.ok(reminders.some(x => x.number === '5531955554444'));
  assert.ok(!reminders.some(x => x.number === '5511966665555'), 'pendente não recebe lembrete');
  const n2 = evo.sent.length;
  await m.runReminders(start - 22 * 3600e3);
  assert.equal(evo.sent.length, n2, 'não repete o lembrete');

  await call('POST', '/api/whatsapp/disconnect');
  assert.equal((await call('GET', '/api/whatsapp/status')).body.state, 'off');
  await app.close();
});

test('push: inscrever, testar, aparelho que sumiu é removido', async () => {
  const sent = [];
  const app = buildApp({
    pushSender: async sub => {
      if (sub.endpoint.endsWith('/sumiu')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
      sent.push(sub.endpoint);
    },
  });
  const call = await salon(app);
  assert.ok((await call('GET', '/api/push/key')).body.key.length > 40);
  assert.equal((await call('POST', '/api/push/test')).status, 400, 'sem aparelho');
  assert.equal((await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'http://inseguro', keys: {} } })).status, 400);
  await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://push.test/ok', keys: { p256dh: 'a', auth: 'b' } } });
  await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://push.test/sumiu', keys: { p256dh: 'a', auth: 'b' } } });
  assert.equal((await call('POST', '/api/push/test')).body.devices, 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM push_subs').get().n, 1, 'aparelho que sumiu foi removido');
  const k1 = (await call('GET', '/api/push/key')).body.key;
  assert.equal(k1, app.push.publicKey, 'chave fica a mesma');
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

test('marca por domínio: Studio Kadosh x Marque Fácil', async () => {
  const publicDir = new URL('../../public/', import.meta.url).pathname;
  const app = buildApp({ publicDir });
  await salon(app);
  const get = async (url, host) => { const r = await app.inject({ method: 'GET', url, headers: { host } }); return { status: r.statusCode, body: r.body, type: r.headers['content-type'] }; };

  const k = await get('/', 'studiokadosh.com');
  assert.match(k.body, /<title>Studio Kadosh<\/title>/);
  assert.match(k.body, /window\.BRAND = \{"name":"Studio Kadosh"/);
  assert.match(k.body, /\/brands\/kadosh\/logo\.png/);
  assert.match((await get('/', 'www.studiokadosh.com')).body, /Studio Kadosh/, 'www também');

  const m = await get('/', 'maquefacil.com.br');
  assert.match(m.body, /<title>Marque Fácil<\/title>/);
  assert.doesNotMatch(m.body, /Kadosh/);

  const mk = JSON.parse((await get('/manifest.json', 'studiokadosh.com')).body);
  assert.equal(mk.name, 'Studio Kadosh');
  assert.equal(JSON.parse((await get('/manifest.json', 'maquefacil.com.br')).body).name, 'Marque Fácil');

  const iconK = await get('/icon-192.png', 'studiokadosh.com');
  const iconM = await get('/icon-192.png', 'maquefacil.com.br');
  assert.equal(iconK.status, 200);
  assert.notEqual(iconK.body.length, iconM.body.length, 'ícone diferente em cada domínio');
  assert.equal((await get('/brands/kadosh/logo.png', 'studiokadosh.com')).status, 200);

  const link = await get('/studio-ana', 'studiokadosh.com');
  assert.match(link.body, /window\.BRAND = \{"name":"Studio Kadosh"/, 'página das clientes também com a marca');
  await app.close();
});
