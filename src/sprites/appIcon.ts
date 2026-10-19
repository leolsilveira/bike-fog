// Ícone do app: personagem de bike sobre um "buraco" na névoa.
import { createRaster, blit, blendPixel, hexToRgba, scaleRaster, type Raster } from './pixel.ts';
import { CHARACTERS, characterFrame } from './characters.ts';
import { coinIcon } from './items.ts';

const NATIVE = 32;

export function appIconNative(): Raster {
  const r = createRaster(NATIVE, NATIVE);
  const fogDark = hexToRgba('#2a2445');
  const fogLight = hexToRgba('#4b4175');
  const land = hexToRgba('#b7e08e');
  const road = hexToRgba('#fff3d1');
  const roadEdge = hexToRgba('#c9a77c');
  for (let y = 0; y < NATIVE; y++) {
    for (let x = 0; x < NATIVE; x++) {
      const dx = x - 15.5;
      const dy = y - 17.5;
      const d = Math.sqrt(dx * dx + dy * dy * 1.6);
      // pontilhado nas bordas da clareira (mesmo dithering da névoa no jogo)
      const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5][(y % 4) * 4 + (x % 4)] / 16;
      const t = (d - 9) / 4;
      if (t < bayer) {
        const onRoad = Math.abs(x - 15.5 - (y - 17) * 0.35) < 2.2;
        const edge = Math.abs(x - 15.5 - (y - 17) * 0.35) < 3.2;
        blendPixel(r, x, y, onRoad ? road : edge ? roadEdge : land);
      } else {
        const cloud = Math.sin(x * 0.7 + y * 0.3) + Math.sin(y * 0.9 - x * 0.2) > 0.9;
        blendPixel(r, x, y, cloud ? fogLight : fogDark);
      }
    }
  }
  const hero = characterFrame(CHARACTERS[0], 'bike', 'up', 0);
  blit(r, hero, 4, 3);
  blit(r, coinIcon('gold'), 21, 4);
  return r;
}

export function appIcon(size: number): Raster {
  const native = appIconNative();
  const k = Math.max(1, Math.floor(size / NATIVE));
  const scaled = scaleRaster(native, k);
  if (scaled.w === size) return scaled;
  const out = createRaster(size, size);
  const bg = hexToRgba('#2a2445');
  for (let i = 0; i < size * size; i++) out.data.set(bg, i * 4);
  blit(out, scaled, Math.floor((size - scaled.w) / 2), Math.floor((size - scaled.h) / 2));
  return out;
}
