// Exportação em lote (.zip de GPX) e importação de atividades (.zip do Strava ou .gpx).
// Atividades importadas revelam a névoa no mapa e entram no histórico/totais, mas NÃO dão XP/nível.
import { strToU8, zipSync } from 'fflate';
import { pickActivityFile, shareZip } from '../services/fileTransfer';
import { bumpCityCells, cityAtSync, ensureCityAt } from './cities.ts';
import { GAME_NAME, REVEAL_RADIUS_M } from './config.ts';
import { fog } from './fog.ts';
import { cellSizeM, formatArea, type LngLat } from './geo.ts';
import { buildGpx, gpxFileName } from './gpxFormat.ts';
import { extractGpxFiles, parseGpx, type ParsedGpxActivity } from './gpxImport.ts';
import { loadTrack, saveNow, saveTrack } from './persist.ts';
import { uid, useGame } from './store.ts';
import type { ActivitySummary } from './types.ts';

function isDuplicate(candidate: { startedAt: number; distanceM: number }, list: { startedAt: number; distanceM: number }[]): boolean {
  return list.some(
    (a) => Math.abs(a.startedAt - candidate.startedAt) < 5000 && Math.abs(a.distanceM - candidate.distanceM) < 10,
  );
}

/** Exporta todas as atividades com trilha salva em um único arquivo .zip de GPX. */
export async function exportAllActivities(): Promise<number> {
  const s = useGame.getState();
  const files: Record<string, Uint8Array> = {};
  const usedNames = new Set<string>();
  let count = 0;

  for (const activity of s.activities) {
    const track = await loadTrack(activity.id);
    if (!track || track.length < 6) continue;
    let name = gpxFileName(activity);
    if (usedNames.has(name)) {
      const base = name.replace(/\.gpx$/i, '');
      let n = 2;
      while (usedNames.has(`${base}-${n}.gpx`)) n++;
      name = `${base}-${n}.gpx`;
    }
    usedNames.add(name);
    files[`activities/${name}`] = strToU8(buildGpx(activity, track));
    count++;
  }

  if (count === 0) {
    s.toast('Nenhuma atividade com trilha salva para exportar.', 'warn');
    return 0;
  }

  try {
    const zipBytes = zipSync(files, { level: 6 });
    const stamp = new Date().toISOString().slice(0, 10);
    await shareZip(`${GAME_NAME.toLowerCase()}-atividades-${stamp}.zip`, zipBytes);
    s.toast(`${count} ${count === 1 ? 'atividade exportada' : 'atividades exportadas'}!`, 'info');
    return count;
  } catch (err) {
    console.warn('[export-all]', err);
    s.toast('Não foi possível exportar as atividades.', 'warn');
    return 0;
  }
}

export interface ImportResult {
  imported: number;
  skipped: number;
  newCells: number;
}

/** Importa atividades de um .zip (ex.: Strava) ou .gpx, revelando a névoa sem alterar XP/nível. */
export async function importActivitiesFromFile(): Promise<ImportResult | null> {
  const s0 = useGame.getState();
  let picked;
  try {
    picked = await pickActivityFile();
  } catch (err) {
    console.warn('[import]', err);
    s0.toast('Não foi possível abrir o seletor de arquivos.', 'warn');
    return null;
  }
  if (!picked) return null;

  let gpxFiles: { name: string; xml: string }[];
  try {
    gpxFiles = extractGpxFiles(picked.name, picked.bytes);
  } catch (err) {
    console.warn('[import] falha ao abrir arquivo', err);
    s0.toast('Arquivo inválido. Selecione um .zip do Strava ou um .gpx.', 'warn');
    return null;
  }

  if (!gpxFiles.length) {
    s0.toast('Nenhum arquivo GPX encontrado nesse arquivo.', 'warn');
    return { imported: 0, skipped: 0, newCells: 0 };
  }

  const fallbackModality = s0.profile?.modality ?? 'bike';
  const existing = s0.activities;
  const accepted: ParsedGpxActivity[] = [];
  let skipped = 0;

  for (const entry of gpxFiles) {
    const parsed = parseGpx(entry.xml, fallbackModality);
    if (!parsed) {
      skipped++;
      continue;
    }
    if (isDuplicate(parsed, existing) || isDuplicate(parsed, accepted)) {
      skipped++;
      continue;
    }
    accepted.push(parsed);
  }

  if (!accepted.length) {
    s0.toast(
      skipped > 0 ? 'Essas atividades já foram importadas ou não têm pontos GPS.' : 'Nenhuma atividade GPX válida encontrada.',
      'info',
    );
    return { imported: 0, skipped, newCells: 0 };
  }

  // Revela toda a névoa em lote (uma única notificação para o mapa)
  const allSegments: [LngLat, LngLat][] = [];
  for (const p of accepted) {
    for (const seg of p.segments) allSegments.push(seg);
  }
  const { added, byCity } = fog.revealSegments(allSegments, REVEAL_RADIUS_M, cityAtSync);
  for (const [cityId, n] of Object.entries(byCity)) bumpCityCells(cityId, n);

  const cityIdsFound = Object.keys(byCity);
  const newSummaries: ActivitySummary[] = [];
  let addDist = 0;
  let addMoving = 0;

  for (const p of accepted) {
    const id = uid('imp');
    await saveTrack(id, p.track);
    addDist += p.distanceM;
    addMoving += p.movingS;
    newSummaries.push({
      id,
      modality: p.modality,
      startedAt: p.startedAt,
      endedAt: p.endedAt,
      elapsedS: p.elapsedS,
      movingS: p.movingS,
      distanceM: p.distanceM,
      maxSpeed: p.maxSpeed,
      coinsValue: 0,
      coinsCount: 0,
      captures: [],
      newCells: 0,
      xp: 0,
      cityIds: cityIdsFound,
    });
  }

  // Atualiza histórico e totais sem mexer em XP/nível nem moedas/capturas.
  const st = useGame.getState();
  const merged = [...newSummaries, ...st.activities]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 200);
  useGame.setState({
    activities: merged,
    totals: {
      ...st.totals,
      distanceM: st.totals.distanceM + addDist,
      movingS: st.totals.movingS + addMoving,
      activities: st.totals.activities + newSummaries.length,
      cells: st.totals.cells + added.length,
    },
  });

  await saveNow();

  // Se alguma atividade caiu fora das cidades já conhecidas, consulta Nominatim para o ponto médio da primeira.
  const firstTrack = accepted[0].track;
  const midIdx = Math.floor(firstTrack.length / 6) * 3;
  const samplePt: LngLat = { lng: firstTrack[midIdx], lat: firstTrack[midIdx + 1] };
  if (!cityAtSync(samplePt)) void ensureCityAt(samplePt);

  const area = added.length * cellSizeM(samplePt.lat) ** 2;
  const countLabel = `${newSummaries.length} ${newSummaries.length === 1 ? 'atividade importada' : 'atividades importadas'}`;
  const areaLabel = added.length > 0 ? ` (+${formatArea(area)} revelados)` : '';
  useGame.getState().toast(`${countLabel}${areaLabel}`, 'info');

  return { imported: newSummaries.length, skipped, newCells: added.length };
}
