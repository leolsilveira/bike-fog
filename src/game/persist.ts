// Salvamento local (arquivos no celular, IndexedDB na web). Quando houver backend, este é o ponto de sincronização.
import { AppState } from 'react-native';
import { storage } from '../services/storage';
import { useGame, pickPersisted, DEFAULT_PERSISTED, type PersistedState } from './store.ts';
import { fog } from './fog.ts';
import { bytesToFloat64, decodeFog, encodeFog, float64ToBytes, type FogData } from './binary.ts';

const SAVE_KEY = 'save:v1';
/** Névoa em binário (ver binary.ts). */
const FOG_KEY = 'fog:v2';
/** Metadados de sincronização da névoa (revisão otimista no Supabase). */
export const FOG_SYNC_KEY = 'fog:sync';
/** Formato da versão web antiga (objeto com typed arrays no IndexedDB). Só é lido para migrar. */
const LEGACY_CELLS_KEY = 'cells:v1';
const TRACK_PREFIX = 'track:';

export interface FogSyncState {
  revision: number;
  lastSyncedAt: number | null;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let cellsDirty = false;
let hydrated = false;
let legacyCells = false;
/** Gravação em andamento; outra só começa quando esta termina. */
let flushing: Promise<void> | null = null;
let flushAgain = false;

export async function hydrate(keepRecording = false): Promise<void> {
  try {
    const [saved, fogBytes] = await Promise.all([
      storage.getJson<PersistedState>(SAVE_KEY),
      storage.getBytes(FOG_KEY),
    ]);
    if (saved && saved.version === 1) {
      const live =
        saved.live && !(keepRecording && saved.live.status === 'recording')
          ? { ...saved.live, status: 'paused' as const, resumedAt: null }
          : saved.live;
      useGame.setState({
        ...DEFAULT_PERSISTED,
        ...saved,
        achievements: saved.achievements ?? {},
        live,
        settings: { ...DEFAULT_PERSISTED.settings, ...saved.settings },
      });
    }
    let cells: FogData | undefined = fogBytes ? decodeFog(fogBytes) : undefined;
    if (fogBytes && !cells) console.warn('[persist] névoa ilegível, ignorando');
    if (!cells) {
      cells = await storage.getJson<FogData>(LEGACY_CELLS_KEY).catch(() => undefined);
      if (cells?.keys && cells.city && cells.cityIds) {
        legacyCells = true;
        cellsDirty = true;
      } else {
        cells = undefined;
      }
    }
    fog.load(cells);
  } catch (err) {
    console.warn('[persist] falha ao carregar', err);
  }
  hydrated = true;
  useGame.setState({ hydrated: true });
  void import('../services/sync.ts')
    .then(({ initOnlineSync }) => initOnlineSync())
    .catch((err) => console.warn('[persist] falha ao iniciar sincronização online', err));
}

async function writeOnce(): Promise<void> {
  await storage.setJson(SAVE_KEY, pickPersisted(useGame.getState()));
  if (cellsDirty) {
    cellsDirty = false;
    try {
      await storage.setBytes(FOG_KEY, encodeFog(fog.serialize()));
    } catch (err) {
      cellsDirty = true;
      throw err;
    }
    if (legacyCells) {
      legacyCells = false;
      await storage.remove(LEGACY_CELLS_KEY).catch(() => undefined);
    }
  }
}

function flush(): Promise<void> {
  saveTimer = null;
  if (!hydrated) return Promise.resolve();
  if (flushing) {
    flushAgain = true;
    return flushing;
  }
  flushing = (async () => {
    do {
      flushAgain = false;
      try {
        await writeOnce();
      } catch (err) {
        console.warn('[persist] falha ao salvar', err);
      }
    } while (flushAgain);
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

export function scheduleSave(delay = 1500): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => void flush(), delay);
}

/** Salva já (ex.: o app foi para segundo plano). */
export function saveNow(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  return flush();
}

export function startAutosave(onBackground?: () => void): void {
  useGame.subscribe((s, prev) => {
    if (!s.hydrated) return;
    if (
      s.profile !== prev.profile || s.wallet !== prev.wallet || s.xp !== prev.xp || s.totals !== prev.totals ||
      s.captures !== prev.captures || s.cities !== prev.cities || s.activities !== prev.activities ||
      s.achievements !== prev.achievements || s.settings !== prev.settings || s.coins !== prev.coins ||
      s.live !== prev.live || s.unlocked !== prev.unlocked || s.route !== prev.route ||
      s.cloudUserId !== prev.cloudUserId || s.cloudSyncedAt !== prev.cloudSyncedAt
    ) {
      scheduleSave();
    }
  });
  fog.subscribe((added, reset) => {
    if (!reset || (hydrated && added.length > 0)) cellsDirty = true;
    scheduleSave();
  });
  // No celular o app pode ser morto a qualquer momento depois de sair da tela: salva na saída.
  AppState.addEventListener('change', (state) => {
    if (state !== 'active') {
      onBackground?.();
      void saveNow();
    }
  });
}

// --- trilhas das atividades (para exportar GPX) ------------------------------------

export async function saveTrack(activityId: string, track: number[]): Promise<void> {
  try {
    await storage.setBytes(TRACK_PREFIX + activityId, float64ToBytes(new Float64Array(track)));
  } catch (err) {
    console.warn('[persist] trilha', err);
  }
}

/** Trilha achatada [lng, lat, t, lng, lat, t, ...]. */
export async function loadTrack(activityId: string): Promise<Float64Array | undefined> {
  try {
    const bytes = await storage.getBytes(TRACK_PREFIX + activityId);
    return bytes ? bytesToFloat64(bytes) : undefined;
  } catch (err) {
    console.warn('[persist] trilha', err);
    return undefined;
  }
}

export async function getKv<T>(key: string): Promise<T | undefined> {
  try {
    return await storage.getJson<T>(key);
  } catch (err) {
    console.warn('[persist] leitura', key, err);
    return undefined;
  }
}

export async function setKv(key: string, value: unknown): Promise<void> {
  await storage.setJson(key, value);
}

export async function getFogSyncState(): Promise<FogSyncState> {
  const v = await getKv<FogSyncState>(FOG_SYNC_KEY);
  if (v && typeof v.revision === 'number' && Number.isFinite(v.revision) && v.revision >= 0) {
    return {
      revision: v.revision,
      lastSyncedAt: typeof v.lastSyncedAt === 'number' && Number.isFinite(v.lastSyncedAt) ? v.lastSyncedAt : null,
    };
  }
  return { revision: 0, lastSyncedAt: null };
}

export async function setFogSyncState(state: FogSyncState): Promise<void> {
  await setKv(FOG_SYNC_KEY, state);
}

export async function wipeAll(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  // não deixa uma gravação em andamento reescrever o save logo depois de apagar
  if (flushing) await flushing.catch(() => undefined);
  cellsDirty = false;
  legacyCells = false;
  await storage.clear();
  fog.clear();
}
