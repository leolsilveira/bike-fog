// Verificação automatizada do M2 (supabase-sync-core): testes unitários + integração ao vivo.
// Rodar com: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test scripts/verify-sync-core.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { gunzipSync, gzipSync } from 'fflate';
import {
  decodeFog,
  encodeFog,
  utf8Decode,
  utf8Encode,
} from '../src/game/binary.ts';
import { REVEAL_RADIUS_M, XP } from '../src/game/config.ts';
import { fog } from '../src/game/fog.ts';
import {
  cellOf,
  cellsInRadius,
  haversine,
  lerpLngLat,
  toMerc,
} from '../src/game/geo.ts';
import { EMPTY_TOTALS, useGame } from '../src/game/store.ts';
import type { ActivitySummary, Capture, City } from '../src/game/types.ts';
import { safeFileName } from '../src/services/fileName.ts';
import { sessionStorage as webSessionStorage } from '../src/services/sessionStorage.web.ts';
import {
  isValidAvatarConfig,
  pullCloudToLocal,
  pushAllLocalToCloud,
  syncAchievements,
  syncActivity,
  syncCitiesAndCaptures,
  syncFog,
  syncProfile,
  type FogSyncState,
  type SyncDeps,
} from '../src/services/syncCore.ts';
import {
  avatarFrame,
  avatarFromCharacter,
  avatarKey,
  resolveAvatar,
} from '../src/sprites/avatar.ts';
import { COIN_VALUE, POI_INFO, RARITY_INFO } from '../src/sprites/items.ts';

try {
  process.loadEnvFile('.env.local');
} catch {
  // Variáveis podem vir diretamente do ambiente
}

const SUPABASE_URL = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? '').trim();
const SUPABASE_KEY = (
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ||
  ''
);
const SERVICE_ROLE_KEY = (
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SECRET_KEY ??
  ''
).trim();

const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

test('1. geo.ts: guarda polar em toMerc e cellsInRadius', () => {
  for (const lat of [90, -90, 85.06, -85.06, 89.9999]) {
    const m = toMerc({ lng: -46.65, lat });
    assert.ok(Number.isFinite(m.x) && Number.isFinite(m.y), `toMerc deve ser finito para lat=${lat}`);
    assert.deepEqual(
      cellsInRadius({ lng: -46.65, lat }, REVEAL_RADIUS_M),
      [],
      `cellsInRadius deve retornar [] para lat polar ${lat}`,
    );
  }

  assert.deepEqual(cellsInRadius({ lng: -46.65, lat: -23.56 }, -5), []);
  assert.deepEqual(cellsInRadius({ lng: -46.65, lat: -23.56 }, Number.NaN), []);

  const paulista = cellsInRadius({ lng: -46.6559, lat: -23.5614 }, REVEAL_RADIUS_M);
  assert.ok(paulista.length > 0 && paulista.length <= 200, 'Coordenada válida deve gerar células');

  // Mesmo com raio enorme em latitude válida, o teto r <= 1024 impede travamento
  const capped = cellsInRadius({ lng: 0, lat: 0 }, 500_000);
  assert.ok(capped.length > 0);
});

test('2. fog.merge: união de conjuntos, remapeamento de cityIds, upgrade 0->city e roundtrip gzip', () => {
  fog.clear();
  const k1 = cellOf({ lng: -46.6559, lat: -23.5614 });
  const k2 = cellOf({ lng: -46.6550, lat: -23.5614 });
  const k3 = cellOf({ lng: -46.6540, lat: -23.5614 });
  const k4 = cellOf({ lng: -46.6530, lat: -23.5614 });

  // Estado local inicial: k1 sem cidade (0), k2 em r/sp (1)
  fog.load({
    keys: new Float64Array([k1, k2]),
    city: new Uint16Array([0, 1]),
    cityIds: ['', 'r/sp'],
  });

  const events: Array<{ added: number[]; reset: boolean }> = [];
  const unsub = fog.subscribe((added, reset) => {
    events.push({ added, reset });
  });

  // Snapshot remoto tem índice 1 = r/campinas, índice 2 = r/sp
  const addedCount = fog.merge({
    keys: new Float64Array([k1, k2, k3, k4]),
    city: new Uint16Array([2, 1, 1, 0]),
    cityIds: ['', 'r/campinas', 'r/sp'],
  });
  unsub();

  assert.equal(addedCount, 2, 'Apenas k3 e k4 são células inéditas');
  assert.equal(fog.size, 4);
  assert.equal(events.length, 1);
  assert.equal(events[0].reset, false);
  assert.deepEqual(events[0].added.sort((a, b) => a - b), [k3, k4].sort((a, b) => a - b));

  // k1 era 0 (pendente) -> deve ter sido promovido para r/sp; k2 já tinha r/sp e mantém r/sp; k3 tem r/campinas
  const counts = fog.countByCity();
  assert.equal(counts['r/sp'], 2);
  assert.equal(counts['r/campinas'], 1);

  // Roundtrip encodeFog -> gzipSync -> gunzipSync -> decodeFog
  const serialized = fog.serialize();
  const gz = gzipSync(encodeFog(serialized), { level: 6 });
  const decoded = decodeFog(gunzipSync(gz));
  assert.ok(decoded);
  assert.deepEqual([...decoded.keys], [...serialized.keys]);
  assert.deepEqual([...decoded.city], [...serialized.city]);
  assert.deepEqual(decoded.cityIds, serialized.cityIds);

  fog.clear();
});

test('3. sessionStorage.web e fluxo criptográfico LargeSecureStore', () => {
  // 3a. Fallback em memória quando window é undefined (Node)
  const key = `sb-test-auth-${RUN_ID}`;
  assert.equal(webSessionStorage.getItem(key), null);
  webSessionStorage.setItem(key, 'sessao-mem');
  assert.equal(webSessionStorage.getItem(key), 'sessao-mem');
  webSessionStorage.removeItem(key);
  assert.equal(webSessionStorage.getItem(key), null);

  // 3b. Wrapper de window.localStorage com mock e fallback quando localStorage lança erro
  const storeMap = new Map<string, string>();
  const prevWindow = (globalThis as Record<string, unknown>).window;
  let shouldThrow = false;
  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (k: string) => {
        if (shouldThrow) throw new Error('blocked');
        return storeMap.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (shouldThrow) throw new Error('quota');
        storeMap.set(k, v);
      },
      removeItem: (k: string) => {
        if (shouldThrow) throw new Error('blocked');
        storeMap.delete(k);
      },
    },
  };
  try {
    webSessionStorage.setItem(key, 'sessao-ls');
    assert.equal(storeMap.get(key), 'sessao-ls');
    assert.equal(webSessionStorage.getItem(key), 'sessao-ls');

    shouldThrow = true;
    webSessionStorage.setItem(key, 'sessao-fallback');
    assert.equal(webSessionStorage.getItem(key), 'sessao-fallback');

    shouldThrow = false;
    webSessionStorage.removeItem(key);
    assert.equal(storeMap.has(key), false);
    assert.equal(webSessionStorage.getItem(key), null);
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = prevWindow;
    }
  }

  // 3c. Verificação do formato LargeSecureStore (UTF-8 + safeFileName + AES-256-GCM combinado IV+ciphertext+tag)
  const nativeSrc = readFileSync(resolve('src/services/sessionStorage.ts'), 'utf8');
  assert.ok(nativeSrc.includes('AFTER_FIRST_UNLOCK'), 'LargeSecureStore deve usar AFTER_FIRST_UNLOCK');
  assert.ok(nativeSrc.includes('desbrava-auth'), 'LargeSecureStore deve isolar pasta desbrava-auth');
  assert.ok(nativeSrc.includes('aesEncryptAsync') && nativeSrc.includes('aesDecryptAsync'));

  const largePayload = JSON.stringify({
    access_token: 'jwt_' + 'a'.repeat(1800),
    refresh_token: 'ref_' + 'b'.repeat(900),
    user: { id: 'u-1', user_metadata: { display_name: 'Desbravador Ágil 🚴' } },
  });
  const aesKeyBytes = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKeyBytes, iv);
  const enc = Buffer.concat([cipher.update(utf8Encode(largePayload)), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Uint8Array.from(Buffer.concat([iv, enc, tag]));

  const decipher = createDecipheriv('aes-256-gcm', aesKeyBytes, combined.subarray(0, 12));
  decipher.setAuthTag(combined.subarray(combined.length - 16));
  const plain = Uint8Array.from(
    Buffer.concat([decipher.update(combined.subarray(12, combined.length - 16)), decipher.final()]),
  );
  assert.equal(utf8Decode(plain), largePayload);
  assert.notEqual(safeFileName('sb:auth/token'), safeFileName('sb_auth_token'));
});

test('4. syncFog: aborta sem upload nem upsert_fog_state quando download da névoa remota falha ou vem corrompido', async () => {
  fog.clear();
  useGame.getState().resetProgress();

  const localCell = cellOf({ lng: -46.6559, lat: -23.5614 });
  fog.load({
    keys: new Float64Array([localCell]),
    city: new Uint16Array([0]),
    cityIds: [''],
  });

  const userId = '00000000-0000-0000-0000-000000000042';
  let fogRow: { storage_path: string; cell_count: number; revision: number } | null = {
    storage_path: `${userId}/fog.bin.gz`,
    cell_count: 500,
    revision: 7,
  };
  let downloadResult: { data: Blob | null; error: { message: string } | null } = {
    data: null,
    error: { message: 'network timeout' },
  };
  let uploadCalls = 0;
  let rpcCalls = 0;
  let fogSyncState: FogSyncState = { revision: 0, lastSyncedAt: null };

  const mockClient = {
    from: (table: string) => {
      assert.equal(table, 'user_fog_state');
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: fogRow, error: null }),
          }),
        }),
      };
    },
    storage: {
      from: (bucket: string) => {
        assert.equal(bucket, 'fog-snapshots');
        return {
          download: async () => downloadResult,
          upload: async () => {
            uploadCalls++;
            return { error: null };
          },
        };
      },
    },
    rpc: async (fn: string) => {
      assert.equal(fn, 'upsert_fog_state');
      rpcCalls++;
      return {
        data: {
          conflict: false,
          revision: 1,
          storage_path: `${userId}/fog.bin.gz`,
          cell_count: 1,
          total_cells: 1,
        },
        error: null,
      };
    },
  } as unknown as SupabaseClient;

  const deps: SyncDeps = {
    client: mockClient,
    userId,
    loadTrack: async () => undefined,
    fogSync: {
      get: async () => fogSyncState,
      set: async (next) => {
        fogSyncState = next;
      },
    },
  };

  // 4a. Erro no download -> rejeita antes de qualquer upload ou RPC
  await assert.rejects(() => syncFog(deps), /Falha ao baixar snapshot de névoa/);
  assert.equal(uploadCalls, 0, 'Não pode chamar storage.upload após erro no download');
  assert.equal(rpcCalls, 0, 'Não pode chamar upsert_fog_state após erro no download');
  assert.equal(fog.size, 1, 'Névoa local deve permanecer preservada');

  // 4b. Bytes corrompidos no download -> rejeita antes de qualquer upload ou RPC
  downloadResult = {
    data: new Blob([new Uint8Array([0x01, 0x02, 0x03, 0x04])]),
    error: null,
  };
  await assert.rejects(() => syncFog(deps), /Snapshot de névoa remoto inválido/);
  assert.equal(uploadCalls, 0, 'Não pode chamar storage.upload com snapshot corrompido');
  assert.equal(rpcCalls, 0, 'Não pode chamar upsert_fog_state com snapshot corrompido');

  // 4c. Ausência de snapshot remoto (fogRow == null) -> trata como vazio e envia normalmente
  fogRow = null;
  const ok = await syncFog(deps);
  assert.equal(uploadCalls, 1);
  assert.equal(rpcCalls, 1);
  assert.equal(ok.revision, 1);

  fog.clear();
  useGame.getState().resetProgress();
});

test('5. avatar_config: pullCloudToLocal rejeita {} / malformado e syncProfile envia AvatarConfig válido', async () => {
  fog.clear();
  useGame.getState().resetProgress();

  const userId = '00000000-0000-0000-0000-000000000043';
  const updatedPayloads: Array<Record<string, unknown>> = [];
  let remoteAvatarConfig: unknown = {};

  const buildQuery = (data: unknown) => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data, error: null }),
        maybeSingle: async () => ({ data, error: null }),
        order: () => ({
          limit: async () => ({ data: [], error: null }),
        }),
        then: (resolve: (v: { data: unknown; error: null }) => void) =>
          Promise.resolve({ data, error: null }).then(resolve),
      }),
    }),
  });

  const mockClient = {
    from: (table: string) => {
      if (table === 'profiles') {
        return {
          update: (payload: Record<string, unknown>) => ({
            eq: async () => {
              updatedPayloads.push(payload);
              return { error: null };
            },
          }),
          ...buildQuery({
            id: userId,
            username: 'ciclista_teste',
            display_name: 'Ciclista Teste',
            modality: 'bike',
            character_id: 'teo',
            avatar_config: remoteAvatarConfig,
            xp: 0,
            level: 1,
            wallet: 0,
            total_distance_m: 0,
            total_moving_s: 0,
            total_activities: 0,
            total_coins_value: 0,
            total_coins_count: 0,
            total_captures: 0,
            total_cells: 0,
            achievements_count: 0,
            settings: { sound: true, haptics: true },
            is_public: false,
            created_at: new Date().toISOString(),
          }),
        };
      }
      if (table === 'user_fog_state') {
        return buildQuery(null);
      }
      return buildQuery([]);
    },
  } as unknown as SupabaseClient;

  const deps: SyncDeps = {
    client: mockClient,
    userId,
    loadTrack: async () => undefined,
  };

  // 5a. syncProfile com profile.avatar === undefined envia avatarFromCharacter('teo'), nunca {}
  useGame.setState({
    profile: {
      name: 'Legado Sem Avatar',
      characterId: 'teo',
      modality: 'run',
      createdAt: Date.now(),
    },
  });
  await syncProfile(deps);
  assert.equal(updatedPayloads.length, 1);
  assert.equal(isValidAvatarConfig(updatedPayloads[0].avatar_config), true);
  assert.deepEqual(updatedPayloads[0].avatar_config, avatarFromCharacter('teo'));

  // 5b. pullCloudToLocal com avatar_config: {} deixa profile.avatar === undefined e resolveAvatar funciona
  remoteAvatarConfig = {};
  await pullCloudToLocal(deps, { mode: 'replace' });
  const profEmpty = useGame.getState().profile;
  assert.ok(profEmpty);
  assert.equal(profEmpty.avatar, undefined, 'avatar_config: {} deve virar undefined');
  const resolvedEmpty = resolveAvatar(profEmpty);
  assert.deepEqual(resolvedEmpty, avatarFromCharacter('teo'));
  assert.ok(avatarKey(resolvedEmpty).length > 0);
  assert.equal(avatarFrame(resolvedEmpty, 'bike', 'down', 0).w, 24);

  // 5c. pullCloudToLocal com avatar_config malformado também faz fallback seguro
  for (const bad of [
    null,
    { hair: 'moicano', colors: avatarFromCharacter('lia').colors },
    { hair: 'short', colors: { skin: '#f6cfae' } },
    { hair: 'short', colors: { ...avatarFromCharacter('lia').colors, bike: 123 } },
  ]) {
    remoteAvatarConfig = bad;
    await pullCloudToLocal(deps, { mode: 'replace' });
    const p = useGame.getState().profile;
    assert.ok(p);
    assert.equal(p.avatar, undefined, `avatar_config malformado deve virar undefined: ${JSON.stringify(bad)}`);
    assert.ok(avatarKey(resolveAvatar(p)).length > 0);
  }

  // 5d. pullCloudToLocal com avatar_config válido preserva o avatar customizado
  const validCustom = avatarFromCharacter('dandara');
  remoteAvatarConfig = validCustom;
  await pullCloudToLocal(deps, { mode: 'replace' });
  assert.deepEqual(useGame.getState().profile?.avatar, validCustom);

  fog.clear();
  useGame.getState().resetProgress();
});

test('6. Integração ao vivo no Supabase (lugwebngeyadfrqoapsg): syncProfile, syncActivity, syncCitiesAndCaptures, syncFog, syncAchievements, pullCloudToLocal', async (t) => {
  assert.ok(SUPABASE_URL && SUPABASE_KEY, 'EXPO_PUBLIC_SUPABASE_URL e EXPO_PUBLIC_SUPABASE_ANON_KEY necessárias');

  let adminClient: SupabaseClient | null = null;
  let ephemeralUser = false;
  let userId = '';
  let client!: SupabaseClient;

  const uploadedTrackPaths: string[] = [];
  const tracks = new Map<string, Float64Array>();
  let fogSyncState: FogSyncState = { revision: 0, lastSyncedAt: null };

  if (SERVICE_ROLE_KEY) {
    ephemeralUser = true;
    adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const email = `desbrava.sync.${RUN_ID}@example.com`;
    const password = `Desbrava!${RUN_ID}#7`;
    const created = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: `Sync ${RUN_ID}`, modality: 'bike' },
    });
    assert.ifError(created.error);
    const anon = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signed = await anon.auth.signInWithPassword({ email, password });
    assert.ifError(signed.error);
    assert.ok(signed.data.user && signed.data.session);
    userId = signed.data.user.id;
    client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: { headers: { Authorization: `Bearer ${signed.data.session.access_token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } else if (process.env.TEST_USER_A_EMAIL && process.env.TEST_USER_A_PASSWORD) {
    const anon = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signed = await anon.auth.signInWithPassword({
      email: process.env.TEST_USER_A_EMAIL,
      password: process.env.TEST_USER_A_PASSWORD,
    });
    assert.ifError(signed.error);
    assert.ok(signed.data.user && signed.data.session);
    userId = signed.data.user.id;
    client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: { headers: { Authorization: `Bearer ${signed.data.session.access_token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } else {
    throw new Error(
      'Credenciais ausentes: configure SUPABASE_SERVICE_ROLE_KEY ou TEST_USER_A_EMAIL/TEST_USER_A_PASSWORD em .env.local.',
    );
  }

  // Snapshot inicial do perfil para restaurar ao final (quando usando TEST_USER_A)
  const { data: origProf, error: origProfErr } = await client
    .from('profiles')
    .select('username, display_name, modality, character_id, avatar_config, is_public, settings')
    .eq('id', userId)
    .single();
  assert.ifError(origProfErr);

  const deps: SyncDeps = {
    client,
    userId,
    loadTrack: async (id) => tracks.get(id),
    fogSync: {
      get: async () => fogSyncState,
      set: async (next) => {
        fogSyncState = next;
      },
    },
  };

  t.after(async () => {
    try {
      if (uploadedTrackPaths.length > 0) {
        await client.storage.from('activity-tracks').remove(uploadedTrackPaths);
      }
      if (ephemeralUser && adminClient) {
        await client.storage.from('fog-snapshots').remove([`${userId}/fog.bin.gz`]);
        await adminClient.auth.admin.deleteUser(userId);
      } else if (origProf) {
        await client
          .from('profiles')
          .update({
            display_name: origProf.display_name,
            modality: origProf.modality,
            character_id: origProf.character_id,
            avatar_config: origProf.avatar_config,
            is_public: origProf.is_public,
            settings: origProf.settings,
          })
          .eq('id', userId);
      }
    } catch {
      // Melhor esforço na limpeza pós-teste
    }
    useGame.getState().resetProgress();
    fog.clear();
  });

  // Limpa estado local do Zustand/névoa antes de iniciar
  useGame.getState().resetProgress();
  fog.clear();
  useGame.getState().createProfile(`Viajante ${RUN_ID}`, {
    hair: 'pony',
    colors: {
      skin: '#e8b48a',
      hair: '#4a2c2a',
      top: '#ff6b5a',
      bottom: '#2f3e7a',
      shoe: '#4fe0b0',
      helmet: '#ffd23f',
      bike: '#4fe0b0',
    },
  }, 'bike', 'lia');

  // 4a. syncProfile
  await syncProfile(deps);
  const { data: profAfterSync } = await client
    .from('profiles')
    .select('display_name, modality, character_id')
    .eq('id', userId)
    .single();
  assert.equal(profAfterSync?.display_name, `Viajante ${RUN_ID}`);
  assert.equal(profAfterSync?.modality, 'bike');

  // 4b. syncActivity (trilha realista na Av. Paulista + coinsByKind + captura)
  const t0 = Date.now() - 80_000;
  const pts = [
    { lng: -46.6559, lat: -23.5614, t: t0 },
    { lng: -46.6540, lat: -23.5614, t: t0 + 25_000 },
    { lng: -46.6520, lat: -23.5614, t: t0 + 50_000 },
  ];
  const trackArr = new Float64Array(pts.length * 3);
  for (let i = 0; i < pts.length; i++) {
    trackArr[i * 3] = pts[i].lng;
    trackArr[i * 3 + 1] = pts[i].lat;
    trackArr[i * 3 + 2] = pts[i].t;
  }

  const cellSet = new Set<number>();
  for (let i = 1; i < pts.length; i++) {
    const d = haversine(pts[i - 1], pts[i]);
    const steps = Math.max(1, Math.ceil(d / (REVEAL_RADIUS_M * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const p = lerpLngLat(pts[i - 1], pts[i], s / steps);
      for (const k of cellsInRadius(p, REVEAL_RADIUS_M)) {
        cellSet.add(k);
      }
    }
  }
  const distM = haversine(pts[0], pts[1]) + haversine(pts[1], pts[2]);
  const poiId = `poi_sync_${RUN_ID}`;
  const museuRarity = POI_INFO.museu.rarity;
  const capture: Capture = {
    id: poiId,
    name: 'MASP Teste Sync',
    category: 'museu',
    rarity: museuRarity,
    lng: -46.6559,
    lat: -23.5614,
    cityId: 'r/298285',
    activityId: `act_sync_${RUN_ID}`,
    capturedAt: t0 + 10_000,
  };

  const actId = `act_sync_${RUN_ID}`;
  tracks.set(actId, trackArr);
  uploadedTrackPaths.push(`${userId}/${actId}.bin.gz`);

  const coinsByKind = { bronze: 2, silver: 1, gold: 0, gem: 0 };
  const coinsValue = 2 * COIN_VALUE.bronze + 1 * COIN_VALUE.silver;
  const activity: ActivitySummary = {
    id: actId,
    modality: 'bike',
    startedAt: t0,
    endedAt: t0 + 50_000,
    elapsedS: 50,
    movingS: 50,
    distanceM: distM,
    maxSpeed: distM / 50,
    coinsValue,
    coinsCount: 3,
    coinsByKind,
    captures: [poiId],
    newCells: cellSet.size,
    xp: Math.floor((distM / 1000) * XP.perKm.bike) + Math.floor(cellSet.size * XP.perCell.bike) + 5 + RARITY_INFO[museuRarity].xp,
    cityIds: ['r/298285'],
    source: 'live',
    verificationStatus: 'local',
  };

  const spCity: City = {
    id: 'r/298285',
    name: 'São Paulo',
    state: 'SP',
    country: 'Brasil',
    areaM2: 1_521_110_000,
    bbox: [-46.826, -24.008, -46.365, -23.356],
    cells: cellSet.size,
    cellAreaM2: 289,
    discoveredAt: t0,
  };

  useGame.setState({
    activities: [activity],
    captures: { [poiId]: capture },
    cities: { [spCity.id]: spCity },
    totals: {
      ...EMPTY_TOTALS,
      activities: 1,
      distanceM: distM,
      movingS: 50,
      coinsCount: 3,
      coinsValue,
      captures: 1,
      cells: cellSet.size,
    },
  });

  const verifyRes = await syncActivity(deps, activity);
  assert.ok(verifyRes, 'syncActivity deve retornar resposta de verify-activity');
  assert.equal(verifyRes.status, 'verified', `Esperado verified, recebido ${verifyRes.status}: ${verifyRes.reason}`);
  assert.equal(useGame.getState().activities[0].verificationStatus, 'verified');
  assert.equal(useGame.getState().xp, verifyRes.authoritative.xp);
  assert.equal(useGame.getState().wallet, verifyRes.authoritative.wallet);

  // 4c. syncCitiesAndCaptures: poiId já tem is_verified = true no servidor;
  // adicionar mais uma captura local pendente NÃO pode falhar com 42501
  const pendingPoiId = `poi_local_${RUN_ID}`;
  useGame.setState({
    captures: {
      ...useGame.getState().captures,
      [pendingPoiId]: {
        id: pendingPoiId,
        name: 'Parque Trianon Local',
        category: 'parque',
        rarity: 'comum',
        lng: -46.657,
        lat: -23.562,
        cityId: 'r/298285',
        activityId: null,
        capturedAt: Date.now(),
      },
    },
  });
  await syncCitiesAndCaptures(deps);
  const { data: capRows } = await client
    .from('user_captures')
    .select('poi_id, is_verified')
    .eq('user_id', userId)
    .in('poi_id', [poiId, pendingPoiId]);
  const capMap = new Map((capRows ?? []).map((r) => [r.poi_id as string, r.is_verified as boolean]));
  assert.equal(capMap.get(poiId), true, 'Captura verificada deve permanecer is_verified=true');
  assert.equal(capMap.get(pendingPoiId), false, 'Captura enviada direto pelo cliente deve ficar is_verified=false');

  // 4d. syncFog + teste de conflito de revisão otimista e retry com merge
  fog.load({
    keys: new Float64Array([...cellSet]),
    city: new Uint16Array(cellSet.size).fill(1),
    cityIds: ['', 'r/298285'],
  });
  const fogRes1 = await syncFog(deps, { forceUpload: true });
  assert.ok(fogRes1.revision >= 1, 'upsert_fog_state deve incrementar revision');

  // Força expectedRevision defasado (-1) para disparar ramo de conflito + download + merge + retry
  const extraCell = cellOf({ lng: -46.6500, lat: -23.5614 });
  fog.merge({
    keys: new Float64Array([extraCell]),
    city: new Uint16Array([1]),
    cityIds: ['', 'r/298285'],
  });
  const fogRes2 = await syncFog(deps, { forceUpload: true, expectedRevision: -1 });
  assert.equal(fogRes2.revision, fogRes1.revision + 1, 'Retry após conflito deve avançar revision');
  assert.equal(fogSyncState.revision, fogRes2.revision);

  // 4e. syncAchievements (tenta claim legítimo + chave inatingida P0001 sem quebrar)
  useGame.setState({
    achievements: {
      ...useGame.getState().achievements,
      'total_activities:0': { at: Date.now(), coins: 15 },
      'total_distance:6': { at: Date.now(), coins: 500 }, // 2500 km -> servidor deve recusar com P0001
    },
  });
  await syncAchievements(deps);
  const { data: achRows } = await client
    .from('user_achievements')
    .select('achievement_key')
    .eq('user_id', userId);
  const claimedSet = new Set((achRows ?? []).map((r) => r.achievement_key as string));
  assert.ok(claimedSet.has('total_activities:0'), 'Conquista elegível deve ser resgatada no servidor');
  assert.ok(!claimedSet.has('total_distance:6'), 'Conquista inatingida (P0001) não deve ser gravada');

  // 4f. pushAllLocalToCloud seguido de wipe local + pullCloudToLocal
  await pushAllLocalToCloud(deps);
  const expectedXp = useGame.getState().xp;
  const expectedWallet = useGame.getState().wallet;
  const expectedFogSize = fog.size;

  useGame.getState().resetProgress();
  fog.clear();
  assert.equal(useGame.getState().profile, null);
  assert.equal(fog.size, 0);

  await pullCloudToLocal(deps, { mode: 'replace' });
  const restored = useGame.getState();
  assert.ok(restored.profile, 'pullCloudToLocal deve restaurar perfil');
  assert.equal(restored.profile.cloudUserId, userId);
  assert.equal(restored.xp, expectedXp);
  assert.equal(restored.wallet, expectedWallet);
  assert.ok(restored.activities.some((a) => a.id === actId), 'Atividade deve ser restaurada');
  assert.ok(restored.captures[poiId], 'Captura deve ser restaurada');
  assert.ok(restored.cities['r/298285'], 'Cidade deve ser restaurada');
  assert.ok(restored.achievements['total_activities:0'], 'Conquista deve ser restaurada');
  assert.equal(fog.size, expectedFogSize, 'Névoa deve ser restaurada via fog-snapshots');
});
