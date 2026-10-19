// Pontos capturáveis vêm da camada `poi` dos vector tiles (OpenMapTiles/OpenFreeMap):
// sem API extra e sem limite de requisições. O mapa entrega as features, aqui viram POIs.
import { POI_INFO, type PoiCategory, type Rarity } from '../sprites/items.ts';
import { haversine, type LngLat } from './geo.ts';
import type { Poi } from './types.ts';

interface Classified {
  category: PoiCategory;
  rarity?: Rarity;
}

/** class/subclass do OpenMapTiles -> categoria do jogo. */
export function classify(cls: string, sub: string): Classified | null {
  switch (cls) {
    case 'park':
      return { category: 'parque' };
    case 'art_gallery':
      if (sub === 'artwork') return { category: 'arte' };
      if (sub === 'arts_centre') return { category: 'cultura' };
      return { category: 'museu' };
    case 'museum':
      return { category: 'museu' };
    case 'theatre':
    case 'cinema':
      return { category: 'cultura' };
    case 'library':
      return sub === 'books' ? null : { category: 'biblioteca' };
    case 'place_of_worship':
      return { category: 'templo' };
    case 'monument':
      return { category: 'monumento' };
    case 'castle':
      return { category: 'monumento', rarity: 'lendario' };
    case 'town_hall':
      return sub === 'townhall' ? { category: 'monumento' } : null;
    case 'stadium':
      return { category: 'estadio' };
    case 'zoo':
    case 'aquarium':
      return { category: 'atracao', rarity: 'lendario' };
    case 'attraction':
      if (sub === 'viewpoint') return { category: 'mirante' };
      if (sub === 'zoo' || sub === 'theme_park' || sub === 'aquarium') return { category: 'atracao', rarity: 'lendario' };
      return { category: 'atracao' };
    default:
      return null;
  }
}

export const CAPTURABLE_CLASSES = [
  'park', 'art_gallery', 'museum', 'theatre', 'cinema', 'library', 'place_of_worship', 'monument', 'castle',
  'town_hall', 'stadium', 'zoo', 'aquarium', 'attraction',
];

export interface RawPoiFeature {
  id?: string | number;
  lng: number;
  lat: number;
  /** Zoom do tile de origem: tiles de zoom baixo trazem pontos menos precisos. */
  z: number;
  props: Record<string, unknown>;
}

const registry = new Map<string, Poi>();
const sourceZoom = new Map<string, number>();
/** nome normalizado -> ids, para descartar duplicatas próximas (praças com vários pontos). */
const byName = new Map<string, string[]>();
const listeners = new Set<() => void>();

function norm(s: string): string {
  return s.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

export const pois = {
  get size() {
    return registry.size;
  },
  get(id: string): Poi | undefined {
    return registry.get(id);
  },
  all(): IterableIterator<Poi> {
    return registry.values();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** Adiciona features vindas do mapa. Retorna quantos POIs novos entraram. */
  harvest(features: RawPoiFeature[], namePreference: string[] = ['name:pt', 'name', 'name:latin']): number {
    let added = 0;
    let moved = 0;
    const sorted = [...features].sort((a, b) => b.z - a.z);
    for (const f of sorted) {
      const cls = String(f.props.class ?? '');
      const sub = String(f.props.subclass ?? '');
      const c = classify(cls, sub);
      if (!c) continue;
      let name = '';
      for (const k of namePreference) {
        const v = f.props[k];
        if (typeof v === 'string' && v.trim()) {
          name = v.trim();
          break;
        }
      }
      if (!name || name.length < 3) continue;
      const id = f.id != null ? `osm:${f.id}` : `p:${norm(name)}:${f.lng.toFixed(4)},${f.lat.toFixed(4)}`;
      const known = registry.get(id);
      if (known) {
        // chegou a versão de um tile mais detalhado: corrige a posição
        if (f.z > (sourceZoom.get(id) ?? 0)) {
          sourceZoom.set(id, f.z);
          if (known.lng !== f.lng || known.lat !== f.lat) {
            registry.set(id, { ...known, lng: f.lng, lat: f.lat });
            moved++;
          }
        }
        continue;
      }
      const n = norm(name);
      const sameName = byName.get(n) ?? [];
      const p: LngLat = { lng: f.lng, lat: f.lat };
      if (sameName.some((other) => haversine(registry.get(other)!, p) < 180)) continue;
      registry.set(id, {
        id,
        name,
        category: c.category,
        rarity: c.rarity ?? POI_INFO[c.category].rarity,
        lng: f.lng,
        lat: f.lat,
      });
      sourceZoom.set(id, f.z);
      byName.set(n, [...sameName, id]);
      added++;
    }
    if (added || moved) listeners.forEach((fn) => fn());
    return added;
  },

  /** POIs ordenados por distância. */
  nearby(p: LngLat, radius: number, filter?: (poi: Poi) => boolean): { poi: Poi; dist: number }[] {
    const out: { poi: Poi; dist: number }[] = [];
    for (const poi of registry.values()) {
      if (filter && !filter(poi)) continue;
      const d = haversine(p, poi);
      if (d <= radius) out.push({ poi, dist: d });
    }
    return out.sort((a, b) => a.dist - b.dist);
  },
};
