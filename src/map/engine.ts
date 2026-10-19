// Motor do mapa: uma instância MapLibre compartilhada pelas abas Mapa e Gravar.
import { Map as MLMap, Marker, setWorkerUrl, type GeoJSONSource, type LngLatLike } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { FeatureCollection, LineString, Point } from 'geojson';
import { buildStyle, SOURCE } from './style.ts';
import { FogLayer } from './fogLayer.ts';
import { registerImages } from './images.ts';
import { DEFAULT_CENTER, PITCH, POI_NEARBY_M, ZOOM } from '../game/config.ts';
import { angleDiff, cellOf, haversine, type LngLat } from '../game/geo.ts';
import { fog } from '../game/fog.ts';
import { pois, CAPTURABLE_CLASSES, type RawPoiFeature } from '../game/pois.ts';
import { player, tickPlayer, simTeleport } from '../game/location.ts';
import { onTrack, setRoadSampler } from '../game/tracker.ts';
import { useGame } from '../game/store.ts';
import { RARITY_INFO } from '../sprites/items.ts';
import { frameCount, type Facing } from '../sprites/characters.ts';
import { cachedCharacterFrame, drawRaster } from '../ui/spriteCanvas.ts';
import type { Tab } from '../game/types.ts';

setWorkerUrl(workerUrl);

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const ROAD_CLASSES = ['minor', 'service', 'tertiary', 'secondary', 'primary', 'path', 'track'];
const TRACK_COLOR = { bike: '#3fd3a0', run: '#ff6b5a' };

type Listener = () => void;

class Engine {
  map: MLMap | null = null;
  readonly fogLayer = new FogLayer();
  private marker: Marker | null = null;
  private spriteCanvas: HTMLCanvasElement | null = null;
  private spriteKey = '';
  private mode: Tab = 'record';
  private following = true;
  private interacting = false;
  private transitionUntil = 0;
  private camBearing = 0;
  private lastT = 0;
  private lastRepaint = 0;
  private raf = 0;
  private poiDirty = true;
  private poiCenter: LngLat | null = null;
  private lastPoiBuild = 0;
  private harvestTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<Listener>();
  private unsubs: (() => void)[] = [];
  private centeredOnFirstFix = false;

  get isFollowing(): boolean {
    return this.following;
  }

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private setFollowing(v: boolean): void {
    if (this.following === v) return;
    this.following = v;
    this.listeners.forEach((fn) => fn());
  }

  mount(container: HTMLElement): void {
    if (this.map) return;
    const start = player.display ?? useGame.getState().fix ?? DEFAULT_CENTER;
    this.mode = useGame.getState().tab;
    const map = new MLMap({
      container,
      style: buildStyle(),
      center: [start.lng, start.lat],
      zoom: this.mode === 'record' ? ZOOM.record : ZOOM.map,
      pitch: this.mode === 'record' ? PITCH.record : PITCH.map,
      maxPitch: 72,
      attributionControl: { compact: true },
      canvasContextAttributes: { antialias: true },
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      fadeDuration: 150,
      // Acima do z14 o MapLibre v6 fatia tiles e descarta camadas fora do estilo (ex.: `poi`).
      // Reutilizar o tile z14 inteiro mantém POIs e ruas disponíveis para o jogo.
      zoomLevelsToOverscale: 99,
    });
    this.map = map;
    registerImages(map);
    this.createMarker(start);

    map.on('load', () => {
      container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
      this.onLoad();
    });
    map.on('dragstart', () => this.setFollowing(false));
    map.on('rotatestart', (e) => {
      if (e.originalEvent && this.mode === 'record') this.setFollowing(false);
    });
    map.on('zoomstart', (e) => {
      if (e.originalEvent) this.interacting = true;
    });
    map.on('zoomend', () => (this.interacting = false));
    map.on('contextmenu', (e) => {
      if (!useGame.getState().settings.simulator) return;
      e.originalEvent.preventDefault();
      simTeleport({ lng: e.lngLat.lng, lat: e.lngLat.lat });
    });
    map.on('sourcedata', (e) => {
      if (e.sourceId === SOURCE && e.tile) this.scheduleHarvest();
    });
    map.on('idle', () => this.scheduleHarvest());

    setRoadSampler(() => this.sampleRoads());
    this.lastT = performance.now();
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      this.frame(t);
    };
    this.raf = requestAnimationFrame(loop);

    if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) {
      (window as unknown as Record<string, unknown>).__desbrava = { engine: this, useGame, fog, pois, player, simTeleport };
    }
  }

  unmount(): void {
    cancelAnimationFrame(this.raf);
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.marker?.remove();
    this.marker = null;
    this.map?.remove();
    this.map = null;
    this.spriteKey = '';
    this.centeredOnFirstFix = false;
    this.poiCenter = null;
    this.poiDirty = true;
    if (this.harvestTimer) clearTimeout(this.harvestTimer);
    this.harvestTimer = null;
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

  private onLoad(): void {
    const map = this.map!;
    map.addSource('game-track', { type: 'geojson', data: EMPTY });
    map.addSource('game-pois', { type: 'geojson', data: EMPTY });
    map.addSource('game-coins', { type: 'geojson', data: EMPTY });

    const modality = useGame.getState().profile?.modality ?? 'bike';
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
          'line-color': TRACK_COLOR[modality],
          'line-width': ['interpolate', ['linear'], ['zoom'], 13, 2, 18, 7],
        },
      },
      'water-name',
    );

    map.addLayer(this.fogLayer);
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
    const spriteSize = ['interpolate', ['linear'], ['zoom'], 13, 0.32, 16, 0.6, 18.5, 0.95] as const;
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
      const hit = map.queryRenderedFeatures(e.point, { layers: ['poi-icon'] })[0];
      const id = hit?.properties?.id as string | undefined;
      useGame.getState().select((id && pois.get(id)) || null);
    });
    map.on('mouseenter', 'poi-icon', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'poi-icon', () => (map.getCanvas().style.cursor = ''));

    // névoa: carga inicial + incrementos
    this.fogLayer.setCells(fog.keys());
    this.unsubs.push(
      fog.subscribe((added, reset) => {
        if (reset) this.fogLayer.setCells(fog.keys());
        else this.fogLayer.addCells(added, true);
        this.poiDirty = true;
      }),
      pois.subscribe(() => {
        this.poiDirty = true;
        useGame.setState({ poiRev: useGame.getState().poiRev + 1 });
      }),
      onTrack((track) => this.updateTrack(track)),
      useGame.subscribe((s, prev) => {
        if (s.coins !== prev.coins) this.updateCoins();
        if (s.captures !== prev.captures) this.poiDirty = true;
        if (s.tab !== prev.tab) this.setMode(s.tab);
        if (s.profile?.modality !== prev.profile?.modality && s.profile) {
          map.setPaintProperty('track', 'line-color', TRACK_COLOR[s.profile.modality]);
        }
      }),
    );
    this.updateCoins();
    this.setMode(useGame.getState().tab, true);
  }

  // ---------------------------------------------------------------------------
  // Câmera
  // ---------------------------------------------------------------------------
  private padding(mode: Tab) {
    const h = this.map?.getContainer().clientHeight ?? 800;
    return mode === 'record' ? { top: Math.round(h * 0.42), bottom: 0, left: 0, right: 0 } : { top: 0, bottom: 0, left: 0, right: 0 };
  }

  setMode(mode: Tab, instant = false): void {
    this.mode = mode;
    this.marker?.getElement().classList.toggle('is-record', mode === 'record');
    const map = this.map;
    if (!map) return;
    this.fogLayer.opacity = mode === 'record' ? 0.94 : 0.86;
    // na visão 3D os nomes poluem a frente do personagem
    if (map.getLayer('poi-label')) map.setLayoutProperty('poi-label', 'visibility', mode === 'record' ? 'none' : 'visible');
    if (mode === 'stats') return;
    this.setFollowing(true);
    const p = player.display;
    const opts = {
      center: (p ? [p.lng, p.lat] : map.getCenter()) as LngLatLike,
      zoom: mode === 'record' ? ZOOM.record : ZOOM.map,
      pitch: mode === 'record' ? PITCH.record : PITCH.map,
      bearing: mode === 'record' ? this.camBearing : map.getBearing(),
      padding: this.padding(mode),
    };
    if (instant) {
      map.jumpTo(opts);
    } else {
      this.transitionUntil = performance.now() + 950;
      map.easeTo({ ...opts, duration: 900 });
    }
  }

  recenter(): void {
    this.setMode(this.mode);
  }

  /** Solta a câmera do jogador e mostra um ponto. */
  focus(p: LngLat): void {
    if (!this.map) return;
    this.setFollowing(false);
    this.map.easeTo({ center: [p.lng, p.lat], zoom: Math.max(this.map.getZoom(), 16.3), duration: 700 });
  }

  zoomBy(delta: number): void {
    this.map?.easeTo({ zoom: (this.map.getZoom() ?? 16) + delta, duration: 250 });
  }

  // ---------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------
  private frame(t: number): void {
    const map = this.map;
    if (!map) return;
    const dt = t - this.lastT;
    this.lastT = t;
    if (document.visibilityState === 'hidden') return;

    tickPlayer(dt, map.getBearing(), this.mode === 'record');
    const p = player.display;
    if (!p) return;

    if (!this.centeredOnFirstFix && !useGame.getState().settings.simulator) {
      this.centeredOnFirstFix = true;
      map.jumpTo({ center: [p.lng, p.lat] });
    }

    if (this.marker) {
      this.marker.setLngLat([p.lng, p.lat]);
      this.marker.getElement().style.visibility = '';
    }
    this.updateSprite(map.getBearing());

    if (this.mode === 'record' && player.speed > 0.3) {
      this.camBearing = (this.camBearing + angleDiff(this.camBearing, player.heading) * Math.min(1, (dt / 1000) * 2.2) + 360) % 360;
    }

    if (this.mode !== 'stats' && this.following && !this.interacting && t > this.transitionUntil) {
      if (this.mode === 'record') {
        map.jumpTo({ center: [p.lng, p.lat], bearing: this.camBearing, padding: this.padding('record') });
      } else {
        map.jumpTo({ center: [p.lng, p.lat] });
      }
    }

    // névoa e moedas são animadas
    if (this.mode !== 'stats' && t - this.lastRepaint > 33) {
      this.lastRepaint = t;
      map.triggerRepaint();
    }

    if (t - this.lastPoiBuild > 1000) {
      const moved = this.poiCenter ? haversine(this.poiCenter, p) : Infinity;
      if (this.poiDirty || moved > 150) {
        this.lastPoiBuild = t;
        this.buildPois(p);
      }
    }
  }

  private updateSprite(mapBearing: number): void {
    const s = useGame.getState();
    const profile = s.profile;
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
  // Dados do jogo -> fontes GeoJSON
  // ---------------------------------------------------------------------------
  private updateTrack(track: number[]): void {
    const src = this.map?.getSource('game-track') as GeoJSONSource | undefined;
    if (!src) return;
    const coords: number[][] = [];
    for (let i = 0; i < track.length; i += 3) coords.push([track[i], track[i + 1]]);
    const line: FeatureCollection<LineString> = {
      type: 'FeatureCollection',
      features: coords.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] : [],
    };
    src.setData(line);
  }

  private updateCoins(): void {
    const src = this.map?.getSource('game-coins') as GeoJSONSource | undefined;
    if (!src) return;
    const fc: FeatureCollection<Point> = {
      type: 'FeatureCollection',
      features: useGame.getState().coins.map((c) => ({
        type: 'Feature',
        properties: { id: c.id, kind: c.kind },
        geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      })),
    };
    src.setData(fc);
  }

  private buildPois(center: LngLat): void {
    const src = this.map?.getSource('game-pois') as GeoJSONSource | undefined;
    if (!src) return;
    this.poiDirty = false;
    this.poiCenter = center;
    const captures = useGame.getState().captures;
    const near = pois.nearby(center, POI_NEARBY_M * 1.8).slice(0, 350);
    // capturados de outras áreas continuam visíveis como troféus
    const fc: FeatureCollection<Point> = {
      type: 'FeatureCollection',
      features: near.map(({ poi }) => {
        const captured = !!captures[poi.id];
        const revealed = captured || fog.has(cellOf(poi));
        const state = captured ? 'captured' : revealed ? 'wild' : 'fog';
        return {
          type: 'Feature',
          properties: {
            id: poi.id,
            name: poi.name,
            state,
            icon: state === 'fog' ? 'poi-fog' : `poi-${poi.category}-${state}`,
            color: RARITY_INFO[poi.rarity].color,
          },
          geometry: { type: 'Point', coordinates: [poi.lng, poi.lat] },
        };
      }),
    };
    src.setData(fc);
  }

  private scheduleHarvest(): void {
    if (this.harvestTimer) return;
    this.harvestTimer = setTimeout(() => {
      this.harvestTimer = null;
      this.harvest();
    }, 700);
  }

  private harvest(): void {
    const map = this.map;
    if (!map || !map.getSource(SOURCE)) return;
    const feats = map.querySourceFeatures(SOURCE, {
      sourceLayer: 'poi',
      filter: ['in', ['get', 'class'], ['literal', CAPTURABLE_CLASSES]],
    });
    const raw: RawPoiFeature[] = [];
    for (const f of feats) {
      if (f.geometry.type !== 'Point') continue;
      const [lng, lat] = f.geometry.coordinates;
      raw.push({ id: f.id, lng, lat, z: (f as { tile?: { z: number } }).tile?.z ?? 0, props: f.properties ?? {} });
    }
    pois.harvest(raw);
  }

  private sampleRoads(): LngLat[][] {
    const map = this.map;
    if (!map || !map.getSource(SOURCE)) return [];
    const feats = map.querySourceFeatures(SOURCE, {
      sourceLayer: 'transportation',
      filter: ['all', ['in', ['get', 'class'], ['literal', ROAD_CLASSES]], ['!=', ['get', 'brunnel'], 'tunnel']],
    });
    const out: LngLat[][] = [];
    for (const f of feats) {
      const g = f.geometry;
      const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      for (const line of lines) out.push(line.map(([lng, lat]) => ({ lng, lat })));
    }
    return out;
  }
}

export const engine = new Engine();
