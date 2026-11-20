// Configuração de avatar customizável: estilo de cabelo + paletas curadas de 16-bit para cada parte.
// Módulo puro (sem React Native / DOM) para ser compartilhado entre o app e o map-runtime.
import {
  CHARACTERS, characterById, characterFrame,
  type CharacterColors, type Facing, type HairStyle, type Modality,
} from './characters.ts';
import type { Raster } from './pixel.ts';

export type AvatarColorKey = 'skin' | 'hair' | 'top' | 'bottom' | 'shoe' | 'helmet' | 'bike';
export type AvatarPart = AvatarColorKey;
export type AvatarColors = Record<AvatarColorKey, string>;

export interface AvatarConfig {
  hair: HairStyle;
  colors: AvatarColors;
}

export interface ColorSwatch {
  id: string;
  name: string;
  color: string;
  shade?: string;
  light?: string;
}

export const HAIR_STYLES: readonly { id: HairStyle; label: string }[] = [
  { id: 'short', label: 'Curto' },
  { id: 'pony', label: 'Rabo' },
  { id: 'puff', label: 'Black' },
];

export const AVATAR_PARTS: readonly { id: AvatarPart; label: string }[] = [
  { id: 'hair', label: 'Cabelo' },
  { id: 'skin', label: 'Pele' },
  { id: 'top', label: 'Camisa' },
  { id: 'bottom', label: 'Shorts' },
  { id: 'shoe', label: 'Tênis' },
  { id: 'helmet', label: 'Capacete' },
  { id: 'bike', label: 'Bike' },
];

export const AVATAR_SWATCHES: Record<AvatarColorKey, readonly ColorSwatch[]> = {
  skin: [
    { id: 'porcelana', name: 'Clara', color: '#f6cfae', shade: '#d9a582' },
    { id: 'pessego', name: 'Pêssego', color: '#f3c3a0', shade: '#d39a76' },
    { id: 'areia', name: 'Areia', color: '#f1c7a0', shade: '#d1a07a' },
    { id: 'dourada', name: 'Dourada', color: '#e8b48a', shade: '#c98d66' },
    { id: 'canela', name: 'Canela', color: '#c48a64', shade: '#a16a48' },
    { id: 'bronze', name: 'Bronze', color: '#a86e4b', shade: '#855234' },
    { id: 'cacau', name: 'Cacau', color: '#8d5a3b', shade: '#6b4029' },
    { id: 'ebano', name: 'Ébano', color: '#5c3522', shade: '#3f2214' },
  ],
  hair: [
    { id: 'preto', name: 'Preto', color: '#1d1a2a', shade: '#0f0d18', light: '#3a3552' },
    { id: 'escuro', name: 'Café', color: '#2a1a1a', shade: '#160d0f', light: '#4a3030' },
    { id: 'castanho', name: 'Castanho', color: '#4a2c2a', shade: '#2f1b1d', light: '#7a4a3c' },
    { id: 'mel', name: 'Mel', color: '#8a5a32', shade: '#5e3b20', light: '#b07a48' },
    { id: 'ruivo', name: 'Ruivo', color: '#e0732e', shade: '#b0521a', light: '#ffa05a' },
    { id: 'loiro', name: 'Loiro', color: '#f2c94c', shade: '#c49622', light: '#ffe385' },
    { id: 'prata', name: 'Prata', color: '#d8d6e8', shade: '#a5a2bd', light: '#f4f3ff' },
    { id: 'rosa', name: 'Rosa', color: '#ff7ab8', shade: '#c94a8a', light: '#ffb0d6' },
    { id: 'azul', name: 'Azul', color: '#5ab8f0', shade: '#3a83b8', light: '#99d8ff' },
    { id: 'menta', name: 'Menta', color: '#4fe0b0', shade: '#2a9c7a', light: '#92f5d3' },
  ],
  top: [
    { id: 'coral', name: 'Coral', color: '#ff6b5a', shade: '#c94a3f' },
    { id: 'menta', name: 'Menta', color: '#4fe0b0', shade: '#2a9c7a' },
    { id: 'ouro', name: 'Ouro', color: '#ffd23f', shade: '#d19a1a' },
    { id: 'ceu', name: 'Céu', color: '#5ab8f0', shade: '#3a83b8' },
    { id: 'violeta', name: 'Violeta', color: '#6e4bd8', shade: '#4a2fa0' },
    { id: 'floresta', name: 'Verde', color: '#2fae5a', shade: '#1e7a3e' },
    { id: 'rosa', name: 'Rosa', color: '#ff6b9a', shade: '#c94a75' },
    { id: 'laranja', name: 'Laranja', color: '#ff9248', shade: '#cc6824' },
    { id: 'creme', name: 'Creme', color: '#fff8ec', shade: '#c9c2b0' },
    { id: 'grafite', name: 'Grafite', color: '#2b2838', shade: '#181524' },
  ],
  bottom: [
    { id: 'marinho', name: 'Marinho', color: '#2f3e7a', shade: '#1f2a57' },
    { id: 'chumbo', name: 'Chumbo', color: '#3a3550', shade: '#25213a' },
    { id: 'noite', name: 'Noite', color: '#1d1a2a', shade: '#0f0d18' },
    { id: 'violeta', name: 'Violeta', color: '#6e4bd8', shade: '#4a2fa0' },
    { id: 'areia', name: 'Areia', color: '#e9e3d0', shade: '#b9b2a0' },
    { id: 'ouro', name: 'Ouro', color: '#ffd23f', shade: '#d19a1a' },
    { id: 'verde', name: 'Verde', color: '#2fae5a', shade: '#1e7a3e' },
    { id: 'coral', name: 'Coral', color: '#ff6b5a', shade: '#c94a3f' },
  ],
  shoe: [
    { id: 'menta', name: 'Menta', color: '#4fe0b0' },
    { id: 'coral', name: 'Coral', color: '#ff6b5a' },
    { id: 'creme', name: 'Branco', color: '#fff8ec' },
    { id: 'ouro', name: 'Ouro', color: '#ffd23f' },
    { id: 'rosa', name: 'Rosa', color: '#ff7ab8' },
    { id: 'tinta', name: 'Escuro', color: '#2a1f3d' },
    { id: 'ceu', name: 'Céu', color: '#5ab8f0' },
    { id: 'violeta', name: 'Violeta', color: '#6e4bd8' },
  ],
  helmet: [
    { id: 'ouro', name: 'Ouro', color: '#ffd23f', shade: '#d19a1a' },
    { id: 'ceu', name: 'Céu', color: '#5ab8f0', shade: '#3a83b8' },
    { id: 'rosa', name: 'Rosa', color: '#ff6b9a', shade: '#c94a75' },
    { id: 'creme', name: 'Branco', color: '#fff8ec', shade: '#c9c2b0' },
    { id: 'menta', name: 'Menta', color: '#4fe0b0', shade: '#2a9c7a' },
    { id: 'coral', name: 'Coral', color: '#ff6b5a', shade: '#c94a3f' },
    { id: 'violeta', name: 'Violeta', color: '#6e4bd8', shade: '#4a2fa0' },
    { id: 'noite', name: 'Preto', color: '#1d1a2a', shade: '#0f0d18' },
  ],
  bike: [
    { id: 'menta', name: 'Menta', color: '#4fe0b0', shade: '#2a9c7a' },
    { id: 'coral', name: 'Coral', color: '#ff6b5a', shade: '#c94a3f' },
    { id: 'violeta', name: 'Violeta', color: '#6e4bd8', shade: '#4a2fa0' },
    { id: 'noite', name: 'Preto', color: '#1d1a2a', shade: '#0f0d18' },
    { id: 'ouro', name: 'Ouro', color: '#ffd23f', shade: '#d19a1a' },
    { id: 'prata', name: 'Prata', color: '#c3c7da', shade: '#80849c' },
    { id: 'ceu', name: 'Céu', color: '#5ab8f0', shade: '#3a83b8' },
    { id: 'verde', name: 'Verde', color: '#2fae5a', shade: '#1e7a3e' },
    { id: 'rosa', name: 'Rosa', color: '#ff6b9a', shade: '#c94a75' },
  ],
};

function parseHex(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}

function toHex(r: number, g: number, b: number): string {
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${f(r)}${f(g)}${f(b)}`;
}

function deriveShade(hex: string, factor = 0.76): string {
  const [r, g, b] = parseHex(hex);
  return toHex(r * factor, g * factor, b * factor);
}

function deriveLight(hex: string, amount = 0.28): string {
  const [r, g, b] = parseHex(hex);
  return toHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount);
}

function findSwatch(part: AvatarColorKey, hex: string): ColorSwatch | undefined {
  const target = hex.toLowerCase();
  return AVATAR_SWATCHES[part].find((s) => s.color.toLowerCase() === target);
}

/** Expande as 7 cores principais do avatar para a paleta completa (com sombras e brilho do cabelo). */
export function resolveCharacterColors(colors: AvatarColors): CharacterColors {
  const skin = findSwatch('skin', colors.skin);
  const hair = findSwatch('hair', colors.hair);
  const top = findSwatch('top', colors.top);
  const bottom = findSwatch('bottom', colors.bottom);
  const helmet = findSwatch('helmet', colors.helmet);
  const bike = findSwatch('bike', colors.bike);

  return {
    skin: colors.skin,
    skinShade: skin?.shade ?? deriveShade(colors.skin, 0.82),
    hair: colors.hair,
    hairShade: hair?.shade ?? deriveShade(colors.hair, 0.68),
    hairLight: hair?.light ?? deriveLight(colors.hair, 0.25),
    top: colors.top,
    topShade: top?.shade ?? deriveShade(colors.top, 0.74),
    bottom: colors.bottom,
    bottomShade: bottom?.shade ?? deriveShade(colors.bottom, 0.7),
    shoe: colors.shoe,
    helmet: colors.helmet,
    helmetShade: helmet?.shade ?? deriveShade(colors.helmet, 0.74),
    bike: colors.bike,
    bikeShade: bike?.shade ?? deriveShade(colors.bike, 0.72),
  };
}

/** Converte um dos presets clássicos (`CHARACTERS`) em `AvatarConfig`. */
export function avatarFromCharacter(characterId: string): AvatarConfig {
  const def = characterById(characterId);
  return {
    hair: def.hair,
    colors: {
      skin: def.colors.skin,
      hair: def.colors.hair,
      top: def.colors.top,
      bottom: def.colors.bottom,
      shoe: def.colors.shoe,
      helmet: def.colors.helmet,
      bike: def.colors.bike,
    },
  };
}

/** Avatar padrão inicial (baseado no primeiro preset). */
export const DEFAULT_AVATAR: AvatarConfig = avatarFromCharacter(CHARACTERS[0].id);

/** Resolve o avatar efetivo de um perfil (com fallback para saves antigos sem `profile.avatar`). */
export function resolveAvatar(profile: { characterId: string; avatar?: AvatarConfig }): AvatarConfig {
  return profile.avatar ?? avatarFromCharacter(profile.characterId);
}

/** Chave compacta e determinística para cache de rasters. */
export function avatarKey(avatar: AvatarConfig): string {
  const c = avatar.colors;
  return `${avatar.hair}|${c.skin}|${c.hair}|${c.top}|${c.bottom}|${c.shoe}|${c.helmet}|${c.bike}`;
}

/** Compõe um quadro de sprite diretamente a partir de um `AvatarConfig`. */
export function avatarFrame(avatar: AvatarConfig, modality: Modality, facing: Facing, frame: number): Raster {
  return characterFrame(
    { hair: avatar.hair, colors: resolveCharacterColors(avatar.colors) },
    modality,
    facing,
    frame,
  );
}

function pickRandom<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/** Gera um avatar aleatório a partir das paletas curadas. */
export function randomAvatar(): AvatarConfig {
  return {
    hair: pickRandom(HAIR_STYLES).id,
    colors: {
      skin: pickRandom(AVATAR_SWATCHES.skin).color,
      hair: pickRandom(AVATAR_SWATCHES.hair).color,
      top: pickRandom(AVATAR_SWATCHES.top).color,
      bottom: pickRandom(AVATAR_SWATCHES.bottom).color,
      shoe: pickRandom(AVATAR_SWATCHES.shoe).color,
      helmet: pickRandom(AVATAR_SWATCHES.helmet).color,
      bike: pickRandom(AVATAR_SWATCHES.bike).color,
    },
  };
}
