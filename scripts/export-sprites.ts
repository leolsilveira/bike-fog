// Valida as artes e exporta PNGs: folha de preview e ícones do PWA.
// Uso: node scripts/export-sprites.ts [pasta-de-preview]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodePng } from './png.ts';
import { checkArt, createRaster, blit, scaleRaster, hexToRgba, type Raster } from '../src/sprites/pixel.ts';
import {
  ALL_CHARACTER_ART, CHARACTERS, characterFrame, frameCount, type Facing, type Modality,
} from '../src/sprites/characters.ts';
import { ALL_ITEM_ART, coinFrames, poiBadge, POI_CATEGORIES, COIN_KINDS } from '../src/sprites/items.ts';
import { ALL_ICON_ART, ICON_NAMES, iconRaster } from '../src/sprites/icons.ts';
import { ALL_TILE_ART, TILE_NAMES, tileRaster } from '../src/sprites/tiles.ts';
import { appIcon } from '../src/sprites/appIcon.ts';

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

// Ícones do app (PWA / favicon) vão para public/.
mkdirSync('public/icons', { recursive: true });
for (const size of [32, 180, 192, 512]) {
  writeFileSync(join('public/icons', `icon-${size}.png`), encodePng(appIcon(size)));
}
console.log(errors.length ? `${errors.length} erro(s) de arte` : 'sprites ok', '->', previewDir);
