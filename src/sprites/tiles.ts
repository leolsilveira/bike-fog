// Texturas 16x16 que repetem (fill-pattern do mapa) e decorações (árvores billboard).
import { rasterize, type Art, type Palette, type Raster } from './pixel.ts';

export const MAP_COLORS = {
  grass: '#b7e08e',
  park: '#95d46e',
  forest: '#62b358',
  water: '#5cb9f0',
  sand: '#f3e0a0',
} as const;

const TILES = {
  grass: {
    art: [
      'gggggggggggggggg',
      'gggggggggggggggg',
      'gggdgggggggggggg',
      'ggdgdggggggggggg',
      'gggggggggggglggg',
      'gggggggggggggggg',
      'gggggggggggggggg',
      'gggggggggdgggggg',
      'ggggggggdgdggggg',
      'gggggggggggggggg',
      'glgggggggggggggg',
      'gggggggggggggggg',
      'gggggggggggggdgg',
      'ggggggggggggdgdg',
      'gggggglggggggggg',
      'gggggggggggggggg',
    ],
    pal: { g: MAP_COLORS.grass, d: '#93c96b', l: '#d6f0b4' },
  },
  park: {
    art: [
      'pppppppppppppppp',
      'pppppppppppppppp',
      'pppdpppppppppppp',
      'ppdpdppppppwpppp',
      'pppppppppppwyppp',
      'ppppppppppppwppp',
      'pppppppppppppppp',
      'pppppppppdpppppp',
      'ppppppppdpdppppp',
      'pprppppppppppppp',
      'prkrpppppppppppp',
      'pprppppppppppppp',
      'pppppppppppppdpp',
      'ppppppppppppdpdp',
      'pppppppppppppppp',
      'pppppppppppppppp',
    ],
    pal: { p: MAP_COLORS.park, d: '#6fb54e', w: '#fff8ec', y: '#ffd23f', r: '#ff8fb0', k: '#ffd23f' },
  },
  forest: {
    art: [
      'ffffffffffffffff',
      'ffflllffffffffff',
      'fflllllfffffffff',
      'ffllldllffffffff',
      'fflldddlfffflllf',
      'fffddddfffflllll',
      'ffffddffffllldll',
      'fffffffffflldddl',
      'ffffffffffdddddd',
      'flllfffffffdddff',
      'llllllffffffffff',
      'lllldllfffffffff',
      'llldddlfffffffff',
      'dddddddfffffffff',
      'fdddddffffffffff',
      'ffffffffffffffff',
    ],
    pal: { f: MAP_COLORS.forest, l: '#86d06c', d: '#3f8a45' },
  },
  water: {
    art: [
      'wwwwwwwwwwwwwwww',
      'wwwwwwwwwwwwwwww',
      'wwwllllwwwwwwwww',
      'wwlwwwwlwwwwwwww',
      'wwwwwwwwwwwwwwww',
      'wwwwwwwwwwwwwwww',
      'wwwwwwwwwwwwwwww',
      'wwwwwwwwwwwwwwww',
      'wwwwwwwwwwwwwwww',
      'wwwwwwwwwwllllww',
      'wwwwwwwwwlwwwwlw',
      'wwwwwwwwwwwwwwww',
      'wwwwwwwwwwwwwwww',
      'wwwwwdwwwwwwwwww',
      'wwwwwwwwwwwwwwww',
      'wwwwwwwwwwwwwwww',
    ],
    pal: { w: MAP_COLORS.water, l: '#9edcff', d: '#3f9bd8' },
  },
  sand: {
    art: [
      'ssssssssssssssss',
      'ssssssssssssssss',
      'ssdsssssssssssss',
      'ssssssssssdsssss',
      'ssssssssssssssss',
      'sssssslsssssssss',
      'ssssssssssssssss',
      'ssssssssssssssds',
      'sdssssssssssssss',
      'ssssssssssssssss',
      'ssssssssdsssssss',
      'ssssssssssssssss',
      'ssssslssssssssss',
      'ssssssssssssslss',
      'ssssssssssssssss',
      'ssssssssssssssss',
    ],
    pal: { s: MAP_COLORS.sand, d: '#dcc27a', l: '#fff2c8' },
  },
} satisfies Record<string, { art: Art; pal: Palette }>;

export type TileName = keyof typeof TILES;
export const TILE_NAMES = Object.keys(TILES) as TileName[];

export function tileRaster(name: TileName): Raster {
  const t = TILES[name];
  return rasterize(16, 16, [{ art: t.art }], t.pal);
}

// Árvores que ficam "em pé" no modo 3D (billboards).
const TREE: Art = [
  '....oooooo....',
  '..oollllggoo..',
  '.ollllllgggGo.',
  '.olllllggggGo.',
  'olllllgggggGGo',
  'ollllggggggGGo',
  'olllgggggggGGo',
  '.olggggggGGGo.',
  '.oggggggGGGGo.',
  '..ooGGGGGGoo..',
  '....oonnoo....',
  '.....onNo.....',
  '.....onNo.....',
  '....dddddd....',
];
const PINE: Art = [
  '......oo......',
  '.....ollo.....',
  '....ollggo....',
  '...ollggGGo...',
  '....olgGGo....',
  '...ollggGGo...',
  '..ollgggGGGo..',
  '...olggGGGo...',
  '..ollggggGGo..',
  '.ollgggggGGGo.',
  'ooooooooooooo.',
  '.....onNo.....',
  '.....onNo.....',
  '....dddddd....',
];

const TREE_PAL: Palette = {
  o: '#2a3a2a', l: '#9be86f', g: '#4fae4a', G: '#2f7a3a', n: '#9a6a3a', N: '#6a4424', d: '#2a1f3d40',
};

export function treeRaster(kind: 'round' | 'pine'): Raster {
  return rasterize(14, 14, [{ art: kind === 'round' ? TREE : PINE }], TREE_PAL);
}

export const ALL_TILE_ART: Record<string, Art> = {
  ...Object.fromEntries(Object.entries(TILES).map(([k, v]) => [`tile.${k}`, v.art])),
  'tree.round': TREE,
  'tree.pine': PINE,
};
