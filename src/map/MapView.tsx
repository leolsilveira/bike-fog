// Mapa do jogo no celular: a página do map-runtime (MapLibre GL JS + névoa WebGL2) numa WebView em tela cheia,
// atrás do HUD. A conversa com o resto do app passa só pelo mapHost (src/bridge).
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { initialWindowMetrics, SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import type {
  ShouldStartLoadRequest, WebViewMessageEvent, WebViewOpenWindowEvent,
} from 'react-native-webview/lib/WebViewTypes';
import { mapHost } from '../bridge/mapHost.ts';
import { MAP_HTML } from './mapHtml.generated.ts';
import { startMapSync } from './sync.ts';

/**
 * Origem da página. Uma origem https de verdade (sem `null`/`about:blank`) deixa o worker do MapLibre num Blob
 * da mesma origem e os tiles do OpenFreeMap passam pelo CORS normal nos dois sistemas. Nada é baixado dela.
 */
const BASE_URL = 'https://localhost/';
/** Cor da névoa: a WebView nasce com ela para não piscar branco antes do mapa. */
const FOG_BG = '#2a2445';

function openExternal(url: string): void {
  if (/^https?:\/\//i.test(url)) Linking.openURL(url).catch(() => {});
}

export function MapView() {
  // `WebView<object>`: com o genérico padrão (undefined) as props do componente viram `never` no TS
  const ref = useRef<WebView<object>>(null);
  // trocar a chave recria a WebView (o processo dela pode morrer em segundo plano)
  const [generation, setGeneration] = useState(0);
  const ctxInsets = useContext(SafeAreaInsetsContext);
  const insets = ctxInsets ?? initialWindowMetrics?.insets ?? null;
  const insetTop = Math.round(insets?.top ?? 0);
  const insetBottom = Math.round(insets?.bottom ?? 0);

  useEffect(() => {
    startMapSync();
  }, []);

  useEffect(() => {
    // postMessage da react-native-webview: string entregue como MessageEvent em window (iOS) ou document (Android)
    mapHost.attach((json) => ref.current?.postMessage(json));
    return () => mapHost.detach();
  }, [generation]);

  useEffect(() => {
    mapHost.setSticky({ type: 'insets', top: insetTop, bottom: insetBottom });
  }, [insetTop, insetBottom]);

  const onMessage = useCallback((e: WebViewMessageEvent) => mapHost.receive(e.nativeEvent.data), []);

  const restart = useCallback(() => {
    console.warn('[mapa] processo da WebView terminou; recarregando o mapa');
    setGeneration((g) => g + 1);
  }, []);

  // a página só navega para si mesma; links (atribuição do OSM) abrem fora do app
  const onShouldStart = useCallback((req: ShouldStartLoadRequest) => {
    const url = req.url;
    if (url.startsWith(BASE_URL) || /^(about|data|blob):/i.test(url)) return true;
    openExternal(url);
    return false;
  }, []);

  const onOpenWindow = useCallback((e: WebViewOpenWindowEvent) => openExternal(e.nativeEvent.targetUrl), []);

  return (
    <View style={styles.fill}>
      <WebView
        key={generation}
        ref={ref}
        source={{ html: MAP_HTML, baseUrl: BASE_URL }}
        originWhitelist={['*']}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={onShouldStart}
        onOpenWindow={onOpenWindow}
        onContentProcessDidTerminate={restart}
        onRenderProcessGone={restart}
        renderError={() => <View style={styles.fill} />}
        style={styles.webview}
        containerStyle={styles.fill}
        javaScriptEnabled
        domStorageEnabled
        cacheEnabled
        webviewDebuggingEnabled={__DEV__}
        // sem rolagem, quique, zoom do sistema, seleção de texto, prévias de link nem gestos de voltar
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        nestedScrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        setBuiltInZoomControls={false}
        setDisplayZoomControls={false}
        textZoom={100}
        textInteractionEnabled={false}
        allowsLinkPreview={false}
        allowsBackForwardNavigationGestures={false}
        dataDetectorTypes="none"
        allowFileAccess={false}
        mixedContentMode="never"
        // Android: a WebView já desenha na GPU (o app inteiro é acelerado por hardware). Uma camada "hardware"
        // própria só somaria uma cópia da tela a cada quadro, já que o mapa redesenha o tempo todo.
        androidLayerType="none"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill, backgroundColor: FOG_BG },
  webview: { flex: 1, backgroundColor: FOG_BG },
});
