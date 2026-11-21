import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { gateTest } from './lib/probe.ts';
import { SupabaseHttpClient, TestUserRegistry } from './lib/supabaseHttp.ts';
import {
  buildFogFixtures,
  buildVectorG1,
  buildVectorV1,
  buildVectorV2,
  buildVectorV3,
  currentSaoPauloMonthBounds,
  decodeDsbf,
  encodeDsbf,
  mergeDsbf,
  T0_MS,
} from './lib/trackFixtures.ts';
import {
  completeGuestOnboarding,
  drainModals,
  launchWebSession,
  listIdbKeys,
  openAuthModal,
  readIdbKey,
  readLocalStorageAll,
  recordBriefSimRide,
  seedSupabaseWebSession,
  setExternalOffline,
  signInViaAuthModal,
  startDistServer,
  writeIdbKey,
} from './lib/webHarness.ts';

interface UpsertFogResult {
  conflict: boolean;
  revision: number;
  storage_path: string | null;
  cell_count: number;
}

type GlobalRankRow = { rank?: number; user_id?: string; is_me?: boolean } | number | null;

async function submitVerified(
  client: SupabaseHttpClient,
  userId: string,
  token: string,
  actId: string,
  vec: ReturnType<typeof buildVectorV1>,
  boostUsageIds?: string[],
) {
  const tp = `${userId}/${actId}.bin.gz`;
  const up = await client.storageUpload('activity-tracks', tp, vec.trackGzBytes, { token });
  assert.equal(up.status, 200);
  const ver = await client.invokeVerifyActivity(
    {
      activityId: actId,
      source: vec.source,
      modality: vec.modality,
      startedAt: vec.startedAt,
      endedAt: vec.endedAt,
      trackPath: tp,
      clientSummary: {
        distanceM: vec.distanceM,
        movingS: vec.movingS,
        maxSpeed: vec.maxSpeed,
        newCells: vec.newCells,
        coinsCount: vec.coinsCount,
        coinsValue: vec.coinsValue,
        coinsByKind: vec.coinsByKind,
        captures: vec.captures,
        cityIds: vec.cityIds,
      },
      ...(boostUsageIds ? { boostUsageIds } : {}),
    },
    { token },
  );
  assert.equal(ver.status, 200, `verify-activity failed: ${ver.rawText}`);
  return ver.data;
}

// ============================================================================
// Tier 4 — Real-World Application Scenarios (11 Scenarios)
// ============================================================================

test('T4-S01: Daily commuter cycling + level-up (1 -> 3) + achievement claim + cosmetic equip', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t4s01', { displayName: 'Ciclista Diario', isPublic: true });
    // Morning ride (V1 = 117 XP, 27 coins -> Level 2)
    const morning = await submitVerified(client, user.userId, user.accessToken, `act_am_${Date.now()}`, buildVectorV1(T0_MS));
    assert.equal(morning.authoritative.level, 2);

    // Evening ride (V3 = 367 XP -> total 484 XP -> Level 3)
    const evening = await submitVerified(client, user.userId, user.accessToken, `act_pm_${Date.now()}`, buildVectorV3(T0_MS + 36_000_000));
    assert.ok(evening.authoritative.level >= 3);

    // Claim achievements -> earn >= 82 coins -> buy cheapest active cosmetic -> equip in profile
    for (const key of ['total_activities:0', 'total_captures:0', 'total_cells:0']) {
      const claim = await client.rpc('claim_achievement', { p_achievement_key: key }, { token: user.accessToken });
      assert.equal(claim.status, 200, `claim_achievement(${key}) failed: ${claim.rawText}`);
    }
    const prof = await client.rest<{ wallet: number }[]>('GET', `profiles?id=eq.${user.userId}&select=wallet`, {
      token: user.accessToken,
    });
    assert.ok(prof.data[0].wallet >= 82, `Expected wallet >= 82, got ${prof.data[0].wallet}`);
    const cosmetics = await client.rest<{ id: string; price_coins: number }[]>(
      'GET',
      `store_items?is_active=eq.true&kind=eq.cosmetic&price_coins=lte.${prof.data[0].wallet}&order=price_coins.asc&limit=1&select=id,price_coins`,
      { token: user.accessToken },
    );
    assert.ok(cosmetics.data.length > 0, `Expected affordable cosmetic <= ${prof.data[0].wallet} coins`);
    const cos = cosmetics.data[0];
    const buy = await client.rpc('purchase_store_item', { p_item_id: cos.id, p_quantity: 1 }, { token: user.accessToken });
    assert.equal(buy.status, 200, `purchase_store_item failed: ${buy.rawText}`);
    const equipPatch = await client.rest('PATCH', `profiles?id=eq.${user.userId}`, {
      token: user.accessToken,
      body: { avatar_config: { equipped: [cos.id] } },
    });
    assert.ok(equipPatch.ok, `Cosmetic equip patch failed: ${equipPatch.rawText}`);
  } finally {
    await registry.cleanup();
  }
});

test('T4-S02: Strava GPX multi-city archive + live run combo', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t4s02');
    const g1 = buildVectorG1(T0_MS);
    const gpxRes = await submitVerified(client, user.userId, user.accessToken, `act_gpx_${Date.now()}`, g1);
    assert.equal(gpxRes.activity.xpEarned, 0);
    assert.equal(gpxRes.authoritative.wallet, 0);

    const { fogA, fogB } = buildFogFixtures();
    const merged = mergeDsbf(fogA, fogB);
    await client.storageUpload('fog-snapshots', `${user.userId}/fog.bin`, new Uint8Array(zlib.gzipSync(encodeDsbf(merged))), {
      token: user.accessToken,
    });

    // Follow with live run (V2 = 201 XP, 105 coins)
    const liveRun = await submitVerified(client, user.userId, user.accessToken, `act_run_${Date.now()}`, buildVectorV2(T0_MS + 86_400_000));
    assert.equal(liveRun.activity.xpEarned, 201);
    assert.equal(liveRun.authoritative.xp, 201);
    assert.equal(liveRun.authoritative.wallet, 105);
  } finally {
    await registry.cleanup();
  }
});

test('T4-S03: 3-player friend competition across metrics & America/Sao_Paulo monthly period', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const now = Date.now();
    const month = currentSaoPauloMonthBounds(now);
    assert.ok(month.yearMonth.length === 7);

    const uAlice = `alice_${now.toString(36)}`;
    const alice = await registry.provisionUser('t4s03_alice', { username: uAlice, isPublic: true });
    const bob = await registry.provisionUser('t4s03_bob', { username: `bob_${now.toString(36)}`, isPublic: true });
    const carol = await registry.provisionUser('t4s03_carol', { username: `carol_${now.toString(36)}`, isPublic: true });

    // Alice: V2 run (201 XP, 1080m, 261 cells)
    await submitVerified(client, alice.userId, alice.accessToken, `act_al_${now}`, buildVectorV2(now - 600_000));
    // Bob: V1 bike (117 XP, 2100m, 615 cells)
    await submitVerified(client, bob.userId, bob.accessToken, `act_bo_${now}`, buildVectorV1(now - 500_000));
    // Carol: V3 bike (367 XP, 10000m, 2871 cells)
    await submitVerified(client, carol.userId, carol.accessToken, `act_ca_${now}`, buildVectorV3(now - 1_500_000));

    // Alice <-> Bob friends; Bob <-> Carol friends; Alice NOT friends with Carol
    const fAB = await client.rest<{ id: string }[]>('POST', 'friendships', {
      token: bob.accessToken,
      prefer: 'return=representation',
      body: { requester_id: bob.userId, addressee_id: alice.userId, status: 'pending' },
    });
    assert.ok(fAB.ok, `fAB POST failed: ${fAB.rawText}`);
    const accAB = await client.rest('PATCH', `friendships?id=eq.${fAB.data[0].id}`, {
      token: alice.accessToken,
      body: { status: 'accepted' },
    });
    assert.ok(accAB.ok, `fAB accept failed: ${accAB.rawText}`);

    const fBC = await client.rest<{ id: string }[]>('POST', 'friendships', {
      token: carol.accessToken,
      prefer: 'return=representation',
      body: { requester_id: carol.userId, addressee_id: bob.userId, status: 'pending' },
    });
    assert.ok(fBC.ok, `fBC POST failed: ${fBC.rawText}`);
    const accBC = await client.rest('PATCH', `friendships?id=eq.${fBC.data[0].id}`, {
      token: bob.accessToken,
      body: { status: 'accepted' },
    });
    assert.ok(accBC.ok, `fBC accept failed: ${accBC.rawText}`);

    const aliceFriendsXp = await client.rpc<{ user_id?: string; id?: string }[]>(
      'get_friends_leaderboard',
      { p_metric: 'xp', p_period: 'monthly' },
      { token: alice.accessToken },
    );
    const aliceIds = aliceFriendsXp.data.map((r) => r.user_id ?? r.id);
    assert.equal(aliceIds[0], alice.userId);
    assert.equal(aliceIds[1], bob.userId);
    assert.equal(aliceIds.includes(carol.userId), false);

    const aliceFriendsDist = await client.rpc<{ user_id?: string; id?: string }[]>(
      'get_friends_leaderboard',
      { p_metric: 'distance', p_period: 'monthly' },
      { token: alice.accessToken },
    );
    assert.equal(aliceFriendsDist.data[0].user_id ?? aliceFriendsDist.data[0].id, bob.userId);

    const globalXp = await client.rpc<{ entries: { user_id?: string; id?: string }[]; my_rank: GlobalRankRow }>(
      'get_global_leaderboard',
      { p_metric: 'xp', p_period: 'all_time', p_limit: 50, p_offset: 0 },
      { token: alice.accessToken },
    );
    assert.equal(globalXp.status, 200);
    const gIds = globalXp.data.entries.map((e) => e.user_id ?? e.id);
    const aliceInMyRank =
      typeof globalXp.data.my_rank === 'object' &&
      globalXp.data.my_rank !== null &&
      globalXp.data.my_rank.user_id === alice.userId;
    assert.ok((gIds.includes(alice.userId) || aliceInMyRank) && gIds.includes(bob.userId) && gIds.includes(carol.userId));
  } finally {
    await registry.cleanup();
  }
});

test('T4-S04: Online trail run with pre-purchased booster + verify-activity reconciliation', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t4s04');
    await submitVerified(client, user.userId, user.accessToken, `act_seed_${Date.now()}`, buildVectorV2(T0_MS));
    const items = await client.rest<{ id: string }[]>(
      'GET',
      'store_items?is_active=eq.true&category=eq.boost_xp&order=price_coins.asc&limit=1&select=id',
      { token: user.accessToken },
    );
    const boostId = items.data[0].id;
    const buy = await client.rpc('purchase_store_item', { p_item_id: boostId, p_quantity: 1 }, { token: user.accessToken });
    assert.equal(buy.status, 200, `purchase_store_item failed: ${buy.rawText}`);

    // Online booster activation -> upload & verify-activity reconciliation
    const v2 = buildVectorV2(T0_MS + 5_000_000, 'poi_v2_s04');
    const usageId = `bu_s4_${Date.now()}`;
    const actId = `act_trail_${Date.now()}`;
    const boostIns = await client.rest('POST', 'user_boost_usages', {
      token: user.accessToken,
      body: {
        id: usageId,
        user_id: user.userId,
        item_id: boostId,
        activity_id: actId,
        activated_at: new Date(v2.startedAt).toISOString(),
        expires_at: new Date(v2.endedAt + 600_000).toISOString(),
      },
    });
    assert.ok(boostIns.ok, `user_boost_usages insert failed: ${boostIns.rawText}`);
    const ver = await submitVerified(client, user.userId, user.accessToken, actId, v2, [usageId]);
    assert.equal(ver.activity.xpEarned, v2.expectedXp * 2);

    const inv = await client.rest<{ quantity: number }[]>(
      'GET',
      `user_inventory?user_id=eq.${user.userId}&item_id=eq.${boostId}&select=quantity`,
      { token: user.accessToken },
    );
    assert.equal(inv.data[0].quantity, 0);
  } finally {
    await registry.cleanup();
  }
});

test('T4-S05: Multi-device sync & migration conflict resolution (Mesclar vs Manter apenas a nuvem)', async (t) => {
  if (!(await gateTest(t, { milestone: 'M3', requires: ['schema', 'verifyActivity', 'serviceRoleKey', 'authUi', 'distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession();
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t4s05', { displayName: 'Device One' });
    await submitVerified(client, user.userId, user.accessToken, `act_d1_${Date.now()}`, buildVectorV1());

    await session.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'Device Two Guest', modality: 'run' });
    await openAuthModal(session.page);
    await signInViaAuthModal(session.page, user.email, user.password);

    await session.page.getByTestId('migration-modal').waitFor({ state: 'visible', timeout: 12_000 });
    await session.page.getByTestId('migration-merge-btn').click();
    await session.page.getByTestId('migration-modal').waitFor({ state: 'hidden', timeout: 12_000 });

    const deadline = Date.now() + 8000;
    let mergedXp = 0;
    while (Date.now() < deadline) {
      const saveVal = await readIdbKey(session.page, 'save:v1');
      if (saveVal.kind === 'json') {
        mergedXp = (saveVal.json as { xp?: number })?.xp ?? 0;
        if (mergedXp >= 117) break;
      }
      await session.page.waitForTimeout(250);
    }
    assert.ok(mergedXp >= 117, `Expected merged XP >= 117 from cloud V1 + local, got ${mergedXp}`);
    await session.page.getByTestId('tab-map').click();
    await session.page.getByTestId('player-chip').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
    await registry.cleanup();
  }
});

test('T4-S06: Playwright end-to-end browser journey against dist/ (guest ride + IDB + offline/online resilience)', async (t) => {
  if (!(await gateTest(t, { milestone: 'Baseline', requires: ['distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession({ allowOfflineErrors: true });
  try {
    await session.page.goto(`${server.baseUrl}/?sim=1&skip=1`, { waitUntil: 'domcontentloaded' });
    await session.page.getByTestId('create-screen').waitFor({ state: 'visible', timeout: 15_000 });
    await session.page.getByTestId('mode-bike').click();
    await session.page.getByTestId('step-next-0').click();
    await session.page.getByTestId('step-next-1').click();
    await session.page.getByTestId('hero-name').fill('Aventureiro E2E');
    await session.page.getByTestId('create-start').click();
    await session.page.getByTestId('tabbar').waitFor({ state: 'visible', timeout: 10_000 });

    // Offline ride
    await setExternalOffline(session, server.baseUrl, true);
    await session.page.getByTestId('tab-record').click();
    await session.page.getByTestId('start').click();
    await session.page.keyboard.down('ArrowUp');
    await session.page.waitForTimeout(1400);
    await session.page.keyboard.up('ArrowUp');
    await session.page.getByTestId('pause').click();
    await drainModals(session.page);
    await session.page.getByTestId('finish').click();
    const sawSummary = await drainModals(session.page, { expectSummary: true });
    assert.equal(sawSummary, true);
    await session.page.getByTestId('modal-ok').click();

    // Wait for debounced IDB persistence and reload while external network stays offline
    await session.page.waitForTimeout(1800);
    const keys = await listIdbKeys(session.page);
    assert.ok(keys.includes('save:v1'));
    assert.ok(keys.includes('fog:v2'));

    await session.page.reload({ waitUntil: 'domcontentloaded' });
    await session.page.getByTestId('tabbar').waitFor({ state: 'visible', timeout: 15_000 });
    await setExternalOffline(session, server.baseUrl, false);

    await session.page.getByTestId('tab-stats').click();
    await session.page.getByTestId('stats-scroll').waitFor({ state: 'visible', timeout: 10_000 });
    const profileText = await session.page.getByTestId('profile-card').innerText();
    assert.ok(profileText.includes('Aventureiro E2E'));
    await session.page.getByTestId('tab-map').click();
    const chip = await session.page.getByTestId('player-chip').innerText();
    assert.ok(chip.includes('Aventureiro E2E'));
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
  }
});

test('T4-S07: Authenticated multi-ride persistence -> clean logout -> wipeAll verification', async (t) => {
  if (!(await gateTest(t, { milestone: 'M3', requires: ['syncEngine', 'authUi', 'distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession();
  try {
    await session.page.route('https://lugwebngeyadfrqoapsg.supabase.co/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/auth/v1/user')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: '00000000-0000-0000-0000-000000000407',
            email: 's07@desbrava-e2e.test',
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await session.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'MultiRideLogout', modality: 'bike' });
    await recordBriefSimRide(session.page, 1200);
    await session.page.waitForTimeout(1800);

    const { fogABytes } = buildFogFixtures();
    await writeIdbKey(session.page, 'fog:v2', Array.from(fogABytes), true);
    await seedSupabaseWebSession(session.page, {
      userId: '00000000-0000-0000-0000-000000000407',
      email: 's07@desbrava-e2e.test',
    });

    await session.page.reload({ waitUntil: 'domcontentloaded' });
    await session.page.getByTestId('tabbar').waitFor({ state: 'visible', timeout: 10_000 });

    const keysBefore = await listIdbKeys(session.page);
    assert.ok(keysBefore.includes('save:v1'), 'Expected save:v1 before logout');
    assert.ok(keysBefore.includes('fog:v2'), 'Expected fog:v2 before logout');
    assert.ok(keysBefore.some((k) => k.startsWith('track:')), 'Expected track:* before logout');

    await session.page.getByTestId('tab-stats').click();
    await session.page.getByTestId('logout-btn').waitFor({ state: 'visible', timeout: 8000 });
    await session.page.getByTestId('logout-btn').click();

    const deadline = Date.now() + 6000;
    let wiped = false;
    while (Date.now() < deadline) {
      const keysAfter = await listIdbKeys(session.page);
      if (
        !keysAfter.includes('save:v1') &&
        !keysAfter.includes('fog:v2') &&
        !keysAfter.some((k) => k.startsWith('track:'))
      ) {
        wiped = true;
        break;
      }
      await session.page.waitForTimeout(200);
    }
    assert.equal(wiped, true, 'wipeAll() must clear save:v1, fog:v2, and track:* on clean logout');
    const ls = await readLocalStorageAll(session.page);
    assert.equal(ls['sb-lugwebngeyadfrqoapsg-auth-token'], undefined);
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
  }
});

test('T4-S08: Privacy toggle (is_public=false) & friend block mid-competition', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const uname = `t4s08_${Date.now().toString(36)}`;
    const a = await registry.provisionUser('t4s08_a', { username: uname, isPublic: true });
    const b = await registry.provisionUser('t4s08_b', { isPublic: true });
    await submitVerified(client, a.userId, a.accessToken, `act_s8_${Date.now()}`, buildVectorV1());

    const f = await client.rest<{ id: string }[]>('POST', 'friendships', {
      token: a.accessToken,
      prefer: 'return=representation',
      body: { requester_id: a.userId, addressee_id: b.userId, status: 'pending' },
    });
    assert.ok(f.ok, `f POST failed: ${f.rawText}`);
    const acc = await client.rest('PATCH', `friendships?id=eq.${f.data[0].id}`, {
      token: b.accessToken,
      body: { status: 'accepted' },
    });
    assert.ok(acc.ok, `f accept failed: ${acc.rawText}`);

    const privPatch = await client.rest('PATCH', `profiles?id=eq.${a.userId}`, {
      token: a.accessToken,
      body: { is_public: false },
    });
    assert.ok(privPatch.ok, `is_public patch failed: ${privPatch.rawText}`);
    const glb = await client.rpc<{ entries: { user_id?: string; id?: string }[] }>(
      'get_global_leaderboard',
      { p_metric: 'xp', p_period: 'all_time', p_limit: 50, p_offset: 0 },
      { token: b.accessToken },
    );
    assert.equal(glb.data.entries.some((e) => (e.user_id ?? e.id) === a.userId), false);

    const blk = await client.rest('PATCH', `friendships?id=eq.${f.data[0].id}`, {
      token: a.accessToken,
      body: { status: 'blocked' },
    });
    assert.ok(blk.ok, `friend block failed: ${blk.rawText}`);
    const flb = await client.rpc<{ user_id?: string; id?: string }[]>(
      'get_friends_leaderboard',
      { p_metric: 'xp', p_period: 'all_time' },
      { token: b.accessToken },
    );
    assert.equal(flb.data.some((r) => (r.user_id ?? r.id) === a.userId), false);
  } finally {
    await registry.cleanup();
  }
});

test('T4-S09: Multi-booster & multi-rarity POI expedition with exact wallet_ledger audit', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t4s09');
    await submitVerified(client, user.userId, user.accessToken, `act_s9_seed_${Date.now()}`, buildVectorV2(T0_MS));
    const items = await client.rest<{ id: string }[]>(
      'GET',
      'store_items?is_active=eq.true&category=eq.boost_xp&order=price_coins.asc&limit=1&select=id',
      { token: user.accessToken },
    );
    const buy = await client.rpc('purchase_store_item', { p_item_id: items.data[0].id, p_quantity: 1 }, { token: user.accessToken });
    assert.equal(buy.status, 200, `purchase_store_item failed: ${buy.rawText}`);

    const v2 = buildVectorV2(T0_MS + 3_600_000, 'poi_v2_s09');
    const buId = `bu_s9_${Date.now()}`;
    const actId = `act_s9_exp_${Date.now()}`;
    const boostIns = await client.rest('POST', 'user_boost_usages', {
      token: user.accessToken,
      body: {
        id: buId,
        user_id: user.userId,
        item_id: items.data[0].id,
        activity_id: actId,
        activated_at: new Date(v2.startedAt).toISOString(),
        expires_at: new Date(v2.endedAt + 300_000).toISOString(),
      },
    });
    assert.ok(boostIns.ok, `user_boost_usages insert failed: ${boostIns.rawText}`);
    const ver = await submitVerified(client, user.userId, user.accessToken, actId, v2, [buId]);
    assert.equal(ver.activity.xpEarned, v2.expectedXp * 2);

    const ledger = await client.rest<{ delta: number }[]>('GET', `wallet_ledger?user_id=eq.${user.userId}&select=delta`, {
      token: user.accessToken,
    });
    assert.equal(ledger.data.reduce((a, r) => a + r.delta, 0), ver.authoritative.wallet);
  } finally {
    await registry.cleanup();
  }
});

test('T4-S10: Deep-link invite onboarding (desbrava://add/<username> -> friendship -> Friends LB)', async (t) => {
  if (!(await gateTest(t, { milestone: 'M4', requires: ['schema', 'verifyActivity', 'serviceRoleKey', 'socialUi', 'distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession();
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const hostUname = `host_${Date.now().toString(36)}`;
    const host = await registry.provisionUser('t4s10_host', {
      username: hostUname,
      displayName: 'Host Link E2E',
      isPublic: true,
    });
    await submitVerified(client, host.userId, host.accessToken, `act_s10_${Date.now()}`, buildVectorV1());
    const invitee = await registry.provisionUser('t4s10_invitee', {
      displayName: 'Convidado Link',
      isPublic: true,
    });

    await session.page.goto(`${server.baseUrl}/?add=${encodeURIComponent(hostUname)}&sim=1`, {
      waitUntil: 'domcontentloaded',
    });
    await completeGuestOnboarding(session.page, { name: 'Convidado Link', modality: 'bike' });

    await openAuthModal(session.page);
    await signInViaAuthModal(session.page, invitee.email, invitee.password);
    await session.page.getByTestId('auth-modal').waitFor({ state: 'hidden', timeout: 12_000 });
    await session.page.waitForTimeout(1000);

    if (!(await session.page.getByTestId('friend-request-send').isVisible().catch(() => false))) {
      await session.page.getByTestId('tab-social').click();
    }
    await session.page.getByTestId('friend-request-send').waitFor({ state: 'visible', timeout: 10_000 });
    await session.page.getByTestId('friend-request-send').click();

    // Poll friendships row created by invitee -> host
    let friendshipId = '';
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const fRes = await client.rest<{ id: string; status: string }[]>(
        'GET',
        `friendships?requester_id=eq.${invitee.userId}&addressee_id=eq.${host.userId}&select=id,status`,
        { token: host.accessToken },
      );
      if (fRes.ok && Array.isArray(fRes.data) && fRes.data.length > 0) {
        friendshipId = fRes.data[0].id;
        break;
      }
      await session.page.waitForTimeout(250);
    }
    assert.ok(friendshipId.length > 0, 'Expected pending friendship row from invitee to host');

    const acc = await client.rest('PATCH', `friendships?id=eq.${friendshipId}`, {
      token: host.accessToken,
      body: { status: 'accepted' },
    });
    assert.ok(acc.ok, `Host accept failed: ${acc.rawText}`);

    await session.page.getByTestId('tab-social').click();
    await session.page.getByTestId('leaderboard-scope-friends').click();
    await session.page
      .getByText(new RegExp(`Host Link E2E|${hostUname}`))
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
    await registry.cleanup();
  }
});

test('T4-S11: Multi-city weekend tour with concurrent fog revision conflict resolution', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t4s11');
    // Migration 0007 caps upsert_fog_state.cell_count to SUM(verified activities.new_cells)
    await submitVerified(client, user.userId, user.accessToken, `act_s11_${Date.now()}`, buildVectorV1());
    const { fogA, fogB } = buildFogFixtures();
    const p = `${user.userId}/fog.bin`;

    await client.storageUpload('fog-snapshots', p, new Uint8Array(zlib.gzipSync(encodeDsbf(fogA))), { token: user.accessToken });
    const initFog = await client.rpc<UpsertFogResult>(
      'upsert_fog_state',
      { p_storage_path: p, p_cell_count: 3, p_expected_revision: 0 },
      { token: user.accessToken },
    );
    assert.equal(initFog.status, 200, `init upsert_fog_state failed: ${initFog.rawText}`);
    assert.equal(initFog.data.revision, 1);

    // Simulate Saturday device commit (revision 1 -> 2)
    const sat = await client.rpc<UpsertFogResult>(
      'upsert_fog_state',
      { p_storage_path: p, p_cell_count: 3, p_expected_revision: 1 },
      { token: user.accessToken },
    );
    assert.equal(sat.status, 200);
    assert.equal(sat.data.conflict, false);
    assert.equal(sat.data.revision, 2);

    // Sunday device hits stale CAS (revision=1), downloads, merges, and commits (revision 2 -> 3)
    const stale = await client.rpc<UpsertFogResult>(
      'upsert_fog_state',
      { p_storage_path: p, p_cell_count: 3, p_expected_revision: 1 },
      { token: user.accessToken },
    );
    assert.equal(stale.status, 200);
    assert.equal(stale.data.conflict, true);
    assert.equal(stale.data.revision, 2);

    const dl = await client.storageDownload('fog-snapshots', p, { token: user.accessToken });
    const remote = decodeDsbf(new Uint8Array(zlib.gunzipSync(dl.bytes)));
    assert.ok(remote);
    const merged = mergeDsbf(remote, fogB);
    await client.storageUpload('fog-snapshots', p, new Uint8Array(zlib.gzipSync(encodeDsbf(merged))), { token: user.accessToken });
    const win = await client.rpc<UpsertFogResult>(
      'upsert_fog_state',
      { p_storage_path: p, p_cell_count: merged.keys.length, p_expected_revision: 2 },
      { token: user.accessToken },
    );
    assert.equal(win.status, 200);
    assert.equal(win.data.conflict, false);
    assert.equal(win.data.revision, 3);
    assert.equal(win.data.cell_count, 4);
  } finally {
    await registry.cleanup();
  }
});
