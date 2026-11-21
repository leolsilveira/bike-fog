// Web: síntese chiptune em WebAudio (onda quadrada/triangular), como na versão original, e Vibration API.
import { ATTACK_S, MASTER_GAIN, RELEASE_TAIL_S, SFX_DEFS, START_DELAY_S, noteFreq, type SfxName } from './sfxDefs.ts';
import type { HapticKind } from './audio.ts';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let unlockInstalled = false;

function audio(): AudioContext | null {
  if (!ctx) {
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tone(c: AudioContext, freq: number, start: number, dur: number, type: OscillatorType, vol: number): void {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(vol, start + ATTACK_S);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g).connect(master!);
  osc.start(start);
  osc.stop(start + dur + RELEASE_TAIL_S);
}

export const backend = {
  init(): void {
    if (unlockInstalled || typeof window === 'undefined') return;
    unlockInstalled = true;
    const unlock = () => {
      backend.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  },

  unlock(): void {
    audio();
  },

  play(name: SfxName): void {
    const c = audio();
    if (!c) return;
    const t0 = c.currentTime + START_DELAY_S;
    for (const s of SFX_DEFS[name]) {
      s.notes.forEach((n, i) => {
        const f = noteFreq(n);
        if (f) tone(c, f, t0 + i * s.step, s.dur, s.type ?? 'square', s.vol ?? 1);
      });
    }
  },

  haptic(kind: HapticKind): void {
    this.vibrate(kind === 'light' ? 30 : kind === 'warning' ? [80, 60, 80] : [60, 40, 120]);
  },

  vibrate(pattern: number | number[]): void {
    navigator.vibrate?.(pattern);
  },
};
