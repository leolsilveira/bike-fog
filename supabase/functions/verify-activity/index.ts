// Edge Function verify-activity: valida trilhas GPS do Storage, calcula XP/moedas
// autoritativos com paridade 1:1 ao cliente e grava atomicamente via commit_verified_activity_v2.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from '@supabase/supabase-js';
import {
  evaluateTrack,
  type ValidatedBooster,
  type VerifyActivityPayload,
} from './validator.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_DECOMPRESSED_BYTES = 24 * 1024 * 1024; // 24 MiB (~1M pontos Float64 [lng, lat, t])
const ACTIVITY_ID_RE = /^[A-Za-z0-9_-]{3,80}$/;
const TRACK_PATH_RE = /^[0-9a-f-]+\/[A-Za-z0-9_.-]+\.bin\.gz$/;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      Connection: 'keep-alive',
    },
  });
}

function getServiceRoleKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  const secretMapRaw = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (secretMapRaw) {
    try {
      const parsed = JSON.parse(secretMapRaw) as Record<string, string>;
      if (parsed.default) return parsed.default;
    } catch {
      // ignora JSON inválido
    }
  }
  throw new Error('SUPABASE_SERVICE_ROLE_KEY ausente');
}

async function gunzipLimited(compressed: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (compressed.length < 2 || compressed[0] !== 0x1f || compressed[1] !== 0x8b) {
    throw new Error('invalid_gzip_magic');
  }
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const writePromise = writer
    .write(compressed as unknown as BufferSource)
    .then(() => writer.close());

  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('decompressed_limit_exceeded');
        throw new Error('payload_too_large');
      }
      chunks.push(value);
    }
  }
  await writePromise;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function isNonNegFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function isValidPayload(raw: unknown): raw is VerifyActivityPayload {
  if (!raw || typeof raw !== 'object') return false;
  const p = raw as Partial<VerifyActivityPayload>;
  if (typeof p.activityId !== 'string' || !ACTIVITY_ID_RE.test(p.activityId)) return false;
  if (p.source !== 'live' && p.source !== 'gpx_import') return false;
  if (p.modality !== 'bike' && p.modality !== 'run') return false;
  if (
    typeof p.startedAt !== 'number' ||
    typeof p.endedAt !== 'number' ||
    !Number.isFinite(p.startedAt) ||
    !Number.isFinite(p.endedAt) ||
    p.startedAt < 946684800000 ||
    p.endedAt < p.startedAt ||
    p.endedAt > Date.now() + 86_400_000
  ) {
    return false;
  }
  if (typeof p.trackPath !== 'string' || p.trackPath.length > 260) return false;
  if (!p.clientSummary || typeof p.clientSummary !== 'object') return false;
  const cs = p.clientSummary as Partial<VerifyActivityPayload['clientSummary']>;
  if (
    !isNonNegFinite(cs.distanceM) ||
    !isNonNegFinite(cs.movingS) ||
    !isNonNegFinite(cs.maxSpeed) ||
    !isNonNegFinite(cs.newCells) ||
    !isNonNegFinite(cs.coinsCount) ||
    !isNonNegFinite(cs.coinsValue)
  ) {
    return false;
  }
  return true;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Método não permitido' }, 405);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  const token = match?.[1]?.trim();
  if (!token || token.startsWith('sb_publishable_')) {
    return jsonResponse({ error: 'Token de usuário ausente ou inválido' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) {
    return jsonResponse({ error: 'Configuração do servidor incompleta' }, 500);
  }

  const supabaseAdmin = createClient(supabaseUrl, getServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const {
    data: { user },
    error: authError,
  } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    return jsonResponse({ error: 'Sessão inválida ou expirada' }, 401);
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return jsonResponse({ error: 'JSON inválido' }, 400);
  }

  if (!isValidPayload(rawBody)) {
    return jsonResponse({ error: 'Payload de atividade inválido' }, 400);
  }

  const payload = rawBody;

  // Proteção contra path traversal / leitura de trilha de outro usuário
  if (
    payload.trackPath.includes('..') ||
    !TRACK_PATH_RE.test(payload.trackPath) ||
    !payload.trackPath.startsWith(`${user.id}/`)
  ) {
    return jsonResponse({ error: 'Caminho de trilha não autorizado para este usuário' }, 403);
  }

  // Fast-path de idempotência: se a atividade já foi verificada antes, retorna estado atual
  const { data: existingAct } = await supabaseAdmin
    .from('activities')
    .select(
      'id, verification_status, verification_reason, distance_m, moving_s, max_speed, xp, coins_value, new_cells',
    )
    .eq('user_id', user.id)
    .eq('id', payload.activityId)
    .maybeSingle();

  if (existingAct) {
    const { data: prof } = await supabaseAdmin
      .from('profiles')
      .select(
        'xp, level, wallet, total_distance_m, total_moving_s, total_activities, total_cells, total_captures, achievements_count',
      )
      .eq('id', user.id)
      .single();

    if (prof) {
      return jsonResponse({
        status: existingAct.verification_status,
        ...(existingAct.verification_reason ? { reason: existingAct.verification_reason } : {}),
        activity: {
          id: existingAct.id,
          verificationStatus: existingAct.verification_status,
          distanceM: existingAct.distance_m,
          movingS: existingAct.moving_s,
          maxSpeed: existingAct.max_speed,
          xpEarned: existingAct.xp,
          coinsEarned: existingAct.coins_value,
          newCells: existingAct.new_cells,
        },
        authoritative: {
          xp: prof.xp,
          level: prof.level,
          wallet: prof.wallet,
          totalDistanceM: prof.total_distance_m,
          totalMovingS: prof.total_moving_s,
          totalActivities: prof.total_activities,
          totalCells: prof.total_cells,
          totalCaptures: prof.total_captures,
          achievementsCount: prof.achievements_count,
        },
      });
    }
  }

  // Download da trilha comprimida no bucket privado activity-tracks
  const { data: blob, error: dlError } = await supabaseAdmin.storage
    .from('activity-tracks')
    .download(payload.trackPath);

  if (dlError || !blob) {
    return jsonResponse({ error: 'Arquivo de trilha não encontrado no Storage' }, 404);
  }

  const compressed = new Uint8Array(await blob.arrayBuffer());
  let decompressed: Uint8Array;
  try {
    decompressed = await gunzipLimited(compressed, MAX_DECOMPRESSED_BYTES);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg === 'payload_too_large') {
      return jsonResponse({ error: 'Trilha excede o limite de tamanho após descompressão' }, 413);
    }
    return jsonResponse({ error: 'Arquivo de trilha gzip inválido' }, 400);
  }

  if (decompressed.byteLength === 0 || decompressed.byteLength % 24 !== 0) {
    return jsonResponse({ error: 'Binário de trilha Float64 malformado' }, 400);
  }

  const aligned = new ArrayBuffer(decompressed.byteLength);
  new Uint8Array(aligned).set(decompressed);
  const floats = new Float64Array(aligned);

  // Consultar capturas já existentes para evitar XP duplicado em POIs já capturados
  const existingCaptureIds = new Set<string>();
  const claimedPoiIds = Array.isArray(payload.clientSummary.captures)
    ? payload.clientSummary.captures
        .map((c) => (c && typeof c.poiId === 'string' ? c.poiId.trim() : ''))
        .filter((id) => id.length > 0)
    : [];

  if (claimedPoiIds.length > 0) {
    const { data: existingCaps } = await supabaseAdmin
      .from('user_captures')
      .select('poi_id')
      .eq('user_id', user.id)
      .eq('is_verified', true)
      .in('poi_id', claimedPoiIds);

    for (const row of existingCaps ?? []) {
      existingCaptureIds.add(row.poi_id as string);
    }
  }

  // Consultar boosters elegíveis (apenas para atividades ao vivo)
  const validatedBoosters: ValidatedBooster[] = [];
  const requestedBoostIds = Array.isArray(payload.boostUsageIds)
    ? payload.boostUsageIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];

  if (payload.source === 'live' && requestedBoostIds.length > 0) {
    const { data: usages } = await supabaseAdmin
      .from('user_boost_usages')
      .select('id, item_id, activity_id, activated_at, expires_at, consumed_at')
      .eq('user_id', user.id)
      .in('id', requestedBoostIds)
      .is('consumed_at', null);

    if (usages && usages.length > 0) {
      const itemIds = [...new Set(usages.map((u) => u.item_id as string))];
      const [{ data: invRows }, { data: itemRows }] = await Promise.all([
        supabaseAdmin
          .from('user_inventory')
          .select('item_id, quantity')
          .eq('user_id', user.id)
          .in('item_id', itemIds)
          .gt('quantity', 0),
        supabaseAdmin
          .from('store_items')
          .select('id, category, metadata')
          .in('id', itemIds),
      ]);

      const invMap = new Map<string, number>();
      for (const inv of invRows ?? []) {
        invMap.set(inv.item_id as string, inv.quantity as number);
      }

      const itemMap = new Map<string, { category: string; metadata: Record<string, unknown> }>();
      for (const it of itemRows ?? []) {
        itemMap.set(it.id as string, {
          category: it.category as string,
          metadata: (it.metadata ?? {}) as Record<string, unknown>,
        });
      }

      for (const usage of usages) {
        if (usage.activity_id && usage.activity_id !== payload.activityId) continue;
        const activatedMs = Date.parse(usage.activated_at as string);
        const expiresMs = usage.expires_at ? Date.parse(usage.expires_at as string) : null;
        if (!Number.isFinite(activatedMs) || activatedMs > payload.endedAt) continue;
        if (expiresMs !== null && (!Number.isFinite(expiresMs) || expiresMs < payload.startedAt)) {
          continue;
        }
        const qty = invMap.get(usage.item_id as string) ?? 0;
        if (qty <= 0) continue;

        const item = itemMap.get(usage.item_id as string);
        if (
          !item ||
          (item.category !== 'boost_xp' &&
            item.category !== 'boost_fog' &&
            item.category !== 'boost_coins')
        ) {
          continue;
        }

        const rawMult = Number(item.metadata?.multiplier ?? 1);
        validatedBoosters.push({
          id: usage.id as string,
          itemId: usage.item_id as string,
          category: item.category,
          multiplier: Number.isFinite(rawMult) ? rawMult : 1,
        });
      }
    }
  }

  const evaluation = evaluateTrack(floats, payload, existingCaptureIds, validatedBoosters);

  const maxCities = Math.min(12, Math.max(3, Math.ceil(evaluation.distanceM / 5000) + 2));
  const cityIds = Array.isArray(payload.clientSummary.cityIds)
    ? [...new Set(
        payload.clientSummary.cityIds
          .filter((id): id is string => typeof id === 'string')
          .map((id) => id.trim())
          .filter((id) => id.length > 0 && id.length <= 120),
      )].slice(0, maxCities)
    : [];

  const elapsedS = Math.max(0, (payload.endedAt - payload.startedAt) / 1000);

  const { data: committed, error: rpcError } = await supabaseAdmin.rpc('commit_verified_activity_v2', {
    p_user_id: user.id,
    p_activity_id: payload.activityId,
    p_source: payload.source,
    p_modality: payload.modality,
    p_started_at: new Date(payload.startedAt).toISOString(),
    p_ended_at: new Date(payload.endedAt).toISOString(),
    p_elapsed_s: elapsedS,
    p_moving_s: evaluation.movingS,
    p_distance_m: evaluation.distanceM,
    p_max_speed: evaluation.maxSpeed,
    p_base_coins: evaluation.baseCoins,
    p_coins_count: evaluation.coinsCount,
    p_new_cells: evaluation.newCells,
    p_base_xp: evaluation.baseXp,
    p_fog_multiplier: evaluation.fogMultiplier,
    p_city_ids: cityIds,
    p_captures: evaluation.validCaptures,
    p_track_path: payload.trackPath,
    p_status: evaluation.status,
    p_reason: evaluation.reason,
    p_boost_usage_ids: evaluation.consumedBoostUsageIds,
  });

  if (rpcError || !committed) {
    console.error('commit_verified_activity_v2 error:', rpcError?.message ?? 'unknown');
    return jsonResponse({ error: 'Falha ao gravar atividade verificada' }, 500);
  }

  const res = committed as {
    status: 'verified' | 'flagged';
    reason?: string | null;
    activity: Record<string, unknown>;
    authoritative: Record<string, unknown>;
  };

  return jsonResponse({
    status: res.status,
    ...(res.reason ? { reason: res.reason } : {}),
    activity: res.activity,
    authoritative: res.authoritative,
  });
});
