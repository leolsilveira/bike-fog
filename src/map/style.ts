// Tema do mapa "cidade de brinquedo HD-2D" sobre os vector tiles do OpenFreeMap (schema OpenMapTiles).
import type { StyleSpecification, ExpressionSpecification } from 'maplibre-gl';
import { MAP_COLORS } from '../sprites/tiles.ts';

export const SOURCE = 'ofm';

export const THEME = {
  land: '#ece4c6',
  residential: '#f2e8ca',
  commercial: '#f5e0c8',
  industrial: '#e4dccd',
  school: '#f6e4cf',
  hospital: '#f7dcd8',
  cemetery: '#cfe0b4',
  pitch: '#9fd67a',
  track: '#e8a87c',
  wetland: '#a9d8bf',
  farmland: '#e5e7a9',
  ice: '#f2f9ff',
  waterEdge: '#2f86cc',
  ink: '#2a1f3d',
  roadMinor: '#fffaf0',
  roadMinorCase: '#cdb08a',
  roadMid: '#fff0c2',
  roadMidCase: '#c29a62',
  roadMajor: '#ffd98a',
  roadMajorCase: '#b47c3c',
  roadMotor: '#ffb48a',
  roadMotorCase: '#a8603f',
  path: '#e6cc9c',
  cycle: '#3fd3a0',
  cycleCase: '#1d8a68',
  rail: '#9c93b2',
  label: '#5a4330',
  labelHalo: '#fffaf0',
  place: '#4b3f72',
  waterLabel: '#1f6fa8',
  buildings: ['#f7c9a8', '#f3e2b3', '#c9daf2', '#eac4dc', '#d5e8b6', '#e6d4f5', '#fbe7c6'],
};

const name: ExpressionSpecification = ['coalesce', ['get', 'name:pt'], ['get', 'name'], ['get', 'name:latin']];

/** largura por zoom com crescimento exponencial (estilo padrão de vias). */
function w(stops: [number, number][]): ExpressionSpecification {
  return ['interpolate', ['exponential', 1.6], ['zoom'], ...stops.flat()] as ExpressionSpecification;
}

const isCycle: ExpressionSpecification = [
  'any',
  ['==', ['get', 'subclass'], 'cycleway'],
  ['all', ['==', ['get', 'class'], 'path'], ['==', ['get', 'bicycle'], 'designated']],
];
const notTunnel: ExpressionSpecification = ['!=', ['get', 'brunnel'], 'tunnel'];

function roadPair(
  id: string,
  classes: string[],
  fill: string,
  casing: string,
  widths: [number, number][],
  minzoom: number,
) {
  const filter: ExpressionSpecification = ['all', ['in', ['get', 'class'], ['literal', classes]], notTunnel];
  return [
    {
      id: `${id}-case`,
      type: 'line' as const,
      source: SOURCE,
      'source-layer': 'transportation',
      minzoom,
      filter,
      layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const },
      paint: { 'line-color': casing, 'line-width': w(widths.map(([z, v]) => [z, v * 1.35 + 1.2])) },
    },
    {
      id: `${id}-fill`,
      type: 'line' as const,
      source: SOURCE,
      'source-layer': 'transportation',
      minzoom,
      filter,
      layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const },
      paint: { 'line-color': fill, 'line-width': w(widths) },
    },
  ];
}

export function buildStyle(): StyleSpecification {
  const b = THEME.buildings;
  const buildingColor: ExpressionSpecification = [
    'match', ['%', ['to-number', ['id'], 0], 7],
    0, b[0], 1, b[1], 2, b[2], 3, b[3], 4, b[4], 5, b[5], b[6],
  ];

  return {
    version: 8,
    name: 'Desbrava Toytown',
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      [SOURCE]: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
        attribution:
          '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> ' +
          '<a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> ' +
          'Dados <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap</a>',
      },
    },
    sky: {
      'sky-color': '#79c3ff',
      'horizon-color': '#ffe6cc',
      'fog-color': '#cbbcff',
      'fog-ground-blend': 0.65,
      'horizon-fog-blend': 0.7,
      'sky-horizon-blend': 0.75,
      'atmosphere-blend': 0,
    },
    light: { anchor: 'viewport', color: '#fff1d6', intensity: 0.38, position: [1.3, 200, 35] },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': THEME.land } },

      // --- uso do solo -------------------------------------------------------------
      {
        id: 'landuse',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'landuse',
        paint: {
          'fill-color': [
            'match', ['get', 'class'],
            'residential', THEME.residential,
            ['commercial', 'retail'], THEME.commercial,
            ['industrial', 'railway', 'garages'], THEME.industrial,
            ['school', 'college', 'university', 'kindergarten'], THEME.school,
            'hospital', THEME.hospital,
            'cemetery', THEME.cemetery,
            'pitch', THEME.pitch,
            'track', THEME.track,
            ['playground', 'theme_park', 'zoo'], MAP_COLORS.grass,
            'stadium', THEME.commercial,
            THEME.residential,
          ],
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 14, 1],
        },
      },
      {
        id: 'landuse-pitch-lines',
        type: 'line',
        source: SOURCE,
        'source-layer': 'landuse',
        minzoom: 15,
        filter: ['in', ['get', 'class'], ['literal', ['pitch', 'track']]],
        paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-opacity': 0.8 },
      },
      {
        id: 'park-lowzoom',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'park',
        maxzoom: 14,
        paint: { 'fill-color': MAP_COLORS.park, 'fill-opacity': 0.9 },
      },
      {
        id: 'landcover-plain',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'landcover',
        filter: ['in', ['get', 'class'], ['literal', ['wetland', 'farmland', 'ice', 'rock']]],
        paint: {
          'fill-color': [
            'match', ['get', 'class'],
            'wetland', THEME.wetland,
            'farmland', THEME.farmland,
            'ice', THEME.ice,
            '#d9d2c2',
          ],
        },
      },
      {
        id: 'landcover-grass',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'landcover',
        filter: ['all', ['==', ['get', 'class'], 'grass'], ['!', ['in', ['get', 'subclass'], ['literal', ['park', 'garden']]]]],
        paint: { 'fill-pattern': 'tile-grass' },
      },
      {
        id: 'landcover-park',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'landcover',
        filter: ['all', ['==', ['get', 'class'], 'grass'], ['in', ['get', 'subclass'], ['literal', ['park', 'garden']]]],
        paint: { 'fill-pattern': 'tile-park' },
      },
      {
        id: 'landcover-wood',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'landcover',
        filter: ['==', ['get', 'class'], 'wood'],
        paint: { 'fill-pattern': 'tile-forest' },
      },
      {
        id: 'landcover-sand',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'landcover',
        filter: ['==', ['get', 'class'], 'sand'],
        paint: { 'fill-pattern': 'tile-sand' },
      },
      {
        id: 'park-edge',
        type: 'line',
        source: SOURCE,
        'source-layer': 'landcover',
        minzoom: 14,
        filter: ['in', ['get', 'class'], ['literal', ['grass', 'wood']]],
        paint: { 'line-color': '#5f9e48', 'line-width': 1.2, 'line-opacity': 0.55 },
      },

      // --- água ------------------------------------------------------------------
      {
        id: 'waterway',
        type: 'line',
        source: SOURCE,
        'source-layer': 'waterway',
        filter: notTunnel,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': MAP_COLORS.water,
          'line-width': [
            'interpolate', ['exponential', 1.6], ['zoom'],
            10, ['match', ['get', 'class'], 'river', 1, 0.2],
            14, ['match', ['get', 'class'], 'river', 4, 1],
            18, ['match', ['get', 'class'], 'river', 22, 6],
          ],
        },
      },
      {
        id: 'water',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'water',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'fill-pattern': 'tile-water' },
      },
      {
        id: 'water-edge',
        type: 'line',
        source: SOURCE,
        'source-layer': 'water',
        minzoom: 12,
        paint: { 'line-color': THEME.waterEdge, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 18, 2.4] },
      },

      {
        id: 'aeroway',
        type: 'line',
        source: SOURCE,
        'source-layer': 'aeroway',
        minzoom: 11,
        filter: ['in', ['get', 'class'], ['literal', ['runway', 'taxiway']]],
        paint: { 'line-color': '#d9d3c6', 'line-width': w([[11, 1], [17, 40]]) },
      },

      // --- vias ------------------------------------------------------------------
      {
        id: 'path',
        type: 'line',
        source: SOURCE,
        'source-layer': 'transportation',
        minzoom: 14,
        filter: ['all', ['==', ['get', 'class'], 'path'], ['!', isCycle], notTunnel],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': THEME.path,
          'line-width': w([[14, 1], [18, 4.5]]),
          'line-dasharray': [1.2, 0.8],
        },
      },
      ...roadPair('road-service', ['service', 'track'], THEME.roadMinor, THEME.roadMinorCase, [[14, 0.8], [18, 7]], 14),
      ...roadPair('road-minor', ['minor'], THEME.roadMinor, THEME.roadMinorCase, [[12, 0.6], [14, 2.4], [18, 13]], 12),
      ...roadPair('road-mid', ['tertiary', 'secondary'], THEME.roadMid, THEME.roadMidCase, [[9, 0.6], [14, 4], [18, 17]], 9),
      ...roadPair('road-major', ['primary', 'trunk'], THEME.roadMajor, THEME.roadMajorCase, [[7, 0.6], [14, 5], [18, 20]], 7),
      ...roadPair('road-motorway', ['motorway'], THEME.roadMotor, THEME.roadMotorCase, [[5, 0.6], [14, 5.5], [18, 22]], 5),
      {
        id: 'cycleway-case',
        type: 'line',
        source: SOURCE,
        'source-layer': 'transportation',
        minzoom: 13,
        filter: ['all', isCycle, notTunnel],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': THEME.cycleCase, 'line-width': w([[13, 1.6], [18, 8]]) },
      },
      {
        id: 'cycleway',
        type: 'line',
        source: SOURCE,
        'source-layer': 'transportation',
        minzoom: 13,
        filter: ['all', isCycle, notTunnel],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': THEME.cycle, 'line-width': w([[13, 0.8], [18, 5]]) },
      },
      {
        id: 'rail',
        type: 'line',
        source: SOURCE,
        'source-layer': 'transportation',
        minzoom: 12,
        filter: ['all', ['in', ['get', 'class'], ['literal', ['rail', 'transit']]], notTunnel],
        paint: { 'line-color': THEME.rail, 'line-width': w([[12, 0.8], [18, 4]]), 'line-dasharray': [2, 1.5] },
      },

      // --- prédios (cidade de brinquedo) -------------------------------------------
      {
        id: 'building-flat',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'building',
        minzoom: 13,
        maxzoom: 15,
        paint: { 'fill-color': buildingColor, 'fill-outline-color': '#c9b48f' },
      },
      {
        id: 'building-3d',
        type: 'fill-extrusion',
        source: SOURCE,
        'source-layer': 'building',
        minzoom: 14.5,
        filter: ['!=', ['get', 'hide_3d'], true],
        paint: {
          'fill-extrusion-color': buildingColor,
          'fill-extrusion-height': [
            'interpolate', ['linear'], ['zoom'],
            14.5, 0,
            15.5, ['max', 3, ['min', 40, ['*', 0.8, ['coalesce', ['get', 'render_height'], 6]]]],
          ],
          'fill-extrusion-base': ['min', 30, ['*', 0.8, ['coalesce', ['get', 'render_min_height'], 0]]],
          'fill-extrusion-opacity': 1,
          'fill-extrusion-vertical-gradient': true,
        },
      },

      // --- árvores em pé ao redor de parques e matas ----------------------------------
      {
        id: 'trees',
        type: 'symbol',
        source: SOURCE,
        'source-layer': 'landcover',
        minzoom: 15.5,
        filter: ['in', ['get', 'class'], ['literal', ['grass', 'wood']]],
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 15.5, 120, 18, 90],
          'icon-image': ['case', ['==', ['get', 'class'], 'wood'], 'tree-pine', 'tree-round'],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 15.5, 0.4, 18, 0.8],
          'icon-anchor': 'bottom',
          'icon-pitch-alignment': 'viewport',
          'icon-rotation-alignment': 'viewport',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      },

      // --- rótulos ------------------------------------------------------------------
      {
        id: 'water-name',
        type: 'symbol',
        source: SOURCE,
        'source-layer': 'water_name',
        layout: {
          'text-field': name,
          'text-font': ['Noto Sans Italic'],
          'text-size': 13,
          'text-letter-spacing': 0.1,
        },
        paint: { 'text-color': THEME.waterLabel, 'text-halo-color': '#e6f6ff', 'text-halo-width': 1.6 },
      },
      {
        id: 'road-name',
        type: 'symbol',
        source: SOURCE,
        'source-layer': 'transportation_name',
        minzoom: 14,
        filter: ['in', ['get', 'class'], ['literal', ['minor', 'tertiary', 'secondary', 'primary', 'trunk', 'service', 'path']]],
        layout: {
          'symbol-placement': 'line',
          'text-field': name,
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 18, 14],
          'text-max-angle': 30,
          'symbol-spacing': 280,
          'text-pitch-alignment': 'viewport',
        },
        paint: { 'text-color': THEME.label, 'text-halo-color': THEME.labelHalo, 'text-halo-width': 1.8 },
      },
      {
        id: 'place-name',
        type: 'symbol',
        source: SOURCE,
        'source-layer': 'place',
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village', 'suburb', 'neighbourhood', 'quarter']]],
        layout: {
          'text-field': name,
          'text-font': ['Noto Sans Bold'],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.18,
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            6, ['match', ['get', 'class'], ['city', 'town'], 12, 9],
            11, ['match', ['get', 'class'], ['city', 'town'], 17, 10],
            16, ['match', ['get', 'class'], ['city', 'town'], 24, 14],
          ],
          'text-max-width': 8,
        },
        paint: { 'text-color': THEME.place, 'text-halo-color': '#fff8ec', 'text-halo-width': 2 },
      },
    ],
  };
}
