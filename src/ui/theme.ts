// Design system do Desbrava: cores, fontes e medidas do CSS original (:root de global.css).
// Importa só os pesos usados (o índice do pacote puxaria também o 500).
import { PixelifySans_400Regular } from '@expo-google-fonts/pixelify-sans/400Regular';
import { PixelifySans_600SemiBold } from '@expo-google-fonts/pixelify-sans/600SemiBold';
import { PixelifySans_700Bold } from '@expo-google-fonts/pixelify-sans/700Bold';
import { PressStart2P_400Regular } from '@expo-google-fonts/press-start-2p/400Regular';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Paleta (variáveis CSS do original). */
export const C = {
  ink: '#1d1730',
  panel: '#2a2445',
  panel2: '#352d58',
  panel3: '#463c72',
  line: '#5b4f8f',
  cream: '#fff6e0',
  cream2: '#f1e3bf',
  muted: '#b8afd9',
  gold: '#ffc63d',
  goldDark: '#b8740f',
  mint: '#3fd3a0',
  mintDark: '#1d8a68',
  coral: '#ff6b5a',
  coralDark: '#b83a2f',
  sky: '#79c3ff',
  skyDark: '#2f7fc0',
  violet: '#8f7cff',
  white: '#ffffff',
  /** Sombra "de chão" das caixas (0 9px 0 rgba(20,14,40,.35)). */
  dropShadow: 'rgba(20, 14, 40, 0.35)',
  /** Fundo dos modais. */
  backdrop: 'rgba(20, 14, 40, 0.7)',
  /** Fundo translúcido de chips. */
  chipBg: 'rgba(29, 23, 48, 0.82)',
  /** Cor secundária dos ícones inativos da barra de abas. */
  iconMuted: '#8f86c9',
} as const;

/** Pesos da Pixelify Sans usados no CSS original. */
export type Weight = 400 | 600 | 700;

/**
 * Famílias carregadas pelo expo-font. Uma família por peso: no Android o `fontWeight` não troca o arquivo de
 * uma fonte custom, e na web o peso extra faria o navegador engrossar (negrito sintético) uma fonte já bold.
 */
export const FONT = {
  ui400: 'PixelifySans_400Regular',
  ui600: 'PixelifySans_600SemiBold',
  ui700: 'PixelifySans_700Bold',
  arcade: 'PressStart2P_400Regular',
} as const;

/** Mapa para `useFonts` (App.tsx). */
export const FONT_SOURCES = {
  [FONT.ui400]: PixelifySans_400Regular,
  [FONT.ui600]: PixelifySans_600SemiBold,
  [FONT.ui700]: PixelifySans_700Bold,
  [FONT.arcade]: PressStart2P_400Regular,
};

export function uiFont(weight: Weight = 400): string {
  return weight >= 700 ? FONT.ui700 : weight >= 600 ? FONT.ui600 : FONT.ui400;
}

/** Medidas recorrentes do CSS. */
export const M = {
  /** --px: espessura do contorno "pixel" das caixas e botões. */
  px: 3,
  /** --tabbar-h (sem a área segura de baixo). */
  tabbarH: 76,
  /** line-height do body. */
  lineHeight: 1.35,
  /** Tamanho de fonte do body. */
  fontSize: 16,
  /** Margem lateral do HUD (left/right: 12px). */
  gutter: 12,
} as const;

/** `position: absolute; inset: 0` (no lugar do StyleSheet.absoluteFillObject, que saiu do RN 0.88). */
export const FILL = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } as const;

/** Áreas seguras como no CSS (--safe-t/--safe-b) e a altura total da barra de abas. */
export function useSafe(): { safeT: number; safeB: number; tabbarH: number } {
  const insets = useSafeAreaInsets();
  return { safeT: insets.top, safeB: insets.bottom, tabbarH: M.tabbarH + insets.bottom };
}

/** Mistura duas cores '#rrggbb' (t = 0 → a, 1 → b). */
export function mix(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  const f = (i: number) => Math.round(pa[i] + (pb[i] - pa[i]) * t).toString(16).padStart(2, '0');
  return `#${f(0)}${f(1)}${f(2)}`;
}

/** Equivalente ao `filter: brightness(k)` aplicado a uma cor. */
export function brighten(hex: string, k: number): string {
  const p = parseHex(hex);
  const f = (v: number) => Math.min(255, Math.round(v * k)).toString(16).padStart(2, '0');
  return `#${f(p[0])}${f(p[1])}${f(p[2])}`;
}

/** Equivalente a `filter: grayscale(g) brightness(b)` numa cor '#rrggbb' ou 'rgba()'. */
export function grayscaleBrightness(color: string, g: number, b: number): string {
  const [r0, g0, b0, a] = parseColor(color);
  // matriz de grayscale do CSS Filter Effects
  const r1 = (0.2126 + 0.7874 * (1 - g)) * r0 + (0.7152 - 0.7152 * (1 - g)) * g0 + (0.0722 - 0.0722 * (1 - g)) * b0;
  const g1 = (0.2126 - 0.2126 * (1 - g)) * r0 + (0.7152 + 0.2848 * (1 - g)) * g0 + (0.0722 - 0.0722 * (1 - g)) * b0;
  const b1 = (0.2126 - 0.2126 * (1 - g)) * r0 + (0.7152 - 0.7152 * (1 - g)) * g0 + (0.0722 + 0.9278 * (1 - g)) * b0;
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * b)));
  return `rgba(${c(r1)}, ${c(g1)}, ${c(b1)}, ${a})`;
}

function parseHex(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function parseColor(color: string): [number, number, number, number] {
  const m = /^rgba?\(([^)]+)\)$/.exec(color.trim());
  if (m) {
    const parts = m[1].split(',').map((s) => parseFloat(s));
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }
  const [r, g, b] = parseHex(color);
  return [r, g, b, 1];
}
