// Extração em streaming de arquivos GPX (direto, .gpx.gz ou .zip do Strava) e parser GPX puro (sem DOMParser).
import { gunzipSync, strFromU8, Unzip, UnzipInflate, UnzipPassThrough, unzipSync } from 'fflate';
import { haversine, type LngLat } from './geo.ts';
import type { Modality } from './types.ts';

export interface ParsedGpxActivity {
  modality: Modality;
  startedAt: number;
  endedAt: number;
  elapsedS: number;
  movingS: number;
  distanceM: number;
  maxSpeed: number;
  /** Trilha achatada [lng, lat, t, ...]. */
  track: number[];
  /** Segmentos contínuos para revelar a névoa sem riscar pulos de GPS. */
  segments: [LngLat, LngLat][];
}

export interface ChunkedFileSource {
  name: string;
  size: number;
  readChunk(length: number): Promise<Uint8Array>;
  close(): void;
}

/** Pulo maior que 500 m entre dois pontos seguidos é tratado como pausa/teleporte (não risca névoa). */
const MAX_SEGMENT_JUMP_M = 500;
/** Tamanho de cada bloco lido do disco ao fazer streaming de ZIPs grandes (1 MB). */
const STREAM_CHUNK_BYTES = 1024 * 1024;

/** Libera a thread principal para o React/UI redesenhar o progresso sem travar. */
export function yieldUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function isZip(name: string, bytes: Uint8Array): boolean {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return true;
  }
  return name.toLowerCase().endsWith('.zip');
}

function isGzip(name: string, bytes: Uint8Array): boolean {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return true;
  return name.toLowerCase().endsWith('.gz');
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function gpxEntryKind(rawPath: string): 'gpx' | 'gpx.gz' | null {
  const base = rawPath.split('/').pop() ?? rawPath;
  if (!base || rawPath.includes('__MACOSX/') || base.startsWith('._')) return null;
  const lower = base.toLowerCase();
  if (lower.endsWith('.gpx')) return 'gpx';
  if (lower.endsWith('.gpx.gz')) return 'gpx.gz';
  return null;
}

/**
 * Faz streaming de um .zip (pulando fotos/FIT/CSV sem descomprimir), .gpx.gz ou .gpx,
 * entregando um GPX de cada vez e cedendo o controle para a UI entre blocos.
 */
export async function streamGpxEntries(
  source: ChunkedFileSource,
  handlers: {
    onEntry: (entry: { name: string; xml: string }) => Promise<void>;
    onReadProgress?: (bytesRead: number, totalBytes: number) => void;
    isCancelled?: () => boolean;
  },
): Promise<{ found: number; cancelled: boolean }> {
  const { onEntry, onReadProgress, isCancelled } = handlers;
  let bytesRead = 0;
  let found = 0;
  let cancelled = false;

  try {
    const first = await source.readChunk(STREAM_CHUNK_BYTES);
    if (!first.length) return { found: 0, cancelled: false };
    bytesRead += first.length;
    onReadProgress?.(bytesRead, source.size);

    if (isZip(source.name, first)) {
      const ready: { name: string; xml: string }[] = [];
      const uz = new Unzip((file) => {
        const kind = gpxEntryKind(file.name);
        // Não chamar file.start() pula fotos, vídeos, .fit.gz e CSVs sem descomprimir nada!
        if (!kind) return;
        const base = file.name.split('/').pop() ?? file.name;
        const outName = kind === 'gpx.gz' ? base.slice(0, -3) : base;
        const parts: Uint8Array[] = [];
        file.ondata = (err, data, final) => {
          if (err) {
            console.warn('[gpx-import] erro ao descomprimir', file.name, err);
            return;
          }
          if (data?.length) parts.push(data);
          if (final && parts.length) {
            try {
              const raw = concatChunks(parts);
              const bytes = kind === 'gpx.gz' ? gunzipSync(raw) : raw;
              ready.push({ name: outName, xml: strFromU8(bytes) });
            } catch (e) {
              console.warn('[gpx-import] falha ao decodificar', file.name, e);
            }
          }
        };
        file.start();
      });
      uz.register(UnzipPassThrough);
      uz.register(UnzipInflate);

      const drain = async () => {
        while (ready.length > 0) {
          if (isCancelled?.()) {
            cancelled = true;
            return;
          }
          const item = ready.shift()!;
          found++;
          await onEntry(item);
          await yieldUi();
        }
      };

      let current: Uint8Array = first;
      while (true) {
        if (isCancelled?.()) {
          cancelled = true;
          break;
        }
        const next = await source.readChunk(STREAM_CHUNK_BYTES);
        const isLast = next.length === 0;
        uz.push(current, isLast);
        await drain();
        if (cancelled || isLast) break;
        bytesRead += next.length;
        onReadProgress?.(bytesRead, source.size);
        await yieldUi();
        current = next;
      }
      return { found, cancelled };
    }

    // Arquivo único (.gpx ou .gpx.gz)
    const chunks: Uint8Array[] = [first];
    while (true) {
      if (isCancelled?.()) {
        cancelled = true;
        return { found: 0, cancelled: true };
      }
      const next = await source.readChunk(STREAM_CHUNK_BYTES);
      if (!next.length) break;
      chunks.push(next);
      bytesRead += next.length;
      onReadProgress?.(bytesRead, source.size);
      await yieldUi();
    }
    const all = concatChunks(chunks);
    const xml = isGzip(source.name, all) ? strFromU8(gunzipSync(all)) : strFromU8(all);
    found = 1;
    await onEntry({ name: source.name.replace(/\.gz$/i, ''), xml });
    return { found, cancelled: false };
  } finally {
    source.close();
  }
}

/** Extrai todos os textos GPX de um buffer já em memória (.zip, .gpx.gz ou .gpx). */
export function extractGpxFiles(fileName: string, bytes: Uint8Array): { name: string; xml: string }[] {
  if (isZip(fileName, bytes)) {
    const entries = unzipSync(bytes, {
      filter: (f) => gpxEntryKind(f.name) !== null,
    });
    const out: { name: string; xml: string }[] = [];
    for (const [rawPath, data] of Object.entries(entries)) {
      if (!data.length) continue;
      const kind = gpxEntryKind(rawPath);
      if (!kind) continue;
      const base = rawPath.split('/').pop() ?? rawPath;
      try {
        if (kind === 'gpx') {
          out.push({ name: base, xml: strFromU8(data) });
        } else {
          out.push({ name: base.slice(0, -3), xml: strFromU8(gunzipSync(data)) });
        }
      } catch (err) {
        console.warn('[gpx-import] falha ao extrair', rawPath, err);
      }
    }
    return out;
  }
  if (isGzip(fileName, bytes)) {
    return [{ name: fileName.replace(/\.gz$/i, ''), xml: strFromU8(gunzipSync(bytes)) }];
  }
  return [{ name: fileName, xml: strFromU8(bytes) }];
}

function detectModality(xml: string, fallback: Modality): Modality {
  const m = xml.match(/<type>([^<]+)<\/type>/i);
  if (!m) return fallback;
  const t = m[1].trim().toLowerCase();
  if (t.includes('run') || t.includes('corrida') || t.includes('walk') || t.includes('hike')) return 'run';
  if (t.includes('cycl') || t.includes('bik') || t.includes('ride') || t.includes('pedal')) return 'bike';
  return fallback;
}

const TRKPT_RE = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>|<trkpt\b([^>]*)\/>/gi;
const LAT_RE = /\blat=["']([^"']+)["']/i;
const LON_RE = /\blon=["']([^"']+)["']/i;
const TIME_RE = /<time>([^<]+)<\/time>/i;

function parseSegmentPoints(segXml: string): { lng: number; lat: number; t: number }[] {
  const pts: { lng: number; lat: number; t: number }[] = [];
  TRKPT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TRKPT_RE.exec(segXml)) !== null) {
    const attrs = m[1] ?? m[3] ?? '';
    const body = m[2] ?? '';
    const latM = attrs.match(LAT_RE);
    const lonM = attrs.match(LON_RE);
    if (!latM || !lonM) continue;
    const lat = Number(latM[1]);
    const lng = Number(lonM[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const timeM = body.match(TIME_RE);
    const parsedT = timeM ? Date.parse(timeM[1].trim()) : NaN;
    pts.push({ lng, lat, t: Number.isFinite(parsedT) ? parsedT : 0 });
  }
  return pts;
}

/** Faz o parse de um GPX em uma atividade pronta para injetar na névoa e no histórico. */
export function parseGpx(xml: string, fallbackModality: Modality): ParsedGpxActivity | null {
  const segMatches = xml.match(/<trkseg\b[^>]*>[\s\S]*?<\/trkseg>/gi);
  const rawSegs = segMatches?.length ? segMatches : [xml];

  const track: number[] = [];
  const segments: [LngLat, LngLat][] = [];
  let distanceM = 0;
  let movingS = 0;
  let maxSpeed = 0;
  let firstT = 0;
  let lastT = 0;
  let fallbackT = Date.now();

  for (const segXml of rawSegs) {
    const pts = parseSegmentPoints(segXml);
    if (pts.length === 0) continue;
    let prev: { lng: number; lat: number; t: number } | null = null;
    for (const pt of pts) {
      const t: number = pt.t || (prev ? prev.t + 1000 : fallbackT);
      if (!firstT) firstT = t;
      lastT = Math.max(lastT, t);
      fallbackT = t + 1000;
      track.push(pt.lng, pt.lat, t);

      if (prev) {
        const d = haversine(prev, pt);
        if (d <= MAX_SEGMENT_JUMP_M) {
          segments.push([
            { lng: prev.lng, lat: prev.lat },
            { lng: pt.lng, lat: pt.lat },
          ]);
          distanceM += d;
          const dt = (t - prev.t) / 1000;
          if (dt > 0 && dt <= 30) {
            const speed = d / dt;
            if (speed > 0.6 && speed < 35) {
              movingS += dt;
              if (speed > maxSpeed) maxSpeed = speed;
            }
          }
        }
      } else if (pts.length === 1) {
        segments.push([
          { lng: pt.lng, lat: pt.lat },
          { lng: pt.lng, lat: pt.lat },
        ]);
      }
      prev = { lng: pt.lng, lat: pt.lat, t };
    }
  }

  if (track.length < 6) return null;
  const elapsedS = Math.max(0, (lastT - firstT) / 1000);
  return {
    modality: detectModality(xml, fallbackModality),
    startedAt: firstT,
    endedAt: lastT || firstT,
    elapsedS: elapsedS || movingS,
    movingS: movingS || elapsedS,
    distanceM,
    maxSpeed,
    track,
    segments,
  };
}
