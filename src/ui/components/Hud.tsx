// HUD por cima do mapa: barra de abas, chips do jogador, botões laterais, toasts, aviso de velocidade,
// joystick do simulador e cartão de POI. Port de legacy/src/ui/components/Hud.tsx + global.css.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Animated, Platform, Pressable, StyleSheet, View, type GestureResponderEvent, type StyleProp,
  type TextStyle, type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useGame } from '../../game/store.ts';
import { levelFromXp } from '../../game/progression.ts';
import { player, setSimInput } from '../../game/location.ts';
import { sfx } from '../../game/audio.ts';
import { cellOf, formatDistance, haversine } from '../../game/geo.ts';
import { fog } from '../../game/fog.ts';
import { cityPercent } from '../../game/cities.ts';
import { mapController, useFollowing } from '../../map/controller.ts';
import { resolveAvatar } from '../../sprites/avatar.ts';
import { POI_INFO, RARITY_INFO } from '../../sprites/items.ts';
import type { Tab, Toast } from '../../game/types.ts';
import { BadgeImg, CharacterSprite, CoinImg, Icon } from './Sprites.tsx';
import { Arcade, Bar, Chip, Inset, Muted, PxBox, PxButton, PxOutline, RarityTag, Txt } from './Px.tsx';
import { brighten, C, FILL, FONT, M, mix, useSafe } from '../theme.ts';

const useNative = Platform.OS !== 'web';

/** Relógio que re-renderiza a cada `ms` (distâncias, cronômetro). */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Índice que avança a cada `ms` enquanto `active` (animações em degraus, como `steps()` do CSS). */
function useStepper(ms: number, n: number, active: boolean): number {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setI((v) => (v + 1) % n), ms);
    // volta ao primeiro passo ao parar ou ao mudar o ritmo
    return () => {
      clearInterval(id);
      setI(0);
    };
  }, [ms, n, active]);
  return i;
}

/** Easing em degraus (CSS `steps(n)`, jump-end). */
const steps = (n: number) => (t: number) => (t >= 1 ? 1 : Math.floor(t * n) / n);

/** Entrada `toast-in` do CSS: desce 14px e aparece, em 4 degraus. */
function useToastIn(duration: number): Animated.Value {
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration, easing: steps(4), useNativeDriver: useNative }).start();
  }, [v, duration]);
  return v;
}

function toastInStyle(v: Animated.Value) {
  return {
    opacity: v,
    transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [-14, 0] }) }],
  };
}

// ---------------------------------------------------------------------------
// Barra de abas
// ---------------------------------------------------------------------------

const TABS: { id: Tab; label: string; icon: 'pin' | 'record' | 'stats' }[] = [
  { id: 'map', label: 'Mapa', icon: 'pin' },
  { id: 'record', label: 'Gravar', icon: 'record' },
  { id: 'stats', label: 'Stats', icon: 'stats' },
];

// `pulse` 1.2s steps(2): coral → meio-termo → claro → meio-termo, 300ms cada.
const ORB_PULSE = [C.coral, mix(C.coral, '#ff8a7a', 0.5), '#ff8a7a', mix(C.coral, '#ff8a7a', 0.5)];

export function TabBar() {
  const tab = useGame((s) => s.tab);
  const setTab = useGame((s) => s.setTab);
  const live = useGame((s) => s.live);
  const recording = live?.status === 'recording';
  const { safeB } = useSafe();
  const pulse = useStepper(300, 4, recording);
  // Durante uma atividade na aba Gravar, esconde o menu inferior para manter a tela limpa.
  if (tab === 'record' && live) return null;
  return (
    <View style={[styles.tabbar, { height: M.tabbarH + safeB }]} testID="tabbar">
      <LinearGradient
        colors={['rgba(29, 23, 48, 0)', 'rgba(29, 23, 48, 0.85)', 'rgba(29, 23, 48, 0.85)']}
        locations={[0, 0.35, 1]}
        style={styles.noTouchFill}
      />
      <View style={styles.tabRow}>
        {TABS.map((t) => {
          const active = tab === t.id;
          const center = t.id === 'record';
          const color = active ? C.gold : C.muted;
          return (
            <Pressable
              key={t.id}
              testID={`tab-${t.id}`}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              style={[styles.tab, center ? styles.tabCenter : styles.tabSide]}
              onPress={() => {
                if (tab !== t.id) sfx.click();
                setTab(t.id);
              }}
            >
              {center ? (
                <View style={[styles.orb, { backgroundColor: recording ? ORB_PULSE[pulse] : C.coral }]}>
                  <Inset side="bottom" h={5} color={C.coralDark} />
                  <Inset side="top" h={3} color="rgba(255, 255, 255, 0.3)" />
                  <PxOutline />
                  <View style={styles.tabIcon}>
                    {/* `.tab.active img` também pega o ícone do orbe */}
                    {active && (
                      <Icon name={recording ? 'pause' : 'record'} size={30} color={C.ink} accent={C.ink} style={styles.iconShadow} />
                    )}
                    <Icon name={recording ? 'pause' : 'record'} size={30} color={C.cream} accent={C.cream} />
                  </View>
                </View>
              ) : (
                <View style={styles.tabIcon}>
                  {/* `.tab.active img { filter: drop-shadow(0 2px 0 var(--ink)) }` */}
                  {active && <Icon name={t.icon} size={30} color={C.ink} accent={C.ink} style={styles.iconShadow} />}
                  <Icon name={t.icon} size={30} color={color} accent={active ? C.cream : C.iconMuted} />
                </View>
              )}
              <Txt size={13} weight={700} spacing={0.04} upper color={color} numberOfLines={1}>
                {recording && center ? 'Gravando' : t.label}
              </Txt>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// HUD superior
// ---------------------------------------------------------------------------

/** Linha do topo (`.top-hud`): absoluta abaixo da área segura, itens nas pontas. */
export function TopHud({ children, style }: { children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { safeT } = useSafe();
  return <View style={[styles.topHud, { top: 10 + safeT }, style]}>{children}</View>;
}

export function PlayerChip() {
  const profile = useGame((s) => s.profile);
  const xp = useGame((s) => s.xp);
  if (!profile) return null;
  const lvl = levelFromXp(xp);
  return (
    <PxBox style={styles.playerChip} testID="player-chip">
      <CharacterSprite
        avatar={resolveAvatar(profile)}
        modality={profile.modality}
        animate={false}
        width={48}
        style={styles.avatar}
      />
      <View style={styles.who}>
        <Txt weight={700} size={15} numberOfLines={1}>
          {profile.name}
        </Txt>
        <Arcade size={9} spacing={0} color={C.gold}>
          NV {lvl.level}
        </Arcade>
        <Bar percent={(lvl.current / lvl.needed) * 100} height={7} style={styles.chipBar} />
      </View>
    </PxBox>
  );
}

export function Wallet() {
  const wallet = useGame((s) => s.wallet);
  return (
    <PxBox style={styles.wallet} testID="wallet" accessibilityLabel="Moedas">
      <CoinImg size={20} />
      <Arcade size={13} spacing={0} color={C.gold}>
        {wallet.toLocaleString('pt-BR')}
      </Arcade>
    </PxBox>
  );
}

/** Cidade atual e % explorado (usado nas abas Mapa e Gravar). */
export function CityChip({ style }: { style?: StyleProp<ViewStyle> }) {
  const city = useGame((s) => (s.currentCityId ? s.cities[s.currentCityId] : null));
  if (!city) return null;
  const pct = cityPercent(city);
  return (
    <Chip style={style}>
      <Icon name="flag" size={14} />
      {city.name} · {pct.toFixed(pct < 1 ? 3 : 2).replace('.', ',')}%
    </Chip>
  );
}

/** Botões da direita (embaixo, ao alcance do polegar): centralizar e, opcionalmente, zoom. */
export function SideButtons({ showZoom, bottom }: { showZoom: boolean; bottom?: number }) {
  const following = useFollowing();
  const { tabbarH } = useSafe();
  return (
    <View style={[styles.sideButtons, { bottom: bottom ?? tabbarH + 16 }]}>
      {!following && (
        <PxButton variant="gold" style={styles.sideBtn} onPress={() => mapController.recenter()} label="Centralizar">
          <Icon name="target" size={24} color={C.ink} accent={C.coral} />
        </PxButton>
      )}
      {showZoom && (
        <>
          <PxButton variant="ghost" style={styles.sideBtn} onPress={() => mapController.zoomBy(0.8)} label="Aproximar">
            <Arcade size={16} spacing={0}>
              +
            </Arcade>
          </PxButton>
          <PxButton variant="ghost" style={styles.sideBtn} onPress={() => mapController.zoomBy(-0.8)} label="Afastar">
            {/* A Press Start 2P não tem "−": o navegador caía na Pixelify Sans, mas com a linha de base da Press Start. */}
            <Txt size={16} weight={700} style={styles.minus}>
              −
            </Txt>
          </PxButton>
        </>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

interface ToastItem {
  t: Toast;
  leaving: boolean;
}

export function Toasts() {
  const toasts = useGame((s) => s.toasts);
  const { safeT } = useSafe();
  const [items, setItems] = useState<ToastItem[]>(() => toasts.map((t) => ({ t, leaving: false })));
  // ajusta a lista durante o render quando os toasts mudam (sem efeito: evita um render a mais)
  const [seen, setSeen] = useState(toasts);
  if (seen !== toasts) {
    setSeen(toasts);
    setItems((prev) => {
      const live = new Set(toasts.map((t) => t.id));
      const next = prev.map((it) => (live.has(it.t.id) || it.leaving ? it : { ...it, leaving: true }));
      for (const t of toasts) if (!prev.some((it) => it.t.id === t.id)) next.push({ t, leaving: false });
      return next;
    });
  }
  const gone = useCallback((id: number) => setItems((prev) => prev.filter((it) => it.t.id !== id)), []);
  return (
    <View style={[styles.toastsWrap, { top: 84 + safeT }]} testID="toasts">
      <View style={styles.toasts}>
        {items.map((it, i) => (
          <ToastView
            key={it.t.id}
            toast={it.t}
            leaving={it.leaving}
            afterCity={i > 0 && items[i - 1].t.kind === 'city'}
            onGone={gone}
          />
        ))}
      </View>
    </View>
  );
}

function ToastView({ toast: t, leaving, afterCity, onGone }: {
  toast: Toast;
  leaving: boolean;
  afterCity: boolean;
  onGone: (id: number) => void;
}) {
  const v = useToastIn(220);
  useEffect(() => {
    if (!leaving) return;
    const a = Animated.timing(v, { toValue: 0, duration: 220, easing: steps(4), useNativeDriver: useNative });
    a.start(({ finished }) => finished && onGone(t.id));
    return () => a.stop();
  }, [leaving, v, onGone, t.id]);
  // No original, `.toast.city` também casava com a regra `.city` das Stats (coluna, padding maior, gap 8):
  // o toast de cidade sai com o ícone em cima. Mantido igual.
  const city = t.kind === 'city';
  const ach = t.kind === 'achievement';
  return (
    <Animated.View style={toastInStyle(v)}>
      <PxBox
        bg={city ? C.mint : t.kind === 'warn' ? C.coral : undefined}
        color={t.kind === 'coin' || ach ? C.gold : city ? C.ink : undefined}
        style={[styles.toast, city && styles.toastCity, city && afterCity && { marginTop: 14 }]}
      >
        {t.kind === 'coin' && <CoinImg kind={t.coinKind} size={20} />}
        {ach && <Icon name="trophy" size={20} color={C.gold} accent={C.cream} />}
        {city && <Icon name="flag" size={20} color={C.ink} accent={C.cream} />}
        {t.kind === 'warn' && <Icon name="bolt" size={20} />}
        <Txt weight={700} size={15} style={styles.shrink}>
          {t.text}
        </Txt>
      </PxBox>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Aviso de velocidade
// ---------------------------------------------------------------------------

// `blink` 1s steps(2) com brightness(1.15) no meio: 1 → 1,075 → 1,15 → 1,075, 250ms cada.
const BLINK = [1, 1.075, 1.15, 1.075];

export function SpeedBanner() {
  const warn = useGame((s) => s.speedWarning);
  const { safeT } = useSafe();
  const i = useStepper(250, 4, warn);
  if (!warn) return null;
  const k = BLINK[i];
  return (
    <View style={[styles.bannerWrap, { top: 150 + safeT }]}>
      <PxBox
        bg={brighten(C.coral, k)}
        color={brighten(C.cream, k)}
        outline={brighten(C.ink, k)}
        style={styles.banner}
        testID="speed-banner"
      >
        <Icon name="bolt" size={22} color={brighten(C.gold, k)} accent={brighten(C.gold, k)} />
        <Txt weight={700} style={styles.shrink}>
          Rápido demais! Exploração pausada até você voltar ao ritmo de pedal/corrida.
        </Txt>
      </PxBox>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Joystick do simulador
// ---------------------------------------------------------------------------

const PAD = 112;
const PAD_BORDER = 3;
const KNOB = 48;
const PAD_MAX = PAD / 2 - 12;

/** Joystick virtual do modo simulador (na web o teclado WASD/setas também funciona, via game/location). */
export function SimPad() {
  const sim = useGame((s) => s.settings.simulator);
  const tab = useGame((s) => s.tab);
  const [knob] = useState(() => new Animated.ValueXY({ x: 0, y: 0 }));
  const origin = useRef({ x: 0, y: 0 });

  // Solta o joystick se o pad sumir no meio do gesto.
  useEffect(() => () => setSimInput(0, 0), []);

  if (!sim || tab === 'stats') return null;

  const update = (e: GestureResponderEvent) => {
    let dx = e.nativeEvent.pageX - origin.current.x;
    let dy = e.nativeEvent.pageY - origin.current.y;
    const len = Math.hypot(dx, dy);
    if (len > PAD_MAX) {
      dx = (dx / len) * PAD_MAX;
      dy = (dy / len) * PAD_MAX;
    }
    knob.setValue({ x: dx, y: dy });
    setSimInput(dx / PAD_MAX, -dy / PAD_MAX);
  };
  const end = () => {
    knob.setValue({ x: 0, y: 0 });
    setSimInput(0, 0);
  };

  return (
    <View
      style={styles.simpad}
      testID="simpad"
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        // Centro do pad em coordenadas de página. locationX/Y é relativo à caixa do pad (os filhos não recebem
        // toque); daí em diante só pageX/Y, que continua certo mesmo com o dedo fora do pad.
        const { pageX, pageY, locationX, locationY } = e.nativeEvent;
        origin.current = { x: pageX - locationX + PAD / 2, y: pageY - locationY + PAD / 2 };
        update(e);
      }}
      onResponderMove={update}
      onResponderRelease={end}
      onResponderTerminate={end}
    >
      <View style={styles.simRing} />
      <View style={styles.simTagWrap}>
        <Txt size={11} weight={700} spacing={0.06} shadow={{ y: 2 }} numberOfLines={1}>
          SIMULADOR
        </Txt>
      </View>
      <Animated.View style={[styles.knob, { transform: knob.getTranslateTransform() }]}>
        <View style={styles.knobClip}>
          {/* inset 0 3px 0 rgba(255,255,255,.35): o fundo é o brilho; o resto é coberto pelo círculo descido 3px */}
          <View style={[styles.knobCircle, styles.knobDown]}>
            {/* inset 0 -5px 0 #5a48c8: dentro do círculo descido, o violeta é o círculo subido 5px */}
            <View style={[styles.knobCircle, styles.knobUp]} />
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Cartão de POI
// ---------------------------------------------------------------------------

export function PoiCard() {
  const selected = useGame((s) => s.selected);
  if (!selected) return null;
  return <PoiCardInner key={selected.id} />;
}

function PoiCardInner() {
  const selected = useGame((s) => s.selected)!;
  const select = useGame((s) => s.select);
  const capture = useGame((s) => s.captures[selected.id]);
  const tab = useGame((s) => s.tab);
  const hasLive = useGame((s) => s.live != null);
  const { safeB, tabbarH } = useSafe();
  const v = useToastIn(200);
  useNow(1000);
  const info = POI_INFO[selected.category];
  const rarity = RARITY_INFO[selected.rarity];
  const revealed = !!capture || fog.has(cellOf(selected));
  const here = player.display;
  const dist = here ? haversine(here, selected) : null;
  const status = capture
    ? `Capturado em ${new Date(capture.capturedAt).toLocaleDateString('pt-BR')}`
    : !revealed
      ? 'Explore a névoa para descobrir o que é.'
      : dist != null && dist <= info.radius
        ? 'Você está aqui! Inicie uma atividade para capturar.'
        : `Chegue a ${info.radius} m durante uma atividade para capturar.`;
  const cardBottom = tab === 'record' && hasLive ? safeB + 90 : tabbarH + 14;
  return (
    <Animated.View style={[styles.poiWrap, { bottom: cardBottom }, toastInStyle(v)]}>
      <PxBox style={styles.poiCard} testID="poi-card">
        <BadgeImg category={selected.category} state={capture ? 'captured' : revealed ? 'wild' : 'fog'} width={60} />
        <View style={styles.poiInfo}>
          <Txt weight={700} size={17} lh={1.2} style={styles.poiTitle}>
            {revealed ? selected.name : '??? Ponto misterioso'}
          </Txt>
          <View style={styles.poiTags}>
            <RarityTag color={rarity.color}>{revealed ? rarity.label : '???'}</RarityTag>
            <Muted>{revealed ? info.label : 'na névoa'}</Muted>
          </View>
          <Muted size={14} style={styles.poiStatus}>
            {status}
            {dist != null && !capture && ` · ${formatDistance(dist)}`}
          </Muted>
        </View>
        <PxButton variant="ghost" size="small" style={styles.poiClose} onPress={() => select(null)} label="Fechar">
          <Icon name="close" size={16} />
        </PxButton>
      </PxBox>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  shrink: { flexShrink: 1 },
  noTouchFill: { ...FILL, pointerEvents: 'none' },

  // barra de abas
  tabbar: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 20 },
  // As abas transbordam a barra para baixo como no grid do original (linha de 71,5px a partir do padding de 8px).
  tabRow: {
    position: 'absolute',
    top: 8,
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
  },
  tab: { alignItems: 'center', gap: 4, paddingTop: 6, paddingBottom: 4, flexBasis: 0 },
  tabSide: { flexGrow: 1 },
  tabCenter: { flexGrow: 1.25, marginBottom: 4 },
  tabIcon: { width: 30, height: 30 },
  iconShadow: { position: 'absolute', left: 0, top: 2 },
  orb: {
    width: 62,
    height: 62,
    marginTop: -26,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // topo
  topHud: {
    position: 'absolute',
    left: M.gutter,
    right: M.gutter,
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    zIndex: 10,
    pointerEvents: 'box-none',
  },
  playerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: 6,
    paddingRight: 12,
    paddingBottom: 8,
    paddingLeft: 6,
    minWidth: 0,
    flexShrink: 1,
  },
  avatar: { marginTop: -14, marginBottom: -6, flexShrink: 0 },
  who: { minWidth: 0, flexShrink: 1, gap: 3 },
  chipBar: { width: 110 },
  wallet: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: 8,
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  sideButtons: {
    position: 'absolute',
    right: M.gutter,
    gap: 12,
    zIndex: 10,
    pointerEvents: 'box-none',
  },
  sideBtn: { width: 46, height: 46, padding: 0, paddingBottom: 3 },
  // Web: mesma pilha de fontes do original. Nativo: desce a diferença de linha de base entre as duas fontes
  // (Press Start: ascent 1, descent 0; Pixelify: 0,92/0,28 → 0,18em).
  minus: Platform.select<TextStyle>({
    web: { fontFamily: `${FONT.arcade}, ${FONT.ui700}` },
    default: { transform: [{ translateY: 16 * 0.18 }] },
  }),

  // toasts
  toastsWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 40, pointerEvents: 'none' },
  toasts: { width: '92%', maxWidth: 420, alignItems: 'center', gap: 8 },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 8,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  toastCity: { flexDirection: 'column', paddingTop: 12, paddingBottom: 14 },

  // aviso
  bannerWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 15, pointerEvents: 'box-none' },
  banner: {
    width: '92%',
    maxWidth: 420,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: 10,
    paddingHorizontal: 14,
    paddingBottom: 12,
  },

  // joystick
  simpad: {
    position: 'absolute',
    left: 16,
    top: '44%',
    width: PAD,
    height: PAD,
    borderRadius: PAD / 2,
    borderWidth: PAD_BORDER,
    borderColor: C.ink,
    backgroundColor: 'rgba(29, 23, 48, 0.55)',
    zIndex: 12,
  },
  simRing: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    borderRadius: PAD / 2,
    borderWidth: 3,
    borderColor: 'rgba(143, 124, 255, 0.5)',
    pointerEvents: 'none',
  },
  simTagWrap: { position: 'absolute', top: -24, left: -40, right: -40, alignItems: 'center', pointerEvents: 'none' },
  knob: {
    position: 'absolute',
    left: (PAD - 2 * PAD_BORDER - KNOB) / 2,
    top: (PAD - 2 * PAD_BORDER - KNOB) / 2,
    width: KNOB,
    height: KNOB,
    borderRadius: KNOB / 2,
    borderWidth: 3,
    borderColor: C.ink,
    backgroundColor: C.ink,
    pointerEvents: 'none',
  },
  knobClip: {
    width: KNOB - 6,
    height: KNOB - 6,
    borderRadius: (KNOB - 6) / 2,
    overflow: 'hidden',
    backgroundColor: mix(C.violet, '#ffffff', 0.35),
  },
  knobCircle: {
    position: 'absolute',
    left: 0,
    width: KNOB - 6,
    height: KNOB - 6,
    borderRadius: (KNOB - 6) / 2,
    overflow: 'hidden',
  },
  knobDown: { top: 3, backgroundColor: '#5a48c8' },
  knobUp: { top: -8, backgroundColor: C.violet },

  // cartão de POI
  poiWrap: {
    position: 'absolute',
    left: M.gutter,
    right: M.gutter,
    alignItems: 'center',
    zIndex: 30,
    pointerEvents: 'box-none',
  },
  poiCard: {
    width: '100%',
    maxWidth: 480,
    padding: 14,
    flexDirection: 'row',
    gap: 14,
    alignItems: 'center',
  },
  poiInfo: { flex: 1, minWidth: 0 },
  poiTitle: { marginBottom: 4 },
  poiTags: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 4 },
  poiStatus: { marginTop: 6 },
  poiClose: { alignSelf: 'flex-start' },
});
