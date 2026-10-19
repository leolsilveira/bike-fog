// Converte os sprites em imagens do MapLibre (texturas, árvores, emblemas, moedas animadas).
import type { Map as MLMap, StyleImageInterface } from 'maplibre-gl';
import { scaleRaster, type Raster } from '../sprites/pixel.ts';
import { tileRaster, treeRaster, TILE_NAMES } from '../sprites/tiles.ts';
import { COIN_KINDS, coinFrames, poiBadge, POI_CATEGORIES } from '../sprites/items.ts';

/** Pixels de tela (CSS) por pixel de sprite no mapa. */
const SPRITE_CSS_SCALE = 3;

function dpr(): number {
  return Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
}

function asImage(r: Raster, cssScale: number) {
  const k = cssScale * dpr();
  const s = scaleRaster(r, k);
  return {
    image: { width: s.w, height: s.h, data: new Uint8Array(s.data.buffer, s.data.byteOffset, s.data.byteLength) },
    pixelRatio: k / cssScale,
  };
}

class AnimatedSprite implements StyleImageInterface {
  width: number;
  height: number;
  data: Uint8Array;
  private frames: Uint8Array[];
  private current = -1;
  private fps: number;

  constructor(frames: Raster[], cssScale: number, fps: number) {
    this.fps = fps;
    const k = cssScale * dpr();
    this.frames = frames.map((f) => {
      const s = scaleRaster(f, k);
      return new Uint8Array(s.data.buffer, s.data.byteOffset, s.data.byteLength);
    });
    const first = scaleRaster(frames[0], k);
    this.width = first.w;
    this.height = first.h;
    this.data = new Uint8Array(this.frames[0]);
  }

  render(): boolean {
    const f = Math.floor((performance.now() / 1000) * this.fps) % this.frames.length;
    if (f === this.current) return false;
    this.current = f;
    this.data.set(this.frames[f]);
    return true;
  }
}

type ImageFactory = () => void;

export function registerImages(map: MLMap): void {
  const factories = new Map<string, ImageFactory>();
  const add = (id: string, make: () => { image: { width: number; height: number; data: Uint8Array }; pixelRatio: number }) =>
    factories.set(id, () => {
      if (map.hasImage(id)) return;
      const { image, pixelRatio } = make();
      map.addImage(id, image, { pixelRatio });
    });

  for (const name of TILE_NAMES) add(`tile-${name}`, () => asImage(tileRaster(name), 2));
  add('tree-round', () => asImage(treeRaster('round'), SPRITE_CSS_SCALE));
  add('tree-pine', () => asImage(treeRaster('pine'), SPRITE_CSS_SCALE));
  for (const cat of POI_CATEGORIES) {
    add(`poi-${cat}-wild`, () => asImage(poiBadge(cat, 'wild'), SPRITE_CSS_SCALE));
    add(`poi-${cat}-captured`, () => asImage(poiBadge(cat, 'captured'), SPRITE_CSS_SCALE));
  }
  add('poi-fog', () => asImage(poiBadge('parque', 'fog'), SPRITE_CSS_SCALE));
  for (const kind of COIN_KINDS) {
    factories.set(`coin-${kind}`, () => {
      const id = `coin-${kind}`;
      if (map.hasImage(id)) return;
      const img = new AnimatedSprite(coinFrames(kind), SPRITE_CSS_SCALE, kind === 'gem' ? 6 : 10);
      map.addImage(id, img, { pixelRatio: dpr() });
    });
  }

  map.on('styleimagemissing', (e) => factories.get(e.id)?.());
  for (const make of factories.values()) make();
}
