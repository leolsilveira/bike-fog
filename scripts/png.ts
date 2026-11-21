// Encoder PNG mínimo (RGBA 8-bit) usando só zlib do Node.
import { deflateSync } from 'node:zlib';
import type { Raster } from '../src/sprites/pixel.ts';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, Buffer.from(data), crc]);
}

/**
 * PNG 8-bit de um raster. `alpha: false` grava RGB sem canal alfa (o ícone da App Store não pode ter
 * transparência); nesse caso o raster precisa ser todo opaco.
 */
export function encodePng(r: Raster, { alpha = true }: { alpha?: boolean } = {}): Buffer {
  const ch = alpha ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(r.w, 0);
  ihdr.writeUInt32BE(r.h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = alpha ? 6 : 2; // RGBA : RGB
  const stride = r.w * ch + 1;
  const raw = Buffer.alloc(stride * r.h);
  for (let y = 0; y < r.h; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < r.w; x++) {
      const si = (y * r.w + x) * 4;
      if (!alpha && r.data[si + 3] !== 255) throw new Error(`encodePng: pixel transparente em (${x}, ${y})`);
      for (let k = 0; k < ch; k++) raw[y * stride + 1 + x * ch + k] = r.data[si + k];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
