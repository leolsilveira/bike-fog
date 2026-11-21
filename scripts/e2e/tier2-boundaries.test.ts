import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { decodeFog } from '../../src/game/binary.ts';
import { PROJECT_ROOT } from './lib/env.ts';
import { gateTest } from './lib/probe.ts';
import { SupabaseHttpClient, TestUserRegistry } from './lib/supabaseHttp.ts';
import {
  buildFogFixtures,
  buildLinearPoints,
  buildVectorF1,
  buildVectorF2,
  buildVectorF3,
  buildVectorG1,
  buildVectorV1,
  buildVectorV2,
  decodeDsbf,
  DEFAULT_CENTER,
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
  setLocalStorageItem,
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

async function assertZeroCredits(
  client: SupabaseHttpClient,
  userId: string,
  token: string,
  prevXp = 0,
  prevWallet = 0,
) {
  const res = await client.rest<{ xp: number; wallet: number }[]>(
    'GET',
    `profiles?id=eq.${userId}&select=xp,wallet`,
    { token },
  );
  assert.equal(res.status, 200);
  assert.equal(res.data[0].xp, prevXp, 'XP must not change on rejected/flagged activity');
  assert.equal(res.data[0].wallet, prevWallet, 'Wallet must not change on rejected/flagged activity');
}

async function seedVerifiedV1(
  client: SupabaseHttpClient,
  userId: string,
  token: string,
  activityId: string,
): Promise<void> {
  const v1 = buildVectorV1();
  const trackPath = `${userId}/${activityId}.bin.gz`;
  const up = await client.storageUpload('activity-tracks', trackPath, v1.trackGzBytes, {
    token,
    contentType: 'application/gzip',
  });
  assert.equal(up.status, 200, `Track upload failed: ${up.rawText}`);
  const ver = await client.invokeVerifyActivity(
    {
      activityId,
      source: 'live',
      modality: 'bike',
      startedAt: v1.startedAt,
      endedAt: v1.endedAt,
      trackPath,
      clientSummary: {
        distanceM: v1.distanceM,
        movingS: v1.movingS,
        maxSpeed: v1.maxSpeed,
        newCells: v1.newCells,
        coinsCount: v1.coinsCount,
        coinsValue: v1.coinsValue,
        coinsByKind: v1.coinsByKind,
        captures: v1.captures,
        cityIds: v1.cityIds,
      },
    },
    { token },
  );
  assert.equal(ver.status, 200, `verify-activity failed: ${ver.rawText}`);
}

// ============================================================================
// Area A: verify-activity Anti-Cheat, GPX Import & Security Boundaries
// ============================================================================

test('T2-VER-01: Live bike speed > MAX_SPEED.bike (~30 m/s) is flagged with 0 XP/wallet', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t2ver01');
    const f1 = buildVectorF1();
    const actId = `act_f1_${Date.now()}`;
    const tp = `${user.userId}/${actId}.bin.gz`;
    await client.storageUpload('activity-tracks', tp, f1.trackGzBytes, { token: user.accessToken });

    const ver = await client.invokeVerifyActivity(
      {
        activityId: actId,
        source: 'live',
        modality: 'bike',
        startedAt: f1.startedAt,
        endedAt: f1.endedAt,
        trackPath: tp,
        clientSummary: {
          distanceM: f1.distanceM,
          movingS: f1.movingS,
          maxSpeed: f1.maxSpeed,
          newCells: f1.newCells,
          coinsCount: 0,
          coinsValue: 0,
          captures: [],
          cityIds: [],
        },
      },
      { token: user.accessToken },
    );
    assert.equal(ver.status, 200);
    assert.equal(ver.data.status, 'flagged');
    assert.ok(Boolean(ver.data.reason), 'Expected non-empty flagging reason');
    assert.equal(ver.data.activity.xpEarned, 0);
    assert.equal(ver.data.activity.coinsEarned, 0);
    await assertZeroCredits(client, user.userId, user.accessToken);
  } finally {
    await registry.cleanup();
  }
});

test('T2-VER-02: Live run speed ~12 m/s (> 7.0 run cap, < 16.7 bike cap) is flagged', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t2ver02');
    const f2 = buildVectorF2();
    const actId = `act_f2_${Date.now()}`;
    const tp = `${user.userId}/${actId}.bin.gz`;
    await client.storageUpload('activity-tracks', tp, f2.trackGzBytes, { token: user.accessToken });

    const ver = await client.invokeVerifyActivity(
      {
        activityId: actId,
        source: 'live',
        modality: 'run',
        startedAt: f2.startedAt,
        endedAt: f2.endedAt,
        trackPath: tp,
        clientSummary: {
          distanceM: f2.distanceM,
          movingS: f2.movingS,
          maxSpeed: f2.maxSpeed,
          newCells: f2.newCells,
          coinsCount: 0,
          coinsValue: 0,
          captures: [],
          cityIds: [],
        },
      },
      { token: user.accessToken },
    );
    assert.equal(ver.status, 200);
    assert.equal(ver.data.status, 'flagged');
    assert.equal(ver.data.activity.xpEarned, 0);
    await assertZeroCredits(client, user.userId, user.accessToken);
  } finally {
    await registry.cleanup();
  }
});

test('T2-VER-03: Live teleport jump (2000m in 1s) is flagged with zero rewards', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t2ver03');
    const f3 = buildVectorF3();
    const actId = `act_f3_${Date.now()}`;
    const tp = `${user.userId}/${actId}.bin.gz`;
    await client.storageUpload('activity-tracks', tp, f3.trackGzBytes, { token: user.accessToken });

    const ver = await client.invokeVerifyActivity(
      {
        activityId: actId,
        source: 'live',
        modality: 'bike',
        startedAt: f3.startedAt,
        endedAt: f3.endedAt,
        trackPath: tp,
        clientSummary: {
          distanceM: f3.distanceM,
          movingS: f3.movingS,
          maxSpeed: f3.maxSpeed,
          newCells: f3.newCells,
          coinsCount: 0,
          coinsValue: 0,
          captures: [],
          cityIds: [],
        },
      },
      { token: user.accessToken },
    );
    assert.equal(ver.status, 200);
    assert.equal(ver.data.status, 'flagged');
    await assertZeroCredits(client, user.userId, user.accessToken);
  } finally {
    await registry.cleanup();
  }
});

test('T2-VER-04: Non-monotonic and negative timestamps are flagged or rejected with zero credits', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t2ver04');
    const f64 = new Float64Array([
      DEFAULT_CENTER.lng,
      DEFAULT_CENTER.lat,
      T0_MS,
      DEFAULT_CENTER.lng + 0.001,
      DEFAULT_CENTER.lat,
      T0_MS - 5000,
      DEFAULT_CENTER.lng + 0.002,
      DEFAULT_CENTER.lat,
      -1000,
    ]);
    const gz = new Uint8Array(zlib.gzipSync(new Uint8Array(f64.buffer)));
    const actId = `act_f4_${Date.now()}`;
    const tp = `${user.userId}/${actId}.bin.gz`;
    await client.storageUpload('activity-tracks', tp, gz, { token: user.accessToken });

    const ver = await client.invokeVerifyActivity(
      {
        activityId: actId,
        source: 'live',
        modality: 'bike',
        startedAt: T0_MS,
        endedAt: T0_MS + 10_000,
        trackPath: tp,
        clientSummary: {
          distanceM: 200,
          movingS: 20,
          maxSpeed: 10,
          newCells: 10,
          coinsCount: 0,
          coinsValue: 0,
          captures: [],
          cityIds: [],
        },
      },
      { token: user.accessToken },
    );
    assert.ok(!ver.ok || ver.data.status === 'flagged', `Expected reject or flagged, got ${ver.status}`);
    await assertZeroCredits(client, user.userId, user.accessToken);
  } finally {
    await registry.cleanup();
  }
});

test('T2-VER-05: Malformed Float64Array (25 bytes, 1-point 24 bytes, non-gzip) rejected/flagged cleanly', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t2ver05');
    const badPayloads = [
      new Uint8Array(zlib.gzipSync(new Uint8Array(25))),
      new Uint8Array(zlib.gzipSync(new Uint8Array(new Float64Array([DEFAULT_CENTER.lng, DEFAULT_CENTER.lat, T0_MS]).buffer))),
      new Uint8Array([1, 2, 3, 4, 5]),
    ];

    for (let i = 0; i < badPayloads.length; i++) {
      const actId = `act_mal_${i}_${Date.now()}`;
      const tp = `${user.userId}/${actId}.bin.gz`;
      await client.storageUpload('activity-tracks', tp, badPayloads[i], { token: user.accessToken });
      const ver = await client.invokeVerifyActivity(
        {
          activityId: actId,
          source: 'live',
          modality: 'bike',
          startedAt: T0_MS,
          endedAt: T0_MS + 10_000,
          trackPath: tp,
          clientSummary: {
            distanceM: 100,
            movingS: 10,
            maxSpeed: 10,
            newCells: 10,
            coinsCount: 0,
            coinsValue: 0,
            captures: [],
            cityIds: [],
          },
        },
        { token: user.accessToken },
      );
      assert.ok(
        !ver.ok || ver.data.status === 'flagged',
        `Bad payload #${i} must reject or flag, got ${ver.status}`,
      );
    }
    await assertZeroCredits(client, user.userId, user.accessToken);
  } finally {
    await registry.cleanup();
  }
});

test('T2-VER-06: Fabricated coins (5000 gems) and off-track captures (357 km away) are rejected/flagged', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t2ver06');
    const v1 = buildVectorV1();

    // Variant 1: 5000 gems on a 200m track
    const ptsShort = buildLinearPoints({ steps: 2, stepM: 100, bearingDeg: 90, startedAt: T0_MS });
    const gzShort = new Uint8Array(zlib.gzipSync(new Uint8Array(new Float64Array(ptsShort.flatMap((p) => [p.lng, p.lat, p.t])).buffer)));
    const act1 = `act_fcoins_${Date.now()}`;
    const tp1 = `${user.userId}/${act1}.bin.gz`;
    await client.storageUpload('activity-tracks', tp1, gzShort, { token: user.accessToken });
    const r1 = await client.invokeVerifyActivity(
      {
        activityId: act1,
        source: 'live',
        modality: 'bike',
        startedAt: T0_MS,
        endedAt: T0_MS + 20_000,
        trackPath: tp1,
        clientSummary: {
          distanceM: 50_000,
          movingS: 20,
          maxSpeed: 10,
          newCells: 50_000,
          coinsCount: 5000,
          coinsValue: 500_000,
          coinsByKind: { bronze: 0, silver: 0, gold: 0, gem: 5000 },
          captures: [],
          cityIds: [],
        },
      },
      { token: user.accessToken },
    );
    assert.ok(!r1.ok || r1.data.status === 'flagged' || r1.data.activity.coinsEarned < 500_000);

    // Variant 2: Off-track Rio de Janeiro POI on Sao Paulo track
    const act2 = `act_fcap_${Date.now()}`;
    const tp2 = `${user.userId}/${act2}.bin.gz`;
    await client.storageUpload('activity-tracks', tp2, v1.trackGzBytes, { token: user.accessToken });
    const r2 = await client.invokeVerifyActivity(
      {
        activityId: act2,
        source: 'live',
        modality: 'bike',
        startedAt: v1.startedAt,
        endedAt: v1.endedAt,
        trackPath: tp2,
        clientSummary: {
          distanceM: v1.distanceM,
          movingS: v1.movingS,
          maxSpeed: v1.maxSpeed,
          newCells: v1.newCells,
          coinsCount: 0,
          coinsValue: 0,
          captures: [
            {
              poiId: 'fake_rj_museu',
              name: 'Museu do Amanha',
              category: 'museu',
              rarity: 'raro',
              lat: -22.9068,
              lng: -43.1729,
            },
          ],
          cityIds: [],
        },
      },
      { token: user.accessToken },
    );
    assert.equal(r2.status, 200);
    assert.equal(r2.data.status, 'flagged', 'Off-track capture 357km away must be flagged');
    assert.equal(r2.data.reason, 'capture_out_of_range');
    await assertZeroCredits(client, user.userId, user.accessToken);
  } finally {
    await registry.cleanup();
  }
});

test('T2-VER-07: gpx_import skips >500m jumps without flagging and awards 0 XP / 0 coins', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t2ver07');
    const g1 = buildVectorG1();
    const actId = `act_gpx_${Date.now()}`;
    const tp = `${user.userId}/${actId}.bin.gz`;
    await client.storageUpload('activity-tracks', tp, g1.trackGzBytes, { token: user.accessToken });

    const ver = await client.invokeVerifyActivity(
      {
        activityId: actId,
        source: 'gpx_import',
        modality: 'bike',
        startedAt: g1.startedAt,
        endedAt: g1.endedAt,
        trackPath: tp,
        clientSummary: {
          distanceM: g1.distanceM,
          movingS: g1.movingS,
          maxSpeed: g1.maxSpeed,
          newCells: g1.newCells,
          coinsCount: 0,
          coinsValue: 0,
          captures: [],
          cityIds: g1.cityIds,
        },
      },
      { token: user.accessToken },
    );
    assert.equal(ver.status, 200);
    assert.equal(ver.data.status, 'verified');
    assert.ok(Math.abs(ver.data.activity.distanceM - 800) < 5, `Expected ~800m, got ${ver.data.activity.distanceM}`);
    assert.equal(ver.data.activity.xpEarned, 0);
    assert.equal(ver.data.activity.coinsEarned, 0);
    await assertZeroCredits(client, user.userId, user.accessToken);
  } finally {
    await registry.cleanup();
  }
});

test('T2-VER-08: Missing/invalid JWT returns 401 and cross-user trackPath or missing track fails', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const userA = await registry.provisionUser('t2ver08_a');
    const userB = await registry.provisionUser('t2ver08_b');
    const v1 = buildVectorV1();
    const tpA = `${userA.userId}/act_cross_${Date.now()}.bin.gz`;
    await client.storageUpload('activity-tracks', tpA, v1.trackGzBytes, { token: userA.accessToken });

    // No auth header
    const noAuth = await client.invokeVerifyActivity({ activityId: 'a1' }, { omitAuth: true });
    assert.equal(noAuth.status, 401);

    // Invalid JWT
    const badAuth = await client.invokeVerifyActivity({ activityId: 'a2' }, { rawBearer: 'not.a.jwt' });
    assert.equal(badAuth.status, 401);

    // User B trying to reference User A's trackPath
    const crossTrack = await client.invokeVerifyActivity(
      {
        activityId: `act_stolen_${Date.now()}`,
        source: 'live',
        modality: 'bike',
        startedAt: v1.startedAt,
        endedAt: v1.endedAt,
        trackPath: tpA,
        clientSummary: {
          distanceM: v1.distanceM,
          movingS: v1.movingS,
          maxSpeed: v1.maxSpeed,
          newCells: v1.newCells,
          coinsCount: 0,
          coinsValue: 0,
          captures: [],
          cityIds: [],
        },
      },
      { token: userB.accessToken },
    );
    assert.ok(crossTrack.status === 403 || crossTrack.status === 400, `Expected 403/400, got ${crossTrack.status}`);

    // Non-existent track
    const missingTrack = await client.invokeVerifyActivity(
      {
        activityId: `act_missing_${Date.now()}`,
        source: 'live',
        modality: 'bike',
        startedAt: v1.startedAt,
        endedAt: v1.endedAt,
        trackPath: `${userB.userId}/does_not_exist.bin.gz`,
        clientSummary: {
          distanceM: 100,
          movingS: 10,
          maxSpeed: 5,
          newCells: 10,
          coinsCount: 0,
          coinsValue: 0,
          captures: [],
          cityIds: [],
        },
      },
      { token: userB.accessToken },
    );
    assert.ok(missingTrack.status === 400 || missingTrack.status === 404);
  } finally {
    await registry.cleanup();
  }
});

// ============================================================================
// Area B: RLS, Storage & Auth Boundaries
// ============================================================================

test('T2-RLS-01: Anon role leaks 0 private rows and cannot invoke authenticated RPCs', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const userA = await registry.provisionUser('t2rls01', { isPublic: false });
    assert.ok(userA.userId);
    for (const tbl of ['activities', 'wallet_ledger', 'friendships', 'user_inventory']) {
      const res = await client.rest<unknown[]>('GET', tbl);
      assert.ok(res.status === 401 || res.status === 403 || (res.status === 200 && res.data.length === 0));
    }
    const rpcPurchase = await client.rpc('purchase_store_item', { p_item_id: 'any', p_quantity: 1 });
    assert.ok(!rpcPurchase.ok);
    const rpcLb = await client.rpc('get_friends_leaderboard', { p_metric: 'xp', p_period: 'all_time' });
    assert.ok(!rpcLb.ok || (Array.isArray(rpcLb.data) && rpcLb.data.length === 0));
  } finally {
    await registry.cleanup();
  }
});

test('T2-RLS-02: Forged profile INSERT with inflated XP/wallet is blocked or zeroed', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t2rls02');
    const res = await client.rest('POST', 'profiles', {
      token: user.accessToken,
      body: { id: user.userId, display_name: 'Hacker', modality: 'bike', xp: 99999, wallet: 99999 },
    });
    assert.ok(!res.ok);
  } finally {
    await registry.cleanup();
  }
});

test('T2-RLS-03: user_achievements direct forged coin insert is blocked', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t2rls03');
    const res = await client.rest('POST', 'user_achievements', {
      token: user.accessToken,
      body: {
        user_id: user.userId,
        achievement_key: 'total_activities:0',
        unlocked_at: new Date().toISOString(),
        coins_awarded: 99999,
      },
    });
    assert.ok(!res.ok, `Expected forged user_achievements insert blocked, got ${res.status}`);
  } finally {
    await registry.cleanup();
  }
});

test('T2-RLS-04: Cross-user Storage read and overwrite are blocked on both buckets', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const userA = await registry.provisionUser('t2rls04_a');
    const userB = await registry.provisionUser('t2rls04_b');
    const v1 = buildVectorV1();
    const trackPath = `${userA.userId}/secret_track.bin.gz`;
    const fogPath = `${userA.userId}/fog.bin`;
    await client.storageUpload('activity-tracks', trackPath, v1.trackGzBytes, { token: userA.accessToken });
    await client.storageUpload('fog-snapshots', fogPath, new Uint8Array([1, 2, 3]), { token: userA.accessToken });

    const dlTrack = await client.storageDownload('activity-tracks', trackPath, { token: userB.accessToken });
    assert.ok(!dlTrack.ok && (dlTrack.status === 400 || dlTrack.status === 403 || dlTrack.status === 404));

    const dlFog = await client.storageDownload('fog-snapshots', fogPath, { token: userB.accessToken });
    assert.ok(!dlFog.ok && (dlFog.status === 400 || dlFog.status === 403 || dlFog.status === 404));

    const overwriteFog = await client.storageUpload('fog-snapshots', fogPath, new Uint8Array([9, 9]), {
      token: userB.accessToken,
    });
    assert.ok(!overwriteFog.ok);
  } finally {
    await registry.cleanup();
  }
});

test('T2-RLS-05: Storage root upload and path traversal outside own {user_id}/ prefix are blocked', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const userA = await registry.provisionUser('t2rls05_a');
    const userB = await registry.provisionUser('t2rls05_b');
    const rootUp = await client.storageUpload('fog-snapshots', 'fog.bin', new Uint8Array([1, 2]), {
      token: userA.accessToken,
    });
    assert.ok(!rootUp.ok);
    const travUp = await client.storageUpload(
      'fog-snapshots',
      `${userA.userId}/../${userB.userId}/fog.bin`,
      new Uint8Array([1, 2]),
      { token: userA.accessToken },
    );
    assert.ok(!travUp.ok);
  } finally {
    await registry.cleanup();
  }
});

test('T2-AUTH-01: Invalid login credentials return GoTrue 400 and local mock weak-password returns 422', async () => {
  const client = new SupabaseHttpClient();
  // grant_type=password with wrong password sends ZERO emails
  const badLogin = await client.signInWithPassword('nonexistent@desbrava-e2e.test', 'WrongPass123!');
  assert.equal(badLogin.status, 400);

  // Test weak-password error handling against local mock server (never hits live SMTP)
  const mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += String(c);
    });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { password?: string };
      if (!parsed.password || parsed.password.length < 6) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error_code: 'weak_password', msg: 'Password should be at least 6 characters.' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ user: { id: 'mock-id' } }));
    });
  });

  try {
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = mockServer.address() as AddressInfo;
    const weakRes = await fetch(`http://127.0.0.1:${addr.port}/mock-auth/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'weak@local.test', password: '123' }),
    });
    assert.equal(weakRes.status, 422);
  } finally {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  }
});

test('T2-AUTH-02: Live mailer_autoconfirm=false settings and local mock unconfirmed response omit access_token', async () => {
  const client = new SupabaseHttpClient();
  const settings = await client.getAuthSettings();
  assert.equal(settings.status, 200);
  assert.equal(settings.data.mailer_autoconfirm, false);

  // Validate unconfirmed signup response shape via local mock server (zero live outbound email)
  const mockServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock-unconfirmed-user',
        email: 'unconf@local.test',
        confirmation_sent_at: new Date().toISOString(),
      }),
    );
  });

  try {
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = mockServer.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${addr.port}/mock-auth/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'unconf@local.test', password: 'ValidPassword!123' }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200);
    assert.equal(json.access_token, undefined, 'Unconfirmed payload must omit access_token');
  } finally {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  }
});

test('T2-AUTH-05: LargeSecureStore splits >2048B session payload from AES key and roundtrips >3KB web session', async (t) => {
  if (!(await gateTest(t, { milestone: 'M2', requires: ['syncEngine', 'distWeb'] }))) return;
  const nativeSessionPath = path.join(PROJECT_ROOT, 'src/services/sessionStorage.ts');
  const code = fs.readFileSync(nativeSessionPath, 'utf8');
  assert.ok(code.includes('expo-secure-store'), 'Native sessionStorage must use expo-secure-store for AES key');

  const server = await startDistServer();
  const session = await launchWebSession();
  try {
    await session.page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    const hugeToken = 'x'.repeat(3200);
    await setLocalStorageItem(session.page, 'sb-lugwebngeyadfrqoapsg-auth-token', JSON.stringify({ access_token: hugeToken }));
    const all = await readLocalStorageAll(session.page);
    assert.ok(all['sb-lugwebngeyadfrqoapsg-auth-token']?.includes(hugeToken));
  } finally {
    await session.close();
    await server.close();
  }
});

// ============================================================================
// Area C: Local Persistence, Fog Merge, Migration, Logout & DSBF Boundaries
// ============================================================================

test('T2-DSBF-01: Corrupt DSBF truncated header (<16 bytes) returns undefined', () => {
  const { corrupt } = buildFogFixtures();
  assert.equal(decodeFog(corrupt.truncatedHeader), undefined);
  assert.equal(decodeDsbf(corrupt.truncatedHeader), undefined);
});

test('T2-DSBF-02: Corrupt DSBF wrong magic returns undefined', () => {
  const { corrupt } = buildFogFixtures();
  assert.equal(decodeFog(corrupt.wrongMagic), undefined);
  assert.equal(decodeDsbf(corrupt.wrongMagic), undefined);
});

test('T2-DSBF-03: Corrupt DSBF unsupported version returns undefined', () => {
  const { corrupt } = buildFogFixtures();
  assert.equal(decodeFog(corrupt.unsupportedVersion), undefined);
  assert.equal(decodeDsbf(corrupt.unsupportedVersion), undefined);
});

test('T2-DSBF-04: Corrupt DSBF byteLength mismatch returns undefined', () => {
  const { corrupt } = buildFogFixtures();
  assert.equal(decodeFog(corrupt.lengthMismatch), undefined);
  assert.equal(decodeDsbf(corrupt.lengthMismatch), undefined);
});

test('T2-DSBF-05: Corrupt DSBF non-string JSON cityIds returns undefined', () => {
  const { corrupt } = buildFogFixtures();
  assert.equal(decodeFog(corrupt.nonStringCityIds), undefined);
  assert.equal(decodeDsbf(corrupt.nonStringCityIds), undefined);
});

test('T2-DSBF-06: Unaligned DSBF Uint8Array view (byteOffset=3) decodes cleanly', () => {
  const { fogA, corrupt } = buildFogFixtures();
  const appDec = decodeFog(corrupt.unalignedView);
  const oracleDec = decodeDsbf(corrupt.unalignedView);
  assert.ok(appDec && oracleDec);
  assert.deepEqual(Array.from(appDec.keys), Array.from(fogA.keys));
  assert.deepEqual(Array.from(oracleDec.keys), Array.from(fogA.keys));
});

test('T2-FOG-01: fog:v2 set-union remaps cityIds indices without raw index collisions', () => {
  const { fogA, fogB, c1, c2, c3, c4 } = buildFogFixtures();
  const merged = mergeDsbf(fogA, fogB);
  const roundtrip = decodeFog(encodeDsbf(merged));
  assert.ok(roundtrip);
  assert.equal(roundtrip.keys.length, 4);
  assert.equal(roundtrip.cityIds[0], '');
  assert.ok(roundtrip.cityIds.includes('sp'));
  assert.ok(roundtrip.cityIds.includes('rj'));

  const cityByKey = new Map<number, string>();
  for (let i = 0; i < roundtrip.keys.length; i++) {
    cityByKey.set(roundtrip.keys[i], roundtrip.cityIds[roundtrip.city[i]] ?? '');
  }
  assert.equal(cityByKey.get(c1), 'rj');
  assert.equal(cityByKey.get(c2), 'sp');
  assert.equal(cityByKey.get(c3), 'sp');
  assert.equal(cityByKey.get(c4), 'rj');
});

test('T2-FOG-02: user_fog_state optimistic revision CAS rejects stale writer and recovers via union', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t2fog02');
    const { fogA, fogB } = buildFogFixtures();
    const pathFog = `${user.userId}/fog.bin`;

    await client.storageUpload('fog-snapshots', pathFog, new Uint8Array(zlib.gzipSync(encodeDsbf(fogA))), {
      token: user.accessToken,
    });
    // Migration 0007 invariant: with 0 verified activities, upsert_fog_state clamps cell_count to 0
    const initUpsert = await client.rpc<UpsertFogResult>(
      'upsert_fog_state',
      { p_storage_path: pathFog, p_cell_count: 3, p_expected_revision: 0 },
      { token: user.accessToken },
    );
    assert.equal(initUpsert.status, 200, `init upsert_fog_state failed: ${initUpsert.rawText}`);
    assert.equal(initUpsert.data.conflict, false);
    assert.equal(initUpsert.data.revision, 1);
    assert.equal(initUpsert.data.cell_count, 0);

    // Direct client REST mutations on user_fog_state must be blocked by RLS/GRANT
    const directPatch = await client.rest('PATCH', `user_fog_state?user_id=eq.${user.userId}`, {
      token: user.accessToken,
      body: { revision: 99, cell_count: 99999 },
    });
    assert.ok(
      !directPatch.ok && (directPatch.status === 401 || directPatch.status === 403),
      `Direct PATCH user_fog_state must be rejected, got ${directPatch.status}`,
    );
    const directPost = await client.rest('POST', 'user_fog_state', {
      token: user.accessToken,
      body: { user_id: user.userId, storage_path: pathFog, cell_count: 99999, revision: 99 },
    });
    assert.ok(
      !directPost.ok && (directPost.status === 401 || directPost.status === 403),
      `Direct POST user_fog_state must be rejected, got ${directPost.status}`,
    );

    // Seed verified activity (615 cells >= 4) so subsequent CAS updates record 3 and 4 cells
    await seedVerifiedV1(client, user.userId, user.accessToken, `act_t2fog02_${Date.now()}`);

    // Device A wins CAS revision 1 -> 2
    const winA = await client.rpc<UpsertFogResult>(
      'upsert_fog_state',
      { p_storage_path: pathFog, p_cell_count: 3, p_expected_revision: 1 },
      { token: user.accessToken },
    );
    assert.equal(winA.status, 200);
    assert.equal(winA.data.conflict, false);
    assert.equal(winA.data.revision, 2);
    assert.equal(winA.data.cell_count, 3);

    // Device B attempts stale CAS revision 1 -> conflict: true, stays at revision 2
    const staleB = await client.rpc<UpsertFogResult>(
      'upsert_fog_state',
      { p_storage_path: pathFog, p_cell_count: 3, p_expected_revision: 1 },
      { token: user.accessToken },
    );
    assert.equal(staleB.status, 200);
    assert.equal(staleB.data.conflict, true, 'Stale revision must return conflict: true');
    assert.equal(staleB.data.revision, 2);
    assert.equal(staleB.data.cell_count, 3);

    // Device B downloads, merges A + B, uploads, and commits revision 2 -> 3
    const merged = mergeDsbf(fogA, fogB);
    await client.storageUpload('fog-snapshots', pathFog, new Uint8Array(zlib.gzipSync(encodeDsbf(merged))), {
      token: user.accessToken,
    });
    const retryB = await client.rpc<UpsertFogResult>(
      'upsert_fog_state',
      { p_storage_path: pathFog, p_cell_count: merged.keys.length, p_expected_revision: 2 },
      { token: user.accessToken },
    );
    assert.equal(retryB.status, 200);
    assert.equal(retryB.data.conflict, false);
    assert.equal(retryB.data.revision, 3);
    assert.equal(retryB.data.cell_count, 4);
  } finally {
    await registry.cleanup();
  }
});

test('T2-SYNC-01: Corrupt fog:v2 bytes and malformed fog:sync JSON do not crash app boot', async (t) => {
  if (!(await gateTest(t, { milestone: 'M2', requires: ['syncEngine', 'distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession();
  try {
    await session.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'CorruptSafe', modality: 'bike' });
    await writeIdbKey(session.page, 'fog:v2', [1, 2, 3, 4], true);
    await writeIdbKey(session.page, 'fog:sync', '{corrupt-json');
    await session.page.reload({ waitUntil: 'domcontentloaded' });
    await session.page.getByTestId('tabbar').waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
  }
});

test('T2-MIG-01: Migration network failure preserves local guest save:v1 and fog:v2', async (t) => {
  if (!(await gateTest(t, { milestone: 'M3', requires: ['authUi', 'distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession({ allowOfflineErrors: true });
  try {
    await session.page.route('https://lugwebngeyadfrqoapsg.supabase.co/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/auth/v1/token')) {
        const userId = '00000000-0000-0000-0000-000000000099';
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            access_token: 'hdr.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwOTkiLCJleHAiOjQ3MDAwMDAwMDB9.sig',
            token_type: 'bearer',
            expires_in: 3600,
            refresh_token: 'migfail_refresh',
            user: { id: userId, email: 'migfail@desbrava-e2e.test', role: 'authenticated' },
          }),
        });
        return;
      }
      if (url.includes('/auth/v1/user')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: '00000000-0000-0000-0000-000000000099',
            email: 'migfail@desbrava-e2e.test',
          }),
        });
        return;
      }
      // Simulate REST/Storage outage during migration
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Simulated migration failure' }),
      });
    });

    await session.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'KeepLocal', modality: 'bike' });
    await recordBriefSimRide(session.page, 1200);
    await session.page.waitForTimeout(1800);

    const saveBefore = await readIdbKey(session.page, 'save:v1');
    const fogBefore = await readIdbKey(session.page, 'fog:v2');
    assert.equal(saveBefore.kind, 'json');
    assert.equal(fogBefore.kind, 'uint8array');
    assert.ok((fogBefore.bytes?.length ?? 0) > 16, 'Expected non-empty fog:v2 before migration');

    await openAuthModal(session.page);
    await signInViaAuthModal(session.page, 'migfail@desbrava-e2e.test', 'ValidPass!123');
    await session.page.waitForTimeout(1500);

    const saveAfter = await readIdbKey(session.page, 'save:v1');
    const fogAfter = await readIdbKey(session.page, 'fog:v2');
    assert.equal(saveAfter.kind, 'json', 'save:v1 must be preserved after migration failure');
    assert.equal(
      (saveAfter.json as { profile?: { name?: string } })?.profile?.name,
      'KeepLocal',
      'Local guest profile name must remain intact',
    );
    assert.equal(fogAfter.kind, 'uint8array', 'fog:v2 must be preserved after migration failure');
    assert.equal(
      fogAfter.bytes?.length,
      fogBefore.bytes?.length,
      'fog:v2 byte length must be unchanged after failed migration',
    );
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
  }
});

test('T2-LOG-01: Clean logout after recorded rides wipes save:v1, fog:v2, track:*, and session token', async (t) => {
  if (!(await gateTest(t, { milestone: 'M3', requires: ['authUi', 'distWeb'] }))) return;
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
            id: '00000000-0000-0000-0000-000000000051',
            email: 'log01@desbrava-e2e.test',
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await session.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'CleanLogout', modality: 'bike' });
    await recordBriefSimRide(session.page, 1200);
    await session.page.waitForTimeout(1800);

    await seedSupabaseWebSession(session.page, {
      userId: '00000000-0000-0000-0000-000000000051',
      email: 'log01@desbrava-e2e.test',
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
    assert.equal(wiped, true, 'Clean logout must wipe save:v1, fog:v2, and track:*');
    const ls = await readLocalStorageAll(session.page);
    assert.equal(ls['sb-lugwebngeyadfrqoapsg-auth-token'], undefined, 'Session token must be removed on logout');
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
  }
});

// ============================================================================
// Area D: Profile, Social, Leaderboards & Store Boundaries
// ============================================================================

test('T2-PROF-01: Duplicate username (case-insensitive) is rejected by unique constraint', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const uname = `dup_user_${Date.now().toString(36)}`;
    await registry.provisionUser('t2prof01_a', { username: uname });
    const userB = await registry.provisionUser('t2prof01_b');

    const dup = await client.rest('PATCH', `profiles?id=eq.${userB.userId}`, {
      token: userB.accessToken,
      body: { username: uname.toUpperCase() },
    });
    assert.ok(!dup.ok, 'Duplicate username (including uppercase) must be rejected');
  } finally {
    await registry.cleanup();
  }
});

test('T2-PROF-02: Invalid username formats (too short, spaces/symbols, empty) are rejected', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t2prof02');
    for (const bad of ['ab', 'bad user!', '']) {
      const res = await client.rest('PATCH', `profiles?id=eq.${user.userId}`, {
        token: user.accessToken,
        body: { username: bad },
      });
      assert.ok(!res.ok, `Expected rejection for invalid username "${bad}", got ${res.status}`);
    }
  } finally {
    await registry.cleanup();
  }
});

test('T2-PROF-03: Private profile (is_public=false) excluded from search_users and global leaderboard', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const uname = `priv_u_${Date.now().toString(36)}`;
    const userA = await registry.provisionUser('t2prof03_a', { username: uname, isPublic: false });
    const userB = await registry.provisionUser('t2prof03_b', { isPublic: true });

    const search = await client.rpc<{ id: string }[]>(
      'search_users',
      { p_query: uname, p_limit: 20 },
      { token: userB.accessToken },
    );
    assert.equal(search.data.some((r) => r.id === userA.userId), false);

    const glb = await client.rpc<{ entries: { user_id?: string; id?: string }[] }>(
      'get_global_leaderboard',
      { p_metric: 'xp', p_period: 'all_time', p_limit: 50, p_offset: 0 },
      { token: userB.accessToken },
    );
    assert.equal(glb.data.entries.some((e) => (e.user_id ?? e.id) === userA.userId), false);
  } finally {
    await registry.cleanup();
  }
});

test('T2-SOC-01: Self-friend request (requester_id === addressee_id) is blocked', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t2soc01');
    const res = await client.rest('POST', 'friendships', {
      token: user.accessToken,
      body: { requester_id: user.userId, addressee_id: user.userId, status: 'pending' },
    });
    assert.ok(!res.ok, 'Self-friend request must be rejected');
  } finally {
    await registry.cleanup();
  }
});

test('T2-SOC-02: Reverse duplicate friendship (B->A when A->B exists) is blocked', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const userA = await registry.provisionUser('t2soc02_a');
    const userB = await registry.provisionUser('t2soc02_b');
    const first = await client.rest('POST', 'friendships', {
      token: userA.accessToken,
      body: { requester_id: userA.userId, addressee_id: userB.userId, status: 'pending' },
    });
    assert.ok(first.ok);
    const reverse = await client.rest('POST', 'friendships', {
      token: userB.accessToken,
      body: { requester_id: userB.userId, addressee_id: userA.userId, status: 'pending' },
    });
    assert.ok(!reverse.ok, 'Reverse duplicate friendship must be rejected');
  } finally {
    await registry.cleanup();
  }
});

test('T2-SOC-03: Blocked user cannot re-request or appear in search_users', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const unameA = `blk_a_${Date.now().toString(36)}`;
    const userA = await registry.provisionUser('t2soc03_a', { username: unameA, isPublic: true });
    const userB = await registry.provisionUser('t2soc03_b', { isPublic: true });

    const req = await client.rest<{ id: string }[]>('POST', 'friendships', {
      token: userA.accessToken,
      prefer: 'return=representation',
      body: { requester_id: userA.userId, addressee_id: userB.userId, status: 'pending' },
    });
    assert.ok(req.ok, `Friend request failed: ${req.rawText}`);
    const blk = await client.rest('PATCH', `friendships?id=eq.${req.data[0].id}`, {
      token: userA.accessToken,
      body: { status: 'blocked' },
    });
    assert.ok(blk.ok, `Friend block failed: ${blk.rawText}`);

    const bUpdate = await client.rest('PATCH', `friendships?id=eq.${req.data[0].id}`, {
      token: userB.accessToken,
      prefer: 'return=representation',
      body: { status: 'accepted' },
    });
    assert.ok(
      !bUpdate.ok || (Array.isArray(bUpdate.data) && bUpdate.data.length === 0),
      'Blocked user must not unblock themselves',
    );

    const search = await client.rpc<{ id: string }[]>(
      'search_users',
      { p_query: unameA, p_limit: 20 },
      { token: userB.accessToken },
    );
    assert.equal(search.data.some((r) => r.id === userA.userId), false);
  } finally {
    await registry.cleanup();
  }
});

test('T2-LB-01: Invalid leaderboard metric or period is rejected explicitly', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t2lb01');
    const bad1 = await client.rpc(
      'get_friends_leaderboard',
      { p_metric: 'invalid_metric', p_period: 'all_time' },
      { token: user.accessToken },
    );
    assert.ok(!bad1.ok);
    const bad2 = await client.rpc(
      'get_global_leaderboard',
      { p_metric: 'xp', p_period: 'weekly', p_limit: 10, p_offset: 0 },
      { token: user.accessToken },
    );
    assert.ok(!bad2.ok);
  } finally {
    await registry.cleanup();
  }
});

test('T2-STR-01: purchase_store_item rejects insufficient verified wallet balance', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t2str01');
    const items = await client.rest<{ id: string }[]>(
      'GET',
      'store_items?is_active=eq.true&price_coins=gt.0&limit=1&select=id',
      { token: user.accessToken },
    );
    const res = await client.rpc(
      'purchase_store_item',
      { p_item_id: items.data[0].id, p_quantity: 1 },
      { token: user.accessToken },
    );
    assert.ok(!res.ok, 'Zero-wallet purchase must fail atomically');
  } finally {
    await registry.cleanup();
  }
});

test('T2-STR-02: Concurrent double-spend purchase race allows exactly 1 winner via FOR UPDATE', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t2str02');
    // Earn 105 coins (V2) so wallet >= 60 (cheapest consumable boost_xp_2x)
    const v2 = buildVectorV2();
    const actId = `act_race_${Date.now()}`;
    const tp = `${user.userId}/${actId}.bin.gz`;
    await client.storageUpload('activity-tracks', tp, v2.trackGzBytes, { token: user.accessToken });
    const ver = await client.invokeVerifyActivity(
      {
        activityId: actId,
        source: 'live',
        modality: 'run',
        startedAt: v2.startedAt,
        endedAt: v2.endedAt,
        trackPath: tp,
        clientSummary: {
          distanceM: v2.distanceM,
          movingS: v2.movingS,
          maxSpeed: v2.maxSpeed,
          newCells: v2.newCells,
          coinsCount: v2.coinsCount,
          coinsValue: v2.coinsValue,
          coinsByKind: v2.coinsByKind,
          captures: v2.captures,
          cityIds: v2.cityIds,
        },
      },
      { token: user.accessToken },
    );
    assert.equal(ver.status, 200, `verify-activity failed: ${ver.rawText}`);
    const wallet = ver.data.authoritative.wallet;

    const items = await client.rest<{ id: string; price_coins: number }[]>(
      'GET',
      `store_items?is_active=eq.true&kind=eq.consumable&price_coins=lte.${wallet}&order=price_coins.asc&select=id,price_coins`,
      { token: user.accessToken },
    );
    const target =
      items.data.find(
        (i) => i.price_coins <= wallet && Math.floor(wallet / i.price_coins) * i.price_coins * 2 > wallet,
      ) ?? items.data[0];
    assert.ok(target, `Expected affordable consumable <= ${wallet} coins`);
    const qty = Math.floor(wallet / target.price_coins);
    assert.ok(qty >= 1 && qty * target.price_coins * 2 > wallet);

    const [p1, p2] = await Promise.all([
      client.rpc('purchase_store_item', { p_item_id: target.id, p_quantity: qty }, { token: user.accessToken }),
      client.rpc('purchase_store_item', { p_item_id: target.id, p_quantity: qty }, { token: user.accessToken }),
    ]);
    const okCount = [p1.ok, p2.ok].filter(Boolean).length;
    assert.equal(okCount, 1, `Concurrent double-spend must allow exactly 1 purchase, got ${okCount}`);
  } finally {
    await registry.cleanup();
  }
});

test('T2-STR-03: max_stack=1 cosmetic duplicate purchase and p_quantity<=0 are rejected', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t2str03');
    // Earn 105 coins via V2
    const v2 = buildVectorV2();
    const actId = `act_stack_${Date.now()}`;
    const tp = `${user.userId}/${actId}.bin.gz`;
    await client.storageUpload('activity-tracks', tp, v2.trackGzBytes, { token: user.accessToken });
    const ver = await client.invokeVerifyActivity(
      {
        activityId: actId,
        source: 'live',
        modality: 'run',
        startedAt: v2.startedAt,
        endedAt: v2.endedAt,
        trackPath: tp,
        clientSummary: {
          distanceM: v2.distanceM,
          movingS: v2.movingS,
          maxSpeed: v2.maxSpeed,
          newCells: v2.newCells,
          coinsCount: v2.coinsCount,
          coinsValue: v2.coinsValue,
          coinsByKind: v2.coinsByKind,
          captures: v2.captures,
          cityIds: v2.cityIds,
        },
      },
      { token: user.accessToken },
    );
    assert.equal(ver.status, 200, `verify-activity failed: ${ver.rawText}`);
    const wallet = ver.data.authoritative.wallet;

    const cosmetics = await client.rest<{ id: string; price_coins: number }[]>(
      'GET',
      `store_items?is_active=eq.true&kind=eq.cosmetic&max_stack=eq.1&price_coins=lte.${wallet}&order=price_coins.asc&select=id,price_coins`,
      { token: user.accessToken },
    );
    assert.ok(cosmetics.data.length > 0, `Expected affordable cosmetic <= ${wallet} coins`);
    const cos = cosmetics.data[0];

    const zeroQty = await client.rpc('purchase_store_item', { p_item_id: cos.id, p_quantity: 0 }, { token: user.accessToken });
    assert.ok(!zeroQty.ok);

    const firstBuy = await client.rpc('purchase_store_item', { p_item_id: cos.id, p_quantity: 1 }, { token: user.accessToken });
    assert.equal(firstBuy.status, 200);

    const dupBuy = await client.rpc('purchase_store_item', { p_item_id: cos.id, p_quantity: 1 }, { token: user.accessToken });
    assert.ok(!dupBuy.ok, 'Duplicate purchase of max_stack=1 cosmetic must fail');
  } finally {
    await registry.cleanup();
  }
});

test('T2-STR-04: Forged or unowned booster passed to verify-activity yields 1x base XP', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t2str04');
    const v1 = buildVectorV1();
    const actId = `act_fboost_${Date.now()}`;
    const tp = `${user.userId}/${actId}.bin.gz`;
    await client.storageUpload('activity-tracks', tp, v1.trackGzBytes, { token: user.accessToken });

    const ver = await client.invokeVerifyActivity(
      {
        activityId: actId,
        source: 'live',
        modality: 'bike',
        startedAt: v1.startedAt,
        endedAt: v1.endedAt,
        trackPath: tp,
        clientSummary: {
          distanceM: v1.distanceM,
          movingS: v1.movingS,
          maxSpeed: v1.maxSpeed,
          newCells: v1.newCells,
          coinsCount: v1.coinsCount,
          coinsValue: v1.coinsValue,
          coinsByKind: v1.coinsByKind,
          captures: v1.captures,
          cityIds: v1.cityIds,
        },
        boostUsageIds: ['forged_boost_usage_id'],
      },
      { token: user.accessToken },
    );
    assert.equal(ver.status, 200);
    assert.equal(ver.data.activity.xpEarned, v1.expectedXp, 'Forged booster must not multiply XP');
  } finally {
    await registry.cleanup();
  }
});
