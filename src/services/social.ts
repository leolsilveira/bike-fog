// Serviço de amigos, perfis públicos, convites e rankings integrado ao Supabase.
import { Platform, Share } from 'react-native';
import { normalizeUsername } from './authCore.ts';
import {
  acceptFriendRequestWithClient,
  blockUserWithClient,
  buildInviteLink as buildInviteLinkCore,
  findFriendshipWithUserWithClient,
  getFriendsLeaderboardWithClient,
  getGlobalLeaderboardWithClient,
  getPublicProfileByUsernameWithClient,
  getPublicProfileWithClient,
  listFriendshipsWithClient,
  mapSocialError,
  normalizeSearchQuery,
  parseAvatarConfig,
  removeFriendshipWithClient,
  searchUsersWithClient,
  sendFriendRequestWithClient,
  type CategorizedFriendships,
  type FriendshipDirection,
  type FriendshipItem,
  type FriendshipRow,
  type FriendshipStatus,
  type GlobalLeaderboardResult,
  type LeaderboardEntry,
  type LeaderboardMetric,
  type LeaderboardPeriod,
  type PublicProfileSummary,
  type SendFriendRequestResult,
  type SocialUserCard,
} from './socialCore.ts';
import { getSupabaseUser, requireSupabase } from './supabase.ts';

export {
  mapSocialError,
  normalizeSearchQuery,
  parseAvatarConfig,
  type CategorizedFriendships,
  type FriendshipDirection,
  type FriendshipItem,
  type FriendshipRow,
  type FriendshipStatus,
  type GlobalLeaderboardResult,
  type LeaderboardEntry,
  type LeaderboardMetric,
  type LeaderboardPeriod,
  type PublicProfileSummary,
  type SendFriendRequestResult,
  type SocialUserCard,
};

async function requireAuthContext() {
  const client = requireSupabase();
  const user = await getSupabaseUser();
  if (!user) {
    throw new Error('Entre na sua conta para acessar amigos e rankings.');
  }
  return { client, user };
}

export async function searchUsers(query: string, limit = 20): Promise<SocialUserCard[]> {
  const { client } = await requireAuthContext();
  return searchUsersWithClient(client, query, limit);
}

export async function getPublicProfile(userId: string): Promise<PublicProfileSummary | null> {
  const { client } = await requireAuthContext();
  return getPublicProfileWithClient(client, userId);
}

export async function getPublicProfileByUsername(username: string): Promise<PublicProfileSummary | null> {
  const { client } = await requireAuthContext();
  return getPublicProfileByUsernameWithClient(client, username);
}

export async function findFriendshipWithUser(targetUserId: string): Promise<FriendshipRow | null> {
  const { client, user } = await requireAuthContext();
  return findFriendshipWithUserWithClient(client, user.id, targetUserId);
}

export async function listFriendships(): Promise<CategorizedFriendships> {
  const { client, user } = await requireAuthContext();
  return listFriendshipsWithClient(client, user.id);
}

export async function sendFriendRequest(targetUserId: string): Promise<SendFriendRequestResult> {
  const { client, user } = await requireAuthContext();
  return sendFriendRequestWithClient(client, user.id, targetUserId);
}

export async function acceptFriendRequest(friendshipId: string): Promise<void> {
  const { client } = await requireAuthContext();
  return acceptFriendRequestWithClient(client, friendshipId);
}

export async function removeFriendship(friendshipId: string): Promise<void> {
  const { client } = await requireAuthContext();
  return removeFriendshipWithClient(client, friendshipId);
}

export async function blockUser(targetUserId: string): Promise<void> {
  const { client, user } = await requireAuthContext();
  return blockUserWithClient(client, user.id, targetUserId);
}

export async function getFriendsLeaderboard(
  metric: LeaderboardMetric,
  period: LeaderboardPeriod,
): Promise<LeaderboardEntry[]> {
  const { client } = await requireAuthContext();
  return getFriendsLeaderboardWithClient(client, metric, period);
}

export async function getGlobalLeaderboard(
  metric: LeaderboardMetric,
  period: LeaderboardPeriod,
  limit = 50,
  offset = 0,
): Promise<GlobalLeaderboardResult> {
  const { client } = await requireAuthContext();
  return getGlobalLeaderboardWithClient(client, metric, period, limit, offset);
}

export function buildInviteLink(username: string, opts?: { webOrigin?: string | null }): string {
  const origin =
    opts?.webOrigin !== undefined
      ? opts.webOrigin
      : Platform.OS === 'web' && typeof window !== 'undefined'
        ? window.location.origin
        : undefined;
  return buildInviteLinkCore(username, { webOrigin: origin });
}

export async function shareInviteLink(
  username: string,
): Promise<{ method: 'share' | 'clipboard' | 'manual'; url: string }> {
  const normalized = normalizeUsername(username);
  const url = buildInviteLink(normalized);
  const message = `Explore o mapa comigo no Desbrava! Adicione @${normalized}: ${url}`;

  if (Platform.OS === 'web') {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    if (nav && typeof nav.share === 'function') {
      try {
        await nav.share({ title: 'Desbrava', text: message, url });
        return { method: 'share', url };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return { method: 'share', url };
        }
      }
    }
    if (nav?.clipboard && typeof nav.clipboard.writeText === 'function') {
      try {
        await nav.clipboard.writeText(url);
        return { method: 'clipboard', url };
      } catch {
        // Fallback manual caso a permissão de clipboard seja negada
      }
    }
    return { method: 'manual', url };
  }

  await Share.share({ message, url });
  return { method: 'share', url };
}
