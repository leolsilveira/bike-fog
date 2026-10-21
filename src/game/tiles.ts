// Dados do mapa para o jogo: baixa os vector tiles z14 do OpenFreeMap em volta do jogador e extrai
// POIs capturáveis e ruas. Roda no host (JS puro + fetch), então funciona com o app em segundo plano,
// quando a WebView do mapa está suspensa.
import { haversine, type LngLat } from './geo.ts';
import { pois } from './pois.ts';
import { decodeTile, lngLatToTile, tileKey, tilesAround, unflatten, TILE_ZOOM, type TileCoord } from './tileDecode.ts';
import { fetchWithTimeout } from './net.ts';

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
/** Raio coberto em volta do jogador (a lista "por perto" usa 1,5 km). */
export const COVER_RADIUS_M = 1800;
/** Andou isso desde a última avaliação: confere de novo quais tiles faltam. */
const REEVALUATE_M = 300;
const MAX_CONCURRENCY = 3;
/** Tiles decodificados guardados (só as ruas; os POIs vão para o registro e ficam). */
const MAX_CACHED = 40;
/** Teto de tiles para a área visível do mapa (afastando muito o zoom, só os do meio). */
export const MAX_VIEW_TILES = 12;
const FETCH_TIMEOUT_MS = 20000;
/** O OpenFreeMap publica uma versão nova por semana; o endereço dos tiles muda junto. */
const TILEJSON_TTL_MS = 6 * 3600 * 1000;

type TileState = 'queued' | 'loading' | 'ready' | 'failed';

interface TileEntry {
  coord: TileCoord;
  key: string;
  state: TileState;
  roads: Float64Array[];
  failures: number;
  retryAt: number;
  usedAt: number;
}

const entries = new Map<string, TileEntry>();
let inFlight = 0;
/** Chaves em volta do centro atual (não saem do cache). */
let wanted = new Set<string>();
/** Chaves da área visível do mapa (idem). */
let viewWanted = new Set<string>();
let center: LngLat | null = null;
let centerTile = '';
const doneListeners = new Set<() => void>();

let template: string | null = null;
let templateAt = 0;
let templateFailures = 0;
let templateRetryAt = 0;
let templateLoading: Promise<string | null> | null = null;

function backoff(failures: number): number {
  return Math.min(120000, 2000 * 2 ** Math.min(6, failures - 1));
}

async function getTemplate(): Promise<string | null> {
  const now = Date.now();
  if (template && now - templateAt < TILEJSON_TTL_MS) return template;
  if (templateLoading) return templateLoading;
  if (now < templateRetryAt) return template;
  templateLoading = (async () => {
    try {
      const res = await fetchWithTimeout(TILEJSON_URL, FETCH_TIMEOUT_MS, { Accept: 'application/json' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tj = (await res.json()) as { tiles?: string[] };
      const t = tj.tiles?.[0];
      if (!t || !t.includes('{z}')) throw new Error('TileJSON sem tiles');
      template = t;
      templateAt = Date.now();
      templateFailures = 0;
    } catch (err) {
      templateFailures++;
      templateRetryAt = Date.now() + backoff(templateFailures);
      console.warn('[tiles] TileJSON indisponível', String(err));
    } finally {
      templateLoading = null;
    }
    return template;
  })();
  return templateLoading;
}

function tileUrl(tpl: string, c: TileCoord): string {
  return tpl.replace('{z}', String(c.z)).replace('{x}', String(c.x)).replace('{y}', String(c.y));
}

function notifyDone(): void {
  doneListeners.forEach((fn) => fn());
}

function fail(e: TileEntry, quick = false): void {
  e.failures++;
  e.state = 'failed';
  e.retryAt = Date.now() + (quick ? 1000 : backoff(e.failures));
}

async function load(e: TileEntry): Promise<void> {
  e.state = 'loading';
  inFlight++;
  try {
    const tpl = await getTemplate();
    if (!tpl) {
      fail(e);
      return;
    }
    const res = await fetchWithTimeout(tileUrl(tpl, e.coord), FETCH_TIMEOUT_MS);
    if (res.status === 204) {
      // tile vazio (oceano)
      e.roads = [];
      e.state = 'ready';
      return;
    }
    if (!res.ok) {
      // 404 costuma ser versão nova publicada: busca o TileJSON de novo e tenta logo
      if (res.status === 404 && tpl === template && Date.now() - templateAt > 60000) {
        templateAt = 0;
        fail(e, true);
      } else {
        fail(e);
      }
      return;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const dec = decodeTile(bytes, e.coord);
    pois.harvest(dec.pois);
    e.roads = dec.roads;
    e.state = 'ready';
    e.failures = 0;
  } catch (err) {
    // sem rede, timeout, tile corrompido: tenta depois, com espera crescente
    fail(e);
    if (e.failures <= 1) console.warn('[tiles] falha', e.key, String(err));
  } finally {
    inFlight--;
    e.usedAt = Date.now();
    evict();
    notifyDone();
    pump();
  }
}

function pump(): void {
  while (inFlight < MAX_CONCURRENCY) {
    let next: TileEntry | null = null;
    let best = Infinity;
    const c = center ? lngLatToTile(center, TILE_ZOOM) : null;
    for (const e of entries.values()) {
      if (e.state !== 'queued') continue;
      const d = c ? Math.hypot(e.coord.x - c.x, e.coord.y - c.y) : 0;
      if (d < best) {
        best = d;
        next = e;
      }
    }
    if (!next) return;
    void load(next);
  }
}

function evict(): void {
  if (entries.size <= MAX_CACHED) return;
  const old = [...entries.values()]
    .filter((e) => (e.state === 'ready' || e.state === 'failed') && !wanted.has(e.key) && !viewWanted.has(e.key))
    .sort((a, b) => a.usedAt - b.usedAt);
  for (const e of old) {
    if (entries.size <= MAX_CACHED) break;
    entries.delete(e.key);
  }
}

/** Pede os tiles (os que já estão prontos ou a caminho ficam como estão; falhas vencidas voltam à fila). */
function request(coords: TileCoord[]): void {
  const now = Date.now();
  for (const coord of coords) {
    const key = tileKey(coord);
    const e = entries.get(key);
    if (!e) {
      entries.set(key, { coord, key, state: 'queued', roads: [], failures: 0, retryAt: 0, usedAt: now });
    } else {
      e.usedAt = now;
      if (e.state === 'failed' && now >= e.retryAt) e.state = 'queued';
    }
  }
  pump();
}

/** Chamado a cada posição: reavalia ao trocar de tile ou andar mais de 300 m. */
export function updateTiles(p: LngLat): void {
  const t = lngLatToTile(p, TILE_ZOOM);
  const tk = `${t.x}/${t.y}`;
  if (center && tk === centerTile && haversine(center, p) < REEVALUATE_M) {
    // parado: só tenta de novo o que falhou e já pode ser refeito
    const now = Date.now();
    for (const key of wanted) {
      const e = entries.get(key);
      if (e?.state === 'failed' && now >= e.retryAt) {
        request(tilesAround(center, COVER_RADIUS_M));
        break;
      }
    }
    return;
  }
  center = { lng: p.lng, lat: p.lat };
  centerTile = tk;
  const coords = tilesAround(p, COVER_RADIUS_M);
  wanted = new Set(coords.map(tileKey));
  // o que ainda estava na fila de uma área antiga não precisa mais ser baixado
  for (const [key, e] of entries) {
    if (e.state === 'queued' && !wanted.has(key) && !viewWanted.has(key)) entries.delete(key);
  }
  request(coords);
}

/**
 * Área visível do mapa: baixa os tiles que a cobrem (no máximo MAX_VIEW_TILES, os mais perto do meio),
 * para os POIs aparecerem onde o jogador está olhando, não só onde ele está.
 */
export function updateViewTiles(view: { west: number; south: number; east: number; north: number }): void {
  const nw = lngLatToTile({ lng: view.west, lat: view.north }, TILE_ZOOM);
  const se = lngLatToTile({ lng: view.east, lat: view.south }, TILE_ZOOM);
  const cx = (nw.x + se.x) / 2;
  const cy = (nw.y + se.y) / 2;
  const coords: TileCoord[] = [];
  for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) coords.push({ x, y, z: TILE_ZOOM });
  coords.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
  const picked = coords.slice(0, MAX_VIEW_TILES);
  viewWanted = new Set(picked.map(tileKey));
  for (const [key, e] of entries) {
    if (e.state === 'queued' && !wanted.has(key) && !viewWanted.has(key)) entries.delete(key);
  }
  request(picked);
}

/**
 * Espera os tiles em volta de `p` terminarem (prontos ou com falha), até `timeoutMs`.
 * Resolve com true se todos ficaram prontos.
 */
export function waitForTiles(p: LngLat, radius: number, timeoutMs: number): Promise<boolean> {
  const coords = tilesAround(p, radius);
  for (const c of coords) wanted.add(tileKey(c));
  request(coords);
  const settled = () => coords.every((c) => {
    const s = entries.get(tileKey(c))?.state;
    return s === 'ready' || s === 'failed';
  });
  const allReady = () => coords.every((c) => entries.get(tileKey(c))?.state === 'ready');
  if (settled()) return Promise.resolve(allReady());
  return new Promise((resolve) => {
    const check = () => {
      if (!settled()) return;
      cleanup();
      resolve(allReady());
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(allReady());
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      doneListeners.delete(check);
    };
    doneListeners.add(check);
  });
}

/** Ruas dos tiles já carregados em volta de `p` (para as moedas nascerem sobre elas). */
export function roadsNear(p: LngLat, radius: number): LngLat[][] {
  const out: LngLat[][] = [];
  for (const c of tilesAround(p, radius)) {
    const e = entries.get(tileKey(c));
    if (e?.state !== 'ready') continue;
    e.usedAt = Date.now();
    for (const flat of e.roads) out.push(unflatten(flat));
  }
  return out;
}

/** Estado para depuração/testes. */
export function tileStats(): { total: number; ready: number; failed: number; loading: number; queued: number } {
  const s = { total: entries.size, ready: 0, failed: 0, loading: 0, queued: 0 };
  for (const e of entries.values()) s[e.state]++;
  return s;
}
