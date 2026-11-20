// Inicialização: carrega o save, liga GPS/simulador, tiles, autosave e reações a mudanças de atividade.
import { hydrate, startAutosave } from './persist.ts';
import { loadCityPolygons } from './cities.ts';
import { initLocation, player } from './location.ts';
import { finishAndSaveTrack, onActivityChange, restoreLiveTrack } from './tracker.ts';
import { initAudio } from './audio.ts';
import { updateTiles } from './tiles.ts';
import { hasPendingBackgroundLocations, setBackgroundBoot } from './bgTask';
import { fog } from './fog.ts';
import { pois } from './pois.ts';
import { useGame } from './store.ts';
import { mapHost } from '../bridge/mapHost.ts';
import { launchParam } from '../services/launch';

let started: Promise<void> | null = null;

export function initGame(): Promise<void> {
  if (started) return started;
  started = (async () => {
    await hydrate(hasPendingBackgroundLocations());
    await loadCityPolygons();
    await restoreLiveTrack();
    startAutosave(() => void finishAndSaveTrack());
    initAudio();

    // POIs e ruas vêm dos vector tiles em volta do jogador
    pois.subscribe(() => useGame.setState({ poiRev: useGame.getState().poiRev + 1 }));
    useGame.subscribe((s, prev) => {
      if (s.fix && s.fix !== prev.fix) updateTiles(s.fix);
    });
    const fix = useGame.getState().fix;
    if (fix) updateTiles(fix);

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

    const dev = typeof __DEV__ !== 'undefined' && __DEV__;
    if (dev || launchParam('debug') !== null) {
      (globalThis as Record<string, unknown>).__desbrava = { useGame, fog, pois, player, mapHost };
    }
  })();
  return started;
}

// Uma posição de segundo plano chegou com o jogo parado (o sistema abriu o app sem a interface).
setBackgroundBoot(() => initGame());
