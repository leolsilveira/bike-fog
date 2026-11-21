// Transporte da página do mapa: WebView (react-native-webview) no celular ou iframe na web.
// Tudo é JSON em string, no formato de src/bridge/protocol.ts.
import type { HostToMap, MapToHost } from '../src/bridge/protocol.ts';

interface RNWebViewBridge {
  postMessage(data: string): void;
}

declare global {
  interface Window {
    ReactNativeWebView?: RNWebViewBridge;
  }
}

const inIframe = window.parent !== window;

export function send(msg: MapToHost): void {
  const json = JSON.stringify(msg);
  try {
    // injetado pela react-native-webview antes do conteúdo carregar
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(json);
    else if (inIframe) window.parent.postMessage(json, '*');
  } catch {
    /* host indisponível: nada a fazer */
  }
}

export function log(level: 'info' | 'warn' | 'error', msg: string): void {
  send({ type: 'log', level, msg: msg.slice(0, 2000) });
}

/** Recebe mensagens do host. iOS despacha em `window`, Android em `document`, o iframe em `window`. */
export function listen(fn: (msg: HostToMap) => void): void {
  const handler = (e: Event) => {
    const ev = e as MessageEvent;
    // no iframe, só o host (janela pai) fala com o mapa
    if (inIframe && ev.source && ev.source !== window.parent) return;
    let msg: unknown = ev.data;
    if (typeof msg === 'string') {
      try {
        msg = JSON.parse(msg);
      } catch {
        return;
      }
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return;
    try {
      fn(msg as HostToMap);
    } catch (err) {
      log('error', `[mapa] falha ao tratar "${(msg as HostToMap).type}": ${describe(err)}`);
    }
  };
  window.addEventListener('message', handler);
  document.addEventListener('message', handler);
}

export function describe(err: unknown): string {
  if (err instanceof Error) return `${err.message}${err.stack ? `\n${err.stack}` : ''}`;
  return String(err);
}

/** Erros não tratados da página vão para o log do host (no celular não há console à vista). */
export function captureErrors(): void {
  window.addEventListener('error', (e) => {
    log('error', `[mapa] ${e.message} (${e.filename}:${e.lineno}:${e.colno})${e.error ? `\n${describe(e.error)}` : ''}`);
  });
  window.addEventListener('unhandledrejection', (e) => log('error', `[mapa] promessa rejeitada: ${describe(e.reason)}`));
}
