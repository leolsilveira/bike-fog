// Integração de sincronização online com o app (Zustand, persistência local, cidades e ciclo de vida).
import { recountCities } from '../game/cities.ts';
import { getFogSyncState, loadTrack, saveNow, setFogSyncState } from '../game/persist.ts';
import { useGame } from '../game/store.ts';
import type { ActivitySource, ActivitySummary } from '../game/types.ts';
import { getSupabaseUser, supabase } from './supabase.ts';
import {
  isApplyingCloudState,
  pullCloudToLocal as pullCloudToLocalCore,
  pushAllLocalToCloud as pushAllLocalToCloudCore,
  syncAchievements as syncAchievementsCore,
  syncActivitiesSequence,
  syncActivity as syncActivityCore,
  syncCitiesAndCaptures as syncCitiesAndCapturesCore,
  syncFog as syncFogCore,
  syncProfile as syncProfileCore,
  withCloudGuard,
  withSyncLock,
  type FogSyncState,
  type SyncDeps,
  type SyncFogResult,
  type VerifyActivityResponse,
} from './syncCore.ts';

export {
  isApplyingCloudState,
  withCloudGuard,
  withSyncLock,
  type FogSyncState,
  type SyncDeps,
  type SyncFogResult,
  type VerifyActivityResponse,
};

async function getDeps(): Promise<SyncDeps | null> {
  if (!supabase) return null;
  const user = await getSupabaseUser();
  if (!user) return null;
  return {
    client: supabase,
    userId: user.id,
    loadTrack,
    saveLocalNow: saveNow,
    onFogMerged: recountCities,
    fogSync: {
      get: getFogSyncState,
      set: setFogSyncState,
    },
  };
}

async function runTracked<T>(fn: (deps: SyncDeps) => Promise<T>): Promise<T | null> {
  const deps = await getDeps();
  if (!deps) return null;
  useGame.getState().setSyncState({ syncing: true, lastSyncError: null });
  try {
    const res = await fn(deps);
    useGame.getState().setSyncState({
      syncing: false,
      lastSyncedAt: Date.now(),
      lastSyncError: null,
    });
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    useGame.getState().setSyncState({ syncing: false, lastSyncError: msg });
    throw err;
  }
}

export async function syncProfile(): Promise<void> {
  await runTracked((deps) => syncProfileCore(deps));
}

export async function syncActivity(
  activity: ActivitySummary,
  opts?: { track?: Float64Array | number[]; source?: ActivitySource; boostUsageIds?: string[] },
): Promise<VerifyActivityResponse | null> {
  return await runTracked((deps) => syncActivityCore(deps, activity, opts));
}

export async function syncFog(opts?: { forceUpload?: boolean }): Promise<SyncFogResult | null> {
  return await runTracked((deps) => syncFogCore(deps, opts));
}

export async function syncCitiesAndCaptures(): Promise<void> {
  await runTracked((deps) => syncCitiesAndCapturesCore(deps));
}

export async function syncAchievements(candidateKeys?: string[]): Promise<void> {
  await runTracked((deps) => syncAchievementsCore(deps, candidateKeys));
}

export async function pushAllLocalToCloud(): Promise<void> {
  await runTracked((deps) => pushAllLocalToCloudCore(deps));
}

export async function pullCloudToLocal(opts?: { mode?: 'merge' | 'replace' }): Promise<void> {
  await runTracked((deps) => pullCloudToLocalCore(deps, opts));
}

/** Sincroniza atividade finalizada, cidades/capturas, névoa e conquistas sem bloquear a UI. */
export async function syncAfterActivityFinish(activity: ActivitySummary): Promise<void> {
  try {
    await runTracked((deps) => syncActivitiesSequence(deps, [activity], { source: activity.source ?? 'live' }));
  } catch (err) {
    console.warn('[sync] falha após finalizar atividade', err);
  }
}

/** Sincroniza lote de atividades importadas via GPX sem bloquear a UI. */
export async function syncAfterGpxImport(newSummaries: ActivitySummary[]): Promise<void> {
  if (newSummaries.length === 0) return;
  try {
    const chronological = [...newSummaries].reverse();
    await runTracked((deps) => syncActivitiesSequence(deps, chronological, { source: 'gpx_import' }));
  } catch (err) {
    console.warn('[sync] falha após importar GPX', err);
  }
}

let activeUnsub: (() => void) | null = null;

/** Inicia observadores de auto-sync online (não-bloqueante; modo Convidado permanece no-op). */
export function initOnlineSync(): () => void {
  if (activeUnsub) return activeUnsub;

  let profileTimer: ReturnType<typeof setTimeout> | null = null;
  let achTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingAchKeys = new Set<string>();

  const unsubStore = useGame.subscribe((s, prev) => {
    if (!s.hydrated || isApplyingCloudState()) return;

    // 1. Conclusão de atividade ao vivo
    if (prev.live !== null && s.live === null && s.activities.length > prev.activities.length) {
      const finished = s.activities[0];
      if (finished) {
        void syncAfterActivityFinish(finished);
      }
    }

    // 2. Edição de perfil ou configurações sincronizáveis (som/háptico)
    const profileEdited =
      s.profile !== null &&
      (s.profile.name !== prev.profile?.name ||
        s.profile.modality !== prev.profile?.modality ||
        s.profile.characterId !== prev.profile?.characterId ||
        s.profile.avatar !== prev.profile?.avatar ||
        s.profile.username !== prev.profile?.username ||
        s.profile.isPublic !== prev.profile?.isPublic ||
        s.settings.sound !== prev.settings.sound ||
        s.settings.haptics !== prev.settings.haptics);

    if (profileEdited) {
      if (profileTimer) clearTimeout(profileTimer);
      profileTimer = setTimeout(() => {
        profileTimer = null;
        void syncProfile().catch((err) => console.warn('[sync] auto perfil falhou', err));
      }, 800);
    }

    // 3. Novas conquistas desbloqueadas
    const prevAchCount = Object.keys(prev.achievements).length;
    const curAchKeys = Object.keys(s.achievements);
    if (curAchKeys.length > prevAchCount) {
      for (const k of curAchKeys) {
        if (!prev.achievements[k]) pendingAchKeys.add(k);
      }
      if (achTimer) clearTimeout(achTimer);
      achTimer = setTimeout(() => {
        achTimer = null;
        const keys = [...pendingAchKeys];
        pendingAchKeys.clear();
        if (keys.length > 0) {
          void syncAchievements(keys).catch((err) => console.warn('[sync] auto conquistas falhou', err));
        }
      }, 400);
    }
  });

  // Pull inicial silencioso ao abrir o app se já houver sessão autenticada e perfil local compatível
  void (async () => {
    const user = await getSupabaseUser();
    const s = useGame.getState();
    const localCloudId = s.cloudUserId ?? s.profile?.cloudUserId;
    if (user && s.profile && (!localCloudId || localCloudId === user.id)) {
      await pullCloudToLocal({ mode: 'merge' });
    }
  })().catch((err) => console.warn('[sync] pull inicial falhou', err));

  activeUnsub = () => {
    if (profileTimer) clearTimeout(profileTimer);
    if (achTimer) clearTimeout(achTimer);
    pendingAchKeys.clear();
    unsubStore();
    activeUnsub = null;
  };

  return activeUnsub;
}
