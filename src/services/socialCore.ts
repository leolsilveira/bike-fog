// Lógica pura e clientes Supabase de amigos, busca, perfis públicos e rankings (testável no Node 24).
// Não importa react-native, expo-* nem módulos com variante por plataforma (.web.ts).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AvatarConfig, Modality } from '../game/types.ts';
import { avatarFromCharacter } from '../sprites/avatar.ts';
import { isValidUsername, mapAuthError, normalizeUsername } from './authCore.ts';
import { isValidAvatarConfig } from './syncCore.ts';

export type LeaderboardMetric = 'xp' | 'distance' | 'cells';
export type LeaderboardPeriod = 'all_time' | 'monthly';
export type FriendshipStatus = 'none' | 'pending' | 'accepted' | 'blocked';
export type FriendshipDirection = 'none' | 'incoming' | 'outgoing';

export interface SocialUserCard {
  id: string;
  username: string | null;
  displayName: string;
  level: number;
  xp: number;
  totalDistanceM: number;
  totalCells: number;
  avatarConfig: AvatarConfig;
  characterId: string;
  modality: Modality;
  friendshipStatus: FriendshipStatus;
  friendshipDirection: FriendshipDirection;
}

export interface PublicProfileSummary {
  id: string;
  username: string | null;
  displayName: string;
  modality: Modality;
  characterId: string;
  avatarConfig: AvatarConfig;
  level: number;
  xp: number;
  totalDistanceM: number;
  totalMovingS: number;
  totalActivities: number;
  totalCaptures: number;
  totalCells: number;
  achievementsCount: number;
  isPublic: boolean;
  friendshipStatus: FriendshipStatus;
  friendshipDirection: FriendshipDirection;
}

export interface FriendshipRow {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: 'pending' | 'accepted' | 'blocked';
  blocked_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FriendshipItem {
  friendshipId: string;
  otherUserId: string;
  status: 'pending' | 'accepted' | 'blocked';
  direction: 'incoming' | 'outgoing';
  blockedBy: string | null;
  createdAt: string;
  updatedAt: string;
  profile: PublicProfileSummary | null;
}

export interface CategorizedFriendships {
  friends: FriendshipItem[];
  incomingRequests: FriendshipItem[];
  outgoingRequests: FriendshipItem[];
  blocked: FriendshipItem[];
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string | null;
  displayName: string;
  level: number;
  xp: number;
  score: number;
  totalDistanceM: number;
  totalCells: number;
  avatarConfig: AvatarConfig;
  characterId: string;
  modality: Modality;
  isMe: boolean;
}

export interface GlobalLeaderboardResult {
  entries: LeaderboardEntry[];
  myRank: LeaderboardEntry | null;
}

export interface SendFriendRequestResult {
  status: 'pending' | 'accepted' | 'already_pending' | 'already_friends';
  friendshipId: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function toModality(value: unknown): Modality {
  return value === 'run' ? 'run' : 'bike';
}

function toFriendshipStatus(value: unknown): FriendshipStatus {
  if (value === 'pending' || value === 'accepted' || value === 'blocked') return value;
  return 'none';
}

function toFriendshipDirection(value: unknown): FriendshipDirection {
  if (value === 'incoming' || value === 'outgoing') return value;
  return 'none';
}

export function normalizeSearchQuery(raw: string): string {
  return raw.trim().replace(/^@+/, '');
}

export function parseAvatarConfig(raw: unknown, characterId = 'lia'): AvatarConfig {
  if (isValidAvatarConfig(raw)) return raw;
  return avatarFromCharacter(characterId || 'lia');
}

export function buildInviteLink(username: string, opts?: { webOrigin?: string | null }): string {
  const normalized = normalizeUsername(username);
  if (!isValidUsername(normalized)) {
    throw new Error('Defina um @username válido antes de compartilhar seu link de convite.');
  }
  const encoded = encodeURIComponent(normalized);
  const origin = opts?.webOrigin?.trim().replace(/\/+$/, '');
  if (origin) {
    return `${origin}/?add=${encoded}`;
  }
  return `desbrava://add/${encoded}`;
}

interface SocialErrorLike {
  message?: unknown;
  code?: unknown;
  details?: unknown;
  hint?: unknown;
}

export function mapSocialError(err: unknown): string {
  const obj = (typeof err === 'object' && err !== null ? err : null) as SocialErrorLike | null;
  const rawMsg =
    typeof err === 'string'
      ? err
      : typeof obj?.message === 'string'
        ? obj.message
        : err instanceof Error
          ? err.message
          : '';
  const code = typeof obj?.code === 'string' ? obj.code.trim() : '';
  const m = rawMsg.toLowerCase();

  if (code === '42501' && (m.includes('não autenticado') || m.includes('nao autenticado'))) {
    return 'Entre na sua conta para acessar amigos e rankings.';
  }
  if (m.includes('remova o bloqueio antes de enviar')) {
    return 'Remova o bloqueio antes de enviar um novo convite.';
  }
  if (m.includes('somente o destinatário pode aceitar') || m.includes('somente o destinatario pode aceitar')) {
    return 'Somente quem recebeu o pedido pode aceitá-lo.';
  }
  if (m.includes('somente quem bloqueou')) {
    return 'Somente quem aplicou o bloqueio pode removê-lo.';
  }
  if (
    m.includes('amizade não pode ser criada diretamente') ||
    m.includes('transição de status inválida') ||
    m.includes('transicao de status invalida')
  ) {
    return 'Não foi possível atualizar esta amizade.';
  }
  if (m.includes('friendships_no_self') || m.includes('para si mesmo')) {
    return 'Você não pode enviar convite para si mesmo.';
  }
  if (code === '23505' || m.includes('idx_friendships_pair_unique')) {
    return 'Já existe uma solicitação ou amizade com este explorador.';
  }
  if (
    m.includes('network request failed') ||
    m.includes('failed to fetch') ||
    m.includes('fetch failed') ||
    m.includes('networkerror') ||
    m.includes('econnrefused')
  ) {
    return 'Sem conexão com o servidor. Confira sua internet.';
  }
  if (
    rawMsg &&
    /^(Entre na sua conta|Remova o bloqueio|Somente quem|Você não pode|Não foi possível|Defina um @username|Já existe uma solicitação|Este usuário)/.test(
      rawMsg.trim(),
    )
  ) {
    return rawMsg.trim();
  }
  const authMapped = mapAuthError(err);
  if (authMapped !== 'Não foi possível concluir a operação. Tente novamente.') {
    return authMapped;
  }
  return 'Não foi possível concluir a ação social. Tente novamente.';
}

function mapSocialUserCard(row: Record<string, unknown>): SocialUserCard {
  const characterId = str(row.character_id) ?? 'lia';
  return {
    id: String(row.id),
    username: str(row.username),
    displayName: str(row.display_name) ?? 'Explorador',
    level: num(row.level, 1),
    xp: num(row.xp, 0),
    totalDistanceM: num(row.total_distance_m, 0),
    totalCells: num(row.total_cells, 0),
    avatarConfig: parseAvatarConfig(row.avatar_config, characterId),
    characterId,
    modality: toModality(row.modality),
    friendshipStatus: toFriendshipStatus(row.friendship_status),
    friendshipDirection: toFriendshipDirection(row.friendship_direction),
  };
}

function mapPublicProfileSummary(row: Record<string, unknown>): PublicProfileSummary {
  const characterId = str(row.character_id) ?? 'lia';
  return {
    id: String(row.id),
    username: str(row.username),
    displayName: str(row.display_name) ?? 'Explorador',
    modality: toModality(row.modality),
    characterId,
    avatarConfig: parseAvatarConfig(row.avatar_config, characterId),
    level: num(row.level, 1),
    xp: num(row.xp, 0),
    totalDistanceM: num(row.total_distance_m, 0),
    totalMovingS: num(row.total_moving_s, 0),
    totalActivities: num(row.total_activities, 0),
    totalCaptures: num(row.total_captures, 0),
    totalCells: num(row.total_cells, 0),
    achievementsCount: num(row.achievements_count, 0),
    isPublic: typeof row.is_public === 'boolean' ? row.is_public : true,
    friendshipStatus: toFriendshipStatus(row.friendship_status),
    friendshipDirection: toFriendshipDirection(row.friendship_direction),
  };
}

function mapLeaderboardEntry(row: Record<string, unknown>): LeaderboardEntry {
  const characterId = str(row.character_id) ?? 'lia';
  return {
    rank: num(row.rank, 1),
    userId: String(row.user_id),
    username: str(row.username),
    displayName: str(row.display_name) ?? 'Explorador',
    level: num(row.level, 1),
    xp: num(row.xp, 0),
    score: num(row.score, 0),
    totalDistanceM: num(row.total_distance_m, 0),
    totalCells: num(row.total_cells, 0),
    avatarConfig: parseAvatarConfig(row.avatar_config, characterId),
    characterId,
    modality: toModality(row.modality),
    isMe: Boolean(row.is_me),
  };
}

export async function searchUsersWithClient(
  client: SupabaseClient,
  query: string,
  limit = 20,
): Promise<SocialUserCard[]> {
  const clean = normalizeSearchQuery(query);
  if (clean.length < 2) return [];
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const { data, error } = await client.rpc('search_users', {
    p_query: clean,
    p_limit: safeLimit,
  });
  if (error) throw error;
  if (!Array.isArray(data)) return [];
  return data.map((row) => mapSocialUserCard(row as Record<string, unknown>));
}

export async function getPublicProfileWithClient(
  client: SupabaseClient,
  userId: string,
): Promise<PublicProfileSummary | null> {
  if (!UUID_REGEX.test(userId.trim())) return null;
  const { data, error } = await client.rpc('get_public_profile', {
    p_user_id: userId.trim(),
  });
  if (error) throw error;
  if (!Array.isArray(data) || data.length === 0) return null;
  return mapPublicProfileSummary(data[0] as Record<string, unknown>);
}

export async function getPublicProfileByUsernameWithClient(
  client: SupabaseClient,
  username: string,
): Promise<PublicProfileSummary | null> {
  const clean = normalizeUsername(username);
  if (!isValidUsername(clean)) return null;
  const { data, error } = await client.rpc('get_public_profile_by_username', {
    p_username: clean,
  });
  if (error) throw error;
  if (!Array.isArray(data) || data.length === 0) return null;
  return mapPublicProfileSummary(data[0] as Record<string, unknown>);
}

export async function findFriendshipWithUserWithClient(
  client: SupabaseClient,
  myUserId: string,
  targetUserId: string,
): Promise<FriendshipRow | null> {
  if (!UUID_REGEX.test(myUserId) || !UUID_REGEX.test(targetUserId) || myUserId === targetUserId) {
    return null;
  }
  const { data, error } = await client
    .from('friendships')
    .select('id, requester_id, addressee_id, status, blocked_by, created_at, updated_at')
    .or(
      `and(requester_id.eq.${myUserId},addressee_id.eq.${targetUserId}),and(requester_id.eq.${targetUserId},addressee_id.eq.${myUserId})`,
    )
    .maybeSingle();
  if (error) throw error;
  return (data as FriendshipRow | null) ?? null;
}

export async function listFriendshipsWithClient(
  client: SupabaseClient,
  myUserId: string,
): Promise<CategorizedFriendships> {
  if (!UUID_REGEX.test(myUserId)) {
    return { friends: [], incomingRequests: [], outgoingRequests: [], blocked: [] };
  }

  const { data, error } = await client
    .from('friendships')
    .select('id, requester_id, addressee_id, status, blocked_by, created_at, updated_at')
    .or(`requester_id.eq.${myUserId},addressee_id.eq.${myUserId}`)
    .order('updated_at', { ascending: false });

  if (error) throw error;

  const rows = ((data ?? []) as FriendshipRow[]).filter(
    (row) => row.status !== 'blocked' || row.blocked_by === myUserId,
  );

  const profileTargets = [
    ...new Set(
      rows
        .filter((r) => r.status !== 'blocked')
        .map((r) => (r.requester_id === myUserId ? r.addressee_id : r.requester_id)),
    ),
  ];

  const profileMap = new Map<string, PublicProfileSummary | null>();
  await Promise.all(
    profileTargets.map(async (uid) => {
      try {
        const prof = await getPublicProfileWithClient(client, uid);
        profileMap.set(uid, prof);
      } catch {
        profileMap.set(uid, null);
      }
    }),
  );

  const result: CategorizedFriendships = {
    friends: [],
    incomingRequests: [],
    outgoingRequests: [],
    blocked: [],
  };

  for (const row of rows) {
    const outgoing = row.requester_id === myUserId;
    const otherUserId = outgoing ? row.addressee_id : row.requester_id;
    const item: FriendshipItem = {
      friendshipId: row.id,
      otherUserId,
      status: row.status,
      direction: outgoing ? 'outgoing' : 'incoming',
      blockedBy: row.blocked_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      profile: row.status === 'blocked' ? null : (profileMap.get(otherUserId) ?? null),
    };

    if (row.status === 'accepted') {
      result.friends.push(item);
    } else if (row.status === 'blocked') {
      result.blocked.push(item);
    } else if (outgoing) {
      result.outgoingRequests.push(item);
    } else {
      result.incomingRequests.push(item);
    }
  }

  return result;
}

export async function sendFriendRequestWithClient(
  client: SupabaseClient,
  myUserId: string,
  targetUserId: string,
): Promise<SendFriendRequestResult> {
  if (!UUID_REGEX.test(targetUserId) || myUserId === targetUserId) {
    throw new Error('Você não pode enviar convite para si mesmo.');
  }

  const existing = await findFriendshipWithUserWithClient(client, myUserId, targetUserId);
  if (existing) {
    if (existing.status === 'accepted') {
      return { status: 'already_friends', friendshipId: existing.id };
    }
    if (existing.status === 'pending') {
      if (existing.requester_id === myUserId) {
        return { status: 'already_pending', friendshipId: existing.id };
      }
      // Pedido recebido pendente: aceitar automaticamente em vez de falhar na unicidade do par
      const { error: acceptErr } = await client
        .from('friendships')
        .update({ status: 'accepted' })
        .eq('id', existing.id);
      if (acceptErr) throw acceptErr;
      return { status: 'accepted', friendshipId: existing.id };
    }
    if (existing.status === 'blocked') {
      if (existing.blocked_by === myUserId) {
        throw new Error('Remova o bloqueio antes de enviar um novo convite.');
      }
      throw new Error('Não foi possível enviar o convite para este usuário.');
    }
  }

  const { data, error } = await client
    .from('friendships')
    .insert({
      requester_id: myUserId,
      addressee_id: targetUserId,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error) throw error;
  return {
    status: 'pending',
    friendshipId: String((data as { id: string }).id),
  };
}

export async function acceptFriendRequestWithClient(
  client: SupabaseClient,
  friendshipId: string,
): Promise<void> {
  const { error } = await client
    .from('friendships')
    .update({ status: 'accepted' })
    .eq('id', friendshipId);
  if (error) throw error;
}

export async function removeFriendshipWithClient(
  client: SupabaseClient,
  friendshipId: string,
): Promise<void> {
  const { error } = await client
    .from('friendships')
    .delete()
    .eq('id', friendshipId);
  if (error) throw error;
}

export async function blockUserWithClient(
  client: SupabaseClient,
  myUserId: string,
  targetUserId: string,
): Promise<void> {
  if (!UUID_REGEX.test(targetUserId) || myUserId === targetUserId) {
    throw new Error('Você não pode bloquear a si mesmo.');
  }

  const existing = await findFriendshipWithUserWithClient(client, myUserId, targetUserId);
  if (!existing) {
    const { error } = await client.from('friendships').insert({
      requester_id: myUserId,
      addressee_id: targetUserId,
      status: 'blocked',
      blocked_by: myUserId,
    });
    if (error) throw error;
    return;
  }

  if (existing.status === 'blocked') {
    if (existing.blocked_by === myUserId) return;
    throw new Error('Não foi possível bloquear este usuário.');
  }

  const { error } = await client
    .from('friendships')
    .update({ status: 'blocked', blocked_by: myUserId })
    .eq('id', existing.id);
  if (error) throw error;
}

export async function getFriendsLeaderboardWithClient(
  client: SupabaseClient,
  metric: LeaderboardMetric,
  period: LeaderboardPeriod,
): Promise<LeaderboardEntry[]> {
  const { data, error } = await client.rpc('get_friends_leaderboard', {
    p_metric: metric,
    p_period: period,
  });
  if (error) throw error;
  if (!Array.isArray(data)) return [];
  return data.map((row) => mapLeaderboardEntry(row as Record<string, unknown>));
}

export async function getGlobalLeaderboardWithClient(
  client: SupabaseClient,
  metric: LeaderboardMetric,
  period: LeaderboardPeriod,
  limit = 50,
  offset = 0,
): Promise<GlobalLeaderboardResult> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  const { data, error } = await client.rpc('get_global_leaderboard', {
    p_metric: metric,
    p_period: period,
    p_limit: safeLimit,
    p_offset: safeOffset,
  });
  if (error) throw error;

  const raw = (data ?? {}) as { entries?: unknown; my_rank?: unknown };
  const entries = Array.isArray(raw.entries)
    ? raw.entries.map((row) => mapLeaderboardEntry(row as Record<string, unknown>))
    : [];
  const myRank =
    raw.my_rank && typeof raw.my_rank === 'object' && !Array.isArray(raw.my_rank)
      ? mapLeaderboardEntry(raw.my_rank as Record<string, unknown>)
      : null;

  return { entries, myRank };
}
