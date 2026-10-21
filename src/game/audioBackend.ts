// Celular: um player do expo-audio por som (criado na primeira vez e reaproveitado) e expo-haptics.
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import type { SfxName } from './sfxDefs.ts';
import type { HapticKind } from './audio.ts';

/** Volume dos efeitos: os WAVs são normalizados perto do máximo; isto os deixa no nível da música. */
const SFX_VOLUME = 0.6;

const SOURCES: Record<SfxName, number> = {
  coin: require('../../assets/sfx/coin.wav'),
  coinBig: require('../../assets/sfx/coinBig.wav'),
  gem: require('../../assets/sfx/gem.wav'),
  capture: require('../../assets/sfx/capture.wav'),
  levelUp: require('../../assets/sfx/levelUp.wav'),
  start: require('../../assets/sfx/start.wav'),
  pause: require('../../assets/sfx/pause.wav'),
  stop: require('../../assets/sfx/stop.wav'),
  click: require('../../assets/sfx/click.wav'),
  warn: require('../../assets/sfx/warn.wav'),
  city: require('../../assets/sfx/city.wav'),
};

const players = new Map<SfxName, AudioPlayer>();

function playerFor(name: SfxName): AudioPlayer {
  let p = players.get(name);
  if (!p) {
    p = createAudioPlayer(SOURCES[name], { updateInterval: 1000 });
    p.volume = SFX_VOLUME;
    players.set(name, p);
  }
  return p;
}

export const backend = {
  init(): void {
    // Mistura com o áudio de outros apps (música/podcast do ciclista continua tocando) e respeita
    // a chave de silencioso, como a versão web no iPhone.
    void setAudioModeAsync({
      interruptionMode: 'mixWithOthers',
      playsInSilentMode: false,
      shouldPlayInBackground: false,
      allowsRecording: false,
    }).catch((err: unknown) => console.warn('[audio] modo de áudio', err));
  },

  unlock(): void {
    /* no celular não há bloqueio de áudio */
  },

  play(name: SfxName): void {
    const p = playerFor(name);
    // volta ao início e toca de novo (duas moedas seguidas reiniciam o som)
    if (p.playing || p.currentTime > 0) {
      void p.seekTo(0).then(() => p.play(), () => p.play());
    } else {
      p.play();
    }
  },

  haptic(kind: HapticKind): void {
    const job =
      kind === 'light' ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      : kind === 'warning' ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
      : Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    void job.catch(() => undefined);
  },

  vibrate(pattern: number | number[]): void {
    const long = Array.isArray(pattern) ? pattern.length > 1 || (pattern[0] ?? 0) > 50 : pattern > 50;
    this.haptic(long ? 'success' : 'light');
  },
};
