// Testes unitários do motor de conquistas (rodar com: node --test scripts/test-achievements.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAchievementOverview,
  cityTierKey,
  computeEddingtonKm,
  computeMaxStreak,
  evaluateAchievements,
  monthlyDaysKey,
  monthlyDistKey,
  tieredKey,
  type AchievementSnapshot,
} from '../src/game/achievements.ts';
import { EMPTY_TOTALS, useGame } from '../src/game/store.ts';
import type { ActivitySummary, City } from '../src/game/types.ts';

function makeSnapshot(partial: Partial<AchievementSnapshot> = {}): AchievementSnapshot {
  return {
    totals: { ...EMPTY_TOTALS },
    cities: {},
    captures: {},
    activities: [],
    live: null,
    achievements: {},
    ...partial,
  };
}

function makeActivity(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
  const startedAt = overrides.startedAt ?? new Date(2026, 10, 10, 9, 0, 0).getTime();
  return {
    id: `act_${Math.random().toString(36).slice(2, 7)}`,
    modality: 'bike',
    startedAt,
    endedAt: startedAt + 1800_000,
    elapsedS: 1800,
    movingS: 1700,
    distanceM: 10_000,
    maxSpeed: 8,
    coinsValue: 0,
    coinsCount: 0,
    captures: [],
    newCells: 100,
    xp: 120,
    cityIds: [],
    ...overrides,
  };
}

function makeCity(id: string, name: string, pct: number): City {
  const areaM2 = 10_000_000;
  const cellAreaM2 = 289;
  const cells = Math.ceil(((pct / 100) * areaM2) / cellAreaM2);
  return {
    id,
    name,
    areaM2,
    bbox: [0, 0, 1, 1],
    cells,
    cellAreaM2,
    discoveredAt: Date.now(),
  };
}

test('computeMaxStreak calcula dias consecutivos e ignora duplicatas no mesmo dia', () => {
  const acts = [
    makeActivity({ startedAt: new Date(2026, 10, 1, 8, 0).getTime() }),
    makeActivity({ startedAt: new Date(2026, 10, 1, 18, 0).getTime() }), // mesmo dia
    makeActivity({ startedAt: new Date(2026, 10, 2, 9, 0).getTime() }),
    makeActivity({ startedAt: new Date(2026, 10, 3, 7, 30).getTime() }),
    // pula dia 4
    makeActivity({ startedAt: new Date(2026, 10, 5, 10, 0).getTime() }),
    makeActivity({ startedAt: new Date(2026, 10, 6, 10, 0).getTime() }),
  ];
  assert.equal(computeMaxStreak(acts), 3);
});

test('computeEddingtonKm soma atividades do mesmo dia corretamente', () => {
  const acts = [
    // Dia 1: 3 km + 3 km = 6 km
    makeActivity({ startedAt: new Date(2026, 10, 1, 7, 0).getTime(), distanceM: 3000 }),
    makeActivity({ startedAt: new Date(2026, 10, 1, 18, 0).getTime(), distanceM: 3000 }),
    // Dia 2..5: 6 km cada -> 5 dias com >= 5 km -> E = 5
    makeActivity({ startedAt: new Date(2026, 10, 2, 7, 0).getTime(), distanceM: 6000 }),
    makeActivity({ startedAt: new Date(2026, 10, 3, 7, 0).getTime(), distanceM: 6000 }),
    makeActivity({ startedAt: new Date(2026, 10, 4, 7, 0).getTime(), distanceM: 6000 }),
    makeActivity({ startedAt: new Date(2026, 10, 5, 7, 0).getTime(), distanceM: 6000 }),
    // Dia 6: apenas 2 km (não sobe E para 6)
    makeActivity({ startedAt: new Date(2026, 10, 6, 7, 0).getTime(), distanceM: 2000 }),
  ];
  assert.equal(computeEddingtonKm(acts), 5);
});

test('conquistas multi-tier desbloqueiam vários níveis de uma vez e são idempotentes', () => {
  const snap = makeSnapshot({
    totals: { ...EMPTY_TOTALS, distanceM: 120_000, activities: 6 },
  });
  const first = evaluateAchievements(snap);
  const distKeys = first.filter((u) => u.key.startsWith('total_distance:')).map((u) => u.key);
  assert.deepEqual(distKeys, [tieredKey('total_distance', 0), tieredKey('total_distance', 1), tieredKey('total_distance', 2)]);

  // Marca todas como já desbloqueadas e garante que a segunda passada devolve vazio
  for (const u of first) snap.achievements[u.key] = { at: Date.now(), coins: u.coins };
  const second = evaluateAchievements(snap);
  assert.equal(second.length, 0);
});

test('conquistas recorrentes por cidade concedem recompensas independentes para cada município', () => {
  const sp = makeCity('r/1', 'São Paulo', 1.2);
  const bcn = makeCity('r/2', 'Barcelona', 0.6);
  const snap = makeSnapshot({
    cities: { [sp.id]: sp, [bcn.id]: bcn },
  });
  const unlocks = evaluateAchievements(snap);
  const keys = new Set(unlocks.map((u) => u.key));

  // SP passou 0.1%, 0.5% e 1%
  assert.ok(keys.has(cityTierKey('r/1', 0)));
  assert.ok(keys.has(cityTierKey('r/1', 1)));
  assert.ok(keys.has(cityTierKey('r/1', 2)));
  assert.ok(!keys.has(cityTierKey('r/1', 3)));

  // Barcelona passou 0.1% e 0.5%, mas não 1%
  assert.ok(keys.has(cityTierKey('r/2', 0)));
  assert.ok(keys.has(cityTierKey('r/2', 1)));
  assert.ok(!keys.has(cityTierKey('r/2', 2)));
});

test('conquistas recorrentes mensais separam meses diferentes', () => {
  const acts = [
    makeActivity({ startedAt: new Date(2026, 9, 10, 8, 0).getTime(), distanceM: 30_000 }), // Out/2026 -> 30 km
    makeActivity({ startedAt: new Date(2026, 10, 2, 8, 0).getTime(), distanceM: 60_000 }), // Nov/2026 -> 60 km
    makeActivity({ startedAt: new Date(2026, 10, 3, 8, 0).getTime(), distanceM: 1_000 }),
    makeActivity({ startedAt: new Date(2026, 10, 4, 8, 0).getTime(), distanceM: 1_000 }),
    makeActivity({ startedAt: new Date(2026, 10, 5, 8, 0).getTime(), distanceM: 1_000 }),
    makeActivity({ startedAt: new Date(2026, 10, 6, 8, 0).getTime(), distanceM: 1_000 }),
  ];
  const snap = makeSnapshot({ activities: acts });
  const keys = new Set(evaluateAchievements(snap).map((u) => u.key));

  assert.ok(keys.has(monthlyDistKey('2026-10', 0))); // 25 km em Out
  assert.ok(!keys.has(monthlyDistKey('2026-10', 1))); // < 50 km em Out
  assert.ok(keys.has(monthlyDistKey('2026-11', 0))); // 25 km em Nov
  assert.ok(keys.has(monthlyDistKey('2026-11', 1))); // 50 km em Nov
  assert.ok(keys.has(monthlyDaysKey('2026-11', 0))); // 5 dias ativos em Nov
});

test('conquistas especiais (Madrugador, Coruja, Sem Fronteiras e Híbrido)', () => {
  const acts = [
    makeActivity({
      modality: 'bike',
      startedAt: new Date(2026, 10, 10, 5, 15).getTime(),
      cityIds: ['r/1', 'r/2'],
    }),
    makeActivity({
      modality: 'run',
      startedAt: new Date(2026, 10, 11, 22, 30).getTime(),
      distanceM: 10_500,
    }),
  ];
  const snap = makeSnapshot({ activities: acts });
  const keys = new Set(evaluateAchievements(snap).map((u) => u.key));

  assert.ok(keys.has(tieredKey('early_bird', 0)));
  assert.ok(keys.has(tieredKey('night_rider', 0)));
  assert.ok(keys.has(tieredKey('multi_city_activity', 0)));
  assert.ok(keys.has(tieredKey('dual_sport', 0)));
  assert.ok(keys.has(tieredKey('single_run_dist', 0)));
  assert.ok(keys.has(tieredKey('single_run_dist', 1)));
});

test('grantAchievements na store credita moedas uma única vez e gera overview consistente', () => {
  useGame.getState().resetProgress();
  const snap = makeSnapshot({
    totals: { ...EMPTY_TOTALS, activities: 1, distanceM: 6000 },
  });
  const unlocks = evaluateAchievements(snap);
  const expectedCoins = unlocks.reduce((sum, u) => sum + u.coins, 0);

  const granted1 = useGame.getState().grantAchievements(unlocks, { batchToast: true });
  const granted2 = useGame.getState().grantAchievements(unlocks, { batchToast: true });

  assert.equal(granted1, expectedCoins);
  assert.equal(granted2, 0);
  assert.equal(useGame.getState().wallet, expectedCoins);

  const overview = buildAchievementOverview(useGame.getState());
  assert.equal(overview.unlockedCount, unlocks.length);
  assert.equal(overview.totalCoinsEarned, expectedCoins);
  assert.equal(overview.almostThere.length, 3);
});
