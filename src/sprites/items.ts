// Moedas e emblemas de pontos capturáveis (POIs).
import type { Art, Palette } from './pixel.ts';
import { rasterize, createRaster, blit, blendPixel, hexToRgba, type Raster } from './pixel.ts';

const O = '#2a1f3d';

// ---------------------------------------------------------------------------
// Moedas: 10 x 10, giram em 6 quadros (frente, 3/4, perfil, fio, perfil, 3/4).
// ---------------------------------------------------------------------------
const COIN_FULL: Art = [
  '...oooo...',
  '.ooyyyyoo.',
  '.oywwyyyo.',
  'oywyyyyyYo',
  'oyyyddyyYo',
  'oyyyddyyYo',
  'oyyyyyyyYo',
  '.oyyyyyYo.',
  '.ooYYYYoo.',
  '...oooo...',
];
const COIN_34: Art = [
  '...ooo....',
  '..oyyyo...',
  '.oywyyYo..',
  '.owyyyYo..',
  '.oyydyYo..',
  '.oyydyYo..',
  '.oyyyyYo..',
  '.oyyyyYo..',
  '..oYYYo...',
  '...ooo....',
];
const COIN_HALF: Art = [
  '....oo....',
  '...oyyo...',
  '...owyo...',
  '...oyYo...',
  '...oyYo...',
  '...oyYo...',
  '...oyYo...',
  '...oyYo...',
  '...oYYo...',
  '....oo....',
];
const COIN_EDGE: Art = [
  '....oo....',
  '....oo....',
  '....YY....',
  '....YY....',
  '....YY....',
  '....YY....',
  '....YY....',
  '....YY....',
  '....oo....',
  '....oo....',
];
const GEM: Art = [
  '..........',
  '..oooooo..',
  '.owwyyyYo.',
  'owyyyyyyYo',
  'oooooooooo',
  '.oyyyyyYo.',
  '..oyyyYo..',
  '...oyYo...',
  '....oo....',
  '..........',
];

export type CoinKind = 'bronze' | 'silver' | 'gold' | 'gem';
export const COIN_KINDS: CoinKind[] = ['bronze', 'silver', 'gold', 'gem'];

export const COIN_VALUE: Record<CoinKind, number> = { bronze: 1, silver: 5, gold: 20, gem: 100 };
export const COIN_LABEL: Record<CoinKind, string> = {
  bronze: 'Moeda de bronze',
  silver: 'Moeda de prata',
  gold: 'Moeda de ouro',
  gem: 'Gema rara',
};

const COIN_PAL: Record<CoinKind, Palette> = {
  bronze: { o: O, y: '#e8955a', Y: '#a85a2a', w: '#ffd6aa', d: '#c06e3a' },
  silver: { o: O, y: '#dfe3f0', Y: '#8f96b3', w: '#ffffff', d: '#aab0c8' },
  gold: { o: O, y: '#ffd23f', Y: '#c98a12', w: '#fff6c0', d: '#e8a82a' },
  gem: { o: O, y: '#5ff0e0', Y: '#1f9fb0', w: '#e8fffb', d: '#3ad0c8' },
};

export const COIN_W = 16;
export const COIN_H = 20;

function shadow(r: Raster, cx: number, y: number, rx: number, alpha = 0.28): void {
  const c = hexToRgba(O);
  for (let x = -rx; x <= rx; x++) {
    const edge = Math.abs(x) === rx;
    blendPixel(r, cx + x, y, [c[0], c[1], c[2], Math.round(255 * alpha * (edge ? 0.5 : 1))]);
    if (!edge) blendPixel(r, cx + x, y + 1, [c[0], c[1], c[2], Math.round(255 * alpha * 0.6)]);
  }
}

function sparkle(r: Raster, x: number, y: number, size: 1 | 2): void {
  const c = hexToRgba('#ffffff');
  blendPixel(r, x, y, c);
  if (size === 2) {
    blendPixel(r, x - 1, y, c);
    blendPixel(r, x + 1, y, c);
    blendPixel(r, x, y - 1, c);
    blendPixel(r, x, y + 1, c);
  }
}

/** Quadros de 16x20: moeda flutuando sobre a sombra e girando de vez em quando. */
export function coinFrames(kind: CoinKind): Raster[] {
  const pal = COIN_PAL[kind];
  const frames: Raster[] = [];
  const spin: { art: Art; flip?: boolean }[] =
    kind === 'gem'
      ? Array.from({ length: 8 }, () => ({ art: GEM }))
      : [
          { art: COIN_FULL },
          { art: COIN_FULL },
          { art: COIN_FULL },
          { art: COIN_FULL },
          { art: COIN_FULL },
          { art: COIN_FULL },
          { art: COIN_34 },
          { art: COIN_HALF },
          { art: COIN_EDGE },
          { art: COIN_HALF, flip: true },
          { art: COIN_34, flip: true },
          { art: COIN_FULL },
        ];
  for (let i = 0; i < spin.length; i++) {
    const r = createRaster(COIN_W, COIN_H);
    const bob = Math.round(Math.sin((i / spin.length) * Math.PI * 2) * 1.5);
    shadow(r, 8, 17, bob > 0 ? 3 : 4);
    const coin = rasterize(10, 10, [{ art: spin[i].art, flip: spin[i].flip }], pal);
    blit(r, coin, 3, 4 - bob);
    if (kind === 'gem') {
      const pts: [number, number, 1 | 2][] = [[4, 5, 2], [12, 7, 1], [11, 4, 2], [5, 10, 1]];
      const [sx, sy, ss] = pts[i % 4];
      sparkle(r, sx, sy - bob, ss);
    } else if (i === 0) {
      sparkle(r, 11, 4 - bob, 2);
    }
    frames.push(r);
  }
  return frames;
}

// ---------------------------------------------------------------------------
// POIs: categoria -> ícone 12x12 dentro de um emblema com borda da raridade.
// ---------------------------------------------------------------------------
export type Rarity = 'comum' | 'incomum' | 'raro' | 'epico' | 'lendario';
export const RARITIES: Rarity[] = ['comum', 'incomum', 'raro', 'epico', 'lendario'];
export const RARITY_INFO: Record<Rarity, { label: string; color: string; dark: string; xp: number; stars: number }> = {
  comum: { label: 'Comum', color: '#8fd16a', dark: '#4f8f3a', xp: 40, stars: 1 },
  incomum: { label: 'Incomum', color: '#4fb3ff', dark: '#2a6fb8', xp: 80, stars: 2 },
  raro: { label: 'Raro', color: '#b77bff', dark: '#7440c0', xp: 160, stars: 3 },
  epico: { label: 'Épico', color: '#ff9f3d', dark: '#c0601a', xp: 320, stars: 4 },
  lendario: { label: 'Lendário', color: '#ff5f8f', dark: '#c02a5a', xp: 640, stars: 5 },
};

export type PoiCategory =
  | 'parque' | 'arte' | 'templo' | 'cultura' | 'biblioteca'
  | 'museu' | 'monumento' | 'mirante' | 'estadio' | 'atracao';

export const POI_CATEGORIES: PoiCategory[] = [
  'parque', 'arte', 'templo', 'cultura', 'biblioteca', 'museu', 'monumento', 'mirante', 'estadio', 'atracao',
];

/** `radius`: distância de captura em metros (o ponto de um parque fica no centro dele). */
export const POI_INFO: Record<PoiCategory, { label: string; plural: string; rarity: Rarity; radius: number }> = {
  parque: { label: 'Parque / Praça', plural: 'Parques e praças', rarity: 'comum', radius: 70 },
  arte: { label: 'Arte urbana', plural: 'Artes urbanas', rarity: 'comum', radius: 35 },
  templo: { label: 'Templo', plural: 'Templos', rarity: 'incomum', radius: 50 },
  cultura: { label: 'Palco cultural', plural: 'Teatros e cinemas', rarity: 'incomum', radius: 50 },
  biblioteca: { label: 'Biblioteca', plural: 'Bibliotecas', rarity: 'incomum', radius: 50 },
  museu: { label: 'Museu / Galeria', plural: 'Museus e galerias', rarity: 'raro', radius: 70 },
  monumento: { label: 'Monumento', plural: 'Monumentos', rarity: 'raro', radius: 45 },
  mirante: { label: 'Mirante', plural: 'Mirantes', rarity: 'raro', radius: 50 },
  estadio: { label: 'Estádio', plural: 'Estádios', rarity: 'epico', radius: 120 },
  atracao: { label: 'Atração', plural: 'Atrações', rarity: 'epico', radius: 60 },
};

const POI_ICONS: Record<PoiCategory, { art: Art; pal: Palette }> = {
  parque: {
    art: [
      '....oooo....',
      '..oollggoo..',
      '.ollllgggGo.',
      '.olllggggGo.',
      'ollggggggGGo',
      'olgggggggGGo',
      '.oggggGGGGo.',
      '..ooGGGGoo..',
      '....onno....',
      '....onNo....',
      '...onnNNo...',
      '...oooooo...',
    ],
    pal: { o: O, l: '#9be86f', g: '#4fae4a', G: '#2f7a3a', n: '#9a6a3a', N: '#6a4424' },
  },
  arte: {
    art: [
      '...oooooo...',
      '..owwwwwwo..',
      '.owrwwwwbwo.',
      'owrrwwwwbbwo',
      'owwwwyywwwwo',
      'owgwwyywwwwo',
      'owggwwwwoowo',
      'owwwwwwo..oo',
      '.owwppwwo...',
      '.owpppwwo...',
      '..owwwwo....',
      '...oooo.....',
    ],
    pal: { o: O, w: '#fff1d6', r: '#ff5a5a', b: '#4fb3ff', y: '#ffd23f', g: '#4fe0b0', p: '#b77bff' },
  },
  templo: {
    art: [
      '.....oo.....',
      '....oyyo....',
      '.....oo.....',
      '....owwo....',
      '...owwwwo...',
      '..owwwwwwo..',
      '.orrrrrrrro.',
      '..owwbbwwo..',
      '..owbbbbwo..',
      '..owbbbbwo..',
      '..owbbbbwo..',
      '..oooooooo..',
    ],
    pal: { o: O, y: '#ffd23f', w: '#fff1d6', r: '#e0604a', b: '#5a4a8a' },
  },
  cultura: {
    art: [
      '............',
      'oooooo......',
      'oyyyyyo.....',
      'oyeyeyoooooo',
      'oyyyyyoppppo',
      'oyeeeyopepeo',
      '.oyyyoppppo.',
      '..ooooppeepo',
      '.....oppppo.',
      '......oooo..',
      '............',
      '............',
    ],
    pal: { o: O, y: '#ffd23f', e: O, p: '#b77bff' },
  },
  biblioteca: {
    art: [
      '............',
      '.oooo..oooo.',
      'owwwwoowwwwo',
      'owllwoowllwo',
      'owwwwoowwwwo',
      'owllwoowllwo',
      'owwwwoowwwwo',
      'owllwoowllwo',
      'owwwwoowwwwo',
      'obbbbbbbbbbo',
      '.oooo..oooo.',
      '............',
    ],
    pal: { o: O, w: '#fff1d6', l: '#b8a890', b: '#4fb3ff' },
  },
  museu: {
    art: [
      '.....oo.....',
      '...oowwoo...',
      '.oowwwwwwoo.',
      'oooooooooooo',
      '.owowowowo..',
      '.owowowowo..',
      '.owowowowo..',
      '.owowowowo..',
      '.owowowowo..',
      'oooooooooooo',
      'owwwwwwwwwwo',
      'oooooooooooo',
    ],
    pal: { o: O, w: '#fff1d6' },
  },
  monumento: {
    art: [
      '.....oo.....',
      '....owwo....',
      '....owGo....',
      '....owGo....',
      '...owwGGo...',
      '...owwGGo...',
      '...owwGGo...',
      '..owwwGGGo..',
      '..owwwGGGo..',
      '.oooooooooo.',
      'owwwwwwwGGGo',
      'oooooooooooo',
    ],
    pal: { o: O, w: '#e8e3f5', G: '#a9a2c8' },
  },
  mirante: {
    art: [
      '............',
      '.oooo..oooo.',
      'obbbboobbbbo',
      'obwwboobwwbo',
      'obwcboobwcbo',
      'obbbbbbbbbbo',
      'obbbboobbbbo',
      '.oooo..oooo.',
      '............',
      '..oo....oo..',
      '.oggo..oggo.',
      'oooooooooooo',
    ],
    pal: { o: O, b: '#3a3550', w: '#9fd8ff', c: '#ffffff', g: '#8a8fa8' },
  },
  estadio: {
    art: [
      '...oooooo...',
      '..owwwwwwo..',
      '.owwoowwwwo.',
      'owwoooowwwwo',
      'owwwoowwoowo',
      'owwwwwwoooo.',
      'owoowwwwoowo',
      'oooooowwwwwo',
      'owoowwwwoowo',
      '.owwwwoowwo.',
      '..owwwwwwo..',
      '...oooooo...',
    ],
    pal: { o: O, w: '#ffffff' },
  },
  atracao: {
    art: [
      '.....oo.....',
      '....oyyo....',
      '....oyyo....',
      'ooooowyyoooo',
      'oyyyywyyyyyo',
      '.oyyyyyyyyo.',
      '..oyyyyyyo..',
      '..oyyYYyyo..',
      '.oyyyooyyyo.',
      '.oyyo..oyyo.',
      'oyyo....oyyo',
      'ooo......ooo',
    ],
    pal: { o: O, y: '#ffd23f', Y: '#e09a1a', w: '#fff6c0' },
  },
};

const MYSTERY: Art = [
  '...oooooo...',
  '..owwwwwwo..',
  '.owwooooowo.',
  '.owoo..oowo.',
  '..oo...oowo.',
  '......oowo..',
  '.....oowo...',
  '.....owwo...',
  '.....oooo...',
  '.....owwo...',
  '.....owwo...',
  '.....oooo...',
];

const CHECK: Art = [
  '..ooooo.',
  '.oggggo.',
  'ogggggwo',
  'ogwggwgo',
  'oggwwggo',
  '.oggggo.',
  '..oooo..',
];

export type BadgeState = 'wild' | 'captured' | 'fog';
export const BADGE_W = 20;
export const BADGE_H = 26;

function roundedBox(r: Raster, x0: number, y0: number, w: number, h: number, border: string, inner: string, light: string): void {
  const b = hexToRgba(border);
  const o = hexToRgba(O);
  const i = hexToRgba(inner);
  const l = hexToRgba(light);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cx = Math.min(x, w - 1 - x);
      const cy = Math.min(y, h - 1 - y);
      // cantos arredondados de 2px
      if (cx + cy < 2) continue;
      const outer = cx === 0 || cy === 0 || cx + cy === 2;
      const ring = cx === 1 || cy === 1 || cx + cy === 3;
      let c = i;
      if (outer) c = o;
      else if (ring) c = y < h / 2 ? l : b;
      else if (cx === 2 || cy === 2) c = b;
      blendPixel(r, x0 + x, y0 + y, c);
    }
  }
}

function lighten(hex: string, amt: number): string {
  const [r, g, b] = hexToRgba(hex);
  const f = (v: number) => Math.round(v + (255 - v) * amt).toString(16).padStart(2, '0');
  return `#${f(r)}${f(g)}${f(b)}`;
}

/** Emblema 20x26: caixa arredondada + ícone, haste e sombra no chão. */
export function poiBadge(cat: PoiCategory, state: BadgeState): Raster {
  const r = createRaster(BADGE_W, BADGE_H);
  const rarity = RARITY_INFO[POI_INFO[cat].rarity];
  shadow(r, 10, 23, 5, 0.3);
  // haste
  const stem = hexToRgba(O);
  blendPixel(r, 9, 20, stem);
  blendPixel(r, 10, 20, stem);
  blendPixel(r, 9, 21, stem);
  blendPixel(r, 10, 21, stem);
  if (state === 'fog') {
    roundedBox(r, 1, 1, 18, 18, '#6e62a8', '#3a3170', '#8f86c9');
    blit(r, rasterize(12, 12, [{ art: MYSTERY }], { o: '#2a1f3d', w: '#e8e3ff' }), 4, 4);
    return r;
  }
  if (state === 'captured') {
    roundedBox(r, 1, 1, 18, 18, '#e0a82a', '#fff0b0', '#ffe27a');
  } else {
    roundedBox(r, 1, 1, 18, 18, rarity.color, '#fff8ec', lighten(rarity.color, 0.45));
  }
  const icon = POI_ICONS[cat];
  const w = Math.max(...icon.art.map((row) => row.length));
  blit(r, rasterize(w, 12, [{ art: icon.art }], icon.pal), 4 + Math.floor((12 - w) / 2), 4);
  if (state === 'captured') {
    blit(r, rasterize(8, 7, [{ art: CHECK }], { o: O, g: '#2fae5a', w: '#ffffff' }), 12, 0);
  }
  return r;
}

/** Ícone da categoria sozinho (12x12), para a interface. */
export function poiIcon(cat: PoiCategory): Raster {
  const icon = POI_ICONS[cat];
  const w = Math.max(...icon.art.map((row) => row.length));
  return rasterize(w, 12, [{ art: icon.art }], icon.pal);
}

export function coinIcon(kind: CoinKind = 'gold'): Raster {
  return rasterize(10, 10, [{ art: kind === 'gem' ? GEM : COIN_FULL }], COIN_PAL[kind]);
}

export const ALL_ITEM_ART: Record<string, Art> = {
  'coin.full': COIN_FULL,
  'coin.34': COIN_34,
  'coin.half': COIN_HALF,
  'coin.edge': COIN_EDGE,
  gem: GEM,
  mystery: MYSTERY,
  check: CHECK,
  ...Object.fromEntries(Object.entries(POI_ICONS).map(([k, v]) => [`poi.${k}`, v.art])),
};
