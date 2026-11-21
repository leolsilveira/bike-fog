// Tela de título: céu em degradê, nuvens passando, logo com contorno, heróis animados e "Começar/Continuar".
// Port de legacy/src/ui/screens/TitleScreen.tsx + seção .title-screen de global.css.
import { useEffect, useState } from 'react';
import {
  Animated, Easing, Platform, StyleSheet, useWindowDimensions, View, type DimensionValue, type ViewStyle,
} from 'react-native';
import { GAME_NAME, GAME_TAGLINE } from '../../game/config.ts';
import { sfx, unlockAudio } from '../../game/audio.ts';
import { useGame } from '../../game/store.ts';
import { isSupabaseConfigured } from '../../services/supabase.ts';
import { CharacterSprite } from '../components/Sprites.tsx';
import { Arcade, Chip, PxButton, Txt } from '../components/Px.tsx';
import { SkyBackdrop } from '../components/Backdrops.tsx';
import { C, FILL, useSafe } from '../theme.ts';

const isWeb = Platform.OS === 'web';
const useNativeDriver = !isWeb;

/** Mesmos parâmetros do original: altura (% da tela), largura, duração e atraso (negativo = já começou). */
const CLOUDS: { top: DimensionValue; width: number; dur: number; delay: number }[] = [
  { top: '8%', width: 120, dur: 46, delay: -10 },
  { top: '18%', width: 80, dur: 34, delay: -22 },
  { top: '30%', width: 150, dur: 58, delay: -40 },
  { top: '12%', width: 60, dur: 28, delay: -5 },
];

// `blink-text` 1s steps(2) (50% → opacidade 0,55), em degraus de 250ms: 1 → 0,775 → 0,55 → 0,775.
const BLINK = [1, 0.775, 0.55, 0.775];

// text-shadow do .logo, de baixo para cima (no CSS a primeira sombra fica por cima).
const LOGO_WEB_SHADOW =
  '0 4px 0 #b8740f, 4px 4px 0 #1d1730, -4px 4px 0 #1d1730, 4px -4px 0 #1d1730, -4px -4px 0 #1d1730, ' +
  '0 8px 0 #1d1730, 0 12px 0 rgba(29, 23, 48, 0.35)';
const LOGO_LAYERS: { x: number; y: number; color: string; opacity?: number }[] = [
  { x: 0, y: 12, color: C.ink, opacity: 0.35 },
  { x: 0, y: 8, color: C.ink },
  { x: -4, y: -4, color: C.ink },
  { x: 4, y: -4, color: C.ink },
  { x: -4, y: 4, color: C.ink },
  { x: 4, y: 4, color: C.ink },
  { x: 0, y: 4, color: C.goldDark },
];

export function TitleScreen({ onStart }: { onStart: () => void }) {
  const profile = useGame((s) => s.profile);
  const authEmail = useGame((s) => s.authEmail);
  const pushModal = useGame((s) => s.pushModal);
  const { width } = useWindowDimensions();
  const { safeT, safeB } = useSafe();
  const supabaseReady = isSupabaseConfigured();
  // O toque também libera o áudio do navegador (no celular é no-op).
  const start = () => {
    unlockAudio();
    sfx.start();
    onStart();
  };
  const openAuth = () => {
    unlockAudio();
    sfx.click();
    pushModal({ type: 'auth' });
  };
  // Conteúdo centralizado: a mesma folga nos dois lados mantém o centro do original e foge do entalhe.
  const padV = 24 + Math.max(safeT, safeB);
  return (
    <View
      style={[styles.screen, { paddingTop: padV, paddingBottom: padV }]}
      testID="title-screen"
    >
      <SkyBackdrop />
      <View style={styles.clouds}>
        {CLOUDS.map((c, i) => (
          <Cloud key={i} {...c} vw={width} />
        ))}
      </View>
      <Logo size={Math.min(64, Math.max(30, width * 0.11))} />
      <View style={styles.tagline}>
        <Txt weight={700} size={18} color={C.ink}>
          {GAME_TAGLINE}
        </Txt>
      </View>
      <View style={styles.hero}>
        <CharacterSprite characterId="dandara" modality="run" facing="right" width={96} />
        <CharacterSprite characterId="lia" modality="bike" facing="right" width={96} />
        <CharacterSprite characterId="teo" modality="run" facing="right" width={96} />
      </View>
      <PressStart label={profile ? 'CONTINUAR' : 'COMEÇAR'} onPress={start} />
      {supabaseReady && (
        authEmail ? (
          <Chip dot={C.mint} testID="auth-status-email">
            {authEmail}
          </Chip>
        ) : (
          <PxButton size="small" variant="sky" onPress={openAuth} testID="auth-open-btn">
            Entrar / Criar conta
          </PxButton>
        )
      )}
      <Txt size={13} weight={600} color={C.ink} align="center" style={styles.foot}>
        Um jogo de exploração para ciclistas e corredores. Revele a névoa da sua cidade, capture pontos turísticos e colete
        moedas a cada pedalada.
      </Txt>
    </View>
  );
}

/** Botão "Começar/Continuar" piscando (só ele re-renderiza a cada degrau). */
function PressStart({ label, onPress }: { label: string; onPress: () => void }) {
  const i = useStepper(250, BLINK.length);
  return (
    <PxButton variant="gold" onPress={onPress} style={{ opacity: BLINK[i] }} testID="press-start">
      <Arcade>{label}</Arcade>
    </PxButton>
  );
}

/** Índice que avança a cada `ms` (animações em degraus, como `steps()` do CSS). */
function useStepper(ms: number, n: number): number {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((v) => (v + 1) % n), ms);
    return () => clearInterval(id);
  }, [ms, n]);
  return i;
}

/**
 * Logo com o contorno do CSS (7 sombras duras). Na web vai o text-shadow original; no celular o RN só aceita uma
 * sombra, então cada sombra vira uma cópia do texto deslocada por baixo (mesmo desenho).
 */
function Logo({ size }: { size: number }) {
  const text = GAME_NAME.toUpperCase();
  const common = { size, weight: 700 as const, spacing: 0.04, lh: 1, align: 'center' as const };
  if (isWeb) {
    return (
      <Arcade {...common} color={C.gold} webShadow={LOGO_WEB_SHADOW} accessibilityRole="header">
        {text}
      </Arcade>
    );
  }
  return (
    <View accessible accessibilityRole="header" accessibilityLabel={GAME_NAME}>
      {LOGO_LAYERS.map((l, i) => (
        <View
          key={i}
          style={[styles.logoLayer, { left: l.x, right: -l.x, top: l.y, opacity: l.opacity ?? 1 }]}
          needsOffscreenAlphaCompositing={l.opacity != null}
        >
          <Arcade {...common} color={l.color}>
            {text}
          </Arcade>
        </View>
      ))}
      <Arcade {...common} color={C.gold}>
        {text}
      </Arcade>
    </View>
  );
}

/**
 * Nuvem pixelada: corpo de 26px, "faixa" clara embaixo (box-shadow 0 6px #e6ecff) e dois calombos (::before e
 * ::after). As peças não se sobrepõem, então a opacidade 0,95 vai direto nas cores.
 */
function Cloud({ top, width, dur, delay, vw }: { top: DimensionValue; width: number; dur: number; delay: number; vw: number }) {
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    // `drift linear infinite` com atraso negativo: começa no meio do caminho
    const p0 = (((-delay % dur) + dur) % dur) / dur;
    v.setValue(p0);
    let loop: Animated.CompositeAnimation | null = null;
    const first = Animated.timing(v, {
      toValue: 1,
      duration: (1 - p0) * dur * 1000,
      easing: Easing.linear,
      useNativeDriver,
    });
    first.start(({ finished }) => {
      if (!finished) return;
      v.setValue(0);
      loop = Animated.loop(Animated.timing(v, { toValue: 1, duration: dur * 1000, easing: Easing.linear, useNativeDriver }));
      loop.start();
    });
    return () => {
      first.stop();
      loop?.stop();
    };
  }, [v, dur, delay]);
  // translateX(-30vw) → translateX(130vw)
  const translateX = v.interpolate({ inputRange: [0, 1], outputRange: [-0.3 * vw, 1.3 * vw] });
  const a = width * 0.18;
  const b = width * 0.45;
  const c = width * 0.75;
  return (
    <Animated.View style={[styles.cloud, { top, width, transform: [{ translateX }] }]}>
      <View style={[styles.piece, { left: 0, width, top: 0, height: 26, backgroundColor: CLOUD_WHITE }]} />
      <View style={[styles.piece, { left: 0, width, top: 26, height: 6, backgroundColor: CLOUD_SHADE }]} />
      <View style={[styles.piece, { left: a, width: b - a, top: -8, height: 8, backgroundColor: CLOUD_WHITE }]} />
      <View style={[styles.piece, { left: b, width: c - b, top: -20, height: 20, backgroundColor: CLOUD_WHITE }]} />
    </Animated.View>
  );
}

const CLOUD_WHITE = 'rgba(255, 255, 255, 0.95)';
const CLOUD_SHADE = 'rgba(230, 236, 255, 0.95)';

const styles = StyleSheet.create({
  screen: {
    ...FILL,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
    paddingHorizontal: 16,
    overflow: 'hidden',
    backgroundColor: '#9fd3ff',
  },
  clouds: { ...FILL, pointerEvents: 'none' } as ViewStyle,
  cloud: { position: 'absolute', left: 0, height: 26 },
  piece: { position: 'absolute' },
  logoLayer: { position: 'absolute' },
  tagline: {
    backgroundColor: 'rgba(255, 246, 224, 0.85)',
    paddingTop: 4,
    paddingBottom: 6,
    paddingHorizontal: 12,
  },
  hero: { flexDirection: 'row', alignItems: 'flex-end', gap: 18, marginTop: 10 },
  foot: { maxWidth: 360, marginVertical: 13 },
});
