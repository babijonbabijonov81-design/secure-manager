// The relay runs as plain `node server/src/index.ts` (Render, Docker): Node only strips types, so
// TypeScript-only syntax (parameter properties, enums) would stop it before it starts.
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

it('starts with node alone and answers /health', async () => {
  const child = spawn(process.execPath, ['server/src/index.ts'], {
    env: { ...process.env, PORT: '0', DATA_DIR: 'memory', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`no start: ${out}`)), 15_000);
      const read = (chunk: Buffer) => {
        out += chunk;
        const match = /listening on :(\d+)/.exec(out);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.on('exit', () => reject(new Error(`exited: ${out}`)));
    });
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(health).toMatchObject({ ok: true });
    expect(health.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  } finally {
    child.kill();
  }
});
