// Núcleo de pixel art: sprites são grades de caracteres + paletas.
// Puro (sem DOM) para rodar no navegador e no script de exportação em Node.

/** Linhas da arte; '.' ou ' ' = transparente. Cada outro caractere é uma chave da paleta. */
export type Art = readonly string[];
/** caractere -> cor '#rgb', '#rrggbb' ou '#rrggbbaa' */
export type Palette = Readonly<Record<string, string>>;

export interface Layer {
  art: Art;
  palette?: Palette;
  x?: number;
  y?: number;
  flip?: boolean;
}

export interface Raster {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

const colorCache = new Map<string, [number, number, number, number]>();

export function hexToRgba(hex: string): [number, number, number, number] {
  const cached = colorCache.get(hex);
  if (cached) return cached;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255;
  const out: [number, number, number, number] = [r, g, b, a];
  colorCache.set(hex, out);
  return out;
}

export function artSize(art: Art): { w: number; h: number } {
  let w = 0;
  for (const row of art) w = Math.max(w, row.length);
  return { w, h: art.length };
}

export function createRaster(w: number, h: number): Raster {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

/** Desenha camadas (na ordem) num raster novo. Pixels opacos sobrescrevem; semitransparentes misturam. */
export function rasterize(w: number, h: number, layers: Layer[], basePalette: Palette = {}): Raster {
  const out = createRaster(w, h);
  for (const layer of layers) drawLayer(out, layer, basePalette);
  return out;
}

export function drawLayer(out: Raster, layer: Layer, basePalette: Palette = {}): void {
  const pal = layer.palette ? { ...basePalette, ...layer.palette } : basePalette;
  const ox = layer.x ?? 0;
  const oy = layer.y ?? 0;
  const { w: aw } = artSize(layer.art);
  layer.art.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      const ch = row[rx];
      if (ch === '.' || ch === ' ') continue;
      const color = pal[ch];
      if (!color) continue;
      const px = ox + (layer.flip ? aw - 1 - rx : rx);
      const py = oy + ry;
      if (px < 0 || py < 0 || px >= out.w || py >= out.h) continue;
      blendPixel(out, px, py, hexToRgba(color));
    }
  });
}

export function blendPixel(out: Raster, x: number, y: number, c: [number, number, number, number]): void {
  const i = (y * out.w + x) * 4;
  const a = c[3] / 255;
  if (a >= 1) {
    out.data[i] = c[0];
    out.data[i + 1] = c[1];
    out.data[i + 2] = c[2];
    out.data[i + 3] = 255;
    return;
  }
  const da = out.data[i + 3] / 255;
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  for (let k = 0; k < 3; k++) {
    out.data[i + k] = (c[k] * a + out.data[i + k] * da * (1 - a)) / oa;
  }
  out.data[i + 3] = oa * 255;
}

/** Ampliação por vizinho mais próximo (mantém o pixel nítido). */
export function scaleRaster(src: Raster, k: number): Raster {
  if (k === 1) return src;
  const out = createRaster(src.w * k, src.h * k);
  for (let y = 0; y < out.h; y++) {
    const sy = Math.floor(y / k);
    for (let x = 0; x < out.w; x++) {
      const sx = Math.floor(x / k);
      const si = (sy * src.w + sx) * 4;
      const di = (y * out.w + x) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

export function flipRaster(src: Raster): Raster {
  const out = createRaster(src.w, src.h);
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const si = (y * src.w + x) * 4;
      const di = (y * src.w + (src.w - 1 - x)) * 4;
      for (let k = 0; k < 4; k++) out.data[di + k] = src.data[si + k];
    }
  }
  return out;
}

/** Copia `src` para dentro de `dst` na posição (x, y), com mistura alfa. */
export function blit(dst: Raster, src: Raster, x: number, y: number): void {
  for (let sy = 0; sy < src.h; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dst.h) continue;
    for (let sx = 0; sx < src.w; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= dst.w) continue;
      const si = (sy * src.w + sx) * 4;
      const a = src.data[si + 3];
      if (a === 0) continue;
      blendPixel(dst, dx, dy, [src.data[si], src.data[si + 1], src.data[si + 2], a]);
    }
  }
}

/** Contorno de 1px ao redor dos pixels opacos (útil para destacar ícones no mapa). */
export function outlineRaster(src: Raster, color: string): Raster {
  const out = createRaster(src.w + 2, src.h + 2);
  const c = hexToRgba(color);
  const opaque = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < src.w && y < src.h && src.data[(y * src.w + x) * 4 + 3] > 0;
  for (let y = -1; y <= src.h; y++) {
    for (let x = -1; x <= src.w; x++) {
      if (opaque(x, y)) continue;
      if (opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1)) {
        blendPixel(out, x + 1, y + 1, c);
      }
    }
  }
  blit(out, src, 1, 1);
  return out;
}

/** Valida que todas as linhas de uma arte têm a mesma largura (usado no script de exportação). */
export function checkArt(name: string, art: Art): string[] {
  const { w } = artSize(art);
  const errs: string[] = [];
  art.forEach((row, i) => {
    if (row.length !== w) errs.push(`${name}: linha ${i} tem ${row.length} colunas (esperado ${w})`);
  });
  return errs;
}
