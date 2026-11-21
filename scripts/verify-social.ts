// Verificação automatizada do M4 (friends-ranking-ui): testes unitários + integração ao vivo com 2 usuários.
// Rodar com: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test scripts/verify-social.ts
// ATENÇÃO: nunca chamar signUp(), resetPasswordForEmail() ou resend() contra o Supabase ao vivo (política anti-bounce).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { DEFAULT_AVATAR, avatarFromCharacter } from '../src/sprites/avatar.ts';
import {
  acceptFriendRequestWithClient,
  blockUserWithClient,
  buildInviteLink,
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
} from '../src/services/socialCore.ts';

try {
  process.loadEnvFile('.env.local');
} catch {
  // Variáveis podem vir diretamente do ambiente
}

const SUPABASE_URL = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? '').trim();
const SUPABASE_KEY = (
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ||
  ''
);
const TEST_USER_A_EMAIL = (process.env.TEST_USER_A_EMAIL ?? '').trim();
const TEST_USER_A_PASSWORD = (process.env.TEST_USER_A_PASSWORD ?? '').trim();
const TEST_USER_B_EMAIL = (process.env.TEST_USER_B_EMAIL ?? '').trim();
const TEST_USER_B_PASSWORD = (process.env.TEST_USER_B_PASSWORD ?? '').trim();

test('1. socialCore: busca, links de convite, parse de avatar e erros em pt-BR', () => {
  assert.equal(normalizeSearchQuery('  @@alice_sp  '), 'alice_sp');
  assert.equal(normalizeSearchQuery('  Bob  '), 'Bob');

  assert.equal(buildInviteLink('@Alice_SP'), 'desbrava://add/alice_sp');
  assert.equal(
    buildInviteLink('alice_sp', { webOrigin: 'https://desbrava.app/' }),
    'https://desbrava.app/?add=alice_sp',
  );
  assert.throws(
    () => buildInviteLink('ab'),
    /Defina um @username válido/,
  );

  assert.deepEqual(parseAvatarConfig(DEFAULT_AVATAR, 'zeca'), DEFAULT_AVATAR);
  assert.deepEqual(parseAvatarConfig({ invalid: true }, 'lia'), avatarFromCharacter('lia'));

  assert.equal(
    mapSocialError({ code: '42501', message: 'Não autenticado' }),
    'Entre na sua conta para acessar amigos e rankings.',
  );
  assert.equal(
    mapSocialError({ code: '22023', message: 'Remova o bloqueio antes de enviar novo convite' }),
    'Remova o bloqueio antes de enviar um novo convite.',
  );
  assert.equal(
    mapSocialError({ code: '42501', message: 'Somente o destinatário pode aceitar o convite' }),
    'Somente quem recebeu o pedido pode aceitá-lo.',
  );
  assert.equal(
    mapSocialError({ code: '42501', message: 'Somente quem bloqueou pode alterar o bloqueio' }),
    'Somente quem aplicou o bloqueio pode removê-lo.',
  );
  assert.equal(
    mapSocialError({ code: '23505', message: 'duplicate key value violates unique constraint "idx_friendships_pair_unique"' }),
    'Já existe uma solicitação ou amizade com este explorador.',
  );
  assert.equal(
    mapSocialError(new TypeError('Failed to fetch')),
    'Sem conexão com o servidor. Confira sua internet.',
  );
});

test('2. Live Supabase (lugwebngeyadfrqoapsg): busca, amizades, bloqueio e rankings com 2 usuários', async (t) => {
  if (
    !SUPABASE_URL ||
    !SUPABASE_KEY ||
    !TEST_USER_A_EMAIL ||
    !TEST_USER_A_PASSWORD ||
    !TEST_USER_B_EMAIL ||
    !TEST_USER_B_PASSWORD
  ) {
    t.skip('Credenciais TEST_USER_A_* / TEST_USER_B_* ausentes em .env.local');
    return;
  }

  const clientA = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const clientB = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const [authA, authB] = await Promise.all([
    clientA.auth.signInWithPassword({ email: TEST_USER_A_EMAIL, password: TEST_USER_A_PASSWORD }),
    clientB.auth.signInWithPassword({ email: TEST_USER_B_EMAIL, password: TEST_USER_B_PASSWORD }),
  ]);
  assert.equal(authA.error, null);
  assert.equal(authB.error, null);
  assert.ok(authA.data.user);
  assert.ok(authB.data.user);

  const userAId = authA.data.user.id;
  const userBId = authB.data.user.id;
  assert.notEqual(userAId, userBId);

  const [profARes, profBRes] = await Promise.all([
    clientA.from('profiles').select('display_name, username, is_public').eq('id', userAId).single(),
    clientB.from('profiles').select('display_name, username, is_public').eq('id', userBId).single(),
  ]);
  assert.equal(profARes.error, null);
  assert.equal(profBRes.error, null);
  const origA = profARes.data as { display_name: string; username: string | null; is_public: boolean };
  const origB = profBRes.data as { display_name: string; username: string | null; is_public: boolean };

  const tempSuffix = Date.now().toString(36).slice(-5);
  const usernameA = origA.username ?? `test_a_${tempSuffix}`;
  const usernameB = origB.username ?? `test_b_${tempSuffix}`;

  t.after(async () => {
    const existing = await findFriendshipWithUserWithClient(clientA, userAId, userBId).catch(() => null);
    if (existing) {
      if (existing.status === 'blocked' && existing.blocked_by === userBId) {
        await removeFriendshipWithClient(clientB, existing.id).catch(() => undefined);
      } else {
        await removeFriendshipWithClient(clientA, existing.id).catch(() => undefined);
      }
    }
    await clientA
      .from('profiles')
      .update({
        display_name: origA.display_name,
        username: origA.username,
        is_public: origA.is_public,
      })
      .eq('id', userAId);
    await clientB
      .from('profiles')
      .update({
        display_name: origB.display_name,
        username: origB.username,
        is_public: origB.is_public,
      })
      .eq('id', userBId);
    await Promise.all([
      clientA.auth.signOut({ scope: 'local' }),
      clientB.auth.signOut({ scope: 'local' }),
    ]);
  });

  // Garante estado inicial limpo entre A e B antes do teste
  const preExisting = await findFriendshipWithUserWithClient(clientA, userAId, userBId);
  if (preExisting) {
    if (preExisting.status === 'blocked' && preExisting.blocked_by === userBId) {
      await removeFriendshipWithClient(clientB, preExisting.id);
    } else {
      await removeFriendshipWithClient(clientA, preExisting.id);
    }
  }

  // Garante perfis públicos e @usernames válidos para busca e ranking global
  const [updA, updB] = await Promise.all([
    clientA.from('profiles').update({ is_public: true, username: usernameA }).eq('id', userAId),
    clientB.from('profiles').update({ is_public: true, username: usernameB }).eq('id', userBId),
  ]);
  assert.equal(updA.error, null);
  assert.equal(updB.error, null);

  // Busca (< 2 chars curto-circuita; >= 2 chars encontra usuário B sem expor usuário A)
  assert.deepEqual(await searchUsersWithClient(clientA, '@a'), []);
  const foundB = await searchUsersWithClient(clientA, `@${usernameB}`);
  assert.ok(foundB.some((u) => u.id === userBId));
  assert.equal(foundB.some((u) => u.id === userAId), false);

  // Resumo público por ID e por @username (sem expor wallet nem settings)
  const summaryByUsername = await getPublicProfileByUsernameWithClient(clientA, `@${usernameB}`);
  assert.ok(summaryByUsername);
  assert.equal(summaryByUsername.id, userBId);
  assert.equal(summaryByUsername.friendshipStatus, 'none');
  assert.equal('wallet' in summaryByUsername, false);
  assert.equal('settings' in summaryByUsername, false);

  // 1) A envia pedido para B
  const sent = await sendFriendRequestWithClient(clientA, userAId, userBId);
  assert.equal(sent.status, 'pending');

  const [listA1, listB1] = await Promise.all([
    listFriendshipsWithClient(clientA, userAId),
    listFriendshipsWithClient(clientB, userBId),
  ]);
  assert.ok(listA1.outgoingRequests.some((r) => r.otherUserId === userBId && r.friendshipId === sent.friendshipId));
  assert.ok(listB1.incomingRequests.some((r) => r.otherUserId === userAId && r.friendshipId === sent.friendshipId));

  // 2) B aceita o pedido
  await acceptFriendRequestWithClient(clientB, sent.friendshipId);
  const [listA2, listB2] = await Promise.all([
    listFriendshipsWithClient(clientA, userAId),
    listFriendshipsWithClient(clientB, userBId),
  ]);
  assert.ok(listA2.friends.some((r) => r.otherUserId === userBId));
  assert.ok(listB2.friends.some((r) => r.otherUserId === userAId));

  // 3) Rankings (Amigos e Global)
  const [friendsXp, friendsDist, friendsCells, friendsMonthly, globalXp] = await Promise.all([
    getFriendsLeaderboardWithClient(clientA, 'xp', 'all_time'),
    getFriendsLeaderboardWithClient(clientA, 'distance', 'all_time'),
    getFriendsLeaderboardWithClient(clientA, 'cells', 'all_time'),
    getFriendsLeaderboardWithClient(clientA, 'xp', 'monthly'),
    getGlobalLeaderboardWithClient(clientA, 'xp', 'all_time', 25, 0),
  ]);
  assert.ok(friendsXp.some((e) => e.userId === userAId && e.isMe));
  assert.ok(friendsXp.some((e) => e.userId === userBId));
  assert.ok(friendsDist.some((e) => e.userId === userBId));
  assert.ok(friendsCells.some((e) => e.userId === userBId));
  assert.ok(friendsMonthly.some((e) => e.userId === userAId));
  assert.ok(Array.isArray(globalXp.entries));
  assert.ok(globalXp.myRank !== null);
  assert.equal(globalXp.myRank?.userId, userAId);

  // 4) A bloqueia B -> B some de friends, aparece em blocked só para A e get_public_profile fica oculto
  await blockUserWithClient(clientA, userAId, userBId);
  const [listA3, listB3, hiddenProfile] = await Promise.all([
    listFriendshipsWithClient(clientA, userAId),
    listFriendshipsWithClient(clientB, userBId),
    getPublicProfileWithClient(clientB, userAId),
  ]);
  assert.equal(listA3.friends.some((r) => r.otherUserId === userBId), false);
  assert.ok(listA3.blocked.some((r) => r.otherUserId === userBId));
  assert.equal(listB3.blocked.some((r) => r.otherUserId === userAId), false);
  assert.equal(hiddenProfile, null);

  // 5) A desbloqueia B via DELETE e valida auto-aceite quando há convite cruzado
  await removeFriendshipWithClient(clientA, sent.friendshipId);
  assert.equal(await findFriendshipWithUserWithClient(clientA, userAId, userBId), null);

  const cross1 = await sendFriendRequestWithClient(clientA, userAId, userBId);
  assert.equal(cross1.status, 'pending');
  const cross2 = await sendFriendRequestWithClient(clientB, userBId, userAId);
  assert.equal(cross2.status, 'accepted');
  assert.equal(cross2.friendshipId, cross1.friendshipId);

  await removeFriendshipWithClient(clientA, cross1.friendshipId);
  assert.equal(await findFriendshipWithUserWithClient(clientA, userAId, userBId), null);
});
