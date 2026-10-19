// Inicialização: carrega o save, liga GPS/simulador, autosave e reações a mudanças de atividade.
import { hydrate, startAutosave } from './persist.ts';
import { loadCityPolygons } from './cities.ts';
import { initLocation } from './location.ts';
import { onActivityChange, restoreLiveTrack } from './tracker.ts';
import { unlockAudio } from './audio.ts';
import { useGame } from './store.ts';

let started: Promise<void> | null = null;

export function initGame(): Promise<void> {
  if (started) return started;
  started = (async () => {
    await hydrate();
    await loadCityPolygons();
    await restoreLiveTrack();
    startAutosave();
    initLocation();

    let prevId = useGame.getState().live?.id ?? null;
    let prevStatus = useGame.getState().live?.status ?? null;
    useGame.subscribe((s) => {
      const id = s.live?.id ?? null;
      const status = s.live?.status ?? null;
      if (id !== prevId || status !== prevStatus) {
        prevId = id;
        prevStatus = status;
        onActivityChange();
      }
    });

    const unlock = () => {
      unlockAudio();
      window.removeEventListener('pointerdown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
  })();
  return started;
}
