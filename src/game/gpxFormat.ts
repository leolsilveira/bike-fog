// Monta o GPX de uma atividade (mesmo formato e nome de arquivo da versão web). Puro.
import { GAME_NAME } from './config.ts';
import type { ActivitySummary } from './types.ts';

/** `track` achatado [lng, lat, t, ...]. */
export function buildGpx(a: ActivitySummary, track: ArrayLike<number>): string {
  const pts: string[] = [];
  for (let i = 0; i + 2 < track.length; i += 3) {
    const time = new Date(track[i + 2]).toISOString();
    pts.push(`<trkpt lat="${track[i + 1].toFixed(7)}" lon="${track[i].toFixed(7)}"><time>${time}</time></trkpt>`);
  }
  const type = a.modality === 'bike' ? 'cycling' : 'running';
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="${GAME_NAME}" xmlns="http://www.topografix.com/GPX/1/1">` +
    `<trk><name>${GAME_NAME} ${new Date(a.startedAt).toLocaleString('pt-BR')}</name><type>${type}</type><trkseg>` +
    pts.join('') +
    `</trkseg></trk></gpx>`
  );
}

export function gpxFileName(a: ActivitySummary): string {
  return `${GAME_NAME.toLowerCase()}-${new Date(a.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.gpx`;
}
