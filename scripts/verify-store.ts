// Verificação automatizada do M5 (store-cosmetics-ui): testes unitários + integração ao vivo.
// Rodar com: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test scripts/verify-store.ts
// ATENÇÃO: nunca chamar signUp(), resetPasswordForEmail() ou resend() contra o Supabase ao vivo (política anti-bounce).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { REVEAL_RADIUS_M } from '../src/game/config.ts';
import { fog } from '../src/game/fog.ts';
import { cellOf, cellsInRadius } from '../src/game/geo.ts';
import { effectiveRevealRadius, useGame } from '../src/game/store.ts';
import {
  applyCosmeticToProfile,
  boosterDurationS,
  boosterMultiplier,
  extractUnlockedCharacterIds,
  fetchStoreCatalogWithClient,
  fetchUserInventoryWithClient,
  isCosmeticEquipped,
  mapStoreError,
  parseStoreItem,
  purchaseStoreItemWithClient,
  toActiveBooster,
  type StoreItem,
} from '../src/services/storeServiceCore.ts';
import { isValidAvatarConfig, syncProfile, type SyncDeps } from '../src/services/syncCore.ts';
import {
  DEFAULT_AVATAR,
  avatarFrame,
  avatarKey,
  normalizeCosmeticKey,
} from '../src/sprites/avatar.ts';
import { ALL_CHARACTER_ART } from '../src/sprites/characters.ts';
import { ALL_ICON_ART, ICON_NAMES } from '../src/sprites/icons.ts';
import { COIN_VALUE } from '../src/sprites/items.ts';
import { checkArt } from '../src/sprites/pixel.ts';

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
const TEST_USER_A_EMAIL = (process.env.TEST_USER_A_EMAIL ?? '').trim();
const TEST_USER_A_PASSWORD = (process.env.TEST_USER_A_PASSWORD ?? '').trim();

function rasterEqual(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

test('1. storeServiceCore: parser, duração/multiplicador, desbloqueios, equip e erros em pt-BR', () => {
  const xpItem = parseStoreItem({
    id: 'boost_xp_2x',
    kind: 'consumable',
    category: 'boost_xp',
    name: 'Dobro de XP',
    description: '2x XP',
    price_coins: 60,
    rarity: 'incomum',
    max_stack: 10,
    metadata: { multiplier: 2, durationMin: 30 },
    sort_order: 200,
  });
  assert.equal(boosterDurationS(xpItem), 1800);
  assert.equal(boosterMultiplier(xpItem), 2);

  const fogItem = parseStoreItem({
    id: 'boost_fog_wide',
    kind: 'consumable',
    category: 'boost_fog',
    name: 'Radar de Névoa',
    description: '+50% raio',
    price_coins: 75,
    rarity: 'raro',
    max_stack: 10,
    metadata: { multiplier: 1.5, duration_minutes: 15 },
    sort_order: 210,
  });
  assert.equal(boosterDurationS(fogItem), 900);
  assert.equal(boosterMultiplier(fogItem), 1.5);

  const customS = parseStoreItem({
    id: 'boost_custom',
    kind: 'consumable',
    category: 'boost_coins',
    name: 'Imã',
    description: '2x moedas',
    price_coins: 85,
    rarity: 'raro',
    max_stack: 10,
    metadata: { multiplier: 2, duration_s: 600 },
    sort_order: 220,
  });
  assert.equal(boosterDurationS(customS), 600);

  const active = toActiveBooster(
    {
      id: 'bst_test_1',
      itemId: xpItem.id,
      activityId: null,
      activatedAt: 10_000,
      expiresAt: 20_000,
      consumedAt: null,
    },
    xpItem,
    15_000,
  );
  assert.ok(active);
  assert.equal(active.multiplier, 2);
  assert.equal(active.category, 'boost_xp');
  assert.equal(
    toActiveBooster(
      { id: 'bst_exp', itemId: xpItem.id, activityId: null, activatedAt: 10_000, expiresAt: 12_000, consumedAt: null },
      xpItem,
      15_000,
    ),
    null,
  );

  // Personagens desbloqueados a partir do inventário
  const catalog: StoreItem[] = [
    parseStoreItem({
      id: 'char_kenji',
      kind: 'cosmetic',
      category: 'character',
      name: 'Kenji',
      price_coins: 250,
      rarity: 'incomum',
      max_stack: 1,
      metadata: { slot: 'character', cosmeticKey: 'kenji', characterId: 'kenji' },
    }),
  ];
  const unlocked = extractUnlockedCharacterIds(
    [{ itemId: 'char_kenji', quantity: 1, firstPurchasedAt: 1, updatedAt: 1 }],
    catalog,
  );
  assert.deepEqual(new Set(unlocked), new Set(['lia', 'teo', 'dandara', 'kenji']));

  // Suporta tanto item_id (hat_bone_retro) quanto cosmeticKey (bone_retro)
  const p0 = { characterId: 'lia', avatar: DEFAULT_AVATAR };
  const eqByItemId = applyCosmeticToProfile(p0, 'hat', 'hat_bone_retro');
  assert.equal(eqByItemId.avatar.cosmetics?.hat, 'bone_retro');
  assert.equal(
    isCosmeticEquipped(
      { characterId: eqByItemId.characterId, avatar: eqByItemId.avatar },
      { id: 'hat_bone_retro', category: 'hat', metadata: { cosmeticKey: 'bone_retro' } },
    ),
    true,
  );
  assert.equal(
    isCosmeticEquipped(
      { characterId: 'lia', avatar: { ...DEFAULT_AVATAR, cosmetics: { hat: 'hat_bone_retro' } } },
      { id: 'hat_bone_retro', category: 'hat', metadata: { cosmeticKey: 'bone_retro' } },
    ),
    true,
  );

  const removedHat = applyCosmeticToProfile(eqByItemId, 'hat', null);
  assert.equal(removedHat.avatar.cosmetics, undefined);

  const eqChar = applyCosmeticToProfile(eqByItemId, 'character', 'char_kenji');
  assert.equal(eqChar.characterId, 'kenji');
  assert.equal(eqChar.avatar.cosmetics?.hat, 'bone_retro');

  // Erros em pt-BR
  assert.equal(
    mapStoreError({ code: 'P0001', message: 'Saldo insuficiente' }),
    'Saldo insuficiente para comprar este item.',
  );
  assert.equal(
    mapStoreError({ code: '42501', message: 'Não autenticado' }),
    'Entre na sua conta para comprar itens e ativar boosters.',
  );
  assert.equal(
    mapStoreError(new TypeError('Failed to fetch')),
    'Sem conexão com o servidor. Confira sua internet.',
  );
  assert.match(
    mapStoreError({ code: '22023', message: 'Limite máximo de inventário atingido (1)' }),
    /Limite máximo de inventário/,
  );
});

test('2. Sprites & AvatarConfig: ícone shop, uniformidade de artes, renderização de cosméticos e validação', () => {
  assert.ok(ICON_NAMES.includes('shop'), 'ícone shop deve estar registrado em icons.ts');

  const artErrors = [
    ...Object.entries(ALL_CHARACTER_ART),
    ...Object.entries(ALL_ICON_ART),
  ].flatMap(([name, art]) => checkArt(name, art));
  assert.deepEqual(artErrors, [], 'Todas as artes de personagens, cosméticos e ícones devem ter largura uniforme');

  // Validação de AvatarConfig com e sem cosmetics
  assert.equal(isValidAvatarConfig(DEFAULT_AVATAR), true);
  assert.equal(
    isValidAvatarConfig({
      ...DEFAULT_AVATAR,
      cosmetics: { hat: 'bone_retro', glasses: 'aviador', bike: 'bike_dourada', shoe: 'relampago', pet: 'caramelo', color: 'neon_cyber' },
    }),
    true,
  );
  assert.equal(isValidAvatarConfig({ ...DEFAULT_AVATAR, cosmetics: { unknown_slot: 'x' } }), false);
  assert.equal(isValidAvatarConfig({ ...DEFAULT_AVATAR, cosmetics: { hat: '' } }), false);
  assert.equal(isValidAvatarConfig({ ...DEFAULT_AVATAR, cosmetics: ['hat'] }), false);

  // Normalização de item_id e cosmeticKey (incluindo bike_dourada)
  assert.equal(normalizeCosmeticKey('hat', 'hat_bone_retro'), 'bone_retro');
  assert.equal(normalizeCosmeticKey('bike', 'bike_dourada'), 'bike_dourada');
  assert.equal(normalizeCosmeticKey('bike', 'bike_speed_carbon'), 'speed_carbon');

  // Cada slot altera visivelmente o raster e muda avatarKey
  const baseFrame = avatarFrame(DEFAULT_AVATAR, 'bike', 'down', 0);
  const baseSideBike = avatarFrame(DEFAULT_AVATAR, 'bike', 'right', 0);
  const baseRun = avatarFrame(DEFAULT_AVATAR, 'run', 'down', 0);
  const baseKey = avatarKey(DEFAULT_AVATAR);

  const withHatById = { ...DEFAULT_AVATAR, cosmetics: { hat: 'hat_bone_retro' } };
  const withHatByKey = { ...DEFAULT_AVATAR, cosmetics: { hat: 'bone_retro' } };
  assert.equal(avatarKey(withHatById), avatarKey(withHatByKey));
  assert.notEqual(avatarKey(withHatByKey), baseKey);
  assert.equal(
    rasterEqual(
      avatarFrame(withHatById, 'bike', 'down', 0).data,
      avatarFrame(withHatByKey, 'bike', 'down', 0).data,
    ),
    true,
  );
  assert.equal(rasterEqual(baseFrame.data, avatarFrame(withHatByKey, 'bike', 'down', 0).data), false);

  const cosmeticChecks: Array<{
    cosmetics: Record<string, string>;
    modality: 'bike' | 'run';
    facing: 'down' | 'right';
    base: Uint8ClampedArray;
  }> = [
    { cosmetics: { glasses: 'glasses_viseira_neon' }, modality: 'bike', facing: 'down', base: baseFrame.data },
    { cosmetics: { bike: 'bike_dourada' }, modality: 'bike', facing: 'right', base: baseSideBike.data },
    { cosmetics: { shoe: 'shoe_relampago' }, modality: 'run', facing: 'down', base: baseRun.data },
    { cosmetics: { pet: 'pet_caramelo' }, modality: 'run', facing: 'down', base: baseRun.data },
    { cosmetics: { color: 'color_neon_cyber' }, modality: 'bike', facing: 'down', base: baseFrame.data },
  ];
  for (const check of cosmeticChecks) {
    const cfg = { ...DEFAULT_AVATAR, cosmetics: check.cosmetics };
    assert.notEqual(avatarKey(cfg), baseKey);
    const frame = avatarFrame(cfg, check.modality, check.facing, 0);
    assert.equal(rasterEqual(frame.data, check.base), false, `Cosmético ${JSON.stringify(check.cosmetics)} deve alterar pixels`);
  }
});

test('3. Gameplay de Boosters: boostUsageIds no store, base coinsByKind parity e raio boost_fog', () => {
  useGame.getState().resetProgress();
  fog.clear();

  useGame.getState().createProfile('Testador', DEFAULT_AVATAR, 'bike', 'lia');

  const now = Date.now();
  useGame.getState().setActiveBoosters([
    {
      usageId: 'bst_xp_1',
      itemId: 'boost_xp_2x',
      category: 'boost_xp',
      multiplier: 2,
      name: 'Dobro de XP',
      activatedAt: now - 1000,
      expiresAt: now + 600_000,
    },
    {
      usageId: 'bst_fog_1',
      itemId: 'boost_fog_wide',
      category: 'boost_fog',
      multiplier: 1.5,
      name: 'Radar de Névoa',
      activatedAt: now - 1000,
      expiresAt: now + 600_000,
    },
    {
      usageId: 'bst_coins_1',
      itemId: 'boost_coins_2x',
      category: 'boost_coins',
      multiplier: 2,
      name: 'Imã de Moedas',
      activatedAt: now - 1000,
      expiresAt: now + 600_000,
    },
  ]);

  useGame.getState().startActivity();
  const liveAfterStart = useGame.getState().live;
  assert.ok(liveAfterStart);
  assert.deepEqual(liveAfterStart.boostUsageIds, ['bst_xp_1', 'bst_fog_1', 'bst_coins_1']);

  // Coletar moeda com boost_coins (2x) e boost_xp (2x):
  // live.coinsValue deve permanecer no valor BASE para paridade com coinsByKind no verify-activity!
  useGame.getState().collectCoin({ id: 'c1', kind: 'silver', lng: -46.6559, lat: -23.5614 });
  const afterCoin = useGame.getState();
  assert.equal(afterCoin.live?.coinsValue, COIN_VALUE.silver);
  assert.equal(afterCoin.live?.coinsByKind?.silver, 1);
  assert.equal(afterCoin.wallet, COIN_VALUE.silver * 2);
  // silver (5) * 0.5 = 3 base XP -> * 2 (boost_xp) = 6
  assert.equal(afterCoin.xp, 6);

  // Paridade de raio boost_fog (REVEAL_RADIUS_M * 1.5)
  const center = { lng: -46.6559, lat: -23.5614 };
  const radius = effectiveRevealRadius(useGame.getState(), now);
  assert.equal(radius, REVEAL_RADIUS_M * 1.5);
  const expectedKeys = cellsInRadius(center, REVEAL_RADIUS_M * 1.5);
  const baseKeys = cellsInRadius(center, REVEAL_RADIUS_M);
  assert.ok(expectedKeys.length > baseKeys.length);

  fog.revealAlong(center, center, radius, () => null);
  assert.equal(fog.size, expectedKeys.length, 'fog.revealAlong deve revelar exatamente células do raio multiplicado por 1.5');
  for (const k of expectedKeys) {
    assert.equal(fog.has(k), true);
  }
  assert.equal(fog.has(cellOf(center)), true);

  const summary = useGame.getState().finishActivity();
  assert.ok(summary);
  assert.deepEqual(summary.boostUsageIds, ['bst_xp_1', 'bst_fog_1', 'bst_coins_1']);
  assert.equal(summary.coinsValue, COIN_VALUE.silver);

  // Reconciliação limpa os boosters consumidos
  useGame.getState().reconcileVerifiedActivity({
    activityId: summary.id,
    verificationStatus: 'verified',
    xpEarned: 100,
    coinsEarned: 10,
    authoritative: {
      xp: 100,
      level: 1,
      wallet: 10,
      totalDistanceM: 0,
      totalMovingS: 0,
      totalActivities: 1,
      totalCells: fog.size,
      totalCaptures: 0,
      achievementsCount: 0,
    },
  });
  assert.equal(useGame.getState().activeBoosters.length, 0);

  useGame.getState().resetProgress();
  fog.clear();
});

test('4. Live Supabase (lugwebngeyadfrqoapsg): catálogo, inventário, saldo insuficiente e syncProfile com cosméticos', async (t) => {
  if (!SUPABASE_URL || !SUPABASE_KEY || !TEST_USER_A_EMAIL || !TEST_USER_A_PASSWORD) {
    t.skip('Credenciais TEST_USER_A_* ausentes em .env.local');
    return;
  }

  const client = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Catálogo público de 19 itens
  const catalog = await fetchStoreCatalogWithClient(client);
  assert.equal(catalog.length, 19, 'Deve retornar os 19 itens ativos da loja');
  assert.ok(catalog.some((i) => i.id === 'hat_bone_retro'));
  assert.ok(catalog.some((i) => i.id === 'boost_xp_2x'));
  assert.ok(catalog.some((i) => i.id === 'boost_fog_wide'));
  assert.ok(catalog.some((i) => i.id === 'boost_coins_2x'));

  const auth = await client.auth.signInWithPassword({
    email: TEST_USER_A_EMAIL,
    password: TEST_USER_A_PASSWORD,
  });
  assert.equal(auth.error, null);
  assert.ok(auth.data.user);
  const userId = auth.data.user.id;

  const { data: origProf, error: profErr } = await client
    .from('profiles')
    .select('display_name, modality, character_id, avatar_config, settings')
    .eq('id', userId)
    .single();
  assert.equal(profErr, null);
  assert.ok(origProf);

  t.after(async () => {
    await client
      .from('profiles')
      .update({
        display_name: origProf.display_name,
        modality: origProf.modality,
        character_id: origProf.character_id,
        avatar_config: origProf.avatar_config,
        settings: origProf.settings,
      })
      .eq('id', userId);
    useGame.getState().resetProgress();
    await client.auth.signOut({ scope: 'local' });
  });

  const snap = await fetchUserInventoryWithClient(client, userId);
  assert.ok(Array.isArray(snap.inventory));
  assert.ok(Array.isArray(snap.activeUsages));
  assert.equal(typeof snap.wallet, 'number');

  // Testa rejeição de compra com saldo insuficiente (se houver item mais caro que o wallet atual)
  const expensive = [...catalog]
    .filter((i) => i.priceCoins > snap.wallet && !snap.inventory.some((e) => e.itemId === i.id && e.quantity > 0))
    .sort((a, b) => b.priceCoins - a.priceCoins)[0];
  if (expensive) {
    await assert.rejects(
      () => purchaseStoreItemWithClient(client, expensive.id, 1),
      (err: unknown) => /Saldo insuficiente/i.test(mapStoreError(err)),
    );
  }

  // Testa roundtrip de avatar_config com cosmetics via syncProfile
  useGame.getState().resetProgress();
  const baseAvatar = isValidAvatarConfig(origProf.avatar_config) ? origProf.avatar_config : DEFAULT_AVATAR;
  const decoratedAvatar = {
    ...baseAvatar,
    cosmetics: {
      hat: 'bone_retro',
      glasses: 'aviador',
      pet: 'caramelo',
    },
  };
  useGame.getState().createProfile(
    String(origProf.display_name || 'Viajante'),
    decoratedAvatar,
    origProf.modality === 'run' ? 'run' : 'bike',
    String(origProf.character_id || 'lia'),
  );
  const deps: SyncDeps = {
    client,
    userId,
    loadTrack: async () => undefined,
  };
  await syncProfile(deps);

  const { data: updatedProf, error: updErr } = await client
    .from('profiles')
    .select('avatar_config')
    .eq('id', userId)
    .single();
  assert.equal(updErr, null);
  assert.equal(isValidAvatarConfig(updatedProf?.avatar_config), true);
  assert.deepEqual(
    (updatedProf?.avatar_config as { cosmetics?: unknown })?.cosmetics,
    decoratedAvatar.cosmetics,
  );
});
