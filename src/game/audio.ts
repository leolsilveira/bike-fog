// Efeitos sonoros e vibração. Este módulo é o mesmo em todas as plataformas (pode ser importado com
// ou sem extensão); quem toca de fato é `audioBackend` (WAVs + expo-haptics no celular, WebAudio na web).
import { useGame } from './store.ts';
import { backend } from './audioBackend';
import type { SfxName } from './sfxDefs.ts';

export type HapticKind = 'light' | 'success' | 'warning';

function play(name: SfxName): void {
  if (!useGame.getState().settings.sound) return;
  try {
    backend.play(name);
  } catch (err) {
    console.warn('[audio]', name, err);
  }
}

export const sfx = {
  coin: () => play('coin'),
  coinBig: () => play('coinBig'),
  gem: () => play('gem'),
  capture: () => play('capture'),
  levelUp: () => play('levelUp'),
  start: () => play('start'),
  pause: () => play('pause'),
  stop: () => play('stop'),
  click: () => play('click'),
  warn: () => play('warn'),
  city: () => play('city'),
};

/** Prepara o áudio (modo de mistura no celular; na web, libera o áudio no primeiro toque). */
export function initAudio(): void {
  try {
    backend.init();
  } catch (err) {
    console.warn('[audio] init', err);
  }
}

/** Navegadores só liberam áudio após um gesto do usuário. No celular não faz nada. */
export function unlockAudio(): void {
  if (!useGame.getState().settings.sound) return;
  backend.unlock();
}

/** Retorno tátil por tipo de evento. */
export function haptic(kind: HapticKind): void {
  if (!useGame.getState().settings.haptics) return;
  try {
    backend.haptic(kind);
  } catch {
    /* sem suporte */
  }
}

/**
 * Vibração no formato da Vibration API (ms ou padrão). No celular vira um retorno tátil:
 * toque curto = impacto leve; padrões e toques longos (captura) = sucesso.
 */
export function vibrate(pattern: number | number[]): void {
  if (!useGame.getState().settings.haptics) return;
  try {
    backend.vibrate(pattern);
  } catch {
    /* sem suporte */
  }
}
