// Entry point: `node src/index.ts` (Node.js >= 22.18 runs TypeScript natively).
import { resolve } from 'node:path';
import { mailerFromEnv } from './mailer.ts';
import { startRelay } from './relay.ts';

const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.DATA_DIR === 'memory' ? null : resolve(process.env.DATA_DIR ?? 'data');

const log = (message: string) => console.log(`[${new Date().toISOString()}] ${message}`);
const mailer = mailerFromEnv(process.env, log);
if (!mailer) log('email is not configured: recovery by email is disabled (see README)');

// Calls: STUN finds a direct route; TURN relays audio when there is none (strict NATs) and
// lets users hide their IP. Without TURN_URLS clients fall back to public STUN servers.
const list = (value: string | undefined) => (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
const ice = {
  stun: list(process.env.STUN_URLS),
  turn: list(process.env.TURN_URLS),
  secret: process.env.TURN_SECRET || undefined,
  username: process.env.TURN_USERNAME || undefined,
  credential: process.env.TURN_PASSWORD || undefined,
};
if (ice.turn.length && !ice.secret && !(ice.username && ice.credential)) log('TURN_URLS is set without TURN_SECRET or TURN_USERNAME/TURN_PASSWORD: ignored');

const relay = await startRelay({
  port,
  host: process.env.HOST ?? '0.0.0.0',
  dataDir,
  name: process.env.RELAY_NAME ?? 'Veil Relay',
  log,
  mailer,
  ice,
  ...(Number(process.env.REGISTRATIONS_PER_HOUR) > 0 ? { registrationsPerHour: Number(process.env.REGISTRATIONS_PER_HOUR) } : {}),
});

const shutdown = async () => {
  await relay.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
