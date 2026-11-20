// Cidades: descobre o município onde o jogador está (Nominatim/OSM), guarda o polígono
// e calcula o percentual explorado = área das células visitadas / área do município.
import { areaBBox, areaM2, cellSizeM, inBBox, pointInArea, type AreaGeometry, type LngLat } from './geo.ts';
import { fog } from './fog.ts';
import { checkAndGrantAchievements } from './achievements.ts';
import { useGame } from './store.ts';
import { getKv, setKv } from './persist.ts';
import { fetchWithTimeout } from './net.ts';
import type { City } from './types.ts';

const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const polys = new Map<string, AreaGeometry>();
let inflight: Promise<string | null> | null = null;
let lastQuery: { p: LngLat; t: number } | null = null;

const polyKey = (id: string) => `city-poly:${id}`;

export async function loadCityPolygons(): Promise<void> {
  const cities = Object.keys(useGame.getState().cities);
  await Promise.all(
    cities.map(async (id) => {
      const g = await getKv<AreaGeometry>(polyKey(id));
      if (g) polys.set(id, g);
    }),
  );
  if (fog.assignPending(cityAtSync) > 0) recountCities();
}

/** Cidade (já conhecida) que contém o ponto. */
export function cityAtSync(p: LngLat): string | null {
  const cities = useGame.getState().cities;
  for (const [id, geom] of polys) {
    const c = cities[id];
    if (c && !inBBox(p, c.bbox)) continue;
    if (pointInArea(p, geom)) return id;
  }
  return null;
}

/** Recalcula as contagens de células por cidade a partir do registro da névoa. */
export function recountCities(): void {
  const counts = fog.countByCity();
  const cities = { ...useGame.getState().cities };
  let changed = false;
  for (const id of Object.keys(cities)) {
    const n = counts[id] ?? 0;
    if (cities[id].cells !== n) {
      cities[id] = { ...cities[id], cells: n };
      changed = true;
    }
  }
  if (changed) useGame.setState({ cities });
}

export function cityPercent(c: City): number {
  if (!c.areaM2) return 0;
  return Math.min(100, ((c.cells * c.cellAreaM2) / c.areaM2) * 100);
}

/** Soma células novas na contagem da cidade (rápido, sem recontar tudo). */
export function bumpCityCells(cityId: string, n: number): void {
  const cities = useGame.getState().cities;
  const c = cities[cityId];
  if (!c || n <= 0) return;
  useGame.setState({ cities: { ...cities, [cityId]: { ...c, cells: c.cells + n } } });
}

interface NominatimResult {
  osm_type?: string;
  osm_id?: number;
  name?: string;
  addresstype?: string;
  address?: Record<string, string>;
  geojson?: { type: string; coordinates: unknown };
  error?: string;
}

/**
 * Garante que conhecemos a cidade do ponto. Consulta a rede no máximo a cada 20 s
 * (política de uso do Nominatim) e só se o ponto não estiver numa cidade conhecida.
 */
export async function ensureCityAt(p: LngLat): Promise<string | null> {
  const known = cityAtSync(p);
  if (known) return known;
  if (inflight) return inflight;
  const now = Date.now();
  // no máximo 1 consulta a cada 20 s, mesmo se o jogador "pular" longe (teleporte do simulador)
  if (lastQuery && now - lastQuery.t < 20000) return null;
  lastQuery = { p, t: now };
  inflight = (async () => {
    try {
      const url = `${NOMINATIM}?format=jsonv2&lat=${p.lat.toFixed(5)}&lon=${p.lng.toFixed(5)}` +
        `&zoom=10&polygon_geojson=1&polygon_threshold=0.0005&accept-language=pt-BR`;
      const res = await fetchWithTimeout(url, 20000, { Accept: 'application/json' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as NominatimResult;
      if (data.error || !data.geojson || !data.osm_id) return null;
      if (data.geojson.type !== 'Polygon' && data.geojson.type !== 'MultiPolygon') return null;
      const geom = data.geojson as AreaGeometry;
      const id = `${data.osm_type ?? 'r'}/${data.osm_id}`;
      const a = data.address ?? {};
      const name = a.city ?? a.town ?? a.municipality ?? a.village ?? data.name ?? 'Cidade desconhecida';
      polys.set(id, geom);
      await setKv(polyKey(id), geom);
      const isNew = !useGame.getState().cities[id];
      const city: City = {
        id,
        name,
        state: a.state,
        country: a.country,
        areaM2: areaM2(geom),
        bbox: areaBBox(geom),
        cells: 0,
        cellAreaM2: cellSizeM(p.lat) ** 2,
        discoveredAt: Date.now(),
      };
      useGame.setState({ cities: { ...useGame.getState().cities, [id]: { ...city, ...useGame.getState().cities[id] } } });
      fog.assignPending(cityAtSync);
      recountCities();
      if (isNew) useGame.getState().toast(`Nova cidade descoberta: ${name}!`, 'city');
      checkAndGrantAchievements();
      return id;
    } catch (err) {
      console.warn('[cidades] geocodificação falhou', err);
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
