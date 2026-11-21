// Lógica pura de inspeção e decisão de migração local ↔ nuvem (testável no Node 24).
// Não importa react-native, expo-* nem módulos com variante por plataforma (.web.ts).
import type { SupabaseClient } from '@supabase/supabase-js';
import { fog } from '../game/fog.ts';
import { useGame } from '../game/store.ts';
import type { MigrationSummary } from '../game/types.ts';

export type MigrationDecision = 'same_account_sync' | 'auto_push' | 'auto_pull' | 'conflict';

export interface DecideMigrationInput {
  userId: string;
  localCloudUserId?: string;
  local: MigrationSummary;
  cloud: MigrationSummary;
  hasLocalProfile: boolean;
  cloudHasWalletOrExtras?: boolean;
  localHasExtras?: boolean;
}

export function hasSummaryProgress(s: MigrationSummary): boolean {
  return s.activities > 0 || s.cells > 0 || s.captures > 0 || s.xp > 0;
}

export function decideMigration(input: DecideMigrationInput): MigrationDecision {
  if (input.localCloudUserId && input.localCloudUserId === input.userId) {
    return 'same_account_sync';
  }

  const localHasProgress = hasSummaryProgress(input.local) || Boolean(input.localHasExtras);
  const cloudHasProgress = hasSummaryProgress(input.cloud) || Boolean(input.cloudHasWalletOrExtras);

  if (cloudHasProgress && localHasProgress) {
    return 'conflict';
  }
  if (!cloudHasProgress && (localHasProgress || input.hasLocalProfile)) {
    return 'auto_push';
  }
  return 'auto_pull';
}

export function buildLocalMigrationSummary(): {
  summary: MigrationSummary;
  hasProfile: boolean;
  localCloudUserId?: string;
  hasExtras: boolean;
} {
  const s = useGame.getState();
  const capturesCount = Object.keys(s.captures).length;
  const cells = Math.max(fog.size, s.totals.cells);
  const activities = Math.max(s.activities.length, s.totals.activities);
  const summary: MigrationSummary = {
    activities,
    cells,
    captures: Math.max(capturesCount, s.totals.captures),
    xp: s.xp,
    ...(s.profile?.name ? { displayName: s.profile.name } : {}),
  };
  const hasExtras =
    Object.keys(s.cities).length > 0 ||
    Object.keys(s.achievements).length > 0 ||
    s.wallet > 0;
  return {
    summary,
    hasProfile: s.profile !== null,
    localCloudUserId: s.cloudUserId ?? s.profile?.cloudUserId,
    hasExtras,
  };
}

export interface CloudInspectionResult {
  summary: MigrationSummary;
  hasProgress: boolean;
}

export async function inspectCloudState(
  client: SupabaseClient,
  userId: string,
): Promise<CloudInspectionResult> {
  const [profRes, actRes, fogRes] = await Promise.all([
    client
      .from('profiles')
      .select('display_name, xp, wallet, total_activities, total_cells, total_captures, achievements_count')
      .eq('id', userId)
      .maybeSingle(),
    client
      .from('activities')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId),
    client
      .from('user_fog_state')
      .select('cell_count')
      .eq('user_id', userId)
      .maybeSingle(),
  ]);

  if (profRes.error) {
    throw new Error(`Falha ao consultar perfil na nuvem: ${profRes.error.message}`);
  }
  if (actRes.error) {
    throw new Error(`Falha ao consultar atividades na nuvem: ${actRes.error.message}`);
  }
  if (fogRes.error) {
    throw new Error(`Falha ao consultar névoa na nuvem: ${fogRes.error.message}`);
  }

  const prof = profRes.data as {
    display_name?: string | null;
    xp?: number | null;
    wallet?: number | null;
    total_activities?: number | null;
    total_cells?: number | null;
    total_captures?: number | null;
    achievements_count?: number | null;
  } | null;

  const fogRow = fogRes.data as { cell_count?: number | null } | null;

  const activities = Math.max(prof?.total_activities ?? 0, actRes.count ?? 0);
  const cells = Math.max(prof?.total_cells ?? 0, fogRow?.cell_count ?? 0);
  const captures = prof?.total_captures ?? 0;
  const xp = prof?.xp ?? 0;
  const wallet = prof?.wallet ?? 0;
  const achievementsCount = prof?.achievements_count ?? 0;

  const summary: MigrationSummary = {
    activities,
    cells,
    captures,
    xp,
    ...(prof?.display_name ? { displayName: prof.display_name } : {}),
  };

  return {
    summary,
    hasProgress: hasSummaryProgress(summary) || wallet > 0 || achievementsCount > 0,
  };
}
