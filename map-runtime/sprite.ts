// Desenho do herói no mapa: rasters dos sprites num <canvas>, com cache por quadro.
import type { Raster } from '../src/sprites/pixel.ts';
import type { Facing } from '../src/sprites/characters.ts';
import { avatarFrame, avatarKey, type AvatarConfig } from '../src/sprites/avatar.ts';
import type { Modality } from '../src/game/types.ts';

export function drawRaster(canvas: HTMLCanvasElement, r: Raster): void {
  if (canvas.width !== r.w) canvas.width = r.w;
  if (canvas.height !== r.h) canvas.height = r.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, r.w, r.h);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.w, r.h), 0, 0);
}

const MAX_FRAMES = 64;
const frameCache = new Map<string, Raster>();

export function cachedAvatarFrame(avatar: AvatarConfig, modality: Modality, facing: Facing, frame: number): Raster {
  const key = `${avatarKey(avatar)}|${modality}|${facing}|${frame}`;
  let r = frameCache.get(key);
  if (!r) {
    if (frameCache.size >= MAX_FRAMES) {
      const oldest = frameCache.keys().next().value;
      if (oldest !== undefined) frameCache.delete(oldest);
    }
    r = avatarFrame(avatar, modality, facing, frame);
    frameCache.set(key, r);
  }
  return r;
}
