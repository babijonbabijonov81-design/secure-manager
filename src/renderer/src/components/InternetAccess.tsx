import { Check, Copy, Globe, Loader2, Router, ShieldCheck, TriangleAlert, Waypoints, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isLanServer } from '../../../core/invite.ts';
import type { Messenger } from '../../../core/messenger.ts';
import { bridge, type EmbeddedServerStatus, type ReachConfig, type ReachLevel, type ReachStatus } from '../../../core/platform.ts';
import type { MessengerSnapshot } from '../../../core/types.ts';
import { Toggle, useToast } from '../lib/ui.tsx';

/** Settings → Сервер → «Доступен из интернета»: the server on this computer for other networks. */
export function InternetAccess({
  embedded,
  messenger,
  snapshot,
}: {
  embedded: EmbeddedServerStatus;
  messenger?: Messenger;
  snapshot?: MessengerSnapshot;
}) {
  const [config, setConfig] = useState<ReachConfig | null>(null);
  const [status, setStatus] = useState<ReachStatus | null>(null);
  const [relayInput, setRelayInput] = useState('');
  const [manualInput, setManualInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!bridge) return;
    void bridge.server.reachConfig().then((c) => {
      setConfig(c);
      // By default the tunnel goes through the server this account uses (if it is on the internet).
      const own = snapshot?.me.serverUrl ?? '';
      setRelayInput(c.publicRelay || (own && !isLanServer(own) ? own : ''));
      setManualInput(c.manual);
    });
    void bridge.server.reachStatus().then(setStatus);
    return bridge.server.onReach(setStatus);
  }, [snapshot?.me.serverUrl]);

  if (!bridge || !config) return null;

  const save = async (patch: Partial<ReachConfig>) => {
    setError('');
    const next = { ...config, ...patch };
    if (next.internet && !next.publicRelay.trim() && !next.manual.trim()) {
      setError('Укажите публичный ретранслятор (например, ваш сервер на Render) — через него работает туннель');
      return;
    }
    setBusy(true);
    try {
      setConfig(next);
      setStatus(await bridge!.server.configure(patch));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // An invite to MY account works for outsiders only if that account lives on this server.
  const myServerHere = !!snapshot && !!embedded.id && snapshot.me.serverId === embedded.id;
  const copyInvite = async () => {
    if (!messenger || !status) return;
    try {
      const registration = config.inviteOnly ? await bridge!.server.mintInvite() : undefined;
      const link = messenger.createInvite({ addresses: status.addresses, ...(registration ? { registration } : {}) });
      await navigator.clipboard.writeText(link);
      toast('Приглашение скопировано: по нему можно зарегистрироваться на этом сервере и сразу написать вам', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="internet-access" data-testid="internet-access">
      <div className="setting-row" style={{ padding: 0, border: 0 }}>
        <div className="grow">
          <b>Доступен из интернета</b>
          <span>Чтобы к серверу этого компьютера подключались люди из других сетей, а не только из вашей Wi-Fi.</span>
        </div>
        {busy ? <span className="spinner" /> : <Toggle label="Доступен из интернета" on={config.internet} onChange={(on) => void save({ internet: on, publicRelay: relayInput })} />}
      </div>

      <div className="field">
        <label className="field-label" htmlFor="public-relay">
          Публичный ретранслятор
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id="public-relay"
            className="input"
            placeholder="veil-relay.onrender.com"
            value={relayInput}
            onChange={(e) => setRelayInput(e.target.value)}
          />
          <button className="btn btn-secondary" disabled={busy || relayInput.trim() === config.publicRelay} onClick={() => void save({ publicRelay: relayInput })}>
            Сохранить
          </button>
        </div>
        <span className="field-hint">
          Через него идёт туннель и проверка доступа снаружи. Он видит те же метаданные, что и сервер на этом компьютере: кто подключён и
          сколько весят конверты, — но не содержимое.
        </span>
      </div>

      {error && <span className="field-error">{error}</span>}

      {config.internet && status && (
        <div className="reach-levels" data-testid="reach-levels">
          <Level icon={<Router size={18} />} title="Проброс порта на роутере" level={status.mapping} extra={status.mapping.method} />
          <Level icon={<Waypoints size={18} />} title="Туннель через ретранслятор" level={status.tunnel} />
          <Level icon={<Globe size={18} />} title="Свой адрес" level={status.manual} />
          {status.publicIp && <span className="field-hint">Публичный IP этого компьютера: {status.publicIp}</span>}
        </div>
      )}

      <div className="field">
        <label className="field-label" htmlFor="manual-address">
          Внешний адрес (по желанию)
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id="manual-address"
            className="input"
            placeholder="chat.example.com или 203.0.113.7:8787"
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
          />
          <button className="btn btn-secondary" disabled={busy || manualInput.trim() === config.manual} onClick={() => void save({ manual: manualInput })}>
            Проверить
          </button>
        </div>
        <details className="field-hint">
          <summary>Как открыть порт вручную</summary>
          Откройте настройки роутера (обычно 192.168.0.1 или 192.168.1.1), найдите «Проброс портов» / «Port forwarding» / «Виртуальные серверы» и
          направьте TCP-порт {embedded.port} на этот компьютер ({embedded.addresses.find((a) => !a.startsWith('localhost'))?.split(':')[0] ?? 'его адрес в Wi-Fi'}).
          Затем впишите сюда ваш внешний IP с портом или домен. Подойдёт и адрес из ngrok или cloudflared.
        </details>
      </div>

      <div className="setting-row" style={{ padding: 0, border: 0 }}>
        <div className="grow">
          <b>Регистрация только по приглашению</b>
          <span>Новые люди регистрируются на этом сервере только по ссылке veil:// от вас или ваших знакомых (до 5 в сутки), иначе сюда придут чужие и спамеры.</span>
        </div>
        <Toggle label="Регистрация только по приглашению" on={config.inviteOnly} onChange={(on) => void save({ inviteOnly: on })} />
      </div>

      <div className="setting-row" style={{ padding: 0, border: 0 }}>
        <div className="grow">
          <b>Не давать компьютеру засыпать</b>
          <span>Пока этот компьютер выключен или спит, сообщения через сервер не ходят. Veil может не давать ему засыпать, пока работает сервер.</span>
        </div>
        <Toggle label="Не давать компьютеру засыпать" on={config.keepAwake} onChange={(on) => void save({ keepAwake: on })} />
      </div>

      {config.internet && status && status.addresses.length > 0 && (
        <div className="invite-copy">
          {myServerHere ? (
            <button className="btn btn-primary" onClick={() => void copyInvite()}>
              <Copy size={15} /> Скопировать приглашение
            </button>
          ) : (
            <span className="field-hint">
              <ShieldCheck size={14} /> Ваш аккаунт на другом сервере. Друзья, которых вы зовёте сюда, получат ссылку от того, у кого аккаунт на этом
              компьютере.
            </span>
          )}
          <span className="field-hint">В приглашении — ключ этого сервера и все адреса: {status.addresses.join(', ')}.</span>
        </div>
      )}
    </div>
  );
}

function Level({ icon, title, level, extra }: { icon: React.ReactNode; title: string; level: ReachLevel; extra?: string }) {
  const badge =
    level.state === 'ok' ? (
      <span className="chip success">
        <Check size={13} /> Работает
      </span>
    ) : level.state === 'working' ? (
      <span className="chip">
        <Loader2 size={13} className="spin" /> Проверяем
      </span>
    ) : level.state === 'failed' ? (
      <span className="chip danger">
        <X size={13} /> Не вышло
      </span>
    ) : (
      <span className="chip">Не используется</span>
    );
  return (
    <div className={`reach-level ${level.state}`}>
      <div className="feature-icon">{icon}</div>
      <div className="grow">
        <b>
          {title}
          {extra ? ` · ${extra}` : ''}
        </b>
        {level.text && (
          <span>
            {level.state === 'failed' && <TriangleAlert size={12} />} {level.text}
          </span>
        )}
        {level.address && <code className="selectable">{level.address}</code>}
      </div>
      {badge}
    </div>
  );
}
