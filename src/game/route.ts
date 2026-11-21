// Rotas planejadas: busca de endereços (Photon), traçado (OSRM do FOSSGIS) e andamento durante a atividade.
// Os dois são serviços públicos de uso justo: bastam para o protótipo e depois passam pelo backend (ver persist.ts).
import { fetchWithTimeout } from './net.ts';
import { cellsInRadius, haversine, lerpLngLat, offset, type LngLat } from './geo.ts';
import { fog } from './fog.ts';
import { useGame } from './store.ts';
import { sfx } from './audio.ts';
import type { Modality, Place, PlannedRoute, PlayerFix, RouteProgress } from './types.ts';

const PHOTON = 'https://photon.komoot.io/api/';
/** Perfis do OSRM do FOSSGIS (o "driving" da URL é ignorado; quem manda é o servidor). */
const OSRM: Record<Modality, string> = {
  bike: 'https://routing.openstreetmap.de/routed-bike',
  run: 'https://routing.openstreetmap.de/routed-foot',
};
/** Velocidade usada na estimativa de tempo enquanto não há histórico suficiente. */
const DEFAULT_SPEED: Record<Modality, number> = { bike: 16 / 3.6, run: 10 / 3.6 };
const SPEED_RANGE: Record<Modality, [number, number]> = { bike: [8 / 3.6, 35 / 3.6], run: [5 / 3.6, 20 / 3.6] };

/** Mais longe que isto do trajeto conta como "fora da rota". */
export const OFF_ROUTE_M = 50;
/** Passar a esta distância de uma parada intermediária (o destino, na ida e volta) libera a próxima. */
const STOP_REACHED_M = 40;
/** Chegada: a esta distância da última parada. */
const ARRIVED_M = 35;
/** Recálculo automático: fora do trajeto por este tempo, com GPS pelo menos tão preciso quanto isto. */
const REROUTE_AFTER_MS = 6000;
const REROUTE_MAX_ACCURACY_M = 30;
/** Intervalo mínimo entre tentativas (também é o tempo até tentar de novo depois de uma falha). */
const REROUTE_EVERY_MS = 15000;
/** Janela de busca no trajeto em volta do último ponto conhecido (evita "pular" para a volta na ida e volta). */
const WINDOW_BACK_M = 150;
const WINDOW_AHEAD_M = 2000;

// ---------------------------------------------------------------------------
// Busca de endereços
// ---------------------------------------------------------------------------

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, string | undefined>;
}

function toPlace(f: PhotonFeature): Place | null {
  const p = f.properties ?? {};
  const [lng, lat] = f.geometry?.coordinates ?? [];
  if (typeof lng !== 'number' || typeof lat !== 'number') return null;
  const street = p.street ? (p.housenumber ? `${p.street}, ${p.housenumber}` : p.street) : undefined;
  const name = p.name ?? street ?? p.city;
  if (!name) return null;
  const parts: string[] = [];
  for (const part of [p.name ? street : undefined, p.district ?? p.locality, p.city ?? p.county, p.state]) {
    if (part && part !== name && !parts.includes(part)) parts.push(part);
  }
  return { name, detail: parts.join(' · '), lng, lat };
}

/** Candidatos pedidos ao Photon; depois de ordenados por distância, só os primeiros aparecem. */
const SEARCH_CANDIDATES = 20;
const SEARCH_SHOWN = 6;

/**
 * Lugares para o texto digitado, do mais perto de `near` para o mais longe. O Photon ordena por relevância e
 * o viés de localização dele é fraco (um homônimo em outro estado vinha antes do lugar a 2 km): pede vários
 * candidatos e ordena aqui.
 */
export async function searchPlaces(q: string, near: LngLat | null): Promise<Place[]> {
  const params = [`q=${encodeURIComponent(q)}`, `limit=${SEARCH_CANDIDATES}`];
  if (near) params.push(`lat=${near.lat.toFixed(5)}`, `lon=${near.lng.toFixed(5)}`);
  const res = await fetchWithTimeout(`${PHOTON}?${params.join('&')}`, 10000, { Accept: 'application/json' });
  if (!res.ok) throw new Error(`Photon ${res.status}`);
  const data = (await res.json()) as { features?: PhotonFeature[] };
  const out: Place[] = [];
  const seen = new Set<string>();
  for (const f of data.features ?? []) {
    const place = toPlace(f);
    if (!place) continue;
    const key = `${place.name}|${place.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(place);
  }
  if (near) {
    const dist = new Map(out.map((p) => [p, haversine(near, p)]));
    out.sort((a, b) => dist.get(a)! - dist.get(b)!);
  }
  return out.slice(0, SEARCH_SHOWN);
}

// ---------------------------------------------------------------------------
// Traçado
// ---------------------------------------------------------------------------

interface OsrmResult {
  coords: number[];
  distanceM: number;
  /** Pontos pedidos já ajustados à rua mais próxima, na mesma ordem. */
  snapped: LngLat[];
}

/** Trajeto passando por `points` em ordem; `continue_straight` evita "ir e voltar" num ponto intermediário. */
async function fetchRoute(points: LngLat[], modality: Modality): Promise<OsrmResult> {
  const path = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `${OSRM[modality]}/route/v1/driving/${path}?overview=full&geometries=geojson&continue_straight=true`;
  const res = await fetchWithTimeout(url, 20000, { Accept: 'application/json' });
  const data = (await res.json().catch(() => null)) as {
    code?: string;
    routes?: { distance: number; geometry: { coordinates: [number, number][] } }[];
    waypoints?: { location: [number, number] }[];
  } | null;
  const r = data?.routes?.[0];
  if (!res.ok || data?.code !== 'Ok' || !r || r.geometry.coordinates.length < 2) {
    throw new Error(`OSRM ${res.status} ${data?.code ?? ''}`);
  }
  const snapped = points.map((p, i) => {
    const loc = data?.waypoints?.[i]?.location;
    return loc ? { lng: loc[0], lat: loc[1] } : { lng: p.lng, lat: p.lat };
  });
  return { coords: r.geometry.coordinates.flat(), distanceM: r.distance, snapped };
}

/** Rota de `from` até `dest` (e de volta a `from`, se `roundTrip`). */
export async function planRoute(
  from: LngLat,
  dest: Place,
  roundTrip: boolean,
  modality: Modality,
): Promise<PlannedRoute> {
  const start = { lng: from.lng, lat: from.lat };
  const d: LngLat = { lng: dest.lng, lat: dest.lat };
  const r = await fetchRoute(roundTrip ? [start, d, start] : [start, d], modality);
  return {
    kind: 'address',
    dest,
    roundTrip,
    modality,
    coords: r.coords,
    distanceM: r.distanceM,
    stops: r.snapped.slice(1),
    fogShare: fogShare(r.coords),
  };
}

// ---------------------------------------------------------------------------
// Volta automática
// ---------------------------------------------------------------------------

/** As ruas fazem o trajeto real ~30% maior que o círculo ideal. */
const ROAD_FACTOR = 1.3;
/** Distância aceita sem corrigir o raio (fração do pedido). */
const LOOP_TOLERANCE = 0.08;
const LOOP_ATTEMPTS = 3;
const BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315];

/** Fração (0 a 1) de `points` que cai em névoa (sem célula explorada a até `radius` m). */
function fogShareOf(points: LngLat[], radius: number): number {
  if (!points.length) return 0;
  let foggy = 0;
  for (const p of points) if (!cellsInRadius(p, radius).some((k) => fog.has(k))) foggy++;
  return foggy / points.length;
}

/** Pontos do trajeto a cada ~`step` m (para medir quanto dele passa pela névoa). */
function samplePath(coords: number[], step: number): LngLat[] {
  const out: LngLat[] = [];
  let carry = step;
  for (let i = 0; i + 3 < coords.length; i += 2) {
    const a = { lng: coords[i], lat: coords[i + 1] };
    const b = { lng: coords[i + 2], lat: coords[i + 3] };
    const len = haversine(a, b);
    let t = carry;
    while (t <= len) {
      out.push(lerpLngLat(a, b, t / len));
      t += step;
    }
    carry = t - len;
  }
  return out;
}

/** Quanto do trajeto passa pela névoa (0 a 1): mostrado na folha e usado para escolher a volta. */
export function fogShare(coords: number[]): number {
  return fogShareOf(samplePath(coords, 60), 25);
}

/** Pontos do círculo da volta: centro a `r` m do início, no rumo `brg`; o início está no próprio círculo. */
function circle(from: LngLat, r: number, brg: number, n: number): LngLat[] {
  const center = offset(from, r, brg);
  const back = (brg + 180) % 360;
  return Array.from({ length: n }, (_, i) => offset(center, r, back + (360 * (i + 1)) / (n + 1)));
}

/**
 * Rumos para o centro da volta, do que tem mais névoa no caminho para o que tem menos (empate: ordem fixa).
 * "Outra sugestão" percorre essa lista.
 */
function rankBearings(from: LngLat, r: number): number[] {
  const scored = BEARINGS.map((b, i) => ({ b, i, s: fogShareOf(circle(from, r, b, 23), 40) }));
  scored.sort((x, y) => y.s - x.s || x.i - y.i);
  return scored.map((x) => x.b);
}

/**
 * Volta de ~`targetM` m saindo e chegando em `from`: três pontos num círculo, traçados pelas ruas. O raio é
 * corrigido até a distância bater (±8%). `variant` escolhe o rumo: 0 é o que atravessa mais névoa.
 */
export async function planLoop(
  from: LngLat,
  targetM: number,
  modality: Modality,
  variant: number,
): Promise<PlannedRoute> {
  const start = { lng: from.lng, lat: from.lat };
  let r = targetM / (2 * Math.PI * ROAD_FACTOR);
  const order = rankBearings(start, r);
  const brg = order[((variant % order.length) + order.length) % order.length];
  let best: OsrmResult | null = null;
  for (let attempt = 0; attempt < LOOP_ATTEMPTS; attempt++) {
    const res = await fetchRoute([start, ...circle(start, r, brg, 3), start], modality);
    if (!best || Math.abs(res.distanceM - targetM) < Math.abs(best.distanceM - targetM)) best = res;
    const ratio = targetM / res.distanceM;
    if (Math.abs(1 - ratio) <= LOOP_TOLERANCE) break;
    r *= ratio;
  }
  const km = Math.round(targetM / 100) / 10;
  return {
    kind: 'loop',
    dest: { name: `Volta de ${String(km).replace('.', ',')} km`, detail: '', lng: start.lng, lat: start.lat },
    roundTrip: false,
    modality,
    coords: best!.coords,
    distanceM: best!.distanceM,
    stops: best!.snapped.slice(1),
    fogShare: fogShare(best!.coords),
  };
}

/** Novo trajeto da posição atual pelas paradas que faltam (recálculo automático fora da rota). */
async function recalcRoute(from: LngLat): Promise<void> {
  const r = useGame.getState().route;
  if (!r) return;
  const { coords, distanceM } = await fetchRoute([{ lng: from.lng, lat: from.lat }, ...r.stops], r.modality);
  // a rota mudou enquanto a resposta vinha (atividade acabou, outra rota): descarta
  if (useGame.getState().route?.coords !== r.coords) return;
  useGame.getState().setRoute({ ...useGame.getState().route!, coords, distanceM });
}

/** Velocidade típica do jogador na modalidade (histórico), para estimar o tempo da rota. */
export function typicalSpeed(modality: Modality): number {
  let d = 0;
  let t = 0;
  for (const a of useGame.getState().activities) {
    if (a.modality !== modality) continue;
    d += a.distanceM;
    t += a.movingS;
  }
  const [min, max] = SPEED_RANGE[modality];
  return d >= 2000 && t > 0 ? Math.min(max, Math.max(min, d / t)) : DEFAULT_SPEED[modality];
}

export function routeBounds(coords: number[]): { west: number; south: number; east: number; north: number } {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (let i = 0; i + 1 < coords.length; i += 2) {
    west = Math.min(west, coords[i]);
    east = Math.max(east, coords[i]);
    south = Math.min(south, coords[i + 1]);
    north = Math.max(north, coords[i + 1]);
  }
  return { west, south, east, north };
}

// ---------------------------------------------------------------------------
// Andamento durante a atividade
// ---------------------------------------------------------------------------

/** Trajeto em metros (projeção local equirretangular: sobra precisão na escala de uma cidade). */
interface Geom {
  coords: number[];
  lng0: number;
  lat0: number;
  kx: number;
  ky: number;
  xy: Float64Array;
  /** Distância acumulada até cada vértice. */
  cum: Float64Array;
  total: number;
  /** Último ponto conhecido no trajeto (m desde o início). */
  done: number;
  /** Posição no trajeto (m) de cada parada que faltava quando a geometria foi montada. */
  stopAlong: number[];
}

let geom: Geom | null = null;
/** Desde quando está fora do trajeto (ms) e quando foi a última tentativa de recálculo. */
let offSince: number | null = null;
let lastReroute = 0;

function buildGeom(coords: number[]): Geom {
  const n = coords.length / 2;
  const lng0 = coords[0];
  const lat0 = coords[1];
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110574;
  const xy = new Float64Array(n * 2);
  const cum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xy[i * 2] = (coords[i * 2] - lng0) * kx;
    xy[i * 2 + 1] = (coords[i * 2 + 1] - lat0) * ky;
    if (i > 0) cum[i] = cum[i - 1] + Math.hypot(xy[i * 2] - xy[i * 2 - 2], xy[i * 2 + 1] - xy[i * 2 - 1]);
  }
  return { coords, lng0, lat0, kx, ky, xy, cum, total: cum[n - 1], done: 0, stopAlong: [] };
}

/** Ponto do trajeto mais perto de `p` entre os segmentos que passam no filtro. */
function nearest(g: Geom, p: LngLat, accept: (i: number) => boolean): { dist: number; along: number } {
  const px = (p.lng - g.lng0) * g.kx;
  const py = (p.lat - g.lat0) * g.ky;
  let best = { dist: Infinity, along: g.done };
  for (let i = 0; i + 1 < g.cum.length; i++) {
    if (!accept(i)) continue;
    const ax = g.xy[i * 2];
    const ay = g.xy[i * 2 + 1];
    const dx = g.xy[i * 2 + 2] - ax;
    const dy = g.xy[i * 2 + 3] - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const dist = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (dist < best.dist) best = { dist, along: g.cum[i] + t * (g.cum[i + 1] - g.cum[i]) };
  }
  return best;
}

/** Posição no trajeto: procura perto do último ponto; perdido, aceita qualquer trecho a menos de OFF_ROUTE_M. */
function locate(g: Geom, p: LngLat): { dist: number; along: number } {
  const lo = g.done - WINDOW_BACK_M;
  const hi = g.done + WINDOW_AHEAD_M;
  const local = nearest(g, p, (i) => g.cum[i + 1] >= lo && g.cum[i] <= hi);
  if (local.dist <= OFF_ROUTE_M) return local;
  const any = nearest(g, p, () => true);
  return any.dist <= OFF_ROUTE_M ? any : local;
}

function onFix(fix: PlayerFix): void {
  const s = useGame.getState();
  const route = s.route;
  if (!route || s.live?.status !== 'recording') return;
  if (!geom || geom.coords !== route.coords) {
    geom = buildGeom(route.coords);
    // cada parada procurada adiante da anterior (a volta passa perto do início duas vezes)
    let from = 0;
    for (const stop of route.stops) {
      const hit = nearest(geom, stop, (i) => geom!.cum[i + 1] >= from);
      from = hit.along;
      geom.stopAlong.push(hit.along);
    }
  }
  const g = geom;

  const hit = locate(g, fix);
  if (hit.dist <= OFF_ROUTE_M) g.done = hit.along;

  // paradas intermediárias (destino da ida e volta, pontos da volta automática): passar perto ou além libera
  // a próxima; a última é a chegada
  let stops = route.stops;
  while (stops.length > 1) {
    const along = g.stopAlong[g.stopAlong.length - stops.length] ?? Infinity;
    if (haversine(fix, stops[0]) < STOP_REACHED_M || g.done >= along - STOP_REACHED_M) stops = stops.slice(1);
    else break;
  }

  const prev = s.routeProgress;
  const arrived =
    prev?.arrived === true ||
    (stops.length === 1 && g.done > g.total * 0.5 && haversine(fix, stops[0]) < ARRIVED_M);
  const remainingM = arrived ? 0 : Math.max(0, g.total - g.done);
  const next: RouteProgress = { doneM: g.done, remainingM, offRouteM: hit.dist, arrived };
  maybeReroute(fix, !arrived && hit.dist > OFF_ROUTE_M);
  const changed =
    !prev ||
    prev.arrived !== arrived ||
    Math.abs(prev.remainingM - remainingM) >= 10 ||
    prev.offRouteM > OFF_ROUTE_M !== hit.dist > OFF_ROUTE_M ||
    stops !== route.stops;
  if (!changed) return;
  useGame.setState({ routeProgress: next, ...(stops !== route.stops ? { route: { ...route, stops } } : null) });
  if (arrived && !prev?.arrived) {
    sfx.city();
    const done = route.kind === 'loop' ? `${route.dest.name} completa!` : 'Volta completa! Rota concluída.';
    s.toast(route.roundTrip || route.kind === 'loop' ? done : `Você chegou: ${route.dest.name}!`, 'city');
  }
}

/** Fora do trajeto por alguns segundos: traça de novo a partir daqui, sem precisar tocar em nada. */
function maybeReroute(fix: PlayerFix, off: boolean): void {
  const now = Date.now();
  if (!off) {
    offSince = null;
    return;
  }
  offSince ??= now;
  if (
    useGame.getState().rerouting === 'busy' ||
    now - offSince < REROUTE_AFTER_MS ||
    now - lastReroute < REROUTE_EVERY_MS ||
    fix.accuracy > REROUTE_MAX_ACCURACY_M
  ) {
    return;
  }
  lastReroute = now;
  useGame.setState({ rerouting: 'busy' });
  recalcRoute(fix)
    .then(() => {
      offSince = null;
      // sem rota nova (a atividade acabou no meio): só sai do "recalculando"
      if (useGame.getState().rerouting === 'busy') useGame.setState({ rerouting: 'idle' });
    })
    .catch((err: unknown) => {
      console.warn('[rota] recálculo falhou', err);
      if (useGame.getState().rerouting === 'busy') useGame.setState({ rerouting: 'failed' });
    });
}

/** Liga o acompanhamento da rota (cada fix do GPS ou do simulador passa pelo store). */
export function initRouteTracking(): void {
  useGame.subscribe((s, prev) => {
    if (!s.route) {
      geom = null;
      offSince = null;
      lastReroute = 0;
    }
    if (s.fix && s.fix !== prev.fix) onFix(s.fix);
  });
}
