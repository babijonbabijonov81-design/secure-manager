// gzip via the web-standard CompressionStream (Electron, browsers, Node 18+), or fflate where
// there is none (the iPhone app's JavaScript engine). The first byte records whether the
// payload is compressed.

import { gunzipSync, gzipSync } from 'fflate';

const streams = () => typeof CompressionStream !== 'undefined' && typeof Response !== 'undefined' && typeof Blob !== 'undefined' && 'stream' in Blob.prototype;

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const response = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await response.arrayBuffer());
}

export async function compress(data: Uint8Array): Promise<Uint8Array> {
  return withFlag(1, streams() ? await pipe(data, new CompressionStream('gzip')) : gzipSync(data));
}

export async function decompress(data: Uint8Array): Promise<Uint8Array> {
  const body = data.subarray(1);
  if (data[0] === 0) return body;
  if (data[0] !== 1) throw new Error('unknown compression');
  return streams() ? pipe(body, new DecompressionStream('gzip')) : gunzipSync(body);
}

function withFlag(flag: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 1);
  out[0] = flag;
  out.set(data, 1);
  return out;
}
