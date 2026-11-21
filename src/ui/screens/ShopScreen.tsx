// Tela da Loja online: catálogo de cosméticos/boosters, mochila, prévia do avatar e ativação de boosters.
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { sfx } from '../../game/audio.ts';
import { useGame } from '../../game/store.ts';
import type { ActiveBooster, Modality } from '../../game/types.ts';
import {
  activateOnlineBooster,
  applyCosmeticToProfile,
  boosterDurationS,
  boosterMultiplier,
  equipCosmetic,
  fetchStoreCatalog,
  fetchUserInventory,
  isBoosterCategory,
  isCosmeticEquipped,
  mapStoreError,
  purchaseStoreItem,
  type BoostUsageRecord,
  type CosmeticCategory,
  type InventoryEntry,
  type StoreItem,
} from '../../services/storeService.ts';
import { isSupabaseConfigured } from '../../services/supabase.ts';
import { avatarFromCharacter, resolveAvatar } from '../../sprites/avatar.ts';
import type { Facing } from '../../sprites/characters.ts';
import type { IconName } from '../../sprites/icons.ts';
import { RARITY_INFO } from '../../sprites/items.ts';
import { useNow } from '../components/Hud.tsx';
import { Arcade, Chip, Muted, PxBox, PxButton, PxCell, PxOutline, RarityTag, Txt } from '../components/Px.tsx';
import { CharacterSprite, CoinImg, Icon } from '../components/Sprites.tsx';
import { C, FILL, useSafe } from '../theme.ts';

type FilterTab = 'all' | 'character' | 'accessories' | 'gear' | 'style' | 'boosters';

const FILTER_TABS: readonly { id: FilterTab; label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'character', label: 'Personagens' },
  { id: 'accessories', label: 'Chapéu & Óculos' },
  { id: 'gear', label: 'Bike & Tênis' },
  { id: 'style', label: 'Pets & Cores' },
  { id: 'boosters', label: 'Boosters' },
];

const FACINGS: readonly Facing[] = ['down', 'right', 'up', 'left'];

const SLOT_LABELS: Record<string, string> = {
  hat: 'Chapéu',
  glasses: 'Óculos',
  bike: 'Bike',
  shoe: 'Tênis',
  pet: 'Pet',
  color: 'Paleta',
};

function matchesFilter(item: StoreItem, filter: FilterTab): boolean {
  if (filter === 'all') return true;
  if (filter === 'character') return item.category === 'character';
  if (filter === 'accessories') return item.category === 'hat' || item.category === 'glasses';
  if (filter === 'gear') return item.category === 'bike' || item.category === 'shoe';
  if (filter === 'style') return item.category === 'pet' || item.category === 'color';
  return item.kind === 'consumable';
}

function formatCountdown(expiresAt: number, now: number): string {
  const remS = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const min = Math.floor(remS / 60);
  const sec = remS % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function BoosterCountdown({ expiresAt }: { expiresAt: number }) {
  const now = useNow(1000);
  return (
    <Arcade size={10} spacing={0} color={C.mint}>
      {formatCountdown(expiresAt, now)}
    </Arcade>
  );
}

function boosterBadge(item: StoreItem): { icon: IconName; label: string; color: string } {
  const mult = boosterMultiplier(item);
  const mins = Math.round(boosterDurationS(item) / 60);
  if (item.category === 'boost_fog') {
    return { icon: 'target', label: `+${Math.round((mult - 1) * 100)}% névoa · ${mins} min`, color: C.sky };
  }
  if (item.category === 'boost_coins') {
    return { icon: 'star', label: `${mult}x moedas · ${mins} min`, color: C.gold };
  }
  return { icon: 'bolt', label: `${mult}x XP · ${mins} min`, color: C.mint };
}

function ItemPreview({
  item,
  baseProfile,
}: {
  item: StoreItem;
  baseProfile: { characterId: string; avatar?: ReturnType<typeof resolveAvatar>; modality: Modality };
}) {
  if (item.kind === 'consumable') {
    const info = boosterBadge(item);
    return (
      <View style={styles.boosterThumb}>
        <Icon name={info.icon} size={30} color={info.color} accent={C.cream} />
      </View>
    );
  }

  if (item.category === 'character') {
    const charId = item.metadata.characterId ?? item.metadata.cosmeticKey ?? item.id.replace(/^char_/, '');
    return (
      <View style={styles.charThumb}>
        <CharacterSprite
          avatar={avatarFromCharacter(charId)}
          modality={baseProfile.modality}
          animate={false}
          width={48}
        />
      </View>
    );
  }

  const slot = item.category as CosmeticCategory;
  const preview = applyCosmeticToProfile(baseProfile, slot, item.metadata.cosmeticKey ?? item.id);
  const previewModality: Modality =
    item.category === 'bike' ? 'bike' : item.category === 'shoe' ? 'run' : baseProfile.modality;

  return (
    <View style={styles.charThumb}>
      <CharacterSprite
        avatar={preview.avatar}
        modality={previewModality}
        facing={item.category === 'bike' ? 'right' : 'down'}
        animate={false}
        width={48}
      />
    </View>
  );
}

export function ShopScreen() {
  const authUserId = useGame((s) => s.authUserId);
  const profile = useGame((s) => s.profile);
  const wallet = useGame((s) => s.wallet);
  const activeBoosters = useGame((s) => s.activeBoosters);
  const pushModal = useGame((s) => s.pushModal);
  const toast = useGame((s) => s.toast);
  const { safeT, tabbarH } = useSafe();

  const [catalog, setCatalog] = useState<StoreItem[]>([]);
  const [inventory, setInventory] = useState<InventoryEntry[]>([]);
  const [activeUsages, setActiveUsages] = useState<BoostUsageRecord[]>([]);
  const [loading, setLoading] = useState(() => isSupabaseConfigured());
  const [error, setError] = useState<string | null>(() =>
    isSupabaseConfigured() ? null : 'Configure o Supabase para acessar a loja online.',
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [facingIdx, setFacingIdx] = useState(0);
  const [previewModality, setPreviewModality] = useState<Modality | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (activeBoosters.length === 0) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [activeBoosters.length]);

  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    let cancelled = false;
    void Promise.resolve()
      .then(async () => {
        if (cancelled) return;
        setLoading(true);
        setError(null);
        const items = await fetchStoreCatalog();
        if (cancelled) return;
        setCatalog(items);
        if (authUserId) {
          const snap = await fetchUserInventory(items);
          if (cancelled) return;
          setInventory(snap.inventory);
          setActiveUsages(snap.activeUsages);
        } else {
          setInventory([]);
          setActiveUsages([]);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(mapStoreError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authUserId, reloadTick]);

  const handleRetryLoad = () => {
    if (!isSupabaseConfigured()) {
      setError('Configure o Supabase para acessar a loja online.');
      return;
    }
    sfx.click();
    setLoading(true);
    setError(null);
    setReloadTick((t) => t + 1);
  };

  const qtyByItem = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of inventory) map.set(e.itemId, e.quantity);
    return map;
  }, [inventory]);

  const activeByCategory = useMemo(() => {
    const map = new Map<string, ActiveBooster>();
    for (const b of activeBoosters) {
      if (b.expiresAt > nowMs) map.set(b.category, b);
    }
    return map;
  }, [activeBoosters, nowMs]);

  const activeUsageCountByItem = useMemo(() => {
    const map = new Map<string, number>();
    for (const u of activeUsages) {
      map.set(u.itemId, (map.get(u.itemId) ?? 0) + 1);
    }
    return map;
  }, [activeUsages]);

  const boosterItemsInBag = useMemo(() => {
    const out: { item: StoreItem; qty: number; active: ActiveBooster | undefined }[] = [];
    for (const item of catalog) {
      if (item.kind !== 'consumable' || !isBoosterCategory(item.category)) continue;
      const qty = qtyByItem.get(item.id) ?? 0;
      const active = activeByCategory.get(item.category);
      const isThisActive = active?.itemId === item.id;
      if (qty > 0 || isThisActive) {
        out.push({ item, qty, active: isThisActive ? active : undefined });
      }
    }
    return out;
  }, [catalog, qtyByItem, activeByCategory]);

  const filteredCatalog = useMemo(
    () => catalog.filter((item) => matchesFilter(item, filter)),
    [catalog, filter],
  );

  const handleBuy = async (item: StoreItem) => {
    if (!authUserId) {
      pushModal({ type: 'auth' });
      return;
    }
    sfx.click();
    setBusyId(item.id);
    setError(null);
    try {
      const { snapshot } = await purchaseStoreItem(item.id, 1, catalog);
      setInventory(snapshot.inventory);
      setActiveUsages(snapshot.activeUsages);
      sfx.coinBig();
      toast(`${item.name} comprado!`, 'info');
    } catch (err) {
      const msg = mapStoreError(err);
      setError(msg);
      toast(msg, 'warn');
    } finally {
      setBusyId(null);
    }
  };

  const handleEquip = async (item: StoreItem, equip: boolean) => {
    sfx.click();
    setBusyId(item.id);
    setError(null);
    try {
      const slot = item.category as CosmeticCategory;
      const value = equip ? (item.metadata.cosmeticKey ?? item.id) : null;
      await equipCosmetic(slot, value);
      toast(equip ? `${item.name} equipado!` : `${item.name} removido.`, 'info');
    } catch (err) {
      const msg = mapStoreError(err);
      setError(msg);
      toast(msg, 'warn');
    } finally {
      setBusyId(null);
    }
  };

  const handleActivateBooster = async (item: StoreItem) => {
    if (!authUserId) {
      pushModal({ type: 'auth' });
      return;
    }
    sfx.click();
    setBusyId(item.id);
    setError(null);
    try {
      const activated = await activateOnlineBooster(item, catalog);
      const snap = await fetchUserInventory(catalog);
      setInventory(snap.inventory);
      setActiveUsages(snap.activeUsages);
      toast(`${activated.name} ativado!`, 'xp');
    } catch (err) {
      const msg = mapStoreError(err);
      setError(msg);
      toast(msg, 'warn');
    } finally {
      setBusyId(null);
    }
  };

  const baseProfile = useMemo(
    () =>
      profile
        ? { characterId: profile.characterId, avatar: resolveAvatar(profile), modality: profile.modality }
        : { characterId: 'lia', avatar: avatarFromCharacter('lia'), modality: 'bike' as Modality },
    [profile],
  );

  const stageModality = previewModality ?? baseProfile.modality;
  const stageFacing = FACINGS[facingIdx];
  const equippedSlots = useMemo(() => {
    const cos = profile?.avatar?.cosmetics;
    if (!cos) return [];
    return Object.entries(cos).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0);
  }, [profile]);

  return (
    <View style={styles.root}>
      <LinearGradient colors={['#1e1831', C.ink]} style={FILL} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingTop: 18 + safeT, paddingBottom: tabbarH + 24 }]}
      >
        <View style={styles.inner}>
          <View style={styles.header}>
            <View>
              <Arcade size={18} weight={700} shadow={{ y: 3 }}>
                LOJA
              </Arcade>
              <Muted size={13}>Cosméticos em pixel art e boosters online</Muted>
            </View>
            <PxBox style={styles.walletPill} testID="shop-wallet">
              <CoinImg size={20} />
              <Arcade size={13} spacing={0} color={C.gold}>
                {wallet.toLocaleString('pt-BR')}
              </Arcade>
            </PxBox>
          </View>

          {profile && (
            <PxBox style={styles.previewCard}>
              <View style={styles.previewRow}>
                <PxButton
                  size="round"
                  onPress={() => {
                    sfx.click();
                    setFacingIdx((i) => (i + FACINGS.length - 1) % FACINGS.length);
                  }}
                  label="Girar à esquerda"
                >
                  <Icon name="back" size={16} />
                </PxButton>
                <View style={styles.previewStage}>
                  <CharacterSprite
                    avatar={resolveAvatar(profile)}
                    modality={stageModality}
                    facing={stageFacing}
                    width={72}
                  />
                </View>
                <PxButton
                  size="round"
                  onPress={() => {
                    sfx.click();
                    setFacingIdx((i) => (i + 1) % FACINGS.length);
                  }}
                  label="Girar à direita"
                >
                  <Icon name="back" size={16} style={styles.flip} />
                </PxButton>
              </View>
              <View style={styles.previewMeta}>
                <Txt weight={700} size={15}>
                  {profile.name}
                </Txt>
                <View style={styles.modeToggle}>
                  <Pressable
                    onPress={() => {
                      sfx.click();
                      setPreviewModality('bike');
                    }}
                    style={[styles.modeBtn, stageModality === 'bike' && styles.modeBtnActive]}
                  >
                    <Icon name="bike" size={13} color={stageModality === 'bike' ? C.ink : C.cream} />
                    <Txt size={12} weight={700} color={stageModality === 'bike' ? C.ink : C.cream}>
                      Bike
                    </Txt>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      sfx.click();
                      setPreviewModality('run');
                    }}
                    style={[styles.modeBtn, stageModality === 'run' && styles.modeBtnRun]}
                  >
                    <Icon name="run" size={13} color={C.cream} />
                    <Txt size={12} weight={700} color={C.cream}>
                      Corrida
                    </Txt>
                  </Pressable>
                </View>
              </View>
              {equippedSlots.length > 0 ? (
                <View style={styles.equippedChips}>
                  {equippedSlots.map(([slot]) => (
                    <Chip key={slot} color={C.gold}>
                      {SLOT_LABELS[slot] ?? slot}
                    </Chip>
                  ))}
                </View>
              ) : (
                <Muted size={12}>Nenhum cosmético extra equipado ainda.</Muted>
              )}
            </PxBox>
          )}

          {error && (
            <PxBox bg={C.panel2} outline={C.coral} style={styles.errorCard} testID="store-offline-error">
              <View style={styles.errorHead}>
                <Icon name="bolt" size={18} color={C.coral} accent={C.gold} />
                <Txt weight={700} size={14} color={C.cream} style={styles.shrink}>
                  {error}
                </Txt>
              </View>
              <PxButton size="small" variant="coral" onPress={handleRetryLoad}>
                Tentar novamente
              </PxButton>
            </PxBox>
          )}

          {!authUserId && (
            <PxBox style={styles.guestCard}>
              <View style={styles.guestTop}>
                <Icon name="shop" size={30} color={C.gold} accent={C.cream} />
                <View style={styles.rowBody}>
                  <Arcade size={12} spacing={0} color={C.gold}>
                    MODO CONVIDADO
                  </Arcade>
                  <Txt size={14} color={C.muted}>
                    Entre com e-mail e senha para comprar itens com suas moedas, equipar cosméticos e ativar boosters online.
                  </Txt>
                </View>
              </View>
              {isSupabaseConfigured() ? (
                <PxButton
                  variant="gold"
                  block
                  onPress={() => {
                    sfx.click();
                    pushModal({ type: 'auth' });
                  }}
                  testID="auth-open-btn"
                >
                  Entrar / Criar conta
                </PxButton>
              ) : (
                <Muted size={13}>Configure o Supabase para habilitar a loja online.</Muted>
              )}
            </PxBox>
          )}

          {authUserId && (
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Icon name="bolt" size={18} color={C.mint} accent={C.gold} />
                <Arcade size={12} weight={700} spacing={0.04}>
                  MOCHILA · BOOSTERS
                </Arcade>
              </View>
              {boosterItemsInBag.length === 0 ? (
                <PxBox style={styles.emptyCard}>
                  <Muted size={13}>
                    Você ainda não tem boosters na mochila. Compre abaixo para usar nas próximas atividades ao vivo!
                  </Muted>
                </PxBox>
              ) : (
                <View style={styles.list}>
                  {boosterItemsInBag.map(({ item, qty, active }) => {
                    const info = boosterBadge(item);
                    const catActive = activeByCategory.get(item.category);
                    const activeItemCount = activeUsageCountByItem.get(item.id) ?? 0;
                    const availableToActivate = Math.max(0, qty - activeItemCount);
                    const canActivate =
                      availableToActivate > 0 && !catActive && busyId === null;
                    return (
                      <PxCell
                        key={item.id}
                        selected={Boolean(active)}
                        style={styles.boosterCard}
                        testID={`inventory-booster-${item.id}`}
                      >
                        <View style={styles.itemRow}>
                          <ItemPreview item={item} baseProfile={baseProfile} />
                          <View style={styles.rowBody}>
                            <View style={styles.titleLine}>
                              <Txt weight={700} size={15} style={styles.shrink}>
                                {item.name}
                              </Txt>
                              <Chip color={C.gold}>{`x${qty}`}</Chip>
                            </View>
                            <Txt size={12} color={info.color}>
                              {info.label}
                            </Txt>
                            {active ? (
                              <View style={styles.activeRow}>
                                <Txt size={12} weight={700} color={C.mint}>
                                  Ativo agora ·
                                </Txt>
                                <BoosterCountdown expiresAt={active.expiresAt} />
                              </View>
                            ) : catActive ? (
                              <Muted size={12}>Já existe um booster ativo nesta categoria.</Muted>
                            ) : (
                              <Muted size={12}>Ative online antes ou durante uma atividade.</Muted>
                            )}
                          </View>
                          <PxButton
                            size="small"
                            variant={active ? 'default' : 'mint'}
                            disabled={!canActivate}
                            onPress={() => void handleActivateBooster(item)}
                            testID="booster-activate-btn"
                          >
                            {busyId === item.id ? 'Ativando…' : active ? 'Ativo' : 'Ativar'}
                          </PxButton>
                        </View>
                      </PxCell>
                    );
                  })}
                </View>
              )}
            </View>
          )}

          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Icon name="shop" size={18} color={C.gold} accent={C.cream} />
              <Arcade size={12} weight={700} spacing={0.04}>
                CATÁLOGO
              </Arcade>
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.filterScroll}
            >
              {FILTER_TABS.map((t) => {
                const selected = filter === t.id;
                return (
                  <Pressable
                    key={t.id}
                    onPress={() => {
                      sfx.click();
                      setFilter(t.id);
                    }}
                    style={[styles.filterChip, selected && styles.filterChipActive]}
                    accessibilityRole="tab"
                    accessibilityState={{ selected }}
                  >
                    <PxOutline w={2} color={selected ? C.gold : C.ink} />
                    <Txt size={13} weight={700} color={selected ? C.ink : C.cream}>
                      {t.label}
                    </Txt>
                  </Pressable>
                );
              })}
            </ScrollView>

            {loading && catalog.length === 0 ? (
              <PxBox style={styles.emptyCard}>
                <Muted size={13}>Carregando catálogo da loja…</Muted>
              </PxBox>
            ) : (
              <View style={styles.list}>
                {filteredCatalog.map((item) => {
                  const qty = qtyByItem.get(item.id) ?? 0;
                  const owned = item.kind === 'cosmetic' && qty >= 1;
                  const equipped = owned && isCosmeticEquipped(profile, item);
                  const rarity = RARITY_INFO[item.rarity];
                  const atMaxStack = item.maxStack !== null && qty >= item.maxStack;
                  const canAfford = wallet >= item.priceCoins;
                  const isBusy = busyId === item.id;
                  const canBuy = Boolean(authUserId) && !owned && !atMaxStack && canAfford && busyId === null;

                  return (
                    <PxCell
                      key={item.id}
                      selected={equipped}
                      style={styles.catalogCard}
                      testID={`shop-item-${item.id}`}
                    >
                      <View style={styles.itemRow}>
                        <ItemPreview item={item} baseProfile={baseProfile} />
                        <View style={styles.rowBody}>
                          <View style={styles.titleLine}>
                            <RarityTag color={rarity.color}>{rarity.label}</RarityTag>
                            {equipped && <Chip color={C.gold}>Equipado</Chip>}
                            {!equipped && owned && <Chip color={C.mint}>Na mochila</Chip>}
                            {item.kind === 'consumable' && qty > 0 && (
                              <Chip color={C.sky}>{`x${qty}${item.maxStack ? `/${item.maxStack}` : ''}`}</Chip>
                            )}
                          </View>
                          <Txt weight={700} size={16}>
                            {item.name}
                          </Txt>
                          <Muted size={13}>{item.description}</Muted>
                          <View style={styles.priceRow}>
                            <CoinImg size={16} />
                            <Arcade size={11} spacing={0} color={canAfford || owned ? C.gold : C.coral}>
                              {item.priceCoins.toLocaleString('pt-BR')}
                            </Arcade>
                          </View>
                        </View>
                      </View>

                      <View style={styles.cardActions}>
                        {owned ? (
                          item.category === 'character' ? (
                            <PxButton
                              size="small"
                              variant={equipped ? 'default' : 'mint'}
                              block
                              disabled={equipped || busyId !== null}
                              onPress={() => void handleEquip(item, true)}
                            >
                              {equipped ? 'Em uso' : isBusy ? 'Aplicando…' : 'Usar personagem'}
                            </PxButton>
                          ) : (
                            <PxButton
                              size="small"
                              variant={equipped ? 'coral' : 'mint'}
                              block
                              disabled={busyId !== null}
                              onPress={() => void handleEquip(item, !equipped)}
                            >
                              {isBusy ? 'Atualizando…' : equipped ? 'Remover' : 'Equipar'}
                            </PxButton>
                          )
                        ) : (
                          <PxButton
                            size="small"
                            variant={canBuy ? 'gold' : 'default'}
                            block
                            disabled={!canBuy}
                            onPress={() => void handleBuy(item)}
                            testID="shop-buy-btn"
                          >
                            {isBusy
                              ? 'Comprando…'
                              : atMaxStack
                                ? 'Limite atingido'
                                : !authUserId
                                  ? 'Entre para comprar'
                                  : !canAfford
                                    ? 'Moedas insuficientes'
                                    : 'Comprar'}
                          </PxButton>
                        )}
                      </View>
                    </PxCell>
                  );
                })}
              </View>
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { ...FILL },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 16, alignItems: 'center' },
  inner: { width: '100%', maxWidth: 560, gap: 18 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  walletPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  previewCard: {
    padding: 14,
    gap: 10,
    alignItems: 'center',
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
  },
  previewStage: {
    width: 92,
    height: 98,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.panel2,
    borderWidth: 2,
    borderColor: C.ink,
  },
  flip: { transform: [{ scaleX: -1 }] },
  previewMeta: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  modeToggle: {
    flexDirection: 'row',
    gap: 6,
  },
  modeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
    backgroundColor: C.panel3,
    borderWidth: 2,
    borderColor: C.ink,
  },
  modeBtnActive: { backgroundColor: C.mint },
  modeBtnRun: { backgroundColor: C.coral },
  equippedChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    width: '100%',
  },
  errorCard: {
    padding: 12,
    gap: 10,
  },
  errorHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  guestCard: {
    padding: 14,
    gap: 12,
  },
  guestTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  section: {
    gap: 10,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  emptyCard: {
    padding: 14,
  },
  filterScroll: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  filterChip: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: C.panel2,
  },
  filterChipActive: {
    backgroundColor: C.gold,
  },
  list: {
    gap: 10,
  },
  boosterCard: {
    padding: 12,
  },
  catalogCard: {
    padding: 12,
    gap: 10,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  charThumb: {
    width: 60,
    height: 70,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.panel3,
    borderWidth: 2,
    borderColor: C.ink,
    flexShrink: 0,
  },
  boosterThumb: {
    width: 60,
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.panel3,
    borderWidth: 2,
    borderColor: C.ink,
    flexShrink: 0,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  activeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  cardActions: {
    width: '100%',
  },
  shrink: { flexShrink: 1 },
});
