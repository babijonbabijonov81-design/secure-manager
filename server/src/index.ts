// Entry point: `node src/index.ts` (Node.js >= 22.18 runs TypeScript natively).
import { resolve } from 'node:path';
import { mailerFromEnv } from './mailer.ts';
import { startRelay } from './relay.ts';

const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.DATA_DIR === 'memory' ? null : resolve(process.env.DATA_DIR ?? 'data');

const log = (message: string) => console.log(`[${new Date().toISOString()}] ${message}`);
const mailer = mailerFromEnv(process.env, log);
if (!mailer) log('email is not configured: recovery by email is disabled (see README)');

const relay = await startRelay({
  port,
  host: process.env.HOST ?? '0.0.0.0',
  dataDir,
  name: process.env.RELAY_NAME ?? 'Veil Relay',
  log,
  mailer,
});

const shutdown = async () => {
  await relay.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
