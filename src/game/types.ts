import type { Modality } from '../sprites/characters.ts';
import type { CoinKind, PoiCategory, Rarity } from '../sprites/items.ts';
import type { BBox, LngLat } from './geo.ts';

export type { Modality, CoinKind, PoiCategory, Rarity, LngLat };

export interface Profile {
  name: string;
  characterId: string;
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

export type Tab = 'map' | 'record' | 'stats';

export interface PlayerFix extends LngLat {
  accuracy: number;
  speed: number;
  heading: number | null;
  t: number;
}

export type GpsStatus = 'off' | 'searching' | 'ok' | 'weak' | 'denied' | 'unavailable' | 'sim';

export interface Toast {
  id: number;
  text: string;
  kind: 'coin' | 'info' | 'warn' | 'city' | 'xp';
  coinKind?: CoinKind;
}

export type Modal =
  | { type: 'capture'; capture: Capture; xp: number }
  | { type: 'levelup'; level: number; title: string }
  | { type: 'summary'; activity: ActivitySummary }
  | { type: 'characters' };
