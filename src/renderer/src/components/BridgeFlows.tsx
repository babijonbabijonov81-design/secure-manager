import { ArrowLeft, Check, CloudUpload, Laptop, Loader2, MonitorSmartphone, RefreshCw, ShieldCheck, TriangleAlert, Wifi } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BridgeGuest, BridgeHost, formatCode, newCode, normalizeCode, ROOM_LENGTH, splitRelayCode, type BridgeChannel } from '../../../core/bridge.ts';
import { relayBridgeChannel } from '../../../core/bridge-relay.ts';
import { importAccount, type Messenger, type MessengerEvents } from '../../../core/messenger.ts';
import { bridge } from '../../../core/platform.ts';
import type { StorageBackend } from '../../../core/storage.ts';
import { formatSize } from '../lib/format.ts';
import { Modal } from '../lib/ui.tsx';

/** A TCP connection through the main process as a bridge channel. */
function lanChannel(onCloseAction: 'drop' | 'stop'): BridgeChannel {
  let offData = () => {};
  let offClosed = () => {};
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    offData();
    offClosed();
    if (onCloseAction === 'drop') bridge!.lan.drop();
    else bridge!.lan.stop();
  };
  return {
    send: (data) => !closed && bridge!.lan.send(data),
    onData: (callback) => {
      offData = bridge!.lan.onData(callback);
    },
    onClose: (callback) => {
      offClosed = bridge!.lan.onClosed(() => {
        if (closed) return;
        closed = true;
        offData();
        offClosed();
        callback();
      });
    },
    close,
  };
}

const sasText = (sas: string) => `${sas.slice(0, 3)} ${sas.slice(3)}`;
const qrColors = () => {
  const dark = document.documentElement.dataset.theme !== 'light';
  return { dark: dark ? '#f4efe9' : '#1a1411', light: dark ? '#151210' : '#ffffff' };
};

function Progress({ done, total, label }: { done: number; total: number; label: string }) {
  const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="field">
      <span className="field-hint">
        {label}: {formatSize(done)} из {formatSize(total)}
      </span>
      <div className="progress">
        <div style={{ width: `${Math.max(4, percent)}%` }} />
      </div>
    </div>
  );
}

type HostStage = 'intro' | 'waiting' | 'sas' | 'sending' | 'done' | 'error';

/** Old computer: Settings → «Устройства» → «Перенести на другой ПК». */
export function BridgeHostDialog({ messenger, onClose, onMoved }: { messenger: Messenger; onClose(): void; onMoved(): void }) {
  const [stage, setStage] = useState<HostStage>('intro');
  const [viaServer, setViaServer] = useState(!bridge);
  const [code, setCode] = useState('');
  const [room, setRoom] = useState('');
  const [lan, setLan] = useState<{ addresses: string[]; port: number; name: string } | null>(null);
  const [sas, setSas] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState('');
  const [qr, setQr] = useState('');
  const host = useRef<BridgeHost | null>(null);
  const cleanup = useRef<() => void>(() => {});
  const finished = useRef(false);

  const shownCode = viaServer && room ? `${room}${code}` : code;
  useEffect(() => {
    if (!shownCode) return;
    const target = viaServer ? `veil-bridge:${shownCode}@${messenger.getSnapshot().me.serverUrl}` : `veil-bridge:${shownCode}@${lan?.addresses[0] ?? ''}:${lan?.port ?? ''}`;
    void QRCode.toDataURL(target, { margin: 1, width: 176, errorCorrectionLevel: 'M', color: qrColors() }).then(setQr);
  }, [shownCode, viaServer, lan, messenger]);

  // Leaving without finishing: stop listening and go back online.
  useEffect(
    () => () => {
      cleanup.current();
      host.current?.close();
      if (!finished.current) messenger.resumeAfterBridge();
    },
    [messenger],
  );

  const start = async () => {
    setError('');
    try {
      const source = await messenger.bridgeSource();
      const instance = new BridgeHost(source, {
        onCode: setCode,
        onSas: (value) => {
          setSas(value);
          setStage('sas');
        },
        onProgress: (done, total) => setProgress({ done, total }),
        onDone: () => {
          finished.current = true;
          setStage('done');
        },
        onError: (e) => {
          setError(e.message);
          setStage('error');
        },
      });
      host.current = instance;
      setCode(instance.code);
      if (viaServer) {
        const name = newCode(ROOM_LENGTH);
        await relayBridgeChannel(messenger.getSnapshot().me.serverUrl, name, 'host', (channel) => instance.attach(channel));
        setRoom(name);
      } else {
        setLan(await bridge!.lan.host());
        const off = bridge!.lan.onPeer(() => instance.attach(lanChannel('drop')));
        cleanup.current = () => {
          off();
          bridge!.lan.stop();
        };
      }
      setStage('waiting');
    } catch (e) {
      messenger.resumeAfterBridge();
      setError((e as Error).message);
      setStage('error');
    }
  };

  const confirm = async () => {
    setStage('sending');
    try {
      await host.current!.confirm();
    } catch (e) {
      setError((e as Error).message);
      setStage('error');
    }
  };

  return (
    <Modal title="Мост: перенос на другой ПК" onClose={stage === 'sending' ? () => {} : onClose} width={480}>
      <div className="modal-body bridge-dialog">
        {stage === 'intro' && (
          <>
            <p>
              Аккаунт, чаты, «Избранное» и файлы переедут на другой компьютер — например, с Windows на Linux — напрямую по локальной сети.
            </p>
            <div className="notice warn">
              <TriangleAlert size={16} />
              <span>После переноса Veil на этом ПК очистится: один аккаунт работает на одном компьютере.</span>
            </div>
            {bridge && (
              <div className="segmented">
                <button className={!viaServer ? 'active' : ''} onClick={() => setViaServer(false)}>
                  <Wifi size={15} /> Локальная сеть
                </button>
                <button className={viaServer ? 'active' : ''} onClick={() => setViaServer(true)}>
                  <CloudUpload size={15} /> Через сервер
                </button>
              </div>
            )}
            {viaServer && (
              <div className="notice">
                <ShieldCheck size={16} />
                <span>
                  Нет общей сети — данные пойдут через ваш сервер. Он передаст только шифр: прочитать его не сможет, но увидит размер и время
                  переноса.
                </span>
              </div>
            )}
            {!viaServer && <span className="field-hint">Windows может спросить разрешение для сети — разрешите для частных сетей.</span>}
            <div className="form-actions">
              <button className="btn btn-secondary" onClick={onClose}>
                Отмена
              </button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => void start()}>
                Начать перенос
              </button>
            </div>
          </>
        )}

        {stage === 'waiting' && (
          <>
            <p>На новом ПК откройте Veil и выберите «Перенести с другого ПК». Введите там этот код:</p>
            <div className="bridge-code" data-testid="bridge-code">
              {formatCode(shownCode)}
            </div>
            {qr && <img className="bridge-qr" src={qr} alt="QR-код для переноса" width={176} height={176} />}
            {!viaServer && lan && (
              <span className="field-hint">
                Этот ПК в сети как «{lan.name}» ({lan.addresses.map((a) => `${a}:${lan.port}`).join(', ') || 'нет адреса'}).
              </span>
            )}
            <div className="bridge-wait">
              <Loader2 size={16} className="spin" /> Ждём новый ПК…
            </div>
          </>
        )}

        {stage === 'sas' && (
          <>
            <p>Новый ПК ввёл верный код. Сверьте цифры: на обоих экранах должны быть одинаковые.</p>
            <div className="bridge-sas" data-testid="bridge-sas">
              {sasText(sas)}
            </div>
            <div className="form-actions">
              <button
                className="btn btn-secondary"
                onClick={() => {
                  host.current?.close();
                  onClose();
                }}
              >
                Не совпадают
              </button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => void confirm()}>
                <Check size={17} /> Цифры совпадают
              </button>
            </div>
          </>
        )}

        {stage === 'sending' && (
          <>
            <p>Передаём зашифрованные данные. Не закрывайте Veil на обоих компьютерах.</p>
            <Progress done={progress.done} total={progress.total} label="Передано" />
          </>
        )}

        {stage === 'done' && (
          <>
            <div className="bridge-done">
              <Laptop size={30} />
              <b>Перенос завершён</b>
              <span>Аккаунт работает на новом ПК. Сейчас Veil на этом компьютере очистится.</span>
            </div>
            <button className="btn btn-primary btn-block" onClick={() => void messenger.wipeAfterBridge().then(onMoved)}>
              Очистить этот ПК
            </button>
          </>
        )}

        {stage === 'error' && (
          <>
            <div className="notice warn">
              <TriangleAlert size={16} />
              <span>{error || 'Перенос не удался'}</span>
            </div>
            <div className="form-actions">
              <button className="btn btn-secondary" onClick={onClose}>
                Закрыть
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

type GuestStage = 'password' | 'find' | 'code' | 'sas' | 'receiving' | 'importing' | 'error';

/** New computer: onboarding → «Перенести с другого ПК». */
export function BridgeGuestFlow({
  storage,
  events,
  onBack,
  onDone,
}: {
  storage: StorageBackend;
  events: MessengerEvents;
  onBack(): void;
  onDone(messenger: Messenger): void;
}) {
  const [stage, setStage] = useState<GuestStage>('password');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [found, setFound] = useState<{ name: string; host: string; port: number }[] | null>(null);
  const [target, setTarget] = useState<{ kind: 'lan'; host: string; port: number; name: string } | { kind: 'server'; server: string } | null>(null);
  const [manual, setManual] = useState('');
  const [server, setServer] = useState('');
  const [code, setCode] = useState('');
  const [sas, setSas] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState('');
  const guest = useRef<BridgeGuest | null>(null);
  useEffect(() => () => guest.current?.cancel(), []);

  const search = async () => {
    setFound(null);
    setFound(bridge ? await bridge.lan.discover() : []);
  };
  useEffect(() => {
    if (stage === 'find' && found === null) void search();
  }, [stage, found]);

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) return setError('Пароль — не короче 8 символов');
    if (password !== password2) return setError('Пароли не совпадают');
    setStage('find');
  };

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    let channel: BridgeChannel;
    let secret = normalizeCode(code);
    try {
      if (target?.kind === 'server') {
        const parts = splitRelayCode(code);
        if (!parts) return setError('Код для переноса через сервер — 12 символов');
        secret = parts.secret;
        channel = await relayBridgeChannel(target.server, parts.room, 'guest');
      } else if (target?.kind === 'lan') {
        if (secret.length !== 8) return setError('Код — 8 символов');
        await bridge!.lan.connect(target.host, target.port);
        channel = lanChannel('stop');
      } else return;
    } catch (err) {
      return setError((err as Error).message);
    }
    const instance = new BridgeGuest(channel, secret, {
      onSas: (value) => {
        setSas(value);
        setStage('sas');
      },
      onProgress: (done, total) => {
        setProgress({ done, total });
        setStage('receiving');
      },
      onRecords: (records) => {
        setStage('importing');
        void importAccount({ storage, password, records }, events)
          .then((messenger) => {
            instance.finish();
            onDone(messenger);
          })
          .catch((err: Error) => {
            instance.cancel();
            setError(err.message);
            setStage('error');
          });
      },
      onError: (err) => {
        setError(err.message);
        setStage(err.code === 'bad_code' ? 'code' : 'error');
      },
    });
    guest.current = instance;
    instance.start();
  };

  return (
    <div className="glass-card bridge-guest">
      <div className="step-head">
        <button className="icon-btn sm back" onClick={onBack} aria-label="Назад">
          <ArrowLeft size={18} />
        </button>
        <h2>Перенос с другого ПК</h2>
        <p>Аккаунт, чаты и «Избранное» переедут с компьютера, где Veil уже есть.</p>
      </div>

      {stage === 'password' && (
        <form className="form" onSubmit={submitPassword}>
          <span className="field-hint">Придумайте пароль Veil для этого компьютера — он может отличаться от старого.</span>
          <input className="input" type="password" placeholder="Пароль для этого ПК" aria-label="Пароль для этого ПК" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          <input className="input" type="password" placeholder="Повторите пароль" aria-label="Повторите пароль для этого ПК" value={password2} onChange={(e) => setPassword2(e.target.value)} />
          {error && <span className="field-error">{error}</span>}
          <button className="btn btn-primary btn-lg btn-block">Дальше</button>
        </form>
      )}

      {stage === 'find' && (
        <div className="form">
          <span className="field-hint">На старом ПК: Настройки → Устройства → «Перенести на другой ПК».</span>
          {bridge && (
            <>
              <div className="bridge-found">
                {found === null && (
                  <div className="bridge-wait">
                    <Loader2 size={16} className="spin" /> Ищем компьютеры в этой сети…
                  </div>
                )}
                {found?.map((f) => (
                  <button
                    key={`${f.host}:${f.port}`}
                    className="option-card"
                    onClick={() => {
                      setTarget({ kind: 'lan', ...f });
                      setStage('code');
                    }}
                  >
                    <MonitorSmartphone size={20} />
                    <div className="grow">
                      <b>{f.name}</b>
                      <span>
                        {f.host}:{f.port}
                      </span>
                    </div>
                  </button>
                ))}
                {found?.length === 0 && <span className="field-hint">В этой сети компьютеров с открытым Мостом не нашлось.</span>}
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => void search()}>
                <RefreshCw size={15} /> Искать снова
              </button>
              <div className="bridge-manual">
                <input className="input" placeholder="Или адрес: 192.168.1.5:41234" aria-label="Адрес старого ПК" value={manual} onChange={(e) => setManual(e.target.value)} />
                <button
                  className="btn btn-secondary"
                  disabled={!/^[\w.-]+:\d{2,5}$/.test(manual.trim())}
                  onClick={() => {
                    const [host, port] = manual.trim().split(':');
                    setTarget({ kind: 'lan', host, port: Number(port), name: host });
                    setStage('code');
                  }}
                >
                  Подключиться
                </button>
              </div>
            </>
          )}
          <div className="section">
            <div className="section-title">
              <CloudUpload size={16} /> Нет общей сети — через сервер
            </div>
            <p>Сервер передаст только шифр. Укажите тот же сервер, что на старом ПК.</p>
            <div className="bridge-manual">
              <input className="input" placeholder="Адрес сервера" aria-label="Адрес сервера для переноса" value={server} onChange={(e) => setServer(e.target.value)} />
              <button
                className="btn btn-secondary"
                disabled={!server.trim()}
                onClick={() => {
                  setTarget({ kind: 'server', server: server.trim() });
                  setStage('code');
                }}
              >
                Дальше
              </button>
            </div>
          </div>
        </div>
      )}

      {stage === 'code' && (
        <form className="form" onSubmit={(e) => void connect(e)}>
          <span className="field-hint">
            {target?.kind === 'server' ? 'Введите код из 12 символов с экрана старого ПК.' : `Введите код из 8 символов с экрана «${target?.kind === 'lan' ? target.name : ''}».`}
          </span>
          <input
            className="input bridge-code-input"
            placeholder={target?.kind === 'server' ? 'XXXX-XXXX-XXXX' : 'XXXX-XXXX'}
            aria-label="Код переноса"
            autoFocus
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          {error && <span className="field-error">{error}</span>}
          <button className="btn btn-primary btn-lg btn-block">Подключиться</button>
          <button type="button" className="link-btn" onClick={() => setStage('find')}>
            Выбрать другой компьютер
          </button>
        </form>
      )}

      {stage === 'sas' && (
        <div className="form">
          <p>Код верный. Сверьте цифры со старым ПК и подтвердите там, что они совпадают:</p>
          <div className="bridge-sas" data-testid="bridge-sas">
            {sasText(sas)}
          </div>
          <div className="bridge-wait">
            <Loader2 size={16} className="spin" /> Ждём подтверждения на старом ПК…
          </div>
        </div>
      )}

      {(stage === 'receiving' || stage === 'importing') && (
        <div className="form">
          <Progress done={progress.done} total={progress.total} label="Получено" />
          {stage === 'importing' && (
            <div className="bridge-wait">
              <Loader2 size={16} className="spin" /> Шифруем данные паролем этого ПК…
            </div>
          )}
        </div>
      )}

      {stage === 'error' && (
        <div className="form">
          <div className="notice warn">
            <TriangleAlert size={16} />
            <span>{error || 'Перенос не удался'}</span>
          </div>
          <button className="btn btn-secondary btn-block" onClick={() => setStage('find')}>
            Попробовать снова
          </button>
        </div>
      )}
    </div>
  );
}
