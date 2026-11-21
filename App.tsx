// Casca do app: fontes + hidratação (com o splash nativo segurado), fluxo Título → Criação → Jogo,
// mapa em tela cheia por trás e HUD/telas/modais por cima (port de legacy/src/App.tsx).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type ViewStyle } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { initGame } from './src/game/index.ts';
import { useGame } from './src/game/store.ts';
import { initAuthListener } from './src/services/auth.ts';
import { initDeepLinks } from './src/services/deepLink.ts';
// sem extensão: o Metro escolhe MapView.web.tsx na web
import { MapView } from './src/map/MapView';
import { TitleScreen } from './src/ui/screens/TitleScreen.tsx';
import { CreateScreen } from './src/ui/screens/CreateScreen.tsx';
import { MapTab } from './src/ui/screens/MapTab.tsx';
import { RideScreen } from './src/ui/screens/RideScreen.tsx';
import { ShopScreen } from './src/ui/screens/ShopScreen.tsx';
import { SocialScreen } from './src/ui/screens/SocialScreen.tsx';
import { StatsScreen } from './src/ui/screens/StatsScreen.tsx';
import { PoiCard, SimPad, SpeedBanner, TabBar, Toasts } from './src/ui/components/Hud.tsx';
import { ModalHost } from './src/ui/components/Modals.tsx';
import { StartSheet } from './src/ui/components/StartSheet.tsx';
import { useKeepAwakeWhile } from './src/ui/keepAwake.ts';
import { Arcade } from './src/ui/components/Px.tsx';
import { Gallery } from './src/ui/Gallery.tsx';
import { C, FILL, FONT_SOURCES } from './src/ui/theme.ts';

// O splash nativo fica na tela até as fontes carregarem e o save hidratar (chamado no escopo do módulo, cedo).
void SplashScreen.preventAutoHideAsync().catch(() => {});

/**
 * Parâmetros de URL só existem na web: `?skip` pula o título, `?gallery` mostra a vitrine das primitivas
 * (`?debug` é tratado em src/game/index.ts).
 */
function webParam(name: string): boolean {
  return Platform.OS === 'web' && typeof window !== 'undefined' && new URLSearchParams(window.location.search).has(name);
}

/** Camada em tela cheia que deixa o toque passar para o mapa onde não há interface. */
function Layer({ z, children }: { z: number; children: ReactNode }) {
  return <View style={[styles.layer, { zIndex: z }]}>{children}</View>;
}

/**
 * Jogo: mapa por trás e, por cima, a aba atual, aviso de velocidade, joystick, cartão de POI e abas.
 * Na aba Mapa com atividade em andamento entra a tela da atividade (câmera inclinada + HUD) no lugar do Mapa.
 * Os zIndex repetem os do CSS original (abas 10, stats 15, joystick 12, aviso 15, barra 20, folha 25, cartão 30).
 */
function Game() {
  const tab = useGame((s) => s.tab);
  const setTab = useGame((s) => s.setTab);
  const hydrated = useGame((s) => s.hydrated);
  const authUserId = useGame((s) => s.authUserId);
  const pendingInviteUsername = useGame((s) => s.pendingInviteUsername);
  const pendingMigration = useGame((s) => s.pendingMigration);
  const live = useGame((s) => s.live != null);
  const planning = useGame((s) => s.planning);
  const routedInviteRef = useRef<string | null>(null);

  // Leva automaticamente à aba Social uma vez quando houver convite pendente e conta conectada.
  useEffect(() => {
    if (!pendingInviteUsername) {
      routedInviteRef.current = null;
      return;
    }
    if (
      hydrated &&
      authUserId &&
      !live &&
      !pendingMigration &&
      routedInviteRef.current !== pendingInviteUsername
    ) {
      routedInviteRef.current = pendingInviteUsername;
      setTab('social');
    }
  }, [hydrated, authUserId, pendingInviteUsername, pendingMigration, live, setTab]);

  // tela acesa gravando, em qualquer aba
  useKeepAwakeWhile(useGame((s) => s.live?.status === 'recording'));
  return (
    <View style={styles.layer}>
      <MapView />
      {tab === 'map' && (
        <Layer z={10}>
          {live ? <RideScreen /> : <MapTab hideNearby={planning} />}
        </Layer>
      )}
      {tab === 'social' && (
        <Layer z={15}>
          <SocialScreen />
        </Layer>
      )}
      {tab === 'shop' && (
        <Layer z={15}>
          <ShopScreen />
        </Layer>
      )}
      {tab === 'stats' && (
        <Layer z={15}>
          <StatsScreen />
        </Layer>
      )}
      <SpeedBanner />
      <SimPad />
      {tab === 'map' && <PoiCard />}
      {planning && <StartSheet />}
      <TabBar />
    </View>
  );
}

function Root() {
  const [fontsLoaded, fontError] = useFonts(FONT_SOURCES);
  const hydrated = useGame((s) => s.hydrated);
  const profile = useGame((s) => s.profile);
  const [started, setStarted] = useState(() => webParam('skip'));
  const [initDone, setInitDone] = useState(false);
  const [gallery] = useState(() => webParam('gallery'));

  useEffect(() => {
    initGame()
      .catch((err: unknown) => console.warn('[desbrava] falha ao iniciar o jogo', err))
      .finally(() => setInitDone(true));
    const unsubAuth = initAuthListener();
    const unsubLinks = initDeepLinks();
    // Rede de segurança: nunca prender o splash para sempre.
    const id = setTimeout(() => SplashScreen.hide(), 10000);
    return () => {
      clearTimeout(id);
      unsubAuth();
      unsubLinks();
    };
  }, []);

  const fontsReady = fontsLoaded || fontError != null;
  useEffect(() => {
    if (fontsReady && (hydrated || initDone)) SplashScreen.hide();
  }, [fontsReady, hydrated, initDone]);

  return (
    <View style={styles.app}>
      <StatusBar style="light" />
      {gallery && fontsReady ? (
        <Gallery />
      ) : !hydrated || !fontsReady ? (
        <View style={styles.loading}>
          {fontsReady && (
            <Arcade size={12} spacing={0} color={C.muted}>
              CARREGANDO…
            </Arcade>
          )}
        </View>
      ) : (
        <>
          {!started ? <TitleScreen onStart={() => setStarted(true)} /> : profile ? <Game /> : <CreateScreen />}
          <Toasts />
          <ModalHost />
        </>
      )}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider style={styles.app}>
      <Root />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: C.ink, overflow: 'hidden' },
  layer: { ...FILL, pointerEvents: 'box-none' } as ViewStyle,
  loading: { ...FILL, alignItems: 'center', justifyContent: 'center' },
});
