// Casca do app: fontes + hidratação (com o splash nativo segurado), fluxo Título → Criação → Jogo,
// mapa em tela cheia por trás e HUD/telas/modais por cima (port de legacy/src/App.tsx).
import { useEffect, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type ViewStyle } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { initGame } from './src/game/index.ts';
import { useGame } from './src/game/store.ts';
// sem extensão: o Metro escolhe MapView.web.tsx na web
import { MapView } from './src/map/MapView';
import { TitleScreen } from './src/ui/screens/TitleScreen.tsx';
import { CreateScreen } from './src/ui/screens/CreateScreen.tsx';
import { MapTab } from './src/ui/screens/MapTab.tsx';
import { RecordTab } from './src/ui/screens/RecordTab.tsx';
import { StatsScreen } from './src/ui/screens/StatsScreen.tsx';
import { PoiCard, SimPad, SpeedBanner, TabBar, Toasts } from './src/ui/components/Hud.tsx';
import { ModalHost } from './src/ui/components/Modals.tsx';
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
 * Os zIndex repetem os do CSS original (abas 10, stats 15, joystick 12, aviso 15, barra 20, cartão 30).
 */
function Game() {
  const tab = useGame((s) => s.tab);
  return (
    <View style={styles.layer}>
      <MapView />
      {tab === 'map' && (
        <Layer z={10}>
          <MapTab />
        </Layer>
      )}
      {tab === 'record' && (
        <Layer z={10}>
          <RecordTab />
        </Layer>
      )}
      {tab === 'stats' && (
        <Layer z={15}>
          <StatsScreen />
        </Layer>
      )}
      <SpeedBanner />
      <SimPad />
      {tab !== 'stats' && <PoiCard />}
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
    // Rede de segurança: nunca prender o splash para sempre.
    const id = setTimeout(() => SplashScreen.hide(), 10000);
    return () => clearTimeout(id);
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
