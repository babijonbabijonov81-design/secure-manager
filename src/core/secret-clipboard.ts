// Passwords on the clipboard: erased after a while, but only if the clipboard still holds the
// same value (compared by SHA-256, so the password itself is not kept around for the check).

import { sha256 } from '@noble/hashes/sha2.js';
import { utf8 } from '../../server/src/shared/wire.ts';

export interface ClipboardIO {
  /** Writes the text; `secret` asks the platform to keep it out of clipboard history and sync. */
  write(text: string, secret: boolean): Promise<void>;
  /** Throws if the clipboard cannot be read (e.g. Wayland, another window owns it). */
  read(): Promise<string>;
  /** Linux/Wayland: clearing means writing an empty string. */
  clear(): Promise<void>;
}

const digest = (text: string) => Array.from(sha256(utf8(text)), (b) => b.toString(16).padStart(2, '0')).join('');

export class SecretClipboard {
  private current: { hash: string; until: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
  private readonly io: ClipboardIO;

  constructor(io: ClipboardIO) {
    this.io = io;
  }

  /** Copies `text`; with `seconds` > 0 it is erased after that time if still on the clipboard. */
  async copy(text: string, seconds: number): Promise<void> {
    await this.io.write(text, true);
    if (this.current?.timer) clearTimeout(this.current.timer);
    this.current = {
      hash: digest(text),
      until: seconds > 0 ? Date.now() + seconds * 1000 : 0,
      timer: seconds > 0 ? setTimeout(() => void this.clear(), seconds * 1000) : null,
    };
  }

  /** When the copied password will be erased (ms timestamp), or null. */
  get clearsAt(): number | null {
    return this.current?.until || null;
  }

  /** Erases our value if it is still there. Returns true if something was erased. */
  async clear(): Promise<boolean> {
    const current = this.current;
    this.current = null;
    if (!current) return false;
    if (current.timer) clearTimeout(current.timer);
    let ours = false;
    try {
      ours = digest(await this.io.read()) === current.hash;
    } catch {
      // Unreadable clipboard: someone else owns it now, so it is not ours to erase.
    }
    if (ours) await this.io.clear();
    return ours;
  }
}
