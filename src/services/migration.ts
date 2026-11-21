// Orquestração da migração local ↔ nuvem após autenticação.
import { wipeAll } from '../game/persist.ts';
import { useGame } from '../game/store.ts';
import {
  buildLocalMigrationSummary,
  decideMigration,
  hasSummaryProgress,
  inspectCloudState,
  type MigrationDecision,
} from './migrationCore.ts';
import { requireSupabase } from './supabase.ts';
import { pullCloudToLocal, pushAllLocalToCloud } from './sync.ts';

export {
  buildLocalMigrationSummary,
  decideMigration,
  hasSummaryProgress,
  inspectCloudState,
  type MigrationDecision,
};

const inFlightMigrations = new Map<string, Promise<MigrationDecision>>();
let recentResolution: { userId: string; at: number; decision: MigrationDecision } | null = null;

export function clearMigrationState(): void {
  recentResolution = null;
  useGame.getState().setPendingMigration(null);
}

async function waitForHydration(timeoutMs = 8000): Promise<void> {
  if (useGame.getState().hydrated) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const unsub = useGame.subscribe((s) => {
      if (s.hydrated) finish();
    });
  });
}

export function resolveMigrationForUser(user: {
  id: string;
  email?: string | null;
}): Promise<MigrationDecision> {
  if (
    recentResolution &&
    recentResolution.userId === user.id &&
    Date.now() - recentResolution.at < 3000
  ) {
    return Promise.resolve(recentResolution.decision);
  }

  const pending = inFlightMigrations.get(user.id);
  if (pending) return pending;

  const task = (async (): Promise<MigrationDecision> => {
    await waitForHydration();

    const s0 = useGame.getState();
    if (s0.pendingMigration && s0.pendingMigration.userId === user.id) {
      if (!s0.modals.some((m) => m.type === 'migration')) {
        s0.pushModal({ type: 'migration' });
      }
      return 'conflict';
    }

    const client = requireSupabase();
    const local = buildLocalMigrationSummary();
    const cloud = await inspectCloudState(client, user.id);

    const decision = decideMigration({
      userId: user.id,
      localCloudUserId: local.localCloudUserId,
      local: local.summary,
      cloud: cloud.summary,
      hasLocalProfile: local.hasProfile,
      cloudHasWalletOrExtras: cloud.hasProgress,
      localHasExtras: local.hasExtras,
    });

    if (decision === 'same_account_sync') {
      await pullCloudToLocal({ mode: 'merge' });
    } else if (decision === 'auto_push') {
      await pushAllLocalToCloud();
    } else if (decision === 'auto_pull') {
      await pullCloudToLocal({ mode: 'replace' });
    } else {
      const store = useGame.getState();
      store.setPendingMigration({
        userId: user.id,
        email: user.email ?? null,
        local: local.summary,
        cloud: cloud.summary,
      });
      if (!store.modals.some((m) => m.type === 'migration')) {
        store.pushModal({ type: 'migration' });
      }
    }

    recentResolution = { userId: user.id, at: Date.now(), decision };
    return decision;
  })().finally(() => {
    inFlightMigrations.delete(user.id);
  });

  inFlightMigrations.set(user.id, task);
  return task;
}

export async function resolveMigrationMerge(): Promise<void> {
  await pushAllLocalToCloud();
  const s = useGame.getState();
  s.setPendingMigration(null);
  recentResolution = null;
  if (s.modals[0]?.type === 'migration') {
    s.closeModal();
  }
}

export async function resolveMigrationCloudOnly(): Promise<void> {
  await wipeAll();
  useGame.getState().resetProgress();
  await pullCloudToLocal({ mode: 'replace' });
  useGame.getState().setPendingMigration(null);
  recentResolution = null;
}
