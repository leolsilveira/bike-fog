// Moedas nascem sobre ruas de verdade ao redor do jogador a cada nova atividade.
import { COIN_MIN_SPACING_M } from './config.ts';
import { haversine, lerpLngLat, offset, type LngLat } from './geo.ts';
import { uid } from './store.ts';
import type { Coin, CoinKind } from './types.ts';

/** Quem conhece o mapa fornece as ruas carregadas (lista de polilinhas). */
export type RoadSampler = () => LngLat[][];

function rollKind(distFromCenter: number, radius: number): CoinKind {
  // Mais longe = mais valioso: incentiva explorar além do quarteirão.
  const far = Math.min(1, distFromCenter / radius);
  const r = Math.random();
  if (r < 0.015 + far * 0.025) return 'gem';
  if (r < 0.07 + far * 0.1) return 'gold';
  if (r < 0.3 + far * 0.15) return 'silver';
  return 'bronze';
}

interface Segment {
  a: LngLat;
  b: LngLat;
  len: number;
}

export function spawnCoins(
  center: LngLat,
  count: number,
  radius: number,
  sampler: RoadSampler | null,
  existing: Coin[] = [],
): Coin[] {
  const segs: Segment[] = [];
  let total = 0;
  for (const line of sampler?.() ?? []) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      const mid = lerpLngLat(a, b, 0.5);
      if (haversine(center, mid) > radius) continue;
      const len = haversine(a, b);
      if (len < 5) continue;
      segs.push({ a, b, len });
      total += len;
    }
  }

  const pickOnRoad = (): LngLat | null => {
    if (!segs.length) return null;
    let x = Math.random() * total;
    for (const s of segs) {
      x -= s.len;
      if (x <= 0) return lerpLngLat(s.a, s.b, Math.random());
    }
    return lerpLngLat(segs[segs.length - 1].a, segs[segs.length - 1].b, Math.random());
  };
  const pickInDisk = (): LngLat => offset(center, Math.sqrt(Math.random()) * radius, Math.random() * 360);

  const out: Coin[] = [];
  const taken = [...existing];
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const p = pickOnRoad() ?? pickInDisk();
      const d = haversine(center, p);
      if (d < 50 || d > radius) continue;
      if (taken.some((c) => haversine(c, p) < COIN_MIN_SPACING_M)) continue;
      const coin: Coin = { id: uid('coin'), kind: rollKind(d, radius), lng: p.lng, lat: p.lat };
      out.push(coin);
      taken.push(coin);
      break;
    }
  }
  return out;
}
