// Entry point: `node src/index.ts` (Node.js >= 22.18 runs TypeScript natively).
import { createHash } from 'node:crypto';
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

// Without a data folder (DATA_DIR=memory, e.g. free Render) the server's key would change on every
// restart; SERVER_SECRET (any long random string) keeps it, and so the server's id, the same.
const secretText = process.env.SERVER_SECRET?.trim();
const secret = secretText && secretText.length >= 32 ? new Uint8Array(createHash('sha256').update(secretText).digest()) : undefined;
if (secretText && !secret) log('SERVER_SECRET is shorter than 32 characters: ignored');

const relay = await startRelay({
  secret,
  port,
  host: process.env.HOST ?? '0.0.0.0',
  dataDir,
  name: process.env.RELAY_NAME ?? 'Veil Relay',
  log,
  mailer,
  ice,
  // Behind Render, nginx or another proxy: TRUST_PROXY=1 (the number of proxies in front).
  trustProxy: Math.max(0, Math.floor(Number(process.env.TRUST_PROXY) || 0)),
  // RECOVERY_DELAY_HOURS: how long recovery by email alone waits for the owner to object (default 168 = 7 days).
  ...(process.env.RECOVERY_DELAY_HOURS !== undefined && Number(process.env.RECOVERY_DELAY_HOURS) >= 0
    ? { recoveryDelayMs: Number(process.env.RECOVERY_DELAY_HOURS) * 60 * 60_000 }
    : {}),
  ...(Number(process.env.REGISTRATIONS_PER_HOUR) > 0 ? { registrationsPerHour: Number(process.env.REGISTRATIONS_PER_HOUR) } : {}),
});

const shutdown = async () => {
  await relay.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
