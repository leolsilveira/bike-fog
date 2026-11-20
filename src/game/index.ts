// Inicialização: carrega o save, liga GPS/simulador, tiles, autosave e reações a mudanças de atividade.
import { hydrate, startAutosave } from './persist.ts';
import { loadCityPolygons } from './cities.ts';
import { checkAndGrantAchievements, evaluateAchievements } from './achievements.ts';
import { initLocation, player } from './location.ts';
import { initRouteTracking } from './route.ts';
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
    // Credita retroativamente conquistas de saves anteriores a esta versão.
    if (useGame.getState().profile) checkAndGrantAchievements({ batchToast: true });

    // POIs e ruas vêm dos vector tiles em volta do jogador
    pois.subscribe(() => useGame.setState({ poiRev: useGame.getState().poiRev + 1 }));
    useGame.subscribe((s, prev) => {
      if (s.fix && s.fix !== prev.fix) updateTiles(s.fix);
    });
    const fix = useGame.getState().fix;
    if (fix) updateTiles(fix);

    initRouteTracking();
    initLocation();

    let prevId = useGame.getState().live?.id ?? null;
    let prevStatus = useGame.getState().live?.status ?? null;
    let prevActCount = useGame.getState().activities.length;
    useGame.subscribe((s) => {
      const id = s.live?.id ?? null;
      const status = s.live?.status ?? null;
      if (id !== prevId || status !== prevStatus) {
        const finished = prevId !== null && id === null && s.activities.length > prevActCount;
        prevId = id;
        prevStatus = status;
        prevActCount = s.activities.length;
        onActivityChange();
        if (finished) checkAndGrantAchievements();
      } else if (s.activities.length !== prevActCount) {
        prevActCount = s.activities.length;
      }
    });

    const dev = typeof __DEV__ !== 'undefined' && __DEV__;
    if (dev || launchParam('debug') !== null) {
      (globalThis as Record<string, unknown>).__desbrava = {
        useGame,
        fog,
        pois,
        player,
        mapHost,
        achievements: { checkAndGrantAchievements, evaluateAchievements },
      };
    }
  })();
  return started;
}

// Uma posição de segundo plano chegou com o jogo parado (o sistema abriu o app sem a interface).
setBackgroundBoot(() => initGame());
