// Motor puro de validação e cálculo autoritativo de atividades (sem dependências Deno).
import {
  COINS_PER_SPAWN,
  COIN_VALUE,
  MAX_SPAWNS_PER_ACTIVITY,
  MAX_SEGMENT_JUMP_M,
  MAX_SPEED,
  POI_CATEGORIES,
  POI_INFO,
  RARITIES,
  RARITY_XP,
  RESPAWN_DISTANCE_M,
  REVEAL_RADIUS_M,
  XP,
  haversine,
  isValidPoiRarity,
  pointToSegmentDistanceM,
  revealSegmentCells,
  type LngLat,
  type Modality,
  type PoiCategory,
  type Rarity,
} from './gameMath.ts';

export interface CaptureClaim {
  poiId: string;
  name: string;
  category: string;
  rarity: string;
  lat: number;
  lng: number;
  cityId?: string | null;
}

export interface CoinsByKind {
  bronze?: number;
  silver?: number;
  gold?: number;
  gem?: number;
}

export interface ClientActivitySummary {
  distanceM: number;
  movingS: number;
  maxSpeed: number;
  newCells: number;
  coinsCount: number;
  coinsValue: number;
  coinsByKind?: CoinsByKind;
  captures?: CaptureClaim[];
  cityIds?: string[];
}

export interface VerifyActivityPayload {
  activityId: string;
  source: 'live' | 'gpx_import';
  modality: Modality;
  startedAt: number;
  endedAt: number;
  trackPath: string;
  clientSummary: ClientActivitySummary;
  boostUsageIds?: string[];
}

export interface ValidatedBooster {
  id: string;
  itemId: string;
  category: 'boost_xp' | 'boost_fog' | 'boost_coins';
  multiplier: number;
}

export interface EvaluationResult {
  status: 'verified' | 'flagged';
  reason: string | null;
  distanceM: number;
  movingS: number;
  maxSpeed: number;
  newCells: number;
  baseXp: number;
  baseCoins: number;
  fogMultiplier: number;
  xpEarned: number;
  coinsEarned: number;
  coinsCount: number;
  validCaptures: CaptureClaim[];
  consumedBoostUsageIds: string[];
}

function isFiniteNonNegInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 0;
}

export function evaluateTrack(
  floats: Float64Array,
  payload: VerifyActivityPayload,
  existingCaptureIds: Set<string>,
  boosters: ValidatedBooster[],
): EvaluationResult {
  const n = Math.floor(floats.length / 3);
  const summary = payload.clientSummary;

  const flagged = (
    reason: string,
    distanceM = 0,
    movingS = 0,
    maxSpeed = 0,
  ): EvaluationResult => ({
    status: 'flagged',
    reason,
    distanceM,
    movingS,
    maxSpeed,
    newCells: 0,
    baseXp: 0,
    baseCoins: 0,
    fogMultiplier: 1,
    xpEarned: 0,
    coinsEarned: 0,
    coinsCount: 0,
    validCaptures: [],
    consumedBoostUsageIds: [],
  });

  if (n <= 0 || floats.length % 3 !== 0) {
    return flagged('empty_or_malformed_track');
  }

  for (let i = 0; i < n; i++) {
    const lng = floats[i * 3];
    const lat = floats[i * 3 + 1];
    const t = floats[i * 3 + 2];
    if (
      !Number.isFinite(lng) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(t) ||
      Math.abs(lat) > 85.05112878 ||
      Math.abs(lng) > 180 ||
      t <= 0
    ) {
      return flagged('invalid_coordinates_or_timestamp');
    }
    if (i > 0 && t < floats[(i - 1) * 3 + 2]) {
      return flagged('non_monotonic_timestamps');
    }
  }

  if (!Number.isFinite(summary.distanceM) || summary.distanceM < 0) {
    return flagged('distance_mismatch');
  }

  if (n === 1 && summary.distanceM > 0) {
    return flagged('insufficient_track_points');
  }

  // Selecionar no máximo 1 booster válido por categoria (somente no modo live)
  let xpMultiplier = 1;
  let fogMultiplier = 1;
  let coinsMultiplier = 1;
  const consumedBoostUsageIds: string[] = [];

  if (payload.source === 'live') {
    const seenCat = new Set<string>();
    for (const b of boosters) {
      if (seenCat.has(b.category)) continue;
      seenCat.add(b.category);
      const mult = Math.max(1, Math.min(5, Number.isFinite(b.multiplier) ? b.multiplier : 1));
      if (b.category === 'boost_xp') xpMultiplier = mult;
      else if (b.category === 'boost_fog') fogMultiplier = mult;
      else if (b.category === 'boost_coins') coinsMultiplier = mult;
      consumedBoostUsageIds.push(b.id);
    }
  }

  const effectiveRadius =
    payload.source === 'live' ? REVEAL_RADIUS_M * fogMultiplier : REVEAL_RADIUS_M;
  const trackCells = new Set<number>();

  // Caso especial: atividade ao vivo válida com apenas 1 fix e distância 0
  if (n === 1) {
    const p0: LngLat = { lng: floats[0], lat: floats[1] };
    revealSegmentCells(p0, p0, effectiveRadius, trackCells);
  }

  // Replay de importação GPX (paridade com src/game/gpxImport.ts)
  if (payload.source === 'gpx_import') {
    let distanceM = 0;
    let movingS = 0;
    let maxSpeed = 0;

    for (let i = 1; i < n; i++) {
      const a: LngLat = { lng: floats[(i - 1) * 3], lat: floats[(i - 1) * 3 + 1] };
      const b: LngLat = { lng: floats[i * 3], lat: floats[i * 3 + 1] };
      const tPrev = floats[(i - 1) * 3 + 2];
      const tCur = floats[i * 3 + 2];
      const d = haversine(a, b);
      if (d > MAX_SEGMENT_JUMP_M) continue;

      distanceM += d;
      revealSegmentCells(a, b, REVEAL_RADIUS_M, trackCells);

      const dt = (tCur - tPrev) / 1000;
      if (dt > 0 && dt <= 30) {
        const speed = d / dt;
        if (speed > 0.6 && speed < 35) {
          movingS += dt;
          if (speed > maxSpeed) maxSpeed = speed;
        }
      }
    }

    if (Math.abs(summary.distanceM - distanceM) > Math.max(250, distanceM * 0.25)) {
      return flagged('distance_mismatch', distanceM, movingS, maxSpeed);
    }

    if (!Number.isFinite(summary.newCells) || summary.newCells < 0) {
      return flagged('cells_mismatch', distanceM, movingS, maxSpeed);
    }
    const claimedNewCells = Math.round(summary.newCells);
    if (claimedNewCells > trackCells.size * 1.15 + 10) {
      return flagged('cells_mismatch', distanceM, movingS, maxSpeed);
    }

    const authoritativeNewCells = Math.min(claimedNewCells, trackCells.size);
    return {
      status: 'verified',
      reason: null,
      distanceM,
      movingS,
      maxSpeed,
      newCells: authoritativeNewCells,
      baseXp: 0,
      baseCoins: 0,
      fogMultiplier: 1,
      xpEarned: 0,
      coinsEarned: 0,
      coinsCount: 0,
      validCaptures: [],
      consumedBoostUsageIds: [],
    };
  }

  // Replay ao vivo + regras anti-cheat (paridade com src/game/tracker.ts e store.ts)
  const maxAllowedSpeed = MAX_SPEED[payload.modality];
  let distanceM = 0;
  let movingS = 0;
  let activeDurationS = 0;
  let maxSpeed = 0;
  let distXpAcc = 0;
  let distXp = 0;
  let excessCount = 0;
  let excessDist = 0;
  const segments = Math.max(0, n - 1);

  for (let i = 1; i < n; i++) {
    const a: LngLat = { lng: floats[(i - 1) * 3], lat: floats[(i - 1) * 3 + 1] };
    const b: LngLat = { lng: floats[i * 3], lat: floats[i * 3 + 1] };
    const tPrev = floats[(i - 1) * 3 + 2];
    const tCur = floats[i * 3 + 2];
    const dt = Math.max(0.001, (tCur - tPrev) / 1000);
    const d = haversine(a, b);
    const speed = d / dt;

    if ((d > 250 && speed > maxAllowedSpeed * 1.5) || (d > 1000 && dt <= 30)) {
      return flagged('teleport_jump', distanceM, movingS, Math.max(maxSpeed, speed));
    }

    if (
      (d > 50 && speed > maxAllowedSpeed * 1.5) ||
      (d > 15 && speed > maxAllowedSpeed * 2.0)
    ) {
      return flagged('impossible_speed', distanceM, movingS, Math.max(maxSpeed, speed));
    }

    if (speed > maxAllowedSpeed * 1.15) {
      excessCount++;
      excessDist += d;
    }

    distanceM += d;
    if (speed > 0.6) {
      movingS += Math.min(dt, 30);
      activeDurationS += dt;
    }
    if (speed > maxSpeed) maxSpeed = speed;

    distXpAcc += (d / 1000) * XP.perKm[payload.modality];
    const step = Math.floor(distXpAcc);
    distXpAcc -= step;
    distXp += step;

    revealSegmentCells(a, b, effectiveRadius, trackCells);
  }

  if (
    (segments >= 3 && (excessCount / segments > 0.2 || excessDist / Math.max(1, distanceM) > 0.2)) ||
    (activeDurationS >= 30 && distanceM / activeDurationS > maxAllowedSpeed * 1.05)
  ) {
    return flagged('sustained_excess_speed', distanceM, movingS, maxSpeed);
  }

  if (Math.abs(summary.distanceM - distanceM) > Math.max(150, distanceM * 0.2)) {
    return flagged('distance_mismatch', distanceM, movingS, maxSpeed);
  }

  if (
    !Number.isFinite(summary.newCells) ||
    summary.newCells < 0 ||
    summary.newCells > trackCells.size * 1.15 + 10
  ) {
    return flagged('cells_mismatch', distanceM, movingS, maxSpeed);
  }
  const authoritativeNewCells = Math.min(Math.max(0, Math.round(summary.newCells)), trackCells.size);

  // Validação de moedas coletadas
  const coinsCount = summary.coinsCount;
  const coinsValue = summary.coinsValue;
  if (!isFiniteNonNegInt(coinsCount) || !isFiniteNonNegInt(coinsValue)) {
    return flagged('implausible_coins', distanceM, movingS, maxSpeed);
  }
  if ((coinsCount === 0 && coinsValue > 0) || (coinsCount > 0 && coinsValue < coinsCount)) {
    return flagged('implausible_coins', distanceM, movingS, maxSpeed);
  }
  if (coinsValue > coinsCount * COIN_VALUE.gem) {
    return flagged('implausible_coins', distanceM, movingS, maxSpeed);
  }

  const isStationary = distanceM < 25 || n < 2;
  const maxSpawns = Math.min(MAX_SPAWNS_PER_ACTIVITY, 2 + Math.floor(distanceM / RESPAWN_DISTANCE_M));
  const maxPlausibleCoins = isStationary
    ? 3
    : Math.min(160, COINS_PER_SPAWN * maxSpawns);
  const maxAllowedGems = isStationary ? 0 : Math.max(1, maxSpawns);

  if (coinsCount > maxPlausibleCoins) {
    return flagged('implausible_coins', distanceM, movingS, maxSpeed);
  }
  if (isStationary && coinsValue > 25) {
    return flagged('implausible_coins', distanceM, movingS, maxSpeed);
  }

  let coinXp = 0;
  if (summary.coinsByKind) {
    const b = summary.coinsByKind.bronze ?? 0;
    const s = summary.coinsByKind.silver ?? 0;
    const g = summary.coinsByKind.gold ?? 0;
    const d = summary.coinsByKind.gem ?? 0;
    if (!isFiniteNonNegInt(b) || !isFiniteNonNegInt(s) || !isFiniteNonNegInt(g) || !isFiniteNonNegInt(d)) {
      return flagged('implausible_coins', distanceM, movingS, maxSpeed);
    }
    if (d > maxAllowedGems) {
      return flagged('implausible_coins', distanceM, movingS, maxSpeed);
    }
    if (b + s + g + d !== coinsCount) {
      return flagged('implausible_coins', distanceM, movingS, maxSpeed);
    }
    if (
      b * COIN_VALUE.bronze + s * COIN_VALUE.silver + g * COIN_VALUE.gold + d * COIN_VALUE.gem !==
      coinsValue
    ) {
      return flagged('implausible_coins', distanceM, movingS, maxSpeed);
    }
    coinXp =
      b * Math.max(1, Math.ceil(COIN_VALUE.bronze * XP.perCoinValue)) +
      s * Math.max(1, Math.ceil(COIN_VALUE.silver * XP.perCoinValue)) +
      g * Math.max(1, Math.ceil(COIN_VALUE.gold * XP.perCoinValue)) +
      d * Math.max(1, Math.ceil(COIN_VALUE.gem * XP.perCoinValue));
  } else if (coinsCount > 0) {
    const gemBudget = Math.min(coinsCount, maxAllowedGems);
    const maxValWithoutExcessGems =
      gemBudget * COIN_VALUE.gem + Math.max(0, coinsCount - gemBudget) * COIN_VALUE.gold;
    if (coinsValue > maxValWithoutExcessGems) {
      return flagged('implausible_coins', distanceM, movingS, maxSpeed);
    }
    coinXp = Math.max(coinsCount, Math.ceil(coinsValue * XP.perCoinValue));
  }

  // Validação de capturas de POIs
  const rawCaptures = Array.isArray(summary.captures) ? summary.captures : [];
  if (rawCaptures.length > 200) {
    return flagged('too_many_captures', distanceM, movingS, maxSpeed);
  }

  const seenPoiIds = new Set<string>();
  const validCaptures: CaptureClaim[] = [];
  let captureXp = 0;

  for (const cap of rawCaptures) {
    if (
      !cap ||
      typeof cap.poiId !== 'string' ||
      cap.poiId.trim().length === 0 ||
      cap.poiId.length > 120 ||
      typeof cap.name !== 'string' ||
      cap.name.trim().length === 0 ||
      cap.name.length > 160 ||
      !Number.isFinite(cap.lat) ||
      !Number.isFinite(cap.lng) ||
      Math.abs(cap.lat) > 85.05112878 ||
      Math.abs(cap.lng) > 180
    ) {
      return flagged('invalid_capture_metadata', distanceM, movingS, maxSpeed);
    }

    if (
      !POI_CATEGORIES.includes(cap.category as PoiCategory) ||
      !RARITIES.includes(cap.rarity as Rarity)
    ) {
      return flagged('invalid_capture_metadata', distanceM, movingS, maxSpeed);
    }

    const cat = cap.category as PoiCategory;
    const rar = cap.rarity as Rarity;
    if (!isValidPoiRarity(cat, rar)) {
      return flagged('invalid_capture_metadata', distanceM, movingS, maxSpeed);
    }

    const poiId = cap.poiId.trim();
    if (seenPoiIds.has(poiId)) continue;
    seenPoiIds.add(poiId);

    // Distância mínima do POI até algum segmento/ponto da trilha
    const target: LngLat = { lng: cap.lng, lat: cap.lat };
    let minDist = haversine(target, { lng: floats[0], lat: floats[1] });
    for (let i = 1; i < n; i++) {
      const a: LngLat = { lng: floats[(i - 1) * 3], lat: floats[(i - 1) * 3 + 1] };
      const b: LngLat = { lng: floats[i * 3], lat: floats[i * 3 + 1] };
      const segD = pointToSegmentDistanceM(target, a, b);
      if (segD < minDist) minDist = segD;
    }

    const allowedDist = POI_INFO[cat].radius + 100;
    if (minDist > allowedDist) {
      return flagged('capture_out_of_range', distanceM, movingS, maxSpeed);
    }

    validCaptures.push({
      poiId,
      name: cap.name.trim(),
      category: cat,
      rarity: rar,
      lat: cap.lat,
      lng: cap.lng,
      cityId: cap.cityId ?? null,
    });

    if (!existingCaptureIds.has(poiId)) {
      captureXp += RARITY_XP[rar];
    }
  }

  const cellXp = Math.floor(authoritativeNewCells * XP.perCell[payload.modality]);
  const baseXp = distXp + cellXp + coinXp + captureXp;
  const xpEarned = Math.round(baseXp * xpMultiplier);
  const coinsEarned = Math.round(coinsValue * coinsMultiplier);

  return {
    status: 'verified',
    reason: null,
    distanceM,
    movingS,
    maxSpeed,
    newCells: authoritativeNewCells,
    baseXp,
    baseCoins: coinsValue,
    fogMultiplier,
    xpEarned,
    coinsEarned,
    coinsCount,
    validCaptures,
    consumedBoostUsageIds,
  };
}
