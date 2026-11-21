// Estado global (zustand). Módulos fora do React usam useGame.getState()/setState().
import { create } from 'zustand';
import { CHARACTERS } from '../sprites/characters.ts';
import { COIN_VALUE, RARITY_INFO } from '../sprites/items.ts';
import { levelFromXp } from './progression.ts';
import { XP } from './config.ts';
import type {
  AchievementRecord, AchievementUnlockEvent, ActivitySummary, AvatarConfig, Capture, City, Coin, CoinsByKind,
  GpsStatus, LiveActivity, Modal, Modality, PendingMigration, PlannedRoute, PlayerFix, Poi, Profile, RouteProgress,
  Settings, Tab, Toast, Totals,
} from './types.ts';

export interface PersistedState {
  version: 1;
  profile: Profile | null;
  unlocked: string[];
  wallet: number;
  xp: number;
  totals: Totals;
  captures: Record<string, Capture>;
  cities: Record<string, City>;
  activities: ActivitySummary[];
  achievements: Record<string, AchievementRecord>;
  settings: Settings;
  coins: Coin[];
  live: LiveActivity | null;
  /** Rota planejada (salva junto: sobrevive ao app fechar no meio da atividade). */
  route: PlannedRoute | null;
  cloudUserId?: string;
  cloudSyncedAt?: number;
}

export interface VerifiedActivityReconciliation {
  activityId: string;
  verificationStatus: 'verified' | 'flagged';
  verificationReason?: string | null;
  distanceM?: number;
  movingS?: number;
  maxSpeed?: number;
  xpEarned?: number;
  coinsEarned?: number;
  newCells?: number;
  authoritative: {
    xp: number;
    level: number;
    wallet: number;
    totalDistanceM: number;
    totalMovingS: number;
    totalActivities: number;
    totalCells: number;
    totalCaptures: number;
    achievementsCount: number;
  };
}

interface RuntimeState {
  hydrated: boolean;
  tab: Tab;
  fix: PlayerFix | null;
  gps: GpsStatus;
  toasts: Toast[];
  modals: Modal[];
  speedWarning: boolean;
  /** Muda quando o registro de POIs muda (para listas "por perto"). */
  poiRev: number;
  /** Muda após ações sociais (convites, amizades, bloqueios) para atualizar listas e rankings. */
  socialRev: number;
  /** Cidade em que o jogador está agora. */
  currentCityId: string | null;
  /** POI tocado no mapa (cartão de detalhes). */
  selected: Poi | null;
  /** Folha "Nova atividade" aberta (modalidade, rota e INICIAR). */
  planning: boolean;
  /** Andamento na rota planejada durante a atividade (ver game/route.ts). */
  routeProgress: RouteProgress | null;
  /** Recálculo automático da rota (fora do trajeto): em andamento ou falhou na última tentativa. */
  rerouting: 'idle' | 'busy' | 'failed';
  /** Estado de sincronização online com o Supabase (não persistido em save:v1). */
  syncing: boolean;
  lastSyncError: string | null;
  lastSyncedAt: number | null;
  /** Estado de autenticação, convite por deep link e conflito de migração (não persistido em save:v1). */
  authUserId: string | null;
  authEmail: string | null;
  authLoading: boolean;
  pendingInviteUsername: string | null;
  pendingMigration: PendingMigration | null;
}

interface Actions {
  createProfile(
    name: string,
    avatar: AvatarConfig,
    modality: Modality,
    characterId?: string,
    opts?: { username?: string; isPublic?: boolean },
  ): void;
  setModality(m: Modality): void;
  setAvatar(avatar: AvatarConfig, characterId?: string): void;
  setCharacter(id: string): void;
  unlockCharacter(id: string): boolean;
  setTab(t: Tab): void;
  /** Abre/fecha a folha "Nova atividade" (abrir leva para a aba Mapa). */
  setPlanning(open: boolean): void;
  setRoute(route: PlannedRoute | null): void;
  setSetting<K extends keyof Settings>(k: K, v: Settings[K]): void;
  toast(text: string, kind?: Toast['kind'], coinKind?: Toast['coinKind']): void;
  dismissToast(id: number): void;
  pushModal(m: Modal): void;
  closeModal(): void;
  addXp(n: number): void;
  startActivity(): void;
  pauseActivity(): void;
  resumeActivity(): void;
  finishActivity(): ActivitySummary | null;
  discardActivity(): void;
  collectCoin(coin: Coin): void;
  capturePoi(poi: Poi, cityId: string | null): Capture | null;
  grantAchievements(unlocks: AchievementUnlockEvent[], opts?: { batchToast?: boolean }): number;
  setSyncState(patch: Partial<{ syncing: boolean; lastSyncError: string | null; lastSyncedAt: number | null }>): void;
  setAuthState(patch: Partial<{ authUserId: string | null; authEmail: string | null; authLoading: boolean }>): void;
  setPendingInviteUsername(username: string | null): void;
  setPendingMigration(migration: PendingMigration | null): void;
  bumpSocialRev(): void;
  updateProfileIdentity(patch: Partial<Pick<Profile, 'name' | 'username' | 'isPublic'>>): void;
  reconcileVerifiedActivity(payload: VerifiedActivityReconciliation): void;
  applyCloudSnapshot(snapshot: Partial<PersistedState>): void;
  resetProgress(): void;
  select(poi: Poi | null): void;
}

export type GameState = PersistedState & RuntimeState & Actions;

export const EMPTY_COINS_BY_KIND: CoinsByKind = {
  bronze: 0, silver: 0, gold: 0, gem: 0,
};

export const EMPTY_TOTALS: Totals = {
  distanceM: 0, movingS: 0, activities: 0, coinsValue: 0, coinsCount: 0, captures: 0, cells: 0,
};

export const DEFAULT_PERSISTED: PersistedState = {
  version: 1,
  profile: null,
  unlocked: CHARACTERS.filter((c) => c.price === 0).map((c) => c.id),
  wallet: 0,
  xp: 0,
  totals: EMPTY_TOTALS,
  captures: {},
  cities: {},
  activities: [],
  achievements: {},
  settings: { sound: true, haptics: true, simulator: false },
  coins: [],
  live: null,
  route: null,
};

let toastSeq = 1;

export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Tempo de cronômetro da atividade em segundos, considerando o trecho em andamento. */
export function liveElapsed(live: LiveActivity, now = Date.now()): number {
  return live.elapsedS + (live.resumedAt ? (now - live.resumedAt) / 1000 : 0);
}

export const useGame = create<GameState>()((set, get) => ({
  ...DEFAULT_PERSISTED,
  hydrated: false,
  tab: 'map',
  fix: null,
  gps: 'off',
  toasts: [],
  modals: [],
  speedWarning: false,
  poiRev: 0,
  socialRev: 0,
  currentCityId: null,
  selected: null,
  planning: false,
  routeProgress: null,
  rerouting: 'idle',
  syncing: false,
  lastSyncError: null,
  lastSyncedAt: null,
  authUserId: null,
  authEmail: null,
  authLoading: false,
  pendingInviteUsername: null,
  pendingMigration: null,

  createProfile(name, avatar, modality, characterId = 'custom', opts) {
    set({
      profile: {
        name: name.trim() || 'Viajante',
        characterId,
        avatar,
        modality,
        createdAt: Date.now(),
        ...(opts?.username ? { username: opts.username } : {}),
        ...(opts?.isPublic !== undefined ? { isPublic: opts.isPublic } : {}),
      },
      tab: 'map',
    });
  },
  setModality(m) {
    const p = get().profile;
    if (!p || get().live) return;
    set({ profile: { ...p, modality: m } });
  },
  setAvatar(avatar, characterId) {
    const p = get().profile;
    if (!p) return;
    set({ profile: { ...p, avatar, characterId: characterId ?? p.characterId } });
  },
  setCharacter(id) {
    const p = get().profile;
    if (!p || !get().unlocked.includes(id)) return;
    set({ profile: { ...p, characterId: id } });
  },
  unlockCharacter(id) {
    const def = CHARACTERS.find((c) => c.id === id);
    const s = get();
    if (!def || s.unlocked.includes(id) || s.wallet < def.price) return false;
    set({ wallet: s.wallet - def.price, unlocked: [...s.unlocked, id] });
    return true;
  },
  setTab(t) {
    set({ tab: t });
  },
  setPlanning(open) {
    if (open && get().live) return;
    // fechar sem iniciar descarta a rota planejada (ao iniciar, startActivity fecha a folha e a rota fica)
    if (open) set({ planning: true, tab: 'map', selected: null });
    else set({ planning: false, route: get().live ? get().route : null });
  },
  setRoute(route) {
    set({ route, routeProgress: null, rerouting: 'idle' });
  },
  setSetting(k, v) {
    set({ settings: { ...get().settings, [k]: v } });
  },
  toast(text, kind = 'info', coinKind) {
    const t: Toast = { id: toastSeq++, text, kind, coinKind };
    set({ toasts: [...get().toasts.slice(-3), t] });
    const ms = kind === 'coin' ? 1600 : kind === 'achievement' ? 3800 : 3200;
    setTimeout(() => get().dismissToast(t.id), ms);
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  pushModal(m) {
    set({ modals: [...get().modals, m] });
  },
  closeModal() {
    set({ modals: get().modals.slice(1) });
  },
  addXp(n) {
    if (n <= 0) return;
    const s = get();
    const before = levelFromXp(s.xp).level;
    const xp = s.xp + n;
    const after = levelFromXp(xp);
    const live = s.live ? { ...s.live, xp: s.live.xp + n } : null;
    set({ xp, live });
    if (after.level > before) get().pushModal({ type: 'levelup', level: after.level, title: after.title });
  },

  startActivity() {
    const s = get();
    if (!s.profile || s.live) return;
    const now = Date.now();
    const live: LiveActivity = {
      id: uid('act'),
      modality: s.profile.modality,
      startedAt: now,
      status: 'recording',
      resumedAt: now,
      elapsedS: 0,
      movingS: 0,
      distanceM: 0,
      maxSpeed: 0,
      coinsValue: 0,
      coinsCount: 0,
      coinsByKind: { ...EMPTY_COINS_BY_KIND },
      captures: [],
      newCells: 0,
      xp: 0,
      cityIds: [],
      source: 'live',
      verificationStatus: 'local',
      spawnCenters: [],
      spawns: 0,
    };
    // A cada nova atividade, as moedas antigas somem e um lote novo nasce (ver tracker).
    set({ live, coins: [], planning: false, tab: 'map' });
  },
  pauseActivity() {
    const live = get().live;
    if (!live || live.status !== 'recording') return;
    set({ live: { ...live, status: 'paused', elapsedS: liveElapsed(live), resumedAt: null } });
  },
  resumeActivity() {
    const live = get().live;
    if (!live || live.status !== 'paused') return;
    set({ live: { ...live, status: 'recording', resumedAt: Date.now() } });
  },
  finishActivity() {
    const s = get();
    const live = s.live;
    if (!live) return null;
    const summary: ActivitySummary = {
      id: live.id,
      modality: live.modality,
      startedAt: live.startedAt,
      endedAt: Date.now(),
      elapsedS: liveElapsed(live),
      movingS: live.movingS,
      distanceM: live.distanceM,
      maxSpeed: live.maxSpeed,
      coinsValue: live.coinsValue,
      coinsCount: live.coinsCount,
      coinsByKind: live.coinsByKind ? { ...live.coinsByKind } : { ...EMPTY_COINS_BY_KIND },
      captures: live.captures,
      newCells: live.newCells,
      xp: live.xp,
      cityIds: live.cityIds,
      source: live.source ?? 'live',
      verificationStatus: 'local',
      verificationReason: null,
      ...(live.boostUsageIds?.length ? { boostUsageIds: [...live.boostUsageIds] } : {}),
    };
    const t = s.totals;
    set({
      live: null,
      route: null,
      routeProgress: null,
      activities: [summary, ...s.activities].slice(0, 200),
      totals: {
        ...t,
        distanceM: t.distanceM + summary.distanceM,
        movingS: t.movingS + summary.movingS,
        activities: t.activities + 1,
      },
    });
    get().pushModal({ type: 'summary', activity: summary });
    return summary;
  },
  discardActivity() {
    set({ live: null, route: null, routeProgress: null });
  },

  collectCoin(coin) {
    const s = get();
    const value = COIN_VALUE[coin.kind];
    const prevKinds = s.live?.coinsByKind ?? EMPTY_COINS_BY_KIND;
    set({
      coins: s.coins.filter((c) => c.id !== coin.id),
      wallet: s.wallet + value,
      totals: { ...s.totals, coinsValue: s.totals.coinsValue + value, coinsCount: s.totals.coinsCount + 1 },
      live: s.live
        ? {
            ...s.live,
            coinsValue: s.live.coinsValue + value,
            coinsCount: s.live.coinsCount + 1,
            coinsByKind: { ...prevKinds, [coin.kind]: (prevKinds[coin.kind] ?? 0) + 1 },
          }
        : null,
    });
    get().addXp(Math.max(1, Math.ceil(value * XP.perCoinValue)));
  },
  capturePoi(poi, cityId) {
    const s = get();
    if (s.captures[poi.id]) return null;
    const capture: Capture = { ...poi, capturedAt: Date.now(), cityId, activityId: s.live?.id ?? null };
    const xp = RARITY_INFO[poi.rarity].xp;
    set({
      captures: { ...s.captures, [poi.id]: capture },
      totals: { ...s.totals, captures: s.totals.captures + 1 },
      live: s.live ? { ...s.live, captures: [...s.live.captures, poi.id] } : null,
    });
    get().pushModal({ type: 'capture', capture, xp });
    get().addXp(xp);
    return capture;
  },
  grantAchievements(unlocks, opts) {
    if (!unlocks.length) return 0;
    const s = get();
    const fresh = unlocks.filter((u) => !s.achievements[u.key]);
    if (!fresh.length) return 0;
    const now = Date.now();
    const nextAchievements: Record<string, AchievementRecord> = { ...s.achievements };
    let totalCoins = 0;
    for (const u of fresh) {
      if (nextAchievements[u.key]) continue;
      nextAchievements[u.key] = { at: now, coins: u.coins };
      totalCoins += u.coins;
    }
    set({
      achievements: nextAchievements,
      wallet: s.wallet + totalCoins,
    });
    if (opts?.batchToast || fresh.length >= 3) {
      const label = fresh.length === 1 ? 'conquista desbloqueada' : 'conquistas desbloqueadas';
      get().toast(`${fresh.length} ${label}! +${totalCoins.toLocaleString('pt-BR')} moedas`, 'achievement');
    } else {
      for (const unlock of fresh) get().pushModal({ type: 'achievement', unlock });
    }
    return totalCoins;
  },
  setSyncState(patch) {
    set(patch);
  },
  setAuthState(patch) {
    set(patch);
  },
  setPendingInviteUsername(username) {
    set({ pendingInviteUsername: username });
  },
  setPendingMigration(migration) {
    set({ pendingMigration: migration });
  },
  bumpSocialRev() {
    set({ socialRev: get().socialRev + 1 });
  },
  updateProfileIdentity(patch) {
    const p = get().profile;
    if (!p) return;
    set({ profile: { ...p, ...patch } });
  },
  reconcileVerifiedActivity(payload) {
    const s = get();
    const now = Date.now();
    const activities = s.activities.map((a) => {
      if (a.id !== payload.activityId) return a;
      return {
        ...a,
        verificationStatus: payload.verificationStatus,
        verificationReason: payload.verificationReason ?? null,
        distanceM: payload.distanceM ?? a.distanceM,
        movingS: payload.movingS ?? a.movingS,
        maxSpeed: payload.maxSpeed ?? a.maxSpeed,
        xp: payload.xpEarned ?? a.xp,
        coinsValue: payload.coinsEarned ?? a.coinsValue,
        newCells: payload.newCells ?? a.newCells,
      };
    });
    const auth = payload.authoritative;
    set({
      activities,
      xp: auth.xp,
      wallet: auth.wallet,
      totals: {
        ...s.totals,
        distanceM: auth.totalDistanceM,
        movingS: auth.totalMovingS,
        activities: auth.totalActivities,
        captures: auth.totalCaptures,
        cells: Math.max(s.totals.cells, auth.totalCells),
      },
      profile: s.profile ? { ...s.profile, cloudSyncedAt: now } : null,
      cloudSyncedAt: now,
      lastSyncedAt: now,
      lastSyncError: null,
    });
  },
  applyCloudSnapshot(snapshot) {
    const s = get();
    set({
      ...snapshot,
      profile: snapshot.profile !== undefined ? snapshot.profile : s.profile,
      totals: snapshot.totals ? { ...s.totals, ...snapshot.totals } : s.totals,
      settings: snapshot.settings ? { ...s.settings, ...snapshot.settings } : s.settings,
      captures: snapshot.captures ?? s.captures,
      cities: snapshot.cities ?? s.cities,
      activities: snapshot.activities ?? s.activities,
      achievements: snapshot.achievements ?? s.achievements,
      unlocked: snapshot.unlocked ?? s.unlocked,
    });
  },
  resetProgress() {
    set({
      ...DEFAULT_PERSISTED,
      cloudUserId: undefined,
      cloudSyncedAt: undefined,
      syncing: false,
      lastSyncError: null,
      lastSyncedAt: null,
      pendingMigration: null,
      tab: 'map',
      modals: [],
      toasts: [],
      selected: null,
      planning: false,
      routeProgress: null,
    });
  },
  select(poi) {
    set({ selected: poi });
  },
}));

export function pickPersisted(s: GameState): PersistedState {
  return {
    version: 1,
    profile: s.profile,
    unlocked: s.unlocked,
    wallet: s.wallet,
    xp: s.xp,
    totals: s.totals,
    captures: s.captures,
    cities: s.cities,
    activities: s.activities,
    achievements: s.achievements,
    settings: s.settings,
    coins: s.coins,
    live: s.live,
    route: s.route,
    ...(s.cloudUserId !== undefined ? { cloudUserId: s.cloudUserId } : {}),
    ...(s.cloudSyncedAt !== undefined ? { cloudSyncedAt: s.cloudSyncedAt } : {}),
  };
}
