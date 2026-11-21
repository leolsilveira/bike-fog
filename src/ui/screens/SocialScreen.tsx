// Tela Social: convites, busca de exploradores, gerenciamento de amizades e rankings (Amigos e Global).
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, TextInput, View, type TextStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { sfx } from '../../game/audio.ts';
import { formatDistance } from '../../game/geo.ts';
import { useGame } from '../../game/store.ts';
import { type IconName } from '../../sprites/icons.ts';
import {
  acceptFriendRequest,
  getFriendsLeaderboard,
  getGlobalLeaderboard,
  getPublicProfileByUsername,
  listFriendships,
  mapSocialError,
  normalizeSearchQuery,
  removeFriendship,
  searchUsers,
  sendFriendRequest,
  shareInviteLink,
  type CategorizedFriendships,
  type LeaderboardEntry,
  type LeaderboardMetric,
  type LeaderboardPeriod,
  type PublicProfileSummary,
  type SocialUserCard,
} from '../../services/social.ts';
import { isSupabaseConfigured } from '../../services/supabase.ts';
import { Arcade, Chip, Inset, Muted, PxBox, PxButton, PxCell, PxOutline, Txt } from '../components/Px.tsx';
import { CharacterSprite, Icon } from '../components/Sprites.tsx';
import { C, FILL, uiFont, useSafe } from '../theme.ts';

const GLOBAL_PAGE_SIZE = 25;

function Section({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <View>
      <View style={styles.h3}>
        <Icon name={icon} size={18} />
        <Arcade size={12} weight={700} spacing={0.04}>
          {title}
        </Arcade>
      </View>
      {children}
    </View>
  );
}

function formatLeaderboardScore(metric: LeaderboardMetric, score: number): string {
  if (metric === 'distance') return formatDistance(score);
  if (metric === 'cells') return `${Math.round(score).toLocaleString('pt-BR')} cél.`;
  return `${Math.round(score).toLocaleString('pt-BR')} XP`;
}

function rankColor(rank: number): string {
  if (rank === 1) return C.gold;
  if (rank === 2) return '#dfe3f0';
  if (rank === 3) return '#e8955a';
  return C.muted;
}

function LeaderboardRow({
  entry,
  metric,
  highlight,
  onPress,
}: {
  entry: LeaderboardEntry;
  metric: LeaderboardMetric;
  highlight?: boolean;
  onPress: () => void;
}) {
  return (
    <PxCell
      selected={highlight ?? entry.isMe}
      onPress={onPress}
      style={styles.listRow}
      testID={`social-leaderboard-row-${entry.userId}`}
    >
      <View style={styles.rankBadge}>
        <Arcade size={12} spacing={0} color={rankColor(entry.rank)}>
          #{entry.rank}
        </Arcade>
      </View>
      <CharacterSprite
        avatar={entry.avatarConfig}
        modality={entry.modality}
        animate={false}
        width={40}
      />
      <View style={styles.rowBody}>
        <Txt weight={700} size={15} numberOfLines={1}>
          {entry.displayName}
          {entry.isMe ? ' (Você)' : ''}
        </Txt>
        <Txt size={12} color={C.muted} numberOfLines={1}>
          {entry.username ? `@${entry.username} · ` : ''}NV {entry.level}
        </Txt>
      </View>
      <View style={styles.rowRight}>
        <Arcade size={11} spacing={0} color={entry.isMe ? C.gold : C.mint} numberOfLines={1}>
          {formatLeaderboardScore(metric, entry.score)}
        </Arcade>
      </View>
    </PxCell>
  );
}

export function SocialScreen() {
  const authUserId = useGame((s) => s.authUserId);
  const profile = useGame((s) => s.profile);
  const pendingInviteUsername = useGame((s) => s.pendingInviteUsername);
  const setPendingInviteUsername = useGame((s) => s.setPendingInviteUsername);
  const pushModal = useGame((s) => s.pushModal);
  const setTab = useGame((s) => s.setTab);
  const socialRev = useGame((s) => s.socialRev);
  const bumpSocialRev = useGame((s) => s.bumpSocialRev);
  const toast = useGame((s) => s.toast);
  const { safeT, tabbarH } = useSafe();

  // Convite recebido via deep link / ?add=
  const inviteKey = authUserId && pendingInviteUsername ? `${authUserId}:${pendingInviteUsername}:${socialRev}` : null;
  const [inviteResult, setInviteResult] = useState<{
    key: string;
    profile: PublicProfileSummary | null;
    error: string | null;
  } | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const inviteLoading = inviteKey !== null && inviteResult?.key !== inviteKey;
  const inviteProfile = inviteKey !== null && inviteResult?.key === inviteKey ? inviteResult.profile : null;
  const inviteError = inviteKey !== null && inviteResult?.key === inviteKey ? inviteResult.error : null;

  // Ranking
  const [lbScope, setLbScope] = useState<'friends' | 'global'>('friends');
  const [lbMetric, setLbMetric] = useState<LeaderboardMetric>('xp');
  const [lbPeriod, setLbPeriod] = useState<LeaderboardPeriod>('all_time');
  const [lbOffset, setLbOffset] = useState(0);
  const [lbEntries, setLbEntries] = useState<LeaderboardEntry[]>([]);
  const [lbMyRank, setLbMyRank] = useState<LeaderboardEntry | null>(null);
  const [lbLoading, setLbLoading] = useState(false);
  const [lbError, setLbError] = useState<string | null>(null);

  // Busca de exploradores
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchResults, setSearchResults] = useState<SocialUserCard[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Amizades
  const [friendships, setFriendships] = useState<CategorizedFriendships>({
    friends: [],
    incomingRequests: [],
    outgoingRequests: [],
    blocked: [],
  });
  const [friendsLoading, setFriendsLoading] = useState(false);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);

  const openFriendProfile = (userId: string, friendshipId?: string) => {
    sfx.click();
    pushModal({ type: 'friend_profile', userId, friendshipId });
  };

  // Carrega perfil do convite pendente quando autenticado
  useEffect(() => {
    if (!inviteKey || !pendingInviteUsername) return;
    let cancelled = false;
    void getPublicProfileByUsername(pendingInviteUsername)
      .then((res) => {
        if (!cancelled) setInviteResult({ key: inviteKey, profile: res, error: null });
      })
      .catch((err) => {
        if (!cancelled) setInviteResult({ key: inviteKey, profile: null, error: mapSocialError(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [inviteKey, pendingInviteUsername]);

  const fetchFriendships = useCallback(async () => {
    return listFriendships();
  }, []);

  const loadFriendships = useCallback(async () => {
    if (!authUserId) return;
    setFriendsLoading(true);
    setFriendsError(null);
    try {
      const res = await fetchFriendships();
      setFriendships(res);
    } catch (err) {
      setFriendsError(mapSocialError(err));
    } finally {
      setFriendsLoading(false);
    }
  }, [authUserId, fetchFriendships]);

  const fetchLeaderboard = useCallback(async () => {
    if (lbScope === 'friends') {
      const rows = await getFriendsLeaderboard(lbMetric, lbPeriod);
      return { entries: rows, myRank: rows.find((r) => r.isMe) ?? null };
    }
    return getGlobalLeaderboard(lbMetric, lbPeriod, GLOBAL_PAGE_SIZE, lbOffset);
  }, [lbScope, lbMetric, lbPeriod, lbOffset]);

  const loadLeaderboard = useCallback(async () => {
    if (!authUserId) return;
    setLbLoading(true);
    setLbError(null);
    try {
      const res = await fetchLeaderboard();
      setLbEntries(res.entries);
      setLbMyRank(res.myRank);
    } catch (err) {
      setLbError(mapSocialError(err));
    } finally {
      setLbLoading(false);
    }
  }, [authUserId, fetchLeaderboard]);

  useEffect(() => {
    if (!authUserId) return;
    let cancelled = false;
    void Promise.resolve()
      .then(() => {
        if (cancelled) return null;
        setFriendsLoading(true);
        setFriendsError(null);
        return fetchFriendships();
      })
      .then((res) => {
        if (!cancelled && res) setFriendships(res);
      })
      .catch((err) => {
        if (!cancelled) setFriendsError(mapSocialError(err));
      })
      .finally(() => {
        if (!cancelled) setFriendsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authUserId, fetchFriendships, socialRev]);

  useEffect(() => {
    if (!authUserId) return;
    let cancelled = false;
    void Promise.resolve()
      .then(() => {
        if (cancelled) return null;
        setLbLoading(true);
        setLbError(null);
        return fetchLeaderboard();
      })
      .then((res) => {
        if (!cancelled && res) {
          setLbEntries(res.entries);
          setLbMyRank(res.myRank);
        }
      })
      .catch((err) => {
        if (!cancelled) setLbError(mapSocialError(err));
      })
      .finally(() => {
        if (!cancelled) setLbLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authUserId, fetchLeaderboard, socialRev]);

  const runSearch = async () => {
    if (!authUserId || searchLoading) return;
    sfx.click();
    const clean = normalizeSearchQuery(searchQuery);
    if (clean.length < 2) {
      setSearchResults(null);
      setSearchError('Digite pelo menos 2 caracteres para buscar.');
      return;
    }
    setSearchLoading(true);
    setSearchError(null);
    try {
      const rows = await searchUsers(clean, 20);
      setSearchResults(rows);
    } catch (err) {
      setSearchError(mapSocialError(err));
    } finally {
      setSearchLoading(false);
    }
  };

  // Atualiza resultados da busca quando ocorre mudança de amizade/bloqueio
  useEffect(() => {
    if (!authUserId || searchResults === null) return;
    const clean = normalizeSearchQuery(searchQuery);
    if (clean.length < 2) return;
    let cancelled = false;
    void searchUsers(clean, 20)
      .then((rows) => {
        if (!cancelled) setSearchResults(rows);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socialRev]);

  const handleShareInvite = async () => {
    if (!profile?.username) return;
    sfx.click();
    try {
      const res = await shareInviteLink(profile.username);
      if (res.method === 'clipboard') {
        toast('Link de convite copiado!', 'info');
      } else if (res.method === 'manual') {
        toast(`Seu link: ${res.url}`, 'info');
      }
    } catch (err) {
      toast(mapSocialError(err), 'warn');
    }
  };

  const handleInviteAdd = async () => {
    if (!inviteProfile || inviteBusy) return;
    sfx.click();
    setInviteBusy(true);
    try {
      const res = await sendFriendRequest(inviteProfile.id);
      setPendingInviteUsername(null);
      bumpSocialRev();
      if (res.status === 'accepted') toast('Amizade aceita!', 'info');
      else if (res.status === 'already_friends') toast('Vocês já são amigos!', 'info');
      else if (res.status === 'already_pending') toast('Pedido já enviado.', 'info');
      else toast(`Convite enviado para @${inviteProfile.username ?? pendingInviteUsername}!`, 'info');
    } catch (err) {
      toast(mapSocialError(err), 'warn');
    } finally {
      setInviteBusy(false);
    }
  };

  const handleAcceptRequest = async (friendshipId: string) => {
    if (actionBusyId) return;
    sfx.click();
    setActionBusyId(friendshipId);
    try {
      await acceptFriendRequest(friendshipId);
      bumpSocialRev();
      toast('Pedido de amizade aceito!', 'info');
    } catch (err) {
      toast(mapSocialError(err), 'warn');
    } finally {
      setActionBusyId(null);
    }
  };

  const handleRemoveRow = async (friendshipId: string, msg: string) => {
    if (actionBusyId) return;
    sfx.click();
    setActionBusyId(friendshipId);
    try {
      await removeFriendship(friendshipId);
      bumpSocialRev();
      toast(msg, 'info');
    } catch (err) {
      toast(mapSocialError(err), 'warn');
    } finally {
      setActionBusyId(null);
    }
  };

  const handleSendFromSearch = async (targetUserId: string) => {
    if (actionBusyId) return;
    sfx.click();
    setActionBusyId(targetUserId);
    try {
      const res = await sendFriendRequest(targetUserId);
      bumpSocialRev();
      toast(res.status === 'accepted' ? 'Amizade aceita!' : 'Pedido de amizade enviado!', 'info');
    } catch (err) {
      toast(mapSocialError(err), 'warn');
    } finally {
      setActionBusyId(null);
    }
  };

  const myRankInEntries = lbMyRank ? lbEntries.some((e) => e.userId === lbMyRank.userId) : true;
  const totalPending = friendships.incomingRequests.length + friendships.outgoingRequests.length;

  return (
    <View style={styles.screen}>
      <LinearGradient colors={['#1e1831', C.ink]} style={styles.noTouchFill} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingTop: 16 + safeT, paddingHorizontal: 14, paddingBottom: tabbarH + 28 }}
        keyboardShouldPersistTaps="handled"
        testID="social-scroll"
      >
        <View style={styles.inner}>
          <View style={styles.screenHeader}>
            <Arcade size={16} weight={700} spacing={0.04} color={C.gold} shadow={{ y: 2 }}>
              AMIGOS E RANKING
            </Arcade>
            <Muted size={13}>
              Conecte-se com outros exploradores e acompanhe sua colocação.
            </Muted>
          </View>

          {pendingInviteUsername && (
            <PxBox style={styles.inviteBanner} testID="social-pending-invite">
              <View style={styles.inviteHeader}>
                <Chip dot={C.sky}>Convite recebido</Chip>
                <PxButton
                  size="small"
                  variant="ghost"
                  onPress={() => {
                    sfx.click();
                    setPendingInviteUsername(null);
                  }}
                >
                  Dispensar
                </PxButton>
              </View>

              {!authUserId ? (
                <Txt size={14} color={C.cream}>
                  Você recebeu um convite de <Txt weight={700} color={C.sky}>@{pendingInviteUsername}</Txt>. Entre na sua conta para adicionar como amigo.
                </Txt>
              ) : inviteLoading ? (
                <Muted size={14}>Buscando @{pendingInviteUsername}…</Muted>
              ) : inviteError ? (
                <Txt size={13} color={C.coral} weight={700}>
                  {inviteError}
                </Txt>
              ) : !inviteProfile ? (
                <Muted size={14}>
                  Não encontramos o perfil público @{pendingInviteUsername}.
                </Muted>
              ) : inviteProfile.id === authUserId ? (
                <Txt size={14} color={C.muted}>
                  Este link é do seu próprio @username (@{inviteProfile.username}).
                </Txt>
              ) : (
                <View style={styles.inviteProfileRow}>
                  <CharacterSprite
                    avatar={inviteProfile.avatarConfig}
                    modality={inviteProfile.modality}
                    animate={false}
                    width={46}
                  />
                  <View style={styles.rowBody}>
                    <Txt weight={700} size={15} numberOfLines={1}>
                      {inviteProfile.displayName}
                    </Txt>
                    <Txt size={12} color={C.sky} numberOfLines={1}>
                      @{inviteProfile.username ?? pendingInviteUsername} · NV {inviteProfile.level}
                    </Txt>
                  </View>
                  <View style={styles.inviteBtns}>
                    <PxButton
                      size="small"
                      variant="sky"
                      onPress={() => openFriendProfile(inviteProfile.id)}
                    >
                      Ver
                    </PxButton>
                    <PxButton
                      size="small"
                      variant="gold"
                      disabled={inviteBusy}
                      onPress={() => void handleInviteAdd()}
                      testID="social-invite-add"
                    >
                      {inviteBusy
                        ? 'Enviando…'
                        : inviteProfile.friendshipStatus === 'accepted'
                          ? 'Amigos'
                          : inviteProfile.friendshipStatus === 'pending' &&
                              inviteProfile.friendshipDirection === 'incoming'
                            ? 'Aceitar'
                            : 'Adicionar'}
                    </PxButton>
                  </View>
                </View>
              )}
            </PxBox>
          )}

          {!authUserId ? (
            <PxBox style={styles.guestCard}>
              <View style={styles.guestTop}>
                <Icon name="trophy" size={32} color={C.gold} accent={C.cream} />
                <View style={styles.rowBody}>
                  <Arcade size={12} spacing={0} color={C.gold}>
                    MODO CONVIDADO
                  </Arcade>
                  <Txt size={14} color={C.muted}>
                    Entre com e-mail e senha para buscar exploradores, adicionar amigos, compartilhar seu link e competir nos rankings.
                  </Txt>
                </View>
              </View>
              {isSupabaseConfigured() ? (
                <PxButton
                  variant="gold"
                  block
                  onPress={() => {
                    sfx.click();
                    pushModal({ type: 'auth' });
                  }}
                  testID="auth-open-btn"
                >
                  Entrar / Criar conta
                </PxButton>
              ) : (
                <Muted size={13}>
                  Configure o Supabase para habilitar os recursos sociais online.
                </Muted>
              )}
            </PxBox>
          ) : (
            <>
              <Section icon="trophy" title="RANKING">
                <PxBox style={styles.card}>
                  <View style={styles.filterGroup}>
                    <View style={styles.filterRow}>
                      <PxButton
                        size="small"
                        variant={lbScope === 'friends' ? 'gold' : 'default'}
                        style={styles.filterBtn}
                        onPress={() => {
                          sfx.click();
                          setLbScope('friends');
                          setLbOffset(0);
                        }}
                        testID="leaderboard-scope-friends"
                      >
                        Amigos
                      </PxButton>
                      <PxButton
                        size="small"
                        variant={lbScope === 'global' ? 'gold' : 'default'}
                        style={styles.filterBtn}
                        onPress={() => {
                          sfx.click();
                          setLbScope('global');
                          setLbOffset(0);
                        }}
                        testID="leaderboard-scope-global"
                      >
                        Global
                      </PxButton>
                    </View>

                    <View style={styles.filterRow}>
                      <PxButton
                        size="small"
                        variant={lbMetric === 'xp' ? 'sky' : 'default'}
                        style={styles.filterBtn}
                        onPress={() => {
                          sfx.click();
                          setLbMetric('xp');
                          setLbOffset(0);
                        }}
                        testID="leaderboard-metric-xp"
                      >
                        XP
                      </PxButton>
                      <PxButton
                        size="small"
                        variant={lbMetric === 'distance' ? 'sky' : 'default'}
                        style={styles.filterBtn}
                        onPress={() => {
                          sfx.click();
                          setLbMetric('distance');
                          setLbOffset(0);
                        }}
                        testID="leaderboard-metric-distance"
                      >
                        Distância
                      </PxButton>
                      <PxButton
                        size="small"
                        variant={lbMetric === 'cells' ? 'sky' : 'default'}
                        style={styles.filterBtn}
                        onPress={() => {
                          sfx.click();
                          setLbMetric('cells');
                          setLbOffset(0);
                        }}
                        testID="leaderboard-metric-cells"
                      >
                        Células
                      </PxButton>
                    </View>

                    <View style={styles.filterRow}>
                      <PxButton
                        size="small"
                        variant={lbPeriod === 'all_time' ? 'mint' : 'default'}
                        style={styles.filterBtn}
                        onPress={() => {
                          sfx.click();
                          setLbPeriod('all_time');
                          setLbOffset(0);
                        }}
                        testID="leaderboard-period-all"
                      >
                        Geral
                      </PxButton>
                      <PxButton
                        size="small"
                        variant={lbPeriod === 'monthly' ? 'mint' : 'default'}
                        style={styles.filterBtn}
                        onPress={() => {
                          sfx.click();
                          setLbPeriod('monthly');
                          setLbOffset(0);
                        }}
                        testID="leaderboard-period-monthly"
                      >
                        Mensal
                      </PxButton>
                    </View>
                  </View>

                  {lbLoading ? (
                    <Muted align="center" style={styles.statePad}>
                      Carregando ranking…
                    </Muted>
                  ) : lbError ? (
                    <View style={styles.errorState}>
                      <Txt size={13} weight={700} color={C.coral} align="center">
                        {lbError}
                      </Txt>
                      <PxButton size="small" variant="gold" onPress={() => void loadLeaderboard()}>
                        Tentar novamente
                      </PxButton>
                    </View>
                  ) : lbEntries.length === 0 ? (
                    <Muted align="center" style={styles.statePad}>
                      {lbPeriod === 'monthly'
                        ? 'Nenhuma atividade ao vivo verificada neste mês ainda.'
                        : 'Nenhum participante neste ranking ainda.'}
                    </Muted>
                  ) : (
                    <View style={styles.list}>
                      {lbEntries.map((entry) => (
                        <LeaderboardRow
                          key={entry.userId}
                          entry={entry}
                          metric={lbMetric}
                          onPress={() => openFriendProfile(entry.userId)}
                        />
                      ))}
                    </View>
                  )}

                  {!lbLoading && !lbError && lbScope === 'global' && lbMyRank && !myRankInEntries && (
                    <View style={styles.pinnedRank}>
                      <Muted size={12} upper spacing={0.04}>
                        Sua posição
                      </Muted>
                      <LeaderboardRow
                        entry={lbMyRank}
                        metric={lbMetric}
                        highlight
                        onPress={() => openFriendProfile(lbMyRank.userId)}
                      />
                    </View>
                  )}

                  {!lbLoading &&
                    !lbError &&
                    lbScope === 'global' &&
                    !lbMyRank &&
                    profile?.isPublic === false && (
                      <Muted size={12} align="center">
                        Seu perfil está privado. Ative &quot;Perfil público&quot; em Stats para entrar no ranking global.
                      </Muted>
                    )}

                  {lbScope === 'global' && (lbOffset > 0 || lbEntries.length === GLOBAL_PAGE_SIZE) && (
                    <View style={styles.pageRow}>
                      <PxButton
                        size="small"
                        variant="ghost"
                        disabled={lbOffset === 0 || lbLoading}
                        onPress={() => {
                          sfx.click();
                          setLbOffset((prev) => Math.max(0, prev - GLOBAL_PAGE_SIZE));
                        }}
                      >
                        Anterior
                      </PxButton>
                      <Muted size={12}>
                        Mostrando {lbOffset + 1}–{lbOffset + lbEntries.length}
                      </Muted>
                      <PxButton
                        size="small"
                        variant="ghost"
                        disabled={lbEntries.length < GLOBAL_PAGE_SIZE || lbLoading}
                        onPress={() => {
                          sfx.click();
                          setLbOffset((prev) => prev + GLOBAL_PAGE_SIZE);
                        }}
                      >
                        Próxima
                      </PxButton>
                    </View>
                  )}
                </PxBox>
              </Section>

              <Section icon="target" title="BUSCAR E CONVIDAR">
                <PxBox style={styles.card}>
                  {profile?.username ? (
                    <View style={styles.shareRow}>
                      <View style={styles.rowBody}>
                        <Txt size={13} color={C.muted}>
                          Seu link de convite
                        </Txt>
                        <Txt weight={700} color={C.sky} numberOfLines={1}>
                          @{profile.username}
                        </Txt>
                      </View>
                      <PxButton size="small" variant="sky" onPress={() => void handleShareInvite()}>
                        Compartilhar link
                      </PxButton>
                    </View>
                  ) : (
                    <View style={styles.shareRow}>
                      <Muted size={13} style={styles.rowBody}>
                        Defina um @username em Stats para compartilhar seu link de convite.
                      </Muted>
                      <PxButton
                        size="small"
                        variant="default"
                        onPress={() => {
                          sfx.click();
                          setTab('stats');
                        }}
                      >
                        Ir para Stats
                      </PxButton>
                    </View>
                  )}

                  <View style={styles.searchBar}>
                    <View style={styles.searchInputWrap}>
                      <Inset side="top" h={3} color={C.cream2} />
                      <PxOutline color={searchFocused ? C.gold : C.ink} />
                      <TextInput
                        value={searchQuery}
                        onChangeText={(v) => {
                          setSearchQuery(v);
                          if (searchError) setSearchError(null);
                        }}
                        placeholder="Buscar por @username ou nome"
                        placeholderTextColor="#757575"
                        autoCapitalize="none"
                        autoCorrect={false}
                        spellCheck={false}
                        returnKeyType="search"
                        onSubmitEditing={() => void runSearch()}
                        onFocus={() => setSearchFocused(true)}
                        onBlur={() => setSearchFocused(false)}
                        cursorColor={C.ink}
                        underlineColorAndroid="transparent"
                        accessibilityLabel="Buscar exploradores"
                        style={styles.input}
                        testID="social-search-input"
                      />
                    </View>
                    <PxButton
                      variant="gold"
                      disabled={searchLoading}
                      onPress={() => void runSearch()}
                      testID="social-search-btn"
                    >
                      {searchLoading ? 'Buscando…' : 'Buscar'}
                    </PxButton>
                  </View>

                  {searchError && (
                    <Txt size={13} weight={700} color={C.coral}>
                      {searchError}
                    </Txt>
                  )}

                  {searchResults !== null && !searchLoading && (
                    searchResults.length === 0 ? (
                      <Muted size={13} align="center" style={styles.statePad}>
                        Nenhum explorador público encontrado para &quot;{searchQuery.trim()}&quot;.
                      </Muted>
                    ) : (
                      <View style={styles.list}>
                        {searchResults.map((u) => (
                          <PxCell
                            key={u.id}
                            onPress={() => openFriendProfile(u.id)}
                            style={styles.listRow}
                            testID={`social-search-result-${u.id}`}
                          >
                            <CharacterSprite
                              avatar={u.avatarConfig}
                              modality={u.modality}
                              animate={false}
                              width={40}
                            />
                            <View style={styles.rowBody}>
                              <Txt weight={700} size={15} numberOfLines={1}>
                                {u.displayName}
                              </Txt>
                              <Txt size={12} color={C.muted} numberOfLines={1}>
                                {u.username ? `@${u.username} · ` : ''}NV {u.level} · {formatDistance(u.totalDistanceM)}
                              </Txt>
                            </View>
                            {u.friendshipStatus === 'accepted' ? (
                              <Chip dot={C.mint}>Amigo</Chip>
                            ) : u.friendshipStatus === 'pending' &&
                              u.friendshipDirection === 'outgoing' ? (
                              <Chip dot={C.gold}>Enviado</Chip>
                            ) : u.friendshipStatus === 'pending' &&
                              u.friendshipDirection === 'incoming' ? (
                              <PxButton
                                size="small"
                                variant="mint"
                                disabled={actionBusyId === u.id}
                                onPress={() => void handleSendFromSearch(u.id)}
                                testID={`social-search-accept-${u.id}`}
                              >
                                Aceitar
                              </PxButton>
                            ) : (
                              <PxButton
                                size="small"
                                variant="gold"
                                disabled={actionBusyId === u.id}
                                onPress={() => void handleSendFromSearch(u.id)}
                                testID={`social-search-add-${u.id}`}
                              >
                                {actionBusyId === u.id ? '…' : 'Adicionar'}
                              </PxButton>
                            )}
                          </PxCell>
                        ))}
                      </View>
                    )
                  )}
                </PxBox>
              </Section>

              {totalPending > 0 && (
                <Section icon="star" title={`SOLICITAÇÕES (${totalPending})`}>
                  <PxBox style={styles.card}>
                    <View style={styles.list}>
                      {friendships.incomingRequests.map((item) => {
                        const name = item.profile?.displayName ?? 'Explorador';
                        const uname = item.profile?.username;
                        return (
                          <PxCell
                            key={item.friendshipId}
                            onPress={() => openFriendProfile(item.otherUserId, item.friendshipId)}
                            style={styles.listRow}
                          >
                            {item.profile ? (
                              <CharacterSprite
                                avatar={item.profile.avatarConfig}
                                modality={item.profile.modality}
                                animate={false}
                                width={40}
                              />
                            ) : (
                              <Icon name="bike" size={28} color={C.muted} />
                            )}
                            <View style={styles.rowBody}>
                              <Txt weight={700} size={15} numberOfLines={1}>
                                {name}
                              </Txt>
                              <Txt size={12} color={C.sky} numberOfLines={1}>
                                {uname ? `@${uname} · ` : ''}Quer adicionar você
                              </Txt>
                            </View>
                            <View style={styles.inlineBtns}>
                              <PxButton
                                size="small"
                                variant="mint"
                                disabled={actionBusyId === item.friendshipId}
                                onPress={() => void handleAcceptRequest(item.friendshipId)}
                                testID={`social-incoming-accept-${item.otherUserId}`}
                              >
                                Aceitar
                              </PxButton>
                              <PxButton
                                size="small"
                                variant="ghost"
                                disabled={actionBusyId === item.friendshipId}
                                onPress={() => void handleRemoveRow(item.friendshipId, 'Pedido recusado.')}
                              >
                                Recusar
                              </PxButton>
                            </View>
                          </PxCell>
                        );
                      })}

                      {friendships.outgoingRequests.map((item) => {
                        const name = item.profile?.displayName ?? 'Explorador';
                        const uname = item.profile?.username;
                        return (
                          <PxCell
                            key={item.friendshipId}
                            onPress={() => openFriendProfile(item.otherUserId, item.friendshipId)}
                            style={styles.listRow}
                          >
                            {item.profile ? (
                              <CharacterSprite
                                avatar={item.profile.avatarConfig}
                                modality={item.profile.modality}
                                animate={false}
                                width={40}
                              />
                            ) : (
                              <Icon name="bike" size={28} color={C.muted} />
                            )}
                            <View style={styles.rowBody}>
                              <Txt weight={700} size={15} numberOfLines={1}>
                                {name}
                              </Txt>
                              <Txt size={12} color={C.muted} numberOfLines={1}>
                                {uname ? `@${uname} · ` : ''}Aguardando resposta
                              </Txt>
                            </View>
                            <PxButton
                              size="small"
                              variant="default"
                              disabled={actionBusyId === item.friendshipId}
                              onPress={() => void handleRemoveRow(item.friendshipId, 'Pedido cancelado.')}
                            >
                              Cancelar
                            </PxButton>
                          </PxCell>
                        );
                      })}
                    </View>
                  </PxBox>
                </Section>
              )}

              <Section icon="medal" title={`AMIGOS (${friendships.friends.length})`}>
                <PxBox style={styles.card}>
                  <View style={styles.friendsHead}>
                    <Muted size={13}>Toque em um amigo para ver o resumo.</Muted>
                    <PxButton
                      size="small"
                      variant="ghost"
                      disabled={friendsLoading}
                      onPress={() => {
                        sfx.click();
                        void loadFriendships();
                      }}
                    >
                      {friendsLoading ? 'Atualizando…' : 'Atualizar'}
                    </PxButton>
                  </View>

                  {friendsLoading && friendships.friends.length === 0 ? (
                    <Muted align="center" style={styles.statePad}>
                      Carregando amigos…
                    </Muted>
                  ) : friendsError ? (
                    <View style={styles.errorState}>
                      <Txt size={13} weight={700} color={C.coral} align="center">
                        {friendsError}
                      </Txt>
                      <PxButton size="small" variant="gold" onPress={() => void loadFriendships()}>
                        Tentar novamente
                      </PxButton>
                    </View>
                  ) : friendships.friends.length === 0 ? (
                    <Muted align="center" style={styles.statePad}>
                      Você ainda não adicionou amigos. Busque por @username ou compartilhe seu link de convite!
                    </Muted>
                  ) : (
                    <View style={styles.list}>
                      {friendships.friends.map((item) => {
                        const prof = item.profile;
                        return (
                          <PxCell
                            key={item.friendshipId}
                            onPress={() => openFriendProfile(item.otherUserId, item.friendshipId)}
                            style={styles.listRow}
                            testID={`social-friend-${item.otherUserId}`}
                          >
                            {prof ? (
                              <CharacterSprite
                                avatar={prof.avatarConfig}
                                modality={prof.modality}
                                animate={false}
                                width={42}
                              />
                            ) : (
                              <Icon name="bike" size={28} color={C.muted} />
                            )}
                            <View style={styles.rowBody}>
                              <Txt weight={700} size={15} numberOfLines={1}>
                                {prof?.displayName ?? 'Explorador'}
                              </Txt>
                              <Txt size={12} color={C.muted} numberOfLines={1}>
                                {prof?.username ? `@${prof.username} · ` : ''}
                                {prof ? `NV ${prof.level} · ${formatDistance(prof.totalDistanceM)}` : 'Amigo'}
                              </Txt>
                            </View>
                            <Icon name="stats" size={16} color={C.muted} />
                          </PxCell>
                        );
                      })}
                    </View>
                  )}
                </PxBox>
              </Section>

              {friendships.blocked.length > 0 && (
                <Section icon="lock" title={`BLOQUEADOS (${friendships.blocked.length})`}>
                  <PxBox style={styles.card}>
                    <View style={styles.list}>
                      {friendships.blocked.map((item) => (
                        <PxCell key={item.friendshipId} style={styles.listRow}>
                          <Icon name="lock" size={20} color={C.coral} />
                          <View style={styles.rowBody}>
                            <Txt weight={700} size={14}>
                              Usuário bloqueado
                            </Txt>
                            <Muted size={12}>
                              Remova o bloqueio se quiser interagir novamente.
                            </Muted>
                          </View>
                          <PxButton
                            size="small"
                            variant="default"
                            disabled={actionBusyId === item.friendshipId}
                            onPress={() => void handleRemoveRow(item.friendshipId, 'Bloqueio removido.')}
                          >
                            Desbloquear
                          </PxButton>
                        </PxCell>
                      ))}
                    </View>
                  </PxBox>
                </Section>
              )}
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { ...FILL },
  noTouchFill: { ...FILL, pointerEvents: 'none' },
  scroll: { flex: 1 },
  inner: { width: '100%', maxWidth: 620, alignSelf: 'center', gap: 16 },
  screenHeader: { gap: 4 },
  h3: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  inviteBanner: { padding: 14, gap: 10 },
  inviteHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  inviteProfileRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  inviteBtns: { flexDirection: 'row', gap: 8, flexShrink: 0 },
  guestCard: { padding: 16, gap: 14 },
  guestTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  card: { padding: 14, gap: 12 },
  filterGroup: { gap: 8 },
  filterRow: { flexDirection: 'row', gap: 8 },
  filterBtn: { flex: 1 },
  statePad: { paddingVertical: 14 },
  errorState: { alignItems: 'center', gap: 10, paddingVertical: 8 },
  list: { gap: 8 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 10 },
  rankBadge: { minWidth: 36, alignItems: 'center' },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowRight: { flexShrink: 0, alignItems: 'flex-end' },
  pinnedRank: { gap: 6, marginTop: 4 },
  pageRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4 },
  shareRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  searchBar: { flexDirection: 'row', alignItems: 'stretch', gap: 8 },
  searchInputWrap: { flex: 1, backgroundColor: C.cream },
  input: {
    height: 44,
    paddingHorizontal: 12,
    paddingVertical: 0,
    margin: 0,
    borderWidth: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null),
    fontFamily: uiFont(700),
    fontSize: 15,
    color: C.ink,
    textAlignVertical: 'center',
    ...(Platform.OS === 'android' ? { includeFontPadding: false } : null),
  } as TextStyle,
  inlineBtns: { flexDirection: 'row', gap: 6, flexShrink: 0 },
  friendsHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
});
