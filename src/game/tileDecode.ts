// Decodificação dos vector tiles (schema OpenMapTiles) para o que o jogo usa: POIs capturáveis e ruas.
// Puro (sem React Native), para rodar também no Node nos testes.
import { PbfReader } from 'pbf';
import { VectorTile, type VectorTileLayer } from '@mapbox/vector-tile';
import { CAPTURABLE_CLASSES, type RawPoiFeature } from './pois.ts';
import { offset, type LngLat } from './geo.ts';

/** Zoom dos tiles lidos pelo jogo (o máximo do OpenFreeMap). */
export const TILE_ZOOM = 14;

export const ROAD_CLASSES = ['minor', 'service', 'tertiary', 'secondary', 'primary', 'path', 'track'];

const POI_SET = new Set(CAPTURABLE_CLASSES);
const ROAD_SET = new Set(ROAD_CLASSES);

export interface TileCoord {
  x: number;
  y: number;
  z: number;
}

export interface DecodedTile {
  pois: RawPoiFeature[];
  /** Ruas como polilinhas achatadas [lng, lat, lng, lat, ...] (bem mais leve que objetos). */
  roads: Float64Array[];
}

export const tileKey = (t: TileCoord): string => `${t.z}/${t.x}/${t.y}`;

export function lngLatToTile(p: LngLat, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const lat = Math.max(-85.0511, Math.min(85.0511, p.lat));
  const x = ((p.lng + 180) / 360) * n;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return { x: Math.min(n - 1, Math.max(0, Math.floor(x))), y: Math.min(n - 1, Math.max(0, Math.floor(y))) };
}

/** Tiles que cobrem um quadrado de lado 2·radius centrado em p, do centro para fora. */
export function tilesAround(p: LngLat, radius: number, z = TILE_ZOOM): TileCoord[] {
  const nw = lngLatToTile(offset(offset(p, radius, 0), radius, 270), z);
  const se = lngLatToTile(offset(offset(p, radius, 180), radius, 90), z);
  const c = lngLatToTile(p, z);
  const out: TileCoord[] = [];
  for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) out.push({ x, y, z });
  return out.sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y));
}

function poisOf(layer: VectorTileLayer, t: TileCoord): RawPoiFeature[] {
  const out: RawPoiFeature[] = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 1 || !POI_SET.has(String(f.properties.class ?? ''))) continue;
    const g = f.toGeoJSON(t.x, t.y, t.z).geometry;
    if (g.type !== 'Point') continue;
    const [lng, lat] = g.coordinates;
    out.push({ id: f.id, lng, lat, z: t.z, props: f.properties });
  }
  return out;
}

function roadsOf(layer: VectorTileLayer, t: TileCoord): Float64Array[] {
  const out: Float64Array[] = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 2) continue;
    const props = f.properties;
    if (!ROAD_SET.has(String(props.class ?? '')) || props.brunnel === 'tunnel') continue;
    const g = f.toGeoJSON(t.x, t.y, t.z).geometry;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of lines) {
      if (line.length < 2) continue;
      const flat = new Float64Array(line.length * 2);
      line.forEach(([lng, lat], j) => {
        flat[j * 2] = lng;
        flat[j * 2 + 1] = lat;
      });
      out.push(flat);
    }
  }
  return out;
}

export function decodeTile(bytes: Uint8Array, t: TileCoord): DecodedTile {
  if (!bytes.byteLength) return { pois: [], roads: [] };
  const vt = new VectorTile(new PbfReader(bytes));
  return {
    pois: vt.layers.poi ? poisOf(vt.layers.poi, t) : [],
    roads: vt.layers.transportation ? roadsOf(vt.layers.transportation, t) : [],
  };
}

/** Polilinha achatada -> pontos. */
export function unflatten(flat: Float64Array): LngLat[] {
  const out: LngLat[] = new Array(flat.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = { lng: flat[i * 2], lat: flat[i * 2 + 1] };
  return out;
}
