// «Копия в OneDrive» against a fake Microsoft: PKCE sign-in through the loopback redirect, the
// app folder only, chunked upload, and what leaves the computer is an encrypted .veil file that
// holds no OneDrive token and no plain text.
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openBackupFile } from '../src/core/backup-file.ts';
import { WrongPasswordError } from '../src/core/crypto/vault.ts';
import { restoreBackupFile, setCloudTransport } from '../src/core/messenger.ts';
import { MemoryStorage } from '../src/core/storage.ts';
import { OneDrive } from '../src/main/onedrive.ts';
import { FAST_KDF, makeUser, testRelay, waitFor, type TestRelay } from './helpers.ts';

const CLIENT = '11111111-2222-3333-4444-555555555555';

interface Fake {
  url: string;
  files: Map<string, Buffer>;
  paths: string[];
  sessions: number;
  close(): Promise<void>;
}

/** Just enough of login.microsoftonline.com and Graph to run the real code against. */
async function fakeMicrosoft(): Promise<Fake> {
  const files = new Map<string, Buffer>();
  const paths: string[] = [];
  const codes = new Map<string, string>();
  const tokens = new Set<string>();
  let counter = 0;
  const fake = { files, paths, sessions: 0 } as Fake;
  const body = (req: import('node:http').IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => parts.push(c));
      req.on('end', () => resolve(Buffer.concat(parts)));
    });
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    paths.push(`${req.method} ${url.pathname}`);
    const json = (status: number, value: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (url.pathname === '/login/authorize') {
      expect(url.searchParams.get('client_id')).toBe(CLIENT);
      expect(url.searchParams.get('scope')).toBe('Files.ReadWrite.AppFolder offline_access');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      const code = `code${++counter}`;
      codes.set(code, url.searchParams.get('code_challenge')!);
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state')!);
      return res.writeHead(302, { Location: back.toString() }).end();
    }
    if (url.pathname === '/login/token') {
      const form = new URLSearchParams((await body(req)).toString());
      if (form.get('grant_type') === 'authorization_code') {
        const challenge = codes.get(form.get('code')!);
        const expected = createHash('sha256').update(form.get('code_verifier')!).digest('base64url');
        if (!challenge || challenge !== expected) return json(400, { error: 'invalid_grant' });
        codes.delete(form.get('code')!);
      } else if (form.get('grant_type') !== 'refresh_token' || !form.get('refresh_token')?.startsWith('refresh')) return json(400, { error: 'invalid_grant' });
      const access = `access${++counter}`;
      tokens.add(access);
      return json(200, { access_token: access, refresh_token: `refresh${counter}`, expires_in: 3600 });
    }
    if (url.pathname.startsWith('/upload/')) {
      // The upload URL carries its own authorization.
      expect(req.headers.authorization).toBeUndefined();
      const name = decodeURIComponent(url.pathname.slice(8));
      const [, start, end, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(String(req.headers['content-range']))!.map(Number);
      const chunk = await body(req);
      expect(chunk.length).toBe(end - start + 1);
      const sofar = start === 0 ? Buffer.alloc(0) : (files.get(`${name}.part`) ?? Buffer.alloc(0));
      expect(sofar.length).toBe(start);
      const next = Buffer.concat([sofar, chunk]);
      if (next.length === total) {
        files.set(name, next);
        files.delete(`${name}.part`);
        return json(201, { name });
      }
      files.set(`${name}.part`, next);
      return json(202, { nextExpectedRanges: [`${next.length}-`] });
    }
    if (!url.pathname.startsWith('/graph/')) return res.writeHead(404).end();
    if (!tokens.has(String(req.headers.authorization).replace('Bearer ', ''))) return json(401, {});
    const path = decodeURIComponent(url.pathname.slice(6));
    // Only the app folder exists for this app.
    if (!path.startsWith('/me/drive/special/approot')) return json(403, {});
    if (path === '/me/drive/special/approot/children') {
      return json(200, { value: [...files].filter(([n]) => !n.endsWith('.part')).map(([name, data]) => ({ name, size: data.length, lastModifiedDateTime: new Date().toISOString() })) });
    }
    const match = /^\/me\/drive\/special\/approot:\/([^:]+)(?::\/(content|createUploadSession))?$/.exec(path);
    if (!match) return json(404, {});
    const [, name, op] = match;
    if (op === 'content' && req.method === 'PUT') {
      files.set(name, await body(req));
      return json(201, { name });
    }
    if (op === 'content' && req.method === 'GET') {
      const data = files.get(name);
      return data ? res.writeHead(200).end(data) : json(404, {});
    }
    if (op === 'createUploadSession') {
      fake.sessions++;
      return json(200, { uploadUrl: `${fake.url}/upload/${encodeURIComponent(name)}` });
    }
    if (!op && req.method === 'DELETE') {
      files.delete(name);
      return res.writeHead(204).end();
    }
    return json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  fake.close = () => new Promise((resolve) => server.close(() => resolve()));
  return fake;
}

/** The "browser": follows Microsoft's redirect back to Veil's loopback address. */
const browser = (url: string) =>
  void fetch(url, { redirect: 'manual' }).then((res) => {
    const location = res.headers.get('location')!;
    return fetch(location.replace('http://localhost:', 'http://127.0.0.1:'));
  });

let t: TestRelay;
let ms: Fake;
let drive: OneDrive;
beforeAll(async () => {
  t = await testRelay();
  ms = await fakeMicrosoft();
  drive = new OneDrive({ clientId: CLIENT, openBrowser: browser, loginBase: `${ms.url}/login`, graphBase: `${ms.url}/graph` });
  setCloudTransport({
    signIn: () => drive.signIn(),
    upload: (r, n, d) => drive.upload(r, n, d),
    remove: (r, n) => drive.remove(r, n),
    forget: async (r) => drive.forget(r),
  });
});
afterAll(async () => {
  setCloudTransport(null);
  await ms.close();
  await t.relay.close();
});

describe('OneDrive client', () => {
  it('needs a client ID and signs in with PKCE through the loopback address', async () => {
    const off = new OneDrive({ clientId: '', openBrowser: () => {} });
    expect(off.configured).toBe(false);
    await expect(off.signIn()).rejects.toMatchObject({ code: 'not_configured' });

    const refresh = await drive.signIn();
    expect(refresh).toMatch(/^refresh/);
    const big = new Uint8Array(9 * 1024 * 1024).map((_, i) => i % 251);
    const sessions = ms.sessions;
    await drive.upload(refresh, 'veil-abcdefgh.veil', big);
    expect(ms.sessions).toBe(sessions + 1);
    expect(Buffer.compare(ms.files.get('veil-abcdefgh.veil')!, Buffer.from(big))).toBe(0);
    const { files } = await drive.list(refresh);
    expect(files.map((f) => f.name)).toContain('veil-abcdefgh.veil');
    const { data } = await drive.download(refresh, 'veil-abcdefgh.veil');
    expect(data.length).toBe(big.length);
    await drive.remove(refresh, 'veil-abcdefgh.veil');
    expect(ms.files.has('veil-abcdefgh.veil')).toBe(false);
    // Only names Veil makes itself, never a path elsewhere in the OneDrive.
    await expect(drive.upload(refresh, '../Documents/x.veil', big)).rejects.toMatchObject({ code: 'failed' });
    expect(ms.paths.every((p) => !p.startsWith('GET /graph') || p.includes('/approot'))).toBe(true);
  });
});

describe('«Копия в OneDrive»', () => {
  it('uploads an encrypted copy that restores with the copy password', async () => {
    const anna = await makeUser(t.url, 'anna');
    const boris = await makeUser(t.url, 'boris');
    await anna.messenger.addContact(boris.username);
    await anna.messenger.sendText(boris.id, 'пароль от сейфа 4821');
    anna.messenger.addNote({ text: 'заметка только для меня' });

    const refresh = await anna.messenger.cloudSignIn();
    await expect(anna.messenger.enableCloud(refresh, 'короткий')).rejects.toMatchObject({ code: 'short' });
    await anna.messenger.enableCloud(refresh, 'Длинный-пароль-копии-2026', { kdf: FAST_KDF });
    const cloud = anna.messenger.getSnapshot().cloud!;
    expect(cloud.lastAt).toBeGreaterThan(0);
    expect(JSON.stringify(anna.messenger.getSnapshot().cloud)).not.toMatch(/refresh|access/);

    const [name, file] = [...ms.files].find(([n]) => n.startsWith('veil-'))!;
    expect(name).toMatch(/^veil-[a-z2-7]{12}\.veil$/);
    expect(name).not.toContain(anna.username);
    // Nothing readable leaves the computer.
    for (const plain of ['пароль от сейфа', 'заметка только для меня', anna.username, 'refresh', 'Длинный-пароль']) {
      expect(file.includes(Buffer.from(plain))).toBe(false);
    }
    await expect(openBackupFile(new Uint8Array(file), 'не тот пароль копии')).rejects.toBeInstanceOf(WrongPasswordError);
    const records = await openBackupFile(new Uint8Array(file), 'Длинный-пароль-копии-2026');
    expect(records.has('account')).toBe(true);
    // The OneDrive sign-in and the copy key stay on this computer.
    expect(records.has('cloud')).toBe(false);

    // A new computer: the copy comes back with its password.
    const restored = await restoreBackupFile(
      { storage: new MemoryStorage(), file: new Uint8Array(file), backupPassword: 'Длинный-пароль-копии-2026', password: 'new-veil-password', kdf: FAST_KDF },
      {},
    );
    await waitFor(() => restored.getSnapshot().status === 'online');
    expect(restored.getSnapshot().me.username).toBe(anna.username);
    expect(restored.getSnapshot().conversations[boris.id]?.some((m) => m.text === 'пароль от сейфа 4821')).toBe(true);
    await restored.lock();

    // Turning it off can delete the copy too.
    await anna.messenger.disableCloud(true);
    expect(ms.files.has(name)).toBe(false);
    expect(anna.messenger.getSnapshot().cloud).toBeUndefined();
    expect(anna.messenger.getSnapshot().securityLog.map((e) => e.kind)).toEqual(expect.arrayContaining(['cloud_on', 'cloud_off']));
  });
});
