// Números de balanceamento do jogo num lugar só.
import type { Modality } from '../sprites/characters.ts';

export const GAME_NAME = 'Desbrava';
export const GAME_TAGLINE = 'pedale. corra. revele sua cidade.';

/** Zoom da grade de exploração (células Web Mercator). z21 ≈ 19 m no equador, ~17 m em SP. */
export const CELL_ZOOM = 21;
/** Raio revelado ao redor do jogador durante uma atividade. */
export const REVEAL_RADIUS_M = 38;

export const COIN_PICKUP_M = 24;
/** POIs dentro deste raio entram na lista "por perto". */
export const POI_NEARBY_M = 1500;

export const COINS_PER_SPAWN = 26;
export const COIN_SPAWN_RADIUS_M = 1100;
export const COIN_MIN_SPACING_M = 70;
/** Ao se afastar isso do último centro de spawn, nasce um novo lote de moedas. */
export const RESPAWN_DISTANCE_M = 1200;
export const MAX_SPAWNS_PER_ACTIVITY = 6;

/** Acima disso a exploração pausa (carro, metrô...). m/s */
export const MAX_SPEED: Record<Modality, number> = { bike: 16.7, run: 7 };
/** Velocidade do simulador. m/s */
export const SIM_SPEED: Record<Modality, number> = { bike: 6.5, run: 3.2 };

/** Precisão mínima do GPS para contar distância/revelar. */
export const MAX_ACCURACY_M = 45;

/** Av. Paulista — usada quando não há GPS ou no simulador. */
export const DEFAULT_CENTER = { lng: -46.6559, lat: -23.5614 };

export const XP = {
  perKm: { bike: 12, run: 30 } as Record<Modality, number>,
  perCell: 2,
  perCoinValue: 1,
};

export const ZOOM = {
  map: 15.6,
  record: 18.1,
};
export const PITCH = {
  map: 45,
  record: 64,
};
