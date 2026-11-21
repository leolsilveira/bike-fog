import zlib from 'node:zlib';

export interface LngLat {
  lng: number;
  lat: number;
}

export interface TrackPoint {
  lng: number;
  lat: number;
  t: number; // ms epoch
}

export type Modality = 'bike' | 'run';

export type CoinKind = 'bronze' | 'silver' | 'gold' | 'gem';

export interface CoinsByKind {
  bronze: number;
  silver: number;
  gold: number;
  gem: number;
}

export interface CaptureSummary {
  poiId: string;
  name: string;
  category: string;
  rarity: 'comum' | 'incomum' | 'raro' | 'epico' | 'lendario';
  lat: number;
  lng: number;
}

export interface DsbfData {
  keys: Float64Array;
  city: Uint16Array;
  cityIds: string[];
}

export interface TrackVector {
  name: string;
  modality: Modality;
  source: 'live' | 'gpx_import';
  points: TrackPoint[];
  startedAt: number;
  endedAt: number;
  trackBytes: Uint8Array;
  trackGzBytes: Uint8Array;
  distanceM: number;
  movingS: number;
  maxSpeed: number;
  newCells: number;
  coinsByKind: CoinsByKind;
  coinsCount: number;
  coinsValue: number;
  captures: CaptureSummary[];
  cityIds: string[];
  expectedXp: number;
  expectedCoinsEarned: number;
}

export const DEFAULT_CENTER: LngLat = { lng: -46.6559, lat: -23.5614 };
export const T0_MS = 1_700_000_000_000;

const R_EARTH_M = 6_371_008.8;
const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6_378_137;
const RAD = Math.PI / 180;
export const CELL_ZOOM = 21;
export const CELLS_PER_AXIS = 2 ** CELL_ZOOM;
export const REVEAL_RADIUS_M = 38;
export const MAX_SPEED_MPS: Record<Modality, number> = { bike: 16.7, run: 7.0 };
export const XP_RATES = {
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
export const RARITY_XP: Record<CaptureSummary['rarity'], number> = {
  comum: 25,
  incomum: 40,
  raro: 75,
  epico: 150,
  lendario: 300,
};

export const FOG_MAGIC = 0x46425344;
export const FOG_VERSION = 1;
export const FOG_HEADER = 16;

export function haversine(a: LngLat, b: LngLat): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const s =
    sinLat * sinLat +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * sinLng * sinLng;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function offsetPoint(p: LngLat, distM: number, bearingDeg: number): LngLat {
  const dn = distM * Math.cos(bearingDeg * RAD);
  const de = distM * Math.sin(bearingDeg * RAD);
  return {
    lat: p.lat + (dn / R_EARTH_M) / RAD,
    lng: p.lng + (de / (R_EARTH_M * Math.cos(p.lat * RAD))) / RAD,
  };
}

export function lerpLngLat(a: LngLat, b: LngLat, t: number): LngLat {
  return {
    lng: a.lng + (b.lng - a.lng) * t,
    lat: a.lat + (b.lat - a.lat) * t,
  };
}

function toMerc(p: LngLat): { x: number; y: number } {
  const x = (p.lng + 180) / 360;
  const s = Math.sin(p.lat * RAD);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return { x, y };
}

export function cellKey(cx: number, cy: number): number {
  return cx * CELLS_PER_AXIS + cy;
}

export function cellOf(p: LngLat): number {
  const m = toMerc(p);
  return cellKey(
    Math.floor(m.x * CELLS_PER_AXIS),
    Math.floor(m.y * CELLS_PER_AXIS),
  );
}

export function cellsInRadius(p: LngLat, radiusM: number): number[] {
  const m = toMerc(p);
  const size = (EARTH_CIRCUMFERENCE_M * Math.cos(p.lat * RAD)) / CELLS_PER_AXIS;
  const r = Math.ceil(radiusM / size);
  const cx0 = Math.floor(m.x * CELLS_PER_AXIS);
  const cy0 = Math.floor(m.y * CELLS_PER_AXIS);
  const fx = m.x * CELLS_PER_AXIS;
  const fy = m.y * CELLS_PER_AXIS;
  const r2 = (radiusM / size) ** 2;
  const out: number[] = [];
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

export function revealAlongPoints(
  points: LngLat[],
  radiusM = REVEAL_RADIUS_M,
  maxSegmentJumpM = Infinity,
): Set<number> {
  const revealed = new Set<number>();
  if (points.length === 0) return revealed;
  if (points.length === 1) {
    for (const key of cellsInRadius(points[0], radiusM)) {
      revealed.add(key);
    }
    return revealed;
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const d = haversine(a, b);
    if (d > maxSegmentJumpM) continue;
    const steps = Math.max(1, Math.ceil(d / (radiusM * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const pt = lerpLngLat(a, b, s / steps);
      for (const key of cellsInRadius(pt, radiusM)) {
        revealed.add(key);
      }
    }
  }
  return revealed;
}

export function xpToNext(level: number): number {
  const n = level - 1;
  return Math.round((100 + 60 * n + 8 * n * n) / 10) * 10;
}

export function levelFromXp(xp: number): {
  level: number;
  current: number;
  needed: number;
} {
  let level = 1;
  let rest = Math.max(0, Math.floor(xp));
  while (rest >= xpToNext(level)) {
    rest -= xpToNext(level);
    level++;
  }
  return { level, current: rest, needed: xpToNext(level) };
}

export function computeExpectedActivityXp(opts: {
  source: 'live' | 'gpx_import';
  modality: Modality;
  distanceM: number;
  newCells: number;
  coinsByKind: CoinsByKind;
  captures: CaptureSummary[];
}): number {
  if (opts.source === 'gpx_import') return 0;
  const distXp = Math.floor((opts.distanceM / 1000) * XP_RATES.perKm[opts.modality]);
  const cellXp = Math.floor(opts.newCells * XP_RATES.perCell[opts.modality]);
  const coinXp =
    opts.coinsByKind.bronze * Math.max(1, Math.ceil(COIN_VALUE.bronze * XP_RATES.perCoinValue)) +
    opts.coinsByKind.silver * Math.max(1, Math.ceil(COIN_VALUE.silver * XP_RATES.perCoinValue)) +
    opts.coinsByKind.gold * Math.max(1, Math.ceil(COIN_VALUE.gold * XP_RATES.perCoinValue)) +
    opts.coinsByKind.gem * Math.max(1, Math.ceil(COIN_VALUE.gem * XP_RATES.perCoinValue));
  const captureXp = opts.captures.reduce((acc, c) => acc + RARITY_XP[c.rarity], 0);
  return distXp + cellXp + coinXp + captureXp;
}

export function encodeTrack(points: TrackPoint[]): Uint8Array {
  const f64 = new Float64Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    f64[i * 3] = points[i].lng;
    f64[i * 3 + 1] = points[i].lat;
    f64[i * 3 + 2] = points[i].t;
  }
  return new Uint8Array(f64.buffer, f64.byteOffset, f64.byteLength);
}

export function gzipTrack(points: TrackPoint[]): {
  raw: Uint8Array;
  gz: Uint8Array;
} {
  const raw = encodeTrack(points);
  const gz = new Uint8Array(zlib.gzipSync(raw));
  return { raw, gz };
}

export function decodeTrack(bytes: Uint8Array): TrackPoint[] {
  if (bytes.byteLength % 24 !== 0) {
    throw new Error(`Invalid track byteLength ${bytes.byteLength}`);
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const f64 = new Float64Array(copy.buffer);
  const out: TrackPoint[] = [];
  for (let i = 0; i < f64.length; i += 3) {
    out.push({ lng: f64[i], lat: f64[i + 1], t: f64[i + 2] });
  }
  return out;
}

export function encodeDsbf(data: DsbfData): Uint8Array {
  const n = data.keys.length;
  const json = Buffer.from(JSON.stringify(data.cityIds), 'utf8');
  const out = new Uint8Array(FOG_HEADER + n * 10 + json.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, FOG_MAGIC, true);
  dv.setUint32(4, FOG_VERSION, true);
  dv.setUint32(8, n, true);
  dv.setUint32(12, json.length, true);
  out.set(new Uint8Array(data.keys.buffer, data.keys.byteOffset, n * 8), FOG_HEADER);
  out.set(new Uint8Array(data.city.buffer, data.city.byteOffset, n * 2), FOG_HEADER + n * 8);
  out.set(json, FOG_HEADER + n * 10);
  return out;
}

export function decodeDsbf(bytes: Uint8Array): DsbfData | undefined {
  if (bytes.byteLength < FOG_HEADER) return undefined;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== FOG_MAGIC || dv.getUint32(4, true) !== FOG_VERSION) {
    return undefined;
  }
  const n = dv.getUint32(8, true);
  const jsonLen = dv.getUint32(12, true);
  if (bytes.byteLength !== FOG_HEADER + n * 10 + jsonLen) return undefined;
  try {
    const keyCopy = new Uint8Array(n * 8);
    keyCopy.set(bytes.subarray(FOG_HEADER, FOG_HEADER + n * 8));
    const keys = new Float64Array(keyCopy.buffer);

    const cityCopy = new Uint8Array(n * 2);
    cityCopy.set(bytes.subarray(FOG_HEADER + n * 8, FOG_HEADER + n * 10));
    const city = new Uint16Array(cityCopy.buffer);

    const jsonText = Buffer.from(bytes.subarray(FOG_HEADER + n * 10)).toString('utf8');
    const parsed = JSON.parse(jsonText) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      return undefined;
    }
    return { keys, city, cityIds: parsed as string[] };
  } catch {
    return undefined;
  }
}

export function mergeDsbf(a: DsbfData, b: DsbfData): DsbfData {
  const cityIds: string[] = [''];
  const cityIndex = new Map<string, number>([['', 0]]);
  const ensureCityIdx = (id: string): number => {
    const existing = cityIndex.get(id);
    if (existing !== undefined) return existing;
    const idx = cityIds.length;
    cityIds.push(id);
    cityIndex.set(id, idx);
    return idx;
  };

  const merged = new Map<number, number>();
  const ingest = (src: DsbfData): void => {
    for (let i = 0; i < src.keys.length; i++) {
      const k = src.keys[i];
      const rawCityIdx = src.city[i] ?? 0;
      const cityId = src.cityIds[rawCityIdx] ?? '';
      const mappedIdx = ensureCityIdx(cityId);
      const prev = merged.get(k);
      if (prev === undefined || (prev === 0 && mappedIdx !== 0)) {
        merged.set(k, mappedIdx);
      }
    }
  };

  ingest(a);
  ingest(b);

  const keys = new Float64Array(merged.size);
  const city = new Uint16Array(merged.size);
  let i = 0;
  for (const [k, c] of merged) {
    keys[i] = k;
    city[i] = c;
    i++;
  }
  return { keys, city, cityIds };
}

function summarizeTrack(opts: {
  name: string;
  modality: Modality;
  source: 'live' | 'gpx_import';
  points: TrackPoint[];
  coinsByKind?: CoinsByKind;
  captures?: CaptureSummary[];
  cityIds?: string[];
}): TrackVector {
  const maxJump = opts.source === 'gpx_import' ? 500 : Infinity;
  let distanceM = 0;
  let movingS = 0;
  let maxSpeed = 0;

  for (let i = 1; i < opts.points.length; i++) {
    const prev = opts.points[i - 1];
    const curr = opts.points[i];
    const d = haversine(prev, curr);
    const dt = (curr.t - prev.t) / 1000;
    if (d > maxJump) continue;
    distanceM += d;
    if (dt > 0 && dt <= 30) {
      const speed = d / dt;
      if (speed > 0.6 && speed < 35) {
        movingS += dt;
        if (opts.source === 'gpx_import' && speed > maxSpeed) {
          maxSpeed = speed;
        }
      }
      if (opts.source === 'live' && speed > maxSpeed) {
        maxSpeed = speed;
      }
    }
  }

  const cells = revealAlongPoints(opts.points, REVEAL_RADIUS_M, maxJump);
  const coinsByKind: CoinsByKind = opts.coinsByKind ?? {
    bronze: 0,
    silver: 0,
    gold: 0,
    gem: 0,
  };
  const captures = opts.source === 'gpx_import' ? [] : (opts.captures ?? []);
  const coinsCount =
    coinsByKind.bronze + coinsByKind.silver + coinsByKind.gold + coinsByKind.gem;
  const coinsValue =
    coinsByKind.bronze * COIN_VALUE.bronze +
    coinsByKind.silver * COIN_VALUE.silver +
    coinsByKind.gold * COIN_VALUE.gold +
    coinsByKind.gem * COIN_VALUE.gem;

  const expectedXp = computeExpectedActivityXp({
    source: opts.source,
    modality: opts.modality,
    distanceM,
    newCells: cells.size,
    coinsByKind,
    captures,
  });

  const { raw, gz } = gzipTrack(opts.points);

  return {
    name: opts.name,
    modality: opts.modality,
    source: opts.source,
    points: opts.points,
    startedAt: opts.points[0].t,
    endedAt: opts.points[opts.points.length - 1].t,
    trackBytes: raw,
    trackGzBytes: gz,
    distanceM,
    movingS,
    maxSpeed,
    newCells: cells.size,
    coinsByKind,
    coinsCount,
    coinsValue,
    captures,
    cityIds: opts.cityIds ?? [],
    expectedXp,
    expectedCoinsEarned: opts.source === 'gpx_import' ? 0 : coinsValue,
  };
}

export function buildLinearPoints(opts: {
  start?: LngLat;
  steps: number;
  stepM: number;
  bearingDeg: number;
  startedAt?: number;
  stepMs?: number;
}): TrackPoint[] {
  const pts: TrackPoint[] = [];
  let cur: LngLat = opts.start ?? DEFAULT_CENTER;
  const t0 = opts.startedAt ?? T0_MS;
  const dt = opts.stepMs ?? 10_000;
  pts.push({ lng: cur.lng, lat: cur.lat, t: t0 });
  for (let i = 1; i <= opts.steps; i++) {
    cur = offsetPoint(cur, opts.stepM, opts.bearingDeg);
    pts.push({ lng: cur.lng, lat: cur.lat, t: t0 + i * dt });
  }
  return pts;
}

export function buildVectorV1(startedAt = T0_MS, poiId = 'poi_v1_parque'): TrackVector {
  const points = buildLinearPoints({
    steps: 20,
    stepM: 105,
    bearingDeg: 90,
    startedAt,
    stepMs: 10_000,
  });
  const mid = points[10];
  return summarizeTrack({
    name: 'V1 Bike + Coins + Capture',
    modality: 'bike',
    source: 'live',
    points,
    coinsByKind: { bronze: 2, silver: 1, gold: 1, gem: 0 },
    captures: [
      {
        poiId,
        name: 'Parque Paulista',
        category: 'parque',
        rarity: 'comum',
        lat: mid.lat,
        lng: mid.lng,
      },
    ],
    cityIds: ['r/sao-paulo'],
  });
}

export function buildVectorV2(
  startedAt = T0_MS + 3_600_000,
  poiId = 'poi_v2_trianon',
): TrackVector {
  const points = buildLinearPoints({
    steps: 30,
    stepM: 36,
    bearingDeg: 0,
    startedAt,
    stepMs: 10_000,
  });
  const mid = points[15];
  return summarizeTrack({
    name: 'V2 Run + Coins + Capture',
    modality: 'run',
    source: 'live',
    points,
    coinsByKind: { bronze: 0, silver: 1, gold: 0, gem: 1 },
    captures: [
      {
        poiId,
        name: 'Monumento Trianon',
        category: 'monumento',
        rarity: 'raro',
        lat: mid.lat,
        lng: mid.lng,
      },
    ],
    cityIds: ['r/sao-paulo'],
  });
}

export function buildVectorV3(startedAt = T0_MS + 7_200_000): TrackVector {
  const points = buildLinearPoints({
    steps: 100,
    stepM: 100,
    bearingDeg: 90,
    startedAt,
    stepMs: 10_000,
  });
  return summarizeTrack({
    name: 'V3 Long Bike Multi-Level',
    modality: 'bike',
    source: 'live',
    points,
    cityIds: ['r/sao-paulo'],
  });
}

export function buildVectorG1(startedAt = T0_MS + 10_800_000): TrackVector {
  const pts: TrackPoint[] = [];
  let cur: LngLat = DEFAULT_CENTER;
  pts.push({ lng: cur.lng, lat: cur.lat, t: startedAt });
  for (let i = 1; i <= 4; i++) {
    cur = offsetPoint(cur, 100, 90);
    pts.push({ lng: cur.lng, lat: cur.lat, t: startedAt + i * 10_000 });
  }
  // 800m jump (> MAX_SEGMENT_JUMP_M = 500)
  cur = offsetPoint(cur, 800, 90);
  pts.push({ lng: cur.lng, lat: cur.lat, t: startedAt + 50_000 });
  for (let i = 6; i <= 9; i++) {
    cur = offsetPoint(cur, 100, 90);
    pts.push({ lng: cur.lng, lat: cur.lat, t: startedAt + i * 10_000 });
  }
  return summarizeTrack({
    name: 'G1 GPX Import with 800m Jump',
    modality: 'bike',
    source: 'gpx_import',
    points: pts,
    cityIds: ['r/sao-paulo'],
  });
}

export function buildVectorF1(startedAt = T0_MS): TrackVector {
  // 300m / 10s = 30 m/s (> 16.7 bike limit)
  const points = buildLinearPoints({
    steps: 10,
    stepM: 300,
    bearingDeg: 90,
    startedAt,
    stepMs: 10_000,
  });
  return summarizeTrack({ name: 'F1 Excessive Bike Speed', modality: 'bike', source: 'live', points });
}

export function buildVectorF2(startedAt = T0_MS): TrackVector {
  // 120m / 10s = 12 m/s (> 7.0 run limit)
  const points = buildLinearPoints({
    steps: 10,
    stepM: 120,
    bearingDeg: 0,
    startedAt,
    stepMs: 10_000,
  });
  return summarizeTrack({ name: 'F2 Excessive Run Speed', modality: 'run', source: 'live', points });
}

export function buildVectorF3(startedAt = T0_MS): TrackVector {
  // 5 normal steps, 2000m teleport in 1s, 5 normal steps
  const pts: TrackPoint[] = [];
  let cur: LngLat = DEFAULT_CENTER;
  let t = startedAt;
  pts.push({ lng: cur.lng, lat: cur.lat, t });
  for (let i = 0; i < 5; i++) {
    cur = offsetPoint(cur, 100, 90);
    t += 10_000;
    pts.push({ lng: cur.lng, lat: cur.lat, t });
  }
  cur = offsetPoint(cur, 2000, 90);
  t += 1_000;
  pts.push({ lng: cur.lng, lat: cur.lat, t });
  for (let i = 0; i < 5; i++) {
    cur = offsetPoint(cur, 100, 90);
    t += 10_000;
    pts.push({ lng: cur.lng, lat: cur.lat, t });
  }
  return summarizeTrack({ name: 'F3 Live Teleport Jump', modality: 'bike', source: 'live', points: pts });
}

export function buildGpxXml(points: TrackPoint[], name = 'Desbrava E2E GPX'): string {
  const trkpts = points
    .map(
      (p) =>
        `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}"><time>${new Date(p.t).toISOString()}</time></trkpt>`,
    )
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Desbrava E2E">',
    `  <trk><name>${name}</name><trkseg>`,
    trkpts,
    '  </trkseg></trk>',
    '</gpx>',
  ].join('\n');
}

export const FOG_A_HEX =
  '4453424601000000030000000900000000f07e22a3b4774200f07e22a9b4774200f07e22afb477420000010001005b22222c227370225d';
export const FOG_B_HEX =
  '4453424601000000030000000900000000f07e22a3b4774200f07e22afb4774200f07e22b5b477420100000001005b22222c22726a225d';

export function buildFogFixtures(): {
  fogA: DsbfData;
  fogB: DsbfData;
  fogABytes: Uint8Array;
  fogBBytes: Uint8Array;
  c1: number;
  c2: number;
  c3: number;
  c4: number;
  corrupt: {
    truncatedHeader: Uint8Array;
    wrongMagic: Uint8Array;
    unsupportedVersion: Uint8Array;
    lengthMismatch: Uint8Array;
    nonStringCityIds: Uint8Array;
    unalignedView: Uint8Array;
  };
} {
  const c1 = cellOf(DEFAULT_CENTER);
  const c2 = cellOf(offsetPoint(DEFAULT_CENTER, 50, 90));
  const c3 = cellOf(offsetPoint(DEFAULT_CENTER, 100, 90));
  const c4 = cellOf(offsetPoint(DEFAULT_CENTER, 150, 90));

  const fogA: DsbfData = {
    keys: new Float64Array([c1, c2, c3]),
    city: new Uint16Array([0, 1, 1]),
    cityIds: ['', 'sp'],
  };
  const fogB: DsbfData = {
    keys: new Float64Array([c1, c3, c4]),
    city: new Uint16Array([1, 0, 1]),
    cityIds: ['', 'rj'],
  };

  const fogABytes = encodeDsbf(fogA);
  const fogBBytes = encodeDsbf(fogB);

  const wrongMagic = new Uint8Array(fogABytes);
  wrongMagic[0] = 0x58; // 'XSBF'

  const unsupportedVersion = new Uint8Array(fogABytes);
  new DataView(unsupportedVersion.buffer).setUint32(4, 2, true);

  const nonStringCityIds = new Uint8Array(FOG_HEADER + 5);
  const ndv = new DataView(nonStringCityIds.buffer);
  ndv.setUint32(0, FOG_MAGIC, true);
  ndv.setUint32(4, FOG_VERSION, true);
  ndv.setUint32(8, 0, true);
  ndv.setUint32(12, 5, true);
  nonStringCityIds.set(Buffer.from('[123]', 'utf8'), FOG_HEADER);

  const unalignedBacking = new Uint8Array(fogABytes.length + 7);
  unalignedBacking.set(fogABytes, 3);
  const unalignedView = unalignedBacking.subarray(3, 3 + fogABytes.length);

  return {
    fogA,
    fogB,
    fogABytes,
    fogBBytes,
    c1,
    c2,
    c3,
    c4,
    corrupt: {
      truncatedHeader: fogABytes.subarray(0, 8),
      wrongMagic,
      unsupportedVersion,
      lengthMismatch: fogABytes.subarray(0, fogABytes.length - 1),
      nonStringCityIds,
      unalignedView,
    },
  };
}

export function currentSaoPauloMonthBounds(nowMs = Date.now()): {
  yearMonth: string;
  startIso: string;
  endIso: string;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(nowMs));
  const year = Number(parts.find((p) => p.type === 'year')?.value ?? '2026');
  const month = Number(parts.find((p) => p.type === 'month')?.value ?? '1');
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  // America/Sao_Paulo is UTC-3 (no DST since 2019)
  const startUtc = new Date(Date.UTC(year, month - 1, 1, 3, 0, 0, 0));
  const endUtc = new Date(Date.UTC(year, month, 1, 3, 0, 0, 0));
  return {
    yearMonth: ym,
    startIso: startUtc.toISOString(),
    endIso: endUtc.toISOString(),
  };
}
