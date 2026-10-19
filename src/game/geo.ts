// Geometria: distâncias, Web Mercator, células da névoa, ponto-em-polígono e áreas.
import { CELL_ZOOM } from './config.ts';

export interface LngLat {
  lng: number;
  lat: number;
}

const R = 6371008.8;
const RAD = Math.PI / 180;
export const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;

export function haversine(a: LngLat, b: LngLat): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Rumo de a para b em graus (0 = norte, horário). */
export function bearing(a: LngLat, b: LngLat): number {
  const y = Math.sin((b.lng - a.lng) * RAD) * Math.cos(b.lat * RAD);
  const x =
    Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) -
    Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lng - a.lng) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Desloca um ponto `dist` metros no rumo `brg` (aproximação local, boa para < 50 km). */
export function offset(p: LngLat, dist: number, brg: number): LngLat {
  const dn = dist * Math.cos(brg * RAD);
  const de = dist * Math.sin(brg * RAD);
  return {
    lat: p.lat + (dn / R) / RAD,
    lng: p.lng + (de / (R * Math.cos(p.lat * RAD))) / RAD,
  };
}

export function lerpLngLat(a: LngLat, b: LngLat, t: number): LngLat {
  return { lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t };
}

/** Diferença angular com sinal no intervalo (-180, 180]. */
export function angleDiff(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

// --- Web Mercator ([0,1] x [0,1], origem no canto superior esquerdo) -------------

export function toMerc(p: LngLat): { x: number; y: number } {
  const x = (p.lng + 180) / 360;
  const s = Math.sin(p.lat * RAD);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return { x, y };
}

export function fromMerc(x: number, y: number): LngLat {
  const lng = x * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y;
  const lat = Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) / RAD;
  return { lng, lat };
}

/** Metros por unidade mercator na latitude dada. */
export function metersPerMercUnit(lat: number): number {
  return EARTH_CIRCUMFERENCE * Math.cos(lat * RAD);
}

// --- Células da névoa ---------------------------------------------------------------

export const CELLS_PER_AXIS = 2 ** CELL_ZOOM;

/** Chave numérica única da célula (cabe com folga num double). */
export function cellKey(cx: number, cy: number): number {
  return cx * CELLS_PER_AXIS + cy;
}

export function cellXY(key: number): [number, number] {
  const cx = Math.floor(key / CELLS_PER_AXIS);
  return [cx, key - cx * CELLS_PER_AXIS];
}

export function cellOf(p: LngLat): number {
  const m = toMerc(p);
  return cellKey(Math.floor(m.x * CELLS_PER_AXIS), Math.floor(m.y * CELLS_PER_AXIS));
}

/** Centro da célula em mercator. */
export function cellCenterMerc(key: number): { x: number; y: number } {
  const [cx, cy] = cellXY(key);
  return { x: (cx + 0.5) / CELLS_PER_AXIS, y: (cy + 0.5) / CELLS_PER_AXIS };
}

export function cellCenter(key: number): LngLat {
  const m = cellCenterMerc(key);
  return fromMerc(m.x, m.y);
}

/** Lado da célula em metros na latitude dada. */
export function cellSizeM(lat: number): number {
  return metersPerMercUnit(lat) / CELLS_PER_AXIS;
}

/** Todas as células cujo centro está a até `radius` metros de `p`. */
export function cellsInRadius(p: LngLat, radius: number): number[] {
  const m = toMerc(p);
  const size = cellSizeM(p.lat);
  const r = Math.ceil(radius / size);
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

// --- Polígonos (GeoJSON) ------------------------------------------------------------

export type Ring = number[][];
export type PolygonCoords = Ring[];
export interface AreaGeometry {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: PolygonCoords | PolygonCoords[];
}

function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygonCoords(x: number, y: number, poly: PolygonCoords): boolean {
  if (!poly.length || !pointInRing(x, y, poly[0])) return false;
  for (let i = 1; i < poly.length; i++) if (pointInRing(x, y, poly[i])) return false;
  return true;
}

export function pointInArea(p: LngLat, geom: AreaGeometry): boolean {
  if (geom.type === 'Polygon') return pointInPolygonCoords(p.lng, p.lat, geom.coordinates as PolygonCoords);
  return (geom.coordinates as PolygonCoords[]).some((poly) => pointInPolygonCoords(p.lng, p.lat, poly));
}

export type BBox = [number, number, number, number];

export function areaBBox(geom: AreaGeometry): BBox {
  const polys = geom.type === 'Polygon' ? [geom.coordinates as PolygonCoords] : (geom.coordinates as PolygonCoords[]);
  const b: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of polys) {
    for (const [x, y] of poly[0] ?? []) {
      b[0] = Math.min(b[0], x);
      b[1] = Math.min(b[1], y);
      b[2] = Math.max(b[2], x);
      b[3] = Math.max(b[3], y);
    }
  }
  return b;
}

export function inBBox(p: LngLat, b: BBox): boolean {
  return p.lng >= b[0] && p.lng <= b[2] && p.lat >= b[1] && p.lat <= b[3];
}

/** Área esférica de um anel (mesma fórmula do turf/area). */
function ringArea(ring: Ring): number {
  let total = 0;
  const n = ring.length;
  if (n < 3) return 0;
  for (let i = 0; i < n; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % n];
    const p3 = ring[(i + 2) % n];
    total += (p3[0] * RAD - p1[0] * RAD) * Math.sin(p2[1] * RAD);
  }
  return Math.abs((total * 6378137 * 6378137) / 2);
}

export function areaM2(geom: AreaGeometry): number {
  const polys = geom.type === 'Polygon' ? [geom.coordinates as PolygonCoords] : (geom.coordinates as PolygonCoords[]);
  let a = 0;
  for (const poly of polys) {
    poly.forEach((ring, i) => (a += i === 0 ? ringArea(ring) : -ringArea(ring)));
  }
  return Math.max(0, a);
}

export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',')} km`;
}

export function formatDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Pace em min/km (corrida). */
export function formatPace(mps: number): string {
  if (mps < 0.3) return "--'--\"";
  const secPerKm = 1000 / mps;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}'${String(s).padStart(2, '0')}"`;
}

export function formatSpeed(mps: number): string {
  return `${(mps * 3.6).toFixed(1).replace('.', ',')}`;
}

export function formatArea(m2: number): string {
  if (m2 < 100000) return `${Math.round(m2).toLocaleString('pt-BR')} m²`;
  return `${(m2 / 1e6).toFixed(2).replace('.', ',')} km²`;
}
