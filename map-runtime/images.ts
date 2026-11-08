// Converte os sprites em imagens do MapLibre (texturas, árvores, emblemas, moedas animadas).
import type { Map as MLMap, StyleImageInterface } from 'maplibre-gl';
import { scaleRaster, type Raster } from '../src/sprites/pixel.ts';
import { tileRaster, treeRaster, TILE_NAMES } from '../src/sprites/tiles.ts';
import { COIN_KINDS, coinFrames, poiBadge, POI_CATEGORIES } from '../src/sprites/items.ts';

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

/**
 * Seta da rota (chevron apontando para a direita): com `symbol-placement: line` o MapLibre a gira no sentido
 * da linha. Creme com contorno escuro, gerado aqui em vez de virar mais um sprite.
 */
const ARROW_ROWS = ['##.....', '.##....', '..##...', '...##..', '..##...', '.##....', '##.....'];

function arrowRaster(): Raster {
  const pad = 1;
  const h = ARROW_ROWS.length + pad * 2;
  const w = ARROW_ROWS[0].length + pad * 2;
  const on = (x: number, y: number) => ARROW_ROWS[y - pad]?.[x - pad] === '#';
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let rgb: [number, number, number] | null = null;
      if (on(x, y)) rgb = [0xff, 0xf6, 0xe0];
      else if (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1)) rgb = [0x1d, 0x17, 0x30];
      if (!rgb) continue;
      data.set([...rgb, 255], i);
    }
  }
  return { w, h, data };
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
  add('route-arrow', () => asImage(arrowRaster(), 3));
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
