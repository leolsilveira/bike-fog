// Cola entre o estado do jogo (host) e o mapa: tudo o que o mapa desenha sai daqui pelo protocolo.
// Substitui as partes do antigo engine.ts que liam o jogo (névoa, moedas, POIs, trilha, aba, perfil).
// GPS, simulador e telemetria `player` são do core (location.ts), não daqui.
import { AppState, type AppStateStatus } from 'react-native';
import { mapHost } from '../bridge/mapHost.ts';
import type { CameraMode, HostToMap, LiveStatus, PoiMarker } from '../bridge/protocol.ts';
import { DEFAULT_CENTER, POI_NEARBY_M } from '../game/config.ts';
import { fog } from '../game/fog.ts';
import { cellOf, haversine, toMerc, type LngLat } from '../game/geo.ts';
import { player } from '../game/location.ts';
import { pois } from '../game/pois.ts';
import { useGame, type GameState } from '../game/store.ts';
import { onTrack } from '../game/tracker.ts';
import { updateViewTiles } from '../game/tiles.ts';
import type { Poi } from '../game/types.ts';
import { mapController } from './controller.ts';
import { resolveAvatar } from '../sprites/avatar.ts';
import { RARITY_INFO } from '../sprites/items.ts';

/** Reset grande de células vai em pedaços (o mapa não anima os pedaços que chegam em seguida). */
const CELL_CHUNK = 20000;
const POI_RADIUS_M = POI_NEARBY_M * 1.8;
const POI_MAX = 350;
/** Reconstrói os POIs ao andar isso desde a última vez (ou quando algo muda), no máximo 1x/s. */
const POI_MOVE_M = 150;
const POI_MIN_INTERVAL_MS = 1000;

let started = false;

// trilha: o tracker entrega o array achatado inteiro [lng, lat, t, ...]; aqui só vai o que é novo
let track: number[] = [];
let trackSent = 0;
let trackActivity: string | null = null;

// POIs
let poiDirty = true;
let poiCenter: LngLat | null = null;
let lastPoiBuild = 0;
let poiTimer: ReturnType<typeof setTimeout> | null = null;
let lastPoisJson = '';
/** Área visível do mapa (mensagem `view`); null até o mapa informar. */
let view: { west: number; south: number; east: number; north: number } | null = null;
/** Zoom da câmera (mensagem `view`), para espaçar os POIs na tela. */
let viewZoom: number | null = null;
/** Margem em volta da área visível, para os POIs não "brotarem" na borda ao arrastar. */
const VIEW_PAD = 0.25;

/** Câmera inclinada só com atividade em andamento (gravando ou pausada); fora disso, visão de cima. */
function cameraMode(s: GameState): CameraMode {
  if (s.tab === 'stats') return 'stats';
  return s.live ? 'ride' : 'map';
}

function liveStatus(s: GameState): LiveStatus {
  return s.live?.status ?? 'none';
}

function profileOf(s: GameState): Extract<HostToMap, { type: 'init' }>['profile'] {
  return s.profile
    ? { characterId: s.profile.characterId, avatar: resolveAvatar(s.profile), modality: s.profile.modality }
    : null;
}

/** Onde o jogador está sendo desenhado (telemetria do mapa) ou, sem ela, o último fix. */
function playerPos(): LngLat | null {
  const p = player.display ?? useGame.getState().fix;
  return p ? { lng: p.lng, lat: p.lat } : null;
}

// ---------------------------------------------------------------------------
// Névoa
// ---------------------------------------------------------------------------
function sendAllCells(): void {
  const keys = [...fog.keys()];
  if (!keys.length) {
    mapHost.send({ type: 'cells', reset: true, keys: [] });
    return;
  }
  for (let i = 0; i < keys.length; i += CELL_CHUNK) {
    mapHost.send({ type: 'cells', reset: i === 0, keys: keys.slice(i, i + CELL_CHUNK) });
  }
}

// ---------------------------------------------------------------------------
// Moedas e trilha
// ---------------------------------------------------------------------------
function sendCoins(): void {
  mapHost.send({ type: 'coins', coins: useGame.getState().coins });
}

function trackCoords(from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + 1 < track.length; i += 3) out.push(track[i], track[i + 1]);
  return out;
}

function sendFullTrack(): void {
  trackSent = track.length - (track.length % 3);
  mapHost.send({ type: 'track', reset: true, coords: trackCoords(0) });
}

function onTrackChange(next: number[]): void {
  const activity = useGame.getState().live?.id ?? null;
  // array novo, trilha encolheu ou outra atividade: recomeça a linha
  if (next !== track || next.length < trackSent || activity !== trackActivity) {
    track = next;
    trackActivity = activity;
    sendFullTrack();
    return;
  }
  const coords = trackCoords(trackSent);
  trackSent = track.length - (track.length % 3);
  if (coords.length) mapHost.send({ type: 'track', reset: false, coords });
}

// ---------------------------------------------------------------------------
// POIs (porte do buildPois do engine original)
// ---------------------------------------------------------------------------
/** POIs dentro da área visível (com margem), dos mais perto do `ref` para fora. */
function poisInView(v: NonNullable<typeof view>, ref: LngLat): Poi[] {
  const padX = (v.east - v.west) * VIEW_PAD;
  const padY = (v.north - v.south) * VIEW_PAD;
  const w = v.west - padX;
  const e = v.east + padX;
  const sLat = v.south - padY;
  const n = v.north + padY;
  const out: { poi: Poi; dist: number }[] = [];
  for (const poi of pois.all()) {
    if (poi.lng < w || poi.lng > e || poi.lat < sLat || poi.lat > n) continue;
    out.push({ poi, dist: haversine(ref, poi) });
  }
  return out.sort((a, b) => a.dist - b.dist).map((x) => x.poi);
}

// ---------------------------------------------------------------------------
// Espaçamento: com zoom afastado, só um POI por "vaga" na tela; aproximando, os outros aparecem.
// ---------------------------------------------------------------------------
/** O emblema tem 20×26 px de arte, desenhado a 3 px de tela por pixel × `icon-size`. */
const BADGE_H_PX = 26 * 3;
/** Distância mínima entre POIs, em alturas de emblema (folga para o mapa respirar entre eles). */
const MIN_GAP_BADGES = 1.2;
/** ...e nunca menos que isto em px de tela: afastado, os emblemas encolhem, mas o espaço entre eles não. */
const MIN_GAP_PX = 56;

/** Mesma curva de `icon-size` do mapa (map-runtime/engine.ts: 13 → 0,32, 16 → 0,6, 18,5 → 0,95). */
function iconSize(z: number): number {
  if (z <= 13) return 0.32;
  if (z <= 16) return 0.32 + ((z - 13) / 3) * (0.6 - 0.32);
  if (z <= 18.5) return 0.6 + ((z - 16) / 2.5) * (0.95 - 0.6);
  return 0.95;
}

/** Ordem de quem fica com a vaga: revelado e livre > na névoa > capturado; depois o mais raro. */
function priority(poi: Poi, state: PoiMarker['state']): number {
  const stateRank = state === 'wild' ? 0 : state === 'fog' ? 1 : 2;
  // na névoa a raridade ainda é segredo: não influencia
  const rarity = state === 'fog' ? 0 : RARITY_INFO[poi.rarity].xp;
  return stateRank * 10000 - rarity;
}

/**
 * Escolhe, em ordem de prioridade (empate: a ordem de `list`, por distância), POIs que não fiquem a menos de
 * `MIN_GAP_BADGES` emblemas (ou `MIN_GAP_PX`) de outro já escolhido, medindo em pixels do mundo no zoom atual.
 */
function declutter<T extends { poi: Poi; rank: number }>(list: T[], zoom: number, keepId: string | null): T[] {
  const world = 512 * 2 ** zoom;
  const gap = Math.max(MIN_GAP_PX, BADGE_H_PX * iconSize(zoom) * MIN_GAP_BADGES);
  const grid = new Map<string, { x: number; y: number }[]>();
  const kept: T[] = [];
  const ordered = list
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const ka = a.item.poi.id === keepId ? -1 : 0;
      const kb = b.item.poi.id === keepId ? -1 : 0;
      return ka - kb || a.item.rank - b.item.rank || a.i - b.i;
    });
  for (const { item } of ordered) {
    const m = toMerc(item.poi);
    const x = m.x * world;
    const y = m.y * world;
    const gx = Math.floor(x / gap);
    const gy = Math.floor(y / gap);
    let free = true;
    for (let dx = -1; dx <= 1 && free; dx++) {
      for (let dy = -1; dy <= 1 && free; dy++) {
        for (const o of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (Math.hypot(o.x - x, o.y - y) < gap) {
            free = false;
            break;
          }
        }
      }
    }
    if (!free && item.poi.id !== keepId) continue;
    const k = `${gx},${gy}`;
    const cell = grid.get(k) ?? [];
    cell.push({ x, y });
    grid.set(k, cell);
    kept.push(item);
  }
  return kept;
}

function buildPois(center: LngLat): PoiMarker[] {
  const captures = useGame.getState().captures;
  // com a área visível conhecida, desenha o que está na tela; antes disso, o que está em volta do jogador.
  // Seguindo o jogador, a prioridade (teto de POI_MAX) é de quem está perto dele; arrastando, do meio da tela.
  const list = view
    ? poisInView(
      view,
      mapController.isFollowing ? center : { lng: (view.west + view.east) / 2, lat: (view.south + view.north) / 2 },
    )
    : pois.nearby(center, POI_RADIUS_M).map((x) => x.poi);
  const withState = list.map((poi) => {
    const captured = !!captures[poi.id];
    const revealed = captured || fog.has(cellOf(poi));
    const state: PoiMarker['state'] = captured ? 'captured' : revealed ? 'wild' : 'fog';
    return { poi, state, rank: priority(poi, state) };
  });
  const selectedId = useGame.getState().selected?.id ?? null;
  const spaced = viewZoom != null ? declutter(withState, viewZoom, selectedId) : withState;
  return spaced
    .slice(0, POI_MAX)
    .map(({ poi, state }) => {
      return {
        id: poi.id,
        name: poi.name,
        lng: poi.lng,
        lat: poi.lat,
        state,
        icon: state === 'fog' ? 'poi-fog' : `poi-${poi.category}-${state}`,
        color: RARITY_INFO[poi.rarity].color,
      };
    });
}

function refreshPois(force: boolean): void {
  if (!mapHost.connected) {
    poiDirty = true;
    return;
  }
  const center = playerPos();
  if (!center) return;
  const moved = poiCenter ? haversine(poiCenter, center) : Infinity;
  if (!force && !poiDirty && moved <= POI_MOVE_M) return;
  poiDirty = false;
  poiCenter = center;
  lastPoiBuild = Date.now();
  const list = buildPois(center);
  const json = JSON.stringify(list);
  // a névoa muda a cada passo, mas quase nunca muda o estado dos POIs: não reenvia a mesma lista
  if (!force && json === lastPoisJson) return;
  lastPoisJson = json;
  mapHost.send({ type: 'pois', pois: list });
}

/** Agenda uma reconstrução (no máximo 1x/s). */
function requestPois(): void {
  if (poiTimer) return;
  const wait = Math.max(0, POI_MIN_INTERVAL_MS - (Date.now() - lastPoiBuild));
  poiTimer = setTimeout(() => {
    poiTimer = null;
    refreshPois(false);
  }, wait);
}

function markPoisDirty(): void {
  poiDirty = true;
  requestPois();
}

// ---------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------
/** A cada (re)conexão do mapa: cria o mapa e manda o estado inteiro. */
function resync(): void {
  const s = useGame.getState();
  const c = playerPos() ?? DEFAULT_CENTER;
  mapHost.send({
    type: 'init',
    center: { lng: c.lng, lat: c.lat },
    mode: cameraMode(s),
    live: liveStatus(s),
    profile: profileOf(s),
  });
  sendAllCells();
  sendCoins();
  sendFullTrack();
  sendRoute();
  view = null;
  viewZoom = null;
  poiCenter = null;
  lastPoisJson = '';
  refreshPois(true);
}

function sendRoute(): void {
  const r = useGame.getState().route;
  mapHost.send({ type: 'route', route: r ? { coords: r.coords, dest: { lng: r.dest.lng, lat: r.dest.lat } } : null });
  sendRouteDone();
}

function sendRouteDone(): void {
  mapHost.send({ type: 'routeDone', doneM: useGame.getState().routeProgress?.doneM ?? 0 });
}

let wasBackground = false;

function sendActive(state: AppStateStatus | string | null | undefined): void {
  // sem estado conhecido ainda, considera ativo
  mapHost.setSticky({ type: 'active', active: state !== 'background' && state !== 'inactive' });
  if (state === 'background') {
    wasBackground = true;
  } else if (state === 'active' && wasBackground) {
    // com a WebView suspensa, mensagens podem ter se perdido (gravação com a tela apagada): reenvia o estado
    wasBackground = false;
    if (!mapHost.connected) return;
    sendAllCells();
    sendCoins();
    sendFullTrack();
    poiCenter = null;
    lastPoisJson = '';
    refreshPois(true);
  }
}

/** Liga a sincronização host -> mapa (idempotente; chamada pelo MapView ao montar). */
export function startMapSync(): void {
  if (started) return;
  started = true;

  fog.subscribe((added, reset) => {
    if (reset) sendAllCells();
    else if (added.length) mapHost.send({ type: 'cells', reset: false, keys: added });
    markPoisDirty();
  });

  pois.subscribe(() => {
    markPoisDirty();
    // como no engine original: avisa as listas "por perto" da interface
    useGame.setState({ poiRev: useGame.getState().poiRev + 1 });
  });

  useGame.subscribe((s, prev) => {
    if (s.coins !== prev.coins) sendCoins();
    // só o trajeto interessa ao mapa (as paradas mudam durante a atividade sem mudar o desenho)
    if (s.route?.coords !== prev.route?.coords) sendRoute();
    else if (s.routeProgress?.doneM !== prev.routeProgress?.doneM) sendRouteDone();
    // folha fechada sem iniciar (X, toque fora, botão do meio, outra aba): a câmera pode estar enquadrando a
    // rota descartada, então volta para o jogador
    if (prev.planning && !s.planning && !s.live && s.tab === 'map') mapController.recenter();
    if (s.captures !== prev.captures || s.selected !== prev.selected) markPoisDirty();
    if (cameraMode(s) !== cameraMode(prev) || liveStatus(s) !== liveStatus(prev)) {
      mapHost.send({ type: 'mode', mode: cameraMode(s), live: liveStatus(s) });
    }
    const p = s.profile;
    if (
      p &&
      (p.characterId !== prev.profile?.characterId ||
        p.avatar !== prev.profile?.avatar ||
        p.modality !== prev.profile?.modality)
    ) {
      mapHost.send({ type: 'profile', characterId: p.characterId, avatar: resolveAvatar(p), modality: p.modality });
    }
    if (s.fix !== prev.fix) requestPois();
  });

  onTrack(onTrackChange);

  // andar também pede POIs novos (a checagem de 150 m fica em refreshPois)
  mapHost.on('player', () => requestPois());
  mapHost.on('view', (m) => {
    view = { west: m.west, south: m.south, east: m.east, north: m.north };
    viewZoom = m.zoom;
    updateViewTiles(view);
    markPoisDirty();
  });
  mapHost.on('select', (m) => {
    // com a folha "Nova atividade" aberta o mapa é só para ver a rota: o cartão do POI ficaria por cima dela
    if (useGame.getState().planning) return;
    useGame.getState().select((m.id && pois.get(m.id)) || null);
  });
  mapHost.on('log', (m) => {
    const line = `[mapa] ${m.msg}`;
    if (m.level === 'error') console.error(line);
    else if (m.level === 'warn') console.warn(line);
    else console.log(line);
  });

  sendActive(AppState.currentState);
  AppState.addEventListener('change', sendActive);

  mapHost.onConnect(resync);
}
