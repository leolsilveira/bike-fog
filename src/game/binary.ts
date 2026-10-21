// Codificação binária do save: névoa e trilhas viram bytes (bem menores e mais rápidos que JSON de números).
// Puro (sem React Native), para rodar também no Node nos testes.

/** Registro da névoa como `fog.serialize()` produz. */
export interface FogData {
  keys: Float64Array;
  city: Uint16Array;
  cityIds: string[];
}

// 'DSBF' em little-endian
const FOG_MAGIC = 0x46425344;
const FOG_VERSION = 1;
const FOG_HEADER = 16;

/** UTF-8 sem depender de TextEncoder (nem todo motor JS tem). */
export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

export function utf8Decode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i++];
    let cp: number;
    if (c < 0x80) cp = c;
    else if (c < 0xe0) cp = ((c & 31) << 6) | (b[i++] & 63);
    else if (c < 0xf0) cp = ((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
    else cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
    s += String.fromCodePoint(cp);
  }
  return s;
}

/** Cópia alinhada de um trecho (typed arrays exigem offset múltiplo do tamanho do elemento). */
function sliceBuffer(b: Uint8Array, start: number, end: number): ArrayBuffer {
  const out = new Uint8Array(end - start);
  out.set(b.subarray(start, end));
  return out.buffer;
}

export function encodeFog(data: FogData): Uint8Array {
  const n = data.keys.length;
  const json = utf8Encode(JSON.stringify(data.cityIds));
  const out = new Uint8Array(FOG_HEADER + n * 8 + n * 2 + json.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, FOG_MAGIC, true);
  dv.setUint32(4, FOG_VERSION, true);
  dv.setUint32(8, n, true);
  dv.setUint32(12, json.length, true);
  out.set(new Uint8Array(data.keys.buffer, data.keys.byteOffset, n * 8), FOG_HEADER);
  out.set(new Uint8Array(data.city.buffer, data.city.byteOffset, n * 2), FOG_HEADER + n * 8);
  out.set(json, FOG_HEADER + n * 10);
  return out;
}

/** Devolve undefined se os bytes não forem um registro válido (ex.: arquivo truncado). */
export function decodeFog(b: Uint8Array): FogData | undefined {
  if (b.byteLength < FOG_HEADER) return undefined;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== FOG_MAGIC || dv.getUint32(4, true) !== FOG_VERSION) return undefined;
  const n = dv.getUint32(8, true);
  const jsonLen = dv.getUint32(12, true);
  if (b.byteLength !== FOG_HEADER + n * 10 + jsonLen) return undefined;
  try {
    const keys = new Float64Array(sliceBuffer(b, FOG_HEADER, FOG_HEADER + n * 8));
    const city = new Uint16Array(sliceBuffer(b, FOG_HEADER + n * 8, FOG_HEADER + n * 10));
    const cityIds = JSON.parse(utf8Decode(b.subarray(FOG_HEADER + n * 10))) as unknown;
    if (!Array.isArray(cityIds) || cityIds.some((c) => typeof c !== 'string')) return undefined;
    return { keys, city, cityIds: cityIds as string[] };
  } catch {
    return undefined;
  }
}

export function float64ToBytes(a: Float64Array): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

export function bytesToFloat64(b: Uint8Array): Float64Array | undefined {
  if (b.byteLength % 8 !== 0) return undefined;
  if (b.byteOffset % 8 === 0) return new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8);
  return new Float64Array(sliceBuffer(b, 0, b.byteLength));
}
