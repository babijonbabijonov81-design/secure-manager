// Binary framing and encoding helpers shared by the relay server and the client.
// Everything here uses only web-standard APIs so it runs in Node and in the browser.
//
// Frame layout: [u32 big-endian header length][UTF-8 JSON header][raw body bytes]

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (text: string): Uint8Array => encoder.encode(text);
export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

/** Base64url without padding. */
export function b64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64(text: string): Uint8Array {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('invalid base64');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Decodes base64url and checks the decoded length; returns null when invalid. */
export function unb64Len(text: unknown, length: number): Uint8Array | null {
  if (typeof text !== 'string') return null;
  try {
    const bytes = unb64(text);
    return bytes.length === length ? bytes : null;
  } catch {
    return null;
  }
}

export function pack(header: object, body?: Uint8Array): Uint8Array<ArrayBuffer> {
  const json = utf8(JSON.stringify(header));
  return body && body.length ? concat(u32(json.length), json, body) : concat(u32(json.length), json);
}

export function unpack<T = Record<string, unknown>>(data: Uint8Array): { header: T; body: Uint8Array } {
  if (data.length < 4) throw new Error('frame too short');
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, false);
  if (length > data.length - 4) throw new Error('frame header overflow');
  const header = JSON.parse(fromUtf8(data.subarray(4, 4 + length))) as T;
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('frame header must be an object');
  return { header, body: data.subarray(4 + length) };
}

export function randomId(bytes = 16): string {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return b64(out);
}
