// Fonte de posição: GPS real (expo-location; em segundo plano durante a gravação) ou simulador
// (a física roda no mapa, que devolve `simFix`). Mantém o objeto `player` que a interface lê.
import { AppState } from 'react-native';
import { mapHost } from '../bridge/mapHost.ts';
import { DEFAULT_CENTER, MAX_ACCURACY_M } from './config.ts';
import { bearing, haversine, type LngLat } from './geo.ts';
import { finishAndSaveTrack, handleFix, resetTrackerAnchor } from './tracker.ts';
import { useGame } from './store.ts';
import { getKv, saveNow, setKv } from './persist.ts';
import { fromExpo, startWatch } from './gpsSource';
import { setBackgroundSink, startBackgroundLocation, stopBackgroundLocation } from './bgTask';
import { initSimKeys, type KeyVector } from './simKeys';
import { launchParam } from '../services/launch';
import type { RawLocation } from './gpsTypes.ts';
import type { GpsStatus, PlayerFix } from './types.ts';

export const player = {
  /** Posição desenhada (suavizada pelo mapa). */
  display: null as LngLat | null,
  /** Rumo desenhado em graus. */
  heading: 0,
  speed: 0,
  /** Metros andados (para cadência da animação). */
  odometer: 0,
  /** Último fix recebido (GPS ou simulador). */
  target: null as PlayerFix | null,
};

/** 'inactive' (iOS: alerta do sistema, central de notificações) é passageiro: conta como ativo. */
let appActive = AppState.currentState !== 'background';

function setGps(gps: GpsStatus): void {
  if (useGame.getState().gps !== gps) useGame.setState({ gps });
}

// ---------------------------------------------------------------------------
// Posição exibida: vem da telemetria do mapa; sem ela (app em segundo plano, mapa
// desconectado ou travado), direto dos fixes.
// ---------------------------------------------------------------------------
const TELEMETRY_STALE_MS = 2000;
let lastTelemetry = 0;
let lastMapOdometer: number | null = null;

function mapDrivesPlayer(): boolean {
  return appActive && mapHost.connected && Date.now() - lastTelemetry < TELEMETRY_STALE_MS;
}

function onTelemetry(m: { lng: number; lat: number; heading: number; speed: number; odometer: number }): void {
  lastTelemetry = Date.now();
  player.display = { lng: m.lng, lat: m.lat };
  player.heading = m.heading;
  player.speed = m.speed;
  // o odômetro do mapa zera quando a página recarrega: soma só os incrementos
  if (lastMapOdometer != null && m.odometer >= lastMapOdometer) player.odometer += m.odometer - lastMapOdometer;
  lastMapOdometer = m.odometer;
}

function applyFixToPlayer(fix: PlayerFix): void {
  player.target = fix;
  if (mapDrivesPlayer()) return;
  const prev = player.display;
  if (prev) player.odometer += haversine(prev, fix);
  player.display = { lng: fix.lng, lat: fix.lat };
  player.speed = fix.speed;
  if (fix.heading != null && (!prev || fix.speed > 0.8)) player.heading = fix.heading;
}

// ---------------------------------------------------------------------------
// GPS real
// ---------------------------------------------------------------------------
let gpsStop: (() => void) | null = null;
let gpsStarting = false;
let lastGps: PlayerFix | null = null;
/** Timestamp do último fix aceito: o mesmo fix chega pelo watch e pela task de segundo plano. */
let lastFixT = 0;

function gpsShouldRun(): boolean {
  const s = useGame.getState();
  if (!s.hydrated || !s.profile || s.settings.simulator) return false;
  return appActive || s.live?.status === 'recording';
}

/** Ponto único de entrada dos fixes do GPS real (watch em primeiro plano e task de segundo plano). */
function ingest(raw: RawLocation): void {
  if (useGame.getState().settings.simulator) return;
  if (raw.t <= lastFixT) return;
  lastFixT = raw.t;
  const fix: PlayerFix = {
    lng: raw.lng,
    lat: raw.lat,
    accuracy: raw.accuracy,
    speed: raw.speed ?? 0,
    heading: raw.heading,
    t: raw.t,
  };
  // velocidade e rumo desconhecidos: calcula a partir do fix anterior
  if (lastGps) {
    const d = haversine(lastGps, fix);
    const dt = (fix.t - lastGps.t) / 1000;
    if (!raw.speed && dt > 0) fix.speed = d / dt;
    if (fix.heading == null && d > 4) fix.heading = bearing(lastGps, fix);
  }
  lastGps = fix;
  setGps(fix.accuracy > MAX_ACCURACY_M ? 'weak' : 'ok');
  applyFixToPlayer(fix);
  mapHost.send({ type: 'gpsFix', fix });
  handleFix(fix);
}

function startGps(ask: boolean): void {
  if (gpsStop || gpsStarting) return;
  gpsStarting = true;
  void startWatch(
    {
      onLocation: ingest,
      onStatus: (st) => {
        if (useGame.getState().settings.simulator) return;
        // religando com um fix recente (volta do segundo plano) ou erro passageiro: mantém o status do último fix
        const recent = !!lastGps && Date.now() - lastGps.t < 10000;
        if (st === 'searching' && recent) return;
        if (st === 'unavailable' && gpsStop && recent) return;
        setGps(st);
      },
    },
    ask,
  ).then((stop) => {
    gpsStarting = false;
    if (!stop) return;
    if (!gpsShouldRun()) {
      stop();
      return;
    }
    gpsStop = stop;
  });
}

function stopGps(): void {
  gpsStop?.();
  gpsStop = null;
}

function syncGps(ask = true): void {
  if (gpsShouldRun()) startGps(ask);
  else stopGps();
}

/** Pede o GPS de novo (ex.: botão "permitir localização" depois de negar). */
export function requestGps(): void {
  stopGps();
  startGps(true);
}

// ---------------------------------------------------------------------------
// GPS em segundo plano durante a gravação
// ---------------------------------------------------------------------------
let bgDesired = false;
let bgChain: Promise<void> = Promise.resolve();
let askedAlways = false;
let warnedNoBackground = false;
let warnedNoAlways = false;

function syncBackground(): void {
  const s = useGame.getState();
  const want = s.live?.status === 'recording' && !s.settings.simulator;
  if (want === bgDesired) return;
  bgDesired = want;
  bgChain = bgChain.then(want ? enableBackground : stopBackgroundLocation).catch((err: unknown) => {
    console.warn('[gps-bg]', err);
  });
}

async function enableBackground(): Promise<void> {
  if (!bgDesired) return;
  const ask = !askedAlways;
  askedAlways = true;
  const r = await startBackgroundLocation(ask);
  if (!bgDesired) {
    // pausou/finalizou enquanto ligava
    await stopBackgroundLocation();
    return;
  }
  const toast = useGame.getState().toast;
  if (!r.supported) return;
  if (!r.started) {
    if (!warnedNoBackground) {
      warnedNoBackground = true;
      toast('GPS em segundo plano indisponível: deixe o app aberto durante a gravação.', 'warn');
    }
  } else if (r.alwaysDenied && !warnedNoAlways) {
    warnedNoAlways = true;
    toast('Dica: com a localização "Sempre", a gravação não para se o iOS fechar o app.', 'info');
  }
}

// ---------------------------------------------------------------------------
// Simulador (a física roda no mapa; aqui chegam as posições e sai o joystick)
// ---------------------------------------------------------------------------
const SIM_POS_KEY = 'sim-pos';
const sim = {
  pos: null as LngLat | null,
  /** Posição que foi no último `sim` fixo (o mapa recomeça dela se recarregar). */
  stickyPos: null as LngLat | null,
  savedAt: 0,
  urlUsed: false,
  joy: { x: 0, y: 0 },
  keys: { x: 0, y: 0, turbo: false } as KeyVector,
};

function clamp1(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

function sendSimInput(): void {
  if (!useGame.getState().settings.simulator) return;
  mapHost.send({
    type: 'simInput',
    x: clamp1(sim.joy.x + sim.keys.x),
    y: clamp1(sim.joy.y + sim.keys.y),
    turbo: sim.keys.turbo,
  });
}

/** Joystick do simulador: x = direita, y = frente, magnitude 0..1. */
export function setSimInput(x: number, y: number): void {
  sim.joy = { x, y };
  sendSimInput();
}

function urlSimPos(): LngLat | null {
  const lat = Number(launchParam('lat'));
  const lng = Number(launchParam('lng'));
  return lat && lng && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

async function loadSimPos(): Promise<LngLat> {
  if (!sim.urlUsed) {
    sim.urlUsed = true;
    const fromUrl = urlSimPos();
    if (fromUrl) return fromUrl;
  }
  if (sim.pos) return sim.pos;
  const saved = await getKv<LngLat>(SIM_POS_KEY);
  if (saved && typeof saved.lat === 'number' && typeof saved.lng === 'number') return saved;
  return lastGps ? { lng: lastGps.lng, lat: lastGps.lat } : DEFAULT_CENTER;
}

function saveSimPos(force = false): void {
  if (!sim.pos) return;
  const now = Date.now();
  if (!force && now - sim.savedAt < 5000) return;
  sim.savedAt = now;
  void setKv(SIM_POS_KEY, sim.pos).catch(() => undefined);
}

function onSimFix(m: { fix: PlayerFix; teleport?: boolean }): void {
  if (!useGame.getState().settings.simulator) return;
  // teletransporte não conta como deslocamento
  if (m.teleport) resetTrackerAnchor();
  sim.pos = { lng: m.fix.lng, lat: m.fix.lat };
  applyFixToPlayer(m.fix);
  handleFix(m.fix);
  saveSimPos(!!m.teleport);
}

let simSeq = 0;

/** Liga a fonte de posição certa conforme o modo simulador. */
async function applySimMode(): Promise<void> {
  const seq = ++simSeq;
  if (useGame.getState().settings.simulator) {
    stopGps();
    setGps('sim');
    resetTrackerAnchor();
    const pos = await loadSimPos();
    if (seq !== simSeq || !useGame.getState().settings.simulator) return;
    sim.pos = pos;
    sim.stickyPos = pos;
    if (!mapDrivesPlayer()) player.display = { ...pos };
    mapHost.setSticky({ type: 'sim', enabled: true, pos });
  } else {
    saveSimPos(true);
    mapHost.setSticky({ type: 'sim', enabled: false, pos: null });
    resetTrackerAnchor();
    setGps('off');
    syncGps();
  }
  syncBackground();
}

// ---------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------
let started = false;

export function initLocation(): void {
  if (started) return;
  started = true;

  mapHost.on('player', onTelemetry);
  mapHost.on('simFix', onSimFix);
  mapHost.onConnect(() => {
    lastMapOdometer = null;
    if (useGame.getState().settings.simulator) {
      // o mapa recarregou: continua de onde o jogador simulado estava, não de onde começou
      if (sim.pos && sim.stickyPos && haversine(sim.pos, sim.stickyPos) > 1) {
        sim.stickyPos = sim.pos;
        mapHost.setSticky({ type: 'sim', enabled: true, pos: sim.pos });
      }
      sendSimInput();
    } else if (lastGps) {
      mapHost.send({ type: 'gpsFix', fix: lastGps });
    }
  });

  setBackgroundSink(async (locations) => {
    const sorted = [...locations].sort((a, b) => a.timestamp - b.timestamp);
    for (const loc of sorted) ingest(fromExpo(loc));
    // Em segundo plano o iOS pode suspender o processo assim que a task termina: garante o save no disco.
    if (!appActive) await Promise.all([finishAndSaveTrack(), saveNow()]);
  });
  // registro que sobrou de uma sessão morta no meio da gravação (ela volta pausada)
  if (useGame.getState().live?.status !== 'recording') void stopBackgroundLocation();

  initSimKeys(
    () => useGame.getState().settings.simulator,
    (v) => {
      sim.keys = v;
      sendSimInput();
    },
  );

  if (launchParam('sim') === '1' && !useGame.getState().settings.simulator) {
    useGame.getState().setSetting('simulator', true);
  }
  void applySimMode();

  AppState.addEventListener('change', (state) => {
    const active = state !== 'background';
    if (active === appActive) return;
    appActive = active;
    if (active) {
      lastTelemetry = 0;
      // voltou dos Ajustes: se o GPS estava negado/desligado, tenta de novo sem pedir
      const gps = useGame.getState().gps;
      if (gps === 'denied' || gps === 'unavailable') stopGps();
      syncGps(false);
    } else {
      saveSimPos(true);
      syncGps();
    }
  });

  useGame.subscribe((s, prev) => {
    if (s.settings.simulator !== prev.settings.simulator) {
      void applySimMode();
      return;
    }
    if (s.profile !== prev.profile || s.hydrated !== prev.hydrated || s.live?.status !== prev.live?.status) syncGps();
    if (s.live?.status !== prev.live?.status) syncBackground();
  });
}
