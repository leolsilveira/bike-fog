// Página do mapa: MapLibre GL JS + névoa, carregada como string numa WebView (celular) ou num iframe (web).
// Conversa com o host só pelo protocolo de src/bridge/protocol.ts.
import 'maplibre-gl/dist/maplibre-gl.css';
import './page.css';
import { setWorkerUrl } from 'maplibre-gl';
import workerCode from 'virtual:maplibre-worker';
import { captureErrors, describe, listen, log, send } from './bridge.ts';
import { Engine } from './engine.ts';
import type { HostToMap } from '../src/bridge/protocol.ts';

captureErrors();

// Worker do MapLibre embutido na página (não há servidor de onde baixá-lo): o código, convertido no build para
// script clássico, vira um Blob URL e o worker nasce como clássico, o caminho que o MapLibre usou até a v5 em
// todo navegador e WebView. O MapLibre recebe um nome fictício e o `Worker` abaixo troca pelo Blob URL: assim a
// heurística de "worker de outra origem" do MapLibre fica de fora. Ela erra no <iframe srcdoc> (location.origin
// "null", Blob com a origem do pai) e cai num Blob-módulo intermediário revogado cedo demais, que o WebKit não
// consegue carregar.
const WORKER_NAME = 'desbrava-maplibre-worker.js';
const workerBlobUrl = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    if (String(url) === WORKER_NAME) super(workerBlobUrl);
    else super(url, options);
  }
};
setWorkerUrl(WORKER_NAME);

// zoom do navegador (pinça/duplo toque no iOS) e menu de contexto ficam desligados: o MapLibre trata os gestos
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('contextmenu', (e) => e.preventDefault());

const engine = new Engine(document.getElementById('map')!, {
  tiltshift: document.getElementById('tiltshift'),
  vignette: document.getElementById('vignette'),
});

// Mensagens antes do `init` esperam na fila (o host manda as "fixas", como `sim`, antes dele).
let initialized = false;
const queue: HostToMap[] = [];

listen((msg) => {
  if (initialized) {
    engine.handle(msg);
    return;
  }
  if (msg.type !== 'init') {
    queue.push(msg);
    return;
  }
  initialized = true;
  engine.init(msg);
  for (const m of queue.splice(0)) {
    try {
      engine.handle(m);
    } catch (err) {
      log('error', `[mapa] falha ao tratar "${m.type}" da fila: ${describe(err)}`);
    }
  }
});

send({ type: 'ready' });

if (new URLSearchParams(location.search).has('debug')) {
  (window as unknown as Record<string, unknown>).__desbravaMap = { engine };
}
