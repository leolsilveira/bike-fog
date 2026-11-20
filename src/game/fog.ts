// Células exploradas. Fica fora do zustand porque pode ter dezenas de milhares de itens.
import { cellsInRadius, cellCenter, haversine, lerpLngLat, type LngLat } from './geo.ts';

type Listener = (added: number[], reset: boolean) => void;

/** chave da célula -> índice da cidade em `cityIds` (0 = ainda sem cidade) */
const cells = new Map<number, number>();
const cityIds: string[] = [''];
const listeners = new Set<Listener>();

function cityIndex(id: string): number {
  let i = cityIds.indexOf(id);
  if (i < 0) {
    cityIds.push(id);
    i = cityIds.length - 1;
  }
  return i;
}

export const fog = {
  get size() {
    return cells.size;
  },

  has(key: number): boolean {
    return cells.has(key);
  },

  keys(): IterableIterator<number> {
    return cells.keys();
  },

  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** Revela células num raio ao longo do segmento a→b (sem buracos em movimento rápido). */
  revealAlong(
    a: LngLat,
    b: LngLat,
    radius: number,
    cityOf: (p: LngLat) => string | null,
  ): { added: number[]; byCity: Record<string, number> } {
    const dist = haversine(a, b);
    const steps = Math.max(1, Math.ceil(dist / (radius * 0.5)));
    const added: number[] = [];
    const byCity: Record<string, number> = {};
    for (let i = 0; i <= steps; i++) {
      const p = lerpLngLat(a, b, i / steps);
      for (const key of cellsInRadius(p, radius)) {
        if (cells.has(key)) continue;
        const city = cityOf(cellCenter(key));
        cells.set(key, city ? cityIndex(city) : 0);
        if (city) byCity[city] = (byCity[city] ?? 0) + 1;
        added.push(key);
      }
    }
    if (added.length) listeners.forEach((fn) => fn(added, false));
    return { added, byCity };
  },

  /** Revela células num raio ao longo de vários segmentos e notifica os ouvintes uma única vez. */
  revealSegments(
    segments: [LngLat, LngLat][],
    radius: number,
    cityOf: (p: LngLat) => string | null,
  ): { added: number[]; byCity: Record<string, number> } {
    const added: number[] = [];
    const byCity: Record<string, number> = {};
    for (const [a, b] of segments) {
      const dist = haversine(a, b);
      const steps = Math.max(1, Math.ceil(dist / (radius * 0.5)));
      for (let i = 0; i <= steps; i++) {
        const p = lerpLngLat(a, b, i / steps);
        for (const key of cellsInRadius(p, radius)) {
          if (cells.has(key)) continue;
          const city = cityOf(cellCenter(key));
          cells.set(key, city ? cityIndex(city) : 0);
          if (city) byCity[city] = (byCity[city] ?? 0) + 1;
          added.push(key);
        }
      }
    }
    if (added.length) listeners.forEach((fn) => fn(added, false));
    return { added, byCity };
  },

  /** Atribui cidade às células que ainda não têm (quando o polígono da cidade chega). */
  assignPending(cityOf: (p: LngLat) => string | null): number {
    let n = 0;
    for (const [key, idx] of cells) {
      if (idx !== 0) continue;
      const city = cityOf(cellCenter(key));
      if (city) {
        cells.set(key, cityIndex(city));
        n++;
      }
    }
    return n;
  },

  countByCity(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const idx of cells.values()) {
      if (idx === 0) continue;
      const id = cityIds[idx];
      out[id] = (out[id] ?? 0) + 1;
    }
    return out;
  },

  serialize(): { keys: Float64Array; city: Uint16Array; cityIds: string[] } {
    const keys = new Float64Array(cells.size);
    const city = new Uint16Array(cells.size);
    let i = 0;
    for (const [k, c] of cells) {
      keys[i] = k;
      city[i] = c;
      i++;
    }
    return { keys, city, cityIds: [...cityIds] };
  },

  load(data: { keys: Float64Array; city: Uint16Array; cityIds: string[] } | undefined): void {
    cells.clear();
    cityIds.length = 1;
    if (data) {
      data.cityIds.slice(1).forEach((id) => cityIds.push(id));
      for (let i = 0; i < data.keys.length; i++) cells.set(data.keys[i], data.city[i] ?? 0);
    }
    listeners.forEach((fn) => fn([...cells.keys()], true));
  },

  clear(): void {
    cells.clear();
    cityIds.length = 1;
    listeners.forEach((fn) => fn([], true));
  },
};
