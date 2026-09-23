import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { brandFor, brandHtml, manifestFor } from './brands.js';
import { openDb, applyChanges, changesSince, COLLECTIONS } from './db.js';
import { hashPassword, checkPassword, newToken, hashToken, newId, rateLimiter } from './auth.js';
import { fail, norm, isObj } from './util.js';
import { readSettings, updateSettings } from './settings.js';
import { nowIn, zonedEpoch } from './time.js';
import { evolutionClient, createMessenger, registerWhatsapp } from './whatsapp.js';
import { registerBooking } from './booking.js';
import { createPush, registerPush } from './push.js';

const YEAR = 365 * 24 * 60 * 60;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_RECORD = 20_000; // bytes por registro
const HANDOFF_TTL = 3 * 24 * 60 * 60 * 1000;

const slugify = s => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'salao';
// Endereços que não podem virar link de salão
const RESERVED = new Set(['api', 'app', 'admin', 'login', 'entrar', 'sair', 'cadastro', 'agendar', 'www', 'static', 'public', 'suporte', 'ajuda']);

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
  evolution = {},        // { url, apikey, fetchImpl }
  publicUrl = '',        // endereço do sistema, para links nas mensagens
  pushSender = null,     // para testes
  logger = false,
} = {}) {
  const db = openDb(dbFile);
  const app = Fastify({ logger, trustProxy: true, bodyLimit: 8 * 1024 * 1024 });
  app.decorate('db', db);
  app.register(fastifyCookie);

  const limitAuth = rateLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
  const limitHandoff = rateLimiter({ max: 20, windowMs: 60 * 60 * 1000 });
  const limitBook = rateLimiter({ max: 10, windowMs: 60 * 60 * 1000 });

  const evo = evolutionClient(evolution);
  const messenger = createMessenger({ db, evo, publicUrl, log: app.log });
  app.decorate('messenger', messenger);
  const push = createPush({ db, sender: pushSender, log: app.log });
  app.decorate('push', push);

  const getSettings = tenantId => readSettings(db.prepare('SELECT settings FROM tenants WHERE id = ?').get(tenantId)?.settings);
  const saveSettings = (tenantId, s) => db.prepare('UPDATE tenants SET settings = ? WHERE id = ?').run(JSON.stringify(s), tenantId);

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
    for (let i = 2; q.slugTaken.get(slug) || RESERVED.has(slug); i++) slug = `${slugify(salon).slice(0, 36)}-${i}`;
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

  const apptNow = db.prepare("SELECT data FROM records WHERE tenant_id = ? AND coll = 'appts' AND id = ? AND deleted = 0");
  const statusOf = (tenantId, id) => { const r = apptNow.get(tenantId, id); return r ? JSON.parse(r.data).status || 'marcado' : null; };

  // Pedido do link aceito ou recusado: avisa a cliente pelo WhatsApp
  function afterDecision(tenantId, apptId, from, to) {
    if (from !== 'pendente' || to === 'pendente') return;
    const s = getSettings(tenantId);
    if (to === 'cancelado') { if (s.whatsapp.declineMessage) messenger.fire(tenantId, apptId, 'decline'); }
    else if (s.whatsapp.confirmOnline) messenger.fire(tenantId, apptId, 'confirm');
  }

  app.post('/api/sync', { preHandler: auth }, async req => {
    const tenantId = req.s.tenant_id;
    const changes = cleanChanges(req.body?.changes);
    const before = new Map(changes.filter(c => c.coll === 'appts').map(c => [c.id, statusOf(tenantId, c.id)]));
    const seq = changes.length ? applyChanges(db, tenantId, changes)
      : db.prepare('SELECT seq FROM tenants WHERE id = ?').get(tenantId).seq;

    let s = null;
    for (const c of changes) {
      if (c.coll !== 'appts' || c.deleted) continue;
      const from = before.get(c.id), to = c.data.status || 'marcado';
      if (from) { afterDecision(tenantId, c.id, from, to); continue; }
      // Horário novo marcado no app: manda confirmação, se a opção estiver ligada
      s ||= getSettings(tenantId);
      if (s.whatsapp.confirmManual && to === 'marcado' && c.data.date && c.data.time &&
          zonedEpoch(c.data.date, c.data.time, s.timezone) > Date.now()) messenger.fire(tenantId, c.id, 'confirm');
    }
    return { seq };
  });

  // Confirmar/recusar um pedido direto (usado pelo botão da notificação)
  app.post('/api/appts/:id/decision', { preHandler: auth }, async req => {
    const tenantId = req.s.tenant_id, id = req.params.id;
    const r = apptNow.get(tenantId, id);
    if (!r) fail(404, 'Esse agendamento não existe mais.');
    const a = JSON.parse(r.data);
    const to = req.body?.decision === 'decline' ? 'cancelado' : req.body?.decision === 'confirm' ? 'marcado' : null;
    if (!to) fail(400, 'Decisão inválida.');
    if (a.status !== 'pendente') return { ok: true, status: a.status, already: true };
    applyChanges(db, tenantId, [{ coll: 'appts', id, data: { ...a, status: to } }]);
    afterDecision(tenantId, id, 'pendente', to);
    return { ok: true, status: to };
  });

  /* ------------------------------ configurações ------------------------------ */
  app.get('/api/settings', { preHandler: auth }, async req => {
    const s = getSettings(req.s.tenant_id);
    return { ...s, slug: req.s.slug, today: nowIn(s.timezone).date, whatsappAvailable: evo.enabled };
  });
  app.put('/api/settings', { preHandler: auth }, async req => {
    const s = updateSettings(getSettings(req.s.tenant_id), req.body);
    saveSettings(req.s.tenant_id, s);
    return { ...s, slug: req.s.slug, today: nowIn(s.timezone).date, whatsappAvailable: evo.enabled };
  });

  registerWhatsapp(app, { db, evo, messenger, auth, getSettings, saveSettings });
  registerBooking(app, { db, messenger, push, limitBook });
  registerPush(app, { db, auth, push });

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

  if (publicDir) {
    // Link de agendamento do salão. Arquivos (app.js, style.css…) também caem aqui.
    // Páginas com a marca do domínio (nome, cores, ícones)
    const pages = new Map();
    const page = (file, brand) => {
      if (!pages.has(file)) pages.set(file, fs.readFileSync(path.join(publicDir, file), 'utf8'));
      return brandHtml(pages.get(file), brand);
    };
    const html = (reply, file, brand) => reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(page(file, brand));

    // Link de agendamento do salão. Arquivos (app.js, style.css…) também caem aqui.
    app.get('/:slug', async (req, reply) => {
      const slug = req.params.slug;
      const brand = brandFor(req.hostname);
      if (!slug || slug === 'index.html') return html(reply, 'index.html', brand);
      if (slug === 'manifest.json') return reply.header('Cache-Control', 'no-cache').type('application/manifest+json').send(manifestFor(brand));
      if (brand.files?.[slug]) return reply.header('Cache-Control', 'no-cache').sendFile(brand.files[slug]);
      if (slug.includes('.')) return reply.sendFile(slug);
      if (!/^[a-z0-9-]{1,50}$/.test(slug) || !db.prepare('SELECT 1 FROM tenants WHERE slug = ?').get(slug)) {
        return reply.code(404).type('text/html').send('<meta charset="utf-8"><p style="font:18px system-ui;padding:2rem">Link não encontrado.</p>');
      }
      return html(reply, 'agendar.html', brand);
    });
  }

  app.addHook('onClose', async () => db.close());
  return app;
}
