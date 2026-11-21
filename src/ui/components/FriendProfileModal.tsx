// Modal com o resumo público de outro explorador e ações de amizade/bloqueio.
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { sfx } from '../../game/audio.ts';
import { formatDistance, formatDuration } from '../../game/geo.ts';
import { titleFor } from '../../game/progression.ts';
import { useGame } from '../../game/store.ts';
// sem extensão: há variante .web.ts
import { confirmAsync } from '../../services/confirm';
import {
  acceptFriendRequest,
  blockUser,
  findFriendshipWithUser,
  getPublicProfile,
  mapSocialError,
  removeFriendship,
  sendFriendRequest,
  type PublicProfileSummary,
} from '../../services/social.ts';
import { C } from '../theme.ts';
import { Arcade, Chip, Muted, PxBox, PxButton, PxCell, Txt } from './Px.tsx';
import { CharacterSprite, Icon } from './Sprites.tsx';

export function FriendProfileModal({
  userId,
  friendshipId: initialFriendshipId,
  onClose,
}: {
  userId: string;
  friendshipId?: string;
  onClose: () => void;
}) {
  const authUserId = useGame((s) => s.authUserId);
  const socialRev = useGame((s) => s.socialRev);
  const bumpSocialRev = useGame((s) => s.bumpSocialRev);
  const toast = useGame((s) => s.toast);

  const [profile, setProfile] = useState<PublicProfileSummary | null>(null);
  const [resolvedFriendshipId, setResolvedFriendshipId] = useState<string | null>(
    initialFriendshipId ?? null,
  );
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const isMe = authUserId != null && authUserId === userId;

  const fetchProfile = useCallback(async () => {
    const p = await getPublicProfile(userId);
    let fId: string | null = initialFriendshipId ?? null;
    if (p && !initialFriendshipId && p.friendshipStatus !== 'none' && authUserId !== userId) {
      const row = await findFriendshipWithUser(userId);
      fId = row?.id ?? null;
    }
    return { p, fId };
  }, [userId, initialFriendshipId, authUserId]);

  const reload = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const { p, fId } = await fetchProfile();
      setProfile(p);
      setResolvedFriendshipId(fId);
    } catch (err) {
      setErrorMsg(mapSocialError(err));
    } finally {
      setLoading(false);
    }
  }, [fetchProfile]);

  useEffect(() => {
    let cancelled = false;
    void fetchProfile()
      .then(({ p, fId }) => {
        if (cancelled) return;
        setProfile(p);
        setResolvedFriendshipId(fId);
        setErrorMsg(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setErrorMsg(mapSocialError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchProfile, socialRev]);

  const ensureFriendshipId = async (): Promise<string | null> => {
    if (resolvedFriendshipId) return resolvedFriendshipId;
    const row = await findFriendshipWithUser(userId);
    const id = row?.id ?? null;
    setResolvedFriendshipId(id);
    return id;
  };

  const handleSendRequest = async () => {
    if (busy) return;
    sfx.click();
    setErrorMsg(null);
    setBusy('send');
    try {
      const res = await sendFriendRequest(userId);
      setResolvedFriendshipId(res.friendshipId);
      bumpSocialRev();
      if (res.status === 'accepted') {
        toast('Amizade aceita!', 'info');
      } else if (res.status === 'already_friends') {
        toast('Vocês já são amigos.', 'info');
      } else if (res.status === 'already_pending') {
        toast('Pedido de amizade já enviado.', 'info');
      } else {
        toast('Pedido de amizade enviado!', 'info');
      }
    } catch (err) {
      setErrorMsg(mapSocialError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleAccept = async () => {
    if (busy) return;
    sfx.click();
    setErrorMsg(null);
    setBusy('accept');
    try {
      const id = await ensureFriendshipId();
      if (!id) throw new Error('Solicitação de amizade não encontrada.');
      await acceptFriendRequest(id);
      bumpSocialRev();
      toast('Pedido de amizade aceito!', 'info');
    } catch (err) {
      setErrorMsg(mapSocialError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async (action: 'decline' | 'cancel' | 'unfriend') => {
    if (busy) return;
    if (action === 'unfriend') {
      const ok = await confirmAsync(
        'Remover amizade?',
        'Vocês deixarão de aparecer no ranking de amigos um do outro.',
        'Remover',
      );
      if (!ok) return;
    }
    sfx.click();
    setErrorMsg(null);
    setBusy(action);
    try {
      const id = await ensureFriendshipId();
      if (!id) throw new Error('Registro de amizade não encontrado.');
      await removeFriendship(id);
      setResolvedFriendshipId(null);
      bumpSocialRev();
      toast(
        action === 'decline'
          ? 'Pedido recusado.'
          : action === 'cancel'
            ? 'Pedido cancelado.'
            : 'Amizade removida.',
        'info',
      );
      if (action === 'decline') {
        onClose();
      }
    } catch (err) {
      setErrorMsg(mapSocialError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleBlock = async () => {
    if (busy) return;
    const ok = await confirmAsync(
      'Bloquear usuário?',
      'Essa pessoa será removida dos seus amigos e não poderá enviar novos convites nem ver seu perfil.',
      'Bloquear',
    );
    if (!ok) return;
    sfx.click();
    setErrorMsg(null);
    setBusy('block');
    try {
      await blockUser(userId);
      bumpSocialRev();
      toast('Usuário bloqueado.', 'info');
      onClose();
    } catch (err) {
      setErrorMsg(mapSocialError(err));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <View style={styles.wrap}>
        <Arcade size={16} weight={700} spacing={0} align="center" color={C.gold}>
          EXPLORADOR
        </Arcade>
        <Muted align="center" style={{ paddingVertical: 16 }}>
          Carregando perfil…
        </Muted>
        <PxButton block onPress={onClose}>
          Fechar
        </PxButton>
      </View>
    );
  }

  if (!profile) {
    return (
      <View style={styles.wrap}>
        <Arcade size={16} weight={700} spacing={0} align="center" color={C.gold}>
          PERFIL INDISPONÍVEL
        </Arcade>
        <Muted align="center">
          {errorMsg ?? 'Este perfil está privado ou não está disponível no momento.'}
        </Muted>
        <View style={styles.actions}>
          {errorMsg && (
            <PxButton variant="gold" block onPress={() => void reload()}>
              Tentar novamente
            </PxButton>
          )}
          <PxButton block onPress={onClose}>
            Fechar
          </PxButton>
        </View>
      </View>
    );
  }

  const statItems: [string, string][] = [
    ['Distância', formatDistance(profile.totalDistanceM)],
    ['Em movimento', formatDuration(profile.totalMovingS)],
    ['Atividades', String(profile.totalActivities)],
    ['Células', profile.totalCells.toLocaleString('pt-BR')],
    ['Capturas', String(profile.totalCaptures)],
    ['Conquistas', String(profile.achievementsCount)],
  ];

  return (
    <View style={styles.wrap}>
      <View style={styles.hero}>
        <CharacterSprite
          avatar={profile.avatarConfig}
          modality={profile.modality}
          facing="down"
          width={88}
        />
        <Arcade
          size={16}
          weight={700}
          spacing={0}
          lh={1.4}
          align="center"
          color={C.gold}
          shadow={{ y: 2 }}
        >
          {profile.displayName}
        </Arcade>
        {profile.username ? (
          <Txt size={14} weight={700} color={C.sky}>
            @{profile.username}
          </Txt>
        ) : null}
        <Txt size={14} weight={700} color={C.cream}>
          Nível {profile.level} · {titleFor(profile.level)}
        </Txt>
        <View style={styles.chips}>
          <Chip>
            <Icon name={profile.modality} size={14} />{' '}
            {profile.modality === 'bike' ? 'Ciclismo' : 'Corrida'}
          </Chip>
          <Chip color={C.mint}>{profile.xp.toLocaleString('pt-BR')} XP</Chip>
          {profile.friendshipStatus === 'accepted' && <Chip dot={C.mint}>Amigo</Chip>}
          {profile.friendshipStatus === 'pending' && (
            <Chip dot={C.gold}>
              {profile.friendshipDirection === 'incoming' ? 'Quer ser seu amigo' : 'Pedido enviado'}
            </Chip>
          )}
        </View>
      </View>

      <View style={styles.grid}>
        {[0, 2, 4].map((start) => (
          <View key={start} style={styles.gridRow}>
            {statItems.slice(start, start + 2).map(([label, value]) => (
              <PxCell key={label} style={styles.statCell}>
                <Txt size={11} color={C.muted} upper spacing={0.04} numberOfLines={1}>
                  {label}
                </Txt>
                <Arcade size={12} spacing={0} color={C.cream} numberOfLines={1}>
                  {value}
                </Arcade>
              </PxCell>
            ))}
          </View>
        ))}
      </View>

      {errorMsg && (
        <PxBox bg={C.coral} drop={false} style={styles.errorBox}>
          <Txt size={13} weight={700} color={C.cream}>
            {errorMsg}
          </Txt>
        </PxBox>
      )}

      <View style={styles.actions}>
        {!isMe && profile.friendshipStatus === 'none' && (
          <PxButton
            variant="gold"
            block
            disabled={busy !== null}
            onPress={() => void handleSendRequest()}
            testID="friend-request-send"
          >
            {busy === 'send' ? 'Enviando…' : 'Enviar pedido'}
          </PxButton>
        )}

        {!isMe &&
          profile.friendshipStatus === 'pending' &&
          profile.friendshipDirection === 'incoming' && (
            <>
              <PxButton
                variant="mint"
                block
                disabled={busy !== null}
                onPress={() => void handleAccept()}
                testID="friend-request-accept"
              >
                {busy === 'accept' ? 'Aceitando…' : 'Aceitar pedido'}
              </PxButton>
              <PxButton
                variant="default"
                block
                disabled={busy !== null}
                onPress={() => void handleRemove('decline')}
              >
                {busy === 'decline' ? 'Recusando…' : 'Recusar pedido'}
              </PxButton>
            </>
          )}

        {!isMe &&
          profile.friendshipStatus === 'pending' &&
          profile.friendshipDirection === 'outgoing' && (
            <PxButton
              variant="default"
              block
              disabled={busy !== null}
              onPress={() => void handleRemove('cancel')}
            >
              {busy === 'cancel' ? 'Cancelando…' : 'Cancelar pedido'}
            </PxButton>
          )}

        {!isMe && profile.friendshipStatus === 'accepted' && (
          <PxButton
            variant="default"
            block
            disabled={busy !== null}
            onPress={() => void handleRemove('unfriend')}
          >
            {busy === 'unfriend' ? 'Removendo…' : 'Remover amizade'}
          </PxButton>
        )}

        {!isMe && profile.friendshipStatus !== 'blocked' && (
          <PxButton
            variant="coral"
            size="small"
            block
            disabled={busy !== null}
            onPress={() => void handleBlock()}
            testID="friend-block-btn"
          >
            {busy === 'block' ? 'Bloqueando…' : 'Bloquear usuário'}
          </PxButton>
        )}

        <PxButton size="small" variant="ghost" block disabled={busy !== null} onPress={onClose}>
          Fechar
        </PxButton>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  hero: { alignItems: 'center', gap: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6, marginTop: 4 },
  grid: { gap: 8 },
  gridRow: { flexDirection: 'row', gap: 8 },
  statCell: { flex: 1, minWidth: 0, paddingVertical: 8, paddingHorizontal: 10, gap: 4 },
  errorBox: { paddingVertical: 10, paddingHorizontal: 12 },
  actions: { gap: 8, marginTop: 2 },
});
