// Raster (RGBA) → PNG em data URI, sem DOM e sem zlib, com cache por chave.
// No nativo o Image filtra (bilinear) ao escalar; por isso o raster é ampliado antes por vizinho mais próximo
// (fator inteiro) até ~ tamanho exibido × densidade da tela, e o borrão residual fica abaixo de 1 pixel físico.
// Na web o <img> usa `image-rendering: pixelated` (como o original) e recebe o raster em 1x.
import { PixelRatio, Platform } from 'react-native';
import { scaleRaster, type Raster } from '../sprites/pixel.ts';

/** Maior ampliação aceita (um personagem de 24 px vira no máximo 384 px). */
const MAX_SCALE = 16;

const rasterCache = new Map<string, Raster>();
const uriCache = new Map<string, string>();

/** Raster base (1x) de uma chave, calculado uma vez. */
export function cachedRaster(key: string, make: () => Raster): Raster {
  let r = rasterCache.get(key);
  if (!r) {
    r = make();
    rasterCache.set(key, r);
  }
  return r;
}

/** Fator inteiro de ampliação para exibir `srcW` pixels de arte em `displayW` pontos. */
export function scaleFor(srcW: number, displayW: number): number {
  if (Platform.OS === 'web') return 1;
  const k = Math.ceil((displayW * PixelRatio.get()) / Math.max(1, srcW) - 0.01);
  return Math.max(1, Math.min(MAX_SCALE, k));
}

/**
 * Data URI PNG do raster `key` para exibir com `displayW` pontos de largura.
 * `make` só roda na primeira vez (o raster base também fica em cache).
 */
export function rasterUri(key: string, make: () => Raster, displayW: number): string {
  const base = cachedRaster(key, make);
  const k = scaleFor(base.w, displayW);
  const uriKey = `${key}@${k}`;
  let uri = uriCache.get(uriKey);
  if (!uri) {
    uri = pngDataUri(scaleRaster(base, k));
    uriCache.set(uriKey, uri);
  }
  return uri;
}

export function pngDataUri(r: Raster): string {
  return `data:image/png;base64,${base64(encodePng(r))}`;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

/** Codifica RGBA 8 bits. Filtros por linha: "Up" quando a linha repete a anterior (zeros), senão "Sub". */
export function encodePng(r: Raster): Uint8Array {
  const stride = r.w * 4;
  const filtered = new Uint8Array((stride + 1) * r.h);
  const src = r.data;
  let o = 0;
  for (let y = 0; y < r.h; y++) {
    const row = y * stride;
    let same = y > 0;
    if (same) {
      for (let i = 0; i < stride; i++) {
        if (src[row + i] !== src[row - stride + i]) {
          same = false;
          break;
        }
      }
    }
    if (same) {
      filtered[o++] = 2; // Up: tudo zero
      o += stride;
      continue;
    }
    filtered[o++] = 1; // Sub: diferença para o pixel da esquerda
    for (let i = 0; i < stride; i++) {
      filtered[o++] = (src[row + i] - (i >= 4 ? src[row + i - 4] : 0)) & 0xff;
    }
  }

  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, r.w);
  writeU32(ihdr, 4, r.h);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  const idat = zlib(filtered);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  writeU32(out, 8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function writeU32(buf: Uint8Array, at: number, v: number): void {
  buf[at] = (v >>> 24) & 0xff;
  buf[at + 1] = (v >>> 16) & 0xff;
  buf[at + 2] = (v >>> 8) & 0xff;
  buf[at + 3] = v & 0xff;
}

let crcTable: Uint32Array | null = null;

function crc32(buf: Uint8Array, from: number, to: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buf: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------------------------------------------------------------------------
// zlib/deflate mínimo: um bloco com Huffman fixo e só repetições de distância 1.
// Arte ampliada por vizinho mais próximo vira longas sequências de zeros depois dos filtros do PNG,
// então isso já comprime dezenas de vezes (bem melhor que blocos "stored").
// ---------------------------------------------------------------------------

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];

class BitWriter {
  private buf: Uint8Array;
  private pos = 0;
  private cur = 0;
  private nbits = 0;

  constructor(capacity: number) {
    this.buf = new Uint8Array(Math.max(64, capacity));
  }

  private push(byte: number): void {
    if (this.pos >= this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.pos++] = byte;
  }

  /** Bits com o menos significativo primeiro (cabeçalhos e bits extras). */
  bits(value: number, n: number): void {
    for (let i = 0; i < n; i++) {
      this.cur |= ((value >>> i) & 1) << this.nbits;
      if (++this.nbits === 8) {
        this.push(this.cur);
        this.cur = 0;
        this.nbits = 0;
      }
    }
  }

  /** Códigos de Huffman: o mais significativo primeiro. */
  code(value: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) {
      this.cur |= ((value >>> i) & 1) << this.nbits;
      if (++this.nbits === 8) {
        this.push(this.cur);
        this.cur = 0;
        this.nbits = 0;
      }
    }
  }

  finish(): Uint8Array {
    if (this.nbits > 0) this.push(this.cur);
    return this.buf.subarray(0, this.pos);
  }
}

function writeSymbol(w: BitWriter, sym: number): void {
  if (sym < 144) w.code(0x30 + sym, 8);
  else if (sym < 256) w.code(0x190 + sym - 144, 9);
  else if (sym < 280) w.code(sym - 256, 7);
  else w.code(0xc0 + sym - 280, 8);
}

function writeMatch(w: BitWriter, len: number): void {
  let i = LEN_BASE.length - 1;
  while (LEN_BASE[i] > len) i--;
  writeSymbol(w, 257 + i);
  if (LEN_EXTRA[i]) w.bits(len - LEN_BASE[i], LEN_EXTRA[i]);
  w.code(0, 5); // distância 1 (código 0, sem bits extras)
}

function zlib(data: Uint8Array): Uint8Array {
  const w = new BitWriter(data.length >> 3);
  w.bits(0x78, 8);
  w.bits(0x01, 8);
  w.bits(1, 1); // BFINAL
  w.bits(1, 2); // BTYPE = Huffman fixo
  let i = 0;
  while (i < data.length) {
    const v = data[i];
    if (i > 0 && data[i - 1] === v) {
      let n = 1;
      while (n < 258 && i + n < data.length && data[i + n] === v) n++;
      if (n >= 3) {
        writeMatch(w, n);
        i += n;
        continue;
      }
    }
    writeSymbol(w, v);
    i++;
  }
  writeSymbol(w, 256); // fim do bloco
  const body = w.finish();
  const out = new Uint8Array(body.length + 4);
  out.set(body);
  writeU32(out, body.length, adler32(data));
  return out;
}

// ---------------------------------------------------------------------------
// Base64 (sem depender de btoa/Buffer)
// ---------------------------------------------------------------------------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(bytes: Uint8Array): string {
  const out: string[] = [];
  let chunkStr = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    chunkStr +=
      B64[(n >> 18) & 63] +
      B64[(n >> 12) & 63] +
      (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') +
      (i + 2 < bytes.length ? B64[n & 63] : '=');
    if (chunkStr.length >= 4096) {
      out.push(chunkStr);
      chunkStr = '';
    }
  }
  out.push(chunkStr);
  return out.join('');
}
