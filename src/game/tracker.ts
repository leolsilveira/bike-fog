// Recebe cada posição (GPS real ou simulador) e aplica as regras do jogo.
import {
  COINS_PER_SPAWN, COIN_PICKUP_M, COIN_SPAWN_RADIUS_M, MAX_ACCURACY_M, MAX_SPAWNS_PER_ACTIVITY, MAX_SPEED,
  RESPAWN_DISTANCE_M, REVEAL_RADIUS_M, XP,
} from './config.ts';
import { haversine, metersPerMercUnit, toMerc, type LngLat } from './geo.ts';
import { fog } from './fog.ts';
import { pois } from './pois.ts';
import { spawnCoins, type RoadSampler } from './coins.ts';
import { bumpCityCells, cityAtSync, ensureCityAt } from './cities.ts';
import { checkAndGrantAchievements } from './achievements.ts';
import { useGame } from './store.ts';
import { haptic, sfx, vibrate } from './audio.ts';
import { loadTrack, saveTrack } from './persist.ts';
import { roadsNear, waitForTiles } from './tiles.ts';
import { COIN_LABEL, COIN_VALUE, POI_INFO } from '../sprites/items.ts';
import type { PlayerFix } from './types.ts';

const MAX_CAPTURE_M = Math.max(...Object.values(POI_INFO).map((i) => i.radius));
/** Quanto esperar as ruas em volta carregarem antes de espalhar moedas. */
const SPAWN_WAIT_MS = 4000;

let last: PlayerFix | null = null;
let track: number[] = [];
let trackSavedLen = 0;
let distXpAcc = 0;
/** Substitui a fonte de ruas (testes). Padrão: ruas dos tiles carregados por tiles.ts. */
let roadSampler: RoadSampler | null = null;
/** Spawn em andamento (esperando os tiles): evita lotes duplicados. */
let spawning = false;
const trackListeners = new Set<(track: number[]) => void>();

export function setRoadSampler(fn: RoadSampler | null): void {
  roadSampler = fn;
}

export function onTrack(fn: (track: number[]) => void): () => void {
  trackListeners.add(fn);
  fn(track);
  return () => trackListeners.delete(fn);
}

function emitTrack(): void {
  trackListeners.forEach((fn) => fn(track));
}

/** Distância (m) do ponto p ao segmento a-b, em aproximação plana local. */
function distToSegment(p: LngLat, a: LngLat, b: LngLat): number {
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

/**
 * Espalha um lote de moedas sobre as ruas em volta de p. Espera (até ~4 s) os tiles em volta
 * carregarem, para as moedas caírem nas ruas; sem rede, cai no disco em volta do ponto.
 */
async function spawnAround(p: LngLat): Promise<void> {
  const before = useGame.getState().live;
  if (spawning || !before || before.spawns >= MAX_SPAWNS_PER_ACTIVITY) return;
  spawning = true;
  try {
    if (!roadSampler) await waitForTiles(p, COIN_SPAWN_RADIUS_M, SPAWN_WAIT_MS);
    const s = useGame.getState();
    const live = s.live;
    // a atividade terminou, trocou ou já ganhou esse lote enquanto esperávamos
    if (!live || live.id !== before.id || live.spawns !== before.spawns) return;
    const sampler: RoadSampler = roadSampler ?? (() => roadsNear(p, COIN_SPAWN_RADIUS_M));
    const fresh = spawnCoins(p, COINS_PER_SPAWN, COIN_SPAWN_RADIUS_M, sampler, s.coins);
    useGame.setState({
      coins: [...s.coins, ...fresh],
      live: { ...live, spawns: live.spawns + 1, spawnCenters: [...live.spawnCenters, { lng: p.lng, lat: p.lat }] },
    });
    if (live.spawns > 0) s.toast(`${fresh.length} moedas novas apareceram por aqui!`, 'info');
  } catch (err) {
    console.warn('[tracker] spawn falhou', err);
  } finally {
    spawning = false;
  }
}

function collectNear(a: LngLat, b: LngLat): boolean {
  const s = useGame.getState();
  let collected = false;
  for (const coin of s.coins) {
    if (distToSegment(coin, a, b) > COIN_PICKUP_M) continue;
    useGame.getState().collectCoin(coin);
    const value = COIN_VALUE[coin.kind];
    if (coin.kind === 'gem') sfx.gem();
    else if (value >= 20) sfx.coinBig();
    else sfx.coin();
    vibrate(30);
    useGame.getState().toast(`+${value} · ${COIN_LABEL[coin.kind]}`, 'coin', coin.kind);
    collected = true;
  }
  return collected;
}

function captureNear(a: LngLat, b: LngLat): boolean {
  const s = useGame.getState();
  const found = pois.nearby(b, MAX_CAPTURE_M + haversine(a, b), (poi) => !s.captures[poi.id]);
  let captured = false;
  for (const { poi } of found) {
    if (distToSegment(poi, a, b) > POI_INFO[poi.category].radius) continue;
    useGame.getState().capturePoi(poi, cityAtSync(poi));
    sfx.capture();
    vibrate([60, 40, 120]);
    captured = true;
  }
  return captured;
}

function persistTrack(force = false): Promise<void> {
  const live = useGame.getState().live;
  if (!live || track.length === trackSavedLen) return Promise.resolve();
  if (force || track.length - trackSavedLen >= 60) {
    trackSavedLen = track.length;
    return saveTrack(live.id, track);
  }
  return Promise.resolve();
}

export function handleFix(fix: PlayerFix): void {
  useGame.setState({ fix });
  void ensureCityAt(fix).then((id) => {
    if (id !== useGame.getState().currentCityId) useGame.setState({ currentCityId: id });
  });

  const s = useGame.getState();
  const live = s.live;
  if (!live || live.status !== 'recording') {
    last = null;
    return;
  }
  if (fix.accuracy > MAX_ACCURACY_M) return;

  if (!last) {
    last = fix;
    track.push(fix.lng, fix.lat, fix.t);
    emitTrack();
    if (live.spawnCenters.length === 0) void spawnAround(fix);
    revealAndCollect(fix, fix);
    return;
  }

  const dt = Math.max(0.001, (fix.t - last.t) / 1000);
  const d = haversine(last, fix);
  // Zona morta: parado, o GPS "passeia" alguns metros. Sem atualizar `last`,
  // o movimento real se acumula até passar do limite e então conta inteiro.
  if (d < Math.max(1.5, Math.min(fix.accuracy * 0.6, 12))) return;
  const speed = d / dt;
  const max = MAX_SPEED[live.modality];
  if (speed > max) {
    if (!s.speedWarning) {
      useGame.setState({ speedWarning: true });
      sfx.warn();
      haptic('warning');
    }
    last = fix;
    return;
  }
  if (s.speedWarning) useGame.setState({ speedWarning: false });

  const moving = speed > 0.6;
  distXpAcc += (d / 1000) * XP.perKm[live.modality];
  const distXp = Math.floor(distXpAcc);
  distXpAcc -= distXp;

  useGame.setState({
    live: {
      ...live,
      distanceM: live.distanceM + d,
      movingS: live.movingS + (moving ? Math.min(dt, 30) : 0),
      maxSpeed: Math.max(live.maxSpeed, speed),
    },
  });
  if (distXp) useGame.getState().addXp(distXp);

  track.push(fix.lng, fix.lat, fix.t);
  emitTrack();
  void persistTrack();

  revealAndCollect(last, fix);

  const centers = useGame.getState().live?.spawnCenters ?? [];
  if (centers.length && centers.every((c) => haversine(c, fix) > RESPAWN_DISTANCE_M)) void spawnAround(fix);

  last = fix;
}

function revealAndCollect(a: PlayerFix, b: PlayerFix): void {
  const { added, byCity } = fog.revealAlong(a, b, REVEAL_RADIUS_M, cityAtSync);
  if (added.length) {
    for (const [id, n] of Object.entries(byCity)) bumpCityCells(id, n);
    const st = useGame.getState();
    const live = st.live!;
    const newCities = Object.keys(byCity).filter((id) => !live.cityIds.includes(id));
    const cityIds = newCities.length ? [...live.cityIds, ...newCities] : live.cityIds;
    useGame.setState({
      live: { ...live, newCells: live.newCells + added.length, cityIds },
      totals: { ...st.totals, cells: st.totals.cells + added.length },
    });
    useGame.getState().addXp(added.length * XP.perCell);
  }
  const gotCoin = collectNear(a, b);
  const gotPoi = captureNear(a, b);
  if (gotCoin || gotPoi) checkAndGrantAchievements();
  else checkAndGrantAchievements({ throttleMs: 1500 });
}

/** Restaura a trilha de uma atividade interrompida (o app foi fechado no meio). */
export async function restoreLiveTrack(): Promise<void> {
  const live = useGame.getState().live;
  if (!live) return;
  const t = await loadTrack(live.id);
  if (t) {
    track = Array.from(t);
    trackSavedLen = track.length;
    emitTrack();
  }
}

/** Chamado quando a atividade começa, pausa, retoma ou termina. */
export function onActivityChange(): void {
  const live = useGame.getState().live;
  last = null;
  if (!live) {
    track = [];
    trackSavedLen = 0;
    distXpAcc = 0;
    emitTrack();
    useGame.setState({ speedWarning: false });
  }
}

export async function finishAndSaveTrack(): Promise<void> {
  await persistTrack(true);
}

/** Esquece a última posição (teletransporte do simulador não conta como deslocamento). */
export function resetTrackerAnchor(): void {
  last = null;
}

/** Reprocessa a última posição conhecida (ao iniciar/retomar sem esperar o GPS se mover). */
export function kickTracker(): void {
  const fix = useGame.getState().fix;
  if (fix) handleFix({ ...fix, t: Date.now() });
}
