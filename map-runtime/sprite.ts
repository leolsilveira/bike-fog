// Desenho do herói no mapa: rasters dos sprites num <canvas>, com cache por quadro.
import type { Raster } from '../src/sprites/pixel.ts';
import { characterById, characterFrame, type Facing } from '../src/sprites/characters.ts';
import type { Modality } from '../src/game/types.ts';

export function drawRaster(canvas: HTMLCanvasElement, r: Raster): void {
  if (canvas.width !== r.w) canvas.width = r.w;
  if (canvas.height !== r.h) canvas.height = r.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, r.w, r.h);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.w, r.h), 0, 0);
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
