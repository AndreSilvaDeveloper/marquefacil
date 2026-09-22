import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import crypto from 'node:crypto';
import { openDb, applyChanges, changesSince, COLLECTIONS } from './db.js';
import { hashPassword, checkPassword, newToken, hashToken, newId, rateLimiter } from './auth.js';

const YEAR = 365 * 24 * 60 * 60;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_RECORD = 20_000; // bytes por registro
const HANDOFF_TTL = 3 * 24 * 60 * 60 * 1000;

const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const slugify = s => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'salao';
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

class HttpError extends Error {
  constructor(status, message) { super(message); this.statusCode = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

// Confere uma lista de mudanças vinda do app antes de gravar
function cleanChanges(list) {
  if (!Array.isArray(list)) fail(400, 'Formato inválido.');
  if (list.length > 5000) fail(413, 'Mudanças demais de uma vez.');
  return list.map(c => {
    if (!isObj(c) || !COLLECTIONS.includes(c.coll) || !ID_RE.test(c.id || '')) fail(400, 'Registro inválido.');
    if (c.deleted) return { coll: c.coll, id: c.id, deleted: true };
    if (!isObj(c.data)) fail(400, 'Registro inválido.');
    const data = { ...c.data, id: c.id };
    if (JSON.stringify(data).length > MAX_RECORD) fail(413, 'Registro grande demais.');
    return { coll: c.coll, id: c.id, data };
  });
}

// Converte uma cópia de segurança do app ({clients:[...], appts:[...]}) em mudanças
function backupToChanges(backup) {
  if (!isObj(backup)) fail(400, 'Cópia inválida.');
  const out = [];
  for (const coll of COLLECTIONS) {
    for (const item of Array.isArray(backup[coll]) ? backup[coll] : []) {
      if (isObj(item) && ID_RE.test(item.id || '')) out.push({ coll, id: item.id, data: item });
    }
  }
  return cleanChanges(out);
}

export function buildApp({
  dbFile = ':memory:',
  publicDir = null,
  allowSignup = true,
  secureCookies = false,
  handoffOrigins = '*',
  logger = false,
} = {}) {
  const db = openDb(dbFile);
  const app = Fastify({ logger, trustProxy: true, bodyLimit: 8 * 1024 * 1024 });
  app.decorate('db', db);
  app.register(fastifyCookie);

  const limitAuth = rateLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
  const limitHandoff = rateLimiter({ max: 20, windowMs: 60 * 60 * 1000 });

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode || 500;
    if (status >= 500) req.log.error(err);
    reply.code(status).send({ error: status >= 500 ? 'Erro no servidor. Tente de novo.' : err.message });
  });

  /* ------------------------------ sessão ------------------------------ */
  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    session: db.prepare(`
      SELECT s.token_hash, s.last_seen, u.id AS user_id, u.name AS user_name, u.email,
             t.id AS tenant_id, t.name AS tenant_name, t.slug
      FROM sessions s JOIN users u ON u.id = s.user_id JOIN tenants t ON t.id = u.tenant_id
      WHERE s.token_hash = ?`),
    touch: db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?'),
    newSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)'),
    delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    slugTaken: db.prepare('SELECT 1 FROM tenants WHERE slug = ?'),
    newTenant: db.prepare('INSERT INTO tenants (id, name, slug, created_at) VALUES (?, ?, ?, ?)'),
    newUser: db.prepare('INSERT INTO users (id, tenant_id, email, name, pass_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  };

  function startSession(reply, userId) {
    const token = newToken();
    const now = Date.now();
    q.newSession.run(hashToken(token), userId, now, now);
    reply.setCookie('sid', token, { path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: YEAR });
  }

  function me(s) {
    return { user: { id: s.user_id, name: s.user_name, email: s.email }, tenant: { id: s.tenant_id, name: s.tenant_name, slug: s.slug } };
  }

  // Exige login: coloca a sessão em req.s
  async function auth(req) {
    const token = req.cookies.sid;
    const s = token && q.session.get(hashToken(token));
    if (!s) fail(401, 'Entre com seu e-mail e senha.');
    if (Date.now() - s.last_seen > 24 * 60 * 60 * 1000) q.touch.run(Date.now(), s.token_hash);
    req.s = s;
  }

  const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

  app.post('/api/signup', async (req, reply) => {
    if (!allowSignup) fail(403, 'Cadastro fechado. Fale com o suporte.');
    if (!limitAuth(req.ip)) fail(429, 'Muitas tentativas. Espere alguns minutos.');
    const b = isObj(req.body) ? req.body : {};
    const salon = String(b.salonName || '').trim().slice(0, 80);
    const name = String(b.name || '').trim().slice(0, 80);
    const email = norm(b.email);
    const pass = String(b.password || '');
    if (!salon) fail(400, 'Escreva o nome do salão.');
    if (!name) fail(400, 'Escreva o seu nome.');
    if (!emailOk(email)) fail(400, 'O e-mail não está certo.');
    if (pass.length < 6) fail(400, 'A senha precisa ter pelo menos 6 letras ou números.');
    if (q.userByEmail.get(email)) fail(409, 'Já existe uma conta com esse e-mail. Use "Entrar".');

    let slug = slugify(salon);
    for (let i = 2; q.slugTaken.get(slug); i++) slug = `${slugify(salon).slice(0, 36)}-${i}`;
    const passHash = await hashPassword(pass);
    const tenantId = newId(), userId = newId(), now = Date.now();
    db.transaction(() => {
      q.newTenant.run(tenantId, salon, slug, now);
      q.newUser.run(userId, tenantId, email, name, passHash, now);
    })();
    startSession(reply, userId);
    return { user: { id: userId, name, email }, tenant: { id: tenantId, name: salon, slug } };
  });

  app.post('/api/login', async (req, reply) => {
    if (!limitAuth(req.ip)) fail(429, 'Muitas tentativas. Espere alguns minutos.');
    const b = isObj(req.body) ? req.body : {};
    const u = q.userByEmail.get(norm(b.email));
    if (!u || !(await checkPassword(String(b.password || ''), u.pass_hash))) fail(401, 'E-mail ou senha errados.');
    startSession(reply, u.id);
    const t = db.prepare('SELECT id, name, slug FROM tenants WHERE id = ?').get(u.tenant_id);
    return { user: { id: u.id, name: u.name, email: u.email }, tenant: t };
  });

  app.post('/api/logout', async (req, reply) => {
    if (req.cookies.sid) q.delSession.run(hashToken(req.cookies.sid));
    reply.clearCookie('sid', { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', { preHandler: auth }, async req => me(req.s));

  /* ------------------------------ dados ------------------------------ */
  app.get('/api/changes', { preHandler: auth }, async req => {
    const since = Math.max(0, parseInt(req.query.since, 10) || 0);
    return changesSince(db, req.s.tenant_id, since);
  });

  app.post('/api/sync', { preHandler: auth }, async req => {
    const changes = cleanChanges(req.body?.changes);
    const seq = changes.length ? applyChanges(db, req.s.tenant_id, changes)
      : db.prepare('SELECT seq FROM tenants WHERE id = ?').get(req.s.tenant_id).seq;
    return { seq };
  });

  // Recupera uma cópia de segurança. replace=true apaga o que tem antes.
  app.post('/api/import', { preHandler: auth }, async req => {
    const changes = backupToChanges(req.body?.data);
    if (req.body?.replace) {
      const keep = new Set(changes.map(c => c.coll + '/' + c.id));
      const existing = db.prepare('SELECT coll, id FROM records WHERE tenant_id = ? AND deleted = 0').all(req.s.tenant_id);
      for (const r of existing) if (!keep.has(r.coll + '/' + r.id)) changes.push({ coll: r.coll, id: r.id, deleted: true });
    }
    const seq = changes.length ? applyChanges(db, req.s.tenant_id, changes) : 0;
    return { seq, imported: changes.filter(c => !c.deleted).length };
  });

  /* --------- passagem dos dados do app antigo (GitHub Pages) para o novo --------- */
  const cors = (req, reply) => {
    const origin = req.headers.origin;
    const ok = handoffOrigins === '*' || String(handoffOrigins).split(',').map(s => s.trim()).includes(origin);
    if (origin && ok) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type');
    }
  };
  app.options('/api/handoff', async (req, reply) => { cors(req, reply); reply.code(204).send(); });
  app.post('/api/handoff', async (req, reply) => {
    cors(req, reply);
    if (!limitHandoff(req.ip)) fail(429, 'Muitas tentativas. Espere um pouco.');
    backupToChanges(req.body?.data); // só valida
    const code = crypto.randomBytes(12).toString('base64url');
    db.prepare('DELETE FROM handoffs WHERE created_at < ?').run(Date.now() - HANDOFF_TTL);
    db.prepare('INSERT INTO handoffs (code, data, created_at) VALUES (?, ?, ?)').run(code, JSON.stringify(req.body.data), Date.now());
    return { code };
  });
  app.post('/api/handoff/claim', { preHandler: auth }, async req => {
    const code = String(req.body?.code || '');
    const h = db.prepare('SELECT * FROM handoffs WHERE code = ? AND created_at >= ?').get(code, Date.now() - HANDOFF_TTL);
    if (!h) fail(404, 'Esse link de passagem expirou. Faça de novo pelo app antigo.');
    const changes = backupToChanges(JSON.parse(h.data));
    const seq = changes.length ? applyChanges(db, req.s.tenant_id, changes) : 0;
    db.prepare('DELETE FROM handoffs WHERE code = ?').run(code);
    return { seq, imported: changes.length };
  });

  app.get('/api/health', async () => ({ ok: true }));
  app.all('/api/*', async () => fail(404, 'Não encontrado.'));

  /* ------------------------------ app (arquivos) ------------------------------ */
  if (publicDir) {
    app.register(fastifyStatic, {
      root: publicDir,
      setHeaders(res, file) {
        // sw.js e index.html sempre atualizados; o resto pode ficar em cache curto
        if (/(sw\.js|index\.html|manifest\.json)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
      },
    });
  }

  app.addHook('onClose', async () => db.close());
  return app;
}
