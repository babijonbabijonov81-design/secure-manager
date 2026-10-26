// What the shared core expects from the platform and Hermes lacks: a full URL, TextDecoder and
// a secure random source. Imported first, before anything from src/core.
import 'react-native-url-polyfill/auto';
import { getRandomValues } from 'expo-crypto';

const g = globalThis as unknown as { crypto?: { getRandomValues?: unknown }; TextDecoder?: unknown };
if (!g.crypto) g.crypto = {};
if (typeof g.crypto.getRandomValues !== 'function') g.crypto.getRandomValues = getRandomValues;

if (typeof g.TextDecoder === 'undefined') {
  /** UTF-8 only, which is all the core uses; bad sequences become U+FFFD. */
  class Utf8Decoder {
    readonly encoding = 'utf-8';
    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (!input) return '';
      const bytes = input instanceof Uint8Array ? input : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
      let out = '';
      const codes: number[] = [];
      for (let i = 0; i < bytes.length; ) {
        const b = bytes[i];
        let cp = 0xfffd;
        let need = 0;
        if (b < 0x80) cp = b;
        else if (b >= 0xc2 && b < 0xe0) (cp = b & 0x1f), (need = 1);
        else if (b >= 0xe0 && b < 0xf0) (cp = b & 0x0f), (need = 2);
        else if (b >= 0xf0 && b < 0xf5) (cp = b & 0x07), (need = 3);
        let k = 1;
        for (; k <= need; k++) {
          const c = bytes[i + k];
          if (c === undefined || (c & 0xc0) !== 0x80) break;
          cp = (cp << 6) | (c & 0x3f);
        }
        if (k <= need || (need === 2 && cp < 0x800) || (need === 3 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff)) {
          cp = 0xfffd;
          i += Math.max(1, k);
        } else i += need + 1;
        if (cp > 0xffff) {
          cp -= 0x10000;
          codes.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        } else codes.push(cp);
        if (codes.length > 8192) out += String.fromCharCode(...codes.splice(0));
      }
      return out + String.fromCharCode(...codes);
    }
  }
  g.TextDecoder = Utf8Decoder;
}
