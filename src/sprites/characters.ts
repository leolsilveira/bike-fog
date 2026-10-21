// Personagens em pixel art (chibi 16-bit). Cabeça e corpo são camadas separadas
// para combinar penteados, capacete (ciclismo) e paletas por personagem.
import { rasterize, flipRaster, type Art, type Palette, type Layer, type Raster } from './pixel.ts';

export type Dir = 'down' | 'up' | 'side';
export type Facing = 'down' | 'up' | 'left' | 'right';
export type Modality = 'bike' | 'run';
export type HairStyle = 'short' | 'pony' | 'puff';

// ---------------------------------------------------------------------------
// Cabeças: 20 x 14. Olhos nas linhas 9-10, queixo/nuca na linha 13.
// ---------------------------------------------------------------------------
const HEADS: Record<HairStyle, Record<Dir, Art>> = {
  short: {
    down: [
      '....................',
      '....................',
      '......oooooooo......',
      '.....ohhjjhhhho.....',
      '....ohhhhhhhhhho....',
      '....ohhhhhhhhhho....',
      '....ohHhhhhhhHho....',
      '....oHsssHHsssHo....',
      '....osssssssssso....',
      '....ossessssesso....',
      '....ossessssesso....',
      '....omssssssssmo....',
      '.....osssSSssso.....',
      '......oooooooo......',
    ],
    up: [
      '....................',
      '....................',
      '......oooooooo......',
      '.....ohhhjjhhho.....',
      '....ohhhhjhhhhho....',
      '....ohhhhhhhhhho....',
      '....ohhhhhhhhhho....',
      '....ohhhhhhhhhho....',
      '....ohHhhhhhhHho....',
      '....oHhhhhhhhhHo....',
      '....osHhhhhhhHso....',
      '....oSsHHHHHHsSo....',
      '.....oSssssssSo.....',
      '......oooooooo......',
    ],
    side: [
      '....................',
      '....................',
      '.......ooooooo......',
      '......ohhhjjhho.....',
      '.....ohhhhhjhhho....',
      '....ohhhhhhhhhhho...',
      '....ohhhhhhhhhhho...',
      '....ohhhhhhhHHsso...',
      '....ohhhhhhHsssso...',
      '....ohhhhoSssseso...',
      '....ohhhhoSsssesso..',
      '....ohhhhhssssmso...',
      '.....ohhhsssssso....',
      '......ooooooooo.....',
    ],
  },
  pony: {
    down: [
      '....................',
      '....................',
      '......oooooooo......',
      '.....ohhjjhhhho.....',
      '....ohhhhhhhhhho....',
      '...ohhhhhhhhhhhho...',
      '...ohhHhhhhhhhHho...',
      '...ohHsssHHsssHho...',
      '...ohssssssssssho...',
      '...ohssessssessho...',
      '...ohssessssessho...',
      '...oHmssssssssmHo...',
      '...oHosssSSsssoHo...',
      '....oooooooooooo....',
    ],
    up: [
      '....................',
      '....................',
      '......oooooooo......',
      '.....ohhhjjhhho.....',
      '....ohhhhjhhhhho....',
      '....ohhhhhhhhhho....',
      '....ohhhhhhhhhho....',
      '....ohhhhtthhhho....',
      '....ohHhhhhhhHho....',
      '....oHhhhhhhhhHo....',
      '....osHhhhhhhHso....',
      '....oSsHhhhhHsSo....',
      '.....oSsohhosSo.....',
      '......ooohhooo......',
      '........ohho........',
      '........ohHo........',
      '.........oo.........',
    ],
    side: [
      '....................',
      '....................',
      '.......ooooooo......',
      '......ohhhjjhho.....',
      '.....ohhhhhjhhho....',
      '....ohhhhhhhhhhho...',
      '..oothhhhhhhhhhho...',
      '.ohhthhhhhhhHHsso...',
      '.ohHohhhhhhHsssso...',
      '.ohHohhhhoSssseso...',
      '..oHohhhhoSsssesso..',
      '..ooohhhhhssssmso...',
      '.....ohhhsssssso....',
      '......ooooooooo.....',
    ],
  },
  puff: {
    down: [
      '......oooooooo......',
      '....oohhhjjhhhoo....',
      '...ohhhhhjjhhhhho...',
      '..ohhhhhhhhhhhhhho..',
      '..ohhhhhhhhhhhhhho..',
      '..ohhHhhhhhhhhhHho..',
      '..ohHhhhhhhhhhhhHo..',
      '..ohoHsssHHsssHoho..',
      '..ohossssssssssoho..',
      '..oHossessssessoHo..',
      '...oossessssessoo...',
      '....omssssssssmo....',
      '.....osssSSssso.....',
      '......oooooooo......',
    ],
    up: [
      '......oooooooo......',
      '....oohhhjjhhhoo....',
      '...ohhhhhjjhhhhho...',
      '..ohhhhhhhhhhhhhho..',
      '..ohhhhhhhhhhhhhho..',
      '..ohhhhhhhhhhhhhho..',
      '..ohhhhhhhhhhhhhho..',
      '..ohhHhhhhhhhhhHho..',
      '..ohHhhhhhhhhhhhHo..',
      '..oHHhhhhhhhhhhHHo..',
      '...oHHhhhhhhhhHHo...',
      '....oSHHHHHHHHSo....',
      '.....oSssssssSo.....',
      '......oooooooo......',
    ],
    side: [
      '.......ooooooo......',
      '.....oohhhjjhhoo....',
      '....ohhhhhhjhhhhho..',
      '...ohhhhhhhhhhhhhho.',
      '..ohhhhhhhhhhhhhhho.',
      '..ohhhhhhhhhhhhhhho.',
      '..ohhhhhhhhhhhhhhho.',
      '..ohhhhhhhhhHHsso...',
      '..ohhhhhhhhHsssso...',
      '..ohhhhhhoSssseso...',
      '..ohhhhhhoSsssesso..',
      '..oHhhhhhhssssmso...',
      '...oHHhhhsssssso....',
      '....ooooooooooo.....',
    ],
  },
};

// Capacete (só no ciclismo), desenhado por cima do cabelo.
const HELMET: Record<Dir, Art> = {
  down: [
    '....................',
    '......oooooooo......',
    '....ooyyyyyyyyoo....',
    '...oyyvyyyyyyvyyo...',
    '...oyyvyyyyyyvyyo...',
    '...oYyyyyyyyyyyYo...',
    '...ooYYYYYYYYYYoo...',
    '....ovvvvvvvvvvo....',
  ],
  up: [
    '....................',
    '......oooooooo......',
    '....ooyyyyyyyyoo....',
    '...oyyYyyyyyyYyyo...',
    '...oyyYyyyyyyYyyo...',
    '...oyyYyyyyyyYyyo...',
    '...oYyyyyrryyyyYo...',
    '...ooYYYYYYYYYYoo...',
  ],
  side: [
    '....................',
    '.......ooooooo......',
    '.....ooyyyyyyyoo....',
    '...ooyyyvyyyvyyyo...',
    '..oyyyyyvyyyvyyyyo..',
    '..ooYyyyyyyyyyyyYo..',
    '....ooYYYYYYYYYYvo..',
    '..........ovvvvvo...',
  ],
};

// ---------------------------------------------------------------------------
// Corpo do corredor: 20 x 12, encaixa logo abaixo da cabeça (y = 14).
// ---------------------------------------------------------------------------
const RUN: Record<Dir, Art[]> = {
  down: [
    [
      '......otttttto......',
      '.....otttttttto.....',
      '....osTttttttTso....',
      '....osTttttttTso....',
      '....oSottttttoSo....',
      '.....oppppppppo.....',
      '.....opppPPpppo.....',
      '.....opppoopppo.....',
      '.....osso..osso.....',
      '.....owwo..owwo.....',
      '.....obbo..obbo.....',
      '.....oooo..oooo.....',
    ],
    [
      '......otttttto......',
      '.....otttttttto.....',
      '....osTttttttTso....',
      '....oSTttttttTso....',
      '....oootttttToSo....',
      '.....oppppppppo.....',
      '.....opppPPpppo.....',
      '.....opppoopppo.....',
      '.....osso..osso.....',
      '.....owwo..obbo.....',
      '.....obbo..oooo.....',
      '.....oooo...........',
    ],
    [
      '......otttttto......',
      '.....otttttttto.....',
      '....osTttttttTso....',
      '....osTttttttTSo....',
      '....oSoTtttttooo....',
      '.....oppppppppo.....',
      '.....opppPPpppo.....',
      '.....opppoopppo.....',
      '.....osso..osso.....',
      '.....obbo..owwo.....',
      '.....oooo..obbo.....',
      '...........oooo.....',
    ],
  ],
  up: [
    [
      '......otttttto......',
      '.....otttttttto.....',
      '....osTtwwwwtTso....',
      '....osTtweewtTso....',
      '....oSottttttoSo....',
      '.....oppppppppo.....',
      '.....opppPPpppo.....',
      '.....opppoopppo.....',
      '.....osso..osso.....',
      '.....owwo..owwo.....',
      '.....obbo..obbo.....',
      '.....oooo..oooo.....',
    ],
    [
      '......otttttto......',
      '.....otttttttto.....',
      '....osTtwwwwtTso....',
      '....oSTtweewtTso....',
      '....oootttttToSo....',
      '.....oppppppppo.....',
      '.....opppPPpppo.....',
      '.....opppoopppo.....',
      '.....osso..osso.....',
      '.....owwo..obbo.....',
      '.....obbo..oooo.....',
      '.....oooo...........',
    ],
    [
      '......otttttto......',
      '.....otttttttto.....',
      '....osTtwwwwtTso....',
      '....osTtweewtTSo....',
      '....oSoTtttttooo....',
      '.....oppppppppo.....',
      '.....opppPPpppo.....',
      '.....opppoopppo.....',
      '.....osso..osso.....',
      '.....obbo..owwo.....',
      '.....oooo..obbo.....',
      '...........oooo.....',
    ],
  ],
  side: [
    [
      '........ottto.......',
      '.......ottttto......',
      '.......ottTtto......',
      '.......ottTtto......',
      '.......ottstto......',
      '.......opppppo......',
      '.......opppppo......',
      '.......oppPppo......',
      '........osso........',
      '........owwo........',
      '........obbbbo......',
      '........oooooo......',
    ],
    [
      '........ottto.......',
      '.......ottttto......',
      '.......ottTtto......',
      '.......ottTttso.....',
      '......oSttttto......',
      '.......opppppo......',
      '......oppppppo......',
      '.....opppo.oppo.....',
      '....osso...osso.....',
      '...owwo.....owwo....',
      '..obbo.......obbbo..',
      '..ooo........ooooo..',
    ],
    [
      '........ottto.......',
      '.......ottttto......',
      '.......ottTtto......',
      '......oSttTtto......',
      '.......ottttso......',
      '.......opppppo......',
      '.......oppppppo.....',
      '.......opppoppo.....',
      '.......osso.osso....',
      '.......owwo..oSSo...',
      '......obbbbo..obbo..',
      '......oooooo..ooo...',
    ],
  ],
};

// ---------------------------------------------------------------------------
// Ciclista + bicicleta. Cada quadro: 24 x 16, encaixa em y = 13 (sentado, mais baixo).
// ---------------------------------------------------------------------------
function withMirror(art: Art): Art[] {
  return [art, art.map((row) => row.split('').reverse().join(''))];
}

const BIKE: Record<Dir, Art[]> = {
  // Vista de trás (modo gravar): roda traseira fina no centro, pernas pedalando dos lados.
  // O segundo quadro é o espelho do primeiro (pernas trocadas).
  up: withMirror([
    '.......oottttttoo.......',
    '......ottTttttTtto......',
    '.....osottttttttoso.....',
    '....osso.TttttT.osso....',
    '...gSso..oppppo..osSg...',
    '.........oPppPo.........',
    '.......oppokKoppo.......',
    '.......ossokKosso.......',
    '.......ossokKowwo.......',
    '.......ossorroobbo......',
    '.......owwokKoooo.......',
    '.......obbokKo..........',
    '......obbbokKo..........',
    '......oooookKo..........',
    '..........okko..........',
    '...........oo...........',
  ]),
  down: withMirror([
    '.......oottttttoo.......',
    '......ottTttttTtto......',
    '.....osottttttttoso.....',
    '...goSsoggggggggosSog...',
    '....ooo..oppppo..ooo....',
    '.........oPppPo.........',
    '.......oppogGoppo.......',
    '.......ossokKosso.......',
    '.......ossokKowwo.......',
    '.......ossokKoobbo......',
    '.......owwokKoooo.......',
    '.......obbokKo..........',
    '......obbbokKo..........',
    '......oooookKo..........',
    '..........okko..........',
    '...........oo...........',
  ]),
  // Vista lateral (indo para a direita): duas rodas, quadro, ciclista inclinado.
  side: [
    [
      '.........otttto.........',
      '........otttttto........',
      '........ottttTttoo......',
      '.......opppTtttttso.....',
      '.......oppppoootoSgo....',
      '......oopppppo...ofo....',
      '....ffffoppso....ofo....',
      '...offfffossoffffffo....',
      '..okkkkfo.owwffo.okkkk..',
      '.okkoKkkoffobbfoofkkKkko',
      'okko..okkofooooffko..okk',
      'okk...offfgggfo.okk...ok',
      'okko..okkoofgfo.okko..ok',
      '.okkoKkko...o....okkoKko',
      '..okkkko..........okkkko',
      '...oooo............oooo.',
    ],
    [
      '.........otttto.........',
      '........otttttto........',
      '........ottttTttoo......',
      '.......opppTtttttso.....',
      '.......oppppoootoSgo....',
      '......oopppppo...ofo....',
      '....ffffopppo....ofo....',
      '...offfffoppoffffffo....',
      '..okkkkfo.ossfo..okkkk..',
      '.okkKokkoffosso.ofkkoKko',
      'okko..okkofgowwoofko..ok',
      'okk...offfgggobbo.kk...o',
      'okko..okkoofgooo.okko..o',
      '.okkoKkko........okKokko',
      '..okkkko..........okkkko',
      '...oooo............oooo.',
    ],
  ],
};

// Onde cada camada encaixa no quadro final (24 x 30).
export const FRAME_W = 24;
export const FRAME_H = 30;
const HEAD_X = 2;
const RUN_BODY_Y = 14;
const RUN_HEAD_Y = 0;
const BIKE_HEAD_Y = 0;
const BIKE_BODY_Y = 13;

// ---------------------------------------------------------------------------
// Paletas
// ---------------------------------------------------------------------------
export const BASE_PALETTE: Palette = {
  o: '#2a1f3d',
  e: '#2a1f3d',
  w: '#fff8ec',
  m: '#f4978e',
  k: '#2b2838',
  K: '#5a5470',
  g: '#c3c7da',
  G: '#80849c',
  r: '#ff5a5a',
  v: '#3a2f55',
};

export interface CharacterColors {
  skin: string;
  skinShade: string;
  hair: string;
  hairShade: string;
  hairLight: string;
  top: string;
  topShade: string;
  bottom: string;
  bottomShade: string;
  shoe: string;
  helmet: string;
  helmetShade: string;
  bike: string;
  bikeShade: string;
}

export interface CharacterDef {
  id: string;
  name: string;
  tagline: string;
  hair: HairStyle;
  price: number;
  colors: CharacterColors;
}

export const CHARACTERS: CharacterDef[] = [
  {
    id: 'lia',
    name: 'Lia',
    tagline: 'Rata de ciclovia. Nunca recusa uma subida.',
    hair: 'pony',
    price: 0,
    colors: {
      skin: '#e8b48a', skinShade: '#c98d66',
      hair: '#4a2c2a', hairShade: '#2f1b1d', hairLight: '#7a4a3c',
      top: '#ff6b5a', topShade: '#c94a3f',
      bottom: '#2f3e7a', bottomShade: '#1f2a57',
      shoe: '#4fe0b0',
      helmet: '#ffd23f', helmetShade: '#d19a1a',
      bike: '#4fe0b0', bikeShade: '#2a9c7a',
    },
  },
  {
    id: 'teo',
    name: 'Téo',
    tagline: 'Corre de madrugada atrás de padaria nova.',
    hair: 'short',
    price: 0,
    colors: {
      skin: '#f6cfae', skinShade: '#d9a582',
      hair: '#8a5a32', hairShade: '#5e3b20', hairLight: '#b07a48',
      top: '#4fe0b0', topShade: '#2a9c7a',
      bottom: '#3a3550', bottomShade: '#25213a',
      shoe: '#ff6b5a',
      helmet: '#5ab8f0', helmetShade: '#3a83b8',
      bike: '#ff6b5a', bikeShade: '#c94a3f',
    },
  },
  {
    id: 'dandara',
    name: 'Dandara',
    tagline: 'Coleciona mirantes como quem coleciona figurinhas.',
    hair: 'puff',
    price: 0,
    colors: {
      skin: '#8d5a3b', skinShade: '#6b4029',
      hair: '#2a1a1a', hairShade: '#160d0f', hairLight: '#4a3030',
      top: '#ffd23f', topShade: '#d19a1a',
      bottom: '#6e4bd8', bottomShade: '#4a2fa0',
      shoe: '#fff8ec',
      helmet: '#ff6b9a', helmetShade: '#c94a75',
      bike: '#6e4bd8', bikeShade: '#4a2fa0',
    },
  },
  {
    id: 'kenji',
    name: 'Kenji',
    tagline: 'Sabe o nome de todas as praças do bairro.',
    hair: 'short',
    price: 250,
    colors: {
      skin: '#f1c7a0', skinShade: '#d1a07a',
      hair: '#1d1a2a', hairShade: '#0f0d18', hairLight: '#3a3552',
      top: '#5ab8f0', topShade: '#3a83b8',
      bottom: '#e9e3d0', bottomShade: '#b9b2a0',
      shoe: '#ffd23f',
      helmet: '#fff8ec', helmetShade: '#c9c2b0',
      bike: '#1d1a2a', bikeShade: '#0f0d18',
    },
  },
  {
    id: 'maya',
    name: 'Maya',
    tagline: 'Cabelo rosa, pace de elite, zero GPS perdido.',
    hair: 'pony',
    price: 500,
    colors: {
      skin: '#c48a64', skinShade: '#a16a48',
      hair: '#ff7ab8', hairShade: '#c94a8a', hairLight: '#ffb0d6',
      top: '#6e4bd8', topShade: '#4a2fa0',
      bottom: '#1d1a2a', bottomShade: '#0f0d18',
      shoe: '#ff7ab8',
      helmet: '#4fe0b0', helmetShade: '#2a9c7a',
      bike: '#ffd23f', bikeShade: '#d19a1a',
    },
  },
  {
    id: 'zeca',
    name: 'Zeca',
    tagline: 'Lenda do pedal. Ninguém sabe quantos km ele tem.',
    hair: 'puff',
    price: 900,
    colors: {
      skin: '#f3c3a0', skinShade: '#d39a76',
      hair: '#e0732e', hairShade: '#b0521a', hairLight: '#ffa05a',
      top: '#2fae5a', topShade: '#1e7a3e',
      bottom: '#ffd23f', bottomShade: '#d19a1a',
      shoe: '#2a1f3d',
      helmet: '#ff6b5a', helmetShade: '#c94a3f',
      bike: '#c3c7da', bikeShade: '#80849c',
    },
  },
];

export function characterById(id: string): CharacterDef {
  return CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
}

export function paletteFor(def: CharacterDef): Palette {
  const c = def.colors;
  return {
    ...BASE_PALETTE,
    s: c.skin,
    S: c.skinShade,
    h: c.hair,
    H: c.hairShade,
    j: c.hairLight,
    t: c.top,
    T: c.topShade,
    p: c.bottom,
    P: c.bottomShade,
    b: c.shoe,
    B: c.shoe,
    y: c.helmet,
    Y: c.helmetShade,
    f: c.bike,
    F: c.bikeShade,
  };
}

/** Número de quadros da animação de movimento. */
export function frameCount(modality: Modality): number {
  return modality === 'run' ? 4 : 2;
}

function dirOf(facing: Facing): Dir {
  return facing === 'left' || facing === 'right' ? 'side' : facing;
}

/**
 * Compõe um quadro do personagem. `frame` < 0 = parado.
 * Corrida: ciclo [passoA, apoio, passoB, apoio] com leve quique.
 */
export function characterFrame(def: CharacterDef, modality: Modality, facing: Facing, frame: number): Raster {
  const dir = dirOf(facing);
  const pal = paletteFor(def);
  const layers: Layer[] = [];
  let bob = 0;
  if (modality === 'run') {
    const cycle = [1, 0, 2, 0];
    const pose = frame < 0 ? 0 : cycle[frame % 4];
    bob = frame >= 0 && pose === 0 ? 1 : 0;
    layers.push({ art: RUN[dir][pose], x: HEAD_X, y: RUN_BODY_Y + bob + 2 });
    layers.push({ art: HEADS[def.hair][dir], x: HEAD_X, y: RUN_HEAD_Y + bob + 2 });
  } else {
    const pose = frame < 0 ? 0 : frame % 2;
    bob = frame >= 0 && pose === 1 ? 1 : 0;
    layers.push({ art: BIKE[dir][pose], x: 0, y: BIKE_BODY_Y + 1 });
    const headX = dir === 'side' ? HEAD_X + 3 : HEAD_X;
    layers.push({ art: HEADS[def.hair][dir], x: headX, y: BIKE_HEAD_Y + bob });
    layers.push({ art: HELMET[dir], x: headX, y: BIKE_HEAD_Y + bob });
  }
  const r = rasterize(FRAME_W, FRAME_H, layers, pal);
  return facing === 'left' ? flipRaster(r) : r;
}

/** Todas as artes (para validação no script de exportação). */
export const ALL_CHARACTER_ART: Record<string, Art> = (() => {
  const out: Record<string, Art> = {};
  for (const [style, dirs] of Object.entries(HEADS)) for (const [d, a] of Object.entries(dirs)) out[`head.${style}.${d}`] = a;
  for (const [d, a] of Object.entries(HELMET)) out[`helmet.${d}`] = a;
  for (const [d, frames] of Object.entries(RUN)) frames.forEach((a, i) => (out[`run.${d}.${i}`] = a));
  for (const [d, frames] of Object.entries(BIKE)) frames.forEach((a, i) => (out[`bike.${d}.${i}`] = a));
  return out;
})();
