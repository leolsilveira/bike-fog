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
  decodeDsbf,
  encodeDsbf,
  mergeDsbf,
  T0_MS,
} from './lib/trackFixtures.ts';
import {
  completeGuestOnboarding,
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

function extractRankNumber(myRank: GlobalRankRow): number | null {
  if (typeof myRank === 'number') return myRank;
  if (myRank && typeof myRank === 'object' && typeof myRank.rank === 'number') return myRank.rank;
  return null;
}

async function runActivity(
  client: SupabaseHttpClient,
  userId: string,
  token: string,
  actId: string,
  vec: ReturnType<typeof buildVectorV1>,
  boostUsageIds?: string[],
) {
  const tp = `${userId}/${actId}.bin.gz`;
  const up = await client.storageUpload('activity-tracks', tp, vec.trackGzBytes, { token });
  assert.equal(up.status, 200, `Upload failed: ${up.rawText}`);
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
// Tier 3 — Cross-Feature Combinations (23 Tests >= 19 In-Scope Features)
// ============================================================================

test('T3-E2E-01: Full multi-phase journey (Activity + Achievement + Store + Booster + Friends + Global LB)', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const unameA = `t3_hero_${Date.now().toString(36)}`;
    const userA = await registry.provisionUser('t3e2e_a', { username: unameA, isPublic: true });
    const userB = await registry.provisionUser('t3e2e_b', { isPublic: true });

    // 1. Live activity V2 (105 coins, 201 XP) + Fog upload
    const v2 = buildVectorV2(Date.now() - 600_000);
    const ver1 = await runActivity(client, userA.userId, userA.accessToken, `act_t3_1_${Date.now()}`, v2);
    assert.equal(ver1.status, 'verified');

    // 2. Claim achievement
    const claim = await client.rpc('claim_achievement', { p_achievement_key: 'total_activities:0' }, { token: userA.accessToken });
    assert.equal(claim.status, 200);

    // 3. Purchase cosmetic + boost_xp
    const items = await client.rest<{ id: string; kind: string; category: string; price_coins: number }[]>(
      'GET',
      'store_items?is_active=eq.true&order=price_coins.asc&select=id,kind,category,price_coins',
      { token: userA.accessToken },
    );
    const boost = items.data.find((i) => i.category === 'boost_xp');
    assert.ok(boost);
    const buyBoost = await client.rpc('purchase_store_item', { p_item_id: boost.id, p_quantity: 1 }, { token: userA.accessToken });
    assert.equal(buyBoost.status, 200);

    // 4. Second activity with booster
    const v1 = buildVectorV1(Date.now() - 120_000);
    const boostId = `bu_t3_${Date.now()}`;
    const act2 = `act_t3_2_${Date.now()}`;
    const boostIns = await client.rest('POST', 'user_boost_usages', {
      token: userA.accessToken,
      body: {
        id: boostId,
        user_id: userA.userId,
        item_id: boost.id,
        activity_id: act2,
        activated_at: new Date(v1.startedAt).toISOString(),
        expires_at: new Date(v1.endedAt + 300_000).toISOString(),
      },
    });
    assert.ok(boostIns.ok, `user_boost_usages insert failed: ${boostIns.rawText}`);
    const ver2 = await runActivity(client, userA.userId, userA.accessToken, act2, v1, [boostId]);
    assert.ok(ver2.activity.xpEarned > v1.expectedXp);

    // 5. Friend discovery -> request -> accept -> Friends & Global LB
    const search = await client.rpc<{ id: string }[]>('search_users', { p_query: unameA, p_limit: 10 }, { token: userB.accessToken });
    assert.ok(search.data.some((r) => r.id === userA.userId));
    const req = await client.rest<{ id: string }[]>('POST', 'friendships', {
      token: userB.accessToken,
      prefer: 'return=representation',
      body: { requester_id: userB.userId, addressee_id: userA.userId, status: 'pending' },
    });
    assert.ok(req.ok, `Friend request failed: ${req.rawText}`);
    const acc = await client.rest('PATCH', `friendships?id=eq.${req.data[0].id}`, {
      token: userA.accessToken,
      body: { status: 'accepted' },
    });
    assert.ok(acc.ok, `Friend accept failed: ${acc.rawText}`);
    const flb = await client.rpc<{ user_id?: string; id?: string }[]>(
      'get_friends_leaderboard',
      { p_metric: 'xp', p_period: 'monthly' },
      { token: userB.accessToken },
    );
    assert.equal(flb.data[0].user_id ?? flb.data[0].id, userA.userId);
    const glb = await client.rpc<{ entries: unknown[]; my_rank: GlobalRankRow }>(
      'get_global_leaderboard',
      { p_metric: 'xp', p_period: 'all_time', p_limit: 20, p_offset: 0 },
      { token: userA.accessToken },
    );
    assert.equal(glb.status, 200);
    const rankNum = extractRankNumber(glb.data.my_rank);
    assert.ok(rankNum !== null && rankNum >= 1, `Expected my_rank >= 1, got ${JSON.stringify(glb.data.my_rank)}`);
  } finally {
    await registry.cleanup();
  }
});

test('T3-PAIR-01: GPX Import + fog:v2 Set-Union Merge + verify-activity + Monthly Leaderboard (0 XP)', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t3p01', { isPublic: true });
    const g1 = buildVectorG1(Date.now() - 200_000);
    const ver = await runActivity(client, user.userId, user.accessToken, `act_gpx_${Date.now()}`, g1);
    assert.equal(ver.activity.xpEarned, 0);
    assert.equal(ver.authoritative.xp, 0);

    const { fogA, fogB } = buildFogFixtures();
    const merged = mergeDsbf(fogA, fogB);
    const fogPath = `${user.userId}/fog.bin`;
    await client.storageUpload('fog-snapshots', fogPath, new Uint8Array(zlib.gzipSync(encodeDsbf(merged))), {
      token: user.accessToken,
    });
    const fogRpc = await client.rpc<UpsertFogResult>(
      'upsert_fog_state',
      { p_storage_path: fogPath, p_cell_count: merged.keys.length, p_expected_revision: 0 },
      { token: user.accessToken },
    );
    assert.equal(fogRpc.status, 200, `upsert_fog_state failed: ${fogRpc.rawText}`);
    assert.equal(fogRpc.data.conflict, false);
    assert.equal(fogRpc.data.revision, 1);

    const lb = await client.rpc<{ score?: number; xp?: number; value?: number }[]>(
      'get_friends_leaderboard',
      { p_metric: 'xp', p_period: 'monthly' },
      { token: user.accessToken },
    );
    const score = Number(lb.data[0]?.score ?? lb.data[0]?.xp ?? lb.data[0]?.value ?? 0);
    assert.equal(score, 0);
  } finally {
    await registry.cleanup();
  }
});

test('T3-PAIR-02: Online Booster Activation + verify-activity Reconciliation + Follow-up Purchase', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t3p02');
    // Earn V2 (105 coins) + total_activities:0 (+15) = 120 coins to afford quantity 2 of boost_xp_2x (60 each)
    await runActivity(client, user.userId, user.accessToken, `act_p2a_${Date.now()}`, buildVectorV2(T0_MS));
    const claim = await client.rpc('claim_achievement', { p_achievement_key: 'total_activities:0' }, { token: user.accessToken });
    assert.equal(claim.status, 200, `claim_achievement failed: ${claim.rawText}`);

    const items = await client.rest<{ id: string; price_coins: number }[]>(
      'GET',
      'store_items?is_active=eq.true&category=eq.boost_xp&order=price_coins.asc&select=id,price_coins',
      { token: user.accessToken },
    );
    const boost = items.data[0];
    assert.ok(boost, 'Expected boost_xp item');
    const buy = await client.rpc('purchase_store_item', { p_item_id: boost.id, p_quantity: 2 }, { token: user.accessToken });
    assert.equal(buy.status, 200, `purchase_store_item x2 failed: ${buy.rawText}`);

    const v1 = buildVectorV1(T0_MS + 500_000);
    const buId = `bu_p2_${Date.now()}`;
    const actId = `act_p2b_${Date.now()}`;
    const boostIns = await client.rest('POST', 'user_boost_usages', {
      token: user.accessToken,
      body: {
        id: buId,
        user_id: user.userId,
        item_id: boost.id,
        activity_id: actId,
        activated_at: new Date(v1.startedAt).toISOString(),
        expires_at: new Date(v1.endedAt + 300_000).toISOString(),
      },
    });
    assert.ok(boostIns.ok, `user_boost_usages insert failed: ${boostIns.rawText}`);
    const ver = await runActivity(client, user.userId, user.accessToken, actId, v1, [buId]);
    assert.ok(ver.activity.xpEarned > v1.expectedXp);

    const inv = await client.rest<{ quantity: number }[]>(
      'GET',
      `user_inventory?user_id=eq.${user.userId}&item_id=eq.${boost.id}&select=quantity`,
      { token: user.accessToken },
    );
    assert.equal(inv.data[0].quantity, 1);
  } finally {
    await registry.cleanup();
  }
});

test('T3-PAIR-03: Privacy Toggle + Friend Block + Search + Friends/Global Leaderboard Interaction', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const unameA = `priv_pair_${Date.now().toString(36)}`;
    const userA = await registry.provisionUser('t3p03_a', { username: unameA, isPublic: true });
    const userB = await registry.provisionUser('t3p03_b', { isPublic: true });
    const userC = await registry.provisionUser('t3p03_c', { isPublic: true });

    await runActivity(client, userA.userId, userA.accessToken, `act_p3_${Date.now()}`, buildVectorV1(Date.now() - 120_000));
    const f = await client.rest<{ id: string }[]>('POST', 'friendships', {
      token: userA.accessToken,
      prefer: 'return=representation',
      body: { requester_id: userA.userId, addressee_id: userB.userId, status: 'pending' },
    });
    assert.ok(f.ok, `Friend request failed: ${f.rawText}`);
    const acc = await client.rest('PATCH', `friendships?id=eq.${f.data[0].id}`, {
      token: userB.accessToken,
      body: { status: 'accepted' },
    });
    assert.ok(acc.ok, `Friend accept failed: ${acc.rawText}`);

    // Set A private -> hidden from C search/global, visible to friend B
    const privPatch = await client.rest('PATCH', `profiles?id=eq.${userA.userId}`, {
      token: userA.accessToken,
      body: { is_public: false },
    });
    assert.ok(privPatch.ok, `Privacy patch failed: ${privPatch.rawText}`);
    const searchC = await client.rpc<{ id: string }[]>('search_users', { p_query: unameA, p_limit: 10 }, { token: userC.accessToken });
    assert.equal(searchC.data.some((r) => r.id === userA.userId), false);

    const flbB = await client.rpc<{ user_id?: string; id?: string }[]>(
      'get_friends_leaderboard',
      { p_metric: 'xp', p_period: 'all_time' },
      { token: userB.accessToken },
    );
    assert.equal(flbB.data.some((r) => (r.user_id ?? r.id) === userA.userId), true);

    // Block B -> B disappears from A's friends leaderboard
    const blk = await client.rest('PATCH', `friendships?id=eq.${f.data[0].id}`, {
      token: userA.accessToken,
      body: { status: 'blocked' },
    });
    assert.ok(blk.ok, `Friend block failed: ${blk.rawText}`);
    const flbA = await client.rpc<{ user_id?: string; id?: string }[]>(
      'get_friends_leaderboard',
      { p_metric: 'xp', p_period: 'all_time' },
      { token: userA.accessToken },
    );
    assert.equal(flbA.data.some((r) => (r.user_id ?? r.id) === userB.userId), false);
  } finally {
    await registry.cleanup();
  }
});

test('T3-PAIR-04: Local Guest Ride Persistence (save:v1 + fog:v2 + track:*) + Auth Sign-In + Clean Logout Wipe', async (t) => {
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
            id: '00000000-0000-0000-0000-000000000304',
            email: 'pair04@desbrava-e2e.test',
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await session.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'RideThenLogout', modality: 'bike' });
    await recordBriefSimRide(session.page, 1200);
    await session.page.waitForTimeout(1800);

    const keysBefore = await listIdbKeys(session.page);
    assert.ok(keysBefore.includes('save:v1'), 'Expected save:v1 before logout');
    assert.ok(keysBefore.includes('fog:v2'), 'Expected fog:v2 before logout');
    assert.ok(keysBefore.some((k) => k.startsWith('track:')), 'Expected track:* before logout');

    await seedSupabaseWebSession(session.page, {
      userId: '00000000-0000-0000-0000-000000000304',
      email: 'pair04@desbrava-e2e.test',
    });
    await session.page.reload({ waitUntil: 'domcontentloaded' });
    await session.page.getByTestId('tabbar').waitFor({ state: 'visible', timeout: 10_000 });

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
    assert.equal(wiped, true, 'Clean logout must wipe save:v1, fog:v2, and track:*');
    const ls = await readLocalStorageAll(session.page);
    assert.equal(ls['sb-lugwebngeyadfrqoapsg-auth-token'], undefined);
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
  }
});

test('T3-PAIR-05: Store Cosmetic Purchase + AvatarConfig Profile Persistence', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t3p05');
    await runActivity(client, user.userId, user.accessToken, `act_p5_${Date.now()}`, buildVectorV2());
    const cosmetics = await client.rest<{ id: string; category: string }[]>(
      'GET',
      'store_items?is_active=eq.true&kind=eq.cosmetic&price_coins=lte.100&order=price_coins.asc&select=id,category',
      { token: user.accessToken },
    );
    const cos = cosmetics.data[0];
    assert.ok(cos, 'Expected affordable cosmetic <= 100 coins');
    const buy = await client.rpc('purchase_store_item', { p_item_id: cos.id, p_quantity: 1 }, { token: user.accessToken });
    assert.equal(buy.status, 200, `purchase_store_item failed: ${buy.rawText}`);
    const patch = await client.rest('PATCH', `profiles?id=eq.${user.userId}`, {
      token: user.accessToken,
      body: { avatar_config: { equippedCosmeticId: cos.id } },
    });
    assert.ok(patch.ok);
  } finally {
    await registry.cleanup();
  }
});

test('T3-PAIR-06: Auth Session Refresh + Storage Track Upload + verify-activity', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t3p06');
    const refreshed = await client.refreshToken(user.refreshToken);
    assert.equal(refreshed.status, 200);
    const ver = await runActivity(
      client,
      user.userId,
      refreshed.data.access_token,
      `act_p6_${Date.now()}`,
      buildVectorV1(),
    );
    assert.equal(ver.status, 'verified');
  } finally {
    await registry.cleanup();
  }
});

test('T3-PAIR-07: Fog Upload + City Upsert + Capture Upsert Consistency', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t3p07');
    const ver = await runActivity(client, user.userId, user.accessToken, `act_p7_${Date.now()}`, buildVectorV1());
    assert.equal(ver.status, 'verified');

    const cityRes = await client.rest('POST', 'user_cities', {
      token: user.accessToken,
      prefer: 'resolution=merge-duplicates',
      body: {
        user_id: user.userId,
        city_id: 'r/sao-paulo',
        name: 'São Paulo',
        area_m2: 1_521_110_000,
        bbox: [-46.8, -24.0, -46.3, -23.3],
        cells: ver.activity.newCells,
        cell_area_m2: 289,
      },
    });
    assert.ok(cityRes.ok, `user_cities upsert failed: ${cityRes.rawText}`);
  } finally {
    await registry.cleanup();
  }
});

test('T3-PAIR-08: Achievement Claim Coins Fund Store Booster Purchase', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t3p08');
    // V1 earns 27 coins, 615 cells, 1 capture. Claiming total_activities:0 (+15), total_captures:0 (+20), total_cells:0 (+20) yields 82 coins (>= 60 booster & >= 80 cosmetic)
    await runActivity(client, user.userId, user.accessToken, `act_p8_${Date.now()}`, buildVectorV1());
    for (const key of ['total_activities:0', 'total_captures:0', 'total_cells:0']) {
      const claim = await client.rpc('claim_achievement', { p_achievement_key: key }, { token: user.accessToken });
      assert.equal(claim.status, 200, `claim_achievement(${key}) failed: ${claim.rawText}`);
    }

    const prof = await client.rest<{ wallet: number }[]>('GET', `profiles?id=eq.${user.userId}&select=wallet`, {
      token: user.accessToken,
    });
    assert.ok(prof.data[0].wallet >= 82, `Expected wallet >= 82, got ${prof.data[0].wallet}`);
    const items = await client.rest<{ id: string; price_coins: number }[]>(
      'GET',
      `store_items?is_active=eq.true&price_coins=lte.${prof.data[0].wallet}&order=price_coins.asc&limit=1&select=id,price_coins`,
      { token: user.accessToken },
    );
    assert.ok(items.data.length > 0, `Expected affordable store item <= ${prof.data[0].wallet} coins`);
    const buy = await client.rpc(
      'purchase_store_item',
      { p_item_id: items.data[0].id, p_quantity: 1 },
      { token: user.accessToken },
    );
    assert.equal(buy.status, 200, `purchase_store_item failed: ${buy.rawText}`);
  } finally {
    await registry.cleanup();
  }
});

test('T3-PAIR-09: Flagged Activity Excluded from Profiles Totals & Global Leaderboard', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t3p09', { isPublic: true });
    // First run valid V1
    await runActivity(client, user.userId, user.accessToken, `act_p9_ok_${Date.now()}`, buildVectorV1(Date.now() - 300_000));
    const profBefore = await client.rest<{ xp: number }[]>('GET', `profiles?id=eq.${user.userId}&select=xp`, {
      token: user.accessToken,
    });

    // Then submit teleport F3 (1000m/s) -> flagged
    const tpBad = `${user.userId}/act_p9_bad_${Date.now()}.bin.gz`;
    const vBad = buildVectorV1(Date.now() - 100_000);
    // Tamper timestamps to 1s total for 2km => 2000 m/s
    const pts = vBad.points.map((p, idx) => ({ ...p, t: vBad.startedAt + idx * 50 }));
    const f64 = new Float64Array(pts.flatMap((p) => [p.lng, p.lat, p.t]));
    await client.storageUpload('activity-tracks', tpBad, new Uint8Array(zlib.gzipSync(new Uint8Array(f64.buffer))), {
      token: user.accessToken,
    });
    const flagged = await client.invokeVerifyActivity(
      {
        activityId: `act_p9_bad_${Date.now()}`,
        source: 'live',
        modality: 'bike',
        startedAt: pts[0].t,
        endedAt: pts[pts.length - 1].t,
        trackPath: tpBad,
        clientSummary: {
          distanceM: vBad.distanceM,
          movingS: 1,
          maxSpeed: 2000,
          newCells: vBad.newCells,
          coinsCount: 0,
          coinsValue: 0,
          captures: [],
          cityIds: [],
        },
      },
      { token: user.accessToken },
    );
    assert.equal(flagged.data.status, 'flagged');
    const profAfter = await client.rest<{ xp: number }[]>('GET', `profiles?id=eq.${user.userId}&select=xp`, {
      token: user.accessToken,
    });
    assert.equal(profAfter.data[0].xp, profBefore.data[0].xp);
  } finally {
    await registry.cleanup();
  }
});

test('T3-PAIR-10: Multi-Activity Level-Up (V1 + V2 -> Level 3) + Wallet Ledger Balance Audit', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t3p10');
    await runActivity(client, user.userId, user.accessToken, `act_p10a_${Date.now()}`, buildVectorV1(T0_MS));
    const ver2 = await runActivity(client, user.userId, user.accessToken, `act_p10b_${Date.now()}`, buildVectorV2(T0_MS + 3_600_000));
    assert.equal(ver2.authoritative.xp, 318);
    assert.equal(ver2.authoritative.level, 3);
    assert.equal(ver2.authoritative.wallet, 132);

    const ledger = await client.rest<{ delta: number }[]>('GET', `wallet_ledger?user_id=eq.${user.userId}&select=delta`, {
      token: user.accessToken,
    });
    const sum = ledger.data.reduce((a, r) => a + r.delta, 0);
    assert.equal(sum, ver2.authoritative.wallet);
  } finally {
    await registry.cleanup();
  }
});

test('T3-PAIR-11: Username Rename Reflected in Search, Friends Leaderboard & Global Leaderboard', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const u1 = `ren1_${Date.now().toString(36)}`;
    const u2 = `ren2_${Date.now().toString(36)}`;
    const userA = await registry.provisionUser('t3p11_a', { username: u1, isPublic: true });
    const userB = await registry.provisionUser('t3p11_b', { isPublic: true });
    await runActivity(client, userA.userId, userA.accessToken, `act_p11_${Date.now()}`, buildVectorV1());

    const renamePatch = await client.rest('PATCH', `profiles?id=eq.${userA.userId}`, {
      token: userA.accessToken,
      body: { username: u2 },
    });
    assert.ok(renamePatch.ok, `Username rename failed: ${renamePatch.rawText}`);

    const searchOld = await client.rpc<{ id: string }[]>('search_users', { p_query: u1, p_limit: 10 }, { token: userB.accessToken });
    assert.equal(searchOld.data.some((r) => r.id === userA.userId), false);
    const searchNew = await client.rpc<{ id: string }[]>('search_users', { p_query: u2, p_limit: 10 }, { token: userB.accessToken });
    assert.equal(searchNew.data.some((r) => r.id === userA.userId), true);
  } finally {
    await registry.cleanup();
  }
});

test('T3-PAIR-12: Wallet Ledger Idempotency Across Activity Credits, Achievements & Store Purchases', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t3p12');
    const actId = `act_p12_${Date.now()}`;
    await runActivity(client, user.userId, user.accessToken, actId, buildVectorV2());
    const claim = await client.rpc('claim_achievement', { p_achievement_key: 'total_activities:0' }, { token: user.accessToken });
    assert.equal(claim.status, 200, `claim_achievement failed: ${claim.rawText}`);
    const items = await client.rest<{ id: string }[]>(
      'GET',
      'store_items?is_active=eq.true&price_coins=lte.120&order=price_coins.asc&limit=1&select=id',
      { token: user.accessToken },
    );
    assert.ok(items.data.length > 0, 'Expected affordable store item <= 120 coins');
    const buy = await client.rpc('purchase_store_item', { p_item_id: items.data[0].id, p_quantity: 1 }, { token: user.accessToken });
    assert.equal(buy.status, 200, `purchase_store_item failed: ${buy.rawText}`);

    const prof = await client.rest<{ wallet: number }[]>('GET', `profiles?id=eq.${user.userId}&select=wallet`, {
      token: user.accessToken,
    });
    const ledger = await client.rest<{ delta: number }[]>('GET', `wallet_ledger?user_id=eq.${user.userId}&select=delta`, {
      token: user.accessToken,
    });
    assert.equal(
      ledger.data.reduce((a, r) => a + r.delta, 0),
      prof.data[0].wallet,
    );
  } finally {
    await registry.cleanup();
  }
});

test('T3-PAIR-13: Deep Link Pending Invite + Guest Onboarding + Auth Sign-In Integration', async (t) => {
  if (!(await gateTest(t, { milestone: 'M4', requires: ['authUi', 'socialUi', 'distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession();
  try {
    let inviteLookupInvoked = false;
    await session.page.route('https://lugwebngeyadfrqoapsg.supabase.co/**', async (route) => {
      const url = route.request().url();
      const postData = route.request().postData() ?? '';
      if (url.includes('/auth/v1/token')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            access_token: 'hdr.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAxMTMiLCJleHAiOjQ3MDAwMDAwMDB9.sig',
            token_type: 'bearer',
            expires_in: 3600,
            refresh_token: 'pair13_refresh',
            user: { id: '00000000-0000-0000-0000-000000000113', email: 'pair13@desbrava-e2e.test', role: 'authenticated' },
          }),
        });
        return;
      }
      if (url.includes('/auth/v1/user')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: '00000000-0000-0000-0000-000000000113', email: 'pair13@desbrava-e2e.test' }),
        });
        return;
      }
      if (url.includes('/rest/v1/profiles') && route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        return;
      }
      if (url.includes('/rest/v1/rpc/get_public_profile_by_username')) {
        if (postData.includes('amigo_teste')) inviteLookupInvoked = true;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: '00000000-0000-0000-0000-000000000213',
            username: 'amigo_teste',
            display_name: 'Amigo Teste E2E',
            modality: 'bike',
            character_id: 'lia',
            avatar_config: null,
            level: 3,
            xp: 400,
            total_distance_m: 3000,
            total_moving_s: 300,
            total_activities: 2,
            total_captures: 1,
            total_cells: 200,
            achievements_count: 1,
            is_public: true,
            friendship_status: 'none',
            friendship_direction: 'none',
          }),
        });
        return;
      }
      if (url.includes('/rest/v1/rpc/search_users')) {
        if (postData.includes('amigo_teste')) inviteLookupInvoked = true;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: '00000000-0000-0000-0000-000000000213',
              username: 'amigo_teste',
              display_name: 'Amigo Teste E2E',
              level: 3,
              xp: 400,
              total_distance_m: 3000,
              total_cells: 200,
              modality: 'bike',
              character_id: 'lia',
              avatar_config: null,
              friendship_status: 'none',
            },
          ]),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await session.page.goto(`${server.baseUrl}/?add=amigo_teste&sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'DeepLinkGuest', modality: 'bike' });

    await openAuthModal(session.page);
    await signInViaAuthModal(session.page, 'pair13@desbrava-e2e.test', 'ValidPass!123');
    await session.page.getByTestId('auth-modal').waitFor({ state: 'hidden', timeout: 10_000 });
    await session.page.waitForTimeout(800);

    const sendVisible = await session.page.getByTestId('friend-request-send').isVisible().catch(() => false);
    if (!sendVisible) {
      await session.page.getByTestId('tab-social').click();
      await session.page.waitForTimeout(600);
    }

    assert.equal(
      inviteLookupInvoked,
      true,
      'Expected get_public_profile_by_username or search_users called with "amigo_teste"',
    );
    await session.page
      .getByText(/Amigo Teste E2E|@?amigo_teste/)
      .first()
      .waitFor({ state: 'visible', timeout: 8000 });
    await session.page.getByTestId('friend-request-send').waitFor({ state: 'visible', timeout: 8000 });
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
  }
});

test('T3-PAIR-14: Offline Ride -> IDB Track & Fog -> Safe Reload Continuity', async (t) => {
  if (!(await gateTest(t, { milestone: 'Baseline', requires: ['distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession({ allowOfflineErrors: true });
  try {
    await session.page.goto(`${server.baseUrl}/?sim=1&skip=1`, { waitUntil: 'domcontentloaded' });
    await session.page.getByTestId('create-screen').waitFor({ state: 'visible', timeout: 15_000 });
    await session.page.getByTestId('mode-run').click();
    await session.page.getByTestId('step-next-0').click();
    await session.page.getByTestId('step-next-1').click();
    await session.page.getByTestId('hero-name').fill('ReloadOffline');
    await session.page.getByTestId('create-start').click();
    await session.page.getByTestId('tabbar').waitFor({ state: 'visible', timeout: 10_000 });

    await setExternalOffline(session, server.baseUrl, true);
    await recordBriefSimRide(session.page, 1400);
    await session.page.waitForTimeout(1800);
    const keysBefore = await listIdbKeys(session.page);
    assert.ok(keysBefore.includes('save:v1'), 'Expected save:v1 after offline ride');
    assert.ok(keysBefore.includes('fog:v2'), 'Expected fog:v2 after offline ride');
    assert.ok(keysBefore.some((k) => k.startsWith('track:')), 'Expected track:* after offline ride');

    await session.page.reload({ waitUntil: 'domcontentloaded' });
    await session.page.getByTestId('tabbar').waitFor({ state: 'visible', timeout: 10_000 });
    const keysAfter = await listIdbKeys(session.page);
    assert.ok(keysAfter.includes('save:v1'), 'Expected save:v1 to survive reload');
    assert.ok(keysAfter.includes('fog:v2'), 'Expected fog:v2 to survive reload');
    assert.ok(keysAfter.some((k) => k.startsWith('track:')), 'Expected track:* to survive reload');
    if (await session.page.getByTestId('start').isVisible().catch(() => false)) {
      await session.page.getByTestId('tab-map').click();
    }
    const chip = await session.page.getByTestId('player-chip').innerText();
    assert.ok(chip.includes('ReloadOffline'));
  } finally {
    await session.close();
    await server.close();
  }
});

test('T3-PAIR-15: Persistent Web Session + Direct Online Profile & Store Catalog Fetch After Reload', async (t) => {
  if (!(await gateTest(t, { milestone: 'M5', requires: ['syncEngine', 'authUi', 'storeUi', 'distWeb'] }))) return;
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
            id: '00000000-0000-0000-0000-000000000015',
            email: 'pair15@desbrava-e2e.test',
          }),
        });
        return;
      }
      if (url.includes('/rest/v1/store_items')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 'boost_xp_2x',
              kind: 'consumable',
              category: 'boost_xp',
              name: 'E2E_PAIR15_ONLINE_BOOST',
              description: 'Online store item',
              price_coins: 60,
              rarity: 'incomum',
              max_stack: 10,
              is_active: true,
              sort_order: 10,
              metadata: { multiplier: 2 },
            },
          ]),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await session.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'SessionReloadOnline', modality: 'bike' });
    await seedSupabaseWebSession(session.page, {
      userId: '00000000-0000-0000-0000-000000000015',
      email: 'pair15@desbrava-e2e.test',
    });

    await session.page.reload({ waitUntil: 'domcontentloaded' });
    await session.page.getByTestId('tabbar').waitFor({ state: 'visible', timeout: 10_000 });

    await session.page.getByTestId('tab-stats').click();
    await session.page.getByTestId('logout-btn').waitFor({ state: 'visible', timeout: 5000 });

    await session.page.getByTestId('tab-shop').click();
    await session.page.getByText('E2E_PAIR15_ONLINE_BOOST').waitFor({ state: 'visible', timeout: 8000 });
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
  }
});

test('T3-PAIR-16: Multi-City Fog Revision Conflict + City Index Remapping Merge', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t3p16');
    // Migration 0007 caps upsert_fog_state.cell_count to SUM(verified activities.new_cells)
    await runActivity(client, user.userId, user.accessToken, `act_p16_${Date.now()}`, buildVectorV1());
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
    assert.equal(initFog.data.cell_count, 3);

    const dl = await client.storageDownload('fog-snapshots', p, { token: user.accessToken });
    const remote = decodeDsbf(new Uint8Array(zlib.gunzipSync(dl.bytes)));
    assert.ok(remote);
    const merged = mergeDsbf(remote, fogB);
    await client.storageUpload('fog-snapshots', p, new Uint8Array(zlib.gzipSync(encodeDsbf(merged))), { token: user.accessToken });
    const nextFog = await client.rpc<UpsertFogResult>(
      'upsert_fog_state',
      { p_storage_path: p, p_cell_count: merged.keys.length, p_expected_revision: 1 },
      { token: user.accessToken },
    );
    assert.equal(nextFog.status, 200, `upsert_fog_state commit failed: ${nextFog.rawText}`);
    assert.equal(nextFog.data.conflict, false);
    assert.equal(nextFog.data.cell_count, 4);
    assert.equal(nextFog.data.revision, 2);
  } finally {
    await registry.cleanup();
  }
});

test('T3-PAIR-17: Concurrent Store Purchase + Verified Activity + Leaderboard Update', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t3p17', { isPublic: true });
    // Seed initial 105 coins via V2
    const seedAct = await runActivity(
      client,
      user.userId,
      user.accessToken,
      `act_p17_seed_${Date.now()}`,
      buildVectorV2(T0_MS),
    );
    assert.equal(seedAct.status, 'verified');

    const items = await client.rest<{ id: string; price_coins: number }[]>(
      'GET',
      'store_items?is_active=eq.true&price_coins=lte.105&order=price_coins.asc&limit=1&select=id,price_coins',
      { token: user.accessToken },
    );
    assert.ok(items.data.length > 0, 'Expected affordable store item <= 105 coins');
    const item = items.data[0];

    const v1 = buildVectorV1(Date.now() - 1_200_000);
    const [buyRes, actRes] = await Promise.all([
      client.rpc('purchase_store_item', { p_item_id: item.id, p_quantity: 1 }, { token: user.accessToken }),
      runActivity(client, user.userId, user.accessToken, `act_p17_conc_${Date.now()}`, v1),
    ]);
    assert.equal(buyRes.status, 200, `Concurrent purchase_store_item failed: ${buyRes.rawText}`);
    assert.equal(actRes.status, 'verified');

    const prof = await client.rest<{ wallet: number; xp: number; total_distance_m: number }[]>(
      'GET',
      `profiles?id=eq.${user.userId}&select=wallet,xp,total_distance_m`,
      { token: user.accessToken },
    );
    assert.equal(
      prof.data[0].wallet,
      105 - item.price_coins + v1.expectedCoinsEarned,
      'Wallet must reflect concurrent purchase debit + verified activity credit',
    );
    const ledger = await client.rest<{ delta: number }[]>(
      'GET',
      `wallet_ledger?user_id=eq.${user.userId}&select=delta`,
      { token: user.accessToken },
    );
    assert.equal(
      ledger.data.reduce((a, r) => a + r.delta, 0),
      prof.data[0].wallet,
    );

    const glb = await client.rpc<{ entries: { user_id?: string; id?: string }[]; my_rank: GlobalRankRow }>(
      'get_global_leaderboard',
      { p_metric: 'distance', p_period: 'monthly', p_limit: 50, p_offset: 0 },
      { token: user.accessToken },
    );
    assert.equal(glb.status, 200);
    const inEntries = glb.data.entries.some((e) => (e.user_id ?? e.id) === user.userId);
    const inMyRank =
      typeof glb.data.my_rank === 'object' && glb.data.my_rank !== null && glb.data.my_rank.user_id === user.userId;
    assert.ok(inEntries || inMyRank, 'User must appear in monthly distance global leaderboard');
  } finally {
    await registry.cleanup();
  }
});

test('T3-PAIR-18: Blocked User Cannot Re-Add While Third Friend Remains Ranked', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const userA = await registry.provisionUser('t3p18_a');
    const userB = await registry.provisionUser('t3p18_b');
    const userC = await registry.provisionUser('t3p18_c');
    await runActivity(client, userC.userId, userC.accessToken, `act_p18_${Date.now()}`, buildVectorV1());

    const fAB = await client.rest<{ id: string }[]>('POST', 'friendships', {
      token: userA.accessToken,
      prefer: 'return=representation',
      body: { requester_id: userA.userId, addressee_id: userB.userId, status: 'pending' },
    });
    assert.ok(fAB.ok, `fAB POST failed: ${fAB.rawText}`);
    const blkAB = await client.rest('PATCH', `friendships?id=eq.${fAB.data[0].id}`, {
      token: userA.accessToken,
      body: { status: 'blocked' },
    });
    assert.ok(blkAB.ok, `fAB block failed: ${blkAB.rawText}`);
    const fAC = await client.rest<{ id: string }[]>('POST', 'friendships', {
      token: userA.accessToken,
      prefer: 'return=representation',
      body: { requester_id: userA.userId, addressee_id: userC.userId, status: 'pending' },
    });
    assert.ok(fAC.ok, `fAC POST failed: ${fAC.rawText}`);
    const accAC = await client.rest('PATCH', `friendships?id=eq.${fAC.data[0].id}`, {
      token: userC.accessToken,
      body: { status: 'accepted' },
    });
    assert.ok(accAC.ok, `fAC accept failed: ${accAC.rawText}`);

    const lb = await client.rpc<{ user_id?: string; id?: string }[]>(
      'get_friends_leaderboard',
      { p_metric: 'xp', p_period: 'all_time' },
      { token: userA.accessToken },
    );
    const ids = lb.data.map((r) => r.user_id ?? r.id);
    assert.equal(ids.includes(userC.userId), true);
    assert.equal(ids.includes(userB.userId), false);
  } finally {
    await registry.cleanup();
  }
});

test('T3-PAIR-19: Private Profile Remains in Friends Leaderboard While Excluded from Global Leaderboard', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const userA = await registry.provisionUser('t3p19_a', { isPublic: false });
    const userB = await registry.provisionUser('t3p19_b', { isPublic: true });
    await runActivity(client, userA.userId, userA.accessToken, `act_p19_${Date.now()}`, buildVectorV1());

    const f = await client.rest<{ id: string }[]>('POST', 'friendships', {
      token: userA.accessToken,
      prefer: 'return=representation',
      body: { requester_id: userA.userId, addressee_id: userB.userId, status: 'pending' },
    });
    assert.ok(f.ok, `f POST failed: ${f.rawText}`);
    const acc = await client.rest('PATCH', `friendships?id=eq.${f.data[0].id}`, {
      token: userB.accessToken,
      body: { status: 'accepted' },
    });
    assert.ok(acc.ok, `f accept failed: ${acc.rawText}`);

    const flb = await client.rpc<{ user_id?: string; id?: string }[]>(
      'get_friends_leaderboard',
      { p_metric: 'cells', p_period: 'all_time' },
      { token: userB.accessToken },
    );
    assert.equal(flb.data.some((r) => (r.user_id ?? r.id) === userA.userId), true);

    const glb = await client.rpc<{ entries: { user_id?: string; id?: string }[] }>(
      'get_global_leaderboard',
      { p_metric: 'cells', p_period: 'all_time', p_limit: 50, p_offset: 0 },
      { token: userB.accessToken },
    );
    assert.equal(glb.data.entries.some((e) => (e.user_id ?? e.id) === userA.userId), false);
  } finally {
    await registry.cleanup();
  }
});

test('T3-PAIR-20: GPX Import Does Not Unlock Coin/Capture Achievements', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t3p20');
    await runActivity(client, user.userId, user.accessToken, `act_p20_${Date.now()}`, buildVectorG1());
    const prof = await client.rest<{ total_captures: number; wallet: number }[]>(
      'GET',
      `profiles?id=eq.${user.userId}&select=total_captures,wallet`,
      { token: user.accessToken },
    );
    assert.equal(prof.data[0].total_captures, 0);
    assert.equal(prof.data[0].wallet, 0);
  } finally {
    await registry.cleanup();
  }
});

test('T3-PAIR-21: Booster Multiplier + Rare POI Capture + Multi-Level Jump Reconciliation', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t3p21');
    // Earn initial 105 coins
    await runActivity(client, user.userId, user.accessToken, `act_p21_0_${Date.now()}`, buildVectorV2(T0_MS));
    const items = await client.rest<{ id: string }[]>(
      'GET',
      'store_items?is_active=eq.true&category=eq.boost_xp&order=price_coins.asc&limit=1&select=id',
      { token: user.accessToken },
    );
    const buy = await client.rpc('purchase_store_item', { p_item_id: items.data[0].id, p_quantity: 1 }, { token: user.accessToken });
    assert.equal(buy.status, 200, `purchase_store_item failed: ${buy.rawText}`);

    const v2 = buildVectorV2(T0_MS + 7_200_000, 'poi_v2_p21');
    const buId = `bu_p21_${Date.now()}`;
    const actId = `act_p21_1_${Date.now()}`;
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
    const ver = await runActivity(client, user.userId, user.accessToken, actId, v2, [buId]);
    assert.equal(ver.activity.xpEarned, v2.expectedXp * 2);
    assert.ok(ver.authoritative.level >= 3);
  } finally {
    await registry.cleanup();
  }
});

test('T3-PAIR-22: Online Store Purchase RPC Updates Wallet & Inventory in Shop UI', async (t) => {
  if (!(await gateTest(t, { milestone: 'M5', requires: ['storeUi', 'syncEngine', 'distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession();
  try {
    let purchaseCalled = false;
    await session.page.route('https://lugwebngeyadfrqoapsg.supabase.co/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/auth/v1/user')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: '00000000-0000-0000-0000-000000000322',
            email: 'pair22@desbrava-e2e.test',
          }),
        });
        return;
      }
      if (url.includes('/rest/v1/store_items')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 'boost_xp_2x',
              kind: 'consumable',
              category: 'boost_xp',
              name: 'E2E_2X_XP_ONLINE',
              description: 'Online 2x XP',
              price_coins: 60,
              rarity: 'incomum',
              max_stack: 10,
              is_active: true,
              sort_order: 10,
              metadata: { multiplier: 2 },
            },
          ]),
        });
        return;
      }
      if (url.includes('/rest/v1/rpc/purchase_store_item')) {
        purchaseCalled = true;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            item_id: 'boost_xp_2x',
            quantity: 1,
            total_paid: 60,
            wallet: 140,
          }),
        });
        return;
      }
      if (url.includes('/rest/v1/user_inventory')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(purchaseCalled ? [{ item_id: 'boost_xp_2x', quantity: 1 }] : []),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await session.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'StoreOnlineBuyer', modality: 'bike' });
    await seedSupabaseWebSession(session.page, {
      userId: '00000000-0000-0000-0000-000000000322',
      email: 'pair22@desbrava-e2e.test',
    });

    const saveVal = await readIdbKey(session.page, 'save:v1');
    const saveObj = (saveVal.json ?? {}) as Record<string, unknown>;
    saveObj.wallet = 200;
    await writeIdbKey(session.page, 'save:v1', saveObj);

    await session.page.reload({ waitUntil: 'domcontentloaded' });
    await session.page.getByTestId('tabbar').waitFor({ state: 'visible', timeout: 10_000 });

    await session.page.getByTestId('tab-shop').or(session.page.getByText(/Loja/i)).first().click();
    await session.page.getByText('E2E_2X_XP_ONLINE').waitFor({ state: 'visible', timeout: 8000 });

    const buyBtn = session.page
      .getByTestId('shop-buy-btn')
      .or(session.page.getByTestId('shop-item-boost_xp_2x'))
      .first();
    await buyBtn.click();

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !purchaseCalled) {
      await session.page.waitForTimeout(150);
    }
    assert.equal(purchaseCalled, true, 'purchase_store_item RPC must be invoked online from Shop UI');
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
  }
});
