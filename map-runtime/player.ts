// Posição exibida do jogador (suavizada) e física do simulador, rodando a 60 fps junto da câmera.
// Porte de `tickPlayer`/`tickSim` do jogo web original; aqui não há regra de jogo: os fixes vão para o host.
import { SIM_SPEED } from '../src/game/config.ts';
import { angleDiff, haversine, offset, type LngLat } from '../src/game/geo.ts';
import type { Modality, PlayerFix } from '../src/game/types.ts';

export const player = {
  /** Posição desenhada (suavizada). */
  display: null as LngLat | null,
  /** Rumo desenhado em graus. */
  heading: 0,
  speed: 0,
  /** Metros andados (para cadência da animação). */
  odometer: 0,
  /** Último fix do GPS real (alvo da suavização). */
  target: null as PlayerFix | null,
};

type SimFixSink = (fix: PlayerFix, teleport: boolean) => void;

const sim = {
  enabled: false,
  pos: null as LngLat | null,
  heading: 0,
  /** Joystick do host: x = direita, y = frente, magnitude 0..1. */
  input: { x: 0, y: 0, turbo: false },
  /** Teclado da própria página (web): WASD/setas + Shift. */
  keys: new Set<string>(),
  keyTurbo: false,
  lastEmit: 0,
  sink: null as SimFixSink | null,
};

export function onSimFix(fn: SimFixSink): void {
  sim.sink = fn;
}

export function isSimulating(): boolean {
  return sim.enabled;
}

/** Fix do GPS real: vira o alvo da suavização. */
export function setGpsTarget(fix: PlayerFix): void {
  player.target = fix;
  if (!player.display) {
    player.display = { lng: fix.lng, lat: fix.lat };
    if (fix.heading != null) player.heading = fix.heading;
  }
}

/**
 * Liga/desliga o simulador. `pos` só vale na hora de ligar (repetir a mensagem com o simulador já ligado
 * não puxa o jogador de volta); sem `pos`, começa onde o jogador está sendo desenhado (ou em `fallback`).
 */
export function setSimulator(enabled: boolean, pos: LngLat | null, fallback: LngLat): void {
  if (!enabled) {
    sim.enabled = false;
    sim.keys.clear();
    sim.keyTurbo = false;
    return;
  }
  if (sim.enabled) return;
  sim.enabled = true;
  sim.pos = pos ? { lng: pos.lng, lat: pos.lat } : player.display ? { ...player.display } : { ...fallback };
  sim.heading = player.heading;
  player.display = { ...sim.pos };
  emitSimFix(performance.now(), true);
}

export function setSimInput(x: number, y: number, turbo = false): void {
  const clamp = (v: number) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
  sim.input = { x: clamp(x), y: clamp(y), turbo };
}

/** Teleporta o jogador simulado (toque longo / botão direito). */
export function simTeleport(p: LngLat): boolean {
  if (!sim.enabled) return false;
  sim.pos = { lng: p.lng, lat: p.lat };
  player.display = { ...sim.pos };
  emitSimFix(performance.now(), true, true);
  return true;
}

function emitSimFix(now: number, force = false, teleport = false): void {
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
  sim.sink?.(fix, teleport);
}

// ---------------------------------------------------------------------------
// Teclado (web): só funciona quando a página do mapa tem o foco
// ---------------------------------------------------------------------------
const SIM_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', 'Shift'];

function onKey(e: KeyboardEvent): void {
  if (!sim.enabled) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (!SIM_KEYS.includes(key)) return;
  e.preventDefault();
  if (key === 'Shift') sim.keyTurbo = e.type === 'keydown';
  else if (e.type === 'keydown') sim.keys.add(key);
  else sim.keys.delete(key);
}

export function initKeyboard(): void {
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', () => {
    sim.keys.clear();
    sim.keyTurbo = false;
  });
}

function keyVector(): { x: number; y: number } {
  const k = sim.keys;
  const x = (k.has('ArrowRight') || k.has('d') ? 1 : 0) - (k.has('ArrowLeft') || k.has('a') ? 1 : 0);
  const y = (k.has('ArrowUp') || k.has('w') ? 1 : 0) - (k.has('ArrowDown') || k.has('s') ? 1 : 0);
  return { x, y };
}

/**
 * Avança o simulador. `steer` = modo gravar (câmera atrás): frente acelera, lados viram.
 * Fora dele, a direção do joystick é relativa à tela.
 */
function tickSim(dt: number, cameraBearing: number, steer: boolean, modality: Modality): void {
  if (!sim.pos) return;
  const kv = keyVector();
  const ix = Math.max(-1, Math.min(1, sim.input.x + kv.x));
  const iy = Math.max(-1, Math.min(1, sim.input.y + kv.y));
  const mag = Math.min(1, Math.hypot(ix, iy));
  const top = SIM_SPEED[modality] * (sim.input.turbo || sim.keyTurbo ? 2 : 1);
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

/** Avança um quadro: simulador (se ligado) ou suavização em direção ao último fix do GPS. */
export function tickPlayer(dtMs: number, cameraBearing: number, steer: boolean, modality: Modality): void {
  const dt = Math.min(0.1, Math.max(0, dtMs / 1000));
  if (sim.enabled) {
    tickSim(dt, cameraBearing, steer, modality);
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
