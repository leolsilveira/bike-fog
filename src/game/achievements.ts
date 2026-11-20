// Sistema de conquistas (inspirado no StatsHunters e RPGs de exploração):
// marcos progressivos multi-nível, conquistas recorrentes por cidade e por mês,
// e conquistas especiais — todas creditando moedas automaticamente na carteira.
import type { IconName } from '../sprites/icons.ts';
import { useGame } from './store.ts';
import type {
  AchievementCategory, AchievementRecord, AchievementUnlockEvent, ActivitySummary, Capture, City,
  LiveActivity, Totals,
} from './types.ts';

export interface AchievementSnapshot {
  totals: Totals;
  cities: Record<string, City>;
  captures: Record<string, Capture>;
  activities: ActivitySummary[];
  live: LiveActivity | null;
  achievements: Record<string, AchievementRecord>;
}

export interface AchievementTier {
  target: number;
  coins: number;
  label?: string;
}

export interface TieredAchievementDef {
  id: string;
  title: string;
  description: string;
  category: AchievementCategory;
  icon: IconName;
  tiers: AchievementTier[];
  measure: (ctx: EvalContext) => number;
  formatValue: (v: number) => string;
}

export interface AchievementCategoryMeta {
  id: AchievementCategory;
  label: string;
  icon: IconName;
}

export const ACHIEVEMENT_CATEGORIES: AchievementCategoryMeta[] = [
  { id: 'exploration', label: 'Exploração', icon: 'cloud' },
  { id: 'cities', label: 'Cidades', icon: 'flag' },
  { id: 'distance', label: 'Distância', icon: 'bike' },
  { id: 'collection', label: 'Coleção', icon: 'star' },
  { id: 'consistency', label: 'Constância', icon: 'flame' },
  { id: 'special', label: 'Especiais', icon: 'medal' },
];

export const CITY_COMPLETION_TIERS: (AchievementTier & { title: string })[] = [
  { target: 0.1, coins: 15, title: 'Primeiros Passos' },
  { target: 0.5, coins: 25, title: 'Morador do Bairro' },
  { target: 1, coins: 40, title: 'Conhecedor Local' },
  { target: 2.5, coins: 65, title: 'Guia Urbano' },
  { target: 5, coins: 100, title: 'Cartógrafo Municipal' },
  { target: 10, coins: 150, title: 'Desbravador da Cidade' },
  { target: 25, coins: 250, title: 'Guardião Urbano' },
  { target: 50, coins: 400, title: 'Metade do Mapa' },
  { target: 100, coins: 750, title: 'Mestre Absoluto' },
];

export const MONTHLY_DISTANCE_TIERS: AchievementTier[] = [
  { target: 25, coins: 20 },
  { target: 50, coins: 35 },
  { target: 100, coins: 60 },
  { target: 250, coins: 120 },
  { target: 500, coins: 200 },
];

export const MONTHLY_DAYS_TIERS: AchievementTier[] = [
  { target: 5, coins: 20 },
  { target: 10, coins: 40 },
  { target: 15, coins: 70 },
  { target: 20, coins: 120 },
];

// ---------------------------------------------------------------------------
// Helpers puros de data, métricas e formatação
// ---------------------------------------------------------------------------

const MONTHS_SHORT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function localMonthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

export function formatMonthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  const name = MONTHS_SHORT[(m ?? 1) - 1] ?? String(m);
  return `${name}/${y}`;
}

function cityPct(c: City): number {
  if (!c.areaM2) return 0;
  return Math.min(100, ((c.cells * c.cellAreaM2) / c.areaM2) * 100);
}

function formatPct(p: number): string {
  const decimals = p < 1 ? 1 : Number.isInteger(p) ? 0 : 1;
  return `${p.toFixed(decimals).replace('.', ',')}%`;
}

function formatKm(km: number): string {
  if (km >= 100) return `${Math.round(km).toLocaleString('pt-BR')} km`;
  const rounded = Math.round(km * 10) / 10;
  return `${String(rounded).replace('.', ',')} km`;
}

function formatHours(h: number): string {
  if (h >= 10) return `${Math.floor(h).toLocaleString('pt-BR')} h`;
  const rounded = Math.round(h * 10) / 10;
  return `${String(rounded).replace('.', ',')} h`;
}

function formatInt(n: number): string {
  return Math.floor(n).toLocaleString('pt-BR');
}

/** Maior sequência de dias calendário locais consecutivos com pelo menos 1 atividade. */
export function computeMaxStreak(activities: Pick<ActivitySummary, 'startedAt'>[]): number {
  if (!activities.length) return 0;
  const dayIndices = new Set<number>();
  for (const a of activities) {
    const d = new Date(a.startedAt);
    dayIndices.add(Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000));
  }
  const sorted = [...dayIndices].sort((a, b) => a - b);
  let best = 1;
  let cur = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1] + 1) {
      cur++;
      if (cur > best) best = cur;
    } else {
      cur = 1;
    }
  }
  return best;
}

/**
 * Número de Eddington em km (clássico do StatsHunters):
 * maior inteiro E tal que existam pelo menos E dias distintos com soma >= E km.
 */
export function computeEddingtonKm(activities: Pick<ActivitySummary, 'startedAt' | 'distanceM'>[]): number {
  if (!activities.length) return 0;
  const byDay = new Map<string, number>();
  for (const a of activities) {
    const key = localDayKey(a.startedAt);
    byDay.set(key, (byDay.get(key) ?? 0) + a.distanceM / 1000);
  }
  const kms = [...byDay.values()].sort((a, b) => b - a);
  let e = 0;
  for (let i = 0; i < kms.length; i++) {
    if (kms[i] >= i + 1) e = i + 1;
    else break;
  }
  return e;
}

interface MonthlyBucket {
  distanceKm: number;
  days: Set<string>;
}

export function computeMonthlyStats(
  activities: Pick<ActivitySummary, 'startedAt' | 'distanceM'>[],
  live: Pick<LiveActivity, 'startedAt' | 'distanceM'> | null,
): Map<string, MonthlyBucket> {
  const map = new Map<string, MonthlyBucket>();
  const add = (startedAt: number, distanceM: number) => {
    const mk = localMonthKey(startedAt);
    let b = map.get(mk);
    if (!b) {
      b = { distanceKm: 0, days: new Set() };
      map.set(mk, b);
    }
    b.distanceKm += distanceM / 1000;
    b.days.add(localDayKey(startedAt));
  };
  for (const a of activities) add(a.startedAt, a.distanceM);
  if (live && live.distanceM > 0) add(live.startedAt, live.distanceM);
  return map;
}

// ---------------------------------------------------------------------------
// Contexto pré-computado para avaliar todas as conquistas em uma passada
// ---------------------------------------------------------------------------

interface EvalContext {
  state: AchievementSnapshot;
  totalDistanceKm: number;
  totalMovingHours: number;
  citiesCount: number;
  poiCategoriesCount: number;
  rareCapturesCount: number;
  maxStreak: number;
  eddingtonKm: number;
  bestBikeKm: number;
  bestRunKm: number;
  earlyBirdCount: number;
  nightRiderCount: number;
  multiCityCount: number;
  hasDualSport: boolean;
  monthly: Map<string, MonthlyBucket>;
}

function buildContext(state: AchievementSnapshot): EvalContext {
  const { totals, cities, captures, activities, live } = state;
  const totalDistanceKm = (totals.distanceM + (live?.distanceM ?? 0)) / 1000;
  const totalMovingHours = (totals.movingS + (live?.movingS ?? 0)) / 3600;
  const citiesCount = Object.keys(cities).length;

  const catSet = new Set<string>();
  let rareCapturesCount = 0;
  for (const c of Object.values(captures)) {
    catSet.add(c.category);
    if (c.rarity === 'raro' || c.rarity === 'epico' || c.rarity === 'lendario') {
      rareCapturesCount++;
    }
  }

  let bestBikeKm = live?.modality === 'bike' ? live.distanceM / 1000 : 0;
  let bestRunKm = live?.modality === 'run' ? live.distanceM / 1000 : 0;
  let earlyBirdCount = 0;
  let nightRiderCount = 0;
  let multiCityCount = 0;
  let hasBike = false;
  let hasRun = false;

  for (const a of activities) {
    const km = a.distanceM / 1000;
    if (a.modality === 'bike') {
      hasBike = true;
      if (km > bestBikeKm) bestBikeKm = km;
    } else {
      hasRun = true;
      if (km > bestRunKm) bestRunKm = km;
    }
    const hour = new Date(a.startedAt).getHours();
    if (hour < 6) earlyBirdCount++;
    if (hour >= 21 || hour < 4) nightRiderCount++;
    if (a.cityIds.length >= 2) multiCityCount++;
  }

  // Também considera a atividade ao vivo para conquista de multi-cidade imediata
  if (live && live.cityIds.length >= 2) multiCityCount++;

  return {
    state,
    totalDistanceKm,
    totalMovingHours,
    citiesCount,
    poiCategoriesCount: catSet.size,
    rareCapturesCount,
    maxStreak: computeMaxStreak(activities),
    eddingtonKm: computeEddingtonKm(activities),
    bestBikeKm,
    bestRunKm,
    earlyBirdCount,
    nightRiderCount,
    multiCityCount,
    hasDualSport: hasBike && hasRun,
    monthly: computeMonthlyStats(activities, live),
  };
}

// ---------------------------------------------------------------------------
// Catálogo estático de conquistas progressivas e especiais
// ---------------------------------------------------------------------------

export const TIERED_ACHIEVEMENTS: TieredAchievementDef[] = [
  {
    id: 'total_distance',
    title: 'Papa-Léguas',
    description: 'Acumule distância pedalando ou correndo.',
    category: 'distance',
    icon: 'bike',
    tiers: [
      { target: 5, coins: 20 },
      { target: 25, coins: 40 },
      { target: 100, coins: 75 },
      { target: 250, coins: 120 },
      { target: 500, coins: 180 },
      { target: 1000, coins: 300 },
      { target: 2500, coins: 500 },
    ],
    measure: (ctx) => ctx.totalDistanceKm,
    formatValue: formatKm,
  },
  {
    id: 'total_activities',
    title: 'Ritmo Constante',
    description: 'Complete atividades no Desbrava.',
    category: 'consistency',
    icon: 'record',
    tiers: [
      { target: 1, coins: 15 },
      { target: 5, coins: 30 },
      { target: 15, coins: 50 },
      { target: 30, coins: 80 },
      { target: 50, coins: 120 },
      { target: 100, coins: 200 },
      { target: 250, coins: 350 },
    ],
    measure: (ctx) => ctx.state.totals.activities,
    formatValue: (v) => `${formatInt(v)} ${Math.floor(v) === 1 ? 'atividade' : 'atividades'}`,
  },
  {
    id: 'total_moving_time',
    title: 'Horas na Estrada',
    description: 'Some tempo ativo em movimento.',
    category: 'consistency',
    icon: 'clock',
    tiers: [
      { target: 1, coins: 20 },
      { target: 5, coins: 45 },
      { target: 15, coins: 80 },
      { target: 50, coins: 150 },
      { target: 100, coins: 250 },
    ],
    measure: (ctx) => ctx.totalMovingHours,
    formatValue: formatHours,
  },
  {
    id: 'total_cells',
    title: 'Caça-Névoa',
    description: 'Revele novas células do mapa.',
    category: 'exploration',
    icon: 'cloud',
    tiers: [
      { target: 500, coins: 20 },
      { target: 2000, coins: 40 },
      { target: 10000, coins: 80 },
      { target: 35000, coins: 150 },
      { target: 100000, coins: 300 },
      { target: 300000, coins: 500 },
    ],
    measure: (ctx) => ctx.state.totals.cells,
    formatValue: (v) => `${formatInt(v)} células`,
  },
  {
    id: 'cities_count',
    title: 'Turista de Mapa',
    description: 'Descubra municípios diferentes.',
    category: 'cities',
    icon: 'flag',
    tiers: [
      { target: 1, coins: 20 },
      { target: 2, coins: 45 },
      { target: 5, coins: 90 },
      { target: 10, coins: 160 },
      { target: 20, coins: 300 },
    ],
    measure: (ctx) => ctx.citiesCount,
    formatValue: (v) => `${formatInt(v)} ${Math.floor(v) === 1 ? 'cidade' : 'cidades'}`,
  },
  {
    id: 'total_captures',
    title: 'Colecionador de Marcos',
    description: 'Capture pontos de interesse pelo mapa.',
    category: 'collection',
    icon: 'pin',
    tiers: [
      { target: 1, coins: 20 },
      { target: 5, coins: 35 },
      { target: 15, coins: 60 },
      { target: 30, coins: 100 },
      { target: 60, coins: 160 },
      { target: 100, coins: 240 },
      { target: 200, coins: 400 },
    ],
    measure: (ctx) => ctx.state.totals.captures,
    formatValue: (v) => `${formatInt(v)} ${Math.floor(v) === 1 ? 'captura' : 'capturas'}`,
  },
  {
    id: 'poi_categories',
    title: 'Enciclopédia Urbana',
    description: 'Capture pontos de categorias diferentes.',
    category: 'collection',
    icon: 'star',
    tiers: [
      { target: 3, coins: 30 },
      { target: 6, coins: 70 },
      { target: 10, coins: 150 },
    ],
    measure: (ctx) => ctx.poiCategoriesCount,
    formatValue: (v) => `${formatInt(v)}/10 categorias`,
  },
  {
    id: 'rare_captures',
    title: 'Olho Clínico',
    description: 'Capture pontos Raros, Épicos ou Lendários.',
    category: 'collection',
    icon: 'trophy',
    tiers: [
      { target: 1, coins: 30 },
      { target: 5, coins: 70 },
      { target: 15, coins: 140 },
      { target: 40, coins: 280 },
    ],
    measure: (ctx) => ctx.rareCapturesCount,
    formatValue: (v) => `${formatInt(v)} ${Math.floor(v) === 1 ? 'raro' : 'raros'}`,
  },
  {
    id: 'street_coins',
    title: 'Caçador de Tesouros',
    description: 'Colete moedas espalhadas pelas ruas.',
    category: 'exploration',
    icon: 'bolt',
    tiers: [
      { target: 10, coins: 15 },
      { target: 50, coins: 35 },
      { target: 150, coins: 70 },
      { target: 500, coins: 140 },
      { target: 1000, coins: 250 },
    ],
    measure: (ctx) => ctx.state.totals.coinsCount,
    formatValue: (v) => `${formatInt(v)} moedas`,
  },
  {
    id: 'max_streak',
    title: 'Chama Acesa',
    description: 'Registre atividades em dias seguidos.',
    category: 'consistency',
    icon: 'flame',
    tiers: [
      { target: 3, coins: 25 },
      { target: 7, coins: 60 },
      { target: 14, coins: 120 },
      { target: 30, coins: 250 },
      { target: 60, coins: 450 },
    ],
    measure: (ctx) => ctx.maxStreak,
    formatValue: (v) => `${formatInt(v)} ${Math.floor(v) === 1 ? 'dia' : 'dias'}`,
  },
  {
    id: 'eddington_km',
    title: 'Número de Eddington',
    description: 'Complete E dias com pelo menos E km no dia.',
    category: 'distance',
    icon: 'medal',
    tiers: [
      { target: 5, coins: 35 },
      { target: 10, coins: 70 },
      { target: 20, coins: 140 },
      { target: 35, coins: 250 },
      { target: 50, coins: 400 },
    ],
    measure: (ctx) => ctx.eddingtonKm,
    formatValue: (v) => `E = ${formatInt(v)}`,
  },
  {
    id: 'single_bike_dist',
    title: 'Pedal Épico',
    description: 'Percorra grandes distâncias numa única pedalada.',
    category: 'distance',
    icon: 'bike',
    tiers: [
      { target: 10, coins: 25 },
      { target: 25, coins: 50 },
      { target: 50, coins: 90 },
      { target: 100, coins: 180, label: 'Century 100 km' },
      { target: 160, coins: 320, label: 'Imperial 160 km' },
    ],
    measure: (ctx) => ctx.bestBikeKm,
    formatValue: formatKm,
  },
  {
    id: 'single_run_dist',
    title: 'Corrida Épica',
    description: 'Vença grandes distâncias numa única corrida.',
    category: 'distance',
    icon: 'run',
    tiers: [
      { target: 5, coins: 25 },
      { target: 10, coins: 50 },
      { target: 21.1, coins: 120, label: 'Meia Maratona' },
      { target: 42.2, coins: 300, label: 'Maratona' },
    ],
    measure: (ctx) => ctx.bestRunKm,
    formatValue: formatKm,
  },
  {
    id: 'early_bird',
    title: 'Madrugador',
    description: 'Comece uma atividade antes das 6h.',
    category: 'special',
    icon: 'sun',
    tiers: [
      { target: 1, coins: 25 },
      { target: 5, coins: 60 },
      { target: 15, coins: 130 },
    ],
    measure: (ctx) => ctx.earlyBirdCount,
    formatValue: (v) => `${formatInt(v)}x`,
  },
  {
    id: 'night_rider',
    title: 'Coruja Urbana',
    description: 'Saia para explorar entre 21h e 4h.',
    category: 'special',
    icon: 'moon',
    tiers: [
      { target: 1, coins: 25 },
      { target: 5, coins: 60 },
      { target: 15, coins: 130 },
    ],
    measure: (ctx) => ctx.nightRiderCount,
    formatValue: (v) => `${formatInt(v)}x`,
  },
  {
    id: 'multi_city_activity',
    title: 'Sem Fronteiras',
    description: 'Cruze 2 ou mais cidades numa única atividade.',
    category: 'cities',
    icon: 'map',
    tiers: [
      { target: 1, coins: 40 },
      { target: 5, coins: 100 },
      { target: 15, coins: 220 },
    ],
    measure: (ctx) => ctx.multiCityCount,
    formatValue: (v) => `${formatInt(v)}x`,
  },
  {
    id: 'dual_sport',
    title: 'Híbrido',
    description: 'Registre pelo menos uma pedalada e uma corrida.',
    category: 'special',
    icon: 'medal',
    tiers: [{ target: 1, coins: 40 }],
    measure: (ctx) => (ctx.hasDualSport ? 1 : 0),
    formatValue: (v) => (v >= 1 ? 'Completo' : '0/1'),
  },
];

// ---------------------------------------------------------------------------
// Chaves e avaliação
// ---------------------------------------------------------------------------

export function tieredKey(id: string, tierIndex: number): string {
  return `${id}:${tierIndex}`;
}

export function cityTierKey(cityId: string, tierIndex: number): string {
  return `city_pct:${cityId}:${tierIndex}`;
}

export function monthlyDistKey(monthKey: string, tierIndex: number): string {
  return `monthly_dist:${monthKey}:${tierIndex}`;
}

export function monthlyDaysKey(monthKey: string, tierIndex: number): string {
  return `monthly_days:${monthKey}:${tierIndex}`;
}

/** Avalia o estado e devolve todas as conquistas elegíveis ainda não registradas. */
export function evaluateAchievements(state: AchievementSnapshot): AchievementUnlockEvent[] {
  const ctx = buildContext(state);
  const owned = state.achievements;
  const unlocks: AchievementUnlockEvent[] = [];

  // 1. Conquistas progressivas e especiais
  for (const def of TIERED_ACHIEVEMENTS) {
    const val = def.measure(ctx);
    for (let i = 0; i < def.tiers.length; i++) {
      const tier = def.tiers[i];
      if (val < tier.target) break;
      const key = tieredKey(def.id, i);
      if (owned[key]) continue;
      unlocks.push({
        key,
        title: def.title,
        subtitle: tier.label ?? def.formatValue(tier.target),
        coins: tier.coins,
        category: def.category,
        icon: def.icon,
        tier: i + 1,
        maxTier: def.tiers.length,
      });
    }
  }

  // 2. Recorrentes por cidade (conclusão %)
  for (const city of Object.values(state.cities)) {
    const pct = cityPct(city);
    for (let i = 0; i < CITY_COMPLETION_TIERS.length; i++) {
      const tier = CITY_COMPLETION_TIERS[i];
      if (pct < tier.target) break;
      const key = cityTierKey(city.id, i);
      if (owned[key]) continue;
      unlocks.push({
        key,
        title: `${city.name} · ${formatPct(tier.target)}`,
        subtitle: tier.title,
        coins: tier.coins,
        category: 'cities',
        icon: 'flag',
        tier: i + 1,
        maxTier: CITY_COMPLETION_TIERS.length,
      });
    }
  }

  // 3. Recorrentes mensais (distância e dias ativos)
  for (const [monthKey, bucket] of ctx.monthly) {
    const mLabel = formatMonthLabel(monthKey);
    for (let i = 0; i < MONTHLY_DISTANCE_TIERS.length; i++) {
      const tier = MONTHLY_DISTANCE_TIERS[i];
      if (bucket.distanceKm < tier.target) break;
      const key = monthlyDistKey(monthKey, i);
      if (owned[key]) continue;
      unlocks.push({
        key,
        title: `Meta de ${mLabel}`,
        subtitle: `${formatKm(tier.target)} no mês`,
        coins: tier.coins,
        category: 'consistency',
        icon: 'calendar',
        tier: i + 1,
        maxTier: MONTHLY_DISTANCE_TIERS.length,
      });
    }
    const activeDays = bucket.days.size;
    for (let i = 0; i < MONTHLY_DAYS_TIERS.length; i++) {
      const tier = MONTHLY_DAYS_TIERS[i];
      if (activeDays < tier.target) break;
      const key = monthlyDaysKey(monthKey, i);
      if (owned[key]) continue;
      unlocks.push({
        key,
        title: `Frequência de ${mLabel}`,
        subtitle: `${tier.target} dias ativos no mês`,
        coins: tier.coins,
        category: 'consistency',
        icon: 'calendar',
        tier: i + 1,
        maxTier: MONTHLY_DAYS_TIERS.length,
      });
    }
  }

  return unlocks;
}

// ---------------------------------------------------------------------------
// Gatilho conectado à store (com throttle opcional para movimentos de GPS)
// ---------------------------------------------------------------------------

let lastCheckAt = 0;

export function checkAndGrantAchievements(opts?: { batchToast?: boolean; throttleMs?: number }): number {
  const now = Date.now();
  if (opts?.throttleMs && now - lastCheckAt < opts.throttleMs) return 0;
  lastCheckAt = now;
  const s = useGame.getState();
  const unlocks = evaluateAchievements(s);
  if (!unlocks.length) return 0;
  return s.grantAchievements(unlocks, { batchToast: opts?.batchToast });
}

// ---------------------------------------------------------------------------
// Modelo pronto para renderização na UI (StatsScreen e AchievementsModal)
// ---------------------------------------------------------------------------

export interface AchievementCardItem {
  id: string;
  title: string;
  description: string;
  category: AchievementCategory;
  icon: IconName;
  recurring?: 'city' | 'monthly';
  unlockedTiers: number;
  totalTiers: number;
  complete: boolean;
  progressLabel: string;
  percent: number;
  nextCoins: number | null;
  earnedCoins: number;
}

export interface AchievementOverview {
  unlockedCount: number;
  totalCoinsEarned: number;
  fixedUnlockedTiers: number;
  fixedTotalTiers: number;
  items: AchievementCardItem[];
  almostThere: AchievementCardItem[];
}

function summarizeTiers(
  keyFn: (i: number) => string,
  tiers: AchievementTier[],
  currentValue: number,
  owned: Record<string, AchievementRecord>,
  formatValue: (v: number) => string,
): {
  unlockedTiers: number;
  complete: boolean;
  percent: number;
  progressLabel: string;
  nextCoins: number | null;
  earnedCoins: number;
} {
  let unlockedTiers = 0;
  let earnedCoins = 0;
  let nextIdx = -1;
  for (let i = 0; i < tiers.length; i++) {
    const rec = owned[keyFn(i)];
    if (rec) {
      unlockedTiers++;
      earnedCoins += rec.coins;
    } else if (nextIdx === -1) {
      nextIdx = i;
    }
  }
  const complete = nextIdx === -1;
  if (complete) {
    const last = tiers[tiers.length - 1];
    return {
      unlockedTiers,
      complete: true,
      percent: 100,
      progressLabel: `${formatValue(Math.max(currentValue, last.target))}`,
      nextCoins: null,
      earnedCoins,
    };
  }
  const next = tiers[nextIdx];
  const percent = next.target > 0 ? Math.min(100, (currentValue / next.target) * 100) : 0;
  return {
    unlockedTiers,
    complete: false,
    percent,
    progressLabel: `${formatValue(currentValue)} / ${formatValue(next.target)}`,
    nextCoins: next.coins,
    earnedCoins,
  };
}

export function buildAchievementOverview(state: AchievementSnapshot, now = Date.now()): AchievementOverview {
  const ctx = buildContext(state);
  const owned = state.achievements;
  const items: AchievementCardItem[] = [];

  let fixedUnlockedTiers = 0;
  let fixedTotalTiers = 0;

  // 1. Marcos fixos (progressivos e especiais)
  for (const def of TIERED_ACHIEVEMENTS) {
    const val = def.measure(ctx);
    const sum = summarizeTiers((i) => tieredKey(def.id, i), def.tiers, val, owned, def.formatValue);
    fixedUnlockedTiers += sum.unlockedTiers;
    fixedTotalTiers += def.tiers.length;
    items.push({
      id: def.id,
      title: def.title,
      description: def.description,
      category: def.category,
      icon: def.icon,
      ...sum,
      totalTiers: def.tiers.length,
    });
  }

  // 2. Recorrentes do mês atual (sempre visíveis para dar meta do mês)
  const curMonth = localMonthKey(now);
  const curLabel = formatMonthLabel(curMonth);
  const bucket = ctx.monthly.get(curMonth) ?? { distanceKm: 0, days: new Set<string>() };

  const mDist = summarizeTiers(
    (i) => monthlyDistKey(curMonth, i),
    MONTHLY_DISTANCE_TIERS,
    bucket.distanceKm,
    owned,
    formatKm,
  );
  items.push({
    id: `monthly_dist:${curMonth}`,
    title: `Distância · ${curLabel}`,
    description: 'Meta mensal recorrente — renova todo mês.',
    category: 'consistency',
    icon: 'calendar',
    recurring: 'monthly',
    ...mDist,
    totalTiers: MONTHLY_DISTANCE_TIERS.length,
  });

  const mDays = summarizeTiers(
    (i) => monthlyDaysKey(curMonth, i),
    MONTHLY_DAYS_TIERS,
    bucket.days.size,
    owned,
    (v) => `${formatInt(v)} dias`,
  );
  items.push({
    id: `monthly_days:${curMonth}`,
    title: `Dias ativos · ${curLabel}`,
    description: 'Dias distintos com atividade neste mês.',
    category: 'consistency',
    icon: 'calendar',
    recurring: 'monthly',
    ...mDays,
    totalTiers: MONTHLY_DAYS_TIERS.length,
  });

  // 3. Recorrentes por cidade descoberta (ordenadas por % explorado)
  const sortedCities = Object.values(state.cities).sort((a, b) => cityPct(b) - cityPct(a));
  for (const city of sortedCities) {
    const pct = cityPct(city);
    const sum = summarizeTiers(
      (i) => cityTierKey(city.id, i),
      CITY_COMPLETION_TIERS,
      pct,
      owned,
      formatPct,
    );
    items.push({
      id: `city_pct:${city.id}`,
      title: `Explorar ${city.name}`,
      description: 'Desbloqueie mais da cidade para ganhar moedas em cada marco.',
      category: 'cities',
      icon: 'flag',
      recurring: 'city',
      ...sum,
      totalTiers: CITY_COMPLETION_TIERS.length,
    });
  }

  let unlockedCount = 0;
  let totalCoinsEarned = 0;
  for (const rec of Object.values(owned)) {
    unlockedCount++;
    totalCoinsEarned += rec.coins;
  }

  const incomplete = items.filter((it) => !it.complete);
  const withProgress = incomplete.filter((it) => it.percent > 0).sort((a, b) => b.percent - a.percent);
  const almostThere = (withProgress.length >= 3 ? withProgress : [...withProgress, ...incomplete.filter((it) => it.percent === 0)]).slice(0, 3);

  return {
    unlockedCount,
    totalCoinsEarned,
    fixedUnlockedTiers,
    fixedTotalTiers,
    items,
    almostThere,
  };
}
