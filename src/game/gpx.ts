// Exporta a trilha de uma atividade em GPX (Strava, Komoot...). Pode ser importado com ou sem extensão;
// quem entrega o arquivo é `gpxShare` (folha de compartilhar no celular, download na web).
import { loadTrack } from './persist.ts';
import { useGame } from './store.ts';
import { buildGpx, gpxFileName } from './gpxFormat.ts';
import { shareGpx } from './gpxShare';
import type { ActivitySummary } from './types.ts';

export async function exportGpx(activity: ActivitySummary): Promise<void> {
  const track = await loadTrack(activity.id);
  if (!track || track.length < 6) {
    useGame.getState().toast('Esta atividade não tem trilha salva.', 'warn');
    return;
  }
  try {
    await shareGpx(gpxFileName(activity), buildGpx(activity, track));
  } catch (err) {
    console.warn('[gpx]', err);
    useGame.getState().toast('Não foi possível exportar o GPX.', 'warn');
  }
}
