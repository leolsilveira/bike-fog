// Valida as artes e exporta PNGs: folhas de preview e os ícones/splash do app em assets/.
// Uso: node scripts/export-sprites.ts [pasta-de-preview]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodePng } from './png.ts';
import { checkArt, createRaster, blit, scaleRaster, hexToRgba, type Raster } from '../src/sprites/pixel.ts';
import {
  ALL_CHARACTER_ART, CHARACTERS, characterFrame, frameCount, type Facing, type Modality,
} from '../src/sprites/characters.ts';
import { ALL_ITEM_ART, coinFrames, coinIcon, poiBadge, POI_CATEGORIES, COIN_KINDS } from '../src/sprites/items.ts';
import { ALL_ICON_ART, ICON_NAMES, iconRaster } from '../src/sprites/icons.ts';
import { ALL_TILE_ART, TILE_NAMES, tileRaster } from '../src/sprites/tiles.ts';
import { appIcon, appIconNative } from '../src/sprites/appIcon.ts';

const previewDir = process.argv[2] ?? 'dist-sprites';
mkdirSync(previewDir, { recursive: true });

const errors = [
  ...Object.entries(ALL_CHARACTER_ART),
  ...Object.entries(ALL_ITEM_ART),
  ...Object.entries(ALL_ICON_ART),
  ...Object.entries(ALL_TILE_ART),
].flatMap(([name, art]) => checkArt(name, art));
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
}

function fill(r: Raster, color: string): Raster {
  const c = hexToRgba(color);
  for (let i = 0; i < r.w * r.h; i++) r.data.set(c, i * 4);
  return r;
}

function sheet(cells: Raster[][], cellW: number, cellH: number, bg: string, gap = 2): Raster {
  const cols = Math.max(...cells.map((row) => row.length));
  const out = fill(createRaster(cols * (cellW + gap) + gap, cells.length * (cellH + gap) + gap), bg);
  cells.forEach((row, y) => row.forEach((r, x) => blit(out, r, gap + x * (cellW + gap), gap + y * (cellH + gap))));
  return out;
}

// Personagens: uma linha por personagem/modalidade, todas as direções e quadros.
const facings: Facing[] = ['down', 'up', 'right', 'left'];
const charRows: Raster[][] = [];
for (const def of CHARACTERS) {
  for (const m of ['run', 'bike'] as Modality[]) {
    const row: Raster[] = [];
    for (const f of facings) {
      row.push(characterFrame(def, m, f, -1));
      for (let i = 0; i < frameCount(m); i++) row.push(characterFrame(def, m, f, i));
    }
    charRows.push(row);
  }
}
writeFileSync(join(previewDir, 'characters.png'), encodePng(scaleRaster(sheet(charRows, 24, 30, '#9fd18a'), 4)));

// Itens: moedas (todos os quadros) e emblemas de POI (selvagem, capturado, névoa).
const itemRows: Raster[][] = COIN_KINDS.map((k) => coinFrames(k));
itemRows.push(POI_CATEGORIES.map((c) => poiBadge(c, 'wild')));
itemRows.push(POI_CATEGORIES.map((c) => poiBadge(c, 'captured')));
itemRows.push([poiBadge('parque', 'fog')]);
writeFileSync(join(previewDir, 'items.png'), encodePng(scaleRaster(sheet(itemRows, 24, 30, '#efe6c8'), 5)));

const iconRow = ICON_NAMES.map((n) => iconRaster(n, '#fff6e0'));
writeFileSync(join(previewDir, 'icons.png'), encodePng(scaleRaster(sheet([iconRow], 16, 16, '#2a2445'), 6)));

const tileRow = TILE_NAMES.map((n) => {
  const t = tileRaster(n);
  const out = createRaster(t.w * 3, t.h * 3);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) blit(out, t, x * t.w, y * t.h);
  return out;
});
writeFileSync(join(previewDir, 'tiles.png'), encodePng(scaleRaster(sheet([tileRow], 48, 48, '#000000'), 4)));

// ---------------------------------------------------------------------------
// Ícones e splash do app (assets/, referenciados no app.json). Sempre vizinho mais próximo e escala inteira.
// ---------------------------------------------------------------------------

/** Lado da arte do ícone (appIconNative), em pixels de arte. */
const ART = 32;
const FOG_DARK = hexToRgba('#2a2445');
const FOG_LIGHT = hexToRgba('#4b4175');

/**
 * A mesma névoa de appIconNative (src/sprites/appIcon.ts), mas em qualquer coordenada: o fundo do ícone
 * adaptativo do Android vai além dos 32×32 da arte. `checkLayers` confere a fórmula pixel a pixel.
 */
function fogAt(x: number, y: number): [number, number, number, number] {
  const cloud = Math.sin(x * 0.7 + y * 0.3) + Math.sin(y * 0.9 - x * 0.2) > 0.9;
  return cloud ? FOG_LIGHT : FOG_DARK;
}

/** Névoa num quadrado de `grid` pixels de arte, com a arte original começando em (off, off). */
function fogLayer(grid: number, off: number): Raster {
  const r = createRaster(grid, grid);
  for (let y = 0; y < grid; y++) for (let x = 0; x < grid; x++) r.data.set(fogAt(x - off, y - off), (y * grid + x) * 4);
  return r;
}

/**
 * Frente do ícone: clareira, herói e moeda sem a névoa, em (offX, offY) de um quadrado de `grid`.
 * Herói e moeda são desenhados de novo, nas mesmas posições e ordem de appIcon.ts: em appIconNative a última
 * linha da roda cai fora dos 32×32, e aqui a arte pode ter espaço em volta.
 */
function frontLayer(grid: number, offX: number, offY = offX): Raster {
  const native = appIconNative();
  const front = createRaster(ART, ART);
  for (let y = 0; y < ART; y++) {
    for (let x = 0; x < ART; x++) {
      const i = (y * ART + x) * 4;
      const fog = fogAt(x, y);
      const isFog = [0, 1, 2, 3].every((k) => native.data[i + k] === fog[k]);
      if (!isFog) front.data.set(native.data.subarray(i, i + 4), i);
    }
  }
  const out = createRaster(grid, grid);
  blit(out, front, offX, offY);
  blit(out, characterFrame(CHARACTERS[0], 'bike', 'up', 0), offX + 4, offY + 3);
  blit(out, coinIcon('gold'), offX + 21, offY + 4);
  return out;
}

function crop(r: Raster, x0: number, y0: number, w: number, h: number): Raster {
  const out = createRaster(w, h);
  for (let y = 0; y < h; y++) out.data.set(r.data.subarray(((y0 + y) * r.w + x0) * 4, ((y0 + y) * r.w + x0 + w) * 4), y * w * 4);
  return out;
}

/** Garante que névoa + frente recompõem exatamente o appIconNative (pega mudanças em appIcon.ts). */
function checkLayers(): void {
  const native = appIconNative();
  const comp = fogLayer(ART, 0);
  blit(comp, frontLayer(ART, 0), 0, 0);
  for (let i = 0; i < native.data.length; i++) {
    if (comp.data[i] !== native.data[i]) {
      const p = i >> 2;
      throw new Error(`export-sprites: as camadas do ícone não batem com appIconNative em (${p % ART}, ${Math.floor(p / ART)}): ${comp.data.subarray(p * 4, p * 4 + 4)} ≠ ${native.data.subarray(p * 4, p * 4 + 4)} (src/sprites/appIcon.ts mudou?)`);
    }
  }
}

/**
 * Versão monocromática (ícones temáticos do Android 13+): o sistema pinta tudo de uma cor só, então o desenho
 * vai no alfa. Contornos e sombras ficam opacos, cores claras mais leves e a clareira bem suave ao fundo.
 */
function monochrome(front: Raster): Raster {
  const out = createRaster(front.w, front.h);
  const land = new Set(['#b7e08e', '#fff3d1', '#c9a77c'].map((c) => hexToRgba(c).slice(0, 3).join(',')));
  for (let i = 0; i < front.data.length; i += 4) {
    const a = front.data[i + 3];
    if (!a) continue;
    const [r, g, b] = [front.data[i], front.data[i + 1], front.data[i + 2]];
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const alpha = land.has(`${r},${g},${b}`) ? 0.22 : 1 - 0.6 * lum;
    out.data.set([255, 255, 255, Math.round(alpha * a)], i);
  }
  return out;
}

checkLayers();
mkdirSync('assets', { recursive: true });
const png = (name: string, r: Raster, alpha = true) => writeFileSync(join('assets', name), encodePng(r, { alpha }));

// iOS/App Store e fallback: o ícone original inteiro (32 px de arte × 32), sem canal alfa.
png('icon.png', appIcon(1024), false);

// Ícone adaptativo (108 dp = 432 px no xxxhdpi, 4 px/dp), com a arte em escala inteira 7: os 32 px de arte viram
// 224 px (56 dp) no centro, e herói e moeda ficam dentro do círculo seguro de 66 dp de qualquer máscara.
const ADAPTIVE_PX = 432;
const ADAPTIVE_K = 7;
const artPx = ART * ADAPTIVE_K;
const artAt = (ADAPTIVE_PX - artPx) / 2;
// névoa em pixels de arte inteiros cobrindo o quadro todo, recortada no centro
const fogGrid = Math.ceil(ADAPTIVE_PX / ADAPTIVE_K) + 1;
const fogOff = Math.ceil(artAt / ADAPTIVE_K);
const fogBig = scaleRaster(fogLayer(fogGrid, fogOff), ADAPTIVE_K);
const adaptiveBg = crop(fogBig, fogOff * ADAPTIVE_K - artAt, fogOff * ADAPTIVE_K - artAt, ADAPTIVE_PX, ADAPTIVE_PX);
const adaptiveFront = createRaster(ADAPTIVE_PX, ADAPTIVE_PX);
blit(adaptiveFront, scaleRaster(frontLayer(ART + 2, 0), ADAPTIVE_K), artAt, artAt);
png('android-icon-background.png', adaptiveBg);
png('android-icon-foreground.png', adaptiveFront);
png('android-icon-monochrome.png', monochrome(adaptiveFront));

// Splash: clareira com herói e moeda sobre fundo transparente (o splash pinta #1d1730 por trás), 32 px de arte
// × 32 = 1024 (1/2/3x do imageWidth 160 viram blocos inteiros de 5/10/15 px). Sobe 1 px para a roda caber.
png('splash-icon.png', scaleRaster(frontLayer(ART, 0, -1), 32));

// Favicon 48 px: a arte em escala 1 com 8 px de névoa em volta (o export da web gera o .ico de 16/32/48).
const FAV_GRID = 48;
const fav = fogLayer(FAV_GRID, (FAV_GRID - ART) / 2);
blit(fav, frontLayer(FAV_GRID, (FAV_GRID - ART) / 2), 0, 0);
png('favicon.png', fav);

console.log(errors.length ? `${errors.length} erro(s) de arte` : 'sprites ok', '->', previewDir, '+ assets/');
