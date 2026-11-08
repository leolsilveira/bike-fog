// Estado global (zustand). Módulos fora do React usam useGame.getState()/setState().
import { create } from 'zustand';
import { CHARACTERS } from '../sprites/characters.ts';
import { COIN_VALUE, RARITY_INFO } from '../sprites/items.ts';
import { levelFromXp } from './progression.ts';
import { XP } from './config.ts';
import type {
  ActivitySummary, Capture, City, Coin, GpsStatus, LiveActivity, Modal, Modality, PlannedRoute, PlayerFix, Poi,
  Profile, RouteProgress, Settings, Tab, Toast, Totals,
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
  settings: Settings;
  coins: Coin[];
  live: LiveActivity | null;
  /** Rota planejada (salva junto: sobrevive ao app fechar no meio da atividade). */
  route: PlannedRoute | null;
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
}

interface Actions {
  createProfile(name: string, characterId: string, modality: Modality): void;
  setModality(m: Modality): void;
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
  resetProgress(): void;
  select(poi: Poi | null): void;
}

export type GameState = PersistedState & RuntimeState & Actions;

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
  currentCityId: null,
  selected: null,
  planning: false,
  routeProgress: null,
  rerouting: 'idle',

  createProfile(name, characterId, modality) {
    set({ profile: { name: name.trim() || 'Viajante', characterId, modality, createdAt: Date.now() }, tab: 'map' });
  },
  setModality(m) {
    const p = get().profile;
    if (!p || get().live) return;
    set({ profile: { ...p, modality: m } });
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
    setTimeout(() => get().dismissToast(t.id), kind === 'coin' ? 1600 : 3200);
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
      captures: [],
      newCells: 0,
      xp: 0,
      cityIds: [],
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
      captures: live.captures,
      newCells: live.newCells,
      xp: live.xp,
      cityIds: live.cityIds,
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
    set({
      coins: s.coins.filter((c) => c.id !== coin.id),
      wallet: s.wallet + value,
      totals: { ...s.totals, coinsValue: s.totals.coinsValue + value, coinsCount: s.totals.coinsCount + 1 },
      live: s.live ? { ...s.live, coinsValue: s.live.coinsValue + value, coinsCount: s.live.coinsCount + 1 } : null,
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
  resetProgress() {
    set({
      ...DEFAULT_PERSISTED, tab: 'map', modals: [], toasts: [], selected: null, planning: false, routeProgress: null,
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
    settings: s.settings,
    coins: s.coins,
    live: s.live,
    route: s.route,
  };
}
