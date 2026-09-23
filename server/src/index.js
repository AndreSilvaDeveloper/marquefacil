import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { startBackups } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const dataDir = path.resolve(env.DATA_DIR || path.join(here, '../../data'));

const app = buildApp({
  dbFile: path.join(dataDir, 'marquefacil.db'),
  publicDir: path.resolve(env.PUBLIC_DIR || path.join(here, '../../public')),
  allowSignup: env.ALLOW_SIGNUP !== 'false',
  secureCookies: env.NODE_ENV === 'production',
  handoffOrigins: env.HANDOFF_ORIGINS || '*',
  evolution: { url: env.EVOLUTION_URL, apikey: env.EVOLUTION_APIKEY },
  publicUrl: env.PUBLIC_URL || (env.DOMAIN ? `https://${env.DOMAIN}` : ''),
  logger: { level: env.LOG_LEVEL || 'info' },
});

startBackups(app.db, path.join(dataDir, 'backups'));
app.messenger.startScheduler(); // lembretes pelo WhatsApp

const port = Number(env.PORT || 3000);
app.listen({ port, host: '0.0.0.0' }).catch(err => { app.log.error(err); process.exit(1); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
