import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { nowIn, addDays, weekday, zonedEpoch } from '../src/time.js';

function client(app) {
  let cookie = '';
  return async (method, url, body) => {
    const res = await app.inject({ method, url, payload: body, headers: { cookie } });
    const set = res.headers['set-cookie'];
    if (set) cookie = [].concat(set).map(c => c.split(';')[0]).join('; ');
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, raw: res.body };
  };
}
const weekdayAhead = n => { let d = addDays(nowIn('America/Sao_Paulo').date, n); while (weekday(d) === 0 || weekday(d) === 6) d = addDays(d, 1); return d; };

test('agenda pessoal: desligada não muda nada; ligada ocupa o horário no link sem mostrar o que é', async () => {
  const pushed = [];
  const app = buildApp({ pushSender: async (sub, body) => { pushed.push(JSON.parse(body)); } });
  const call = client(app), pub = client(app);
  await call('POST', '/api/signup', { salonName: 'Studio Ana', name: 'Ana', email: 'ana@x.com', password: 'segredo1' });
  await call('PUT', '/api/settings', { booking: { enabled: true, minAdvanceHours: 0 } });
  assert.equal((await call('GET', '/api/settings')).body.personal.enabled, false, 'vem desligada');
  const d = weekdayAhead(2), d2 = weekdayAhead(4);
  await call('POST', '/api/sync', { changes: [
    { coll: 'personal', id: 'p1', data: { title: 'Médico do Joãozinho', date: d, time: '10:00', duration: 60, block: true } },
    { coll: 'personal', id: 'p2', data: { title: 'Ligar pro contador', date: d, time: '15:00', duration: 30, block: false } },
    { coll: 'personal', id: 'p3', data: { title: 'Viagem', date: d2, allDay: true, block: true } },
  ] });
  const slots = async date => (await pub('GET', `/api/public/studio-ana/slots?date=${date}`)).body.slots;

  // desligada: os compromissos não ocupam nada
  assert.ok((await slots(d)).includes('10:00'));
  assert.ok((await slots(d2)).length > 0);

  // ligada
  await call('PUT', '/api/settings', { personal: { enabled: true } });
  const s1 = await slots(d);
  assert.ok(!s1.includes('10:00') && !s1.includes('10:30'), 'compromisso ocupa 10:00–11:00');
  assert.ok(!s1.includes('09:30'), 'serviço de 1h que encostaria no compromisso também não');
  assert.ok(s1.includes('11:00') && s1.includes('15:00'), 'o que não bloqueia o link fica livre');
  assert.deepEqual(await slots(d2), [], 'dia todo: fechado');
  const days = (await pub('GET', '/api/public/studio-ana/days')).body.days;
  assert.equal(days.find(x => x.date === d2).free, 0);
  const all = (await pub('GET', `/api/public/studio-ana/slots?date=${d}`)).raw + JSON.stringify(days);
  assert.ok(!/Médico|Viagem|contador/.test(all), 'a cliente não vê o que é');
  assert.equal((await pub('POST', '/api/public/studio-ana/book', { date: d, time: '10:00', name: 'Bia', phone: '11955554444' })).status, 409);

  // aviso no celular antes do compromisso (mesmo tempo dos avisos de horário)
  await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://push.test/1', keys: { p256dh: 'a', auth: 'b' } } });
  await app.alerts.run(zonedEpoch(d, '10:00', 'America/Sao_Paulo') - 10 * 60e3);
  assert.ok(pushed.some(p => p.title === '📌 Em 10 min: Médico do Joãozinho' && /até 11:00/.test(p.body)));
  await app.close();
});
