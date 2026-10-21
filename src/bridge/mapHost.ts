// Barramento do lado do host para conversar com o mapa (WebView no celular, iframe na web).
// Quem desenha a WebView chama attach/receive/detach; o resto do app só usa send/setSticky/on/onConnect.
import type { HostToMap, MapMessage, MapToHost, MapToHostType } from './protocol.ts';

type Transport = (json: string) => void;
type AnyHandler = (msg: MapToHost) => void;

let transport: Transport | null = null;
let connected = false;
/** Última mensagem de cada tipo "fixo" (ex.: sim), reenviada a cada nova conexão. */
const sticky = new Map<string, HostToMap>();
const handlers = new Map<MapToHostType, Set<AnyHandler>>();
const connectListeners = new Set<() => void>();

function deliver(msg: HostToMap): void {
  if (!transport || !connected) return;
  try {
    transport(JSON.stringify(msg));
  } catch (err) {
    console.warn('[mapHost] falha ao enviar', msg.type, err);
  }
}

export const mapHost = {
  get connected(): boolean {
    return connected;
  },

  /** Envia agora; se o mapa não estiver conectado, a mensagem é descartada (o estado volta via onConnect). */
  send(msg: HostToMap): void {
    deliver(msg);
  },

  /** Guarda a mensagem como estado atual do seu tipo e envia; é repetida a cada (re)conexão. */
  setSticky(msg: HostToMap): void {
    sticky.set(msg.type, msg);
    deliver(msg);
  },

  on<T extends MapToHostType>(type: T, fn: (msg: MapMessage<T>) => void): () => void {
    const set = handlers.get(type) ?? new Set<AnyHandler>();
    handlers.set(type, set);
    set.add(fn as AnyHandler);
    return () => set.delete(fn as AnyHandler);
  },

  /** Chamado sempre que o mapa (re)conecta, depois de reenviar as mensagens fixas. Use para ressincronizar tudo. */
  onConnect(fn: () => void): () => void {
    connectListeners.add(fn);
    if (connected) fn();
    return () => connectListeners.delete(fn);
  },

  // --- usado só pelo componente que hospeda o mapa -----------------------------------

  attach(t: Transport): void {
    transport = t;
    connected = false;
  },

  detach(): void {
    transport = null;
    connected = false;
  },

  /** Mensagem crua vinda do mapa. */
  receive(json: string): void {
    let msg: MapToHost;
    try {
      msg = JSON.parse(json) as MapToHost;
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ready') {
      connected = true;
      for (const m of sticky.values()) deliver(m);
      connectListeners.forEach((fn) => fn());
    }
    handlers.get(msg.type)?.forEach((fn) => fn(msg));
  },
};
