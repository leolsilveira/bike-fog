// Exportação em lote (.zip de GPX) e importação em streaming (.zip do Strava ou .gpx).
// Atividades importadas revelam a névoa no mapa e entram no histórico/totais, mas NÃO dão XP/nível.
import { strToU8, zipSync } from 'fflate';
import { pickActivityFile, shareZip } from '../services/fileTransfer';
import { bumpCityCells, cityAtSync, ensureCityAt } from './cities.ts';
import { GAME_NAME, REVEAL_RADIUS_M } from './config.ts';
import { fog } from './fog.ts';
import { cellSizeM, formatArea, type LngLat } from './geo.ts';
import { buildGpx, gpxFileName } from './gpxFormat.ts';
import { parseGpx, streamGpxEntries, yieldUi } from './gpxImport.ts';
import { loadTrack, saveNow, saveTrack } from './persist.ts';
import { uid, useGame } from './store.ts';
import type { ActivitySummary } from './types.ts';

function isDuplicate(
  candidate: { startedAt: number; distanceM: number },
  list: { startedAt: number; distanceM: number }[],
): boolean {
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
    if (count % 10 === 0) await yieldUi();
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

export interface ImportProgress {
  percent: number;
  label: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  newCells: number;
  cancelled: boolean;
}

const SEG_SLICE = 160;

/**
 * Importa atividades de um .zip (ex.: Strava 200 MB+) ou .gpx em streaming,
 * sem travar a interface, reportando progresso e permitindo cancelamento.
 * Não altera XP/nível nem moedas/capturas.
 */
export async function importActivitiesFromFile(opts?: {
  onProgress?: (p: ImportProgress) => void;
  isCancelled?: () => boolean;
}): Promise<ImportResult | null> {
  const s0 = useGame.getState();
  const onProgress = opts?.onProgress;
  const isCancelled = opts?.isCancelled;

  let picked;
  try {
    picked = await pickActivityFile();
  } catch (err) {
    console.warn('[import]', err);
    s0.toast('Não foi possível abrir o seletor de arquivos.', 'warn');
    return null;
  }
  if (!picked) return null;

  onProgress?.({ percent: 2, label: `Abrindo ${picked.name}…` });
  await yieldUi();

  const fallbackModality = s0.profile?.modality ?? 'bike';
  const existing = s0.activities;
  const newSummaries: ActivitySummary[] = [];
  const allAddedCells: number[] = [];
  const totalByCity: Record<string, number> = {};
  let skipped = 0;
  let addDist = 0;
  let addMoving = 0;
  let samplePt: LngLat | null = null;
  let readPct = 0;

  let streamRes: { found: number; cancelled: boolean };
  try {
    streamRes = await streamGpxEntries(picked, {
      isCancelled,
      onReadProgress: (bytesRead, totalBytes) => {
        readPct = totalBytes > 0 ? Math.min(95, Math.round((bytesRead / totalBytes) * 95)) : 50;
        const done = newSummaries.length;
        const suffix = done > 0 ? ` · ${done} ${done === 1 ? 'atividade' : 'atividades'}` : '';
        onProgress?.({ percent: Math.max(2, readPct), label: `Lendo arquivo… ${readPct}%${suffix}` });
      },
      onEntry: async ({ xml }) => {
        const parsed = parseGpx(xml, fallbackModality);
        if (!parsed) {
          skipped++;
          return;
        }
        if (isDuplicate(parsed, existing) || isDuplicate(parsed, newSummaries)) {
          skipped++;
          return;
        }

        // Revela a névoa desta atividade em fatias curtas para manter a UI fluida.
        let activityCells = 0;
        const activityCitySet = new Set<string>();
        for (let i = 0; i < parsed.segments.length; i += SEG_SLICE) {
          if (isCancelled?.()) return;
          const slice = parsed.segments.slice(i, i + SEG_SLICE);
          const { added, byCity } = fog.revealSegments(slice, REVEAL_RADIUS_M, cityAtSync, false);
          for (const k of added) allAddedCells.push(k);
          activityCells += added.length;
          for (const [cid, n] of Object.entries(byCity)) {
            totalByCity[cid] = (totalByCity[cid] ?? 0) + n;
            activityCitySet.add(cid);
          }
          if (i + SEG_SLICE < parsed.segments.length) await yieldUi();
        }

        const id = uid('imp');
        await saveTrack(id, parsed.track);

        if (!samplePt && parsed.track.length >= 6) {
          const midIdx = Math.floor(parsed.track.length / 6) * 3;
          samplePt = { lng: parsed.track[midIdx], lat: parsed.track[midIdx + 1] };
        }

        addDist += parsed.distanceM;
        addMoving += parsed.movingS;
        newSummaries.push({
          id,
          modality: parsed.modality,
          startedAt: parsed.startedAt,
          endedAt: parsed.endedAt,
          elapsedS: parsed.elapsedS,
          movingS: parsed.movingS,
          distanceM: parsed.distanceM,
          maxSpeed: parsed.maxSpeed,
          coinsValue: 0,
          coinsCount: 0,
          captures: [],
          newCells: activityCells,
          xp: 0,
          cityIds: [...activityCitySet],
        });

        const n = newSummaries.length;
        onProgress?.({
          percent: Math.max(5, readPct),
          label: `Importando… ${n} ${n === 1 ? 'atividade' : 'atividades'}`,
        });
      },
    });
  } catch (err) {
    console.warn('[import] falha ao abrir arquivo', err);
    s0.toast('Arquivo inválido. Selecione um .zip do Strava ou um .gpx.', 'warn');
    return null;
  }

  if (streamRes.cancelled && newSummaries.length === 0) {
    useGame.getState().toast('Importação cancelada.', 'info');
    return { imported: 0, skipped, newCells: 0, cancelled: true };
  }

  if (streamRes.found === 0) {
    s0.toast('Nenhum arquivo GPX encontrado nesse arquivo.', 'warn');
    return { imported: 0, skipped: 0, newCells: 0, cancelled: false };
  }

  if (!newSummaries.length) {
    s0.toast(
      skipped > 0 ? 'Essas atividades já foram importadas ou não têm pontos GPS.' : 'Nenhuma atividade GPX válida encontrada.',
      'info',
    );
    return { imported: 0, skipped, newCells: 0, cancelled: false };
  }

  onProgress?.({ percent: 97, label: 'Atualizando mapa e salvando…' });
  await yieldUi();

  // Notifica o mapa uma única vez com todas as células novas.
  fog.notifyAdded(allAddedCells);
  for (const [cityId, n] of Object.entries(totalByCity)) bumpCityCells(cityId, n);

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
      cells: st.totals.cells + allAddedCells.length,
    },
  });

  await saveNow();
  onProgress?.({ percent: 100, label: 'Concluído!' });

  const firstPt = samplePt as LngLat | null;
  if (firstPt && !cityAtSync(firstPt)) void ensureCityAt(firstPt);

  const area = allAddedCells.length * cellSizeM(firstPt?.lat ?? -23.5) ** 2;
  const countLabel = `${newSummaries.length} ${newSummaries.length === 1 ? 'atividade importada' : 'atividades importadas'}`;
  const areaLabel = allAddedCells.length > 0 ? ` (+${formatArea(area)} revelados)` : '';
  const cancelSuffix = streamRes.cancelled ? ' (interrompido)' : '';
  useGame.getState().toast(`${countLabel}${areaLabel}${cancelSuffix}`, 'info');

  return { imported: newSummaries.length, skipped, newCells: allAddedCells.length, cancelled: streamRes.cancelled };
}
