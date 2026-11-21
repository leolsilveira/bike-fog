// Serviço puro da Loja, Cosméticos e Boosters online (compatível com Node 24, sem imports RN/Expo).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActiveBooster, AvatarConfig, BoosterCategory, Modality, Profile, Rarity } from '../game/types.ts';
import {
  COSMETIC_SLOTS,
  avatarFromCharacter,
  normalizeCosmeticKey,
  resolveAvatar,
  type AvatarColors,
  type AvatarCosmetics,
  type CosmeticSlotKey,
} from '../sprites/avatar.ts';
import { CHARACTERS } from '../sprites/characters.ts';
import { mapAuthError } from './authCore.ts';

export type StoreItemKind = 'cosmetic' | 'consumable';

export type CosmeticCategory = 'character' | CosmeticSlotKey;
export type StoreCategory = CosmeticCategory | BoosterCategory;

export interface StoreItemMetadata {
  slot?: CosmeticCategory;
  cosmeticKey?: string;
  characterId?: string;
  color?: string;
  shade?: string;
  colors?: Partial<AvatarColors>;
  effect?: string;
  multiplier?: number;
  durationMin?: number;
  duration_s?: number;
  duration_minutes?: number;
  [key: string]: unknown;
}

export interface StoreItem {
  id: string;
  kind: StoreItemKind;
  category: StoreCategory;
  name: string;
  description: string;
  priceCoins: number;
  rarity: Rarity;
  maxStack: number | null;
  metadata: StoreItemMetadata;
  sortOrder: number;
}

export interface InventoryEntry {
  itemId: string;
  quantity: number;
  firstPurchasedAt: number;
  updatedAt: number;
}

export interface BoostUsageRecord {
  id: string;
  itemId: string;
  activityId: string | null;
  activatedAt: number;
  expiresAt: number | null;
  consumedAt: number | null;
}

export interface UserInventorySnapshot {
  inventory: InventoryEntry[];
  activeUsages: BoostUsageRecord[];
  wallet: number;
}

export interface PurchaseResult {
  itemId: string;
  quantity: number;
  totalPaid: number;
  wallet: number;
}

const VALID_RARITIES = new Set<Rarity>(['comum', 'incomum', 'raro', 'epico', 'lendario']);
const BOOSTER_CATEGORIES = new Set<BoosterCategory>(['boost_xp', 'boost_fog', 'boost_coins']);
const FREE_CHARACTER_IDS = CHARACTERS.filter((c) => c.price === 0).map((c) => c.id);

export function isBoosterCategory(category: string): category is BoosterCategory {
  return BOOSTER_CATEGORIES.has(category as BoosterCategory);
}

export function isCosmeticSlotKey(category: string): category is CosmeticSlotKey {
  return (COSMETIC_SLOTS as readonly string[]).includes(category);
}

function toMs(iso: unknown): number | null {
  if (typeof iso !== 'string' || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function parseStoreItem(row: Record<string, unknown>): StoreItem {
  const rarityRaw = String(row.rarity ?? 'comum') as Rarity;
  const rarity: Rarity = VALID_RARITIES.has(rarityRaw) ? rarityRaw : 'comum';
  const kind: StoreItemKind = row.kind === 'consumable' ? 'consumable' : 'cosmetic';
  const metadata =
    row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? (row.metadata as StoreItemMetadata)
      : {};

  return {
    id: String(row.id),
    kind,
    category: String(row.category) as StoreCategory,
    name: String(row.name ?? ''),
    description: String(row.description ?? ''),
    priceCoins: Math.max(0, Math.round(Number(row.price_coins ?? 0))),
    rarity,
    maxStack: typeof row.max_stack === 'number' && Number.isFinite(row.max_stack) ? row.max_stack : null,
    metadata,
    sortOrder: typeof row.sort_order === 'number' && Number.isFinite(row.sort_order) ? row.sort_order : 0,
  };
}

export function parseInventoryEntry(row: Record<string, unknown>): InventoryEntry {
  return {
    itemId: String(row.item_id),
    quantity: Math.max(0, Math.round(Number(row.quantity ?? 0))),
    firstPurchasedAt: toMs(row.first_purchased_at) ?? 0,
    updatedAt: toMs(row.updated_at) ?? 0,
  };
}

export function parseBoostUsage(row: Record<string, unknown>): BoostUsageRecord {
  return {
    id: String(row.id),
    itemId: String(row.item_id),
    activityId: typeof row.activity_id === 'string' && row.activity_id.trim() ? row.activity_id : null,
    activatedAt: toMs(row.activated_at) ?? Date.now(),
    expiresAt: toMs(row.expires_at),
    consumedAt: toMs(row.consumed_at),
  };
}

export function boosterDurationS(item: Pick<StoreItem, 'metadata'>): number {
  const meta = item.metadata;
  const rawS =
    meta.duration_s ??
    (meta.durationMin != null ? Number(meta.durationMin) * 60 : undefined) ??
    (meta.duration_minutes != null ? Number(meta.duration_minutes) * 60 : undefined) ??
    1800;
  const num = Number(rawS);
  if (!Number.isFinite(num) || num <= 0) return 1800;
  return Math.round(num);
}

export function boosterMultiplier(item: Pick<StoreItem, 'metadata'>): number {
  const num = Number(item.metadata.multiplier ?? 1);
  if (!Number.isFinite(num) || num < 1) return 1;
  return Math.min(5, num);
}

export function toActiveBooster(
  usage: BoostUsageRecord,
  item: StoreItem,
  nowMs = Date.now(),
): ActiveBooster | null {
  if (usage.consumedAt !== null) return null;
  if (!isBoosterCategory(item.category)) return null;
  const expiresAt = usage.expiresAt ?? usage.activatedAt + boosterDurationS(item) * 1000;
  if (expiresAt <= nowMs) return null;
  return {
    usageId: usage.id,
    itemId: item.id,
    category: item.category,
    multiplier: boosterMultiplier(item),
    name: item.name,
    activatedAt: usage.activatedAt,
    expiresAt,
  };
}

export function extractUnlockedCharacterIds(
  inventory: readonly InventoryEntry[],
  catalog: readonly StoreItem[],
): string[] {
  const itemById = new Map(catalog.map((i) => [i.id, i]));
  const unlocked = new Set<string>(FREE_CHARACTER_IDS);
  for (const entry of inventory) {
    if (entry.quantity <= 0) continue;
    const item = itemById.get(entry.itemId);
    if (item && item.category === 'character') {
      const charId =
        item.metadata.characterId ??
        item.metadata.cosmeticKey ??
        item.id.replace(/^char_/, '');
      if (charId) unlocked.add(charId);
    } else if (entry.itemId.startsWith('char_')) {
      unlocked.add(entry.itemId.slice('char_'.length));
    }
  }
  return [...unlocked];
}

function normalizeCharacterId(itemIdOrKey: string): string {
  const clean = itemIdOrKey.trim();
  return clean.startsWith('char_') ? clean.slice('char_'.length) : clean;
}

/** Calcula o próximo `avatar` e `characterId` ao equipar ou remover um cosmético. */
export function applyCosmeticToProfile(
  profile: Pick<Profile, 'characterId' | 'avatar'> & { modality?: Modality },
  category: CosmeticCategory,
  itemIdOrKey: string | null,
): { avatar: AvatarConfig; characterId: string } {
  const currentAvatar = resolveAvatar(profile);
  const currentCosmetics: AvatarCosmetics = currentAvatar.cosmetics ? { ...currentAvatar.cosmetics } : {};

  if (category === 'character') {
    const nextCharId = itemIdOrKey ? normalizeCharacterId(itemIdOrKey) : FREE_CHARACTER_IDS[0] ?? 'lia';
    const preset = avatarFromCharacter(nextCharId);
    const hasCosmetics = Object.values(currentCosmetics).some((v) => typeof v === 'string' && v.length > 0);
    return {
      characterId: nextCharId,
      avatar: hasCosmetics ? { ...preset, cosmetics: currentCosmetics } : preset,
    };
  }

  if (itemIdOrKey === null || itemIdOrKey.trim().length === 0) {
    delete currentCosmetics[category];
  } else {
    const normalized = normalizeCosmeticKey(category, itemIdOrKey);
    if (normalized) {
      currentCosmetics[category] = normalized;
    }
  }

  const cleanedCosmetics: AvatarCosmetics = {};
  for (const slot of COSMETIC_SLOTS) {
    const val = currentCosmetics[slot];
    if (typeof val === 'string' && val.trim().length > 0) {
      cleanedCosmetics[slot] = val.trim();
    }
  }

  const nextAvatar: AvatarConfig =
    Object.keys(cleanedCosmetics).length > 0
      ? { ...currentAvatar, cosmetics: cleanedCosmetics }
      : { hair: currentAvatar.hair, colors: currentAvatar.colors };

  return {
    characterId: profile.characterId,
    avatar: nextAvatar,
  };
}

export function isCosmeticEquipped(
  profile: Pick<Profile, 'characterId' | 'avatar'> | null,
  item: Pick<StoreItem, 'id' | 'category' | 'metadata'>,
): boolean {
  if (!profile) return false;
  if (item.category === 'character') {
    const targetChar = item.metadata.characterId ?? item.metadata.cosmeticKey ?? normalizeCharacterId(item.id);
    return profile.characterId === targetChar;
  }
  if (!isCosmeticSlotKey(item.category)) return false;
  const equippedRaw = profile.avatar?.cosmetics?.[item.category];
  if (!equippedRaw) return false;
  const equippedNorm = normalizeCosmeticKey(item.category, equippedRaw);
  const itemKey = item.metadata.cosmeticKey ?? item.id;
  const itemNorm = normalizeCosmeticKey(item.category, itemKey);
  return equippedNorm !== undefined && (equippedNorm === itemNorm || equippedNorm === normalizeCosmeticKey(item.category, item.id));
}

interface StoreErrorLike {
  message?: unknown;
  code?: unknown;
  details?: unknown;
  hint?: unknown;
}

export function mapStoreError(err: unknown): string {
  const obj = (typeof err === 'object' && err !== null ? err : null) as StoreErrorLike | null;
  const rawMsg =
    typeof err === 'string'
      ? err
      : typeof obj?.message === 'string'
        ? obj.message
        : err instanceof Error
          ? err.message
          : '';
  const code = typeof obj?.code === 'string' ? obj.code.trim() : '';
  const m = rawMsg.toLowerCase();

  if (
    m.includes('network request failed') ||
    m.includes('failed to fetch') ||
    m.includes('fetch failed') ||
    m.includes('networkerror') ||
    m.includes('econnrefused')
  ) {
    return 'Sem conexão com o servidor. Confira sua internet.';
  }
  if (
    code === '42501' ||
    m.includes('não autenticado') ||
    m.includes('nao autenticado') ||
    m.includes('not authenticated') ||
    m.includes('jwt')
  ) {
    return 'Entre na sua conta para comprar itens e ativar boosters.';
  }
  if (m.includes('saldo insuficiente')) {
    return 'Saldo insuficiente para comprar este item.';
  }
  if (m.includes('limite máximo de inventário') || m.includes('limite maximo de inventario')) {
    return rawMsg.trim() || 'Limite máximo de inventário atingido para este item.';
  }
  if (m.includes('cosméticos só podem ser comprados') || m.includes('cosmeticos so podem ser comprados')) {
    return 'Cosméticos só podem ser comprados 1 por vez.';
  }
  if (m.includes('item não encontrado') || m.includes('item nao encontrado') || m.includes('indisponível')) {
    return 'Item não encontrado ou indisponível.';
  }
  if (m.includes('quantidade inválida') || m.includes('quantidade invalida')) {
    return 'Quantidade inválida.';
  }
  if (m.includes('perfil não encontrado') || m.includes('perfil nao encontrado')) {
    return 'Perfil não encontrado. Tente sincronizar sua conta.';
  }
  if (
    rawMsg &&
    /^(Sem conexão|Entre na sua conta|Saldo insuficiente|Você já|Você não possui|Todas as unidades|Este booster|Item não encontrado|Quantidade inválida|Cosméticos só|Limite máximo)/.test(
      rawMsg.trim(),
    )
  ) {
    return rawMsg.trim();
  }
  const authMapped = mapAuthError(err);
  if (authMapped !== 'Não foi possível concluir a operação. Tente novamente.') {
    return authMapped;
  }
  return 'Não foi possível concluir a operação da loja. Tente novamente.';
}

export async function fetchStoreCatalogWithClient(client: SupabaseClient): Promise<StoreItem[]> {
  const { data, error } = await client
    .from('store_items')
    .select('id, kind, category, name, description, price_coins, rarity, max_stack, metadata, sort_order')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });

  if (error) throw error;
  if (!Array.isArray(data)) return [];
  return data.map((row) => parseStoreItem(row as Record<string, unknown>));
}

export async function fetchUserInventoryWithClient(
  client: SupabaseClient,
  userId: string,
  nowMs = Date.now(),
): Promise<UserInventorySnapshot> {
  const [invRes, usageRes, profRes] = await Promise.all([
    client
      .from('user_inventory')
      .select('item_id, quantity, first_purchased_at, updated_at')
      .eq('user_id', userId)
      .gt('quantity', 0),
    client
      .from('user_boost_usages')
      .select('id, item_id, activity_id, activated_at, expires_at, consumed_at')
      .eq('user_id', userId)
      .is('consumed_at', null),
    client
      .from('profiles')
      .select('wallet')
      .eq('id', userId)
      .single(),
  ]);

  if (invRes.error) throw invRes.error;
  if (usageRes.error) throw usageRes.error;
  if (profRes.error) throw profRes.error;

  const inventory = (invRes.data ?? []).map((r) => parseInventoryEntry(r as Record<string, unknown>));
  const activeUsages = (usageRes.data ?? [])
    .map((r) => parseBoostUsage(r as Record<string, unknown>))
    .filter((u) => u.consumedAt === null && (u.expiresAt === null || u.expiresAt > nowMs));
  const wallet = Math.max(0, Math.round(Number((profRes.data as { wallet?: unknown })?.wallet ?? 0)));

  return { inventory, activeUsages, wallet };
}

export async function purchaseStoreItemWithClient(
  client: SupabaseClient,
  itemId: string,
  quantity = 1,
): Promise<PurchaseResult> {
  const cleanId = itemId.trim();
  const safeQty = Math.round(quantity);
  if (!cleanId) {
    throw new Error('Item não encontrado ou indisponível.');
  }
  if (!Number.isFinite(safeQty) || safeQty < 1 || safeQty > 99) {
    throw new Error('Quantidade inválida.');
  }

  const { data, error } = await client.rpc('purchase_store_item', {
    p_item_id: cleanId,
    p_quantity: safeQty,
  });

  if (error) throw error;
  const raw = (data ?? {}) as {
    item_id?: unknown;
    quantity?: unknown;
    total_paid?: unknown;
    wallet?: unknown;
  };
  return {
    itemId: String(raw.item_id ?? cleanId),
    quantity: Math.round(Number(raw.quantity ?? safeQty)),
    totalPaid: Math.max(0, Math.round(Number(raw.total_paid ?? 0))),
    wallet: Math.max(0, Math.round(Number(raw.wallet ?? 0))),
  };
}

export async function activateOnlineBoosterWithClient(
  client: SupabaseClient,
  userId: string,
  item: StoreItem,
  opts?: { activityId?: string | null; nowMs?: number; catalog?: readonly StoreItem[] },
): Promise<BoostUsageRecord> {
  if (item.kind !== 'consumable' || !isBoosterCategory(item.category)) {
    throw new Error('Este item não é um booster ativável.');
  }

  const nowMs = opts?.nowMs ?? Date.now();

  const [invRes, usageRes] = await Promise.all([
    client
      .from('user_inventory')
      .select('item_id, quantity')
      .eq('user_id', userId)
      .eq('item_id', item.id)
      .maybeSingle(),
    client
      .from('user_boost_usages')
      .select('id, item_id, activity_id, activated_at, expires_at, consumed_at')
      .eq('user_id', userId)
      .is('consumed_at', null),
  ]);

  if (invRes.error) throw invRes.error;
  if (usageRes.error) throw usageRes.error;

  const qty = Math.max(0, Math.round(Number((invRes.data as { quantity?: unknown } | null)?.quantity ?? 0)));
  if (qty <= 0) {
    throw new Error('Você não possui unidades deste booster na mochila.');
  }

  const activeUsages = (usageRes.data ?? [])
    .map((r) => parseBoostUsage(r as Record<string, unknown>))
    .filter((u) => u.consumedAt === null && (u.expiresAt === null || u.expiresAt > nowMs));

  const sameItemActiveCount = activeUsages.filter((u) => u.itemId === item.id).length;
  if (sameItemActiveCount >= qty) {
    throw new Error('Todas as unidades deste booster já estão ativas.');
  }

  if (activeUsages.length > 0) {
    let categoryByItemId: Map<string, StoreCategory>;
    if (opts?.catalog) {
      categoryByItemId = new Map(opts.catalog.map((c) => [c.id, c.category]));
    } else {
      const ids = [...new Set(activeUsages.map((u) => u.itemId))];
      const { data: itemRows, error: catErr } = await client
        .from('store_items')
        .select('id, category')
        .in('id', ids);
      if (catErr) throw catErr;
      categoryByItemId = new Map(
        (itemRows ?? []).map((r) => [String(r.id), String(r.category) as StoreCategory]),
      );
    }

    if (activeUsages.some((u) => categoryByItemId.get(u.itemId) === item.category)) {
      throw new Error('Você já tem um booster ativo desta categoria.');
    }
  }

  const durationS = boosterDurationS(item);
  const usageId = `bst_${nowMs.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const activatedAtIso = new Date(nowMs).toISOString();
  const expiresAtIso = new Date(nowMs + durationS * 1000).toISOString();

  const { data: inserted, error: insErr } = await client
    .from('user_boost_usages')
    .insert({
      id: usageId,
      user_id: userId,
      item_id: item.id,
      activity_id: opts?.activityId ?? null,
      activated_at: activatedAtIso,
      expires_at: expiresAtIso,
      consumed_at: null,
    })
    .select('id, item_id, activity_id, activated_at, expires_at, consumed_at')
    .single();

  if (insErr) throw insErr;
  return parseBoostUsage(inserted as Record<string, unknown>);
}
