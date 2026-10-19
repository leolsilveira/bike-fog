// Fonte de posição: GPS real (watchPosition) ou simulador (joystick/teclado).
// Também mantém a posição "exibida" suavizada que a câmera e o sprite seguem.
import { DEFAULT_CENTER, MAX_ACCURACY_M, SIM_SPEED } from './config.ts';
import { angleDiff, bearing, haversine, offset, type LngLat } from './geo.ts';
import { handleFix, resetTrackerAnchor } from './tracker.ts';
import { useGame } from './store.ts';
import type { PlayerFix } from './types.ts';

export const player = {
  /** Posição desenhada (suavizada). */
  display: null as LngLat | null,
  /** Rumo desenhado em graus. */
  heading: 0,
  speed: 0,
  /** Metros andados (para cadência da animação). */
  odometer: 0,
  target: null as PlayerFix | null,
};

// ---------------------------------------------------------------------------
// GPS real
// ---------------------------------------------------------------------------
let watchId: number | null = null;
let lastGps: PlayerFix | null = null;

function startGps(): void {
  if (watchId != null) return;
  if (!('geolocation' in navigator)) {
    useGame.setState({ gps: 'unavailable' });
    return;
  }
  useGame.setState({ gps: 'searching' });
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const c = pos.coords;
      const fix: PlayerFix = {
        lng: c.longitude,
        lat: c.latitude,
        accuracy: c.accuracy,
        speed: c.speed ?? 0,
        heading: c.heading != null && !Number.isNaN(c.heading) ? c.heading : null,
        t: pos.timestamp || Date.now(),
      };
      if (lastGps) {
        const d = haversine(lastGps, fix);
        const dt = (fix.t - lastGps.t) / 1000;
        if (!c.speed && dt > 0) fix.speed = d / dt;
        if (fix.heading == null && d > 4) fix.heading = bearing(lastGps, fix);
      }
      lastGps = fix;
      useGame.setState({ gps: c.accuracy > MAX_ACCURACY_M ? 'weak' : 'ok' });
      setTarget(fix);
      handleFix(fix);
    },
    (err) => {
      useGame.setState({ gps: err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable' });
      if (err.code === err.PERMISSION_DENIED) stopGps();
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
  );
}

function stopGps(): void {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

function setTarget(fix: PlayerFix): void {
  player.target = fix;
  if (!player.display) {
    player.display = { lng: fix.lng, lat: fix.lat };
    if (fix.heading != null) player.heading = fix.heading;
  }
}

// ---------------------------------------------------------------------------
// Simulador
// ---------------------------------------------------------------------------
const SIM_KEY = 'desbrava:simpos';
const sim = {
  pos: null as LngLat | null,
  heading: 0,
  /** Entrada do joystick: x = direita, y = frente, magnitude 0..1. */
  input: { x: 0, y: 0 },
  keys: new Set<string>(),
  turbo: false,
  lastEmit: 0,
};

export function setSimInput(x: number, y: number): void {
  sim.input = { x, y };
}

function loadSimPos(): LngLat {
  const params = new URLSearchParams(location.search);
  const lat = Number(params.get('lat'));
  const lng = Number(params.get('lng'));
  if (lat && lng) return { lat, lng };
  try {
    const raw = localStorage.getItem(SIM_KEY);
    if (raw) {
      const p = JSON.parse(raw) as LngLat;
      if (typeof p.lat === 'number' && typeof p.lng === 'number') return p;
    }
  } catch {
    /* armazenamento indisponível */
  }
  return lastGps ? { lng: lastGps.lng, lat: lastGps.lat } : DEFAULT_CENTER;
}

function saveSimPos(): void {
  try {
    if (sim.pos) localStorage.setItem(SIM_KEY, JSON.stringify(sim.pos));
  } catch {
    /* ignora */
  }
}

/** Teleporta o jogador simulado (toque longo no mapa). */
export function simTeleport(p: LngLat): void {
  if (!useGame.getState().settings.simulator) return;
  sim.pos = { ...p };
  player.display = { ...p };
  resetTrackerAnchor();
  emitSimFix(performance.now(), true);
}

function emitSimFix(now: number, force = false): void {
  if (!sim.pos) return;
  if (!force && now - sim.lastEmit < 450) return;
  sim.lastEmit = now;
  const fix: PlayerFix = {
    lng: sim.pos.lng,
    lat: sim.pos.lat,
    accuracy: 5,
    speed: player.speed,
    heading: sim.heading,
    t: Date.now(),
  };
  player.target = fix;
  handleFix(fix);
}

function keyVector(): { x: number; y: number } {
  const k = sim.keys;
  const x = (k.has('ArrowRight') || k.has('d') ? 1 : 0) - (k.has('ArrowLeft') || k.has('a') ? 1 : 0);
  const y = (k.has('ArrowUp') || k.has('w') ? 1 : 0) - (k.has('ArrowDown') || k.has('s') ? 1 : 0);
  return { x, y };
}

function onKey(e: KeyboardEvent): void {
  if (!useGame.getState().settings.simulator) return;
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', 'Shift'].includes(key)) return;
  e.preventDefault();
  if (key === 'Shift') sim.turbo = e.type === 'keydown';
  else if (e.type === 'keydown') sim.keys.add(key);
  else sim.keys.delete(key);
}

/**
 * Avança o simulador. `steer` = modo gravar (câmera atrás): frente acelera, lados viram.
 * Fora dele, a direção do joystick é relativa à tela.
 */
function tickSim(dt: number, cameraBearing: number, steer: boolean): void {
  if (!sim.pos) {
    sim.pos = loadSimPos();
    player.display = { ...sim.pos };
    emitSimFix(performance.now(), true);
  }
  const kv = keyVector();
  const ix = Math.max(-1, Math.min(1, sim.input.x + kv.x));
  const iy = Math.max(-1, Math.min(1, sim.input.y + kv.y));
  const mag = Math.min(1, Math.hypot(ix, iy));
  const modality = useGame.getState().profile?.modality ?? 'bike';
  const top = SIM_SPEED[modality] * (sim.turbo ? 2 : 1);
  let speed = 0;
  if (steer) {
    sim.heading = (sim.heading + ix * 95 * dt + 360) % 360;
    speed = Math.max(0, iy) * top;
  } else if (mag > 0.15) {
    const target = (cameraBearing + (Math.atan2(ix, iy) * 180) / Math.PI + 360) % 360;
    sim.heading = (sim.heading + angleDiff(sim.heading, target) * Math.min(1, dt * 10) + 360) % 360;
    speed = mag * top;
  }
  // aceleração suave
  player.speed += (speed - player.speed) * Math.min(1, dt * 4);
  if (player.speed < 0.05) player.speed = 0;
  if (player.speed > 0) {
    const step = player.speed * dt;
    sim.pos = offset(sim.pos, step, sim.heading);
    player.odometer += step;
  }
  player.display = { ...sim.pos };
  player.heading = sim.heading;
  const now = performance.now();
  // parado, ainda emite um "batimento" para o tracker (ex.: atividade recém-iniciada)
  if (player.speed > 0 || now - sim.lastEmit > 2000) emitSimFix(now);
}

// ---------------------------------------------------------------------------
// Loop por quadro (chamado pelo motor do mapa)
// ---------------------------------------------------------------------------
export function tickPlayer(dtMs: number, cameraBearing: number, steer: boolean): void {
  const dt = Math.min(0.1, dtMs / 1000);
  if (useGame.getState().settings.simulator) {
    tickSim(dt, cameraBearing, steer);
    return;
  }
  const t = player.target;
  if (!t || !player.display) return;
  const k = 1 - Math.exp(-dt / 0.45);
  const before = player.display;
  player.display = { lng: before.lng + (t.lng - before.lng) * k, lat: before.lat + (t.lat - before.lat) * k };
  const moved = haversine(before, player.display);
  player.odometer += moved;
  player.speed += ((t.speed || moved / Math.max(dt, 0.001)) - player.speed) * Math.min(1, dt * 3);
  if (t.heading != null && t.speed > 0.8) {
    player.heading = (player.heading + angleDiff(player.heading, t.heading) * Math.min(1, dt * 3) + 360) % 360;
  }
}

/** Liga a fonte de posição certa conforme o modo simulador. */
export function syncLocationSource(): void {
  const simOn = useGame.getState().settings.simulator;
  if (simOn) {
    stopGps();
    useGame.setState({ gps: 'sim' });
    sim.pos = null; // recarrega posição salva no próximo tick
  } else {
    saveSimPos();
    startGps();
  }
}

export function initLocation(): void {
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', () => sim.keys.clear());
  setInterval(saveSimPos, 5000);
  const params = new URLSearchParams(location.search);
  if (params.get('sim') === '1' && !useGame.getState().settings.simulator) {
    useGame.getState().setSetting('simulator', true);
  }
  syncLocationSource();
  let prev = useGame.getState().settings.simulator;
  useGame.subscribe((s) => {
    if (s.settings.simulator !== prev) {
      prev = s.settings.simulator;
      syncLocationSource();
    }
  });
}
