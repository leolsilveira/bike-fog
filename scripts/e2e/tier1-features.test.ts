import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { decodeFog, encodeFog } from '../../src/game/binary.ts';
import { MAX_SPEED, REVEAL_RADIUS_M, XP } from '../../src/game/config.ts';
import { fog } from '../../src/game/fog.ts';
import { haversine } from '../../src/game/geo.ts';
import { parseGpx } from '../../src/game/gpxImport.ts';
import { levelFromXp, xpToNext } from '../../src/game/progression.ts';
import { COIN_VALUE, RARITY_INFO } from '../../src/sprites/items.ts';
import { PROJECT_ROOT } from './lib/env.ts';
import { gateTest } from './lib/probe.ts';
import { SupabaseHttpClient, TestUserRegistry } from './lib/supabaseHttp.ts';
import {
  buildFogFixtures,
  buildGpxXml,
  buildVectorV1,
  buildVectorV2,
  buildVectorV3,
  buildVectorG1,
  decodeDsbf,
  encodeDsbf,
  FOG_A_HEX,
  FOG_B_HEX,
  levelFromXp as oracleLevelFromXp,
  mergeDsbf,
  T0_MS,
  xpToNext as oracleXpToNext,
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
  waitForIdbKey,
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

const ALL_11_TABLES = [
  'profiles',
  'activities',
  'user_cities',
  'user_captures',
  'user_achievements',
  'user_fog_state',
  'friendships',
  'store_items',
  'user_inventory',
  'user_boost_usages',
  'wallet_ledger',
];

async function earnVerifiedV1(
  client: SupabaseHttpClient,
  userId: string,
  token: string,
  activityId: string,
) {
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
  return { v1, ver: ver.data };
}

// ============================================================================
// Area A: Backend Schema, Design Doc, Storage & RLS (Features 1, 2, 3, 4)
// ============================================================================

test('T1-BE-01: Design doc 003-supabase-backend.md exists in pt-BR and is indexed', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['designDoc'] }))) return;
  const docPath = path.join(PROJECT_ROOT, 'docs/design/003-supabase-backend.md');
  const readmePath = path.join(PROJECT_ROOT, 'docs/README.md');
  const doc = fs.readFileSync(docPath, 'utf8');
  const readme = fs.readFileSync(readmePath, 'utf8');

  assert.ok(readme.includes('003-supabase-backend.md'), 'docs/README.md must link to design doc');
  for (const tbl of ALL_11_TABLES) {
    assert.ok(doc.includes(tbl), `Design doc missing table ${tbl}`);
  }
  for (const fn of [
    'search_users',
    'get_friends_leaderboard',
    'get_global_leaderboard',
    'purchase_store_item',
    'claim_achievement',
    'verify-activity',
    'fog-snapshots',
    'activity-tracks',
  ]) {
    assert.ok(doc.includes(fn), `Design doc missing contract ${fn}`);
  }
});

test('T1-BE-02: All 11 Postgres tables exist and store_items catalog is seeded', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1be02');
    for (const table of ALL_11_TABLES) {
      const res = await client.rest('GET', `${table}?limit=0`, { token: user.accessToken });
      assert.equal(
        res.status,
        200,
        `Expected table ${table} to return 200, got ${res.status}: ${res.rawText}`,
      );
    }
    const items = await client.rest<{ id: string; kind: string; category: string; is_active: boolean }[]>(
      'GET',
      'store_items?is_active=eq.true&select=id,kind,category,price_coins,is_active',
      { token: user.accessToken },
    );
    assert.equal(items.status, 200);
    assert.ok(Array.isArray(items.data) && items.data.length >= 2, 'store_items catalog must be seeded');
    assert.ok(items.data.some((i) => i.kind === 'cosmetic'), 'Expected at least 1 cosmetic item');
    assert.ok(items.data.some((i) => i.kind === 'consumable'), 'Expected at least 1 consumable booster');
  } finally {
    await registry.cleanup();
  }
});

test('T1-BE-03: claim_achievement RPC grants eligible achievement idempotently', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1be03');
    const { ver } = await earnVerifiedV1(client, user.userId, user.accessToken, `act_t1be03_${Date.now()}`);
    const walletAfterActivity = ver.authoritative.wallet;

    const claim1 = await client.rpc<Record<string, unknown>>(
      'claim_achievement',
      { p_achievement_key: 'total_activities:0' },
      { token: user.accessToken },
    );
    assert.equal(claim1.status, 200, `claim_achievement failed: ${claim1.rawText}`);

    const profileRes = await client.rest<{ wallet: number; achievements_count: number }[]>(
      'GET',
      `profiles?id=eq.${user.userId}&select=wallet,achievements_count`,
      { token: user.accessToken },
    );
    assert.equal(profileRes.status, 200);
    assert.ok(profileRes.data[0].wallet > walletAfterActivity, 'wallet should increase on achievement claim');
    assert.ok(profileRes.data[0].achievements_count >= 1, 'achievements_count should increment');

    const walletAfterClaim = profileRes.data[0].wallet;
    // Second claim must be idempotent (never double-credit)
    await client.rpc('claim_achievement', { p_achievement_key: 'total_activities:0' }, { token: user.accessToken });
    const profileRes2 = await client.rest<{ wallet: number }[]>(
      'GET',
      `profiles?id=eq.${user.userId}&select=wallet`,
      { token: user.accessToken },
    );
    assert.equal(profileRes2.data[0].wallet, walletAfterClaim, 'Duplicate claim must not double-credit');
  } finally {
    await registry.cleanup();
  }
});

test('T1-RLS-01: Client cannot directly mutate server-managed columns on profiles', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1rls01');
    const forbiddenFields: Record<string, unknown>[] = [
      { xp: 99999 },
      { level: 50 },
      { wallet: 99999 },
      { total_distance_m: 99999 },
      { total_moving_s: 99999 },
      { total_activities: 99 },
      { total_cells: 99999 },
      { total_captures: 99 },
      { achievements_count: 99 },
    ];
    for (const payload of forbiddenFields) {
      const res = await client.rest('PATCH', `profiles?id=eq.${user.userId}`, {
        token: user.accessToken,
        body: payload,
      });
      assert.ok(
        !res.ok && (res.status === 400 || res.status === 401 || res.status === 403),
        `Expected rejection for ${JSON.stringify(payload)}, got ${res.status}: ${res.rawText}`,
      );
    }
    const check = await client.rest<{ xp: number; level: number; wallet: number }[]>(
      'GET',
      `profiles?id=eq.${user.userId}&select=xp,level,wallet`,
      { token: user.accessToken },
    );
    assert.equal(check.data[0].xp, 0);
    assert.equal(check.data[0].level, 1);
    assert.equal(check.data[0].wallet, 0);
  } finally {
    await registry.cleanup();
  }
});

test('T1-RLS-02: Client can update editable cosmetic columns on own profile', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1rls02');
    const patch = await client.rest('PATCH', `profiles?id=eq.${user.userId}`, {
      token: user.accessToken,
      prefer: 'return=representation',
      body: {
        display_name: 'Ciclista E2E',
        modality: 'run',
        is_public: false,
        avatar_config: { hair: 'spiky', shirt: '#34d399' },
      },
    });
    assert.ok(patch.ok, `Cosmetic profile patch failed (${patch.status}): ${patch.rawText}`);
    const fetched = await client.rest<{ display_name: string; modality: string; is_public: boolean }[]>(
      'GET',
      `profiles?id=eq.${user.userId}&select=display_name,modality,is_public`,
      { token: user.accessToken },
    );
    assert.equal(fetched.data[0].display_name, 'Ciclista E2E');
    assert.equal(fetched.data[0].modality, 'run');
    assert.equal(fetched.data[0].is_public, false);
  } finally {
    await registry.cleanup();
  }
});

test('T1-RLS-03: wallet_ledger rejects direct client INSERT', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1rls03');
    const res = await client.rest('POST', 'wallet_ledger', {
      token: user.accessToken,
      body: {
        user_id: user.userId,
        delta: 5000,
        reason: 'adjustment',
        ref_id: 'forged_self_grant',
      },
    });
    assert.ok(!res.ok, `Expected wallet_ledger insert rejection, got ${res.status}`);
  } finally {
    await registry.cleanup();
  }
});

test('T1-RLS-04: activities rejects direct client INSERT and UPDATE', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1rls04');
    const res = await client.rest('POST', 'activities', {
      token: user.accessToken,
      body: {
        id: 'act_forged_1',
        user_id: user.userId,
        source: 'live',
        verification_status: 'verified',
        modality: 'bike',
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        xp: 9999,
      },
    });
    assert.ok(!res.ok, `Expected activities insert rejection, got ${res.status}`);

    const patchRes = await client.rest<unknown[]>('PATCH', `activities?user_id=eq.${user.userId}`, {
      token: user.accessToken,
      prefer: 'return=representation',
      body: { xp: 9999, verification_status: 'verified' },
    });
    assert.ok(
      !patchRes.ok && (patchRes.status === 401 || patchRes.status === 403),
      `Expected activities update rejection (401/403), got ${patchRes.status}: ${patchRes.rawText}`,
    );
  } finally {
    await registry.cleanup();
  }
});

test('T1-RLS-05: user_inventory rejects direct client INSERT and UPDATE', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1rls05');
    const items = await client.rest<{ id: string }[]>('GET', 'store_items?limit=1&select=id', {
      token: user.accessToken,
    });
    const itemId = items.data?.[0]?.id ?? 'boost_xp_2x';
    const res = await client.rest('POST', 'user_inventory', {
      token: user.accessToken,
      body: { user_id: user.userId, item_id: itemId, quantity: 99 },
    });
    assert.ok(!res.ok, `Expected user_inventory insert rejection, got ${res.status}`);

    const patchRes = await client.rest<unknown[]>(
      'PATCH',
      `user_inventory?user_id=eq.${user.userId}`,
      {
        token: user.accessToken,
        prefer: 'return=representation',
        body: { quantity: 99 },
      },
    );
    assert.ok(
      !patchRes.ok && (patchRes.status === 401 || patchRes.status === 403),
      `Expected user_inventory update rejection (401/403), got ${patchRes.status}: ${patchRes.rawText}`,
    );
  } finally {
    await registry.cleanup();
  }
});

test('T1-RLS-06: Cross-user private tables (activities, wallet_ledger, user_inventory, user_boost_usages) are isolated', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const userA = await registry.provisionUser('t1rls06_a');
    const userB = await registry.provisionUser('t1rls06_b');
    await earnVerifiedV1(client, userA.userId, userA.accessToken, `act_iso_${Date.now()}`);

    for (const table of ['activities', 'wallet_ledger', 'user_inventory', 'user_boost_usages']) {
      const res = await client.rest<unknown[]>('GET', `${table}?user_id=eq.${userA.userId}`, {
        token: userB.accessToken,
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.length, 0, `User B leaked rows from ${table}`);
    }
  } finally {
    await registry.cleanup();
  }
});

test('T1-STG-01: activity-tracks private bucket allows owner gzipped upload and byte-identical download', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1stg01');
    const v1 = buildVectorV1();
    const objectPath = `${user.userId}/act_stg_${Date.now()}.bin.gz`;
    const up = await client.storageUpload('activity-tracks', objectPath, v1.trackGzBytes, {
      token: user.accessToken,
      contentType: 'application/gzip',
    });
    assert.equal(up.status, 200, `Upload failed: ${up.rawText}`);

    const dl = await client.storageDownload('activity-tracks', objectPath, {
      token: user.accessToken,
    });
    assert.equal(dl.status, 200);
    assert.deepEqual(Buffer.from(dl.bytes), Buffer.from(v1.trackGzBytes));
  } finally {
    await registry.cleanup();
  }
});

test('T1-STG-02: fog-snapshots private bucket allows owner DSBF upload and byte-identical download', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1stg02');
    const { fogABytes } = buildFogFixtures();
    const gz = new Uint8Array(zlib.gzipSync(fogABytes));
    const objectPath = `${user.userId}/fog.bin`;
    const up = await client.storageUpload('fog-snapshots', objectPath, gz, {
      token: user.accessToken,
      contentType: 'application/octet-stream',
    });
    assert.equal(up.status, 200, `Fog upload failed: ${up.rawText}`);

    const dl = await client.storageDownload('fog-snapshots', objectPath, {
      token: user.accessToken,
    });
    assert.equal(dl.status, 200);
    assert.deepEqual(Buffer.from(dl.bytes), Buffer.from(gz));
  } finally {
    await registry.cleanup();
  }
});

// ============================================================================
// Area B: Auth, Guest Mode, Session Persistence, Migration, Logout & Profile
// ============================================================================

test('T1-AUTH-00: Live GoTrue /auth/v1/settings confirms email auth enabled', async () => {
  const client = new SupabaseHttpClient();
  const res = await client.getAuthSettings();
  assert.equal(res.status, 200, `Auth settings probe failed: ${res.rawText}`);
  const external = res.data.external as Record<string, boolean> | undefined;
  assert.equal(external?.email, true, 'Expected email provider enabled on lugwebngeyadfrqoapsg');
});

test('T1-AUTH-01: Guest-first mode works offline without Supabase login', async (t) => {
  if (!(await gateTest(t, { milestone: 'Baseline', requires: ['distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession({ allowOfflineErrors: true });
  try {
    await setExternalOffline(session, server.baseUrl, true);
    await session.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'Convidado', modality: 'bike' });
    const chipText = await session.page.getByTestId('player-chip').innerText();
    assert.ok(chipText.includes('Convidado'), `Expected player-chip to show Convidado, got ${chipText}`);
    const save = await waitForIdbKey(session.page, 'save:v1', 5000);
    assert.equal(save.kind, 'json');
    assert.equal(session.pageErrors.length, 0, `Unexpected pageErrors: ${session.pageErrors.join('; ')}`);
  } finally {
    await session.close();
    await server.close();
  }
});

test('T1-AUTH-02: Admin user provisioning (email_confirm=true, 0 emails) and live password login', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['serviceRoleKey', 'authSettings'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const confirmed = await registry.provisionUser('t1auth02');
    assert.ok(confirmed.accessToken.length > 20);
    assert.ok(confirmed.refreshToken.length > 5);

    // Verify re-login via grant_type=password works cleanly with zero emails sent
    const relogin = await client.signInWithPassword(confirmed.email, confirmed.password);
    assert.equal(relogin.status, 200, `Password login failed: ${relogin.rawText}`);
    assert.equal(relogin.data.user.id, confirmed.userId);
  } finally {
    await registry.cleanup();
  }
});

test('T1-AUTH-03: Live token refresh (0 emails) and mocked local password-recovery contract', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['serviceRoleKey', 'authSettings'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);

  // Local mock GoTrue server for recovery contract (never calls live SMTP)
  const mockServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/mock-auth/recover') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    const user = await registry.provisionUser('t1auth03');
    const refreshed = await client.refreshToken(user.refreshToken);
    assert.equal(refreshed.status, 200, `Refresh failed: ${refreshed.rawText}`);
    assert.ok(refreshed.data.access_token.length > 20);

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = mockServer.address() as AddressInfo;
    const mockRecover = await fetch(`http://127.0.0.1:${addr.port}/mock-auth/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email }),
    });
    assert.equal(mockRecover.status, 200);
  } finally {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    await registry.cleanup();
  }
});

test('T1-AUTH-06: Persistent session storage survives browser reload', async (t) => {
  if (!(await gateTest(t, { milestone: 'M2', requires: ['syncEngine', 'authUi', 'distWeb'] }))) return;
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
            id: '00000000-0000-0000-0000-000000000001',
            email: 'session@desbrava-e2e.test',
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await session.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'Sessao Persistente', modality: 'bike' });
    await seedSupabaseWebSession(session.page, {
      userId: '00000000-0000-0000-0000-000000000001',
      email: 'session@desbrava-e2e.test',
    });

    await session.page.reload({ waitUntil: 'domcontentloaded' });
    await session.page.getByTestId('tabbar').waitFor({ state: 'visible', timeout: 10_000 });

    await session.page.getByTestId('tab-stats').click();
    await session.page.getByTestId('stats-scroll').waitFor({ state: 'visible', timeout: 10_000 });
    await session.page.getByTestId('logout-btn').waitFor({ state: 'visible', timeout: 5000 });

    const emailVisible = await session.page
      .getByTestId('auth-status-email')
      .innerText()
      .catch(() => '');
    const statsText = await session.page.getByTestId('stats-scroll').innerText();
    assert.ok(
      emailVisible.includes('session@desbrava-e2e.test') ||
        statsText.includes('session@desbrava-e2e.test') ||
        statsText.includes('Conta'),
      `Expected authenticated account indicator after reload, got "${statsText.slice(0, 200)}"`,
    );

    const ls = await readLocalStorageAll(session.page);
    assert.ok(
      ls['sb-lugwebngeyadfrqoapsg-auth-token']?.includes('session@desbrava-e2e.test'),
      'Supabase session token in localStorage must survive reload',
    );
    assert.equal(session.pageErrors.length, 0, `pageErrors: ${session.pageErrors.join('; ')}`);
  } finally {
    await session.close();
    await server.close();
  }
});

test('T1-MIG-01: Local-to-cloud empty cloud account triggers auto-merge without conflict prompt', async (t) => {
  if (!(await gateTest(t, { milestone: 'M3', requires: ['schema', 'serviceRoleKey', 'authUi', 'distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession();
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1mig01');
    await session.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'Guest AutoMerge', modality: 'bike' });

    await openAuthModal(session.page);
    await signInViaAuthModal(session.page, user.email, user.password);

    // Empty cloud must NOT require choosing between merge and cloud-only
    await session.page.getByTestId('auth-modal').waitFor({ state: 'hidden', timeout: 12_000 });
    await session.page.waitForTimeout(1000);
    const conflictVisible = await session.page
      .getByTestId('migration-modal')
      .isVisible()
      .catch(() => false);
    assert.equal(conflictVisible, false, 'Empty cloud should auto-merge without conflict modal');

    const saveAfter = await readIdbKey(session.page, 'save:v1');
    assert.equal(saveAfter.kind, 'json');
    const profile = (saveAfter.json as { profile?: { name?: string } })?.profile;
    assert.equal(profile?.name, 'Guest AutoMerge', 'Auto-merge must preserve local guest profile name');
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
    await registry.cleanup();
  }
});

test('T1-MIG-02: Both local and cloud progress surfaces conflict modal (Mesclar vs Manter apenas a nuvem)', async (t) => {
  if (!(await gateTest(t, { milestone: 'M3', requires: ['schema', 'verifyActivity', 'serviceRoleKey', 'authUi', 'distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession();
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1mig02', { displayName: 'Cloud Hero' });
    await earnVerifiedV1(client, user.userId, user.accessToken, `act_mig_${Date.now()}`);

    await session.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'Local Hero', modality: 'run' });

    await openAuthModal(session.page);
    await signInViaAuthModal(session.page, user.email, user.password);

    await session.page.getByTestId('migration-modal').waitFor({ state: 'visible', timeout: 12_000 });
    await session.page.getByTestId('migration-cloud-only-btn').click();
    await session.page.getByTestId('migration-modal').waitFor({ state: 'hidden', timeout: 12_000 });
    await session.page.getByTestId('tab-map').click();
    const chip = await session.page.getByTestId('player-chip').innerText();
    assert.ok(chip.includes('Cloud Hero'), `Expected Cloud Hero after cloud-only choice, got ${chip}`);
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
    await registry.cleanup();
  }
});

test('T1-LOG-01: Clean logout wipes local account storage (save:v1, fog:v2, session) cleanly', async (t) => {
  if (!(await gateTest(t, { milestone: 'M3', requires: ['schema', 'serviceRoleKey', 'authUi', 'distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession();
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1log01', { displayName: 'LogoutTester' });
    await session.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'LogoutTester', modality: 'bike' });

    await openAuthModal(session.page);
    await signInViaAuthModal(session.page, user.email, user.password);
    await session.page.getByTestId('auth-modal').waitFor({ state: 'hidden', timeout: 12_000 });
    await session.page.waitForTimeout(800);

    await session.page.getByTestId('tab-stats').click();
    await session.page.getByTestId('logout-btn').waitFor({ state: 'visible', timeout: 8000 });
    await session.page.getByTestId('logout-btn').click();

    await session.page.waitForTimeout(1000);
    const saveAfter = await readIdbKey(session.page, 'save:v1');
    assert.equal(saveAfter.kind, 'missing', 'Expected save:v1 cleared after logout');
    const ls = await readLocalStorageAll(session.page);
    assert.equal(ls['sb-lugwebngeyadfrqoapsg-auth-token'], undefined, 'Expected Supabase token cleared on logout');
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
    await registry.cleanup();
  }
});

test('T1-PROF-01: Unique @username creation normalized lowercase and searchable via search_users', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const uname = `e2epilot_${Date.now().toString(36)}`;
    const userA = await registry.provisionUser('t1prof01_a', {
      username: uname,
      displayName: 'Piloto Paulista',
      isPublic: true,
    });
    const userB = await registry.provisionUser('t1prof01_b');

    const res = await client.rpc<{ id: string; username: string }[]>(
      'search_users',
      { p_query: uname.slice(0, 10), p_limit: 20 },
      { token: userB.accessToken },
    );
    assert.equal(res.status, 200, `search_users failed: ${res.rawText}`);
    assert.ok(res.data.some((r) => r.id === userA.userId && r.username === uname));
  } finally {
    await registry.cleanup();
  }
});

test('T1-PROF-02: Profile and partial settings sync preserves server timestamps', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1prof02');
    const before = await client.rest<{ updated_at: string }[]>(
      'GET',
      `profiles?id=eq.${user.userId}&select=updated_at`,
      { token: user.accessToken },
    );
    await new Promise((r) => setTimeout(r, 50));
    const upd = await client.rest(
      'PATCH',
      `profiles?id=eq.${user.userId}`,
      {
        token: user.accessToken,
        body: {
          display_name: 'Nome Atualizado',
          settings: { sound: false, haptics: true },
        },
      },
    );
    assert.ok(upd.ok, `Profile settings update failed: ${upd.rawText}`);
    const after = await client.rest<{ display_name: string; settings: Record<string, unknown>; updated_at: string }[]>(
      'GET',
      `profiles?id=eq.${user.userId}&select=display_name,settings,updated_at`,
      { token: user.accessToken },
    );
    assert.equal(after.data[0].display_name, 'Nome Atualizado');
    assert.equal(after.data[0].settings.sound, false);
    assert.ok(after.data[0].updated_at >= before.data[0].updated_at);
  } finally {
    await registry.cleanup();
  }
});

// ============================================================================
// Area C: Local Persistence, Direct Online Sync, Fog Sync, Verify & Pure Math Parity
// ============================================================================

test('T1-MATH-01: Opaque-box V1/V2/V3 track oracle matches src/game/{geo,config,fog}.ts & items.ts', () => {
  fog.clear();
  try {
    const v1 = buildVectorV1();
    const v2 = buildVectorV2();
    const v3 = buildVectorV3();

    // Distance parity with src/game/geo.ts haversine
    let geoDistV1 = 0;
    for (let i = 1; i < v1.points.length; i++) {
      geoDistV1 += haversine(v1.points[i - 1], v1.points[i]);
    }
    assert.ok(Math.abs(v1.distanceM - geoDistV1) < 1e-6);

    // Cell reveal parity with src/game/fog.ts + REVEAL_RADIUS_M
    for (let i = 1; i < v1.points.length; i++) {
      fog.revealAlong(v1.points[i - 1], v1.points[i], REVEAL_RADIUS_M, () => null);
    }
    assert.equal(v1.newCells, 615);
    assert.equal(fog.size, v1.newCells);

    // XP formula parity with src/game/config.ts + src/sprites/items.ts
    const coinXpV1 =
      v1.coinsByKind.bronze * Math.max(1, Math.ceil(COIN_VALUE.bronze * XP.perCoinValue)) +
      v1.coinsByKind.silver * Math.max(1, Math.ceil(COIN_VALUE.silver * XP.perCoinValue)) +
      v1.coinsByKind.gold * Math.max(1, Math.ceil(COIN_VALUE.gold * XP.perCoinValue)) +
      v1.coinsByKind.gem * Math.max(1, Math.ceil(COIN_VALUE.gem * XP.perCoinValue));
    const expectedV1 =
      Math.floor((v1.distanceM / 1000) * XP.perKm.bike) +
      Math.floor(v1.newCells * XP.perCell.bike) +
      coinXpV1 +
      RARITY_INFO.comum.xp;
    assert.equal(v1.expectedXp, expectedV1);
    assert.equal(v1.expectedXp, 117);

    assert.equal(v2.newCells, 261);
    assert.equal(v2.expectedXp, 201);
    assert.equal(v3.newCells, 2871);
    assert.equal(v3.expectedXp, 367);
    assert.ok(v1.maxSpeed <= MAX_SPEED.bike);
    assert.ok(v2.maxSpeed <= MAX_SPEED.run);
  } finally {
    fog.clear();
  }
});

test('T1-MATH-02: Opaque-box progression oracle matches src/game/progression.ts', () => {
  for (let lvl = 1; lvl <= 30; lvl++) {
    assert.equal(oracleXpToNext(lvl), xpToNext(lvl));
  }
  for (const xp of [0, 99, 100, 117, 269, 270, 318, 367, 870, 4690]) {
    const a = oracleLevelFromXp(xp);
    const b = levelFromXp(xp);
    assert.equal(a.level, b.level);
    assert.equal(a.current, b.current);
    assert.equal(a.needed, b.needed);
  }
  assert.equal(levelFromXp(318).level, 3);
  assert.equal(levelFromXp(318).title, 'Explorador');
});

test('T1-MATH-03: Opaque-box DSBF v1 codec matches src/game/binary.ts and hex fixtures', () => {
  const fx = buildFogFixtures();
  assert.equal(Buffer.from(fx.fogABytes).toString('hex'), FOG_A_HEX);
  assert.equal(Buffer.from(fx.fogBBytes).toString('hex'), FOG_B_HEX);

  const reencodedA = encodeFog({
    keys: fx.fogA.keys,
    city: fx.fogA.city,
    cityIds: fx.fogA.cityIds,
  });
  assert.deepEqual(Buffer.from(reencodedA), Buffer.from(fx.fogABytes));

  const decodedByApp = decodeFog(fx.fogBBytes);
  const decodedByOracle = decodeDsbf(fx.fogBBytes);
  assert.ok(decodedByApp && decodedByOracle);
  assert.deepEqual(Array.from(decodedByApp.keys), Array.from(decodedByOracle.keys));
  assert.deepEqual(Array.from(decodedByApp.city), Array.from(decodedByOracle.city));
  assert.deepEqual(decodedByApp.cityIds, decodedByOracle.cityIds);
});

test('T1-MATH-04: GPX >500m jump skipping oracle matches src/game/gpxImport.ts', () => {
  fog.clear();
  try {
    const g1 = buildVectorG1();
    const xml = buildGpxXml(g1.points, 'G1 Test');
    const parsed = parseGpx(xml, 'bike');
    assert.ok(parsed);
    assert.ok(Math.abs(parsed.distanceM - 800) < 1, `Expected ~800m, got ${parsed.distanceM}`);
    assert.equal(parsed.movingS, 80);
    assert.equal(g1.movingS, 80);
    assert.equal(g1.expectedXp, 0);
    assert.equal(g1.expectedCoinsEarned, 0);

    fog.revealSegments(parsed.segments, REVEAL_RADIUS_M, () => null);
    assert.equal(fog.size, g1.newCells);
    assert.equal(g1.newCells, 258);
  } finally {
    fog.clear();
  }
});

test('T1-SYNC-01: Direct online activity finish uploads track to activity-tracks and invokes verify-activity', async (t) => {
  if (!(await gateTest(t, { milestone: 'M2', requires: ['syncEngine', 'distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession();
  try {
    const uploadUrls: string[] = [];
    const verifyCalls: string[] = [];
    await session.page.route('https://lugwebngeyadfrqoapsg.supabase.co/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/auth/v1/user')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: '00000000-0000-0000-0000-000000000021',
            email: 'sync01@desbrava-e2e.test',
          }),
        });
        return;
      }
      if (url.includes('/storage/v1/object/activity-tracks/')) {
        uploadUrls.push(url);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ Key: 'activity-tracks/mock.bin.gz' }),
        });
        return;
      }
      if (url.includes('/functions/v1/verify-activity')) {
        const bodyRaw = route.request().postData() ?? '{}';
        verifyCalls.push(bodyRaw);
        let parsedId = 'act_sync01';
        try {
          parsedId = (JSON.parse(bodyRaw) as { activityId?: string }).activityId ?? parsedId;
        } catch {
          // ignore
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'verified',
            activity: {
              id: parsedId,
              verificationStatus: 'verified',
              distanceM: 120,
              movingS: 12,
              maxSpeed: 10,
              xpEarned: 35,
              coinsEarned: 10,
              newCells: 18,
            },
            authoritative: {
              xp: 35,
              level: 1,
              wallet: 10,
              totalDistanceM: 120,
              totalMovingS: 12,
              totalActivities: 1,
              totalCells: 18,
              totalCaptures: 0,
              achievementsCount: 0,
            },
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await session.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'OnlineSyncer', modality: 'bike' });
    await seedSupabaseWebSession(session.page, {
      userId: '00000000-0000-0000-0000-000000000021',
      email: 'sync01@desbrava-e2e.test',
    });
    await session.page.reload({ waitUntil: 'domcontentloaded' });
    await session.page.getByTestId('tabbar').waitFor({ state: 'visible', timeout: 10_000 });

    await recordBriefSimRide(session.page, 1400);

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && verifyCalls.length === 0) {
      await session.page.waitForTimeout(200);
    }
    assert.ok(uploadUrls.length >= 1, 'Expected gzipped track uploaded directly to activity-tracks');
    assert.ok(verifyCalls.length >= 1, 'Expected verify-activity invoked directly online on finish');
    const keys = await listIdbKeys(session.page);
    assert.ok(keys.includes('save:v1'), 'save:v1 must persist');
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
  }
});

test('T1-SYNC-02: Direct online fog sync uploads DSBF snapshot to fog-snapshots and advances fog:sync revision', async (t) => {
  if (!(await gateTest(t, { milestone: 'M2', requires: ['syncEngine', 'distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession();
  try {
    const fogUploads: string[] = [];
    const fogRpcCalls: string[] = [];
    await session.page.route('https://lugwebngeyadfrqoapsg.supabase.co/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/auth/v1/user')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: '00000000-0000-0000-0000-000000000022',
            email: 'sync02@desbrava-e2e.test',
          }),
        });
        return;
      }
      if (url.includes('/storage/v1/object/fog-snapshots/')) {
        fogUploads.push(url);
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        return;
      }
      if (url.includes('/rest/v1/rpc/upsert_fog_state')) {
        fogRpcCalls.push(route.request().postData() ?? '{}');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            conflict: false,
            revision: 1,
            storage_path: '00000000-0000-0000-0000-000000000022/fog.bin',
            cell_count: 10,
          }),
        });
        return;
      }
      if (url.includes('/functions/v1/verify-activity')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'verified',
            activity: {
              id: 'act_fog',
              verificationStatus: 'verified',
              distanceM: 80,
              movingS: 8,
              maxSpeed: 8,
              xpEarned: 15,
              coinsEarned: 0,
              newCells: 10,
            },
            authoritative: {
              xp: 15,
              level: 1,
              wallet: 0,
              totalDistanceM: 80,
              totalMovingS: 8,
              totalActivities: 1,
              totalCells: 10,
              totalCaptures: 0,
              achievementsCount: 0,
            },
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await session.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'FogSyncer', modality: 'bike' });
    await seedSupabaseWebSession(session.page, {
      userId: '00000000-0000-0000-0000-000000000022',
      email: 'sync02@desbrava-e2e.test',
    });
    await session.page.reload({ waitUntil: 'domcontentloaded' });
    await session.page.getByTestId('tabbar').waitFor({ state: 'visible', timeout: 10_000 });

    await recordBriefSimRide(session.page, 1400);

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && fogRpcCalls.length === 0) {
      await session.page.waitForTimeout(200);
    }
    assert.ok(fogUploads.length >= 1, 'Expected fog snapshot uploaded to fog-snapshots');
    assert.ok(fogRpcCalls.length >= 1, 'Expected upsert_fog_state RPC called online');
    const fogSync = await waitForIdbKey(session.page, 'fog:sync', 5000);
    assert.equal(fogSync.kind, 'json', 'fog:sync revision metadata must be stored');
    assert.ok(
      ((fogSync.json as { revision?: number })?.revision ?? 0) >= 1,
      `Expected fog:sync revision >= 1, got ${JSON.stringify(fogSync.json)}`,
    );
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
  }
});

test('T1-FOG-01: DSBF v1 gzipped roundtrip in fog-snapshots and user_fog_state', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1fog01');
    // Migration 0007 caps upsert_fog_state.cell_count to SUM(verified activities.new_cells)
    await earnVerifiedV1(client, user.userId, user.accessToken, `act_fog01_${Date.now()}`);
    const { fogA, fogABytes } = buildFogFixtures();
    const gz = new Uint8Array(zlib.gzipSync(fogABytes));
    const storagePath = `${user.userId}/fog.bin`;

    const up = await client.storageUpload('fog-snapshots', storagePath, gz, { token: user.accessToken });
    assert.equal(up.status, 200);

    const upsert = await client.rpc<UpsertFogResult>(
      'upsert_fog_state',
      {
        p_storage_path: storagePath,
        p_cell_count: fogA.keys.length,
        p_expected_revision: 0,
      },
      { token: user.accessToken },
    );
    assert.equal(upsert.status, 200, `upsert_fog_state failed: ${upsert.rawText}`);
    assert.equal(upsert.data.conflict, false);
    assert.equal(upsert.data.revision, 1);
    assert.equal(upsert.data.storage_path, storagePath);
    assert.equal(upsert.data.cell_count, fogA.keys.length);

    const dl = await client.storageDownload('fog-snapshots', storagePath, { token: user.accessToken });
    const raw = new Uint8Array(zlib.gunzipSync(dl.bytes));
    const decoded = decodeDsbf(raw);
    assert.ok(decoded);
    assert.deepEqual(Array.from(decoded.keys), Array.from(fogA.keys));
    assert.deepEqual(decoded.cityIds, fogA.cityIds);
  } finally {
    await registry.cleanup();
  }
});

test('T1-FOG-02: Set-union DSBF merge preserves unique cells across devices', () => {
  const { c1, c2, c3, c4 } = buildFogFixtures();
  const devA = { keys: new Float64Array([c1, c2, c3]), city: new Uint16Array([1, 1, 1]), cityIds: ['', 'sp'] };
  const devB = { keys: new Float64Array([c3, c4]), city: new Uint16Array([1, 1]), cityIds: ['', 'sp'] };
  const merged = mergeDsbf(devA, devB);
  assert.equal(merged.keys.length, 4);
  const decoded = decodeDsbf(encodeDsbf(merged));
  assert.ok(decoded);
  assert.equal(decoded.keys.length, 4);
  assert.deepEqual(decoded.cityIds, ['', 'sp']);
});

test('T1-VER-01: verify-activity validates V1 bike ride and updates profiles & wallet_ledger', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1ver01');
    const actId = `act_v1_${Date.now()}`;
    const { v1, ver } = await earnVerifiedV1(client, user.userId, user.accessToken, actId);

    assert.equal(ver.status, 'verified');
    assert.equal(ver.activity.verificationStatus, 'verified');
    assert.ok(Math.abs(ver.activity.distanceM - v1.distanceM) < v1.distanceM * 0.01);
    assert.equal(ver.activity.xpEarned, v1.expectedXp);
    assert.equal(ver.activity.coinsEarned, v1.expectedCoinsEarned);
    assert.equal(ver.authoritative.xp, v1.expectedXp);
    assert.equal(ver.authoritative.wallet, v1.expectedCoinsEarned);
    assert.equal(ver.authoritative.level, 2);
    assert.equal(ver.authoritative.totalActivities, 1);

    const ledger = await client.rest<{ delta: number; reason: string; ref_id: string }[]>(
      'GET',
      `wallet_ledger?user_id=eq.${user.userId}&ref_id=eq.${actId}`,
      { token: user.accessToken },
    );
    assert.equal(ledger.status, 200);
    assert.equal(ledger.data.length, 1);
    assert.equal(ledger.data[0].delta, v1.expectedCoinsEarned);
  } finally {
    await registry.cleanup();
  }
});

test('T1-VER-02: verify-activity validates V2 run with silver/gem coins and raro POI capture', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1ver02');
    const v2 = buildVectorV2();
    const actId = `act_v2_${Date.now()}`;
    const trackPath = `${user.userId}/${actId}.bin.gz`;
    await client.storageUpload('activity-tracks', trackPath, v2.trackGzBytes, { token: user.accessToken });

    const ver = await client.invokeVerifyActivity(
      {
        activityId: actId,
        source: 'live',
        modality: 'run',
        startedAt: v2.startedAt,
        endedAt: v2.endedAt,
        trackPath,
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
    assert.equal(ver.data.status, 'verified');
    assert.equal(ver.data.activity.xpEarned, v2.expectedXp);
    assert.equal(ver.data.activity.coinsEarned, v2.expectedCoinsEarned);
    assert.equal(ver.data.authoritative.wallet, 105);
  } finally {
    await registry.cleanup();
  }
});

test('T1-VER-03: verify-activity idempotent replay never double-credits XP or wallet', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1ver03');
    const actId = `act_idem_${Date.now()}`;
    const { v1, ver: first } = await earnVerifiedV1(client, user.userId, user.accessToken, actId);

    const replay = await client.invokeVerifyActivity(
      {
        activityId: actId,
        source: 'live',
        modality: 'bike',
        startedAt: v1.startedAt,
        endedAt: v1.endedAt,
        trackPath: `${user.userId}/${actId}.bin.gz`,
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
      { token: user.accessToken },
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.data.authoritative.xp, first.authoritative.xp);
    assert.equal(replay.data.authoritative.wallet, first.authoritative.wallet);

    const ledger = await client.rest<unknown[]>(
      'GET',
      `wallet_ledger?user_id=eq.${user.userId}&ref_id=eq.${actId}`,
      { token: user.accessToken },
    );
    assert.equal(ledger.data.length, 1);
  } finally {
    await registry.cleanup();
  }
});

test('T1-VER-04: verify-activity V3 cumulative levelFromXp parity reaches Level 3', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1ver04');
    const v3 = buildVectorV3();
    const actId = `act_v3_${Date.now()}`;
    const trackPath = `${user.userId}/${actId}.bin.gz`;
    await client.storageUpload('activity-tracks', trackPath, v3.trackGzBytes, { token: user.accessToken });

    const ver = await client.invokeVerifyActivity(
      {
        activityId: actId,
        source: 'live',
        modality: 'bike',
        startedAt: v3.startedAt,
        endedAt: v3.endedAt,
        trackPath,
        clientSummary: {
          distanceM: v3.distanceM,
          movingS: v3.movingS,
          maxSpeed: v3.maxSpeed,
          newCells: v3.newCells,
          coinsCount: 0,
          coinsValue: 0,
          captures: [],
          cityIds: v3.cityIds,
        },
      },
      { token: user.accessToken },
    );
    assert.equal(ver.status, 200);
    assert.equal(ver.data.status, 'verified');
    assert.equal(ver.data.authoritative.xp, v3.expectedXp);
    assert.equal(ver.data.authoritative.level, levelFromXp(ver.data.authoritative.xp).level);
    assert.equal(ver.data.authoritative.level, 3);
  } finally {
    await registry.cleanup();
  }
});

test('T1-VER-05: Client reconciliation aligns local state with server authoritative totals', async (t) => {
  if (!(await gateTest(t, { milestone: 'M2', requires: ['schema', 'verifyActivity', 'syncEngine', 'distWeb'] }))) return;
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
            id: '00000000-0000-0000-0000-000000000025',
            email: 'ver05@desbrava-e2e.test',
          }),
        });
        return;
      }
      if (url.includes('/functions/v1/verify-activity')) {
        let parsedId = 'act_reconcile';
        try {
          parsedId = (JSON.parse(route.request().postData() ?? '{}') as { activityId?: string }).activityId ?? parsedId;
        } catch {
          // ignore
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'verified',
            activity: {
              id: parsedId,
              verificationStatus: 'verified',
              distanceM: 4321,
              movingS: 321,
              maxSpeed: 8.5,
              xpEarned: 777,
              coinsEarned: 345,
              newCells: 888,
            },
            authoritative: {
              xp: 777,
              level: 4,
              wallet: 345,
              totalDistanceM: 4321,
              totalMovingS: 321,
              totalActivities: 3,
              totalCells: 888,
              totalCaptures: 2,
              achievementsCount: 1,
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{}',
      });
    });

    await session.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'Reconciler', modality: 'bike' });
    await seedSupabaseWebSession(session.page, {
      userId: '00000000-0000-0000-0000-000000000025',
      email: 'ver05@desbrava-e2e.test',
    });
    await session.page.reload({ waitUntil: 'domcontentloaded' });
    await session.page.getByTestId('tabbar').waitFor({ state: 'visible', timeout: 10_000 });

    await recordBriefSimRide(session.page, 1400);

    const deadline = Date.now() + 8000;
    let reconciled = false;
    type ReconciledSave = {
      xp?: number;
      wallet?: number;
      totals?: { distanceM?: number; activities?: number };
    };
    let lastSave: ReconciledSave | null = null;
    while (Date.now() < deadline) {
      const val = await readIdbKey(session.page, 'save:v1');
      if (val.kind === 'json') {
        lastSave = val.json as ReconciledSave;
        if (lastSave?.xp === 777 && lastSave?.wallet === 345) {
          reconciled = true;
          break;
        }
      }
      await session.page.waitForTimeout(250);
    }
    assert.equal(reconciled, true, `save:v1 did not reconcile to server totals: ${JSON.stringify(lastSave)}`);
    assert.equal(lastSave?.totals?.distanceM, 4321);
    assert.equal(lastSave?.totals?.activities, 3);

    await session.page.getByTestId('tab-map').click();
    const chipText = await session.page.getByTestId('player-chip').innerText();
    assert.ok(chipText.includes('NV 4'), `Expected NV 4 in player-chip, got ${chipText}`);
    const walletText = await session.page.getByTestId('wallet').innerText();
    assert.ok(walletText.includes('345'), `Expected 345 in wallet HUD, got ${walletText}`);
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
  }
});

// ============================================================================
// Area D: Social, Friendships, Invite Deep Links & Leaderboards
// ============================================================================

test('T1-SOC-01: search_users RPC returns public summaries and hides wallet/settings', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const uname = `soc_pub_${Date.now().toString(36)}`;
    const userA = await registry.provisionUser('t1soc01_a', {
      username: uname,
      displayName: 'Ciclista Aberto',
      isPublic: true,
    });
    const userB = await registry.provisionUser('t1soc01_b');

    const res = await client.rpc<Record<string, unknown>[]>(
      'search_users',
      { p_query: uname, p_limit: 20 },
      { token: userB.accessToken },
    );
    assert.equal(res.status, 200);
    const match = res.data.find((r) => r.id === userA.userId);
    assert.ok(match, 'Expected User A in search results');
    assert.equal('wallet' in match, false, 'search_users must NEVER expose wallet');
    assert.equal('settings' in match, false, 'search_users must NEVER expose settings');
  } finally {
    await registry.cleanup();
  }
});

test('T1-SOC-02: Invite link (?add=<username>) parses cleanly in web app', async (t) => {
  if (!(await gateTest(t, { milestone: 'M4', requires: ['socialUi', 'authUi', 'distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession();
  try {
    await session.page.goto(`${server.baseUrl}/?skip=1&add=piloto_convite`, {
      waitUntil: 'domcontentloaded',
    });
    await completeGuestOnboarding(session.page, { name: 'ConvidadoLink', modality: 'bike' });
    await session.page.getByTestId('tab-social').click();
    await session.page.waitForTimeout(400);

    const inviteText = await session.page
      .getByTestId('social-pending-invite')
      .innerText()
      .catch(() => '');
    const bodyText = await session.page.locator('body').innerText().catch(() => '');
    const ls = await readLocalStorageAll(session.page);
    const idbKeys = await listIdbKeys(session.page);
    const idbValues: string[] = [];
    for (const k of idbKeys) {
      const v = await readIdbKey(session.page, k);
      if (v.kind === 'json') idbValues.push(JSON.stringify(v.json));
    }

    const foundInUi = inviteText.includes('piloto_convite') || bodyText.includes('piloto_convite');
    const foundInStorage =
      Object.values(ls).some((v) => v.includes('piloto_convite')) ||
      idbValues.some((v) => v.includes('piloto_convite'));
    assert.ok(
      foundInUi || foundInStorage,
      'Pending invite "piloto_convite" must be retained in storage or surfaced in Social UI',
    );
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
  }
});

test('T1-SOC-03: Mutual friendship lifecycle pending -> accepted', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const userA = await registry.provisionUser('t1soc03_a');
    const userB = await registry.provisionUser('t1soc03_b');

    const req = await client.rest<{ id: string; status: string }[]>('POST', 'friendships', {
      token: userA.accessToken,
      prefer: 'return=representation',
      body: { requester_id: userA.userId, addressee_id: userB.userId, status: 'pending' },
    });
    assert.ok(req.ok, `Friend request failed: ${req.rawText}`);
    const fId = req.data[0].id;
    assert.equal(req.data[0].status, 'pending');

    const acc = await client.rest<{ status: string }[]>('PATCH', `friendships?id=eq.${fId}`, {
      token: userB.accessToken,
      prefer: 'return=representation',
      body: { status: 'accepted' },
    });
    assert.ok(acc.ok, `Accept friend failed: ${acc.rawText}`);
    assert.equal(acc.data[0].status, 'accepted');
  } finally {
    await registry.cleanup();
  }
});

test('T1-SOC-04: Accepted friend summary never leaks private tracks or individual activities', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const userA = await registry.provisionUser('t1soc04_a', { username: `priv_a_${Date.now().toString(36)}` });
    const userB = await registry.provisionUser('t1soc04_b');
    await earnVerifiedV1(client, userA.userId, userA.accessToken, `act_priv_${Date.now()}`);

    const req = await client.rest<{ id: string }[]>('POST', 'friendships', {
      token: userA.accessToken,
      prefer: 'return=representation',
      body: { requester_id: userA.userId, addressee_id: userB.userId, status: 'pending' },
    });
    assert.ok(req.ok, `Friend request failed: ${req.rawText}`);
    const acc = await client.rest('PATCH', `friendships?id=eq.${req.data[0].id}`, {
      token: userB.accessToken,
      body: { status: 'accepted' },
    });
    assert.ok(acc.ok, `Accept friend failed: ${acc.rawText}`);

    // User B still cannot read User A's activities or tracks
    const acts = await client.rest<unknown[]>('GET', `activities?user_id=eq.${userA.userId}`, {
      token: userB.accessToken,
    });
    assert.equal(acts.data.length, 0);
  } finally {
    await registry.cleanup();
  }
});

test('T1-LB-01: get_friends_leaderboard ranks accepted friends across xp, distance, cells', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const userA = await registry.provisionUser('t1lb01_a');
    const userB = await registry.provisionUser('t1lb01_b');
    const userC = await registry.provisionUser('t1lb01_c');

    // User A: V2 run (201 XP, 1080m, 261 cells); User B: V1 bike (117 XP, 2100m, 615 cells)
    const v2 = buildVectorV2(Date.now() - 120_000);
    const tpA = `${userA.userId}/act_lba_${Date.now()}.bin.gz`;
    await client.storageUpload('activity-tracks', tpA, v2.trackGzBytes, { token: userA.accessToken });
    const verA = await client.invokeVerifyActivity(
      {
        activityId: `act_lba_${Date.now()}`,
        source: 'live',
        modality: 'run',
        startedAt: v2.startedAt,
        endedAt: v2.endedAt,
        trackPath: tpA,
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
      { token: userA.accessToken },
    );
    assert.equal(verA.status, 200, `User A verify-activity failed: ${verA.rawText}`);
    await earnVerifiedV1(client, userB.userId, userB.accessToken, `act_lbb_${Date.now()}`);

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

    const lbXp = await client.rpc<{ user_id?: string; id?: string }[]>(
      'get_friends_leaderboard',
      { p_metric: 'xp', p_period: 'all_time' },
      { token: userA.accessToken },
    );
    assert.equal(lbXp.status, 200);
    const idsXp = lbXp.data.map((r) => r.user_id ?? r.id);
    assert.equal(idsXp[0], userA.userId);
    assert.equal(idsXp[1], userB.userId);
    assert.equal(idsXp.includes(userC.userId), false);

    const lbDist = await client.rpc<{ user_id?: string; id?: string }[]>(
      'get_friends_leaderboard',
      { p_metric: 'distance', p_period: 'all_time' },
      { token: userA.accessToken },
    );
    assert.equal(lbDist.status, 200);
    const idsDist = lbDist.data.map((r) => r.user_id ?? r.id);
    assert.equal(idsDist[0], userB.userId);
  } finally {
    await registry.cleanup();
  }
});

test('T1-LB-02: get_friends_leaderboard monthly filters current America/Sao_Paulo verified activities', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const userA = await registry.provisionUser('t1lb02_a');
    // Old activity from 2023 (T0_MS) should NOT appear in current month's score
    await earnVerifiedV1(client, userA.userId, userA.accessToken, `act_old_${Date.now()}`);

    const lbMonthly = await client.rpc<{ score?: number; xp?: number; value?: number }[]>(
      'get_friends_leaderboard',
      { p_metric: 'xp', p_period: 'monthly' },
      { token: userA.accessToken },
    );
    assert.equal(lbMonthly.status, 200);
    const selfRow = lbMonthly.data[0];
    const score = Number(selfRow?.score ?? selfRow?.xp ?? selfRow?.value ?? 0);
    assert.equal(score, 0, '2023 activity must not count toward current monthly leaderboard');
  } finally {
    await registry.cleanup();
  }
});

test('T1-LB-03: get_global_leaderboard all_time returns entries and my_rank ordered descending', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1lb03', { isPublic: true });
    await earnVerifiedV1(client, user.userId, user.accessToken, `act_glb_${Date.now()}`);
    const res = await client.rpc<{ entries: unknown[]; my_rank: GlobalRankRow }>(
      'get_global_leaderboard',
      { p_metric: 'xp', p_period: 'all_time', p_limit: 50, p_offset: 0 },
      { token: user.accessToken },
    );
    assert.equal(res.status, 200, `get_global_leaderboard failed: ${res.rawText}`);
    assert.ok(Array.isArray(res.data.entries));
    const rankNum = extractRankNumber(res.data.my_rank);
    assert.ok(rankNum !== null && rankNum >= 1, `Expected my_rank >= 1, got ${JSON.stringify(res.data.my_rank)}`);
    if (res.data.my_rank && typeof res.data.my_rank === 'object') {
      assert.equal(res.data.my_rank.user_id, user.userId);
      assert.equal(res.data.my_rank.is_me, true);
    }
  } finally {
    await registry.cleanup();
  }
});

test('T1-LB-04: get_global_leaderboard monthly aggregates current month verified activities', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1lb04', { isPublic: true });
    const v1 = buildVectorV1(Date.now() - 300_000);
    const actId = `act_glbm_${Date.now()}`;
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
      },
      { token: user.accessToken },
    );
    assert.equal(ver.status, 200, `verify-activity failed: ${ver.rawText}`);
    const res = await client.rpc<{ entries: { user_id?: string; id?: string }[]; my_rank: GlobalRankRow }>(
      'get_global_leaderboard',
      { p_metric: 'xp', p_period: 'monthly', p_limit: 50, p_offset: 0 },
      { token: user.accessToken },
    );
    assert.equal(res.status, 200);
    const rankNum = extractRankNumber(res.data.my_rank);
    assert.ok(rankNum !== null && rankNum >= 1, `Expected my_rank >= 1, got ${JSON.stringify(res.data.my_rank)}`);
    const inEntries = res.data.entries.some((e) => (e.user_id ?? e.id) === user.userId);
    const inMyRank =
      typeof res.data.my_rank === 'object' && res.data.my_rank !== null && res.data.my_rank.user_id === user.userId;
    assert.ok(inEntries || inMyRank, 'Expected user in monthly global leaderboard entries or my_rank');
  } finally {
    await registry.cleanup();
  }
});

test('T1-LB-05: get_global_leaderboard returns accurate my_rank even when p_limit=1', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1lb05', { isPublic: true });
    const res = await client.rpc<{ entries: unknown[]; my_rank: GlobalRankRow }>(
      'get_global_leaderboard',
      { p_metric: 'xp', p_period: 'all_time', p_limit: 1, p_offset: 0 },
      { token: user.accessToken },
    );
    assert.equal(res.status, 200);
    assert.ok(res.data.entries.length <= 1);
    const rankNum = extractRankNumber(res.data.my_rank);
    assert.ok(rankNum !== null && rankNum >= 1, `Expected my_rank >= 1, got ${JSON.stringify(res.data.my_rank)}`);
    if (res.data.my_rank && typeof res.data.my_rank === 'object') {
      assert.equal(res.data.my_rank.user_id, user.userId);
    }
  } finally {
    await registry.cleanup();
  }
});

// ============================================================================
// Area E: Store, Cosmetics, Atomic Purchases & Online Boosters
// ============================================================================

test('T1-STR-01: Store catalog contains active cosmetics and booster consumables', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1str01');
    const res = await client.rest<{ id: string; kind: string; category: string; price_coins: number; max_stack: number | null }[]>(
      'GET',
      'store_items?is_active=eq.true&select=id,kind,category,price_coins,max_stack,metadata',
      { token: user.accessToken },
    );
    assert.equal(res.status, 200);
    assert.ok(res.data.some((i) => i.kind === 'cosmetic' && i.max_stack === 1));
    assert.ok(res.data.some((i) => i.kind === 'consumable' && i.category.startsWith('boost_')));
  } finally {
    await registry.cleanup();
  }
});

test('T1-STR-02: Shop tab renders catalog in web UI without errors', async (t) => {
  if (!(await gateTest(t, { milestone: 'M5', requires: ['storeUi', 'distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession();
  try {
    await session.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'ShopGuest', modality: 'bike' });
    await session.page.getByTestId('tab-shop').or(session.page.getByText(/Loja/i)).first().click();

    await session.page
      .getByTestId('shop-item-boost_xp_2x')
      .or(session.page.getByTestId('shop-item-hat_bone_retro'))
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 });
    const bodyText = await session.page.locator('body').innerText();
    assert.ok(
      /Boné Retrô|80/i.test(bodyText) && /Dobro de XP|60/i.test(bodyText),
      'Shop UI must render seeded cosmetic and booster catalog items',
    );
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
  }
});

test('T1-STR-03: purchase_store_item debits verified wallet, logs wallet_ledger, and stacks consumables', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1str03');
    // Earn 27 + 105 = 132 verified coins (plus claim achievement if needed)
    await earnVerifiedV1(client, user.userId, user.accessToken, `act_s1_${Date.now()}`);
    const v2 = buildVectorV2();
    const tp2 = `${user.userId}/act_s2_${Date.now()}.bin.gz`;
    await client.storageUpload('activity-tracks', tp2, v2.trackGzBytes, { token: user.accessToken });
    const ver2 = await client.invokeVerifyActivity(
      {
        activityId: `act_s2_${Date.now()}`,
        source: 'live',
        modality: 'run',
        startedAt: v2.startedAt,
        endedAt: v2.endedAt,
        trackPath: tp2,
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
    assert.equal(ver2.status, 200, `V2 verify-activity failed: ${ver2.rawText}`);
    const startWallet = ver2.data.authoritative.wallet;

    const items = await client.rest<{ id: string; kind: string; price_coins: number }[]>(
      'GET',
      `store_items?is_active=eq.true&price_coins=lte.${Math.floor(startWallet / 2)}&order=price_coins.asc&select=id,kind,price_coins`,
      { token: user.accessToken },
    );
    const consumable = items.data.find((i) => i.kind === 'consumable');
    assert.ok(consumable, 'Expected affordable consumable in store_items');

    const buy = await client.rpc('purchase_store_item', {
      p_item_id: consumable.id,
      p_quantity: 2,
    }, { token: user.accessToken });
    assert.equal(buy.status, 200, `purchase_store_item failed: ${buy.rawText}`);

    const inv = await client.rest<{ quantity: number }[]>(
      'GET',
      `user_inventory?user_id=eq.${user.userId}&item_id=eq.${consumable.id}&select=quantity`,
      { token: user.accessToken },
    );
    assert.equal(inv.data[0].quantity, 2);

    const prof = await client.rest<{ wallet: number }[]>(
      'GET',
      `profiles?id=eq.${user.userId}&select=wallet`,
      { token: user.accessToken },
    );
    assert.equal(prof.data[0].wallet, startWallet - consumable.price_coins * 2);
  } finally {
    await registry.cleanup();
  }
});

test('T1-STR-04: Online booster activation reconciles multiplier and decrements inventory via verify-activity', async (t) => {
  if (!(await gateTest(t, { milestone: 'M1', requires: ['schema', 'verifyActivity', 'serviceRoleKey'] }))) return;
  const client = new SupabaseHttpClient();
  const registry = new TestUserRegistry(client);
  try {
    const user = await registry.provisionUser('t1str04');
    // Earn coins via V2 (105 coins)
    const v2 = buildVectorV2(T0_MS);
    const tp0 = `${user.userId}/act_b0_${Date.now()}.bin.gz`;
    await client.storageUpload('activity-tracks', tp0, v2.trackGzBytes, { token: user.accessToken });
    const ver0 = await client.invokeVerifyActivity(
      {
        activityId: `act_b0_${Date.now()}`,
        source: 'live',
        modality: 'run',
        startedAt: v2.startedAt,
        endedAt: v2.endedAt,
        trackPath: tp0,
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
    assert.equal(ver0.status, 200, `Seed V2 verify-activity failed: ${ver0.rawText}`);

    const items = await client.rest<{ id: string; price_coins: number; metadata: { multiplier?: number } }[]>(
      'GET',
      'store_items?is_active=eq.true&category=eq.boost_xp&order=price_coins.asc&select=id,price_coins,metadata',
      { token: user.accessToken },
    );
    const boostXp = items.data[0];
    assert.ok(boostXp, 'Expected boost_xp item in store_items');
    const buy = await client.rpc(
      'purchase_store_item',
      { p_item_id: boostXp.id, p_quantity: 1 },
      { token: user.accessToken },
    );
    assert.equal(buy.status, 200, `Booster purchase failed: ${buy.rawText}`);

    const v1 = buildVectorV1(T0_MS + 1_000_000);
    const boostUsageId = `boost_use_${Date.now()}`;
    const actId = `act_boosted_${Date.now()}`;
    const boostIns = await client.rest('POST', 'user_boost_usages', {
      token: user.accessToken,
      body: {
        id: boostUsageId,
        user_id: user.userId,
        item_id: boostXp.id,
        activity_id: actId,
        activated_at: new Date(v1.startedAt).toISOString(),
        expires_at: new Date(v1.endedAt + 600_000).toISOString(),
      },
    });
    assert.ok(boostIns.ok, `user_boost_usages insert failed: ${boostIns.rawText}`);

    const tp1 = `${user.userId}/${actId}.bin.gz`;
    await client.storageUpload('activity-tracks', tp1, v1.trackGzBytes, { token: user.accessToken });
    const ver = await client.invokeVerifyActivity(
      {
        activityId: actId,
        source: 'live',
        modality: 'bike',
        startedAt: v1.startedAt,
        endedAt: v1.endedAt,
        trackPath: tp1,
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
        boostUsageIds: [boostUsageId],
      },
      { token: user.accessToken },
    );
    assert.equal(ver.status, 200);
    assert.ok(ver.data.activity.xpEarned > v1.expectedXp, 'Boosted XP must exceed base V1 XP');

    const inv = await client.rest<{ quantity: number }[]>(
      'GET',
      `user_inventory?user_id=eq.${user.userId}&item_id=eq.${boostXp.id}&select=quantity`,
      { token: user.accessToken },
    );
    assert.equal(inv.data[0].quantity, 0, 'Booster inventory must decrement from 1 to 0');
  } finally {
    await registry.cleanup();
  }
});

test('T1-STR-05: Store purchase fails safely with zero balance mutation when Supabase is unreachable', async (t) => {
  if (!(await gateTest(t, { milestone: 'M5', requires: ['storeUi', 'distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession({ allowOfflineErrors: true });
  try {
    await session.page.route('https://lugwebngeyadfrqoapsg.supabase.co/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/auth/v1/user')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: '00000000-0000-0000-0000-000000000035',
            email: 'str05@desbrava-e2e.test',
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
              name: 'Dobro de XP',
              description: '2x XP',
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
        await route.abort('internetdisconnected');
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await session.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'ShopNetworkErr', modality: 'bike' });
    await seedSupabaseWebSession(session.page, {
      userId: '00000000-0000-0000-0000-000000000035',
      email: 'str05@desbrava-e2e.test',
    });

    const saveVal = await readIdbKey(session.page, 'save:v1');
    const saveObj = (saveVal.json ?? {}) as Record<string, unknown>;
    saveObj.wallet = 500;
    await writeIdbKey(session.page, 'save:v1', saveObj);

    await session.page.reload({ waitUntil: 'domcontentloaded' });
    await session.page.getByTestId('tabbar').waitFor({ state: 'visible', timeout: 10_000 });

    await session.page.getByTestId('tab-shop').or(session.page.getByText(/Loja/i)).first().click();
    await session.page
      .getByTestId('shop-item-boost_xp_2x')
      .or(session.page.getByTestId('shop-buy-btn'))
      .first()
      .waitFor({ state: 'visible', timeout: 8000 });

    await setExternalOffline(session, server.baseUrl, true);
    const buyBtn = session.page.getByTestId('shop-buy-btn').first();
    const isDisabled = await buyBtn.isDisabled().catch(() => false);
    if (!isDisabled) {
      await buyBtn.click();
      await session.page.waitForTimeout(400);
      const errVisible = await session.page
        .getByTestId('store-offline-error')
        .isVisible()
        .catch(() => false);
      const bodyText = await session.page.locator('body').innerText();
      assert.ok(
        errVisible || /offline|sem internet|sem conexão|erro|falh/i.test(bodyText),
        'Failed store purchase must show localized pt-BR error when clickable without network',
      );
    }

    const saveAfter = await readIdbKey(session.page, 'save:v1');
    assert.equal(saveAfter.kind, 'json');
    assert.equal((saveAfter.json as { wallet?: number })?.wallet, 500, 'Failed purchase must NOT mutate wallet');
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
  }
});

// ============================================================================
// Area F: Web Boot & Playwright Headless Browser Acceptance
// ============================================================================

test('T1-WEB-01: Web bundle boots in headless Chrome with zero pageerrors', async (t) => {
  if (!(await gateTest(t, { milestone: 'Baseline', requires: ['distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession();
  try {
    await session.page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await session.page.getByTestId('title-screen').waitFor({ state: 'visible', timeout: 15_000 });
    const titleText = await session.page.getByTestId('title-screen').innerText();
    assert.ok(titleText.includes('DESBRAVA'));
    assert.ok(titleText.includes('COMEÇAR'));
    assert.equal(session.pageErrors.length, 0, `pageErrors: ${session.pageErrors.join('; ')}`);
    assert.equal(session.consoleErrors.length, 0, `consoleErrors: ${session.consoleErrors.join('; ')}`);
  } finally {
    await session.close();
    await server.close();
  }
});

test('T1-WEB-02: 3-step guest onboarding persists across browser reload via IndexedDB', async (t) => {
  if (!(await gateTest(t, { milestone: 'Baseline', requires: ['distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession();
  try {
    await session.page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'Explorador Web', modality: 'run' });
    await waitForIdbKey(session.page, 'save:v1', 5000);
    // Allow debounced save to flush
    await session.page.waitForTimeout(1800);
    await session.page.reload({ waitUntil: 'domcontentloaded' });
    // TitleScreen appears on `/` without `?skip`; pressing start skips CreateScreen directly into Game.
    await session.page.getByTestId('press-start').waitFor({ state: 'visible', timeout: 15_000 });
    await session.page.getByTestId('press-start').click();
    await session.page.getByTestId('tabbar').waitFor({ state: 'visible', timeout: 15_000 });
    if (await session.page.getByTestId('start').isVisible().catch(() => false)) {
      await session.page.getByTestId('tab-map').click();
    }
    const createVisible = await session.page
      .getByTestId('create-screen')
      .isVisible()
      .catch(() => false);
    assert.equal(createVisible, false, 'Reloaded guest with save:v1 must skip CreateScreen');
    const chip = await session.page.getByTestId('player-chip').innerText();
    assert.ok(chip.includes('Explorador Web'), `Expected restored name, got ${chip}`);
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
  }
});

test('T1-WEB-03: Tab navigation renders StatsScreen sections cleanly in pt-BR', async (t) => {
  if (!(await gateTest(t, { milestone: 'Baseline', requires: ['distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession();
  try {
    await session.page.goto(`${server.baseUrl}/?skip=1`, { waitUntil: 'domcontentloaded' });
    await session.page.getByTestId('create-screen').waitFor({ state: 'visible', timeout: 15_000 });
    await session.page.getByTestId('step-next-0').click();
    await session.page.getByTestId('step-next-1').click();
    await session.page.getByTestId('hero-name').fill('Navegador');
    await session.page.getByTestId('create-start').click();
    await session.page.getByTestId('tab-stats').click();
    await session.page.getByTestId('stats-scroll').waitFor({ state: 'visible', timeout: 10_000 });
    const text = await session.page.getByTestId('stats-scroll').innerText();
    assert.ok(text.includes('TOTAIS'));
    assert.ok(text.includes('CONQUISTAS'));
    assert.ok(text.includes('ATIVIDADES'));
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
  }
});

test('T1-WEB-04: Simulator activity lifecycle persists save:v1, fog:v2, and track:* in IndexedDB', async (t) => {
  if (!(await gateTest(t, { milestone: 'Baseline', requires: ['distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession();
  try {
    await session.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'Ciclista Sim', modality: 'bike' });

    await session.page.getByTestId('tab-record').click();
    await session.page.getByTestId('start').click();
    await session.page.keyboard.down('ArrowUp');
    await session.page.waitForTimeout(1500);
    await session.page.keyboard.up('ArrowUp');

    await session.page.getByTestId('pause').click();
    await drainModals(session.page);
    await session.page.getByTestId('finish').click();
    const sawSummary = await drainModals(session.page, { expectSummary: true });
    assert.equal(sawSummary, true, 'Expected modal-summary after finishing ride');
    await session.page.getByTestId('modal-ok').click();

    // Wait past 1500ms scheduleSave debounce
    await session.page.waitForTimeout(1800);
    const keys = await listIdbKeys(session.page);
    assert.ok(keys.includes('save:v1'), `Missing save:v1 in IDB keys: ${keys.join(',')}`);
    assert.ok(keys.includes('fog:v2'), `Missing fog:v2 in IDB keys: ${keys.join(',')}`);
    assert.ok(keys.some((k) => k.startsWith('track:act_')), `Missing track:act_* in IDB keys: ${keys.join(',')}`);

    const fogVal = await readIdbKey(session.page, 'fog:v2');
    assert.equal(fogVal.kind, 'uint8array');
    const decoded = decodeDsbf(Uint8Array.from(fogVal.bytes ?? []));
    assert.ok(decoded && decoded.keys.length > 0, 'Expected non-empty decoded DSBF fog cells');
    assert.equal(session.pageErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
  }
});

test('T1-WEB-05: Web Auth, Social, and Shop tabs navigate without uncaught runtime errors', async (t) => {
  if (!(await gateTest(t, { milestone: 'M5', requires: ['authUi', 'socialUi', 'storeUi', 'distWeb'] }))) return;
  const server = await startDistServer();
  const session = await launchWebSession();
  try {
    await session.page.goto(`${server.baseUrl}/?sim=1`, { waitUntil: 'domcontentloaded' });
    await completeGuestOnboarding(session.page, { name: 'AllTabs', modality: 'bike' });
    for (const tid of ['tab-social', 'tab-shop', 'tab-stats', 'tab-map']) {
      await session.page.getByTestId(tid).click();
      await session.page.waitForTimeout(250);
    }
    assert.equal(session.pageErrors.length, 0);
    assert.equal(session.consoleErrors.length, 0);
  } finally {
    await session.close();
    await server.close();
  }
});
