// Motor do mapa dentro da WebView/iframe: MapLibre + névoa + herói, dirigido só pelas mensagens do host.
// Guarda uma cópia local do que precisa desenhar (modo, perfil, moedas, POIs, trilha, células);
// nenhuma regra de jogo roda aqui.
import { Map as MLMap, Marker, type GeoJSONSource, type LngLatLike } from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import { buildStyle } from './style.ts';
import { FogLayer } from './fogLayer.ts';
import { registerImages } from './images.ts';
import { cachedCharacterFrame, drawRaster } from './sprite.ts';
import {
  initKeyboard, isSimulating, onSimFix, player, setGpsTarget, setSimInput, setSimulator, simTeleport, tickPlayer,
} from './player.ts';
import { log, send } from './bridge.ts';
import { PITCH, ZOOM } from '../src/game/config.ts';
import { angleDiff, haversine, type LngLat } from '../src/game/geo.ts';
import { frameCount, type Facing } from '../src/sprites/characters.ts';
import type { Coin, Modality } from '../src/game/types.ts';
import type { CameraMode, HostToMap, LiveStatus, PoiMarker } from '../src/bridge/protocol.ts';

type InitMsg = Extract<HostToMap, { type: 'init' }>;
type CameraMsg = Extract<HostToMap, { type: 'camera' }>;
type Profile = { characterId: string; modality: Modality };

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const TRACK_COLOR: Record<Modality, string> = { bike: '#3fd3a0', run: '#ff6b5a' };
/**
 * Reset grande de células chega em pedaços (o 1º com `reset`, os outros sem). Pedaço sem `reset` que chega
 * até este intervalo depois do anterior faz parte da carga e entra sem a animação de "abrir a clareira".
 */
const BULK_GAP_MS = 500;
/** Toque longo para teleportar o simulador (o iOS não dispara `contextmenu` no toque). */
const LONG_PRESS_MS = 600;
const LONG_PRESS_SLOP_PX = 10;
/** Telemetria da posição exibida para o host. */
const TELEMETRY_MS = 250;
/** Escala dos sprites (POIs e moedas) por zoom: pares [zoom, icon-size], interpolação linear. */
const SPRITE_SIZE_STOPS: [number, number][] = [[13, 0.32], [16, 0.6], [18.5, 0.95]];
/**
 * Largura do herói em px por unidade de `icon-size`: ele cresce e encolhe junto com os POIs, em qualquer câmera.
 * 85 dá os 48 px de sempre no zoom da aba Mapa (15,6).
 */
const HERO_PX_PER_SIZE = 85;
const HERO_ASPECT = 60 / 48;
/** Trecho da rota logo à frente, pintado de verde com setas (m). */
const ROUTE_NEXT_M = 400;

function spriteSizeAt(zoom: number): number {
  const stops = SPRITE_SIZE_STOPS;
  if (zoom <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [z1, v1] = stops[i];
    if (zoom <= z1) {
      const [z0, v0] = stops[i - 1];
      return v0 + ((zoom - z0) / (z1 - z0)) * (v1 - v0);
    }
  }
  return stops[stops.length - 1][1];
}

export class Engine {
  map: MLMap | null = null;
  readonly fogLayer = new FogLayer();
  private readonly container: HTMLElement;
  private readonly tiltshift: HTMLElement | null;
  private readonly vignette: HTMLElement | null;
  private marker: Marker | null = null;
  private spriteCanvas: HTMLCanvasElement | null = null;
  private spriteKey = '';
  private heroWidth = 0;
  private northUp = false;
  private loaded = false;

  // estado espelhado do host
  private mode: CameraMode = 'map';
  private live: LiveStatus = 'none';
  private profile: Profile | null = null;
  private home: LngLat = { lng: 0, lat: 0 };
  private coins: Coin[] = [];
  private pois: PoiMarker[] = [];
  private track: number[][] = [];
  private route: { coords: number[]; dest: LngLat } | null = null;
  /** Metros da rota já percorridos (host) e distâncias acumuladas do trajeto atual. */
  private routeDone = 0;
  private routeCum: { coords: number[]; cum: number[] } | null = null;
  /** Comandos de câmera que chegaram antes do estilo carregar. */
  private pendingCamera: CameraMsg[] = [];

  // câmera e loop
  private following = true;
  private interacting = false;
  /** Dedo (ou botão do mouse) pressionado no mapa: a câmera não segue o jogador enquanto isso. */
  private pressed = false;
  private viewTimer = 0;
  private lastViewKey = '';
  private transitionUntil = 0;
  private camBearing = 0;
  private lastT = 0;
  private lastRepaint = 0;
  private raf = 0;
  private active = true;
  private centeredOnFirstFix = false;
  private bulkUntil = 0;
  private lastTelemetry = 0;
  private telemetryKey = '';
  private lastTeleport = 0;
  private lastMapError = -Infinity;
  private cancelLongPress: () => void = () => {};

  constructor(container: HTMLElement, overlays: { tiltshift: HTMLElement | null; vignette: HTMLElement | null }) {
    this.container = container;
    this.tiltshift = overlays.tiltshift;
    this.vignette = overlays.vignette;
    onSimFix((fix, teleport) => send(teleport ? { type: 'simFix', fix, teleport: true } : { type: 'simFix', fix }));
    initKeyboard();
  }

  // ---------------------------------------------------------------------------
  // Mensagens
  // ---------------------------------------------------------------------------
  init(msg: InitMsg): void {
    this.mode = msg.mode;
    this.live = msg.live;
    this.profile = msg.profile;
    this.home = { lng: msg.center.lng, lat: msg.center.lat };
    if (this.map) {
      // host reconectou sem recarregar a página: só reaplica o estado
      this.applyProfile();
      this.setMode(this.mode, true);
      return;
    }
    this.mount();
  }

  handle(msg: HostToMap): void {
    switch (msg.type) {
      case 'init':
        this.init(msg);
        break;
      case 'mode': {
        const changed = msg.mode !== this.mode;
        this.live = msg.live;
        if (changed) this.setMode(msg.mode);
        else this.updateOverlays();
        break;
      }
      case 'profile':
        this.profile = { characterId: msg.characterId, modality: msg.modality };
        this.applyProfile();
        break;
      case 'cells':
        this.addCells(msg.keys, msg.reset);
        break;
      case 'coins':
        this.coins = msg.coins;
        this.updateCoins();
        break;
      case 'pois':
        this.pois = msg.pois;
        this.updatePois();
        break;
      case 'track':
        if (msg.reset) this.track = [];
        for (let i = 0; i + 1 < msg.coords.length; i += 2) this.track.push([msg.coords[i], msg.coords[i + 1]]);
        this.updateTrack();
        break;
      case 'route':
        this.route = msg.route;
        this.updateRoute();
        break;
      case 'routeDone':
        this.routeDone = msg.doneM;
        this.updateRoute();
        break;
      case 'gpsFix':
        setGpsTarget(msg.fix);
        break;
      case 'sim':
        setSimulator(msg.enabled, msg.pos, player.display ?? this.home);
        break;
      case 'simInput':
        setSimInput(msg.x, msg.y, msg.turbo ?? false);
        break;
      case 'camera':
        if (this.loaded) this.camera(msg);
        else this.pendingCamera.push(msg);
        break;
      case 'active':
        this.setActive(msg.active);
        break;
      case 'insets': {
        const root = document.documentElement.style;
        root.setProperty('--safe-t', `${Math.max(0, msg.top)}px`);
        root.setProperty('--safe-b', `${Math.max(0, msg.bottom)}px`);
        break;
      }
    }
  }

  private addCells(keys: number[], reset: boolean): void {
    const now = performance.now();
    if (reset) {
      this.fogLayer.setCells(keys);
      this.bulkUntil = now + BULK_GAP_MS;
    } else if (now < this.bulkUntil) {
      this.fogLayer.addCells(keys, false);
      this.bulkUntil = now + BULK_GAP_MS;
    } else {
      this.fogLayer.addCells(keys, true);
    }
  }

  // ---------------------------------------------------------------------------
  // Montagem
  // ---------------------------------------------------------------------------
  private mount(): void {
    const start = this.home;
    const ride = this.mode === 'ride';
    const map = new MLMap({
      container: this.container,
      style: buildStyle(),
      center: [start.lng, start.lat],
      zoom: ride ? ZOOM.record : ZOOM.map,
      pitch: ride ? PITCH.record : PITCH.map,
      maxPitch: 72,
      attributionControl: { compact: true },
      canvasContextAttributes: { antialias: true },
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      fadeDuration: 150,
      // Mantido do original: os POIs e as ruas agora vêm do host (sem querySourceFeatures), mas sem isto o
      // MapLibre v6 fatiaria os tiles acima do z14, o que muda a colocação de rótulos e linhas no zoom de rua.
      zoomLevelsToOverscale: 99,
    });
    this.map = map;
    registerImages(map);
    this.createMarker(start);
    this.updateOverlays();

    map.on('load', () => {
      this.container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
      this.onLoad();
    });
    map.on('dragstart', () => this.setFollowing(false));
    // seguindo o jogador há um `moveend` por quadro: a área visível vai para o host no máximo 2x/s
    map.on('moveend', () => this.scheduleView());
    map.on('rotatestart', (e) => {
      if (e.originalEvent && this.mode === 'ride') this.setFollowing(false);
    });
    map.on('zoomstart', (e) => {
      if (e.originalEvent) this.interacting = true;
    });
    map.on('zoomend', () => (this.interacting = false));
    // falhas do MapLibre (ex.: tiles sem rede) vão para o host como aviso, no máximo uma a cada 10 s
    map.on('error', (e) => {
      const now = performance.now();
      if (now - this.lastMapError < 10000) return;
      this.lastMapError = now;
      log('warn', `[mapa] ${e.error?.message ?? 'erro do MapLibre'}`);
    });
    // teleporte do simulador: botão direito (web) e toque longo (Android dispara `contextmenu` também)
    map.on('contextmenu', (e) => {
      e.originalEvent.preventDefault();
      if (!isSimulating() || performance.now() - this.lastTeleport < 1000) return;
      this.cancelLongPress();
      this.teleport({ lng: e.lngLat.lng, lat: e.lngLat.lat });
    });
    this.setupLongPress(map);
    this.setupPressGuard(map);

    this.lastT = performance.now();
    this.startLoop();
  }

  private createMarker(start: LngLat): void {
    const el = document.createElement('div');
    el.className = 'player-marker';
    const shadow = document.createElement('div');
    shadow.className = 'player-shadow';
    const canvas = document.createElement('canvas');
    canvas.className = 'player-sprite';
    el.append(shadow, canvas);
    el.style.visibility = 'hidden'; // aparece quando houver posição
    this.spriteCanvas = canvas;
    this.marker = new Marker({ element: el, anchor: 'bottom', pitchAlignment: 'viewport', rotationAlignment: 'viewport' })
      .setLngLat([start.lng, start.lat])
      .addTo(this.map!);
  }

  private setupLongPress(map: MLMap): void {
    const el = map.getCanvasContainer();
    let timer = 0;
    let start: { x: number; y: number } | null = null;
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = 0;
      start = null;
    };
    this.cancelLongPress = cancel;
    el.addEventListener(
      'touchstart',
      (e) => {
        cancel();
        if (e.touches.length !== 1 || !isSimulating()) return;
        const t = e.touches[0];
        start = { x: t.clientX, y: t.clientY };
        const rect = el.getBoundingClientRect();
        const point: [number, number] = [t.clientX - rect.left, t.clientY - rect.top];
        timer = window.setTimeout(() => {
          timer = 0;
          start = null;
          if (performance.now() - this.lastTeleport < 1000) return;
          const ll = map.unproject(point);
          this.teleport({ lng: ll.lng, lat: ll.lat });
        }, LONG_PRESS_MS);
      },
      { passive: true },
    );
    el.addEventListener(
      'touchmove',
      (e) => {
        if (!start) return;
        const t = e.touches[0];
        if (e.touches.length !== 1 || Math.hypot(t.clientX - start.x, t.clientY - start.y) > LONG_PRESS_SLOP_PX) cancel();
      },
      { passive: true },
    );
    el.addEventListener('touchend', cancel, { passive: true });
    el.addEventListener('touchcancel', cancel, { passive: true });
  }

  /**
   * `jumpTo` chama `stop()`, que zera todos os gestos do MapLibre. Seguir o jogador a cada quadro durante um toque
   * cancelaria o arrasto antes dele começar (no toque o `dragstart` só sai depois de passar da tolerância).
   * Por isso a câmera fica parada enquanto houver dedo no mapa.
   */
  private setupPressGuard(map: MLMap): void {
    const el = map.getCanvasContainer();
    const touches = (e: TouchEvent) => (this.pressed = e.touches.length > 0);
    el.addEventListener('touchstart', touches, { passive: true });
    el.addEventListener('touchend', touches, { passive: true });
    el.addEventListener('touchcancel', touches, { passive: true });
    el.addEventListener('mousedown', () => (this.pressed = true));
    window.addEventListener('mouseup', () => (this.pressed = false));
    window.addEventListener('blur', () => (this.pressed = false));
  }

  private scheduleView(): void {
    if (this.viewTimer) return;
    this.viewTimer = window.setTimeout(() => {
      this.viewTimer = 0;
      this.sendView();
    }, 500);
  }

  private sendView(): void {
    const map = this.map;
    if (!map || this.mode === 'stats') return;
    const b = map.getBounds();
    const view = {
      west: b.getWest(),
      south: b.getSouth(),
      east: b.getEast(),
      north: b.getNorth(),
      zoom: map.getZoom(),
    };
    // ~10 m de resolução: tremidas da câmera não viram mensagens novas
    const key = [view.west, view.south, view.east, view.north].map((v) => v.toFixed(4)).join(',');
    if (key === this.lastViewKey) return;
    this.lastViewKey = key;
    send({ type: 'view', ...view });
  }

  private teleport(p: LngLat): void {
    if (simTeleport(p)) this.lastTeleport = performance.now();
  }

  private onLoad(): void {
    const map = this.map!;
    map.addSource('game-track', { type: 'geojson', data: EMPTY });
    map.addSource('game-pois', { type: 'geojson', data: EMPTY });
    map.addSource('game-coins', { type: 'geojson', data: EMPTY });
    map.addSource('game-route', { type: 'geojson', data: EMPTY });

    map.addLayer(
      {
        id: 'track-glow',
        type: 'line',
        source: 'game-track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#fff8ec',
          'line-width': ['interpolate', ['linear'], ['zoom'], 13, 4, 18, 16],
          'line-opacity': 0.6,
          'line-blur': 2,
        },
      },
      'water-name',
    );
    map.addLayer(
      {
        id: 'track',
        type: 'line',
        source: 'game-track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': TRACK_COLOR[this.profile?.modality ?? 'bike'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 13, 2, 18, 7],
        },
      },
      'water-name',
    );

    map.addLayer(this.fogLayer);
    // rota planejada por cima da névoa: o caminho costuma passar justamente por onde ainda não se explorou
    map.addLayer({
      id: 'route-casing',
      type: 'line',
      source: 'game-route',
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#1d1730',
        'line-opacity': 0.7,
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 5, 18, 14],
      },
    });
    // já percorrido: cinza; o resto: dourado tracejado; o próximo trecho: verde com setas no sentido da rota
    map.addLayer({
      id: 'route-done',
      type: 'line',
      source: 'game-route',
      filter: ['==', ['get', 'part'], 'done'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#8f86a8',
        'line-opacity': 0.85,
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 18, 8],
      },
    });
    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'game-route',
      filter: ['==', ['get', 'part'], 'rest'],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': '#ffc63d',
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 18, 8],
        'line-dasharray': [2, 1.2],
      },
    });
    map.addLayer({
      id: 'route-next',
      type: 'line',
      source: 'game-route',
      filter: ['==', ['get', 'part'], 'next'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#3fd3a0',
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 3.5, 18, 11],
      },
    });
    map.addLayer({
      id: 'route-arrows',
      type: 'symbol',
      source: 'game-route',
      filter: ['==', ['get', 'part'], 'next'],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 90,
        'icon-image': 'route-arrow',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 18, 1.1],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
      },
    });
    map.addLayer({
      id: 'route-dest',
      type: 'circle',
      source: 'game-route',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 5, 18, 11],
        'circle-color': '#ffc63d',
        'circle-stroke-color': '#1d1730',
        'circle-stroke-width': 3,
      },
    });
    map.addLayer(
      {
        id: 'poi-halo',
        type: 'circle',
        source: 'game-pois',
        filter: ['==', ['get', 'state'], 'wild'],
        paint: {
          'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 14, 5, 18, 34],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.4,
          'circle-blur': 0.7,
          'circle-pitch-alignment': 'map',
          'circle-pitch-scale': 'map',
        },
      },
      'fog',
    );
    const spriteSize = ['interpolate', ['linear'], ['zoom'], ...SPRITE_SIZE_STOPS.flat()];
    map.addLayer({
      id: 'poi-icon',
      type: 'symbol',
      source: 'game-pois',
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': spriteSize as unknown as number,
        'icon-anchor': 'bottom',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-pitch-alignment': 'viewport',
        'icon-rotation-alignment': 'viewport',
        'symbol-z-order': 'viewport-y',
      },
    });
    map.addLayer({
      id: 'poi-label',
      type: 'symbol',
      source: 'game-pois',
      minzoom: 16.5,
      filter: ['!=', ['get', 'state'], 'fog'],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Bold'],
        'text-size': 12,
        'text-anchor': 'top',
        'text-offset': [0, 0.3],
        'text-max-width': 9,
        'text-optional': true,
        'text-pitch-alignment': 'viewport',
      },
      paint: { 'text-color': '#2a1f3d', 'text-halo-color': '#fff8ec', 'text-halo-width': 2 },
    });
    map.addLayer({
      id: 'coins',
      type: 'symbol',
      source: 'game-coins',
      layout: {
        'icon-image': ['concat', 'coin-', ['get', 'kind']],
        'icon-size': spriteSize as unknown as number,
        'icon-anchor': 'bottom',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-pitch-alignment': 'viewport',
        'icon-rotation-alignment': 'viewport',
        'symbol-z-order': 'viewport-y',
      },
    });

    map.on('click', (e) => {
      // o toque longo que teleportou não vale como toque no mapa
      if (performance.now() - this.lastTeleport < 800) return;
      const hit = map.queryRenderedFeatures(e.point, { layers: ['poi-icon'] })[0];
      const id = hit?.properties?.id;
      send({ type: 'select', id: typeof id === 'string' && id ? id : null });
    });
    map.on('mouseenter', 'poi-icon', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'poi-icon', () => (map.getCanvas().style.cursor = ''));

    this.loaded = true;
    this.updateTrack();
    this.updateRoute();
    this.updateCoins();
    this.updatePois();
    this.setMode(this.mode, true);
    for (const msg of this.pendingCamera.splice(0)) this.camera(msg);
    send({ type: 'loaded' });
    this.scheduleView();
  }

  // ---------------------------------------------------------------------------
  // Câmera
  // ---------------------------------------------------------------------------
  private setFollowing(v: boolean): void {
    if (this.following === v) return;
    this.following = v;
    send({ type: 'following', following: v });
  }

  private padding(mode: CameraMode) {
    const h = this.map?.getContainer().clientHeight ?? 800;
    return mode === 'ride'
      ? { top: Math.round(h * 0.42), bottom: 0, left: 0, right: 0 }
      : { top: 0, bottom: 0, left: 0, right: 0 };
  }

  private setMode(mode: CameraMode, instant = false): void {
    // saiu da câmera de atividade (talvez passando pelas Stats): a próxima visão de cima volta o norte para cima
    if (this.mode === 'ride' && mode !== 'ride') this.northUp = true;
    this.mode = mode;
    const ride = mode === 'ride';
    this.updateOverlays();
    this.fogLayer.opacity = ride ? 0.94 : 0.86;
    const map = this.map;
    // antes do estilo carregar só guarda o modo; o `load` aplica tudo de uma vez
    if (!map || !this.loaded) return;
    // na visão 3D os nomes poluem a frente do personagem
    map.setLayoutProperty('poi-label', 'visibility', ride ? 'none' : 'visible');
    if (mode === 'stats') return;
    this.setFollowing(true);
    const northUp = this.northUp && !ride;
    if (!ride) this.northUp = false;
    const p = player.display;
    const opts = {
      center: (p ? [p.lng, p.lat] : map.getCenter()) as LngLatLike,
      zoom: ride ? ZOOM.record : ZOOM.map,
      pitch: ride ? PITCH.record : PITCH.map,
      bearing: ride ? this.camBearing : northUp ? 0 : map.getBearing(),
      padding: this.padding(mode),
    };
    if (instant) {
      map.jumpTo(opts);
    } else {
      this.transitionUntil = performance.now() + 950;
      map.easeTo({ ...opts, duration: 900 });
    }
  }

  private camera(msg: CameraMsg): void {
    const map = this.map;
    if (!map) return;
    switch (msg.action) {
      case 'recenter':
        this.setMode(this.mode);
        break;
      case 'focus':
        // solta a câmera do jogador e mostra um ponto
        this.setFollowing(false);
        map.easeTo({ center: [msg.lng, msg.lat], zoom: Math.max(map.getZoom(), 16.3), duration: 700 });
        break;
      case 'fit': {
        // padding maior que a tela faz o MapLibre ignorar o enquadramento: encolhe proporcionalmente
        const el = map.getContainer();
        const pad = { ...msg.padding };
        const fitAxis = (size: number, a: 'top' | 'left', b: 'bottom' | 'right') => {
          const room = size - 100;
          if (pad[a] + pad[b] > room) {
            const k = Math.max(0, room) / (pad[a] + pad[b]);
            pad[a] *= k;
            pad[b] *= k;
          }
        };
        fitAxis(el.clientHeight, 'top', 'bottom');
        fitAxis(el.clientWidth, 'left', 'right');
        this.setFollowing(false);
        this.transitionUntil = performance.now() + 900;
        map.fitBounds(
          [
            [msg.west, msg.south],
            [msg.east, msg.north],
          ],
          // o cálculo do MapLibre ignora a inclinação: a prévia fica vista de cima (recentrar devolve o pitch)
          { padding: pad, duration: 800, maxZoom: 17, bearing: map.getBearing(), pitch: 0 },
        );
        break;
      }
      case 'zoomBy':
        // segurar o "seguir" durante a animação: o jumpTo de cada quadro interromperia o easeTo
        // (no original, os botões +/- não faziam nada enquanto a câmera seguia o jogador)
        this.transitionUntil = Math.max(this.transitionUntil, performance.now() + 300);
        map.easeTo({ zoom: map.getZoom() + msg.delta, duration: 250 });
        break;
    }
  }

  /** Vinheta e tilt-shift na câmera de atividade (gravando ou pausada). */
  private updateOverlays(): void {
    const ride = this.mode === 'ride';
    if (this.vignette) this.vignette.hidden = !ride;
    if (this.tiltshift) this.tiltshift.hidden = !(ride && this.live !== 'none');
  }

  // ---------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------
  private startLoop(): void {
    cancelAnimationFrame(this.raf);
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      this.frame(t);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (!this.map) return;
    if (active) {
      this.lastT = performance.now();
      this.startLoop();
    } else {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private frame(t: number): void {
    const map = this.map;
    if (!map || !this.active) return;
    const dt = t - this.lastT;
    this.lastT = t;
    if (document.visibilityState === 'hidden') return;

    tickPlayer(dt, map.getBearing(), this.mode === 'ride', this.profile?.modality ?? 'bike');
    const p = player.display;
    if (!p) return;

    if (!this.centeredOnFirstFix && !isSimulating()) {
      this.centeredOnFirstFix = true;
      map.jumpTo({ center: [p.lng, p.lat] });
    }

    if (this.marker) {
      this.marker.setLngLat([p.lng, p.lat]);
      this.marker.getElement().style.visibility = '';
    }
    this.updateSprite(map.getBearing());
    this.updateHeroSize(map.getZoom());

    if (this.mode === 'ride' && player.speed > 0.3) {
      this.camBearing =
        (this.camBearing + angleDiff(this.camBearing, player.heading) * Math.min(1, (dt / 1000) * 2.2) + 360) % 360;
    }

    if (this.mode !== 'stats' && this.following && !this.interacting && !this.pressed && t > this.transitionUntil) {
      if (this.mode === 'ride') {
        map.jumpTo({ center: [p.lng, p.lat], bearing: this.camBearing, padding: this.padding('ride') });
      } else {
        map.jumpTo({ center: [p.lng, p.lat] });
      }
    }

    // névoa e moedas são animadas
    if (this.mode !== 'stats' && t - this.lastRepaint > 33) {
      this.lastRepaint = t;
      map.triggerRepaint();
    }

    this.telemetry(t, p);
  }

  /** Posição exibida para o host (~4 Hz em movimento; parado, só um batimento por segundo). */
  private telemetry(t: number, p: LngLat): void {
    if (t - this.lastTelemetry < TELEMETRY_MS) return;
    const key = `${p.lng.toFixed(7)},${p.lat.toFixed(7)},${player.heading.toFixed(1)},${player.speed.toFixed(2)}`;
    if (key === this.telemetryKey && t - this.lastTelemetry < 1000) return;
    this.lastTelemetry = t;
    this.telemetryKey = key;
    send({ type: 'player', lng: p.lng, lat: p.lat, heading: player.heading, speed: player.speed, odometer: player.odometer });
  }

  private applyProfile(): void {
    this.spriteKey = '';
    const modality = this.profile?.modality;
    if (modality && this.loaded) this.map?.setPaintProperty('track', 'line-color', TRACK_COLOR[modality]);
  }

  /** Herói na mesma escala dos POIs: o tamanho segue o zoom (só mexe no DOM quando muda 1 px). */
  private updateHeroSize(zoom: number): void {
    const el = this.marker?.getElement();
    if (!el) return;
    const w = Math.round(HERO_PX_PER_SIZE * spriteSizeAt(zoom));
    if (w === this.heroWidth) return;
    this.heroWidth = w;
    el.style.width = `${w}px`;
    el.style.height = `${Math.round(w * HERO_ASPECT)}px`;
  }

  private updateSprite(mapBearing: number): void {
    const profile = this.profile;
    if (!profile || !this.spriteCanvas) return;
    const rel = angleDiff(mapBearing, player.heading);
    const facing: Facing = Math.abs(rel) < 50 ? 'up' : Math.abs(rel) > 130 ? 'down' : rel > 0 ? 'right' : 'left';
    const moving = player.speed > 0.35;
    const stepLen = profile.modality === 'run' ? 0.85 : 1.7;
    const frame = moving ? Math.floor(player.odometer / stepLen) % frameCount(profile.modality) : -1;
    const key = `${profile.characterId}|${profile.modality}|${facing}|${frame}`;
    if (key === this.spriteKey) return;
    this.spriteKey = key;
    drawRaster(this.spriteCanvas, cachedCharacterFrame(profile.characterId, profile.modality, facing, frame));
  }

  // ---------------------------------------------------------------------------
  // Estado do host -> fontes GeoJSON
  // ---------------------------------------------------------------------------
  private source(id: string): GeoJSONSource | undefined {
    if (!this.loaded) return undefined;
    return this.map?.getSource(id) as GeoJSONSource | undefined;
  }

  private updateTrack(): void {
    const src = this.source('game-track');
    if (!src) return;
    const line: FeatureCollection<LineString> = {
      type: 'FeatureCollection',
      features:
        this.track.length > 1
          ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: this.track } }]
          : [],
    };
    src.setData(line);
  }

  /**
   * Rota em três partes conforme o andamento: feito (cinza), próximos ROUTE_NEXT_M m (verde, com setas) e o
   * resto (dourado). Antes de iniciar o andamento é 0: o verde mostra para que lado sair.
   */
  private updateRoute(): void {
    const src = this.source('game-route');
    if (!src) return;
    const r = this.route;
    if (!r || r.coords.length < 4) {
      src.setData(EMPTY);
      return;
    }
    if (this.routeCum?.coords !== r.coords) {
      const cum = [0];
      for (let i = 2; i + 1 < r.coords.length; i += 2) {
        const a = { lng: r.coords[i - 2], lat: r.coords[i - 1] };
        cum.push(cum[cum.length - 1] + haversine(a, { lng: r.coords[i], lat: r.coords[i + 1] }));
      }
      this.routeCum = { coords: r.coords, cum };
    }
    const { cum } = this.routeCum;
    const total = cum[cum.length - 1];
    const done = Math.min(total, Math.max(0, this.routeDone));
    const next = Math.min(total, done + ROUTE_NEXT_M);

    const pointAt = (d: number): number[] => {
      let i = 0;
      while (i < cum.length - 2 && cum[i + 1] < d) i++;
      const seg = cum[i + 1] - cum[i];
      const t = seg > 0 ? (d - cum[i]) / seg : 0;
      const c = r.coords;
      return [c[i * 2] + (c[i * 2 + 2] - c[i * 2]) * t, c[i * 2 + 1] + (c[i * 2 + 3] - c[i * 2 + 1]) * t];
    };
    const slice = (from: number, to: number): number[][] => {
      if (to - from < 1) return [];
      const out = [pointAt(from)];
      for (let i = 0; i < cum.length; i++) {
        if (cum[i] > from && cum[i] < to) out.push([r.coords[i * 2], r.coords[i * 2 + 1]]);
      }
      out.push(pointAt(to));
      return out;
    };

    const features: Feature<LineString | Point>[] = [];
    for (const [part, line] of [
      ['done', slice(0, done)],
      ['rest', slice(next, total)],
      ['next', slice(done, next)],
    ] as const) {
      if (line.length < 2) continue;
      features.push({ type: 'Feature', properties: { part }, geometry: { type: 'LineString', coordinates: line } });
    }
    const destPoint: Point = { type: 'Point', coordinates: [r.dest.lng, r.dest.lat] };
    features.push({ type: 'Feature', properties: { part: 'dest' }, geometry: destPoint });
    src.setData({ type: 'FeatureCollection', features });
  }

  private updateCoins(): void {
    const src = this.source('game-coins');
    if (!src) return;
    const fc: FeatureCollection<Point> = {
      type: 'FeatureCollection',
      features: this.coins.map((c) => ({
        type: 'Feature',
        properties: { id: c.id, kind: c.kind },
        geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      })),
    };
    src.setData(fc);
  }

  private updatePois(): void {
    const src = this.source('game-pois');
    if (!src) return;
    const fc: FeatureCollection<Point> = {
      type: 'FeatureCollection',
      features: this.pois.map((p) => ({
        type: 'Feature',
        properties: { id: p.id, name: p.name, state: p.state, icon: p.icon, color: p.color },
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      })),
    };
    src.setData(fc);
  }
}
