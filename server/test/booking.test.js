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
  const sent = [], instances = {}, calls = [];
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (url, opts) => {
    const u = new URL(url), body = opts.body ? JSON.parse(opts.body) : null;
    const name = decodeURIComponent(u.pathname.split('/').pop());
    if (u.pathname === '/instance/create') { instances[body.instanceName] = 'connecting'; calls.push(['create', body.instanceName, body]); return json(201, { qrcode: { base64: 'data:image/png;base64,QR' } }); }
    if (u.pathname.startsWith('/instance/connectionState/')) return instances[name] ? json(200, { instance: { state: instances[name] } }) : json(404, { message: ['not found'] });
    if (u.pathname.startsWith('/instance/connect/')) return json(200, { base64: 'data:image/png;base64,QR2', pairingCode: u.searchParams.get('number') ? 'ABCD1234' : undefined });
    if (u.pathname === '/instance/fetchInstances') return json(200, [{ ownerJid: '5511900000000@s.whatsapp.net' }]);
    if (u.pathname.startsWith('/message/sendText/')) { sent.push({ instance: name, ...body }); return json(201, {}); }
    if (u.pathname.startsWith('/settings/set/')) { calls.push(['settings', name, body]); return json(201, {}); }
    if (u.pathname.startsWith('/instance/setPresence/')) { calls.push(['presence', name, body.presence]); return json(201, {}); }
    if (u.pathname.startsWith('/instance/logout/') || u.pathname.startsWith('/instance/delete/')) { delete instances[name]; return json(200, {}); }
    return json(404, {});
  };
  return { sent, instances, calls, fetchImpl };
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
  assert.deepEqual(Object.keys(info.body.services[0]).sort(), ['description', 'id', 'name'], 'cliente não vê valor nem tempo');
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
  assert.equal(appt.data.price, null, 'valor não vem do serviço: é por atendimento');
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
  const d = await call('POST', `/api/appts/${apptId}/decision`, { decision: 'confirm', price: 85 });
  assert.equal(d.body.status, 'marcado');
  await wait();
  const conf = evo.sent.find(m => m.number === '5511988887777');
  assert.match(conf.text, /Olá, Joana! ✅/);
  assert.match(conf.text, /Escova/);
  assert.match(conf.text, /Valor: R\$\s?85,00/, 'valor colocado ao confirmar vai na mensagem');
  assert.equal((await call('POST', `/api/appts/${apptId}/decision`, { decision: 'confirm' })).body.already, true);

  // 3) Outro pedido, recusado pelo app (sincronização) → cliente recebe o aviso com o link
  await pub('POST', '/api/public/studio-ana/book', { date, time: '14:00', name: 'Bia', phone: '21977776666' });
  await wait();
  const pend = (await call('GET', '/api/changes?since=0')).body.changes.find(x => x.coll === 'appts' && x.data.time === '14:00');
  assert.equal(pend.data.status, 'pendente');
  await call('POST', '/api/sync', { changes: [{ coll: 'appts', id: pend.id, data: { ...pend.data, status: 'cancelado' } }] });
  assert.ok(!evo.sent.some(m => /Valor:/.test(m.text) && m.number === '5521977776666'));
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

  // 4b) Duas clientes com os horários trocados: a profissional corrige e cada uma recebe o horário certo
  await call('POST', '/api/sync', { changes: [
    { coll: 'clients', id: 'cd', data: { name: 'Deleia Souza', phone: '(41) 94444-3333' } },
    { coll: 'appts', id: 'm3', data: { clientId: 'cd', date, time: '16:30', status: 'marcado', service: 'Corte', createdAt: Date.now() } },
  ] });
  await wait();
  const all = (await call('GET', '/api/changes?since=0')).body.changes;
  const m1 = all.find(x => x.id === 'm1').data, m3 = all.find(x => x.id === 'm3').data;
  const nSwap = evo.sent.length;
  const swap = [{ coll: 'appts', id: 'm1', data: { ...m1, time: '16:30' } }, { coll: 'appts', id: 'm3', data: { ...m3, time: '16:00' } }];
  await call('POST', '/api/sync', { changes: swap });
  await wait();
  const changed = evo.sent.slice(nSwap);
  assert.equal(changed.length, 2);
  assert.ok(changed.some(x => x.number === '5531955554444' && /mudou/.test(x.text) && /16:30/.test(x.text)), 'Carla: novo horário 16:30');
  assert.ok(changed.some(x => x.number === '5541944443333' && /mudou/.test(x.text) && /16:00/.test(x.text)), 'Deleia: novo horário 16:00');
  await call('POST', '/api/sync', { changes: swap }); // mesma coisa de novo: não repete
  // trocou a cliente do horário: a nova cliente recebe a confirmação
  await call('POST', '/api/sync', { changes: [{ coll: 'appts', id: 'm3', data: { ...m3, time: '16:00', clientId: 'cm' } }] });
  await wait();
  assert.equal(evo.sent.length, nSwap + 3);
  assert.ok(/✅/.test(evo.sent.at(-1).text) && evo.sent.at(-1).number === '5531955554444');
  await call('POST', '/api/sync', { changes: [ // tira da frente para o teste do lembrete
    { coll: 'appts', id: 'm1', data: { ...m1, time: '16:30', status: 'cancelado' } },
    { coll: 'appts', id: 'm3', data: { ...m3, time: '16:00', clientId: 'cm', status: 'cancelado' } },
  ] });

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

test('cliente fixa: só a 1ª data recebe confirmação; despesas sincronizam', async () => {
  const evo = fakeEvolution();
  const app = buildApp({ evolution: { url: 'http://evo.test', apikey: 'k', fetchImpl: evo.fetchImpl } });
  const call = await salon(app);
  await call('POST', '/api/whatsapp/connect');
  evo.instances[Object.keys(evo.instances)[0]] = 'open';
  const d = nextWeekday(4);
  const series = [0, 1, 2, 3].map(i => ({ coll: 'appts', id: 'f' + i, data: {
    clientId: 'cf', date: addDays(d, 7 * i), time: '10:00', status: 'marcado', seriesId: 'S1', seriesIndex: i, seriesEvery: 7, createdAt: Date.now(),
  } }));
  await call('POST', '/api/sync', { changes: [{ coll: 'clients', id: 'cf', data: { name: 'Fixa', phone: '11955554444' } }, ...series] });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(evo.sent.filter(m => m.number === '5511955554444').length, 1, 'uma confirmação só');

  const r = await call('POST', '/api/sync', { changes: [{ coll: 'expenses', id: 'e1', data: { amount: 120, cat: 'Aluguel', date: d } }] });
  assert.equal(r.status, 200);
  assert.ok((await call('GET', '/api/changes?since=0')).body.changes.some(c => c.coll === 'expenses'));
  await app.close();
});

test('link: cliente escreve um serviço que não está na lista', async () => {
  const app = buildApp();
  const call = await salon(app);
  const pub = client(app);
  const date = nextWeekday(5);
  const r = await pub('POST', '/api/public/studio-ana/book', { date, time: '11:00', name: 'Rita', phone: '11933332222', serviceText: '  Luzes   e corte  ' });
  assert.equal(r.status, 200);
  assert.equal(r.body.service, 'Luzes e corte');
  const a = (await call('GET', '/api/changes?since=0')).body.changes.find(c => c.coll === 'appts').data;
  assert.equal(a.service, 'Luzes e corte');
  assert.equal(a.serviceCustom, true);
  assert.equal(a.duration, 60, 'usa o tempo padrão');
  assert.equal(a.price, null);
  await app.close();
});

test('confirmar com "avaliar na hora": mensagem avisa; sem valor, linha some', async () => {
  const evo = fakeEvolution();
  const app = buildApp({ evolution: { url: 'http://evo.test', apikey: 'k', fetchImpl: evo.fetchImpl } });
  const call = await salon(app);
  const pub = client(app);
  await call('POST', '/api/whatsapp/connect');
  evo.instances[Object.keys(evo.instances)[0]] = 'open';
  const date = nextWeekday(2);
  const ids = [];
  for (const [time, phone] of [['09:00', '11911111111'], ['11:00', '11922222222']]) {
    const r = await pub('POST', '/api/public/studio-ana/book', { date, time, name: 'Cliente Teste', phone, serviceId: 's1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  for (const c of (await call('GET', '/api/changes?since=0')).body.changes) if (c.coll === 'appts') ids.push(c);
  const [a1, a2] = ids.sort((x, y) => x.data.time.localeCompare(y.data.time));
  await call('POST', `/api/appts/${a1.id}/decision`, { decision: 'confirm', priceLater: true });
  await call('POST', `/api/appts/${a2.id}/decision`, { decision: 'confirm' });
  await new Promise(r => setTimeout(r, 50));
  assert.match(evo.sent.find(m => m.number === '5511911111111').text, /Valor: avaliado na hora do atendimento/);
  assert.doesNotMatch(evo.sent.find(m => m.number === '5511922222222').text, /Valor/, 'sem valor: linha some');
  await app.close();
});

test('lembrete livre: 1 hora antes, 30 minutos, e configuração antiga em horas', async () => {
  const evo = fakeEvolution();
  const app = buildApp({ evolution: { url: 'http://evo.test', apikey: 'k', fetchImpl: evo.fetchImpl } });
  const call = await salon(app);
  await call('POST', '/api/whatsapp/connect');
  evo.instances[Object.keys(evo.instances)[0]] = 'open';
  const set = await call('PUT', '/api/settings', { whatsapp: { reminderMinutes: 60 } });
  assert.equal(set.body.whatsapp.reminderMinutes, 60);
  assert.equal((await call('PUT', '/api/settings', { whatsapp: { reminderMinutes: 99999 } })).status, 400, 'no máximo 3 dias');

  const date = nextWeekday(4);
  const start = Date.parse(`${date}T15:00:00-03:00`);
  await call('POST', '/api/sync', { changes: [
    { coll: 'clients', id: 'c1', data: { name: 'Lia', phone: '11944443333' } },
    { coll: 'appts', id: 'a1', data: { clientId: 'c1', date, time: '15:00', status: 'marcado', createdAt: start - 3 * 86400e3 } },
  ] });
  const m = app.messenger, lembretes = () => evo.sent.filter(x => /Passando para lembrar/.test(x.text)).length;
  await m.runReminders(start - 2 * 3600e3);
  assert.equal(lembretes(), 0, '2h antes: ainda não');
  await m.runReminders(start - 55 * 60e3);
  assert.equal(lembretes(), 1, '1h antes: manda');

  // 30 minutos: manda com 25 min, não manda com 5 min
  await call('PUT', '/api/settings', { whatsapp: { reminderMinutes: 30 } });
  await call('POST', '/api/sync', { changes: [
    { coll: 'appts', id: 'a2', data: { clientId: 'c1', date, time: '17:00', status: 'marcado', createdAt: start - 3 * 86400e3 } },
    { coll: 'appts', id: 'a3', data: { clientId: 'c1', date, time: '17:30', status: 'marcado', createdAt: start - 3 * 86400e3 } },
  ] });
  const s17 = Date.parse(`${date}T17:00:00-03:00`);
  await m.runReminders(s17 - 25 * 60e3);
  assert.equal(lembretes(), 2);
  await m.runReminders(Date.parse(`${date}T17:25:00-03:00`)); // 5 min antes das 17:30
  assert.equal(lembretes(), 2, 'em cima da hora não manda');

  // configuração antiga (reminderHours) vira minutos
  app.db.prepare("UPDATE tenants SET settings = json_set(settings, '$.whatsapp.reminderHours', 3) WHERE 1").run();
  app.db.prepare("UPDATE tenants SET settings = json_remove(settings, '$.whatsapp.reminderMinutes') WHERE 1").run();
  assert.equal((await call('GET', '/api/settings')).body.whatsapp.reminderMinutes, 180);
  await app.close();
});

test('meus horários: ver, remarcar (com confirmação), recusar, cancelar, pedir link', async () => {
  const evo = fakeEvolution();
  const pushed = [];
  const app = buildApp({
    evolution: { url: 'http://evo.test', apikey: 'k', fetchImpl: evo.fetchImpl },
    publicUrl: 'https://maquefacil.com.br',
    pushSender: async (sub, body) => { pushed.push(JSON.parse(body)); },
  });
  const call = await salon(app);
  const pub = client(app);
  await call('POST', '/api/whatsapp/connect');
  evo.instances[Object.keys(evo.instances)[0]] = 'open';
  await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://push.test/1', keys: { p256dh: 'a', auth: 'b' } } });
  const wait = () => new Promise(r => setTimeout(r, 60));

  // pede um horário: recebe o link pessoal
  const d1 = nextWeekday(2), d2 = nextWeekday(4);
  const b = await pub('POST', '/api/public/studio-ana/book', { date: d1, time: '10:00', serviceId: 's1', name: 'Joana Lima', phone: '(11) 98888-7777' });
  const T = b.body.meus;
  assert.ok(T && T.length > 20);
  assert.equal((await pub('GET', '/api/public/studio-ana/me?t=errado')).status, 401);

  const orig = (await call('GET', '/api/changes?since=0')).body.changes.find(c => c.coll === 'appts');
  await call('POST', `/api/appts/${orig.id}/decision`, { decision: 'confirm' });
  await wait();
  assert.match(evo.sent.find(m => m.number === '5511988887777').text, /Ver ou remarcar: https:\/\/maquefacil\.com\.br\/studio-ana#meus=/, 'link na confirmação');

  let me = (await pub('GET', `/api/public/studio-ana/me?t=${T}`)).body;
  assert.equal(me.name, 'Joana Lima');
  assert.equal(me.upcoming.length, 1);
  assert.equal(me.upcoming[0].canChange, true);

  // horários para remarcar: o dela não conta como ocupado
  const slots = (await pub('GET', `/api/public/studio-ana/slots?date=${d1}&dur=60&except=${orig.id}`)).body.slots;
  assert.ok(slots.includes('10:00') && slots.includes('10:30'));

  // remarca → vira pedido; o antigo continua marcado
  const r = await pub('POST', '/api/public/studio-ana/me/reschedule', { t: T, id: orig.id, date: d2, time: '14:00' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pending, true);
  assert.match(pushed.at(-1).title, /remarcar/);
  me = (await pub('GET', `/api/public/studio-ana/me?t=${T}`)).body;
  assert.equal(me.upcoming.length, 1, 'o pedido de troca não aparece como outro horário');
  const oldView = me.upcoming.find(a => a.id === orig.id);
  assert.equal(oldView.status, 'marcado');
  assert.ok(oldView.moving, 'mostra que tem remarcação esperando');

  // profissional confirma a remarcação → o antigo é cancelado sozinho
  await call('POST', `/api/appts/${oldView.moving}/decision`, { decision: 'confirm' });
  await wait();
  const all = (await call('GET', '/api/changes?since=0')).body.changes.filter(c => c.coll === 'appts').map(c => c.data);
  assert.equal(all.find(a => a.id === orig.id).status, 'cancelado');
  assert.equal(all.find(a => a.id === oldView.moving).status, 'marcado');

  // remarca de novo e a profissional recusa → continua o horário de antes, com aviso
  const moved = oldView.moving;
  await pub('POST', '/api/public/studio-ana/me/reschedule', { t: T, id: moved, date: d2, time: '16:00' });
  const req2 = (await pub('GET', `/api/public/studio-ana/me?t=${T}`)).body.upcoming.find(a => a.id === moved).moving;
  await call('POST', `/api/appts/${req2}/decision`, { decision: 'decline' });
  await wait();
  assert.ok(evo.sent.some(m => /Não conseguimos mudar/.test(m.text)));
  me = (await pub('GET', `/api/public/studio-ana/me?t=${T}`)).body;
  assert.equal(me.upcoming.find(a => a.id === moved).status, 'marcado');

  // cancela → profissional avisada
  assert.equal((await pub('POST', '/api/public/studio-ana/me/cancel', { t: T, id: moved })).status, 200);
  assert.match(pushed.at(-1).title, /cancelado pela cliente/);
  assert.equal((await pub('GET', `/api/public/studio-ana/me?t=${T}`)).body.upcoming.length, 0);

  // pedir o link pelo telefone: chega no WhatsApp; número desconhecido não revela nada
  const before = evo.sent.length;
  assert.deepEqual((await pub('POST', '/api/public/studio-ana/access', { phone: '11 98888 7777' })).body, { ok: true });
  assert.deepEqual((await pub('POST', '/api/public/studio-ana/access', { phone: '11 90000 1111' })).body, { ok: true });
  await wait();
  const sentNow = evo.sent.slice(before);
  assert.equal(sentNow.length, 1);
  assert.match(sentNow[0].text, /#meus=/);
  await app.close();
});

test('pré-reserva: mensagem com o primeiro nome, sem lembrete, confirma ao pagar o sinal', async () => {
  const evo = fakeEvolution();
  const app = buildApp({ evolution: { url: 'http://evo.test', apikey: 'k', fetchImpl: evo.fetchImpl }, publicUrl: 'https://studiokadosh.com' });
  const call = await salon(app);
  await call('POST', '/api/whatsapp/connect');
  evo.instances[Object.keys(evo.instances)[0]] = 'open';
  const date = nextWeekday(4);
  const start = Date.parse(`${date}T10:00:00-03:00`);
  const appt = { clientId: 'c1', date, time: '10:00', service: 'Progressiva', price: 300, status: 'prereserva', createdAt: start - 5 * 86400e3 };
  await call('POST', '/api/sync', { changes: [
    { coll: 'clients', id: 'c1', data: { name: 'Maria Eduarda Souza', phone: '11966665555' } },
    { coll: 'appts', id: 'p1', data: appt },
  ] });
  await new Promise(r => setTimeout(r, 60));
  const msg = evo.sent.find(m => m.number === '5511966665555');
  assert.match(msg.text, /^Olá, Maria! ✅/, 'só o primeiro nome');
  assert.match(msg.text, /pré-reservado/);
  assert.match(msg.text, /Valor: R\$\s?300,00/);
  assert.match(msg.text, /50% do valor/);
  assert.doesNotMatch(msg.text, /\{pacote\}|📦/, 'linha do pacote some quando não tem');

  // sem lembrete enquanto for pré-reserva; livre no link? não: ocupa o horário
  assert.equal(await app.messenger.runReminders(start - 20 * 3600e3), 0);
  const slots = (await client(app)('GET', `/api/public/studio-ana/slots?date=${date}&service=s1`)).body.slots;
  assert.ok(!slots.includes('10:00'), 'pré-reserva segura o horário');

  // pagou o sinal → vira confirmado → sai a confirmação
  await call('POST', '/api/sync', { changes: [{ coll: 'appts', id: 'p1', data: { ...appt, status: 'marcado', payments: [{ v: 150, m: 'pix', d: date }] } }] });
  await new Promise(r => setTimeout(r, 60));
  assert.ok(evo.sent.some(m => m.number === '5511966665555' && /está marcado/.test(m.text)));
  await app.close();
});

test('pacote: "2ª de 4" nas mensagens e na página da cliente; cancelar renumera', async () => {
  const evo = fakeEvolution();
  const app = buildApp({ evolution: { url: 'http://evo.test', apikey: 'k', fetchImpl: evo.fetchImpl }, publicUrl: 'https://x.com' });
  const call = await salon(app);
  const pub = client(app);
  await call('POST', '/api/whatsapp/connect');
  evo.instances[Object.keys(evo.instances)[0]] = 'open';
  const d = nextWeekday(2);
  const ap = (id, n, extra = {}) => ({ coll: 'appts', id, data: { clientId: 'c1', date: addDays(d, 7 * n), time: '15:00', service: 'Cronograma', packageId: 'k1', status: 'marcado', seriesId: 'S', seriesIndex: n, ...extra } });
  await call('POST', '/api/sync', { changes: [
    { coll: 'clients', id: 'c1', data: { name: 'Bia Lima', phone: '11955554444' } },
    { coll: 'packages', id: 'k1', data: { clientId: 'c1', name: 'Cronograma capilar', total: 4 } },
    ap('a1', 0), ap('a2', 1), ap('a3', 2),
  ] });
  await new Promise(r => setTimeout(r, 60));
  assert.match(evo.sent.find(m => m.number === '5511955554444').text, /📦 Cronograma capilar — 1ª sessão de 4/);
  assert.equal(app.messenger.packageLabel((await call('GET', '/api/me')).body.tenant.id, { id: 'a3', packageId: 'k1' }), 'Cronograma capilar — 3ª sessão de 4');

  // cancela a 1ª: a antiga 2ª passa a ser a 1ª
  await call('POST', '/api/sync', { changes: [ap('a1', 0, { status: 'cancelado' })] });
  const tid = (await call('GET', '/api/me')).body.tenant.id;
  assert.equal(app.messenger.packageLabel(tid, { id: 'a2', packageId: 'k1' }), 'Cronograma capilar — 1ª sessão de 4');

  // página da cliente mostra o pacote
  const b = await pub('POST', '/api/public/studio-ana/access', { phone: '11955554444' });
  assert.equal(b.status, 200);
  await new Promise(r => setTimeout(r, 60));
  const token = evo.sent.at(-1).text.match(/#meus=([\w-]+)/)[1];
  const me = (await pub('GET', `/api/public/studio-ana/me?t=${token}`)).body;
  assert.equal(me.upcoming[0].pacote, 'Cronograma capilar — 1ª sessão de 4');
  assert.deepEqual(me.packages.map(p => [p.name, p.total, p.scheduled]), [['Cronograma capilar', 4, 2]]);
  await app.close();
});

test('cronograma que já começou: "3ª sessão de 4" e a sessão vai sempre na mensagem', async () => {
  const evo = fakeEvolution();
  const app = buildApp({ evolution: { url: 'http://evo.test', apikey: 'k', fetchImpl: evo.fetchImpl } });
  const call = await salon(app);
  await call('POST', '/api/whatsapp/connect');
  evo.instances[Object.keys(evo.instances)[0]] = 'open';
  // texto editado SEM {pacote}: a sessão entra mesmo assim
  await call('PUT', '/api/settings', { whatsapp: { templates: { confirm: 'Oi {nome}, marcado {dia} {hora}.', reminder: 'Oi {nome}, amanhã tem.' }, reminderMinutes: 1440 } });
  const date = nextWeekday(3);
  const start = Date.parse(`${date}T11:00:00-03:00`);
  await call('POST', '/api/sync', { changes: [
    { coll: 'clients', id: 'c1', data: { name: 'Rita Alves', phone: '11933332222' } },
    { coll: 'packages', id: 'k1', data: { clientId: 'c1', name: 'Cronograma capilar', total: 4, doneBefore: 2 } },
    { coll: 'appts', id: 'a1', data: { clientId: 'c1', date, time: '11:00', status: 'marcado', packageId: 'k1', createdAt: start - 4 * 86400e3 } },
  ] });
  await new Promise(r => setTimeout(r, 60));
  const conf = evo.sent.find(m => m.number === '5511933332222').text;
  assert.match(conf, /^Oi Rita, marcado/);
  assert.match(conf, /📦 Cronograma capilar — 3ª sessão de 4/);
  await app.messenger.runReminders(start - 20 * 3600e3);
  assert.match(evo.sent.at(-1).text, /Oi Rita, amanhã tem\.\n📦 Cronograma capilar — 3ª sessão de 4/);
  await app.close();
});

test('WhatsApp fica "offline" para o celular continuar recebendo notificações', async () => {
  const evo = fakeEvolution();
  const app = buildApp({ evolution: { url: 'http://evo.test', apikey: 'k', fetchImpl: evo.fetchImpl } });
  const call = await salon(app);
  await call('POST', '/api/whatsapp/connect');
  const created = evo.calls.find(c => c[0] === 'create')[2];
  assert.equal(created.alwaysOnline, false, 'criada sem ficar sempre online');
  assert.equal(created.readMessages, false, 'não marca mensagens como lidas');
  evo.instances[Object.keys(evo.instances)[0]] = 'open';
  await call('GET', '/api/whatsapp/status'); // conectou
  await new Promise(r => setTimeout(r, 30));
  assert.ok(evo.calls.some(c => c[0] === 'settings' && c[2].alwaysOnline === false && c[2].readMessages === false));
  assert.ok(evo.calls.some(c => c[0] === 'presence' && c[2] === 'unavailable'));
  // e o agendador repete
  const before = evo.calls.filter(c => c[0] === 'presence').length;
  assert.equal(await app.messenger.keepQuiet(), 1);
  assert.equal(evo.calls.filter(c => c[0] === 'presence').length, before + 1);
  await app.close();
});
