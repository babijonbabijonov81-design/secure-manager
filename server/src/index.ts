// Entry point: `node src/index.ts` (Node.js >= 22.18 runs TypeScript natively).
import { resolve } from 'node:path';
import { startRelay } from './relay.ts';

const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.DATA_DIR === 'memory' ? null : resolve(process.env.DATA_DIR ?? 'data');

const relay = await startRelay({
  port,
  host: process.env.HOST ?? '0.0.0.0',
  dataDir,
  name: process.env.RELAY_NAME ?? 'Veil Relay',
  log: (message) => console.log(`[${new Date().toISOString()}] ${message}`),
});

const shutdown = async () => {
  await relay.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
