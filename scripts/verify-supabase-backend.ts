// Suíte automatizada de verificação do backend Supabase (RLS, Storage, RPCs e verify-activity).
// Rodar com: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test scripts/verify-supabase-backend.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  MAX_SPEED,
  REVEAL_RADIUS_M,
  XP,
} from '../src/game/config.ts';
import {
  cellsInRadius,
  haversine,
  lerpLngLat,
  type LngLat,
} from '../src/game/geo.ts';
import { levelFromXp } from '../src/game/progression.ts';
import { COIN_VALUE, RARITY_INFO } from '../src/sprites/items.ts';

try {
  process.loadEnvFile('.env.local');
} catch {
  // Variáveis podem vir diretamente do ambiente de execução
}

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  '';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? '';

assert.ok(SUPABASE_URL, 'EXPO_PUBLIC_SUPABASE_URL deve estar configurada');
assert.ok(SUPABASE_KEY, 'EXPO_PUBLIC_SUPABASE_ANON_KEY ou PUBLISHABLE_KEY deve estar configurada');

const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

interface UserCtx {
  id: string;
  email: string;
  accessToken: string;
  client: SupabaseClient;
  username: string;
  displayName: string;
}

function makeAnonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function makeAuthedClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function encodeTrackGz(points: Array<{ lng: number; lat: number; t: number }>): Uint8Array {
  const f64 = new Float64Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    f64[i * 3] = points[i].lng;
    f64[i * 3 + 1] = points[i].lat;
    f64[i * 3 + 2] = points[i].t;
  }
  const bytes = new Uint8Array(f64.buffer, f64.byteOffset, f64.byteLength);
  return new Uint8Array(gzipSync(bytes));
}

function countTrackCells(points: LngLat[], radius = REVEAL_RADIUS_M): number {
  const set = new Set<number>();
  if (points.length === 1) {
    for (const k of cellsInRadius(points[0], radius)) set.add(k);
    return set.size;
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dist = haversine(a, b);
    const steps = Math.max(1, Math.ceil(dist / (radius * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const p = lerpLngLat(a, b, s / steps);
      for (const k of cellsInRadius(p, radius)) set.add(k);
    }
  }
  return set.size;
}

async function invokeVerifyActivity(
  accessToken: string | null,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    apikey: SUPABASE_KEY,
    'Content-Type': 'application/json',
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  const res = await fetch(`${SUPABASE_URL}/functions/v1/verify-activity`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

test('Suíte completa de backend Supabase, RLS, RPCs e verify-activity', async (t) => {
  let adminClient: SupabaseClient | null = null;
  let ephemeralUsers = false;
  let userA!: UserCtx;
  let userB!: UserCtx;
  const uploadedPathsA: string[] = [];
  const uploadedPathsB: string[] = [];

  async function signInUser(email: string, password: string): Promise<UserCtx> {
    const c = makeAnonClient();
    const { data, error } = await c.auth.signInWithPassword({ email, password });
    assert.ifError(error);
    assert.ok(data.user && data.session, `Sessão ausente para ${email}`);
    const authed = makeAuthedClient(data.session.access_token);
    const { data: prof, error: profErr } = await authed
      .from('profiles')
      .select('id, username, display_name')
      .eq('id', data.user.id)
      .single();
    assert.ifError(profErr);
    assert.ok(prof, 'Perfil deve existir via trigger handle_new_user');
    return {
      id: data.user.id,
      email,
      accessToken: data.session.access_token,
      client: authed,
      username: (prof.username as string) ?? '',
      displayName: (prof.display_name as string) ?? '',
    };
  }

  // Provisionamento sem envio de e-mail: Mode 1 (service_role admin API) ou Mode 2 (TEST_USER_* pré-confirmados)
  if (SERVICE_ROLE_KEY) {
    ephemeralUsers = true;
    adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const emailA = `desbrava.e2e.a.${RUN_ID}@example.com`;
    const emailB = `desbrava.e2e.b.${RUN_ID}@example.com`;
    const pass = `Desbrava!${RUN_ID}#9`;
    const resA = await adminClient.auth.admin.createUser({
      email: emailA,
      password: pass,
      email_confirm: true,
      user_metadata: { display_name: `Tester A ${RUN_ID}`, modality: 'bike' },
    });
    assert.ifError(resA.error);
    const resB = await adminClient.auth.admin.createUser({
      email: emailB,
      password: pass,
      email_confirm: true,
      user_metadata: { display_name: `Tester B ${RUN_ID}`, modality: 'run' },
    });
    assert.ifError(resB.error);
    userA = await signInUser(emailA, pass);
    userB = await signInUser(emailB, pass);
  } else if (
    process.env.TEST_USER_A_EMAIL &&
    process.env.TEST_USER_A_PASSWORD &&
    process.env.TEST_USER_B_EMAIL &&
    process.env.TEST_USER_B_PASSWORD
  ) {
    userA = await signInUser(process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
    userB = await signInUser(process.env.TEST_USER_B_EMAIL, process.env.TEST_USER_B_PASSWORD);
  } else {
    throw new Error(
      'Credenciais ausentes: configure SUPABASE_SERVICE_ROLE_KEY (admin createUser com email_confirm: true) ou TEST_USER_A_*/TEST_USER_B_* pré-confirmados em .env.local. Nunca utilize signUp() com e-mails fictícios.',
    );
  }

  // Tornar ambos visíveis apenas durante os testes sociais/ranking e limpar amizades prévias
  await userA.client.from('profiles').update({ is_public: true }).eq('id', userA.id);
  await userB.client.from('profiles').update({ is_public: true }).eq('id', userB.id);
  await userA.client
    .from('friendships')
    .delete()
    .or(`and(requester_id.eq.${userA.id},addressee_id.eq.${userB.id}),and(requester_id.eq.${userB.id},addressee_id.eq.${userA.id})`);

  t.after(async () => {
    try {
      await userA.client
        .from('friendships')
        .delete()
        .or(`and(requester_id.eq.${userA.id},addressee_id.eq.${userB.id}),and(requester_id.eq.${userB.id},addressee_id.eq.${userA.id})`);
      await userA.client.from('profiles').update({ is_public: false }).eq('id', userA.id);
      await userB.client.from('profiles').update({ is_public: false }).eq('id', userB.id);
      if (uploadedPathsA.length > 0) {
        await userA.client.storage.from('activity-tracks').remove(uploadedPathsA);
      }
      if (uploadedPathsB.length > 0) {
        await userB.client.storage.from('activity-tracks').remove(uploadedPathsB);
      }
      if (ephemeralUsers && adminClient) {
        await adminClient.auth.admin.deleteUser(userA.id);
        await adminClient.auth.admin.deleteUser(userB.id);
      }
    } catch {
      // Melhor esforço na limpeza pós-teste
    }
  });

  // -------------------------------------------------------------------------
  // 1. Limites para usuário anônimo (anon) e leitura pública do catálogo
  // -------------------------------------------------------------------------
  await t.test('1. Fronteira anônima (anon): tabelas privadas bloqueadas, store_items acessível', async () => {
    const anon = makeAnonClient();

    const { data: items, error: itemsErr } = await anon
      .from('store_items')
      .select('id, kind, category, price_coins')
      .eq('is_active', true);
    assert.ifError(itemsErr);
    assert.ok((items?.length ?? 0) >= 19, 'Catálogo deve expor os 19 itens ativos');

    const { error: profErr } = await anon.from('profiles').select('id').limit(1);
    assert.ok(profErr, 'anon não pode consultar profiles');

    const { error: actErr } = await anon.from('activities').select('id').limit(1);
    assert.ok(actErr, 'anon não pode consultar activities');

    const { error: rpcErr } = await anon.rpc('search_users', { p_query: 'desbrava' });
    assert.ok(rpcErr, 'anon não pode chamar search_users');

    const fnRes = await invokeVerifyActivity(null, {});
    assert.equal(fnRes.status, 401, 'verify-activity deve rejeitar chamada sem JWT com 401');
  });

  // -------------------------------------------------------------------------
  // 2. Proteção de colunas gerenciadas pelo servidor e tabelas server-owned
  // -------------------------------------------------------------------------
  await t.test('2. RLS e proteção em nível de coluna bloqueiam adulteração direta pelo cliente', async () => {
    const serverCols: Array<Record<string, unknown>> = [
      { xp: 9999 },
      { level: 99 },
      { wallet: 99999 },
      { total_distance_m: 999999 },
      { total_cells: 50000 },
      { achievements_count: 50 },
    ];
    for (const patch of serverCols) {
      const { error } = await userA.client.from('profiles').update(patch).eq('id', userA.id);
      assert.ok(error, `Atualização direta de ${Object.keys(patch)[0]} deve falhar`);
    }

    // Colunas permitidas devem atualizar normalmente
    const nextModality = 'bike';
    const { error: okErr } = await userA.client
      .from('profiles')
      .update({ modality: nextModality, is_public: true })
      .eq('id', userA.id);
    assert.ifError(okErr);

    // Escrita direta em tabelas server-owned deve falhar
    const nowIso = new Date().toISOString();
    const { error: actInsErr } = await userA.client.from('activities').insert({
      id: `forged_${RUN_ID}`,
      user_id: userA.id,
      modality: 'bike',
      started_at: nowIso,
      ended_at: nowIso,
      distance_m: 10000,
      xp: 5000,
    });
    assert.ok(actInsErr, 'INSERT direto em activities deve ser bloqueado');

    const { error: ledgerErr } = await userA.client.from('wallet_ledger').insert({
      user_id: userA.id,
      delta: 1000,
      reason: 'adjustment',
      ref_id: `forged_${RUN_ID}`,
    });
    assert.ok(ledgerErr, 'INSERT direto em wallet_ledger deve ser bloqueado');

    const { error: invErr } = await userA.client.from('user_inventory').insert({
      user_id: userA.id,
      item_id: 'char_zeca',
      quantity: 1,
    });
    assert.ok(invErr, 'INSERT direto em user_inventory deve ser bloqueado');

    const { error: achErr } = await userA.client.from('user_achievements').insert({
      user_id: userA.id,
      achievement_key: 'total_distance:6',
      coins_awarded: 500,
    });
    assert.ok(achErr, 'INSERT direto em user_achievements deve ser bloqueado');
  });

  // -------------------------------------------------------------------------
  // 3. Isolamento entre usuários (Postgres e Storage)
  // -------------------------------------------------------------------------
  await t.test('3. Isolamento entre usuários: B não lê dados privados de A nem acessa pasta Storage de A', async () => {
    const { data: bReadsAProf } = await userB.client
      .from('profiles')
      .select('id, wallet, settings')
      .eq('id', userA.id);
    assert.equal(bReadsAProf?.length ?? 0, 0, 'B não pode ler linha de profiles de A diretamente');

    const secretTrack = encodeTrackGz([
      { lng: -46.6559, lat: -23.5614, t: Date.now() - 20_000 },
      { lng: -46.6549, lat: -23.5614, t: Date.now() - 10_000 },
    ]);
    const pathA = `${userA.id}/isolation_${RUN_ID}.bin.gz`;
    const upA = await userA.client.storage.from('activity-tracks').upload(pathA, secretTrack, {
      contentType: 'application/octet-stream',
      upsert: true,
    });
    assert.ifError(upA.error);
    uploadedPathsA.push(pathA);

    const dlByB = await userB.client.storage.from('activity-tracks').download(pathA);
    assert.ok(dlByB.error, 'B não pode baixar trilha privada de A');

    const upIntoAByB = await userB.client.storage
      .from('activity-tracks')
      .upload(`${userA.id}/spoof_${RUN_ID}.bin.gz`, secretTrack, {
        contentType: 'application/octet-stream',
      });
    assert.ok(upIntoAByB.error, 'B não pode escrever na pasta Storage de A');

    const spoofCall = await invokeVerifyActivity(userB.accessToken, {
      activityId: `spoof_${RUN_ID}`,
      source: 'live',
      modality: 'bike',
      startedAt: Date.now() - 20_000,
      endedAt: Date.now() - 10_000,
      trackPath: pathA,
      clientSummary: {
        distanceM: 100,
        movingS: 10,
        maxSpeed: 10,
        newCells: 5,
        coinsCount: 0,
        coinsValue: 0,
        captures: [],
        cityIds: [],
      },
    });
    assert.equal(spoofCall.status, 403, 'verify-activity deve retornar 403 para trackPath de outro usuário');
  });

  // -------------------------------------------------------------------------
  // 4. Paridade do verify-activity, idempotência, GPX e flags anti-cheat
  // -------------------------------------------------------------------------
  await t.test('4. verify-activity: paridade cliente/servidor, idempotência, GPX e flags anti-cheat', async () => {
    const { data: beforeProf, error: bpErr } = await userA.client
      .from('profiles')
      .select('*')
      .eq('id', userA.id)
      .single();
    assert.ifError(bpErr);

    const { data: fogRow } = await userA.client
      .from('user_fog_state')
      .select('updated_at')
      .eq('user_id', userA.id)
      .maybeSingle();
    const fogUpdatedMs = fogRow?.updated_at ? Date.parse(fogRow.updated_at as string) : null;

    // Trilha válida ~400m em bike (~8 m/s em 50s)
    const t0 = Date.now() - 90_000;
    const pts = [
      { lng: -46.6559, lat: -23.5614, t: t0 },
      { lng: -46.6540, lat: -23.5614, t: t0 + 25_000 },
      { lng: -46.6520, lat: -23.5614, t: t0 + 50_000 },
    ];
    const expectedDist = haversine(pts[0], pts[1]) + haversine(pts[1], pts[2]);
    const expectedCells = countTrackCells(pts);
    const poiId = `poi_parque_${RUN_ID}`;

    // Cálculo espelhado do cliente (tracker.ts + store.ts)
    let distXpAcc = 0;
    let distXp = 0;
    for (let i = 1; i < pts.length; i++) {
      distXpAcc += (haversine(pts[i - 1], pts[i]) / 1000) * XP.perKm.bike;
      const step = Math.floor(distXpAcc);
      distXpAcc -= step;
      distXp += step;
    }
    const cellXp = Math.floor(expectedCells * XP.perCell.bike);
    const coinXp =
      1 * Math.max(1, Math.ceil(COIN_VALUE.gem * XP.perCoinValue)) +
      1 * Math.max(1, Math.ceil(COIN_VALUE.bronze * XP.perCoinValue));
    const expectedXp = distXp + cellXp + coinXp + RARITY_INFO.comum.xp;
    const expectedCoins = COIN_VALUE.gem + COIN_VALUE.bronze; // 101

    const actId = `live_ok_${RUN_ID}`;
    const trackPath = `${userA.id}/${actId}.bin.gz`;
    const up = await userA.client.storage
      .from('activity-tracks')
      .upload(trackPath, encodeTrackGz(pts), { contentType: 'application/octet-stream', upsert: true });
    assert.ifError(up.error);
    uploadedPathsA.push(trackPath);

    const payload = {
      activityId: actId,
      source: 'live',
      modality: 'bike',
      startedAt: t0,
      endedAt: t0 + 50_000,
      trackPath,
      clientSummary: {
        distanceM: expectedDist,
        movingS: 50,
        maxSpeed: expectedDist / 50,
        newCells: expectedCells,
        coinsCount: 2,
        coinsValue: expectedCoins,
        coinsByKind: { bronze: 1, silver: 0, gold: 0, gem: 1 },
        captures: [
          {
            poiId,
            name: 'Parque Verificação',
            category: 'parque',
            rarity: 'comum',
            lng: pts[1].lng,
            lat: pts[1].lat,
          },
        ],
        cityIds: ['br/sp/sao-paulo'],
      },
    };

    const res1 = await invokeVerifyActivity(userA.accessToken, payload);
    assert.equal(res1.status, 200);
    assert.equal(res1.json.status, 'verified');

    const act1 = res1.json.activity as Record<string, unknown>;
    const auth1 = res1.json.authoritative as Record<string, unknown>;
    assert.equal(act1.xpEarned, expectedXp, 'XP verificado deve bater 1:1 com cliente');
    assert.equal(act1.coinsEarned, expectedCoins, 'Moedas verificadas devem bater 1:1');
    assert.equal(act1.newCells, expectedCells);

    const expectedTotalXp = (beforeProf.xp as number) + expectedXp;
    assert.equal(auth1.xp, expectedTotalXp);
    assert.equal(auth1.level, levelFromXp(expectedTotalXp).level);
    assert.equal(auth1.wallet, (beforeProf.wallet as number) + expectedCoins);
    assert.equal(auth1.totalCaptures, (beforeProf.total_captures as number) + 1);
    const expectedCellsDelta = fogUpdatedMs === null || fogUpdatedMs < t0 ? expectedCells : 0;
    assert.equal(auth1.totalCells, (beforeProf.total_cells as number) + expectedCellsDelta);

    // Replay idempotente: mesma activityId não credita duas vezes
    const resReplay = await invokeVerifyActivity(userA.accessToken, payload);
    assert.equal(resReplay.status, 200);
    const authReplay = resReplay.json.authoritative as Record<string, unknown>;
    assert.equal(authReplay.wallet, auth1.wallet, 'Replay não pode duplicar moedas');
    assert.equal(authReplay.xp, auth1.xp, 'Replay não pode duplicar XP');

    // Verificar lançamento no wallet_ledger
    const { data: ledgerRows, error: lErr } = await userA.client
      .from('wallet_ledger')
      .select('delta, reason, ref_id')
      .eq('user_id', userA.id)
      .eq('reason', 'activity_coins')
      .eq('ref_id', actId);
    assert.ifError(lErr);
    assert.equal(ledgerRows?.length, 1);
    assert.equal(ledgerRows?.[0].delta, expectedCoins);

    // GPX import: ignora salto > 500m, zera XP/moedas, retorna verified
    const gpxId = `gpx_ok_${RUN_ID}`;
    const gpxPts = [
      { lng: -46.6559, lat: -23.5614, t: t0 },
      { lng: -46.6549, lat: -23.5614, t: t0 + 15_000 }, // ~102m
      { lng: -46.6400, lat: -23.5614, t: t0 + 30_000 }, // salto > 1500m (ignorado)
    ];
    const gpxPath = `${userA.id}/${gpxId}.bin.gz`;
    await userA.client.storage
      .from('activity-tracks')
      .upload(gpxPath, encodeTrackGz(gpxPts), { contentType: 'application/octet-stream', upsert: true });
    uploadedPathsA.push(gpxPath);

    const gpxValidDist = haversine(gpxPts[0], gpxPts[1]);
    const gpxRes = await invokeVerifyActivity(userA.accessToken, {
      activityId: gpxId,
      source: 'gpx_import',
      modality: 'bike',
      startedAt: t0,
      endedAt: t0 + 30_000,
      trackPath: gpxPath,
      clientSummary: {
        distanceM: gpxValidDist,
        movingS: 15,
        maxSpeed: gpxValidDist / 15,
        newCells: 10,
        coinsCount: 99,
        coinsValue: 999,
        captures: [],
        cityIds: [],
      },
    });
    assert.equal(gpxRes.status, 200);
    assert.equal(gpxRes.json.status, 'verified');
    const gpxAct = gpxRes.json.activity as Record<string, unknown>;
    assert.equal(gpxAct.xpEarned, 0, 'GPX importado não gera XP');
    assert.equal(gpxAct.coinsEarned, 0, 'GPX importado não gera moedas');
    assert.ok(Math.abs((gpxAct.distanceM as number) - gpxValidDist) < 1, 'Salto > 500m deve ser ignorado no GPX');

    // Teleporte em modo live -> flagged, 0 créditos
    const flagId = `flag_tp_${RUN_ID}`;
    const tpPts = [
      { lng: -46.6559, lat: -23.5614, t: t0 },
      { lng: -46.6059, lat: -23.5614, t: t0 + 5_000 }, // ~5 km em 5s
    ];
    const flagPath = `${userA.id}/${flagId}.bin.gz`;
    await userA.client.storage
      .from('activity-tracks')
      .upload(flagPath, encodeTrackGz(tpPts), { contentType: 'application/octet-stream', upsert: true });
    uploadedPathsA.push(flagPath);

    const flagRes = await invokeVerifyActivity(userA.accessToken, {
      activityId: flagId,
      source: 'live',
      modality: 'run',
      startedAt: t0,
      endedAt: t0 + 5_000,
      trackPath: flagPath,
      clientSummary: {
        distanceM: haversine(tpPts[0], tpPts[1]),
        movingS: 5,
        maxSpeed: MAX_SPEED.run * 50,
        newCells: 5,
        coinsCount: 5,
        coinsValue: 500,
        captures: [],
        cityIds: [],
      },
    });
    assert.equal(flagRes.status, 200);
    assert.equal(flagRes.json.status, 'flagged');
    assert.equal(flagRes.json.reason, 'teleport_jump');
    const flagAuth = flagRes.json.authoritative as Record<string, unknown>;
    assert.equal(flagAuth.wallet, auth1.wallet, 'Atividade flagged não credita moedas');
    assert.equal(flagAuth.xp, auth1.xp, 'Atividade flagged não credita XP');
  });

  // -------------------------------------------------------------------------
  // 5. Loja atômica (purchase_store_item) e reconciliação offline de boosters
  // -------------------------------------------------------------------------
  await t.test('5. Loja atômica e reconciliação de booster offline via verify-activity', async () => {
    // Saldo insuficiente em B (tenta comprar char_zeca = 900 se wallet < 900)
    const { data: profB } = await userB.client
      .from('profiles')
      .select('wallet')
      .eq('id', userB.id)
      .single();
    if ((profB?.wallet as number) < 900) {
      const { error: poorErr } = await userB.client.rpc('purchase_store_item', {
        p_item_id: 'char_zeca',
        p_quantity: 1,
      });
      assert.ok(poorErr, 'Compra com saldo insuficiente deve ser rejeitada');
    }

    // Usuário A compra boost_xp_2x (60 moedas) se ainda abaixo do max_stack=10
    const { data: invBeforeRow } = await userA.client
      .from('user_inventory')
      .select('quantity')
      .eq('user_id', userA.id)
      .eq('item_id', 'boost_xp_2x')
      .maybeSingle();
    const qtyBefore = (invBeforeRow?.quantity as number) ?? 0;

    const { data: profABefore } = await userA.client
      .from('profiles')
      .select('wallet, xp')
      .eq('id', userA.id)
      .single();
    assert.ok(profABefore);

    if (qtyBefore < 10) {
      const { data: buyRes, error: buyErr } = await userA.client.rpc('purchase_store_item', {
        p_item_id: 'boost_xp_2x',
        p_quantity: 1,
      });
      assert.ifError(buyErr);
      const buyObj = buyRes as { wallet: number; quantity: number; total_paid: number };
      assert.equal(buyObj.total_paid, 60);
      assert.equal(buyObj.wallet, (profABefore.wallet as number) - 60);
      assert.equal(buyObj.quantity, qtyBefore + 1);
    }

    // Ativa booster offline em user_boost_usages
    const { data: invMid } = await userA.client
      .from('user_inventory')
      .select('quantity')
      .eq('user_id', userA.id)
      .eq('item_id', 'boost_xp_2x')
      .single();
    assert.ok(invMid, 'Inventário de boost_xp_2x deve existir');
    const qtyMid = invMid.quantity as number;
    assert.ok(qtyMid >= 1);

    const tStart = Date.now() - 40_000;
    const tEnd = tStart + 20_000;
    const boostId = `boost_${RUN_ID}`;
    const { error: boostInsErr } = await userA.client.from('user_boost_usages').insert({
      id: boostId,
      user_id: userA.id,
      item_id: 'boost_xp_2x',
      activated_at: new Date(tStart - 5_000).toISOString(),
      expires_at: new Date(tStart + 1_800_000).toISOString(),
    });
    assert.ifError(boostInsErr);

    const pts = [
      { lng: -46.6559, lat: -23.5614, t: tStart },
      { lng: -46.6549, lat: -23.5614, t: tEnd },
    ];
    const dist = haversine(pts[0], pts[1]);
    const cells = countTrackCells(pts);
    const baseXp = Math.floor((dist / 1000) * XP.perKm.run) + Math.floor(cells * XP.perCell.run);

    const boostActId = `boost_act_${RUN_ID}`;
    const boostTrackPath = `${userA.id}/${boostActId}.bin.gz`;
    await userA.client.storage
      .from('activity-tracks')
      .upload(boostTrackPath, encodeTrackGz(pts), { contentType: 'application/octet-stream', upsert: true });
    uploadedPathsA.push(boostTrackPath);

    const boostRes = await invokeVerifyActivity(userA.accessToken, {
      activityId: boostActId,
      source: 'live',
      modality: 'run',
      startedAt: tStart,
      endedAt: tEnd,
      trackPath: boostTrackPath,
      clientSummary: {
        distanceM: dist,
        movingS: 20,
        maxSpeed: dist / 20,
        newCells: cells,
        coinsCount: 0,
        coinsValue: 0,
        captures: [],
        cityIds: [],
      },
      boostUsageIds: [boostId],
    });
    assert.equal(boostRes.status, 200);
    assert.equal(boostRes.json.status, 'verified');
    const boostAct = boostRes.json.activity as Record<string, unknown>;
    assert.equal(boostAct.xpEarned, baseXp * 2, 'Booster 2x XP deve dobrar o XP');

    // Inventário deve ter sido decrementado e consumed_at preenchido
    const { data: invAfter } = await userA.client
      .from('user_inventory')
      .select('quantity')
      .eq('user_id', userA.id)
      .eq('item_id', 'boost_xp_2x')
      .single();
    assert.ok(invAfter, 'Inventário pós-consumo deve existir');
    assert.equal(invAfter.quantity, qtyMid - 1, 'Inventário deve decrementar após consumo');

    const { data: usageAfter } = await userA.client
      .from('user_boost_usages')
      .select('consumed_at, activity_id')
      .eq('id', boostId)
      .single();
    assert.ok(usageAfter, 'Registro de uso do booster deve existir');
    assert.ok(usageAfter.consumed_at, 'consumed_at deve estar preenchido');
    assert.equal(usageAfter.activity_id, boostActId);

    // Reutilizar o mesmo boostUsageId em outra atividade NÃO aplica 2x novamente
    const reuseActId = `boost_reuse_${RUN_ID}`;
    const reusePath = `${userA.id}/${reuseActId}.bin.gz`;
    await userA.client.storage
      .from('activity-tracks')
      .upload(reusePath, encodeTrackGz(pts), { contentType: 'application/octet-stream', upsert: true });
    uploadedPathsA.push(reusePath);

    const reuseRes = await invokeVerifyActivity(userA.accessToken, {
      activityId: reuseActId,
      source: 'live',
      modality: 'run',
      startedAt: tStart,
      endedAt: tEnd,
      trackPath: reusePath,
      clientSummary: {
        distanceM: dist,
        movingS: 20,
        maxSpeed: dist / 20,
        newCells: cells,
        coinsCount: 0,
        coinsValue: 0,
        captures: [],
        cityIds: [],
      },
      boostUsageIds: [boostId],
    });
    assert.equal(reuseRes.status, 200);
    const reuseAct = reuseRes.json.activity as Record<string, unknown>;
    assert.equal(reuseAct.xpEarned, baseXp, 'Booster já consumido não pode ser reaplicado');
  });

  // -------------------------------------------------------------------------
  // 6. Social, rankings (amigos e global), névoa (revision) e conquistas
  // -------------------------------------------------------------------------
  await t.test('6. Social, rankings (excluindo flagged e GPX no mensal), névoa e conquistas', async () => {
    // Busca por usuários públicos
    const { data: found, error: searchErr } = await userA.client.rpc('search_users', {
      p_query: userB.username,
      p_limit: 10,
    });
    assert.ifError(searchErr);
    assert.ok(
      (found as Array<{ id: string }>).some((u) => u.id === userB.id),
      'search_users deve localizar B quando is_public = true',
    );

    // Solicitação de amizade A -> B
    const { error: reqErr } = await userA.client.from('friendships').insert({
      requester_id: userA.id,
      addressee_id: userB.id,
      status: 'pending',
    });
    assert.ifError(reqErr);

    // Duplicata invertida B -> A deve falhar pelo índice único
    const { error: dupErr } = await userB.client.from('friendships').insert({
      requester_id: userB.id,
      addressee_id: userA.id,
      status: 'pending',
    });
    assert.ok(dupErr, 'Convite duplicado invertido deve ser bloqueado');

    // Remetente A não pode aceitar o próprio convite
    const { error: selfAcceptErr } = await userA.client
      .from('friendships')
      .update({ status: 'accepted' })
      .eq('requester_id', userA.id)
      .eq('addressee_id', userB.id);
    assert.ok(selfAcceptErr, 'Somente o destinatário pode aceitar amizade');

    // Destinatário B aceita
    const { error: acceptErr } = await userB.client
      .from('friendships')
      .update({ status: 'accepted' })
      .eq('requester_id', userA.id)
      .eq('addressee_id', userB.id);
    assert.ifError(acceptErr);

    // Perfil público não expõe wallet nem settings
    const { data: pubProfRows, error: pubErr } = await userB.client.rpc('get_public_profile', {
      p_user_id: userA.id,
    });
    assert.ifError(pubErr);
    const pubProf = (pubProfRows as Array<Record<string, unknown>>)[0];
    assert.ok(pubProf);
    assert.equal('wallet' in pubProf, false, 'get_public_profile nunca deve expor wallet');
    assert.equal('settings' in pubProf, false, 'get_public_profile nunca deve expor settings');

    // Rankings de amigos e global
    const { data: fBoard, error: fErr } = await userA.client.rpc('get_friends_leaderboard', {
      p_metric: 'xp',
      p_period: 'all_time',
    });
    assert.ifError(fErr);
    const fIds = new Set((fBoard as Array<{ user_id: string }>).map((r) => r.user_id));
    assert.ok(fIds.has(userA.id) && fIds.has(userB.id));

    const { data: gBoard, error: gErr } = await userA.client.rpc('get_global_leaderboard', {
      p_metric: 'distance',
      p_period: 'monthly',
      p_limit: 50,
      p_offset: 0,
    });
    assert.ifError(gErr);
    const gObj = gBoard as { entries: Array<{ user_id: string; score: number }>; my_rank: unknown };
    assert.ok(Array.isArray(gObj.entries));
    assert.ok(gObj.entries.some((e) => e.user_id === userA.id && e.score > 0));

    // Anti-bypass de bloqueio: A bloqueia B; B não pode deletar ou alterar
    const { error: blkErr } = await userA.client
      .from('friendships')
      .update({ status: 'blocked' })
      .eq('requester_id', userA.id)
      .eq('addressee_id', userB.id);
    assert.ifError(blkErr);

    const { data: unblkData, error: unblkByB } = await userB.client
      .from('friendships')
      .update({ status: 'accepted' })
      .eq('requester_id', userA.id)
      .eq('addressee_id', userB.id)
      .select('id');
    assert.ok(
      unblkByB || (unblkData?.length ?? 0) === 0,
      'Usuário bloqueado não pode desfazer bloqueio via UPDATE',
    );

    const { data: stillBlocked } = await userA.client
      .from('friendships')
      .select('status')
      .eq('requester_id', userA.id)
      .eq('addressee_id', userB.id)
      .single();
    assert.equal(stillBlocked?.status, 'blocked', 'Status deve permanecer blocked');

    const { data: delByB } = await userB.client
      .from('friendships')
      .delete()
      .eq('requester_id', userA.id)
      .eq('addressee_id', userB.id)
      .select('id');
    assert.equal(delByB?.length ?? 0, 0, 'Usuário bloqueado não pode remover linha bloqueada via DELETE');

    // Limpa amizade (como A, que bloqueou)
    const { error: cleanFriendErr } = await userA.client
      .from('friendships')
      .delete()
      .eq('requester_id', userA.id)
      .eq('addressee_id', userB.id);
    assert.ifError(cleanFriendErr);

    // Fog state: controle otimista por revision + teto por células verificadas
    const { data: verifiedActs } = await userA.client
      .from('activities')
      .select('new_cells')
      .eq('user_id', userA.id)
      .eq('verification_status', 'verified');
    const verifiedCellsSum = (verifiedActs ?? []).reduce(
      (acc, r) => acc + ((r.new_cells as number) ?? 0),
      0,
    );

    const { data: fogCur } = await userA.client
      .from('user_fog_state')
      .select('revision, cell_count')
      .eq('user_id', userA.id)
      .maybeSingle();
    const curRev = (fogCur?.revision as number) ?? 0;

    const { data: staleFog, error: staleErr } = await userA.client.rpc('upsert_fog_state', {
      p_storage_path: `${userA.id}/fog.bin.gz`,
      p_cell_count: Math.max(1, verifiedCellsSum),
      p_expected_revision: curRev + 77,
    });
    assert.ifError(staleErr);
    assert.equal((staleFog as { conflict: boolean }).conflict, true);

    // Tentativa de inflar para 300.000 células deve ser limitada a verifiedCellsSum
    const { data: cappedFog, error: cappedErr } = await userA.client.rpc('upsert_fog_state', {
      p_storage_path: `${userA.id}/fog.bin.gz`,
      p_cell_count: 300000,
      p_expected_revision: curRev,
    });
    assert.ifError(cappedErr);
    assert.equal((cappedFog as { conflict: boolean; revision: number }).conflict, false);
    assert.equal((cappedFog as { revision: number }).revision, curRev + 1);
    assert.equal(
      (cappedFog as { total_cells: number }).total_cells,
      verifiedCellsSum,
      'upsert_fog_state deve limitar total_cells à soma de células verificadas',
    );

    const { data: profAfterFog } = await userA.client
      .from('profiles')
      .select('total_cells')
      .eq('id', userA.id)
      .single();
    assert.equal(
      profAfterFog?.total_cells,
      verifiedCellsSum,
      'profiles.total_cells não pode exceder células de atividades verificadas',
    );

    // Conquista idempotente: total_activities:0 (meta 1 atividade, 15 moedas)
    const { data: claim1, error: claimErr1 } = await userA.client.rpc('claim_achievement', {
      p_achievement_key: 'total_activities:0',
    });
    assert.ifError(claimErr1);
    const c1 = claim1 as { already_claimed: boolean; coins_awarded: number; wallet: number };
    assert.equal(c1.coins_awarded, 15);

    const { data: claim2, error: claimErr2 } = await userA.client.rpc('claim_achievement', {
      p_achievement_key: 'total_activities:0',
    });
    assert.ifError(claimErr2);
    const c2 = claim2 as { already_claimed: boolean; wallet: number };
    assert.equal(c2.already_claimed, true);
    assert.equal(c2.wallet, c1.wallet, 'Reclamar conquista repetida não pode creditar duas vezes');

    // Chaves não-canônicas devem ser rejeitadas
    for (const badKey of [
      'total_activities:00',
      'total_activities:+0',
      'total_activities: 0',
      'monthly_dist:2026-13:0',
    ]) {
      const { error: badKeyErr } = await userA.client.rpc('claim_achievement', {
        p_achievement_key: badKey,
      });
      assert.ok(badKeyErr, `Chave não-canônica/inválida "${badKey}" deve ser rejeitada`);
    }

    // Conquista não atingida (2.500 km) e total_cells:5 (300k) devem ser recusadas
    const { error: unearnedErr } = await userA.client.rpc('claim_achievement', {
      p_achievement_key: 'total_distance:6',
    });
    assert.ok(unearnedErr, 'Conquista não atingida deve ser rejeitada pelo servidor');

    const { error: unearnedCellsErr } = await userA.client.rpc('claim_achievement', {
      p_achievement_key: 'total_cells:5',
    });
    assert.ok(unearnedCellsErr, 'total_cells:5 não pode ser resgatada após teto de upsert_fog_state');
  });

  // -------------------------------------------------------------------------
  // 7. Regressões de segurança e anti-cheat (Iteração 2)
  // -------------------------------------------------------------------------
  await t.test('7. Hardening anti-cheat: cidades/capturas falsas, booster sem estoque, poiId com espaços, polar/gap/0m-gemas', async () => {
    // 7a. user_cities falsa e user_captures não-verificada não liberam moedas em claim_achievement
    const fakeCityId = `fake/exploit/${RUN_ID}`;
    const { error: cityInsErr } = await userB.client.from('user_cities').insert({
      user_id: userB.id,
      city_id: fakeCityId,
      name: 'Cidade Falsa',
      area_m2: 10000,
      bbox: [0, 0, 1, 1],
      cells: 1000,
      cell_area_m2: 100,
    });
    assert.ifError(cityInsErr);

    const { error: fakeCityClaimErr } = await userB.client.rpc('claim_achievement', {
      p_achievement_key: `city_pct:${fakeCityId}:0`,
    });
    assert.ok(fakeCityClaimErr, 'Cidade sem atividade verificada não pode liberar city_pct');

    // Inserção direta em user_captures tentando forçar is_verified=true é bloqueada
    const { error: forgedVerifiedCapErr } = await userB.client.from('user_captures').insert({
      user_id: userB.id,
      poi_id: `forged_cap_v_${RUN_ID}`,
      name: 'Museu Forjado',
      category: 'museu',
      rarity: 'raro',
      lng: -46.6559,
      lat: -23.5614,
      is_verified: true,
    });
    assert.ok(forgedVerifiedCapErr, 'Cliente não pode inserir user_captures com is_verified = true');

    // Inserções sem is_verified recebem is_verified = false pelo trigger e não liberam rare_captures
    const { data: insertedCap, error: capInsOkErr } = await userB.client
      .from('user_captures')
      .insert({
        user_id: userB.id,
        poi_id: `unverified_cap_${RUN_ID}`,
        name: 'Monumento Local',
        category: 'monumento',
        rarity: 'lendario',
        lng: -46.6559,
        lat: -23.5614,
      })
      .select('is_verified')
      .single();
    assert.ifError(capInsOkErr);
    assert.equal(insertedCap?.is_verified, false, 'Trigger deve forçar is_verified = false para cliente');

    const { data: verifiedCapsB } = await userB.client
      .from('user_captures')
      .select('poi_id')
      .eq('user_id', userB.id)
      .eq('is_verified', true);
    if ((verifiedCapsB?.length ?? 0) === 0) {
      const { error: rareClaimErr } = await userB.client.rpc('claim_achievement', {
        p_achievement_key: 'rare_captures:0',
      });
      assert.ok(rareClaimErr, 'Captura não-verificada não pode liberar rare_captures');
    }

    // 7b. upsert_fog_state em userB sem atividades verificadas mantém total_cells = 0
    const { data: verifiedActsB } = await userB.client
      .from('activities')
      .select('new_cells')
      .eq('user_id', userB.id)
      .eq('verification_status', 'verified');
    const verifiedCellsB = (verifiedActsB ?? []).reduce(
      (acc, r) => acc + ((r.new_cells as number) ?? 0),
      0,
    );
    const { data: fogB } = await userB.client
      .from('user_fog_state')
      .select('revision')
      .eq('user_id', userB.id)
      .maybeSingle();
    const { data: upFogB, error: upFogBErr } = await userB.client.rpc('upsert_fog_state', {
      p_storage_path: `${userB.id}/fog.bin.gz`,
      p_cell_count: 300000,
      p_expected_revision: (fogB?.revision as number) ?? 0,
    });
    assert.ifError(upFogBErr);
    assert.equal((upFogB as { total_cells: number }).total_cells, verifiedCellsB);

    // 7c. poiId duplicado com espaços ("poi_ws" e " poi_ws ") não dobra XP de captura
    const tWs = Date.now() - 120_000;
    const wsPts = [
      { lng: -46.6559, lat: -23.5614, t: tWs },
      { lng: -46.6549, lat: -23.5614, t: tWs + 20_000 },
    ];
    const wsDist = haversine(wsPts[0], wsPts[1]);
    const wsCells = countTrackCells(wsPts);
    const wsBaseXp = Math.floor((wsDist / 1000) * XP.perKm.run) + Math.floor(wsCells * XP.perCell.run);
    const wsActId = `ws_poi_${RUN_ID}`;
    const wsPath = `${userA.id}/${wsActId}.bin.gz`;
    await userA.client.storage
      .from('activity-tracks')
      .upload(wsPath, encodeTrackGz(wsPts), { contentType: 'application/octet-stream', upsert: true });
    uploadedPathsA.push(wsPath);

    const wsPoi = `poi_ws_${RUN_ID}`;
    const wsRes = await invokeVerifyActivity(userA.accessToken, {
      activityId: wsActId,
      source: 'live',
      modality: 'run',
      startedAt: tWs,
      endedAt: tWs + 20_000,
      trackPath: wsPath,
      clientSummary: {
        distanceM: wsDist,
        movingS: 20,
        maxSpeed: wsDist / 20,
        newCells: wsCells,
        coinsCount: 0,
        coinsValue: 0,
        captures: [
          {
            poiId: wsPoi,
            name: 'Parque Espaço',
            category: 'parque',
            rarity: 'comum',
            lng: wsPts[0].lng,
            lat: wsPts[0].lat,
          },
          {
            poiId: ` ${wsPoi} `,
            name: 'Parque Espaço',
            category: 'parque',
            rarity: 'comum',
            lng: wsPts[0].lng,
            lat: wsPts[0].lat,
          },
        ],
        cityIds: [],
      },
    });
    assert.equal(wsRes.status, 200);
    assert.equal(wsRes.json.status, 'verified');
    assert.equal(
      (wsRes.json.activity as { xpEarned: number }).xpEarned,
      wsBaseXp + RARITY_INFO.comum.xp,
      'poiId duplicado com espaços não pode conceder XP de captura duas vezes',
    );

    // 7d. Booster sem estoque no inventário (userB tem 0 de boost_xp_2x) não concede 2x XP
    const unbackedBoostId = `boost_unbacked_${RUN_ID}`;
    const { error: ubInsErr } = await userB.client.from('user_boost_usages').insert({
      id: unbackedBoostId,
      user_id: userB.id,
      item_id: 'boost_xp_2x',
      activated_at: new Date(tWs - 5_000).toISOString(),
      expires_at: new Date(tWs + 1_800_000).toISOString(),
    });
    assert.ifError(ubInsErr);

    const ubActId = `unbacked_boost_${RUN_ID}`;
    const ubPath = `${userB.id}/${ubActId}.bin.gz`;
    await userB.client.storage
      .from('activity-tracks')
      .upload(ubPath, encodeTrackGz(wsPts), { contentType: 'application/octet-stream', upsert: true });
    uploadedPathsB.push(ubPath);

    const ubRes = await invokeVerifyActivity(userB.accessToken, {
      activityId: ubActId,
      source: 'live',
      modality: 'run',
      startedAt: tWs,
      endedAt: tWs + 20_000,
      trackPath: ubPath,
      clientSummary: {
        distanceM: wsDist,
        movingS: 20,
        maxSpeed: wsDist / 20,
        newCells: wsCells,
        coinsCount: 0,
        coinsValue: 0,
        captures: [],
        cityIds: [],
      },
      boostUsageIds: [unbackedBoostId],
    });
    assert.equal(ubRes.status, 200);
    assert.equal(ubRes.json.status, 'verified');
    assert.equal(
      (ubRes.json.activity as { xpEarned: number }).xpEarned,
      wsBaseXp,
      'Booster sem quantidade em user_inventory não pode multiplicar XP',
    );

    // 7e. Latitude polar (lat = 90) deve ser sinalizada imediatamente sem travar CPU
    const polarActId = `polar_${RUN_ID}`;
    const polarPath = `${userA.id}/${polarActId}.bin.gz`;
    await userA.client.storage
      .from('activity-tracks')
      .upload(
        polarPath,
        encodeTrackGz([
          { lng: 0, lat: 90, t: tWs },
          { lng: 0.001, lat: 90, t: tWs + 10_000 },
        ]),
        { contentType: 'application/octet-stream', upsert: true },
      );
    uploadedPathsA.push(polarPath);

    const polarRes = await invokeVerifyActivity(userA.accessToken, {
      activityId: polarActId,
      source: 'live',
      modality: 'run',
      startedAt: tWs,
      endedAt: tWs + 10_000,
      trackPath: polarPath,
      clientSummary: {
        distanceM: 0,
        movingS: 10,
        maxSpeed: 0,
        newCells: 0,
        coinsCount: 0,
        coinsValue: 0,
        captures: [],
        cityIds: [],
      },
    });
    assert.equal(polarRes.status, 200);
    assert.equal(polarRes.json.status, 'flagged');
    assert.equal(polarRes.json.reason, 'invalid_coordinates_or_timestamp');

    // 7f. Lacuna legítima de GPS (dt = 80s a ~3 m/s = 240m) deve passar como verified
    const gapPts = [
      { lng: -46.6559, lat: -23.5614, t: tWs },
      { lng: -46.65355, lat: -23.5614, t: tWs + 80_000 },
    ];
    const gapDist = haversine(gapPts[0], gapPts[1]);
    const gapCells = countTrackCells(gapPts);
    const gapActId = `gps_gap_${RUN_ID}`;
    const gapPath = `${userA.id}/${gapActId}.bin.gz`;
    await userA.client.storage
      .from('activity-tracks')
      .upload(gapPath, encodeTrackGz(gapPts), { contentType: 'application/octet-stream', upsert: true });
    uploadedPathsA.push(gapPath);

    const gapRes = await invokeVerifyActivity(userA.accessToken, {
      activityId: gapActId,
      source: 'live',
      modality: 'run',
      startedAt: tWs,
      endedAt: tWs + 80_000,
      trackPath: gapPath,
      clientSummary: {
        distanceM: gapDist,
        movingS: 30,
        maxSpeed: gapDist / 80,
        newCells: gapCells,
        coinsCount: 0,
        coinsValue: 0,
        captures: [],
        cityIds: [],
      },
    });
    assert.equal(gapRes.status, 200);
    assert.equal(gapRes.json.status, 'verified', 'Lacuna legítima de GPS (80s a 3 m/s) não deve ser flagada');

    // 7g. Farm estacionário (0m, 1 ponto, 52 gemas) deve ser sinalizado como implausible_coins
    const gemPts = [{ lng: -46.6559, lat: -23.5614, t: tWs }];
    const gemCells = countTrackCells(gemPts);
    const gemActId = `zero_gem_${RUN_ID}`;
    const gemPath = `${userA.id}/${gemActId}.bin.gz`;
    await userA.client.storage
      .from('activity-tracks')
      .upload(gemPath, encodeTrackGz(gemPts), { contentType: 'application/octet-stream', upsert: true });
    uploadedPathsA.push(gemPath);

    const gemRes = await invokeVerifyActivity(userA.accessToken, {
      activityId: gemActId,
      source: 'live',
      modality: 'run',
      startedAt: tWs,
      endedAt: tWs + 1_000,
      trackPath: gemPath,
      clientSummary: {
        distanceM: 0,
        movingS: 0,
        maxSpeed: 0,
        newCells: gemCells,
        coinsCount: 52,
        coinsValue: 5200,
        coinsByKind: { gem: 52 },
        captures: [],
        cityIds: [],
      },
    });
    assert.equal(gemRes.status, 200);
    assert.equal(gemRes.json.status, 'flagged');
    assert.equal(gemRes.json.reason, 'implausible_coins');

    // 7h. Teleporte curto sub-50m (49m em 1ms) deve ser sinalizado como impossible_speed
    const sub50Pts = [
      { lng: -46.6559, lat: -23.5614, t: tWs },
      { lng: -46.65542, lat: -23.5614, t: tWs + 1 },
      { lng: -46.65494, lat: -23.5614, t: tWs + 2 },
    ];
    const sub50Dist = haversine(sub50Pts[0], sub50Pts[1]) + haversine(sub50Pts[1], sub50Pts[2]);
    const sub50Cells = countTrackCells(sub50Pts);
    const sub50ActId = `sub50_tp_${RUN_ID}`;
    const sub50Path = `${userA.id}/${sub50ActId}.bin.gz`;
    await userA.client.storage
      .from('activity-tracks')
      .upload(sub50Path, encodeTrackGz(sub50Pts), { contentType: 'application/octet-stream', upsert: true });
    uploadedPathsA.push(sub50Path);

    const sub50Res = await invokeVerifyActivity(userA.accessToken, {
      activityId: sub50ActId,
      source: 'live',
      modality: 'run',
      startedAt: tWs,
      endedAt: tWs + 2,
      trackPath: sub50Path,
      clientSummary: {
        distanceM: sub50Dist,
        movingS: 0.002,
        maxSpeed: 49000,
        newCells: sub50Cells,
        coinsCount: 0,
        coinsValue: 0,
        captures: [],
        cityIds: [],
      },
    });
    assert.equal(sub50Res.status, 200);
    assert.equal(sub50Res.json.status, 'flagged');
    assert.equal(sub50Res.json.reason, 'impossible_speed');
  });

  // -------------------------------------------------------------------------
  // 8. Regressões de segurança (Iteração 3 - Migração 0008)
  // -------------------------------------------------------------------------
  await t.test('8. Migração 0008: captura verificada imutável, city_pct anti-forja e upsert_fog_state NULL revision', async () => {
    // 8a. Cliente autenticado NÃO pode atualizar/rebaixar linha verificada em user_captures
    const verifiedPoiId = `poi_parque_${RUN_ID}`;
    const { data: capBefore, error: capBeforeErr } = await userA.client
      .from('user_captures')
      .select('poi_id, name, is_verified')
      .eq('user_id', userA.id)
      .eq('poi_id', verifiedPoiId)
      .single();
    assert.ifError(capBeforeErr);
    assert.equal(capBefore?.is_verified, true, 'Captura do teste 4 deve estar verificada');

    const { data: updRows, error: updErr } = await userA.client
      .from('user_captures')
      .update({ name: 'Tentativa Rebaixamento' })
      .eq('user_id', userA.id)
      .eq('poi_id', verifiedPoiId)
      .select('poi_id, is_verified');
    assert.ok(
      updErr || (updRows?.length ?? 0) === 0,
      'UPDATE em captura verificada deve ser bloqueado (erro ou 0 linhas afetadas)',
    );

    const { data: capAfter, error: capAfterErr } = await userA.client
      .from('user_captures')
      .select('name, is_verified')
      .eq('user_id', userA.id)
      .eq('poi_id', verifiedPoiId)
      .single();
    assert.ifError(capAfterErr);
    assert.equal(capAfter?.is_verified, true, 'is_verified deve permanecer true após tentativa de UPDATE');
    assert.equal(capAfter?.name, 'Parque Verificação', 'Nome da captura verificada não pode ser alterado');

    // 8b. Forjar user_cities com area_m2=10000/cell_area_m2=400/cells=1105 em city_id verificada (São Paulo) rende 0 moedas
    const { data: walletBeforeRow, error: wbErr } = await userA.client
      .from('profiles')
      .select('wallet')
      .eq('id', userA.id)
      .single();
    assert.ifError(wbErr);
    const walletBefore = walletBeforeRow?.wallet as number;

    const { error: upsertCityErr } = await userA.client.from('user_cities').upsert(
      {
        user_id: userA.id,
        city_id: 'br/sp/sao-paulo',
        name: 'São Paulo',
        area_m2: 10000,
        bbox: [-46.8, -24.0, -46.3, -23.3],
        cells: 1105,
        cell_area_m2: 400,
      },
      { onConflict: 'user_id,city_id' },
    );
    assert.ifError(upsertCityErr);

    for (let tier = 0; tier <= 8; tier++) {
      const { error: cityPctErr } = await userA.client.rpc('claim_achievement', {
        p_achievement_key: `city_pct:br/sp/sao-paulo:${tier}`,
      });
      assert.ok(
        cityPctErr,
        `city_pct:br/sp/sao-paulo:${tier} não pode ser resgatada com área forjada`,
      );
    }

    const { data: walletAfterRow, error: waErr } = await userA.client
      .from('profiles')
      .select('wallet')
      .eq('id', userA.id)
      .single();
    assert.ifError(waErr);
    assert.equal(
      walletAfterRow?.wallet,
      walletBefore,
      'Nenhuma moeda pode ser emitida ao forjar area_m2/cell_area_m2 em city_pct',
    );

    // 8c. upsert_fog_state(..., NULL) em linha existente deve retornar conflict: true
    const { data: fogCur, error: fogCurErr } = await userA.client
      .from('user_fog_state')
      .select('revision')
      .eq('user_id', userA.id)
      .single();
    assert.ifError(fogCurErr);
    const revBefore = fogCur?.revision as number;
    assert.ok(revBefore >= 1, 'user_fog_state deve existir antes do teste de NULL revision');

    const { data: nullRevRes, error: nullRevErr } = await userA.client.rpc('upsert_fog_state', {
      p_storage_path: `${userA.id}/fog.bin.gz`,
      p_cell_count: 10,
      p_expected_revision: null,
    });
    assert.ifError(nullRevErr);
    const nullRevObj = nullRevRes as { conflict: boolean; revision: number };
    assert.equal(nullRevObj.conflict, true, 'p_expected_revision NULL em linha existente deve sinalizar conflito');
    assert.equal(nullRevObj.revision, revBefore, 'revision não deve avançar quando p_expected_revision é NULL');
  });
});
