// Tela de Stats (por cima do mapa, com rolagem): perfil e nível, totais, cidades, coleção estilo pokédex,
// histórico com exportação GPX e ajustes. Port de legacy/src/ui/screens/StatsScreen.tsx + global.css.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Animated, Linking, Platform, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View,
  type LayoutChangeEvent, type TextStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useGame } from '../../game/store.ts';
import { levelFromXp } from '../../game/progression.ts';
import { buildAchievementOverview } from '../../game/achievements.ts';
import { cityPercent } from '../../game/cities.ts';
import { wipeAll } from '../../game/persist.ts';
import { exportGpx } from '../../game/gpx.ts';
import { exportAllActivities, importActivitiesFromFile, type ImportProgress } from '../../game/activitiesTransfer.ts';
import { cellSizeM, formatArea, formatDistance, formatDuration } from '../../game/geo.ts';
import { sfx } from '../../game/audio.ts';
import { GAME_NAME } from '../../game/config.ts';
// sem extensão: há variante .web.ts
import { confirmAsync } from '../../services/confirm';
import { mapAuthError, signOutAndReset, updateProfileSettings } from '../../services/auth.ts';
import { isSupabaseConfigured } from '../../services/supabase.ts';
import { pushAllLocalToCloud } from '../../services/sync.ts';
import { resolveAvatar } from '../../sprites/avatar.ts';
import { POI_CATEGORIES, POI_INFO, poiIcon, RARITY_INFO, type PoiCategory } from '../../sprites/items.ts';
import { iconRaster, type IconName } from '../../sprites/icons.ts';
import type { Raster } from '../../sprites/pixel.ts';
import type { Modality, Settings } from '../../game/types.ts';
import { BadgeImg, CharacterSprite, CoinImg, Icon, PixelImage, PoiIconImg } from '../components/Sprites.tsx';
import { Arcade, Bar, Chip, Inset, PxBox, PxButton, PxCell, PxOutline, Txt } from '../components/Px.tsx';
import { C, FILL, uiFont, useSafe } from '../theme.ts';

/** Quebra uma lista em linhas de `n` (as grades do CSS viram linhas de flex com colunas iguais). */
function rows<T>(items: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** Data e hora curtas ("18/10/2026, 07:42"), como o original; se o Intl do aparelho recusar as opções, monta à mão. */
function shortDateTime(ms: number): string {
  const d = new Date(ms);
  try {
    return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
}

/** `filter: grayscale(1) brightness(0.55)` (`.dex-cell.zero img`) aplicado direto no raster. */
function grayRaster(src: Raster): Raster {
  const data = new Uint8ClampedArray(src.data.length);
  for (let i = 0; i < data.length; i += 4) {
    const d = src.data;
    const y = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) * 0.55;
    data[i] = data[i + 1] = data[i + 2] = Math.round(y);
    data[i + 3] = d[i + 3];
  }
  return { w: src.w, h: src.h, data };
}

function DexIcon({ category, zero }: { category: PoiCategory; zero: boolean }) {
  if (!zero) return <PoiIconImg category={category} size={36} />;
  return (
    <PixelImage
      rasterKey={`poiicon-gray:${category}`}
      make={() => grayRaster(poiIcon(category))}
      width={36}
      height={36}
    />
  );
}

/**
 * Ícone da modalidade no histórico. No original era um <img width=28> dentro de `.list-item`, e a regra
 * `.list-item > img { width: 34px; height: 44px }` o esticava para 34×44: mantido igual.
 */
function ActivityIcon({ modality }: { modality: Modality }) {
  return (
    <PixelImage
      rasterKey={`icon:${modality}:${C.cream}:`}
      make={() => iconRaster(modality, C.cream)}
      width={34}
      height={44}
      style={styles.noShrink}
    />
  );
}

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

/** Borda tracejada de 2 px (`border-top: 2px dashed`): traços de 6 px, espaçados por igual até as pontas. */
function DashedLine() {
  const [n, setN] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    setN(Math.max(1, Math.round((w + 4) / 10)));
  };
  return (
    <View style={styles.dashed} onLayout={onLayout}>
      {Array.from({ length: n }, (_, i) => (
        <View key={i} style={styles.dash} />
      ))}
    </View>
  );
}

/** Interruptor `.switch`: o pino anda 26 px em 3 degraus (transition 120ms steps(3)). */
function Switch({
  value, label, onPress, testID,
}: { value: boolean; label: string; onPress: () => void; testID?: string }) {
  const [x] = useState(() => new Animated.Value(value ? 1 : 0));
  useEffect(() => {
    const a = Animated.timing(x, {
      toValue: value ? 1 : 0,
      duration: 120,
      easing: (t) => (t >= 1 ? 1 : Math.floor(t * 3) / 3),
      useNativeDriver: false,
    });
    a.start();
    return () => a.stop();
  }, [value, x]);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      onPress={onPress}
      testID={testID}
      style={[styles.switch, value && styles.switchOn]}
    >
      <View style={styles.switchFrame} />
      <Animated.View
        style={[
          styles.knob,
          value && styles.knobOn,
          { transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [0, 26] }) }] },
        ]}
      />
    </Pressable>
  );
}

function Setting({ first, title, desc, children }: { first?: boolean; title: string; desc: string; children: ReactNode }) {
  return (
    <View>
      {!first && <DashedLine />}
      <View style={styles.setting}>
        <View style={styles.settingText}>
          <Txt weight={700}>{title}</Txt>
          <Txt size={13} color={C.muted}>
            {desc}
          </Txt>
        </View>
        {children}
      </View>
    </View>
  );
}

function Toggle({ k, label, desc, first }: { k: keyof Settings; label: string; desc: string; first?: boolean }) {
  const value = useGame((s) => s.settings[k]);
  const setSetting = useGame((s) => s.setSetting);
  return (
    <Setting first={first} title={label} desc={desc}>
      <Switch
        value={value}
        label={label}
        onPress={() => {
          setSetting(k, !value);
          sfx.click();
        }}
      />
    </Setting>
  );
}

function Link({ url, children }: { url: string; children: string }) {
  return (
    <Txt color={C.sky} style={styles.link} accessibilityRole="link" onPress={() => void Linking.openURL(url)}>
      {children}
    </Txt>
  );
}

export function StatsScreen() {
  const profile = useGame((s) => s.profile);
  const xp = useGame((s) => s.xp);
  const wallet = useGame((s) => s.wallet);
  const totals = useGame((s) => s.totals);
  const cities = useGame((s) => s.cities);
  const captures = useGame((s) => s.captures);
  const activities = useGame((s) => s.activities);
  const live = useGame((s) => s.live);
  const achievements = useGame((s) => s.achievements);
  const fix = useGame((s) => s.fix);
  const pushModal = useGame((s) => s.pushModal);
  const toast = useGame((s) => s.toast);
  const authUserId = useGame((s) => s.authUserId);
  const authEmail = useGame((s) => s.authEmail);
  const syncing = useGame((s) => s.syncing);
  const lastSyncError = useGame((s) => s.lastSyncError);
  const lastSyncedAt = useGame((s) => s.lastSyncedAt);
  const pendingMigration = useGame((s) => s.pendingMigration);
  const pendingInviteUsername = useGame((s) => s.pendingInviteUsername);

  const [showAll, setShowAll] = useState(false);
  const [transferring, setTransferring] = useState<'import' | 'export' | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const cancelImportRef = useRef(false);
  const [usernameDraft, setUsernameDraft] = useState<string | null>(null);
  const [isPublicDraft, setIsPublicDraft] = useState<boolean | null>(null);
  const [usernameFocused, setUsernameFocused] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const { width } = useWindowDimensions();
  const { safeT, tabbarH } = useSafe();

  const capList = useMemo(() => Object.values(captures).sort((a, b) => b.capturedAt - a.capturedAt), [captures]);
  const byCat = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of capList) m[c.category] = (m[c.category] ?? 0) + 1;
    return m;
  }, [capList]);
  const achOverview = useMemo(
    () => buildAchievementOverview({ totals, cities, captures, activities, live, achievements }),
    [totals, cities, captures, activities, live, achievements],
  );

  if (!profile) return null;
  const effectiveUsername = usernameDraft ?? (profile.username ?? '');
  const effectiveIsPublic = isPublicDraft ?? (profile.isPublic ?? true);
  const lvl = levelFromXp(xp);
  const avatar = resolveAvatar(profile);
  const cityList = Object.values(cities).sort((a, b) => cityPercent(b) - cityPercent(a));
  const areaTotal = totals.cells * cellSizeM(fix?.lat ?? -23.5) ** 2;
  // media queries do original: totais em 3 colunas a partir de 520 px, coleção em 10 a partir de 720 px
  const totalCols = width >= 520 ? 3 : 2;
  const dexCols = width >= 720 ? 10 : 5;
  const totalVal = Math.min(15, Math.max(12, width * 0.036));

  const totalItems: [string, string][] = [
    ['Distância', formatDistance(totals.distanceM)],
    ['Em movimento', formatDuration(totals.movingS)],
    ['Atividades', String(totals.activities)],
    ['Área revelada', formatArea(areaTotal)],
    ['Moedas', totals.coinsValue.toLocaleString('pt-BR')],
    ['Capturas', String(totals.captures)],
  ];

  const wipe = async () => {
    const ok = await confirmAsync('Apagar todo o progresso deste aparelho?', 'Não dá para desfazer.', 'Apagar');
    if (!ok) return;
    await wipeAll();
    useGame.getState().resetProgress();
  };

  const saveProfileIdentity = async () => {
    if (savingProfile) return;
    sfx.click();
    setProfileMsg(null);
    setProfileError(null);
    setSavingProfile(true);
    try {
      await updateProfileSettings({
        ...(effectiveUsername.trim().length > 0 ? { username: effectiveUsername } : {}),
        isPublic: effectiveIsPublic,
      });
      setUsernameDraft(null);
      setIsPublicDraft(null);
      setProfileMsg(authUserId ? 'Perfil atualizado na nuvem!' : 'Perfil salvo neste aparelho.');
    } catch (err) {
      setProfileError(mapAuthError(err));
    } finally {
      setSavingProfile(false);
    }
  };

  const syncNow = async () => {
    if (syncBusy || syncing) return;
    sfx.click();
    setSyncBusy(true);
    try {
      await pushAllLocalToCloud();
      toast('Sincronizado com a nuvem!', 'info');
    } catch (err) {
      toast(mapAuthError(err), 'warn');
    } finally {
      setSyncBusy(false);
    }
  };

  const logout = async () => {
    if (loggingOut) return;
    const ok = await confirmAsync(
      'Sair da conta?',
      'Os dados locais deste aparelho serão limpos. Seu progresso na nuvem continua seguro.',
      'Sair',
    );
    if (!ok) return;
    setLoggingOut(true);
    try {
      await signOutAndReset();
    } finally {
      setLoggingOut(false);
    }
  };

  const runExport = async () => {
    if (transferring) return;
    sfx.click();
    setTransferring('export');
    try {
      await exportAllActivities();
    } finally {
      setTransferring(null);
    }
  };

  const runImport = async () => {
    if (transferring) return;
    sfx.click();
    cancelImportRef.current = false;
    setTransferring('import');
    setImportProgress({ percent: 0, label: 'Selecionando arquivo…' });
    try {
      await importActivitiesFromFile({
        onProgress: (p) => setImportProgress(p),
        isCancelled: () => cancelImportRef.current,
      });
    } finally {
      setTransferring(null);
      setImportProgress(null);
    }
  };

  return (
    <View style={styles.screen}>
      {/* linear-gradient(rgba(29,23,48,.94), rgba(29,23,48,.98)) sobre as listras de 45°: as listras ficam abaixo
          de 1 nível de cor, então sobra o degradê já composto */}
      <LinearGradient colors={['#1e1831', C.ink]} style={styles.noTouchFill} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingTop: 16 + safeT, paddingHorizontal: 14, paddingBottom: tabbarH + 28 }}
        testID="stats-scroll"
      >
        <View style={styles.inner}>
          <PxBox style={styles.profileCard} testID="profile-card">
            <CharacterSprite avatar={avatar} modality={profile.modality} facing="down" width={96} />
            <View style={styles.profileBody}>
              <Arcade size={15} spacing={0} lh={1.4}>
                {profile.name}
              </Arcade>
              {profile.username ? (
                <Txt size={13} weight={700} color={C.sky}>
                  @{profile.username}
                </Txt>
              ) : null}
              <Txt color={C.gold} weight={700}>
                Nível {lvl.level} · {lvl.title}
              </Txt>
              <View style={styles.xpline}>
                <Txt size={12} color={C.muted}>
                  XP
                </Txt>
                <Txt size={12} color={C.muted}>
                  {lvl.current} / {lvl.needed}
                </Txt>
              </View>
              <Bar percent={(lvl.current / lvl.needed) * 100} />
              <View style={styles.profileRow}>
                <Chip>
                  <CoinImg size={16} /> {wallet.toLocaleString('pt-BR')}
                </Chip>
                <Chip>
                  <Icon name={profile.modality} size={16} /> {profile.modality === 'bike' ? 'Ciclismo' : 'Corrida'}
                </Chip>
                <PxButton size="small" variant="sky" onPress={() => pushModal({ type: 'avatar' })} testID="edit-avatar">
                  Editar avatar
                </PxButton>
              </View>
            </View>
          </PxBox>

          <Section icon="cloud" title="CONTA E SINCRONIZAÇÃO">
            <PxBox style={styles.accountCard}>
              {authUserId ? (
                <View style={styles.accountStatusRow}>
                  <Chip dot={C.mint} testID="auth-status-email">
                    {authEmail ?? 'Conta conectada'}
                  </Chip>
                  <Txt size={12} color={lastSyncError ? C.coral : C.muted}>
                    {syncing
                      ? 'Sincronizando…'
                      : lastSyncError
                        ? `Erro: ${lastSyncError}`
                        : lastSyncedAt
                          ? `Última sincronização: ${shortDateTime(lastSyncedAt)}`
                          : 'Conectado à nuvem'}
                  </Txt>
                </View>
              ) : (
                <View style={styles.accountGuest}>
                  <Txt size={14} color={C.muted}>
                    Modo convidado (local) — entre com e-mail e senha para salvar seu progresso na nuvem.
                  </Txt>
                  {isSupabaseConfigured() && (
                    <PxButton
                      variant="gold"
                      block
                      onPress={() => {
                        sfx.click();
                        pushModal({ type: 'auth' });
                      }}
                      testID="auth-open-btn"
                    >
                      Entrar / Salvar na nuvem
                    </PxButton>
                  )}
                </View>
              )}

              {pendingInviteUsername ? (
                <View style={styles.accountStatusRow}>
                  <Chip dot={C.sky}>Convite salvo: @{pendingInviteUsername}</Chip>
                </View>
              ) : null}

              {pendingMigration ? (
                <PxButton
                  size="small"
                  variant="gold"
                  block
                  onPress={() => {
                    sfx.click();
                    pushModal({ type: 'migration' });
                  }}
                >
                  Resolver conflito de migração
                </PxButton>
              ) : null}

              <DashedLine />

              <View style={styles.usernameField}>
                <Txt weight={700} size={13} upper spacing={0.04} color={C.muted}>
                  @username
                </Txt>
                <View style={styles.inputBox}>
                  <Inset side="top" h={3} color={C.cream2} />
                  <PxOutline color={usernameFocused ? C.gold : C.ink} />
                  <TextInput
                    value={effectiveUsername}
                    onChangeText={(v) => {
                      setUsernameDraft(v);
                      if (profileError) setProfileError(null);
                      if (profileMsg) setProfileMsg(null);
                    }}
                    maxLength={24}
                    placeholder="ex: ciclista_sp"
                    placeholderTextColor="#757575"
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    onFocus={() => setUsernameFocused(true)}
                    onBlur={() => setUsernameFocused(false)}
                    cursorColor={C.ink}
                    underlineColorAndroid="transparent"
                    accessibilityLabel="Nome de usuário"
                    style={styles.input}
                    testID="username-input"
                  />
                </View>
              </View>

              <Setting
                first
                title="Perfil público"
                desc="Permite aparecer na busca de amigos e no ranking global."
              >
                <Switch
                  value={effectiveIsPublic}
                  label="Perfil público"
                  testID="profile-public-toggle"
                  onPress={() => {
                    sfx.click();
                    setIsPublicDraft(!effectiveIsPublic);
                    setProfileMsg(null);
                    setProfileError(null);
                  }}
                />
              </Setting>

              {profileError ? (
                <Txt size={13} weight={700} color={C.coral}>
                  {profileError}
                </Txt>
              ) : profileMsg ? (
                <Txt size={13} weight={700} color={C.mint}>
                  {profileMsg}
                </Txt>
              ) : null}

              <View style={styles.accountActions}>
                <PxButton
                  size="small"
                  variant="sky"
                  disabled={savingProfile}
                  onPress={() => void saveProfileIdentity()}
                  style={styles.accountBtn}
                  testID="profile-save-btn"
                >
                  {savingProfile ? 'Salvando…' : 'Salvar perfil'}
                </PxButton>
                {authUserId ? (
                  <>
                    <PxButton
                      size="small"
                      variant="mint"
                      disabled={syncing || syncBusy}
                      onPress={() => void syncNow()}
                      style={styles.accountBtn}
                    >
                      {syncing || syncBusy ? 'Sincronizando…' : 'Sincronizar agora'}
                    </PxButton>
                    <PxButton
                      size="small"
                      variant="coral"
                      disabled={loggingOut}
                      onPress={() => void logout()}
                      style={styles.accountBtn}
                      testID="logout-btn"
                    >
                      {loggingOut ? 'Saindo…' : 'Sair da conta'}
                    </PxButton>
                  </>
                ) : null}
              </View>
            </PxBox>
          </Section>

          <Section icon="trophy" title="TOTAIS">
            <View style={styles.grid10}>
              {rows(totalItems, totalCols).map((row, r) => (
                <View key={r} style={styles.gridRow10}>
                  {row.map(([lbl, val]) => (
                    <PxBox key={lbl} style={styles.total}>
                      <Txt size={11} color={C.muted} upper spacing={0.05} weight={600} numberOfLines={1}>
                        {lbl}
                      </Txt>
                      <Arcade size={totalVal} spacing={0} numberOfLines={1}>
                        {val}
                      </Arcade>
                    </PxBox>
                  ))}
                  {Array.from({ length: totalCols - row.length }, (_, i) => (
                    <View key={`pad${i}`} style={styles.gridPad} />
                  ))}
                </View>
              ))}
            </View>
          </Section>

          <Section icon="medal" title="CONQUISTAS">
            <PxBox style={styles.achCard} testID="achievements-summary">
              <View style={styles.achHead}>
                <View style={styles.shrink}>
                  <Arcade size={13} spacing={0} color={C.gold}>
                    {achOverview.unlockedCount} {achOverview.unlockedCount === 1 ? 'CONQUISTA' : 'CONQUISTAS'}
                  </Arcade>
                  <Txt size={13} color={C.muted}>
                    {achOverview.fixedUnlockedTiers} de {achOverview.fixedTotalTiers} marcos fixos
                  </Txt>
                </View>
                <Chip>
                  <CoinImg size={14} /> +{achOverview.totalCoinsEarned.toLocaleString('pt-BR')}
                </Chip>
              </View>
              <Bar
                percent={
                  achOverview.fixedTotalTiers > 0
                    ? (achOverview.fixedUnlockedTiers / achOverview.fixedTotalTiers) * 100
                    : 0
                }
                variant="gold"
                height={11}
              />
              {achOverview.almostThere.length > 0 && (
                <View style={styles.achPreviewList}>
                  {achOverview.almostThere.map((it) => (
                    <PxCell key={it.id} style={styles.achPreviewItem}>
                      <Icon name={it.icon} size={20} color={C.gold} accent={C.cream} />
                      <View style={styles.achPreviewBody}>
                        <View style={styles.achPreviewTop}>
                          <Txt weight={700} size={14} numberOfLines={1} style={styles.shrink}>
                            {it.title}
                          </Txt>
                          {it.nextCoins != null && (
                            <View style={styles.achPreviewCoins}>
                              <CoinImg size={12} />
                              <Arcade size={9} spacing={0} color={C.gold}>
                                +{it.nextCoins}
                              </Arcade>
                            </View>
                          )}
                        </View>
                        <Bar percent={it.percent} variant="mint" height={7} />
                        <Txt size={12} color={C.muted}>
                          {it.progressLabel}
                        </Txt>
                      </View>
                    </PxCell>
                  ))}
                </View>
              )}
              <PxButton
                size="small"
                variant="gold"
                block
                testID="open-achievements"
                onPress={() => {
                  sfx.click();
                  pushModal({ type: 'achievements' });
                }}
              >
                Ver todas as conquistas
              </PxButton>
            </PxBox>
          </Section>

          <Section icon="flag" title="CIDADES DESBLOQUEADAS">
            {cityList.length === 0 ? (
              <PxBox style={styles.empty}>
                <Txt size={15} color={C.muted} align="center">
                  Grave sua primeira atividade para começar a revelar uma cidade.
                </Txt>
              </PxBox>
            ) : (
              cityList.map((c, i) => {
                const pct = cityPercent(c);
                return (
                  <PxBox key={c.id} style={[styles.city, i > 0 && styles.cityNext]}>
                    <View style={styles.cityTop}>
                      <Txt weight={700} size={17} style={styles.shrink}>
                        {c.name}
                      </Txt>
                      <Arcade size={14} spacing={0} color={C.mint}>
                        {pct.toFixed(pct < 1 ? 3 : 2).replace('.', ',')}%
                      </Arcade>
                    </View>
                    <Bar percent={Math.max(pct, pct > 0 ? 0.6 : 0)} variant="mint" height={14} />
                    <Txt size={13} color={C.muted}>
                      {formatArea(c.cells * c.cellAreaM2)} de {formatArea(c.areaM2)}
                      {c.state ? ` · ${c.state}` : ''}
                    </Txt>
                  </PxBox>
                );
              })
            )}
          </Section>

          <Section icon="star" title="COLEÇÃO">
            <View style={styles.grid8}>
              {rows(POI_CATEGORIES, dexCols).map((row, r) => (
                <View key={r} style={styles.gridRow8}>
                  {row.map((cat) => {
                    const n = byCat[cat] ?? 0;
                    return (
                      <View key={cat} style={styles.dexCol} accessibilityLabel={POI_INFO[cat].plural}>
                        <PxCell style={styles.dexCell}>
                          <DexIcon category={cat} zero={!n} />
                          <Arcade size={11} spacing={0}>
                            {n}
                          </Arcade>
                          <Txt size={10} lh={1.1} color={C.muted} align="center">
                            {POI_INFO[cat].plural}
                          </Txt>
                        </PxCell>
                      </View>
                    );
                  })}
                </View>
              ))}
            </View>
            {capList.length > 0 && (
              <View style={styles.list}>
                {(showAll ? capList : capList.slice(0, 6)).map((c) => (
                  <PxCell key={c.id} style={styles.listItem}>
                    <BadgeImg category={c.category} state="captured" width={34} style={styles.noShrink} />
                    <View style={styles.listBody}>
                      <Txt weight={700} numberOfLines={1}>
                        {c.name}
                      </Txt>
                      <Txt size={13} color={C.muted}>
                        <Txt color={RARITY_INFO[c.rarity].color}>{RARITY_INFO[c.rarity].label}</Txt> ·{' '}
                        {POI_INFO[c.category].label} · {new Date(c.capturedAt).toLocaleDateString('pt-BR')}
                        {c.cityId && cities[c.cityId] ? ` · ${cities[c.cityId].name}` : ''}
                      </Txt>
                    </View>
                  </PxCell>
                ))}
                {capList.length > 6 && (
                  <PxButton size="small" variant="ghost" block onPress={() => setShowAll((v) => !v)}>
                    {showAll ? 'Mostrar menos' : `Ver todas (${capList.length})`}
                  </PxButton>
                )}
              </View>
            )}
          </Section>

          <Section icon="clock" title="ATIVIDADES">
            {activities.length === 0 ? (
              <PxBox style={styles.empty}>
                <Txt size={15} color={C.muted} align="center">
                  Nenhuma atividade ainda. Toque em Gravar e saia por aí!
                </Txt>
              </PxBox>
            ) : (
              <View style={[styles.list, styles.listFlush]}>
                {activities.slice(0, 30).map((a) => (
                  <PxCell key={a.id} style={styles.listItem}>
                    <ActivityIcon modality={a.modality} />
                    <View style={styles.listBody}>
                      <Txt weight={700} numberOfLines={1}>
                        {formatDistance(a.distanceM)} · {formatDuration(a.movingS || a.elapsedS)}
                      </Txt>
                      <Txt size={13} color={C.muted}>
                        {shortDateTime(a.startedAt)} ·{' '}
                        {a.coinsValue} moedas · {a.captures.length} capturas · +{a.xp} XP
                      </Txt>
                    </View>
                    <PxButton size="small" variant="ghost" label="Exportar GPX" onPress={() => void exportGpx(a)}>
                      <Icon name="download" size={16} />
                    </PxButton>
                  </PxCell>
                ))}
              </View>
            )}
          </Section>

          <Section icon="gear" title="AJUSTES">
            <PxBox style={styles.settings}>
              <Toggle first k="sound" label="Sons" desc="Efeitos chiptune ao coletar e capturar." />
              <Toggle k="haptics" label="Vibração" desc="Vibra ao pegar moedas e capturar pontos." />
              <Toggle
                k="simulator"
                label="Modo simulador"
                desc="GPS virtual para testar no computador: joystick, WASD/setas, Shift = turbo, botão direito/toque longo no mapa = teletransporte."
              />
              <Setting
                title="Importar atividades"
                desc="Carrega um .zip do Strava ou arquivo .gpx para revelar o mapa (não altera XP nem nível)."
              >
                {transferring === 'import' ? (
                  <PxButton
                    size="small"
                    variant="coral"
                    onPress={() => {
                      cancelImportRef.current = true;
                    }}
                  >
                    Cancelar
                  </PxButton>
                ) : (
                  <PxButton
                    size="small"
                    variant="mint"
                    disabled={transferring !== null}
                    onPress={() => void runImport()}
                  >
                    Importar
                  </PxButton>
                )}
              </Setting>
              {importProgress && (
                <View style={styles.importProgress}>
                  <View style={styles.importProgressHead}>
                    <Txt size={13} color={C.cream} style={styles.shrink} numberOfLines={1}>
                      {importProgress.label}
                    </Txt>
                    <Arcade size={10} spacing={0} color={C.mint}>
                      {Math.round(importProgress.percent)}%
                    </Arcade>
                  </View>
                  <Bar percent={importProgress.percent} variant="mint" height={12} />
                </View>
              )}
              <Setting
                title="Exportar atividades"
                desc="Salva todas as trilhas gravadas em um arquivo .zip no formato GPX."
              >
                <PxButton
                  size="small"
                  variant="sky"
                  disabled={transferring !== null || activities.length === 0}
                  onPress={() => void runExport()}
                >
                  {transferring === 'export' ? 'Exportando…' : 'Exportar'}
                </PxButton>
              </Setting>
              <Setting title="Apagar progresso" desc="Remove névoa revelada, capturas, moedas e histórico deste aparelho.">
                <PxButton size="small" variant="coral" onPress={() => void wipe()}>
                  Apagar
                </PxButton>
              </Setting>
            </PxBox>
          </Section>

          <Txt size={12} lh={1.6} color={C.muted} align="center" style={styles.credits}>
            {GAME_NAME} · protótipo front-end. Mapa: <Link url="https://openfreemap.org">OpenFreeMap</Link> ·{' '}
            <Link url="https://www.openmaptiles.org/">OpenMapTiles</Link> · dados ©{' '}
            <Link url="https://www.openstreetmap.org/copyright">OpenStreetMap</Link>. Cidades via Nominatim.
          </Txt>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { ...FILL, backgroundColor: C.ink },
  noTouchFill: { ...FILL, pointerEvents: 'none' },
  scroll: { flex: 1 },
  inner: { width: '100%', maxWidth: 620, alignSelf: 'center', gap: 22 },
  shrink: { flexShrink: 1 },
  noShrink: { flexShrink: 0 },

  // perfil
  profileCard: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14 },
  profileBody: { flex: 1, minWidth: 0 },
  xpline: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8, marginBottom: 4 },
  profileRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },

  // conta e sincronização
  accountCard: { gap: 10, padding: 14 },
  accountStatusRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  accountGuest: { gap: 10 },
  usernameField: { gap: 6 },
  inputBox: { backgroundColor: C.cream },
  input: {
    height: 42,
    paddingHorizontal: 12,
    paddingVertical: 0,
    margin: 0,
    borderWidth: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null),
    fontFamily: uiFont(700),
    fontSize: 16,
    color: C.ink,
    textAlignVertical: 'center',
    ...(Platform.OS === 'android' ? { includeFontPadding: false } : null),
  } as TextStyle,
  accountActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  accountBtn: { flexGrow: 1 },

  // seções
  h3: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  grid10: { gap: 10 },
  gridRow10: { flexDirection: 'row', gap: 10 },
  grid8: { gap: 8 },
  gridRow8: { flexDirection: 'row', gap: 8 },
  gridPad: { flex: 1 },
  total: { flex: 1, minWidth: 0, gap: 4, paddingTop: 10, paddingHorizontal: 10, paddingBottom: 12 },

  city: { gap: 8, paddingTop: 12, paddingHorizontal: 14, paddingBottom: 14 },
  cityNext: { marginTop: 14 },
  cityTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 },
  empty: { padding: 16 },

  // conquistas
  achCard: { gap: 10, padding: 14 },
  achHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  achPreviewList: { gap: 8 },
  achPreviewItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 10 },
  achPreviewBody: { flex: 1, minWidth: 0, gap: 4 },
  achPreviewTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  achPreviewCoins: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 },

  dexCol: { flex: 1, minWidth: 0 },
  dexCell: { flex: 1, alignItems: 'center', gap: 3, paddingTop: 8, paddingHorizontal: 2, paddingBottom: 6 },

  list: { gap: 8, marginTop: 12 },
  listFlush: { marginTop: 0 },
  listItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 12, minWidth: 0 },
  listBody: { flex: 1, minWidth: 0 },

  // ajustes
  settings: { gap: 2, paddingVertical: 6, paddingHorizontal: 14 },
  setting: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 12 },
  settingText: { flexShrink: 1 },
  importProgress: { gap: 6, paddingBottom: 12 },
  importProgressHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  dashed: { height: 2, flexDirection: 'row', justifyContent: 'space-between', overflow: 'hidden' },
  dash: { width: 6, height: 2, backgroundColor: C.panel3 },
  switch: { width: 54, height: 28, flexShrink: 0, backgroundColor: C.ink },
  switchOn: { backgroundColor: C.mintDark },
  switchFrame: { ...FILL, borderWidth: 3, borderColor: C.panel3, pointerEvents: 'none' },
  knob: { position: 'absolute', top: 4, left: 4, width: 20, height: 20, backgroundColor: C.muted },
  knobOn: { backgroundColor: C.cream },

  credits: { marginVertical: 12 },
  link: { textDecorationLine: 'underline' },
});
