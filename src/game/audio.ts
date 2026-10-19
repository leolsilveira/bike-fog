// Efeitos sonoros chiptune sintetizados (onda quadrada/triangular), sem arquivos de áudio.
import { useGame } from './store.ts';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function audio(): AudioContext | null {
  if (!useGame.getState().settings.sound) return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.18;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** Navegadores só liberam áudio após um gesto do usuário. */
export function unlockAudio(): void {
  audio();
}

const NOTE: Record<string, number> = {
  C4: 261.63, E4: 329.63, G4: 392.0, A4: 440.0, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0, B5: 987.77,
  C6: 1046.5, D6: 1174.66, E6: 1318.51, G6: 1567.98, C7: 2093.0,
};

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'square', vol = 1): void {
  const c = ctx!;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(vol, start + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g).connect(master!);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

function seq(notes: (string | number)[], step: number, dur: number, type: OscillatorType = 'square', vol = 1): void {
  const c = audio();
  if (!c) return;
  const t0 = c.currentTime + 0.01;
  notes.forEach((n, i) => {
    const f = typeof n === 'number' ? n : NOTE[n];
    if (f) tone(f, t0 + i * step, dur, type, vol);
  });
}

export const sfx = {
  coin: () => seq(['B5', 'E6'], 0.07, 0.18),
  coinBig: () => seq(['E6', 'G6', 'C7'], 0.06, 0.16),
  gem: () => {
    seq(['C6', 'E6', 'G6', 'C7'], 0.05, 0.14, 'square', 0.8);
    seq(['C5', 'E5', 'G5', 'C6'], 0.05, 0.2, 'triangle', 0.9);
  },
  capture: () => {
    seq(['C5', 'E5', 'G5', 'C6', 'G5', 'C6'], 0.09, 0.16, 'square', 0.7);
    seq(['C4', 'G4', 'C5', 'E5'], 0.135, 0.25, 'triangle', 1);
  },
  levelUp: () => {
    seq(['G4', 'C5', 'E5', 'G5', 'E5', 'G5', 'C6'], 0.08, 0.15, 'square', 0.7);
    seq(['C4', 'E4', 'G4', 'C5'], 0.14, 0.3, 'triangle', 1);
  },
  start: () => seq(['C5', 'G5'], 0.1, 0.14),
  pause: () => seq(['G5', 'C5'], 0.1, 0.12),
  stop: () => seq(['G5', 'E5', 'C5'], 0.09, 0.14),
  click: () => seq(['A5'], 0.01, 0.04, 'square', 0.4),
  warn: () => seq([220, 196], 0.12, 0.16, 'square', 0.6),
  city: () => seq(['D5', 'F5', 'A5', 'D6'], 0.08, 0.16, 'triangle', 1),
};

export function vibrate(pattern: number | number[]): void {
  if (!useGame.getState().settings.haptics) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* sem suporte */
  }
}
