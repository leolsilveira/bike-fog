// Mapa do jogo na web: a mesma página do map-runtime num <iframe srcdoc> em tela cheia, atrás do HUD.
// O transporte é postMessage entre as janelas; a página do mapa resolve o worker do MapLibre sozinha.
import { useContext, useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { initialWindowMetrics, SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { mapHost } from '../bridge/mapHost.ts';
import { MAP_HTML } from './mapHtml.generated.ts';
import { startMapSync } from './sync.ts';

const FOG_BG = '#2a2445';

export function MapView() {
  const ref = useRef<HTMLIFrameElement>(null);
  const ctxInsets = useContext(SafeAreaInsetsContext);
  const insets = ctxInsets ?? initialWindowMetrics?.insets ?? null;
  const insetTop = Math.round(insets?.top ?? 0);
  const insetBottom = Math.round(insets?.bottom ?? 0);

  useEffect(() => {
    startMapSync();
  }, []);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    mapHost.attach((json) => frame.contentWindow?.postMessage(json, '*'));
    const onMessage = (e: MessageEvent) => {
      // só o iframe do mapa fala com o host
      if (e.source !== frame.contentWindow || typeof e.data !== 'string') return;
      mapHost.receive(e.data);
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      mapHost.detach();
    };
  }, []);

  useEffect(() => {
    // dentro do iframe `env(safe-area-inset-*)` vale 0: o host informa as áreas seguras
    mapHost.setSticky({ type: 'insets', top: insetTop, bottom: insetBottom });
  }, [insetTop, insetBottom]);

  return (
    <View style={styles.fill}>
      <iframe ref={ref} srcDoc={MAP_HTML} title="Mapa" style={iframeStyle} />
    </View>
  );
}

const iframeStyle = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  border: 0,
  display: 'block',
  background: FOG_BG,
} as const;

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill, backgroundColor: FOG_BG },
});
