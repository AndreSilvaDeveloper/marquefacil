import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

// Mantém o cookie de sessão entre chamadas, como um navegador
function client(app) {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const res = await app.inject({ method, url, payload: body, headers: { cookie, ...headers } });
    const set = res.headers['set-cookie'];
    if (set) cookie = [].concat(set).map(c => c.split(';')[0]).join('; ');
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
  };
}

const signup = (call, extra = {}) => call('POST', '/api/signup', {
  salonName: 'Salão da Ana', name: 'Ana', email: 'ana@exemplo.com', password: 'segredo1', ...extra,
});

test('cadastro, login, sair', async () => {
  const app = buildApp();
  const call = client(app);
  assert.equal((await call('GET', '/api/me')).status, 401);

  const r = await signup(call);
  assert.equal(r.status, 200);
  assert.equal(r.body.tenant.slug, 'salao-da-ana');
  assert.equal((await call('GET', '/api/me')).body.user.email, 'ana@exemplo.com');

  assert.equal((await signup(call)).status, 409, 'e-mail repetido');
  assert.equal((await call('POST', '/api/logout')).status, 200);
  assert.equal((await call('GET', '/api/me')).status, 401);

  assert.equal((await call('POST', '/api/login', { email: 'ana@exemplo.com', password: 'errada' })).status, 401);
  const ok = await call('POST', '/api/login', { email: ' ANA@exemplo.com ', password: 'segredo1' });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/me')).body.tenant.name, 'Salão da Ana');
  await app.close();
});

test('slug repetido ganha número', async () => {
  const app = buildApp();
  await signup(client(app));
  const r = await signup(client(app), { email: 'outra@exemplo.com' });
  assert.equal(r.body.tenant.slug, 'salao-da-ana-2');
  await app.close();
});

test('sincroniza e busca só o que mudou', async () => {
  const app = buildApp();
  const call = client(app);
  await signup(call);

  const s1 = await call('POST', '/api/sync', { changes: [
    { coll: 'clients', id: 'c1', data: { name: 'Maria' } },
    { coll: 'appts', id: 'a1', data: { clientId: 'c1', date: '2026-09-22', time: '14:00' } },
  ] });
  assert.equal(s1.status, 200);
  assert.equal(s1.body.seq, 2);

  const all = await call('GET', '/api/changes?since=0');
  assert.equal(all.body.changes.length, 2);
  assert.equal(all.body.changes[0].data.id, 'c1');

  await call('POST', '/api/sync', { changes: [{ coll: 'clients', id: 'c1', deleted: true }] });
  const since = await call('GET', `/api/changes?since=${all.body.seq}`);
  assert.deepEqual(since.body.changes, [{ coll: 'clients', id: 'c1', deleted: true }]);

  assert.equal((await call('POST', '/api/sync', { changes: [{ coll: 'hack', id: 'x', data: {} }] })).status, 400);
  assert.equal((await call('POST', '/api/sync', { changes: [{ coll: 'clients', id: '../x', data: {} }] })).status, 400);
  await app.close();
});

test('um salão não vê os dados do outro', async () => {
  const app = buildApp();
  const ana = client(app), bia = client(app);
  await signup(ana);
  await signup(bia, { salonName: 'Bia', email: 'bia@exemplo.com' });
  await ana('POST', '/api/sync', { changes: [{ coll: 'clients', id: 'c1', data: { name: 'Cliente da Ana' } }] });
  await bia('POST', '/api/sync', { changes: [{ coll: 'clients', id: 'c1', data: { name: 'Cliente da Bia' } }] });
  assert.equal((await ana('GET', '/api/changes?since=0')).body.changes[0].data.name, 'Cliente da Ana');
  assert.equal((await bia('GET', '/api/changes?since=0')).body.changes[0].data.name, 'Cliente da Bia');
  await app.close();
});

test('importa cópia de segurança (juntar e substituir)', async () => {
  const app = buildApp();
  const call = client(app);
  await signup(call);
  await call('POST', '/api/sync', { changes: [{ coll: 'clients', id: 'velha', data: { name: 'Velha' } }] });
  const backup = { clients: [{ id: 'c1', name: 'Maria' }], appts: [{ id: 'a1', clientId: 'c1' }], settings: { big: true } };

  const r = await call('POST', '/api/import', { data: backup, replace: true });
  assert.equal(r.body.imported, 2);
  const live = (await call('GET', '/api/changes?since=0')).body.changes.filter(c => !c.deleted);
  assert.deepEqual(live.map(c => c.id).sort(), ['a1', 'c1']);
  await app.close();
});

test('minha conta: nome do salão, nome e senha', async () => {
  const app = buildApp();
  const call = client(app), other = client(app);
  await signup(call);
  await other('POST', '/api/login', { email: 'ana@exemplo.com', password: 'segredo1' });
  const r = await call('PUT', '/api/account', { salonName: 'Studio Novo', name: 'Ana Maria' });
  assert.equal(r.body.tenant.name, 'Studio Novo');
  assert.equal(r.body.user.name, 'Ana Maria');
  assert.equal(r.body.tenant.slug, 'salao-da-ana', 'link não muda');
  assert.equal((await call('PUT', '/api/account', { salonName: '  ' })).status, 400);
  assert.equal((await call('PUT', '/api/account', { currentPassword: 'errada', newPassword: 'nova123' })).status, 400);
  assert.equal((await call('PUT', '/api/account', { currentPassword: 'segredo1', newPassword: '123' })).status, 400);
  assert.equal((await call('PUT', '/api/account', { currentPassword: 'segredo1', newPassword: 'nova123' })).status, 200);
  assert.equal((await call('GET', '/api/me')).status, 200, 'este aparelho continua');
  assert.equal((await other('GET', '/api/me')).status, 401, 'outros aparelhos saem');
  assert.equal((await client(app)('POST', '/api/login', { email: 'ana@exemplo.com', password: 'nova123' })).status, 200);
  await app.close();
});
