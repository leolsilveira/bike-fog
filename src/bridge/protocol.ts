// Protocolo da ponte entre o app React Native (host) e o mapa (MapLibre GL JS rodando numa WebView).
// O mapa é só renderização: toda regra do jogo vive no host. Este arquivo é importado pelos dois lados,
// então só pode conter tipos (nada de runtime, nada de React Native).
import type { Coin, LngLat, Modality, PlayerFix } from '../game/types.ts';

/** Estado de um POI no mapa: capturado (troféu), revelado ("selvagem") ou ainda na névoa ("?"). */
export type PoiMarkerState = 'captured' | 'wild' | 'fog';

/** POI já pronto para desenhar (o host decide estado, ícone e cor). */
export interface PoiMarker {
  id: string;
  name: string;
  lng: number;
  lat: number;
  state: PoiMarkerState;
  /** Nome da imagem registrada no mapa: `poi-<categoria>-<wild|captured>` ou `poi-fog`. */
  icon: string;
  /** Cor da raridade (halo). */
  color: string;
}

export type LiveStatus = 'none' | 'recording' | 'paused';

/**
 * Câmera do mapa: `map` = visão de cima (explorar, planejar), `ride` = câmera inclinada atrás do personagem
 * (só com atividade em andamento), `stats` = mapa parado por trás da tela de estatísticas.
 */
export type CameraMode = 'map' | 'ride' | 'stats';

/** Host -> mapa. */
export type HostToMap =
  /** Primeira mensagem útil: cria o mapa. Mensagens anteriores ficam na fila do mapa. */
  | { type: 'init'; center: LngLat; mode: CameraMode; live: LiveStatus; profile: { characterId: string; modality: Modality } | null }
  /** Modo da câmera (zoom, pitch, opacidade da névoa) e estado da atividade (tilt-shift, vinheta). */
  | { type: 'mode'; mode: CameraMode; live: LiveStatus }
  | { type: 'profile'; characterId: string; modality: Modality }
  /** Células exploradas (chaves de `geo.cellKey`). `reset` substitui tudo; senão, acrescenta (com animação). */
  | { type: 'cells'; reset: boolean; keys: number[] }
  /** Lista completa de moedas no mundo. */
  | { type: 'coins'; coins: Coin[] }
  /** Lista completa de POIs a desenhar. */
  | { type: 'pois'; pois: PoiMarker[] }
  /** Trilha da atividade: pares lng,lat achatados. `reset` substitui; senão, acrescenta pontos. */
  | { type: 'track'; reset: boolean; coords: number[] }
  /** Rota planejada: pares lng,lat achatados e o destino (marcado no mapa). `null` apaga. */
  | { type: 'route'; route: { coords: number[]; dest: LngLat } | null }
  /** Quanto da rota já foi percorrido (m): o mapa pinta o feito de cinza e o próximo trecho de verde. */
  | { type: 'routeDone'; doneM: number }
  /** Posição do GPS real (o mapa suaviza a posição exibida). */
  | { type: 'gpsFix'; fix: PlayerFix }
  /** Liga/desliga o simulador. `pos` = onde o jogador simulado começa. */
  | { type: 'sim'; enabled: boolean; pos: LngLat | null }
  /** Joystick do simulador: x = direita, y = frente, magnitude 0..1. */
  | { type: 'simInput'; x: number; y: number; turbo?: boolean }
  | { type: 'camera'; action: 'recenter' }
  | { type: 'camera'; action: 'focus'; lng: number; lat: number }
  | { type: 'camera'; action: 'zoomBy'; delta: number }
  /** Solta a câmera do jogador e enquadra uma área; `padding` em px reserva espaço para a interface por cima. */
  | {
      type: 'camera';
      action: 'fit';
      west: number;
      south: number;
      east: number;
      north: number;
      padding: { top: number; bottom: number; left: number; right: number };
    }
  /** App em primeiro plano ou não (o mapa para o loop de quadros quando inativo). */
  | { type: 'active'; active: boolean }
  /**
   * Áreas seguras da tela em px (enviado pelo próprio MapView). O mapa usa para manter a atribuição do
   * OpenFreeMap/OSM acima da barra de abas: o Android WebView nem sempre informa `env(safe-area-inset-*)`.
   */
  | { type: 'insets'; top: number; bottom: number };

/** Mapa -> host. */
export type MapToHost =
  /** A página carregou e está pronta para receber mensagens (também após recarregar). */
  | { type: 'ready' }
  /** O mapa terminou de carregar o estilo (útil para esconder o "carregando"). */
  | { type: 'loaded' }
  /** Posição produzida pelo simulador. `teleport` = toque longo no mapa (não conta como deslocamento). */
  | { type: 'simFix'; fix: PlayerFix; teleport?: boolean }
  /** Telemetria da posição exibida (suavizada), ~4 Hz. */
  | { type: 'player'; lng: number; lat: number; heading: number; speed: number; odometer: number }
  /** POI tocado no mapa (null = toque fora). */
  | { type: 'select'; id: string | null }
  /**
   * Área visível do mapa (depois que a câmera assenta; no máximo 2x/s). O host baixa os tiles dessa área e
   * desenha os POIs que caem nela.
   */
  | { type: 'view'; west: number; south: number; east: number; north: number; zoom: number }
  /** A câmera está (ou deixou de estar) seguindo o jogador. */
  | { type: 'following'; following: boolean }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; msg: string };

export type HostToMapType = HostToMap['type'];
export type MapToHostType = MapToHost['type'];
export type MapMessage<T extends MapToHostType> = Extract<MapToHost, { type: T }>;
