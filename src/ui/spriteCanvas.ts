// Ponte entre rasters e o DOM (canvas / data URL), com cache.
import type { Raster } from '../sprites/pixel.ts';
import { characterById, characterFrame, type Facing, type Modality } from '../sprites/characters.ts';

export function drawRaster(canvas: HTMLCanvasElement, r: Raster): void {
  if (canvas.width !== r.w) canvas.width = r.w;
  if (canvas.height !== r.h) canvas.height = r.h;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, r.w, r.h);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.w, r.h), 0, 0);
}

const urlCache = new Map<string, string>();

export function rasterUrl(key: string, make: () => Raster): string {
  const hit = urlCache.get(key);
  if (hit) return hit;
  const r = make();
  const c = document.createElement('canvas');
  drawRaster(c, r);
  const url = c.toDataURL('image/png');
  urlCache.set(key, url);
  return url;
}

const frameCache = new Map<string, Raster>();

export function cachedCharacterFrame(characterId: string, modality: Modality, facing: Facing, frame: number): Raster {
  const key = `${characterId}|${modality}|${facing}|${frame}`;
  let r = frameCache.get(key);
  if (!r) {
    r = characterFrame(characterById(characterId), modality, facing, frame);
    frameCache.set(key, r);
  }
  return r;
}
