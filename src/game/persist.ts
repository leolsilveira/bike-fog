// Salvamento local (IndexedDB). Quando houver backend, este é o ponto de sincronização.
import { get, set, del, clear, createStore } from 'idb-keyval';
import { useGame, pickPersisted, DEFAULT_PERSISTED, type PersistedState } from './store.ts';
import { fog } from './fog.ts';

const db = createStore('desbrava', 'kv');
const SAVE_KEY = 'save:v1';
const CELLS_KEY = 'cells:v1';
const TRACK_PREFIX = 'track:';

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let cellsDirty = false;
let hydrated = false;

export async function hydrate(): Promise<void> {
  try {
    const [saved, cells] = await Promise.all([
      get<PersistedState>(SAVE_KEY, db),
      get<{ keys: Float64Array; city: Uint16Array; cityIds: string[] }>(CELLS_KEY, db),
    ]);
    if (saved && saved.version === 1) {
      const live = saved.live ? { ...saved.live, status: 'paused' as const, resumedAt: null } : null;
      useGame.setState({ ...DEFAULT_PERSISTED, ...saved, live, settings: { ...DEFAULT_PERSISTED.settings, ...saved.settings } });
    }
    fog.load(cells);
  } catch (err) {
    console.warn('[persist] falha ao carregar', err);
  }
  hydrated = true;
  useGame.setState({ hydrated: true });
}

async function flush(): Promise<void> {
  saveTimer = null;
  if (!hydrated) return;
  try {
    await set(SAVE_KEY, pickPersisted(useGame.getState()), db);
    if (cellsDirty) {
      cellsDirty = false;
      await set(CELLS_KEY, fog.serialize(), db);
    }
  } catch (err) {
    console.warn('[persist] falha ao salvar', err);
  }
}

export function scheduleSave(delay = 1500): void {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, delay);
}

export function saveNow(): void {
  if (saveTimer) clearTimeout(saveTimer);
  void flush();
}

export function startAutosave(): void {
  useGame.subscribe((s, prev) => {
    if (!s.hydrated) return;
    if (
      s.profile !== prev.profile || s.wallet !== prev.wallet || s.xp !== prev.xp || s.totals !== prev.totals ||
      s.captures !== prev.captures || s.cities !== prev.cities || s.activities !== prev.activities ||
      s.settings !== prev.settings || s.coins !== prev.coins || s.live !== prev.live || s.unlocked !== prev.unlocked
    ) {
      scheduleSave();
    }
  });
  fog.subscribe((_added, reset) => {
    if (!reset) cellsDirty = true;
    scheduleSave();
  });
  const onHide = () => {
    if (document.visibilityState === 'hidden') saveNow();
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', saveNow);
}

// --- trilhas das atividades (para exportar GPX) ------------------------------------

export async function saveTrack(activityId: string, track: number[]): Promise<void> {
  try {
    await set(TRACK_PREFIX + activityId, new Float64Array(track), db);
  } catch (err) {
    console.warn('[persist] trilha', err);
  }
}

export async function loadTrack(activityId: string): Promise<Float64Array | undefined> {
  return get<Float64Array>(TRACK_PREFIX + activityId, db);
}

export async function getKv<T>(key: string): Promise<T | undefined> {
  return get<T>(key, db);
}

export async function setKv(key: string, value: unknown): Promise<void> {
  await set(key, value, db);
}

export async function wipeAll(): Promise<void> {
  await clear(db);
  fog.clear();
  await del(SAVE_KEY, db);
}
