// Matemática pura do jogo espelhada de src/game/{config,geo,progression,fog}.ts,
// src/game/pois.ts e src/sprites/items.ts para paridade 1:1 no servidor.

export type Modality = 'bike' | 'run';
export type CoinKind = 'bronze' | 'silver' | 'gold' | 'gem';
export type Rarity = 'comum' | 'incomum' | 'raro' | 'epico' | 'lendario';
export type PoiCategory =
  | 'parque'
  | 'arte'
  | 'templo'
  | 'cultura'
  | 'biblioteca'
  | 'museu'
  | 'monumento'
  | 'mirante'
  | 'estadio'
  | 'atracao';

export interface LngLat {
  lng: number;
  lat: number;
}

export const CELL_ZOOM = 21;
export const CELLS_PER_AXIS = 2 ** CELL_ZOOM;
export const REVEAL_RADIUS_M = 38;
export const COIN_PICKUP_M = 24;

export const COINS_PER_SPAWN = 26;
export const RESPAWN_DISTANCE_M = 1200;
export const MAX_SPAWNS_PER_ACTIVITY = 6;

export const MAX_SPEED: Record<Modality, number> = { bike: 16.7, run: 7 };
export const MAX_SEGMENT_JUMP_M = 500;

export const XP = {
  perKm: { bike: 8, run: 20 } as Record<Modality, number>,
  perCell: { bike: 0.1, run: 0.2 } as Record<Modality, number>,
  perCoinValue: 0.5,
};

export const COIN_VALUE: Record<CoinKind, number> = {
  bronze: 1,
  silver: 5,
  gold: 20,
  gem: 100,
};

export const RARITY_XP: Record<Rarity, number> = {
  comum: 25,
  incomum: 40,
  raro: 75,
  epico: 150,
  lendario: 300,
};

export const POI_INFO: Record<PoiCategory, { rarity: Rarity; radius: number }> = {
  parque: { rarity: 'comum', radius: 70 },
  arte: { rarity: 'comum', radius: 35 },
  templo: { rarity: 'incomum', radius: 50 },
  cultura: { rarity: 'incomum', radius: 50 },
  biblioteca: { rarity: 'incomum', radius: 50 },
  museu: { rarity: 'raro', radius: 70 },
  monumento: { rarity: 'raro', radius: 45 },
  mirante: { rarity: 'raro', radius: 50 },
  estadio: { rarity: 'epico', radius: 120 },
  atracao: { rarity: 'epico', radius: 60 },
};

export const POI_CATEGORIES = Object.keys(POI_INFO) as PoiCategory[];
export const RARITIES: Rarity[] = ['comum', 'incomum', 'raro', 'epico', 'lendario'];

export function isValidPoiRarity(category: PoiCategory, rarity: Rarity): boolean {
  if (POI_INFO[category].rarity === rarity) return true;
  // Castelos (monumento) e zoológicos/aquários/parques temáticos (atracao) podem ser lendários (src/game/pois.ts)
  if (rarity === 'lendario' && (category === 'monumento' || category === 'atracao')) return true;
  return false;
}

const R = 6371008.8;
const RAD = Math.PI / 180;
export const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;

export function haversine(a: LngLat, b: LngLat): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function lerpLngLat(a: LngLat, b: LngLat, t: number): LngLat {
  return { lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t };
}

export function toMerc(p: LngLat): { x: number; y: number } {
  const x = (p.lng + 180) / 360;
  const s = Math.max(-0.99999999, Math.min(0.99999999, Math.sin(p.lat * RAD)));
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return { x, y };
}

export function metersPerMercUnit(lat: number): number {
  return EARTH_CIRCUMFERENCE * Math.cos(lat * RAD);
}

export function cellSizeM(lat: number): number {
  return metersPerMercUnit(lat) / CELLS_PER_AXIS;
}

export function cellKey(cx: number, cy: number): number {
  return cx * CELLS_PER_AXIS + cy;
}

export function cellsInRadius(p: LngLat, radius: number): number[] {
  const size = cellSizeM(p.lat);
  if (
    Math.abs(p.lat) > 85.05112878 ||
    !(size >= 0.01) ||
    !Number.isFinite(size) ||
    !(radius >= 0) ||
    !Number.isFinite(radius)
  ) {
    return [];
  }
  const m = toMerc(p);
  const r = Math.min(1024, Math.ceil(radius / size));
  const cx0 = Math.floor(m.x * CELLS_PER_AXIS);
  const cy0 = Math.floor(m.y * CELLS_PER_AXIS);
  const fx = m.x * CELLS_PER_AXIS;
  const fy = m.y * CELLS_PER_AXIS;
  const out: number[] = [];
  const r2 = (radius / size) ** 2;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const cx = cx0 + dx;
      const cy = cy0 + dy;
      const ddx = cx + 0.5 - fx;
      const ddy = cy + 0.5 - fy;
      if (ddx * ddx + ddy * ddy <= r2) out.push(cellKey(cx, cy));
    }
  }
  return out;
}

export function revealSegmentCells(
  a: LngLat,
  b: LngLat,
  radius: number,
  outSet: Set<number>,
): void {
  const dist = haversine(a, b);
  const steps = Math.max(1, Math.ceil(dist / (radius * 0.5)));
  for (let i = 0; i <= steps; i++) {
    const p = lerpLngLat(a, b, i / steps);
    for (const key of cellsInRadius(p, radius)) {
      outSet.add(key);
    }
  }
}

export function pointToSegmentDistanceM(p: LngLat, a: LngLat, b: LngLat): number {
  const k = metersPerMercUnit(p.lat);
  const P = toMerc(p);
  const A = toMerc(a);
  const B = toMerc(b);
  const abx = B.x - A.x;
  const aby = B.y - A.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 ? Math.max(0, Math.min(1, ((P.x - A.x) * abx + (P.y - A.y) * aby) / len2)) : 0;
  const dx = A.x + abx * t - P.x;
  const dy = A.y + aby * t - P.y;
  return Math.sqrt(dx * dx + dy * dy) * k;
}

export function xpToNext(level: number): number {
  const n = level - 1;
  return Math.round((100 + 60 * n + 8 * n * n) / 10) * 10;
}

export function levelFromXp(xp: number): number {
  let level = 1;
  let rest = Math.max(0, Math.floor(xp));
  while (rest >= xpToNext(level)) {
    rest -= xpToNext(level);
    level++;
  }
  return level;
}
