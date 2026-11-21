// Motor puro de sincronização online com o Supabase (testável diretamente no Node 24).
// Não importa react-native, expo-* nem módulos com variante por plataforma (.web.ts).
import type { SupabaseClient } from '@supabase/supabase-js';
import { gunzipSync, gzipSync } from 'fflate';
import { evaluateAchievements } from '../game/achievements.ts';
import { decodeFog, encodeFog, float64ToBytes } from '../game/binary.ts';
import { fog } from '../game/fog.ts';
import { useGame, type PersistedState } from '../game/store.ts';
import type {
  AchievementRecord,
  ActivitySource,
  ActivitySummary,
  AvatarConfig,
  Capture,
  City,
  Modality,
  PoiCategory,
  Profile,
  Rarity,
  VerificationStatus,
} from '../game/types.ts';
import {
  COSMETIC_SLOTS,
  HAIR_STYLES,
  avatarFromCharacter,
  type AvatarColorKey,
} from '../sprites/avatar.ts';
import type { BBox } from '../game/geo.ts';

export interface FogSyncState {
  revision: number;
  lastSyncedAt: number | null;
}

export interface FogSyncStore {
  get: () => Promise<FogSyncState>;
  set: (state: FogSyncState) => Promise<void>;
}

export interface SyncDeps {
  client: SupabaseClient;
  userId: string;
  loadTrack: (activityId: string) => Promise<Float64Array | undefined>;
  saveLocalNow?: () => Promise<void>;
  onFogMerged?: () => void;
  fogSync?: FogSyncStore;
}

export interface VerifyActivityResponse {
  status: 'verified' | 'flagged';
  reason?: string;
  activity: {
    id: string;
    verificationStatus: 'verified' | 'flagged';
    distanceM: number;
    movingS: number;
    maxSpeed: number;
    xpEarned: number;
    coinsEarned: number;
    newCells: number;
  };
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

export interface SyncFogResult {
  revision: number;
  cellCount: number;
  totalCells: number;
}

let syncChain: Promise<unknown> = Promise.resolve();
let cloudGuardDepth = 0;
let memoryFogSync: FogSyncState = { revision: 0, lastSyncedAt: null };

export function isApplyingCloudState(): boolean {
  return cloudGuardDepth > 0;
}

export async function withCloudGuard<T>(fn: () => Promise<T> | T): Promise<T> {
  cloudGuardDepth++;
  try {
    return await fn();
  } finally {
    cloudGuardDepth--;
  }
}

/** Serializa operações de sincronização para manter ordem estrita (atividades antes da névoa/conquistas). */
export function withSyncLock<T>(job: () => Promise<T>): Promise<T> {
  const next = syncChain.then(job, job);
  syncChain = next.catch(() => undefined);
  return next;
}

/** Cópia em ArrayBuffer alinhado (necessário para upload no Supabase Storage no React Native). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

interface FileReaderLike {
  result: ArrayBuffer | string | null;
  error: unknown;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  readAsArrayBuffer(blob: Blob): void;
}

export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  const FileReaderCtor = (globalThis as { FileReader?: new () => FileReaderLike }).FileReader;
  if (typeof FileReaderCtor === 'function') {
    return await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReaderCtor();
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(new Uint8Array(reader.result));
        } else {
          reject(new Error('Leitura de Blob não retornou ArrayBuffer'));
        }
      };
      reader.onerror = () => reject(reader.error ?? new Error('Falha ao ler Blob'));
      reader.readAsArrayBuffer(blob);
    });
  }
  return new Uint8Array(await new Response(blob).arrayBuffer());
}

function maybeGunzip(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return gunzipSync(bytes);
  }
  return bytes;
}

async function getFogSync(deps: SyncDeps): Promise<FogSyncState> {
  if (deps.fogSync) return deps.fogSync.get();
  return memoryFogSync;
}

async function setFogSync(deps: SyncDeps, state: FogSyncState): Promise<void> {
  if (deps.fogSync) {
    await deps.fogSync.set(state);
  } else {
    memoryFogSync = state;
  }
}

const VALID_HAIR_STYLES = new Set<string>(HAIR_STYLES.map((h) => h.id));
const VALID_COSMETIC_SLOTS = new Set<string>(COSMETIC_SLOTS);
const AVATAR_COLOR_KEYS: readonly AvatarColorKey[] = [
  'skin',
  'hair',
  'top',
  'bottom',
  'shoe',
  'helmet',
  'bike',
];

export function isValidAvatarConfig(value: unknown): value is AvatarConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as { hair?: unknown; colors?: unknown; cosmetics?: unknown };
  if (typeof obj.hair !== 'string' || !VALID_HAIR_STYLES.has(obj.hair)) return false;
  if (!obj.colors || typeof obj.colors !== 'object' || Array.isArray(obj.colors)) return false;
  const colors = obj.colors as Record<string, unknown>;
  for (const key of AVATAR_COLOR_KEYS) {
    const color = colors[key];
    if (typeof color !== 'string' || color.trim().length === 0) return false;
  }
  if (obj.cosmetics !== undefined) {
    if (!obj.cosmetics || typeof obj.cosmetics !== 'object' || Array.isArray(obj.cosmetics)) {
      return false;
    }
    const cos = obj.cosmetics as Record<string, unknown>;
    for (const [slot, val] of Object.entries(cos)) {
      if (!VALID_COSMETIC_SLOTS.has(slot)) return false;
      if (val === undefined) continue;
      if (typeof val !== 'string' || val.trim().length === 0 || val.trim().length > 64) {
        return false;
      }
    }
  }
  return true;
}

async function runProfile(deps: SyncDeps): Promise<void> {
  const s = useGame.getState();
  if (!s.profile) return;

  const avatarConfig = isValidAvatarConfig(s.profile.avatar)
    ? s.profile.avatar
    : avatarFromCharacter(s.profile.characterId);

  const payload: Record<string, unknown> = {
    display_name: s.profile.name.trim().slice(0, 32) || 'Viajante',
    modality: s.profile.modality,
    character_id: s.profile.characterId.trim().slice(0, 40) || 'custom',
    avatar_config: avatarConfig,
    settings: { sound: s.settings.sound, haptics: s.settings.haptics },
    updated_at: new Date().toISOString(),
  };

  if (typeof s.profile.username === 'string' && /^[a-z0-9_]{3,24}$/.test(s.profile.username)) {
    payload.username = s.profile.username;
  }
  if (typeof s.profile.isPublic === 'boolean') {
    payload.is_public = s.profile.isPublic;
  }

  const { error } = await deps.client
    .from('profiles')
    .update(payload)
    .eq('id', deps.userId);

  if (error) {
    throw new Error(`Falha ao sincronizar perfil: ${error.message}`);
  }
}

async function runActivity(
  deps: SyncDeps,
  activity: ActivitySummary,
  opts?: { track?: Float64Array | number[]; source?: ActivitySource; boostUsageIds?: string[] },
): Promise<VerifyActivityResponse | null> {
  let floats: Float64Array | undefined;
  if (opts?.track) {
    floats = opts.track instanceof Float64Array ? opts.track : new Float64Array(opts.track);
  } else {
    floats = await deps.loadTrack(activity.id);
  }

  if (!floats || floats.length < 3) {
    return null;
  }

  const gz = gzipSync(float64ToBytes(floats), { level: 6 });
  const trackPath = `${deps.userId}/${activity.id}.bin.gz`;

  const { error: uploadErr } = await deps.client.storage
    .from('activity-tracks')
    .upload(trackPath, toArrayBuffer(gz), {
      contentType: 'application/gzip',
      upsert: true,
    });

  if (uploadErr) {
    throw new Error(`Falha ao enviar trilha da atividade ${activity.id}: ${uploadErr.message}`);
  }

  const s = useGame.getState();
  const capturesPayload = activity.captures
    .map((poiId) => s.captures[poiId])
    .filter((c): c is Capture => Boolean(c))
    .map((c) => ({
      poiId: c.id,
      name: c.name,
      category: c.category,
      rarity: c.rarity,
      lng: c.lng,
      lat: c.lat,
      cityId: c.cityId,
      capturedAt: c.capturedAt,
    }));

  const source: ActivitySource =
    opts?.source ?? activity.source ?? (activity.id.startsWith('imp_') ? 'gpx_import' : 'live');

  const boostIds = opts?.boostUsageIds?.length
    ? opts.boostUsageIds
    : activity.boostUsageIds?.length
      ? activity.boostUsageIds
      : undefined;

  const body = {
    activityId: activity.id,
    source,
    modality: activity.modality,
    startedAt: activity.startedAt,
    endedAt: activity.endedAt,
    trackPath,
    clientSummary: {
      distanceM: activity.distanceM,
      movingS: activity.movingS,
      maxSpeed: activity.maxSpeed,
      newCells: activity.newCells,
      coinsCount: activity.coinsCount,
      coinsValue: activity.coinsValue,
      ...(activity.coinsByKind ? { coinsByKind: activity.coinsByKind } : {}),
      ...(capturesPayload.length > 0 ? { captures: capturesPayload } : {}),
      ...(activity.cityIds.length > 0 ? { cityIds: activity.cityIds } : {}),
    },
    ...(boostIds ? { boostUsageIds: boostIds } : {}),
  };

  const { data, error: fnErr } = await deps.client.functions.invoke<VerifyActivityResponse>(
    'verify-activity',
    { body },
  );

  if (fnErr || !data) {
    throw new Error(`Falha ao verificar atividade ${activity.id}: ${fnErr?.message ?? 'resposta vazia'}`);
  }

  await withCloudGuard(async () => {
    useGame.getState().reconcileVerifiedActivity({
      activityId: activity.id,
      verificationStatus: data.status,
      verificationReason: data.reason ?? null,
      distanceM: data.activity.distanceM,
      movingS: data.activity.movingS,
      maxSpeed: data.activity.maxSpeed,
      xpEarned: data.activity.xpEarned,
      coinsEarned: data.activity.coinsEarned,
      newCells: data.activity.newCells,
      authoritative: data.authoritative,
    });
    useGame.setState({
      cloudUserId: deps.userId,
      cloudSyncedAt: Date.now(),
    });
    await deps.saveLocalNow?.();
  });

  return data;
}

async function downloadAndMergeFog(deps: SyncDeps, storagePath: string): Promise<number> {
  const { data: blob, error } = await deps.client.storage
    .from('fog-snapshots')
    .download(storagePath, {
      cacheNonce: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    });

  if (error || !blob) {
    throw new Error(
      `Falha ao baixar snapshot de névoa (${storagePath}): ${error?.message ?? 'resposta vazia'}`,
    );
  }

  const raw = await blobToBytes(blob);
  let plain: Uint8Array;
  try {
    plain = maybeGunzip(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Falha ao descompactar snapshot de névoa (${storagePath}): ${msg}`);
  }
  const remoteFog = decodeFog(plain);
  if (!remoteFog) {
    throw new Error(`Snapshot de névoa remoto inválido (${storagePath})`);
  }

  const added = fog.merge(remoteFog);
  if (added > 0 || remoteFog.cityIds.length > 1) {
    deps.onFogMerged?.();
  }
  return added;
}

async function runFog(
  deps: SyncDeps,
  opts?: { forceUpload?: boolean; expectedRevision?: number },
): Promise<SyncFogResult> {
  const localSync = await getFogSync(deps);
  const { data: fogRow, error: fogErr } = await deps.client
    .from('user_fog_state')
    .select('storage_path, cell_count, revision')
    .eq('user_id', deps.userId)
    .maybeSingle();

  if (fogErr) {
    throw new Error(`Falha ao consultar estado da névoa: ${fogErr.message}`);
  }

  let remotePath: string | null = (fogRow?.storage_path as string | null) ?? null;
  let expectedRevision =
    opts?.expectedRevision !== undefined
      ? opts.expectedRevision
      : typeof fogRow?.revision === 'number'
        ? fogRow.revision
        : localSync.revision;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (remotePath) {
      await downloadAndMergeFog(deps, remotePath);
    }

    const serialized = fog.serialize();
    if (serialized.keys.length === 0) {
      const now = Date.now();
      await setFogSync(deps, { revision: expectedRevision, lastSyncedAt: now });
      return {
        revision: expectedRevision,
        cellCount: 0,
        totalCells: useGame.getState().totals.cells,
      };
    }

    if (
      !opts?.forceUpload &&
      attempt === 0 &&
      fogRow &&
      typeof fogRow.cell_count === 'number' &&
      serialized.keys.length === fogRow.cell_count &&
      opts?.expectedRevision === undefined
    ) {
      const now = Date.now();
      await setFogSync(deps, { revision: fogRow.revision as number, lastSyncedAt: now });
      return {
        revision: fogRow.revision as number,
        cellCount: fogRow.cell_count,
        totalCells: useGame.getState().totals.cells,
      };
    }

    const storagePath = `${deps.userId}/fog.bin.gz`;
    const gz = gzipSync(encodeFog(serialized), { level: 6 });

    const { error: upErr } = await deps.client.storage
      .from('fog-snapshots')
      .upload(storagePath, toArrayBuffer(gz), {
        contentType: 'application/gzip',
        cacheControl: '0',
        upsert: true,
      });

    if (upErr) {
      throw new Error(`Falha ao enviar snapshot da névoa: ${upErr.message}`);
    }

    const { data: rpcData, error: rpcErr } = await deps.client.rpc('upsert_fog_state', {
      p_storage_path: storagePath,
      p_cell_count: serialized.keys.length,
      p_expected_revision: expectedRevision,
    });

    if (rpcErr || !rpcData) {
      throw new Error(`Falha no upsert_fog_state: ${rpcErr?.message ?? 'resposta vazia'}`);
    }

    const res = rpcData as {
      conflict: boolean;
      revision: number;
      storage_path: string | null;
      cell_count: number;
      total_cells: number;
    };

    if (!res.conflict) {
      const now = Date.now();
      await setFogSync(deps, { revision: res.revision, lastSyncedAt: now });
      await withCloudGuard(async () => {
        const s = useGame.getState();
        useGame.setState({
          totals: {
            ...s.totals,
            cells: Math.max(serialized.keys.length, res.total_cells),
          },
          cloudSyncedAt: now,
          lastSyncedAt: now,
        });
        await deps.saveLocalNow?.();
      });
      return {
        revision: res.revision,
        cellCount: res.cell_count,
        totalCells: res.total_cells,
      };
    }

    remotePath = res.storage_path;
    expectedRevision = res.revision;
  }

  throw new Error('Conflito persistente ao sincronizar névoa após 3 tentativas');
}

interface RemoteCityRow {
  city_id: string;
  name: string;
  state: string | null;
  country: string | null;
  area_m2: number;
  bbox: number[];
  cells: number;
  cell_area_m2: number;
  discovered_at: string;
}

interface RemoteCaptureRow {
  poi_id: string;
  name: string;
  category: PoiCategory;
  rarity: Rarity;
  lng: number;
  lat: number;
  city_id: string | null;
  activity_id: string | null;
  captured_at: string;
  is_verified: boolean;
}

function isValidCityForDb(c: City): boolean {
  return (
    typeof c.id === 'string' &&
    c.id.trim().length > 0 &&
    c.id.trim().length <= 120 &&
    typeof c.name === 'string' &&
    c.name.trim().length > 0 &&
    c.name.trim().length <= 120 &&
    Number.isFinite(c.areaM2) &&
    c.areaM2 >= 0 &&
    Number.isFinite(c.cellAreaM2) &&
    c.cellAreaM2 >= 0 &&
    Number.isFinite(c.cells) &&
    c.cells >= 0 &&
    Array.isArray(c.bbox) &&
    c.bbox.length === 4 &&
    c.bbox.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

function mapRemoteCity(row: RemoteCityRow): City {
  return {
    id: row.city_id,
    name: row.name,
    ...(row.state ? { state: row.state } : {}),
    ...(row.country ? { country: row.country } : {}),
    areaM2: row.area_m2,
    bbox: row.bbox as BBox,
    cells: row.cells,
    cellAreaM2: row.cell_area_m2,
    discoveredAt: Date.parse(row.discovered_at) || Date.now(),
  };
}

function mapRemoteCapture(row: RemoteCaptureRow): Capture {
  return {
    id: row.poi_id,
    name: row.name,
    category: row.category,
    rarity: row.rarity,
    lng: row.lng,
    lat: row.lat,
    cityId: row.city_id,
    activityId: row.activity_id,
    capturedAt: Date.parse(row.captured_at) || Date.now(),
  };
}

async function runCitiesAndCaptures(deps: SyncDeps): Promise<void> {
  const s0 = useGame.getState();

  // 1. Cidades: upsert válidas e mescla com servidor
  const validLocalCities = Object.values(s0.cities).filter(isValidCityForDb);
  if (validLocalCities.length > 0) {
    const cityRows = validLocalCities.map((c) => ({
      user_id: deps.userId,
      city_id: c.id.trim(),
      name: c.name.trim(),
      state: c.state ?? null,
      country: c.country ?? null,
      area_m2: c.areaM2,
      bbox: c.bbox,
      cells: Math.max(0, Math.floor(c.cells)),
      cell_area_m2: c.cellAreaM2,
      discovered_at: new Date(c.discoveredAt || Date.now()).toISOString(),
    }));
    const { error: cityUpErr } = await deps.client
      .from('user_cities')
      .upsert(cityRows, { onConflict: 'user_id,city_id' });

    if (cityUpErr) {
      throw new Error(`Falha ao enviar cidades: ${cityUpErr.message}`);
    }
  }

  const { data: remoteCitiesRaw, error: citySelErr } = await deps.client
    .from('user_cities')
    .select('city_id, name, state, country, area_m2, bbox, cells, cell_area_m2, discovered_at')
    .eq('user_id', deps.userId);

  if (citySelErr) {
    throw new Error(`Falha ao consultar cidades remotas: ${citySelErr.message}`);
  }

  // 2. Capturas: consultar existentes e inserir apenas ausentes (sem is_verified e sem UPDATE)
  const { data: remoteCapsRaw, error: capSelErr } = await deps.client
    .from('user_captures')
    .select('poi_id, name, category, rarity, lng, lat, city_id, activity_id, captured_at, is_verified')
    .eq('user_id', deps.userId);

  if (capSelErr) {
    throw new Error(`Falha ao consultar capturas remotas: ${capSelErr.message}`);
  }

  const remoteCaps = (remoteCapsRaw ?? []) as RemoteCaptureRow[];
  const existingPoiIds = new Set(remoteCaps.map((r) => r.poi_id));

  const missingLocalCaptures = Object.values(s0.captures)
    .filter(
      (c) =>
        !existingPoiIds.has(c.id) &&
        c.id.trim().length > 0 &&
        c.name.trim().length > 0 &&
        c.lng >= -180 &&
        c.lng <= 180 &&
        c.lat >= -90 &&
        c.lat <= 90,
    )
    .map((c) => ({
      user_id: deps.userId,
      poi_id: c.id.trim(),
      name: c.name.trim().slice(0, 160),
      category: c.category,
      rarity: c.rarity,
      lng: c.lng,
      lat: c.lat,
      city_id: c.cityId ?? null,
      activity_id: c.activityId ?? null,
      captured_at: new Date(c.capturedAt || Date.now()).toISOString(),
    }));

  if (missingLocalCaptures.length > 0) {
    const { error: capInsErr } = await deps.client
      .from('user_captures')
      .upsert(missingLocalCaptures, { onConflict: 'user_id,poi_id', ignoreDuplicates: true });

    if (capInsErr) {
      throw new Error(`Falha ao enviar capturas ausentes: ${capInsErr.message}`);
    }
  }

  await withCloudGuard(async () => {
    const cur = useGame.getState();
    const mergedCities: Record<string, City> = { ...cur.cities };
    for (const row of (remoteCitiesRaw ?? []) as RemoteCityRow[]) {
      const mapped = mapRemoteCity(row);
      const local = mergedCities[mapped.id];
      mergedCities[mapped.id] = local
        ? { ...mapped, cells: Math.max(local.cells, mapped.cells) }
        : mapped;
    }

    const mergedCaptures: Record<string, Capture> = { ...cur.captures };
    for (const row of remoteCaps) {
      mergedCaptures[row.poi_id] = mapRemoteCapture(row);
    }

    useGame.setState({
      cities: mergedCities,
      captures: mergedCaptures,
      totals: {
        ...cur.totals,
        captures: Math.max(cur.totals.captures, Object.keys(mergedCaptures).length),
      },
    });
    await deps.saveLocalNow?.();
  });
}

async function runAchievements(deps: SyncDeps, candidateKeys?: string[]): Promise<void> {
  const { data: remoteRows, error: selErr } = await deps.client
    .from('user_achievements')
    .select('achievement_key, unlocked_at, coins_awarded')
    .eq('user_id', deps.userId);

  if (selErr) {
    throw new Error(`Falha ao consultar conquistas remotas: ${selErr.message}`);
  }

  const remoteMap = new Map<string, AchievementRecord>();
  for (const r of remoteRows ?? []) {
    const key = r.achievement_key as string;
    remoteMap.set(key, {
      at: Date.parse(r.unlocked_at as string) || Date.now(),
      coins: (r.coins_awarded as number) ?? 0,
    });
  }

  const s = useGame.getState();
  const evalKeys = evaluateAchievements(s).map((u) => u.key);
  const pool = candidateKeys?.length
    ? [...new Set([...candidateKeys, ...Object.keys(s.achievements), ...evalKeys])]
    : [...new Set([...Object.keys(s.achievements), ...evalKeys])];

  const toClaim = pool.filter((k) => !remoteMap.has(k));
  let latestWallet: number | null = null;

  for (const key of toClaim) {
    const { data, error } = await deps.client.rpc('claim_achievement', {
      p_achievement_key: key,
    });
    if (error) {
      if (error.code === 'P0001') {
        continue;
      }
      console.warn('[sync] claim_achievement falhou para', key, error.message);
      continue;
    }
    if (data) {
      const res = data as {
        achievement_key: string;
        already_claimed: boolean;
        coins_awarded: number;
        wallet: number;
      };
      remoteMap.set(res.achievement_key, {
        at: s.achievements[key]?.at ?? Date.now(),
        coins: res.coins_awarded,
      });
      if (typeof res.wallet === 'number') {
        latestWallet = res.wallet;
      }
    }
  }

  await withCloudGuard(async () => {
    const cur = useGame.getState();
    const merged: Record<string, AchievementRecord> = { ...cur.achievements };
    for (const [k, rec] of remoteMap) {
      merged[k] = rec;
    }
    useGame.setState({
      achievements: merged,
      ...(latestWallet !== null ? { wallet: latestWallet } : {}),
    });
    await deps.saveLocalNow?.();
  });
}

async function runPullCloudToLocal(
  deps: SyncDeps,
  opts?: { mode?: 'merge' | 'replace' },
): Promise<void> {
  const mode = opts?.mode ?? 'merge';

  const [profRes, actRes, cityRes, capRes, achRes, fogRes] = await Promise.all([
    deps.client.from('profiles').select('*').eq('id', deps.userId).single(),
    deps.client
      .from('activities')
      .select('*')
      .eq('user_id', deps.userId)
      .order('started_at', { ascending: false })
      .limit(200),
    deps.client.from('user_cities').select('*').eq('user_id', deps.userId),
    deps.client.from('user_captures').select('*').eq('user_id', deps.userId),
    deps.client.from('user_achievements').select('*').eq('user_id', deps.userId),
    deps.client.from('user_fog_state').select('*').eq('user_id', deps.userId).maybeSingle(),
  ]);

  if (profRes.error || !profRes.data) {
    throw new Error(`Falha ao carregar perfil da nuvem: ${profRes.error?.message ?? 'ausente'}`);
  }
  if (actRes.error) throw new Error(`Falha ao carregar atividades: ${actRes.error.message}`);
  if (cityRes.error) throw new Error(`Falha ao carregar cidades: ${cityRes.error.message}`);
  if (capRes.error) throw new Error(`Falha ao carregar capturas: ${capRes.error.message}`);
  if (achRes.error) throw new Error(`Falha ao carregar conquistas: ${achRes.error.message}`);
  if (fogRes.error) throw new Error(`Falha ao carregar névoa: ${fogRes.error.message}`);

  const prof = profRes.data as {
    id: string;
    username: string | null;
    display_name: string;
    modality: Modality;
    character_id: string;
    avatar_config: unknown;
    xp: number;
    level: number;
    wallet: number;
    total_distance_m: number;
    total_moving_s: number;
    total_activities: number;
    total_coins_value: number;
    total_coins_count: number;
    total_captures: number;
    total_cells: number;
    achievements_count: number;
    settings: { sound?: boolean; haptics?: boolean };
    is_public: boolean;
    created_at: string;
  };

  const fogState = fogRes.data as {
    storage_path: string;
    cell_count: number;
    revision: number;
  } | null;

  if (fogState?.storage_path) {
    const { data: blob, error: dlErr } = await deps.client.storage
      .from('fog-snapshots')
      .download(fogState.storage_path, {
        cacheNonce: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      });
    if (dlErr || !blob) {
      throw new Error(
        `Falha ao baixar snapshot de névoa (${fogState.storage_path}): ${dlErr?.message ?? 'resposta vazia'}`,
      );
    }
    const raw = await blobToBytes(blob);
    let plain: Uint8Array;
    try {
      plain = maybeGunzip(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Falha ao descompactar snapshot de névoa (${fogState.storage_path}): ${msg}`);
    }
    const remoteFog = decodeFog(plain);
    if (!remoteFog) {
      throw new Error(`Snapshot de névoa remoto inválido (${fogState.storage_path})`);
    }
    if (mode === 'replace') fog.load(remoteFog);
    else fog.merge(remoteFog);
  } else if (mode === 'replace') {
    fog.clear();
  }

  const now = Date.now();
  await setFogSync(deps, {
    revision: fogState?.revision ?? 0,
    lastSyncedAt: now,
  });

  const validAvatar = isValidAvatarConfig(prof.avatar_config) ? prof.avatar_config : undefined;
  const remoteProfile: Profile = {
    name: prof.display_name,
    characterId: prof.character_id,
    ...(validAvatar ? { avatar: validAvatar } : {}),
    modality: prof.modality,
    createdAt: Date.parse(prof.created_at) || now,
    ...(prof.username ? { username: prof.username } : {}),
    isPublic: prof.is_public,
    cloudUserId: deps.userId,
    cloudSyncedAt: now,
  };

  const remoteActivities: ActivitySummary[] = (actRes.data ?? []).map((a) => ({
    id: a.id as string,
    modality: a.modality as Modality,
    startedAt: Date.parse(a.started_at as string) || 0,
    endedAt: Date.parse(a.ended_at as string) || 0,
    elapsedS: (a.elapsed_s as number) ?? 0,
    movingS: (a.moving_s as number) ?? 0,
    distanceM: (a.distance_m as number) ?? 0,
    maxSpeed: (a.max_speed as number) ?? 0,
    coinsValue: (a.coins_value as number) ?? 0,
    coinsCount: (a.coins_count as number) ?? 0,
    captures: Array.isArray(a.capture_ids) ? (a.capture_ids as string[]) : [],
    newCells: (a.new_cells as number) ?? 0,
    xp: (a.xp as number) ?? 0,
    cityIds: Array.isArray(a.city_ids) ? (a.city_ids as string[]) : [],
    source: (a.source as ActivitySource) ?? 'live',
    verificationStatus: (a.verification_status as VerificationStatus) ?? 'verified',
    verificationReason: (a.verification_reason as string | null) ?? null,
  }));

  const remoteCities: Record<string, City> = {};
  for (const row of (cityRes.data ?? []) as RemoteCityRow[]) {
    const c = mapRemoteCity(row);
    remoteCities[c.id] = c;
  }

  const remoteCaptures: Record<string, Capture> = {};
  for (const row of (capRes.data ?? []) as RemoteCaptureRow[]) {
    const c = mapRemoteCapture(row);
    remoteCaptures[c.id] = c;
  }

  const remoteAchievements: Record<string, AchievementRecord> = {};
  for (const row of achRes.data ?? []) {
    remoteAchievements[row.achievement_key as string] = {
      at: Date.parse(row.unlocked_at as string) || now,
      coins: (row.coins_awarded as number) ?? 0,
    };
  }

  await withCloudGuard(async () => {
    const cur = useGame.getState();

    let finalActivities = remoteActivities;
    let finalCities = remoteCities;
    let finalCaptures = remoteCaptures;
    let finalAchievements = remoteAchievements;

    if (mode === 'merge') {
      const byId = new Map<string, ActivitySummary>();
      for (const a of cur.activities) byId.set(a.id, a);
      for (const a of remoteActivities) byId.set(a.id, a);
      finalActivities = [...byId.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 200);

      finalCities = { ...cur.cities };
      for (const [id, c] of Object.entries(remoteCities)) {
        const local = finalCities[id];
        finalCities[id] = local ? { ...c, cells: Math.max(local.cells, c.cells) } : c;
      }

      finalCaptures = { ...cur.captures, ...remoteCaptures };
      finalAchievements = { ...cur.achievements, ...remoteAchievements };
    }

    const snapshot: Partial<PersistedState> = {
      profile: remoteProfile,
      xp: prof.xp,
      wallet: prof.wallet,
      totals: {
        distanceM: prof.total_distance_m,
        movingS: prof.total_moving_s,
        activities: prof.total_activities,
        coinsValue: prof.total_coins_value,
        coinsCount: prof.total_coins_count,
        captures: prof.total_captures,
        cells: mode === 'merge' ? Math.max(fog.size, prof.total_cells) : prof.total_cells,
      },
      cities: finalCities,
      captures: finalCaptures,
      activities: finalActivities,
      achievements: finalAchievements,
      settings: {
        ...cur.settings,
        sound: typeof prof.settings?.sound === 'boolean' ? prof.settings.sound : cur.settings.sound,
        haptics: typeof prof.settings?.haptics === 'boolean' ? prof.settings.haptics : cur.settings.haptics,
      },
      cloudUserId: deps.userId,
      cloudSyncedAt: now,
    };

    useGame.getState().applyCloudSnapshot(snapshot);
    useGame.setState({ lastSyncedAt: now, lastSyncError: null });
    deps.onFogMerged?.();
    await deps.saveLocalNow?.();
  });
}

// ---------------------------------------------------------------------------
// API pública serializada (usada por sync.ts e verify-sync-core.ts)
// ---------------------------------------------------------------------------

export function syncProfile(deps: SyncDeps): Promise<void> {
  return withSyncLock(() => runProfile(deps));
}

export function syncActivity(
  deps: SyncDeps,
  activity: ActivitySummary,
  opts?: { track?: Float64Array | number[]; source?: ActivitySource; boostUsageIds?: string[] },
): Promise<VerifyActivityResponse | null> {
  return withSyncLock(() => runActivity(deps, activity, opts));
}

export function syncFog(
  deps: SyncDeps,
  opts?: { forceUpload?: boolean; expectedRevision?: number },
): Promise<SyncFogResult> {
  return withSyncLock(() => runFog(deps, opts));
}

export function syncCitiesAndCaptures(deps: SyncDeps): Promise<void> {
  return withSyncLock(() => runCitiesAndCaptures(deps));
}

export function syncAchievements(deps: SyncDeps, candidateKeys?: string[]): Promise<void> {
  return withSyncLock(() => runAchievements(deps, candidateKeys));
}

export function pullCloudToLocal(
  deps: SyncDeps,
  opts?: { mode?: 'merge' | 'replace' },
): Promise<void> {
  return withSyncLock(() => runPullCloudToLocal(deps, opts));
}

export function pushAllLocalToCloud(deps: SyncDeps): Promise<void> {
  return withSyncLock(async () => {
    await runProfile(deps);

    const { data: existingActs, error: actsErr } = await deps.client
      .from('activities')
      .select('id')
      .eq('user_id', deps.userId);

    if (actsErr) {
      throw new Error(`Falha ao listar atividades remotas: ${actsErr.message}`);
    }

    const remoteIds = new Set((existingActs ?? []).map((r) => r.id as string));
    const localChronological = [...useGame.getState().activities].reverse();

    for (const act of localChronological) {
      if (remoteIds.has(act.id)) continue;
      await runActivity(deps, act);
    }

    await runCitiesAndCaptures(deps);
    await runFog(deps, { forceUpload: fog.size > 0 });
    await runAchievements(deps);
    await runPullCloudToLocal(deps, { mode: 'merge' });
  });
}

/** Sequência atômica executada após concluir uma atividade ao vivo ou importar GPX. */
export function syncActivitiesSequence(
  deps: SyncDeps,
  activities: ActivitySummary[],
  opts?: { source?: ActivitySource },
): Promise<void> {
  return withSyncLock(async () => {
    for (const act of activities) {
      await runActivity(deps, act, { source: opts?.source ?? act.source });
    }
    await runCitiesAndCaptures(deps);
    await runFog(deps, { forceUpload: fog.size > 0 });
    await runAchievements(deps);
  });
}
