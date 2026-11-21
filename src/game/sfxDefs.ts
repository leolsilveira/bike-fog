// Definição dos efeitos sonoros chiptune (notas, passos, durações, ondas). Fonte única para a síntese
// WebAudio da web e para o script que gera os WAVs do celular (scripts/export-sfx.ts).

export type Wave = 'square' | 'triangle';

export interface SfxSeq {
  /** Nome da nota (tabela NOTE) ou frequência em Hz. */
  notes: (string | number)[];
  /** Intervalo entre o início das notas (s). */
  step: number;
  /** Duração de cada nota (s). */
  dur: number;
  type?: Wave;
  vol?: number;
}

export type SfxName =
  | 'coin' | 'coinBig' | 'gem' | 'capture' | 'levelUp' | 'start' | 'pause' | 'stop' | 'click' | 'warn' | 'city';

/** Ganho final da mistura na versão web. */
export const MASTER_GAIN = 0.18;
/** Ataque do envelope (s): sobe exponencialmente até `vol` e depois cai até ~0 no fim da nota. */
export const ATTACK_S = 0.008;
/** O oscilador ainda soa este tanto depois do fim do envelope (no piso de 0,0001). */
export const RELEASE_TAIL_S = 0.02;
/** Silêncio inicial antes da primeira nota. */
export const START_DELAY_S = 0.01;

export const NOTE: Record<string, number> = {
  C4: 261.63, E4: 329.63, G4: 392.0, A4: 440.0, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0, B5: 987.77,
  C6: 1046.5, D6: 1174.66, E6: 1318.51, G6: 1567.98, C7: 2093.0,
};

/** Cada som é uma ou mais sequências que tocam juntas (sobrepostas). */
export const SFX_DEFS: Record<SfxName, SfxSeq[]> = {
  coin: [{ notes: ['B5', 'E6'], step: 0.07, dur: 0.18 }],
  coinBig: [{ notes: ['E6', 'G6', 'C7'], step: 0.06, dur: 0.16 }],
  gem: [
    { notes: ['C6', 'E6', 'G6', 'C7'], step: 0.05, dur: 0.14, type: 'square', vol: 0.8 },
    { notes: ['C5', 'E5', 'G5', 'C6'], step: 0.05, dur: 0.2, type: 'triangle', vol: 0.9 },
  ],
  capture: [
    { notes: ['C5', 'E5', 'G5', 'C6', 'G5', 'C6'], step: 0.09, dur: 0.16, type: 'square', vol: 0.7 },
    { notes: ['C4', 'G4', 'C5', 'E5'], step: 0.135, dur: 0.25, type: 'triangle', vol: 1 },
  ],
  levelUp: [
    { notes: ['G4', 'C5', 'E5', 'G5', 'E5', 'G5', 'C6'], step: 0.08, dur: 0.15, type: 'square', vol: 0.7 },
    { notes: ['C4', 'E4', 'G4', 'C5'], step: 0.14, dur: 0.3, type: 'triangle', vol: 1 },
  ],
  start: [{ notes: ['C5', 'G5'], step: 0.1, dur: 0.14 }],
  pause: [{ notes: ['G5', 'C5'], step: 0.1, dur: 0.12 }],
  stop: [{ notes: ['G5', 'E5', 'C5'], step: 0.09, dur: 0.14 }],
  click: [{ notes: ['A5'], step: 0.01, dur: 0.04, type: 'square', vol: 0.4 }],
  warn: [{ notes: [220, 196], step: 0.12, dur: 0.16, type: 'square', vol: 0.6 }],
  city: [{ notes: ['D5', 'F5', 'A5', 'D6'], step: 0.08, dur: 0.16, type: 'triangle', vol: 1 }],
};

export const SFX_NAMES = Object.keys(SFX_DEFS) as SfxName[];

export function noteFreq(n: string | number): number {
  return typeof n === 'number' ? n : (NOTE[n] ?? 0);
}
