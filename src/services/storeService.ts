// Serviço online da Loja, Inventário, Cosméticos e Boosters (integrado ao Supabase e Zustand).
import { useGame } from '../game/store.ts';
import type { ActiveBooster } from '../game/types.ts';
import { getSupabaseUser, requireSupabase } from './supabase.ts';
import { syncProfile } from './sync.ts';
import {
  activateOnlineBoosterWithClient,
  applyCosmeticToProfile,
  extractUnlockedCharacterIds,
  fetchStoreCatalogWithClient,
  fetchUserInventoryWithClient,
  mapStoreError,
  purchaseStoreItemWithClient,
  toActiveBooster,
  type BoostUsageRecord,
  type CosmeticCategory,
  type InventoryEntry,
  type PurchaseResult,
  type StoreItem,
} from './storeServiceCore.ts';

export {
  applyCosmeticToProfile,
  boosterDurationS,
  boosterMultiplier,
  extractUnlockedCharacterIds,
  isBoosterCategory,
  isCosmeticEquipped,
  mapStoreError,
  toActiveBooster,
  type BoostUsageRecord,
  type CosmeticCategory,
  type InventoryEntry,
  type PurchaseResult,
  type StoreCategory,
  type StoreItem,
  type StoreItemKind,
  type StoreItemMetadata,
  type UserInventorySnapshot,
} from './storeServiceCore.ts';

export interface StoreInventoryState {
  inventory: InventoryEntry[];
  activeUsages: BoostUsageRecord[];
  activeBoosters: ActiveBooster[];
  wallet: number;
}

export async function fetchStoreCatalog(): Promise<StoreItem[]> {
  try {
    const client = requireSupabase();
    return await fetchStoreCatalogWithClient(client);
  } catch (err) {
    throw new Error(mapStoreError(err));
  }
}

export async function fetchUserInventory(catalog?: StoreItem[]): Promise<StoreInventoryState> {
  try {
    const client = requireSupabase();
    const user = await getSupabaseUser();
    if (!user) {
      throw new Error('Entre na sua conta para comprar itens e ativar boosters.');
    }

    const items = catalog ?? (await fetchStoreCatalogWithClient(client));
    const snapshot = await fetchUserInventoryWithClient(client, user.id);
    const itemById = new Map(items.map((i) => [i.id, i]));
    const now = Date.now();
    const activeBoosters: ActiveBooster[] = [];
    const seenCats = new Set<string>();
    for (const usage of snapshot.activeUsages) {
      const item = itemById.get(usage.itemId);
      if (!item) continue;
      const ab = toActiveBooster(usage, item, now);
      if (!ab || seenCats.has(ab.category)) continue;
      seenCats.add(ab.category);
      activeBoosters.push(ab);
    }

    const store = useGame.getState();
    store.setWallet(snapshot.wallet);
    store.grantUnlocked(extractUnlockedCharacterIds(snapshot.inventory, items));
    store.setActiveBoosters(activeBoosters);

    return {
      inventory: snapshot.inventory,
      activeUsages: snapshot.activeUsages,
      activeBoosters,
      wallet: snapshot.wallet,
    };
  } catch (err) {
    throw new Error(mapStoreError(err));
  }
}

export async function purchaseStoreItem(
  itemId: string,
  quantity = 1,
  catalog?: StoreItem[],
): Promise<{ result: PurchaseResult; snapshot: StoreInventoryState }> {
  try {
    const client = requireSupabase();
    const user = await getSupabaseUser();
    if (!user) {
      throw new Error('Entre na sua conta para comprar itens e ativar boosters.');
    }

    const result = await purchaseStoreItemWithClient(client, itemId, quantity);
    useGame.getState().setWallet(result.wallet);
    const snapshot = await fetchUserInventory(catalog);
    return { result, snapshot };
  } catch (err) {
    throw new Error(mapStoreError(err));
  }
}

export async function activateOnlineBooster(
  itemOrId: StoreItem | string,
  catalog?: StoreItem[],
): Promise<ActiveBooster> {
  try {
    const client = requireSupabase();
    const user = await getSupabaseUser();
    if (!user) {
      throw new Error('Entre na sua conta para comprar itens e ativar boosters.');
    }

    const items = catalog ?? (await fetchStoreCatalogWithClient(client));
    const item = typeof itemOrId === 'string' ? items.find((i) => i.id === itemOrId) : itemOrId;
    if (!item) {
      throw new Error('Item não encontrado ou indisponível.');
    }

    const live = useGame.getState().live;
    const usage = await activateOnlineBoosterWithClient(client, user.id, item, {
      activityId: live?.id ?? null,
      catalog: items,
    });
    const active = toActiveBooster(usage, item);
    if (!active) {
      throw new Error('Não foi possível ativar o booster.');
    }
    useGame.getState().addActiveBooster(active);
    return active;
  } catch (err) {
    throw new Error(mapStoreError(err));
  }
}

export async function equipCosmetic(
  category: CosmeticCategory,
  itemId: string | null,
): Promise<void> {
  const s = useGame.getState();
  if (!s.profile) return;
  const { avatar, characterId } = applyCosmeticToProfile(s.profile, category, itemId);
  s.setAvatar(avatar, characterId);
  if (s.authUserId) {
    try {
      await syncProfile();
    } catch (err) {
      throw new Error(mapStoreError(err));
    }
  }
}
