// Extração de arquivos GPX (direto, .gpx.gz ou .zip do Strava) e parser GPX puro (sem DOMParser).
import { gunzipSync, strFromU8, unzipSync } from 'fflate';
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

/** Pulo maior que 500 m entre dois pontos seguidos é tratado como pausa/teleporte (não risca névoa). */
const MAX_SEGMENT_JUMP_M = 500;

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

/** Extrai todos os textos GPX de um arquivo .zip (ex.: exportação do Strava), .gpx.gz ou .gpx. */
export function extractGpxFiles(fileName: string, bytes: Uint8Array): { name: string; xml: string }[] {
  if (isZip(fileName, bytes)) {
    const entries = unzipSync(bytes);
    const out: { name: string; xml: string }[] = [];
    for (const [rawPath, data] of Object.entries(entries)) {
      if (!data.length) continue;
      const base = rawPath.split('/').pop() ?? rawPath;
      if (rawPath.includes('__MACOSX/') || base.startsWith('._')) continue;
      const lower = base.toLowerCase();
      try {
        if (lower.endsWith('.gpx')) {
          out.push({ name: base, xml: strFromU8(data) });
        } else if (lower.endsWith('.gpx.gz')) {
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
