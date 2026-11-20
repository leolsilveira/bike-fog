import type { AvatarConfig } from '../sprites/avatar.ts';
import type { Modality } from '../sprites/characters.ts';
import type { IconName } from '../sprites/icons.ts';
import type { CoinKind, PoiCategory, Rarity } from '../sprites/items.ts';
import type { BBox, LngLat } from './geo.ts';

export type { AvatarConfig, Modality, CoinKind, PoiCategory, Rarity, LngLat };

export interface Profile {
  name: string;
  characterId: string;
  avatar?: AvatarConfig;
  modality: Modality;
  createdAt: number;
}

export interface Coin {
  id: string;
  kind: CoinKind;
  lng: number;
  lat: number;
}

export interface Poi {
  id: string;
  name: string;
  category: PoiCategory;
  rarity: Rarity;
  lng: number;
  lat: number;
}

export interface Capture extends Poi {
  capturedAt: number;
  cityId: string | null;
  activityId: string | null;
}

export interface City {
  id: string;
  name: string;
  state?: string;
  country?: string;
  areaM2: number;
  bbox: BBox;
  /** Células exploradas dentro da cidade. */
  cells: number;
  /** Área média de uma célula nesta latitude (m²). */
  cellAreaM2: number;
  discoveredAt: number;
}

export interface ActivitySummary {
  id: string;
  modality: Modality;
  startedAt: number;
  endedAt: number;
  /** Tempo com o cronômetro rodando (sem pausas). */
  elapsedS: number;
  /** Tempo efetivamente em movimento. */
  movingS: number;
  distanceM: number;
  maxSpeed: number;
  coinsValue: number;
  coinsCount: number;
  captures: string[];
  newCells: number;
  xp: number;
  cityIds: string[];
}

export interface LiveActivity extends Omit<ActivitySummary, 'endedAt'> {
  status: 'recording' | 'paused';
  /** Momento em que o cronômetro foi retomado pela última vez (ms) ou null se pausado. */
  resumedAt: number | null;
  spawnCenters: LngLat[];
  spawns: number;
}

export interface Totals {
  distanceM: number;
  movingS: number;
  activities: number;
  coinsValue: number;
  coinsCount: number;
  captures: number;
  cells: number;
}

export interface Settings {
  sound: boolean;
  haptics: boolean;
  simulator: boolean;
}

/** Lugar encontrado na busca de endereços (Photon). */
export interface Place {
  /** Linha principal: nome do lugar ou "rua, número". */
  name: string;
  /** Linha de baixo: rua, bairro e cidade (o que houver). */
  detail: string;
  lng: number;
  lat: number;
}

/**
 * Rota planejada na folha "Nova atividade": até um endereço (só ida ou ida e volta) ou uma volta automática
 * com a distância pedida, que sai e chega no mesmo ponto.
 */
export interface PlannedRoute {
  kind: 'address' | 'loop';
  /** Destino; na volta automática, o próprio ponto de partida (com o nome "Volta de X km"). */
  dest: Place;
  roundTrip: boolean;
  /** Perfil usado no traçado (bike → ciclovias/ruas; corrida → perfil a pé). */
  modality: Modality;
  /** Trajeto em pares lng,lat achatados. */
  coords: number[];
  distanceM: number;
  /** Paradas que ainda faltam (já ajustadas às ruas): pontos intermediários, destino e, se for o caso, a volta. */
  stops: LngLat[];
  /** Fração do trajeto (0 a 1) que passa por onde ainda há névoa. */
  fogShare: number;
}

/** Andamento na rota durante a atividade. */
export interface RouteProgress {
  doneM: number;
  remainingM: number;
  /** Distância até o trajeto (m). */
  offRouteM: number;
  arrived: boolean;
}

/** Abas da barra. Gravar não é aba: o botão do meio abre a folha "Nova atividade" (ver store `planning`). */
export type Tab = 'map' | 'stats';

export interface PlayerFix extends LngLat {
  accuracy: number;
  speed: number;
  heading: number | null;
  t: number;
}

export type GpsStatus = 'off' | 'searching' | 'ok' | 'weak' | 'denied' | 'unavailable' | 'sim';

export type AchievementCategory =
  | 'exploration'
  | 'cities'
  | 'distance'
  | 'collection'
  | 'consistency'
  | 'special';

export interface AchievementRecord {
  /** Momento em que foi desbloqueada (ms). */
  at: number;
  /** Moedas concedidas no desbloqueio. */
  coins: number;
}

export interface AchievementUnlockEvent {
  key: string;
  title: string;
  subtitle: string;
  coins: number;
  category: AchievementCategory;
  icon: IconName;
  tier?: number;
  maxTier?: number;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'coin' | 'info' | 'warn' | 'city' | 'xp' | 'achievement';
  coinKind?: CoinKind;
}

export type Modal =
  | { type: 'capture'; capture: Capture; xp: number }
  | { type: 'levelup'; level: number; title: string }
  | { type: 'achievement'; unlock: AchievementUnlockEvent }
  | { type: 'achievements' }
  | { type: 'summary'; activity: ActivitySummary }
  | { type: 'avatar' };
