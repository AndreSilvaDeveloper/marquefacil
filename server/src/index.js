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
  evolution: { url: env.EVOLUTION_URL, apikey: env.EVOLUTION_APIKEY },
  publicUrl: env.PUBLIC_URL || (env.DOMAIN ? `https://${env.DOMAIN}` : ''),
  logger: { level: env.LOG_LEVEL || 'info' },
  // proteção contra bloqueio do WhatsApp: 8 a 20 s entre mensagens e 1,5 a 3,5 s de "digitando…"
  sendGap: [Number(env.WA_GAP_MIN || 8000), Number(env.WA_GAP_MAX || 20000)],
  typing: [Number(env.WA_TYPING_MIN || 1500), Number(env.WA_TYPING_MAX || 3500)],
});

startBackups(app.db, path.join(dataDir, 'backups'));
app.messenger.startScheduler(); // lembretes pelo WhatsApp
app.alerts.start();             // avisos no celular da profissional
app.payments.start();           // confere pagamentos online em aberto (se o aviso do banco não chegar)

const port = Number(env.PORT || 3000);
app.listen({ port, host: '0.0.0.0' }).catch(err => { app.log.error(err); process.exit(1); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
