import webpush from 'web-push';
import { fail, isObj } from './util.js';

// Notificações no celular/computador da profissional (Web Push).
// As chaves VAPID são criadas uma vez e ficam no banco (tabela kv).
export function createPush({ db, subject = 'mailto:contato@maquefacil.com.br', sender = null, log = console }) {
  const get = db.prepare('SELECT value FROM kv WHERE key = ?');
  let keys = get.get('vapid')?.value;
  if (keys) keys = JSON.parse(keys);
  else {
    keys = webpush.generateVAPIDKeys();
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('vapid', JSON.stringify(keys));
  }
  const send = sender || ((sub, payload) => webpush.sendNotification(sub, payload, {
    vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 24 * 3600, urgency: 'high',
  }));

  const q = {
    subs: db.prepare('SELECT endpoint, data FROM push_subs WHERE tenant_id = ?'),
    del: db.prepare('DELETE FROM push_subs WHERE endpoint = ?'),
  };

  // Manda para todos os aparelhos do salão; tira os que não existem mais
  async function notifyTenant(tenantId, payload) {
    const body = JSON.stringify(payload);
    let ok = 0;
    await Promise.all(q.subs.all(tenantId).map(async s => {
      try { await send(JSON.parse(s.data), body); ok++; }
      catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) q.del.run(s.endpoint);
        else log.warn?.({ err: e.message }, 'push: falha ao enviar');
      }
    }));
    return ok;
  }

  return { publicKey: keys.publicKey, notifyTenant };
}

export function registerPush(app, { db, auth, push }) {
  app.get('/api/push/key', async () => ({ key: push.publicKey }));

  app.post('/api/push/subscribe', { preHandler: auth }, async req => {
    const sub = req.body?.subscription;
    if (!isObj(sub) || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !isObj(sub.keys)) {
      fail(400, 'Inscrição inválida.');
    }
    db.prepare(`INSERT INTO push_subs (endpoint, tenant_id, user_id, data, created_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (endpoint) DO UPDATE SET tenant_id = excluded.tenant_id, user_id = excluded.user_id, data = excluded.data`)
      .run(sub.endpoint, req.s.tenant_id, req.s.user_id, JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }), Date.now());
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', { preHandler: auth }, async req => {
    db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND tenant_id = ?').run(String(req.body?.endpoint || ''), req.s.tenant_id);
    return { ok: true };
  });

  app.post('/api/push/test', { preHandler: auth }, async req => {
    const n = await push.notifyTenant(req.s.tenant_id, { title: '🔔 Avisos ligados', body: 'É assim que os pedidos de agendamento vão chegar.', url: '/#/agenda' });
    if (!n) fail(400, 'Nenhum aparelho com avisos ligados.');
    return { ok: true, devices: n };
  });
}
