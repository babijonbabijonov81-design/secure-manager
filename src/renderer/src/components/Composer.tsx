import { LockKeyhole, Paperclip, SendHorizontal, Smile } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Messenger } from '../../../core/messenger.ts';
import type { Contact } from '../../../core/types.ts';
import { EMOJI_GROUPS } from '../lib/emoji.ts';

interface Props {
  messenger: Messenger;
  contact: Contact;
  enterToSend: boolean;
  onFiles(files: File[]): void;
}

export function Composer({ messenger, contact, enterToSend, onFiles }: Props) {
  const [text, setText] = useState(contact.draft ?? '');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiTab, setEmojiTab] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef(text);
  const contactId = contact.id;

  // Each chat keeps its own draft; it is saved when switching away.
  useEffect(() => {
    const draft = messenger.getSnapshot().contacts.find((c) => c.id === contactId)?.draft ?? '';
    setText(draft);
    latest.current = draft;
    setEmojiOpen(false);
    area.current?.focus();
    return () => {
      clearTimeout(draftTimer.current);
      messenger.setDraft(contactId, latest.current.trim() ? latest.current : '');
    };
  }, [contactId, messenger]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const update = (value: string) => {
    setText(value);
    latest.current = value;
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => messenger.setDraft(contactId, value), 500);
    messenger.sendTyping(contactId, value.trim().length > 0);
  };

  const send = () => {
    const value = text.trim();
    if (!value) return;
    setText('');
    latest.current = '';
    clearTimeout(draftTimer.current);
    messenger.sendTyping(contactId, false);
    void messenger.sendText(contactId, value);
    area.current?.focus();
  };

  const insertEmoji = (emoji: string) => {
    const el = area.current;
    if (!el) return update(text + emoji);
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const next = text.slice(0, start) + emoji + text.slice(end);
    update(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + emoji.length;
    });
  };

  return (
    <div className="composer-wrap">
      {emojiOpen && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 19 }} onMouseDown={() => setEmojiOpen(false)} />
          <div className="emoji-pop" role="dialog" aria-label="Эмодзи">
            <div className="emoji-tabs">
              {EMOJI_GROUPS.map((group, i) => (
                <button key={group.label} className={i === emojiTab ? 'active' : ''} onClick={() => setEmojiTab(i)} title={group.label}>
                  {group.icon}
                </button>
              ))}
            </div>
            <div className="emoji-grid">
              {EMOJI_GROUPS[emojiTab].items.map((emoji, i) => (
                <button key={`${emoji}${i}`} onClick={() => insertEmoji(emoji)}>
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      <div className="composer">
        <button className="icon-btn" onClick={() => fileInput.current?.click()} aria-label="Прикрепить файл" title="Прикрепить файл">
          <Paperclip size={20} />
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) onFiles([...e.target.files]);
            e.target.value = '';
          }}
        />
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder="Сообщение"
          aria-label="Сообщение"
          onChange={(e) => update(e.target.value)}
          onBlur={() => messenger.sendTyping(contactId, false)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              onFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            const modifier = e.ctrlKey || e.metaKey;
            if ((enterToSend && !e.shiftKey && !modifier) || (!enterToSend && modifier)) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className={`icon-btn${emojiOpen ? ' active' : ''}`} onClick={() => setEmojiOpen((v) => !v)} aria-label="Эмодзи">
          <Smile size={20} />
        </button>
        <button className="send-btn" onClick={send} disabled={!text.trim()} aria-label="Отправить">
          <SendHorizontal size={19} />
        </button>
      </div>
      <div className="composer-note">
        <LockKeyhole size={11} /> Сквозное шифрование · {enterToSend ? 'Enter — отправить, Shift+Enter — новая строка' : 'Ctrl+Enter — отправить'}
      </div>
    </div>
  );
}
