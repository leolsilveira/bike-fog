// Modais do jogo: captura, subida de nível, resumo da atividade e escolha/compra de heróis.
// Port de legacy/src/ui/components/Modals.tsx + seções .modal*, .capture-stage, .summary-grid e .char-* do CSS.
//
// Durante a gravação, captura e nível viram um cartão compacto ("passivo") abaixo do HUD que some sozinho:
// ninguém deve precisar tocar na tela pedalando. Tocar no cartão também fecha.
//
// O CSS colapsava margens verticais (p, h2, .capture-stage...); aqui cada espaço já é o valor colapsado.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  Animated, BackHandler, Easing, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View,
  type ViewStyle,
} from 'react-native';
import Svg, { Defs, Path, RadialGradient, Stop } from 'react-native-svg';
import { useGame } from '../../game/store.ts';
import { sfx } from '../../game/audio.ts';
import { cellSizeM, formatArea, formatDistance, formatDuration, formatPace, formatSpeed } from '../../game/geo.ts';
import { CHARACTERS } from '../../sprites/characters.ts';
import { POI_INFO, RARITY_INFO } from '../../sprites/items.ts';
import type { ActivitySummary, Capture } from '../../game/types.ts';
import { BadgeImg, CharacterSprite, CoinImg, Icon } from './Sprites.tsx';
import { Arcade, Inset, Muted, PxBox, PxButton, Txt } from './Px.tsx';
import { C, FILL, useSafe } from '../theme.ts';

const useNativeDriver = Platform.OS !== 'web';

/** Easing em degraus (CSS `steps(n)`, jump-end). */
const steps = (n: number) => (t: number) => (t >= 1 ? 1 : Math.floor(t * n) / n);

/** Modo compacto (gravação em andamento). */
const PassiveCtx = createContext(false);

// ---------------------------------------------------------------------------
// Animações
// ---------------------------------------------------------------------------

/** Índice que avança a cada `ms` (animações em degraus). */
function useStepper(ms: number, n: number): number {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((v) => (v + 1) % n), ms);
    return () => clearInterval(id);
  }, [ms, n]);
  return i;
}

// `bob` 1.2s steps(4) infinite alternate (0 → -8px): ida 0,-2,-4,-6 e volta -6,-4,-2,0, 300ms cada degrau.
const BOB = [0, -2, -4, -6, -6, -4, -2, 0];

// Raios: `repeating-conic-gradient` de 10° dourado / 10° vazio, recortado em círculo e com a máscara
// `radial-gradient(circle, #000 30%, transparent 70%)` (raio "farthest-corner" = 110·√2 num quadrado de 220).
const RAYS_PATH = (() => {
  const c = 110;
  const pt = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    return `${(c + c * Math.sin(a)).toFixed(3)} ${(c - c * Math.cos(a)).toFixed(3)}`;
  };
  let d = '';
  for (let i = 0; i < 18; i++) d += `M${c} ${c}L${pt(i * 20)}A${c} ${c} 0 0 1 ${pt(i * 20 + 10)}Z`;
  return d;
})();

/** `.rays`: leque dourado girando (8s por volta) atrás do emblema/herói. */
function Rays({ size }: { size: number }) {
  const [spin] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const a = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 8000, easing: Easing.linear, useNativeDriver }),
    );
    a.start();
    return () => a.stop();
  }, [spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Animated.View style={[styles.rays, { width: size, height: size, transform: [{ rotate }] }]}>
      <Svg width={size} height={size} viewBox="0 0 220 220">
        <Defs>
          <RadialGradient id="desbrava-rays" cx="110" cy="110" r={110 * Math.SQRT2} gradientUnits="userSpaceOnUse">
            <Stop offset="0.3" stopColor={C.gold} stopOpacity={0.35} />
            <Stop offset="0.7" stopColor={C.gold} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Path d={RAYS_PATH} fill="url(#desbrava-rays)" />
      </Svg>
    </Animated.View>
  );
}

/** Sobe e desce o emblema em degraus (só este pedaço re-renderiza). */
function Bob({ children }: { children: ReactNode }) {
  const y = BOB[useStepper(300, BOB.length)];
  return <View style={{ transform: [{ translateY: y }] }}>{children}</View>;
}

/** `.capture-stage`: palco com os raios e o sprite no centro (por cima do texto vizinho, como no CSS). */
function CaptureStage({ children }: { children: ReactNode }) {
  const passive = useContext(PassiveCtx);
  return (
    <View style={[styles.stage, passive ? styles.stagePassive : styles.stageNormal]}>
      <Rays size={passive ? 120 : 220} />
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Cartão e fundo
// ---------------------------------------------------------------------------

/**
 * `.px-box.modal`: entra com `pop` (escala 0,6 → 1 em 5 degraus, 260ms). Remontado a cada troca de tipo de
 * modal (como o elemento do original), então a animação repete quando o tipo muda.
 */
function ModalCard({ children, testID }: { children: ReactNode; testID: string }) {
  const passive = useContext(PassiveCtx);
  const { height } = useWindowDimensions();
  const { safeT, safeB } = useSafe();
  const [pop] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const a = Animated.timing(pop, { toValue: 1, duration: 260, easing: steps(5), useNativeDriver });
    a.start();
    return () => a.stop();
  }, [pop]);
  const scale = pop.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });
  // max-height: calc(100dvh - 40px), sem invadir as áreas seguras
  const maxHeight = height - 40 - 2 * Math.max(safeT, safeB);
  const box = (
    <PxBox testID={testID} style={[styles.card, { maxHeight }]}>
      {passive ? (
        <View style={styles.bodyPassive}>{children}</View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.body}
          bounces={false}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      )}
    </PxBox>
  );
  return (
    <Animated.View
      style={[
        styles.cardWrap,
        passive ? styles.cardWrapPassive : null,
        { transform: [{ scale }], transformOrigin: passive ? '50% 0%' : '50% 50%' },
      ]}
    >
      {box}
    </Animated.View>
  );
}

/** `.modal-backdrop`: escurece e centraliza (normal) ou só posiciona o cartão abaixo do HUD (passivo). */
function Backdrop({ passive, onClose, children }: { passive: boolean; onClose: () => void; children: ReactNode }) {
  const { safeT, safeB } = useSafe();
  const [fade] = useState(() => new Animated.Value(0));
  useEffect(() => {
    // `fade 160ms ease`
    const a = Animated.timing(fade, {
      toValue: 1,
      duration: 160,
      easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      useNativeDriver,
    });
    a.start();
    return () => a.stop();
  }, [fade]);
  const safe = Math.max(safeT, safeB);
  return (
    <Animated.View
      style={[styles.backdrop, !passive && styles.backdropDim, { opacity: fade }]}
      testID={passive ? 'modal-backdrop-passive' : 'modal-backdrop'}
    >
      {!passive && <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Fechar" />}
      <View
        style={[
          styles.place,
          passive
            ? { justifyContent: 'flex-start', paddingTop: 150 + safeT }
            : { justifyContent: 'center', paddingTop: 20 + safe, paddingBottom: 20 + safe },
        ]}
      >
        {passive ? (
          // tocar no cartão compacto fecha (o fundo deixa o toque passar para o mapa)
          <Pressable onPress={onClose} style={styles.passiveTap} accessibilityLabel="Fechar">
            {children}
          </Pressable>
        ) : (
          children
        )}
      </View>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Peças de texto
// ---------------------------------------------------------------------------

/** `.modal h2`: título arcade dourado (13px no cartão compacto). */
function Title({ children }: { children: ReactNode }) {
  const passive = useContext(PassiveCtx);
  return (
    <Arcade
      size={passive ? 13 : 18}
      weight={700}
      spacing={0}
      lh={1.4}
      align="center"
      color={C.gold}
      shadow={{ y: 3 }}
      accessibilityRole="header"
    >
      {children}
    </Arcade>
  );
}

/** `.actions`: coluna de botões (escondida no cartão compacto). */
function Actions({ children }: { children: ReactNode }) {
  if (useContext(PassiveCtx)) return null;
  return <View style={styles.actions}>{children}</View>;
}

function Stars({ n }: { n: number }) {
  return (
    <View style={styles.stars}>
      {Array.from({ length: 5 }, (_, i) => (
        <Icon key={i} name="star" size={18} color={C.ink} accent={i < n ? C.gold : C.panel3} />
      ))}
    </View>
  );
}

const MONTHS = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro',
  'dezembro',
];

/**
 * Igual a `toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' })` ("20 de outubro de 2026 às 19:24"),
 * sem depender do Intl de cada plataforma.
 */
function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()} às ${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// Modais
// ---------------------------------------------------------------------------

function CaptureModal({ capture, xp, onClose }: { capture: Capture; xp: number; onClose: () => void }) {
  const passive = useContext(PassiveCtx);
  const r = RARITY_INFO[capture.rarity];
  const g = passive ? 3 : 6;
  return (
    <ModalCard testID="modal-capture">
      <Title>CAPTURADO!</Title>
      <View style={{ marginTop: passive ? 6 : 8 }}>
        <CaptureStage>
          <Bob>
            <BadgeImg category={capture.category} state="wild" width={passive ? 56 : 120} style={passive && { height: 72 }} />
          </Bob>
        </CaptureStage>
      </View>
      <Txt weight={700} size={19} align="center" style={{ marginTop: g }}>
        {capture.name}
      </Txt>
      <View style={[styles.rarityLine, { marginTop: g }]}>
        <View style={[styles.rarityTag, { backgroundColor: r.color }]}>
          <Txt size={13} weight={700} color={C.ink} upper spacing={0.08}>
            {r.label}
          </Txt>
        </View>
        <Muted>{POI_INFO[capture.category].label}</Muted>
      </View>
      {!passive && (
        <View style={styles.starsLine}>
          <Stars n={r.stars} />
        </View>
      )}
      <Arcade size={14} spacing={0} color={C.mint} align="center" style={{ marginTop: passive ? 4 : 10 }}>
        +{xp} XP
      </Arcade>
      <Actions>
        <PxButton variant="gold" block onPress={onClose} testID="modal-ok">
          Continuar
        </PxButton>
      </Actions>
    </ModalCard>
  );
}

function LevelUpModal({ level, title, onClose }: { level: number; title: string; onClose: () => void }) {
  const passive = useContext(PassiveCtx);
  const profile = useGame((s) => s.profile);
  useEffect(() => {
    sfx.levelUp();
  }, []);
  const g = passive ? 3 : 6;
  return (
    <ModalCard testID="modal-levelup">
      <Title>LEVEL UP!</Title>
      <Arcade size={13} color={C.cream} align="center" style={{ marginTop: 6 }}>
        NV {level}
      </Arcade>
      <View style={{ marginTop: passive ? 3 : 8 }}>
        <CaptureStage>
          {profile && (
            <CharacterSprite
              characterId={profile.characterId}
              modality={profile.modality}
              facing="down"
              width={passive ? 56 : 120}
              // no cartão compacto o CSS forçava 56×72 (um pouco mais alto que a proporção do sprite)
              style={passive ? { transform: [{ scaleY: 72 / 70 }] } : undefined}
            />
          )}
        </CaptureStage>
      </View>
      <Txt weight={700} size={18} align="center" style={{ marginTop: g }}>
        Novo título: {title}
      </Txt>
      <Muted align="center" style={{ marginTop: g, marginBottom: passive ? 3 : 0 }}>
        Continue explorando para subir mais.
      </Muted>
      <Actions>
        <PxButton variant="gold" block onPress={onClose} testID="modal-ok">
          Bora!
        </PxButton>
      </Actions>
    </ModalCard>
  );
}

function SummaryModal({ activity: a, onClose }: { activity: ActivitySummary; onClose: () => void }) {
  const fix = useGame((s) => s.fix);
  const captures = useGame((s) => s.captures);
  const avg = a.movingS > 0 ? a.distanceM / a.movingS : 0;
  const area = a.newCells * cellSizeM(fix?.lat ?? -23.5) ** 2;
  const bike = a.modality === 'bike';
  const caught = a.captures.map((id) => captures[id]).filter(Boolean);
  return (
    <ModalCard testID="modal-summary">
      <Title>FIM DA {bike ? 'PEDALADA' : 'CORRIDA'}!</Title>
      <Muted align="center" style={{ marginTop: 6 }}>
        {formatDateTime(a.startedAt)}
      </Muted>
      <View style={styles.grid}>
        <View style={styles.gridRow}>
          <SummaryCell label="Distância" value={formatDistance(a.distanceM)} />
          <SummaryCell label="Tempo" value={formatDuration(a.movingS || a.elapsedS)} />
        </View>
        <View style={styles.gridRow}>
          <SummaryCell
            label={bike ? 'Vel. média' : 'Pace médio'}
            value={bike ? `${formatSpeed(avg)} km/h` : `${formatPace(avg)}/km`}
          />
          <SummaryCell label="Área nova" value={formatArea(area)} />
        </View>
        <View style={styles.gridRow}>
          <SummaryCell label="Moedas" value={String(a.coinsValue)} coin />
          <SummaryCell label="XP" value={`+${a.xp}`} color={C.mint} />
        </View>
      </View>
      {a.captures.length > 0 && (
        <View style={styles.caught}>
          <Muted size={13} style={{ marginBottom: 6 }}>
            CAPTURAS ({a.captures.length})
          </Muted>
          <View style={styles.caughtList}>
            {caught.map((c) => (
              <View key={c.id} style={styles.caughtItem} accessibilityLabel={c.name}>
                <BadgeImg category={c.category} state="captured" width={34} />
              </View>
            ))}
          </View>
        </View>
      )}
      <Actions>
        <PxButton variant="gold" block onPress={onClose} testID="modal-ok">
          Salvar e voltar ao mapa
        </PxButton>
      </Actions>
    </ModalCard>
  );
}

/** Célula de `.summary-grid`: rótulo em caixa alta e valor em fonte arcade. */
function SummaryCell({ label, value, coin, color }: { label: string; value: string; coin?: boolean; color?: string }) {
  return (
    <View style={styles.cell}>
      <Txt size={12} color={C.muted} upper spacing={0.05}>
        {label}
      </Txt>
      <View style={styles.cellVal}>
        {coin && <CoinImg size={16} />}
        <Arcade size={14} spacing={0} color={color}>
          {value}
        </Arcade>
      </View>
    </View>
  );
}

function CharactersModal({ onClose }: { onClose: () => void }) {
  const profile = useGame((s) => s.profile);
  const unlocked = useGame((s) => s.unlocked);
  const wallet = useGame((s) => s.wallet);
  if (!profile) return null;
  const { setCharacter, unlockCharacter, toast } = useGame.getState();
  const choose = (id: string) => {
    const c = CHARACTERS.find((d) => d.id === id);
    if (!c) return;
    if (unlocked.includes(c.id)) {
      sfx.click();
      setCharacter(c.id);
    } else if (unlockCharacter(c.id)) {
      sfx.capture();
      setCharacter(c.id);
      toast(`${c.name} desbloqueado!`, 'city');
    } else {
      sfx.warn();
      toast(`Faltam ${c.price - wallet} moedas para ${c.name}.`, 'warn');
    }
  };
  // `.char-grid`: 3 colunas; cada linha estica as células até a mais alta
  const rows: (typeof CHARACTERS)[] = [];
  for (let i = 0; i < CHARACTERS.length; i += 3) rows.push(CHARACTERS.slice(i, i + 3));
  return (
    <ModalCard testID="modal-characters">
      <Title>HERÓIS</Title>
      <View style={styles.walletLine}>
        <Muted>Você tem</Muted>
        <CoinImg size={14} style={styles.walletCoin} />
        <Muted>{wallet} moedas.</Muted>
      </View>
      <View style={styles.charGrid}>
        {rows.map((row, i) => (
          <View key={i} style={styles.charRow}>
            {row.map((c) => {
              const owned = unlocked.includes(c.id);
              const selected = profile.characterId === c.id;
              return (
                <Pressable
                  key={c.id}
                  onPress={() => choose(c.id)}
                  style={styles.charCell}
                  accessibilityRole="button"
                  accessibilityLabel={owned ? c.name : `${c.name}, ${c.price} moedas`}
                  accessibilityState={{ selected }}
                  testID={`char-${c.id}`}
                >
                  {selected ? (
                    <View style={styles.charSelected} />
                  ) : (
                    <Inset side="bottom" h={3} color="rgba(0, 0, 0, 0.25)" />
                  )}
                  <CharacterSprite
                    characterId={c.id}
                    modality={profile.modality}
                    facing="down"
                    animate={selected}
                    width={60}
                  />
                  <Txt weight={700}>{c.name}</Txt>
                  {owned ? (
                    <Muted size={12}>{selected ? 'em uso' : 'liberado'}</Muted>
                  ) : (
                    <View style={styles.price}>
                      <CoinImg size={12} />
                      <Arcade size={9} spacing={0} color={C.gold}>
                        {c.price}
                      </Arcade>
                    </View>
                  )}
                  {!owned && <Icon name="lock" size={16} style={styles.charLock} />}
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
      <Actions>
        <PxButton block onPress={onClose} testID="modal-ok">
          Fechar
        </PxButton>
      </Actions>
    </ModalCard>
  );
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export function ModalHost() {
  const modal = useGame((s) => s.modals[0]);
  const closeModal = useGame((s) => s.closeModal);
  const setTab = useGame((s) => s.setTab);
  const recording = useGame((s) => s.live?.status === 'recording');
  const queued = useGame((s) => s.modals.length);
  // Pedalando/correndo ninguém deve precisar tocar na tela: capturas e níveis somem sozinhos.
  const passive = recording && (modal?.type === 'capture' || modal?.type === 'levelup');
  useEffect(() => {
    if (!passive) return;
    // com fila (várias capturas de uma vez) cada cartão fica menos tempo
    const id = setTimeout(closeModal, queued > 1 ? 2000 : 3600);
    return () => clearTimeout(id);
  }, [modal, passive, closeModal, queued]);
  const isSummary = modal?.type === 'summary';
  const close = useCallback(() => {
    sfx.click();
    if (isSummary) setTab('map');
    closeModal();
  }, [isSummary, setTab, closeModal]);
  // Android: o botão "voltar" fecha o modal (o original fechava com toque fora ou no cartão compacto).
  const open = modal != null;
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [open, close]);
  if (!modal) return null;
  return (
    <PassiveCtx.Provider value={passive}>
      <Backdrop passive={passive} onClose={close}>
        {modal.type === 'capture' && <CaptureModal capture={modal.capture} xp={modal.xp} onClose={close} />}
        {modal.type === 'levelup' && <LevelUpModal level={modal.level} title={modal.title} onClose={close} />}
        {modal.type === 'summary' && <SummaryModal activity={modal.activity} onClose={close} />}
        {modal.type === 'characters' && <CharactersModal onClose={close} />}
      </Backdrop>
    </PassiveCtx.Provider>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...FILL, zIndex: 50, pointerEvents: 'box-none' } as ViewStyle,
  backdropDim: { backgroundColor: C.backdrop },
  scrim: { ...FILL },
  place: { ...FILL, alignItems: 'center', paddingHorizontal: 20, pointerEvents: 'box-none' } as ViewStyle,
  passiveTap: { width: '100%', maxWidth: 360, alignItems: 'center' },
  cardWrap: { width: '100%', maxWidth: 400 },
  cardWrapPassive: { maxWidth: 360 },
  card: { width: '100%' },
  scroll: { flexGrow: 0, flexShrink: 1 },
  body: { paddingTop: 22, paddingHorizontal: 20, paddingBottom: 20 },
  bodyPassive: { paddingTop: 12, paddingHorizontal: 14, paddingBottom: 14 },
  // acima do texto vizinho: no CSS os raios (position: absolute) pintavam por cima dos parágrafos
  stage: { alignItems: 'center', justifyContent: 'center', zIndex: 1 },
  stageNormal: { height: 170 },
  stagePassive: { height: 84 },
  rays: { position: 'absolute', pointerEvents: 'none' } as ViewStyle,
  rarityLine: { flexDirection: 'row', justifyContent: 'center', alignItems: 'baseline', gap: 16 * 0.2 },
  rarityTag: { paddingTop: 3, paddingBottom: 4, paddingHorizontal: 10 },
  // `.stars` é inline-flex numa linha de texto: a linha ganha a descida da fonte embaixo
  starsLine: { marginTop: 6, alignItems: 'center', paddingBottom: 5.6 },
  stars: { flexDirection: 'row', gap: 3 },
  actions: { marginTop: 18, gap: 12 },
  grid: { marginTop: 14, gap: 10 },
  gridRow: { flexDirection: 'row', gap: 10 },
  cell: { flex: 1, backgroundColor: C.panel2, paddingTop: 8, paddingHorizontal: 10, paddingBottom: 10 },
  cellVal: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  caught: { marginTop: 14 },
  caughtList: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  caughtItem: { paddingBottom: 5.6 },
  walletLine: { flexDirection: 'row', justifyContent: 'center', alignItems: 'baseline', marginTop: 6 },
  walletCoin: { marginHorizontal: 16 * 0.2 },
  charGrid: { marginTop: 12, gap: 10 },
  charRow: { flexDirection: 'row', gap: 10 },
  charCell: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    paddingTop: 10,
    paddingHorizontal: 4,
    paddingBottom: 8,
    backgroundColor: C.panel2,
  },
  charSelected: { ...FILL, borderWidth: 3, borderColor: C.gold, pointerEvents: 'none' } as ViewStyle,
  price: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  charLock: { position: 'absolute', top: 6, right: 6 },
});
