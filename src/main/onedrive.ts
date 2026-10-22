// «Копия в OneDrive»: sign-in with a Microsoft account and the app's own folder in OneDrive.
//
// Sign-in is the OAuth 2.0 authorization code flow with PKCE for desktop apps (RFC 8252): the
// system browser opens Microsoft's page, the answer comes back to a one-time server on
// 127.0.0.1. There is no client secret. The only permission asked for is
// Files.ReadWrite.AppFolder — the folder «Приложения/Veil», nothing else in the user's OneDrive —
// plus offline_access for the daily copy. Only files already encrypted by Veil pass through here;
// the Veil relay is never involved. Tokens are not logged and not written to disk here (the
// renderer keeps the refresh token inside the encrypted vault).
//
// Pure Node (no Electron import), so the tests can run it against a fake Microsoft.

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export interface OneDriveOptions {
  clientId: string;
  openBrowser(url: string): void;
  loginBase?: string;
  graphBase?: string;
  /** How long the browser sign-in may take. */
  signInTimeoutMs?: number;
}

export interface CloudFile {
  name: string;
  size: number;
  modified: number;
}

const SCOPE = 'Files.ReadWrite.AppFolder offline_access';
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
// Upload session chunks must be multiples of 320 KiB.
const CHUNK = 320 * 1024 * 20;
const NAME_RE = /^veil-[a-z0-9]{6,40}\.veil$/;

const b64url = (bytes: Buffer) => bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class CloudError extends Error {
  constructor(
    readonly code: 'not_configured' | 'cancelled' | 'auth' | 'network' | 'not_found' | 'quota' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

const page = (title: string, text: string) =>
  `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Veil</title><body style="font:16px system-ui;display:grid;place-items:center;height:90vh;margin:0;background:#faf7f2;color:#1b1714"><div style="text-align:center"><h2>${title}</h2><p>${text}</p></div></body></html>`;

export class OneDrive {
  private readonly login: string;
  private readonly graph: string;
  /** Access tokens in memory only, by a hash of the refresh token they came from. */
  private readonly access = new Map<string, { token: string; until: number; refresh: string }>();
  private pending: { server: Server; reject(error: Error): void } | null = null;

  constructor(private readonly options: OneDriveOptions) {
    this.login = options.loginBase ?? 'https://login.microsoftonline.com/common/oauth2/v2.0';
    this.graph = options.graphBase ?? 'https://graph.microsoft.com/v1.0';
  }

  get configured(): boolean {
    return /^[0-9a-f-]{36}$/i.test(this.options.clientId);
  }

  /** Opens Microsoft's sign-in page in the browser; resolves to a refresh token. */
  async signIn(): Promise<string> {
    if (!this.configured) throw new CloudError('not_configured', 'В этой сборке Veil вход через Microsoft не настроен');
    this.cancel();
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(16));

    const { code, redirect } = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
      let redirect = '';
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== '/') {
          res.writeHead(404).end();
          return;
        }
        const finish = (error: Error | null, value?: string) => {
          clearTimeout(timer);
          this.pending = null;
          server.close();
          if (error) reject(error);
          else resolve({ code: value!, redirect });
        };
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
        if (url.searchParams.get('state') !== state) {
          res.end(page('Ссылка не подошла', 'Вернитесь в Veil и попробуйте ещё раз.'));
          return finish(new CloudError('auth', 'Вход не подтверждён'));
        }
        const code = url.searchParams.get('code');
        if (!code) {
          const denied = url.searchParams.get('error') === 'access_denied';
          res.end(page(denied ? 'Вход отменён' : 'Не получилось', 'Можно закрыть эту вкладку и вернуться в Veil.'));
          return finish(new CloudError(denied ? 'cancelled' : 'auth', denied ? 'Вход отменён' : 'Microsoft не подтвердил вход'));
        }
        res.end(page('Готово', 'Можно закрыть эту вкладку и вернуться в Veil.'));
        finish(null, code);
      });
      const timer = setTimeout(() => {
        this.pending = null;
        server.close();
        reject(new CloudError('cancelled', 'Время на вход вышло'));
      }, this.options.signInTimeoutMs ?? 5 * 60_000);
      this.pending = {
        server,
        reject: (error) => {
          clearTimeout(timer);
          server.close();
          reject(error);
        },
      };
      server.on('error', (error) => this.pending?.reject(new CloudError('network', error.message)));
      // Only this computer can reach it.
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as { port: number };
        redirect = `http://localhost:${port}`;
        const params = new URLSearchParams({
          client_id: this.options.clientId,
          response_type: 'code',
          redirect_uri: redirect,
          response_mode: 'query',
          scope: SCOPE,
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          prompt: 'select_account',
        });
        this.options.openBrowser(`${this.login}/authorize?${params}`);
      });
    });

    const token = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier });
    return token.refresh;
  }

  /** Stops a sign-in that is waiting for the browser. */
  cancel(): void {
    this.pending?.reject(new CloudError('cancelled', 'Вход отменён'));
    this.pending = null;
  }

  private async tokenRequest(fields: Record<string, string>): Promise<{ token: string; refresh: string; until: number }> {
    let res: Response;
    try {
      res = await fetch(`${this.login}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.options.clientId, scope: SCOPE, ...fields }),
      });
    } catch {
      throw new CloudError('network', 'Нет связи с Microsoft');
    }
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!res.ok || !data.access_token) throw new CloudError('auth', 'Microsoft отклонил вход — подключите OneDrive заново');
    const result = { token: data.access_token, refresh: data.refresh_token ?? fields.refresh_token ?? '', until: Date.now() + ((data.expires_in ?? 3600) - 120) * 1000 };
    this.access.set(this.keyOf(result.refresh), result);
    return result;
  }

  private keyOf(refresh: string): string {
    return createHash('sha256').update(refresh).digest('base64');
  }

  /** A fresh access token; Microsoft may hand out a new refresh token, which is returned. */
  private async authorize(refresh: string): Promise<{ token: string; refresh: string }> {
    const cached = this.access.get(this.keyOf(refresh));
    if (cached && cached.until > Date.now()) return cached;
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
  }

  private async call(refresh: string, path: string, init: RequestInit = {}): Promise<{ res: Response; refresh: string }> {
    const auth = await this.authorize(refresh);
    let res: Response;
    try {
      res = await fetch(`${this.graph}${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${auth.token}` } });
    } catch {
      throw new CloudError('network', 'Нет связи с OneDrive');
    }
    if (res.status === 401) {
      this.access.delete(this.keyOf(refresh));
      throw new CloudError('auth', 'Доступ к OneDrive истёк — подключите его заново');
    }
    if (res.status === 404) throw new CloudError('not_found', 'Копия в OneDrive не найдена');
    if (res.status === 507) throw new CloudError('quota', 'В OneDrive не хватает места');
    if (!res.ok) throw new CloudError('failed', `OneDrive ответил ошибкой ${res.status}`);
    return { res, refresh: auth.refresh };
  }

  /** The Veil copies in the app folder. */
  async list(refresh: string): Promise<{ refresh: string; files: CloudFile[] }> {
    const { res, refresh: next } = await this.call(refresh, '/me/drive/special/approot/children?$select=name,size,lastModifiedDateTime&$top=200');
    const data = (await res.json()) as { value?: { name: string; size: number; lastModifiedDateTime: string }[] };
    const files = (data.value ?? [])
      .filter((f) => NAME_RE.test(f.name))
      .map((f) => ({ name: f.name, size: f.size, modified: Date.parse(f.lastModifiedDateTime) || 0 }))
      .sort((a, b) => b.modified - a.modified);
    return { refresh: next, files };
  }

  /** Replaces the copy `name` with `data` (already encrypted). */
  async upload(refresh: string, name: string, data: Uint8Array): Promise<{ refresh: string }> {
    if (!NAME_RE.test(name)) throw new CloudError('failed', 'Неверное имя файла');
    const path = `/me/drive/special/approot:/${name}`;
    if (data.length <= SIMPLE_UPLOAD_MAX) {
      const { refresh: next } = await this.call(refresh, `${path}:/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.from(data),
      });
      return { refresh: next };
    }
    const { res, refresh: next } = await this.call(refresh, `${path}:/createUploadSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
    });
    const { uploadUrl } = (await res.json()) as { uploadUrl?: string };
    if (!uploadUrl) throw new CloudError('failed', 'OneDrive не принял файл');
    // The upload URL carries its own authorization: no token goes with the chunks.
    for (let start = 0; start < data.length; start += CHUNK) {
      const end = Math.min(start + CHUNK, data.length);
      let part: Response;
      try {
        part = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes ${start}-${end - 1}/${data.length}` },
          body: Buffer.from(data.subarray(start, end)),
        });
      } catch {
        throw new CloudError('network', 'Связь с OneDrive прервалась');
      }
      if (part.status === 507) throw new CloudError('quota', 'В OneDrive не хватает места');
      if (!part.ok) throw new CloudError('failed', `OneDrive ответил ошибкой ${part.status}`);
    }
    return { refresh: next };
  }

  async download(refresh: string, name: string): Promise<{ refresh: string; data: Uint8Array }> {
    if (!NAME_RE.test(name)) throw new CloudError('failed', 'Неверное имя файла');
    const { res, refresh: next } = await this.call(refresh, `/me/drive/special/approot:/${name}:/content`);
    return { refresh: next, data: new Uint8Array(await res.arrayBuffer()) };
  }

  async remove(refresh: string, name: string): Promise<{ refresh: string }> {
    if (!NAME_RE.test(name)) throw new CloudError('failed', 'Неверное имя файла');
    try {
      const { refresh: next } = await this.call(refresh, `/me/drive/special/approot:/${name}`, { method: 'DELETE' });
      return { refresh: next };
    } catch (error) {
      if (error instanceof CloudError && error.code === 'not_found') return { refresh };
      throw error;
    }
  }

  /** Forgets the access token made from this refresh token. */
  forget(refresh: string): void {
    this.access.delete(this.keyOf(refresh));
  }
}
