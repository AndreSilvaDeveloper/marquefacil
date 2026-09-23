import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// Cada registro do app (cliente, horário, venda…) fica guardado como JSON em `records`,
// separado por salão (tenant). `seq` cresce a cada mudança, para os aparelhos
// buscarem só o que mudou desde a última vez.
export const COLLECTIONS = ['clients', 'services', 'products', 'appts', 'sales'];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      settings TEXT NOT NULL DEFAULT '{}',
      seq INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      coll TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      seq INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, coll, id)
    );
    CREATE INDEX IF NOT EXISTS records_seq ON records (tenant_id, seq);
    CREATE INDEX IF NOT EXISTS records_appt_date ON records (tenant_id, coll, json_extract(data, '$.date'));
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      appt_id TEXT,
      kind TEXT NOT NULL,
      phone TEXT,
      name TEXT,
      body TEXT,
      status TEXT NOT NULL,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      UNIQUE (tenant_id, appt_id, kind)
    );
    CREATE INDEX IF NOT EXISTS messages_recent ON messages (tenant_id, created_at);
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_subs (
      endpoint TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id TEXT,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS handoffs (
      code TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

// Grava várias mudanças de uma vez e devolve o novo `seq` do salão.
export function applyChanges(db, tenantId, changes) {
  const bump = db.prepare('UPDATE tenants SET seq = seq + 1 WHERE id = ? RETURNING seq');
  const upsert = db.prepare(`
    INSERT INTO records (tenant_id, coll, id, data, deleted, seq, updated_at)
    VALUES (@tenantId, @coll, @id, @data, @deleted, @seq, @now)
    ON CONFLICT (tenant_id, coll, id) DO UPDATE SET
      data = excluded.data, deleted = excluded.deleted, seq = excluded.seq, updated_at = excluded.updated_at`);
  const run = db.transaction(list => {
    let seq = db.prepare('SELECT seq FROM tenants WHERE id = ?').get(tenantId).seq;
    const now = Date.now();
    for (const c of list) {
      seq = bump.get(tenantId).seq;
      upsert.run({
        tenantId, coll: c.coll, id: c.id, now, seq,
        data: c.deleted ? null : JSON.stringify(c.data),
        deleted: c.deleted ? 1 : 0,
      });
    }
    return seq;
  });
  return run(changes);
}

export function changesSince(db, tenantId, since) {
  const rows = db.prepare(
    'SELECT coll, id, data, deleted, seq FROM records WHERE tenant_id = ? AND seq > ? ORDER BY seq',
  ).all(tenantId, since);
  const seq = db.prepare('SELECT seq FROM tenants WHERE id = ?').get(tenantId).seq;
  return {
    seq,
    changes: rows.map(r => r.deleted
      ? { coll: r.coll, id: r.id, deleted: true }
      : { coll: r.coll, id: r.id, data: JSON.parse(r.data) }),
  };
}

// Cópia diária do banco (mantém as últimas `keep`)
export function startBackups(db, dir, keep = 14) {
  const run = async () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const name = `marquefacil-${new Date().toISOString().slice(0, 10)}.db`;
      await db.backup(path.join(dir, name));
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort();
      for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(dir, f));
    } catch (e) {
      console.error('backup falhou:', e);
    }
  };
  run();
  return setInterval(run, 24 * 60 * 60 * 1000);
}
