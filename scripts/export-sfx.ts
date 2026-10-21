// Gera assets/sfx/<nome>.wav a partir das definições de src/game/sfxDefs.ts, imitando a síntese WebAudio
// da versão web: osciladores quadrado/triangular limitados em banda (como os do navegador), envelope
// exponencial (0,0001 → vol em 8 ms → 0,0001 no fim da nota), sequências sobrepostas e ganho master.
// Uso: node scripts/export-sfx.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ATTACK_S, MASTER_GAIN, RELEASE_TAIL_S, SFX_DEFS, SFX_NAMES, START_DELAY_S, noteFreq, type SfxName, type Wave,
} from '../src/game/sfxDefs.ts';

const RATE = 44100;
/** Pico final do som mais alto (-1 dBFS). Todos usam o mesmo fator, então o volume relativo é o do original. */
const PEAK = 0.89;
const FLOOR = 0.0001;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'assets', 'sfx');

/**
 * Uma volta da onda limitada em banda (só harmônicos abaixo de Nyquist), normalizada para pico 1,
 * como o navegador faz com as PeriodicWave padrão.
 */
const tables = new Map<string, Float64Array>();
const TABLE_SIZE = 4096;

function waveTable(type: Wave, freq: number): Float64Array {
  const key = `${type}:${freq}`;
  const cached = tables.get(key);
  if (cached) return cached;
  const t = new Float64Array(TABLE_SIZE);
  const maxK = Math.floor(RATE / 2 / freq);
  for (let k = 1; k <= maxK; k += 2) {
    // quadrada: 4/(kπ); triangular: 8/(kπ)² com sinal alternado
    const amp = type === 'square' ? 4 / (k * Math.PI) : ((k % 4 === 1 ? 1 : -1) * 8) / (k * Math.PI) ** 2;
    for (let i = 0; i < TABLE_SIZE; i++) t[i] += amp * Math.sin((2 * Math.PI * k * i) / TABLE_SIZE);
  }
  let peak = 0;
  for (const v of t) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < TABLE_SIZE; i++) t[i] /= peak || 1;
  tables.set(key, t);
  return t;
}

/** Envelope do GainNode: setValueAtTime(0,0001) + duas rampas exponenciais. */
function envelope(t: number, dur: number, vol: number): number {
  if (t < 0) return 0;
  if (t < ATTACK_S) return FLOOR * (vol / FLOOR) ** (t / ATTACK_S);
  if (t < dur) return vol * (FLOOR / vol) ** ((t - ATTACK_S) / (dur - ATTACK_S));
  return FLOOR;
}

function render(name: SfxName): Float64Array {
  const tones: { freq: number; start: number; dur: number; type: Wave; vol: number }[] = [];
  for (const s of SFX_DEFS[name]) {
    s.notes.forEach((n, i) => {
      const freq = noteFreq(n);
      if (!freq) return;
      tones.push({ freq, start: START_DELAY_S + i * s.step, dur: s.dur, type: s.type ?? 'square', vol: s.vol ?? 1 });
    });
  }
  const end = Math.max(...tones.map((t) => t.start + t.dur + RELEASE_TAIL_S));
  const out = new Float64Array(Math.ceil(end * RATE));
  for (const tone of tones) {
    const table = waveTable(tone.type, tone.freq);
    const i0 = Math.floor(tone.start * RATE);
    const i1 = Math.min(out.length, Math.ceil((tone.start + tone.dur + RELEASE_TAIL_S) * RATE));
    for (let i = i0; i < i1; i++) {
      const t = i / RATE - tone.start;
      if (t < 0) continue;
      // oscilador começa em fase 0, como o OscillatorNode
      const pos = ((t * tone.freq) % 1) * TABLE_SIZE;
      const j = Math.floor(pos);
      const v = table[j] + (table[(j + 1) % TABLE_SIZE] - table[j]) * (pos - j);
      out[i] += v * envelope(t, tone.dur, tone.vol) * MASTER_GAIN;
    }
  }
  return out;
}

function wav(samples: Float64Array, gain: number): Buffer {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] * gain));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

const rendered = SFX_NAMES.map((name) => ({ name, samples: render(name) }));
let loudest = 0;
for (const r of rendered) for (const v of r.samples) loudest = Math.max(loudest, Math.abs(v));
const gain = PEAK / loudest;

mkdirSync(outDir, { recursive: true });
for (const { name, samples } of rendered) {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v * gain));
  const file = join(outDir, `${name}.wav`);
  writeFileSync(file, wav(samples, gain));
  const secs = (samples.length / RATE).toFixed(3);
  console.log(`${name.padEnd(8)} ${secs} s  pico ${peak.toFixed(3)}  → assets/sfx/${name}.wav`);
}
console.log(`ganho de normalização: ${gain.toFixed(3)} (pico original ${loudest.toFixed(3)})`);
