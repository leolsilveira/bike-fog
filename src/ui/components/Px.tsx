// Primitivas visuais "pixel" (port fiel das classes de global.css do original).
//
// Contorno pixelado: o CSS desenhava a borda com 4 box-shadows deslocados 3px (cima, baixo, esquerda, direita),
// o que deixa os 4 cantos vazados. Aqui são 4 Views absolutas FORA da caixa (não ocupam layout, como o
// box-shadow), com os cantos vazados. Os "inset" (brilho em cima, sombra embaixo) são faixas absolutas por
// baixo do conteúdo, e a sombra "de chão" (0 9px) é uma faixa de 6px abaixo do contorno.
// Por isso a caixa não pode ter `overflow: 'hidden'` (cortaria o contorno).
//
// Texto: o CSS herdava cor/tamanho/peso do pai; no RN isso vem de um contexto (TextStyleProvider). Txt e Arcade
// leem o contexto, e PxBox/PxButton/Chip o definem, então <PxButton><Txt>Oi</Txt></PxButton> já sai em
// negrito 16px na cor da variante. Strings soltas dentro dessas caixas viram <Txt> automaticamente.
import {
  Children, createContext, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import {
  Animated, Platform, Pressable, StyleSheet, Text, View, type StyleProp, type TextProps, type TextStyle,
  type ViewProps, type ViewStyle,
} from 'react-native';
import { C, FONT, grayscaleBrightness, M, uiFont, type Weight } from '../theme.ts';

const isWeb = Platform.OS === 'web';

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------

/** Estilo de texto herdado (equivalente à herança de `color`, `font-size`, `font-weight`... do CSS). */
export interface InheritedText {
  color: string;
  size: number;
  weight: Weight;
  /** letter-spacing em pixels (o CSS herda o valor já calculado). */
  spacingPx: number;
  upper: boolean;
  /** line-height como fator do tamanho (body: 1,35). */
  lh: number;
  align?: TextStyle['textAlign'];
}

const DEFAULT_TEXT: InheritedText = {
  color: C.cream,
  size: M.fontSize,
  weight: 400,
  spacingPx: 0,
  upper: false,
  lh: M.lineHeight,
};

const TextCtx = createContext<InheritedText>(DEFAULT_TEXT);

export interface TextOverrides {
  color?: string;
  size?: number;
  weight?: Weight;
  /** letter-spacing em em (ex.: 0.04 = 0.04em). */
  spacing?: number;
  upper?: boolean;
  lh?: number;
  align?: TextStyle['textAlign'];
}

function applyOverrides(base: InheritedText, o: TextOverrides): InheritedText {
  const size = o.size ?? base.size;
  return {
    color: o.color ?? base.color,
    size,
    weight: o.weight ?? base.weight,
    spacingPx: o.spacing != null ? o.spacing * size : base.spacingPx,
    upper: o.upper ?? base.upper,
    lh: o.lh ?? base.lh,
    align: o.align ?? base.align,
  };
}

/** Define o estilo de texto herdado pelos Txt/Arcade de dentro (como `color`/`font-*` num div do CSS). */
export function TextStyleProvider({ children, ...o }: TextOverrides & { children?: ReactNode }) {
  const parent = useContext(TextCtx);
  const { color, size, weight, spacing, upper, lh, align } = o;
  const value = useMemo(
    () => applyOverrides(parent, { color, size, weight, spacing, upper, lh, align }),
    [parent, color, size, weight, spacing, upper, lh, align],
  );
  return <TextCtx.Provider value={value}>{children}</TextCtx.Provider>;
}

export function useInheritedText(): InheritedText {
  return useContext(TextCtx);
}

/** Sombra de texto dura (sem blur por padrão), ex.: `{ y: 2 }` = `text-shadow: 0 2px 0 var(--ink)`. */
export interface TextShadow {
  x?: number;
  y: number;
  blur?: number;
  color?: string;
}

export interface TxtProps extends TextProps, TextOverrides {
  shadow?: TextShadow;
  /** Só na web: `text-shadow` CSS completo (várias sombras), no lugar de `shadow`. */
  webShadow?: string;
  children?: ReactNode;
}

function shadowStyle(s: TextShadow | undefined): TextStyle | null {
  if (!s) return null;
  return {
    textShadowColor: s.color ?? C.ink,
    textShadowOffset: { width: s.x ?? 0, height: s.y },
    // no Android, raio 0 desliga a sombra (Paint.setShadowLayer); um raio mínimo a mantém dura
    textShadowRadius: Platform.OS === 'android' ? Math.max(s.blur ?? 0, 0.1) : (s.blur ?? 0),
  };
}

function textBase(t: InheritedText, family: string): TextStyle {
  return {
    fontFamily: family,
    color: t.color,
    fontSize: t.size,
    lineHeight: t.size * t.lh,
    letterSpacing: t.spacingPx,
    textTransform: t.upper ? 'uppercase' : 'none',
    textAlign: t.align,
    ...(Platform.OS === 'android' ? { includeFontPadding: false } : null),
  };
}

/**
 * Texto do corpo (Pixelify Sans). Herda cor/tamanho/peso do contexto; props sobrescrevem.
 * Ex.: <Txt size={15} weight={700} numberOfLines={1}>{nome}</Txt>
 */
export function Txt({
  color, size, weight, spacing, upper, lh, align, shadow, webShadow, style, children, ...rest
}: TxtProps) {
  const t = applyOverrides(useContext(TextCtx), { color, size, weight, spacing, upper, lh, align });
  const web = isWeb && webShadow ? ({ textShadow: webShadow } as TextStyle) : null;
  return (
    <TextCtx.Provider value={t}>
      <Text selectable={false} {...rest} style={[textBase(t, uiFont(t.weight)), shadowStyle(shadow), web, style]}>
        {children}
      </Text>
    </TextCtx.Provider>
  );
}

/** Txt na cor --muted (classe .muted). */
export function Muted(props: TxtProps) {
  return <Txt color={C.muted} {...props} />;
}

/**
 * Press Start 2P (classe .arcade: letter-spacing 0.02em). Herda tamanho/cor do contexto.
 * Peso ≥ 600 (herdado de um PxButton, ou `weight={700}` em títulos que eram h1/h2/h3 no original) reproduz o
 * negrito sintético que o navegador aplicava: web/Android engrossam a fonte; no iOS, uma sombra de ~0,6px.
 * Para textos que só usavam `font-family: var(--font-arcade)` (sem a classe), passe `spacing={0}`.
 */
export function Arcade({
  color, size, weight, spacing = 0.02, upper, lh, align, shadow, webShadow, style, children, ...rest
}: TxtProps) {
  const t = applyOverrides(useContext(TextCtx), { color, size, weight, spacing, upper, lh, align });
  const bold = t.weight >= 600;
  let boldStyle: TextStyle | null = null;
  if (bold) {
    if (Platform.OS === 'ios') {
      boldStyle = shadow
        ? null
        : { textShadowColor: t.color, textShadowOffset: { width: Math.max(0.5, t.size * 0.039), height: 0 }, textShadowRadius: 0 };
    } else {
      boldStyle = { fontWeight: '700' };
    }
  }
  const web = isWeb && webShadow ? ({ textShadow: webShadow } as TextStyle) : null;
  return (
    <TextCtx.Provider value={t}>
      <Text selectable={false} {...rest} style={[textBase(t, FONT.arcade), boldStyle, shadowStyle(shadow), web, style]}>
        {children}
      </Text>
    </TextCtx.Provider>
  );
}

/** `.hint`: texto 13px creme centralizado com sombra, por cima do mapa. */
export function Hint({ style, ...props }: TxtProps) {
  return (
    <Txt
      size={13}
      color={C.cream}
      align="center"
      shadow={{ y: 2 }}
      webShadow="0 2px 0 #1d1730, 0 0 6px rgba(29, 23, 48, 0.8)"
      style={[{ maxWidth: 320 }, style]}
      {...props}
    />
  );
}

/**
 * Embrulha strings/números soltos em <Txt> (no RN, texto fora de <Text> quebra no nativo).
 * Textos vizinhos viram um só (como um "anonymous flex item" do CSS) e as pontas são aparadas.
 */
export function textify(children: ReactNode, textProps?: TextProps): ReactNode[] {
  const out: ReactNode[] = [];
  let run: string[] = [];
  const flush = () => {
    if (!run.length) return;
    const s = run.join('').replace(/\s+/g, ' ').trim();
    if (s) {
      out.push(
        <Txt key={`txt${out.length}`} {...textProps}>
          {s}
        </Txt>,
      );
    }
    run = [];
  };
  for (const c of Children.toArray(children)) {
    if (typeof c === 'string' || typeof c === 'number') run.push(String(c));
    else {
      flush();
      out.push(c);
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Contorno e faixas internas (o "box-shadow" do CSS)
// ---------------------------------------------------------------------------

interface OutlineProps {
  /** Espessura (--px = 3; chips = 2). */
  w?: number;
  color?: string;
}

/** Contorno de 4 lados por fora da caixa, cantos vazados. Coloque como filho de uma View sem overflow hidden. */
export function PxOutline({ w = M.px, color = C.ink }: OutlineProps) {
  return (
    <>
      <View style={[styles.abs, { left: 0, right: 0, top: -w, height: w, backgroundColor: color }]} />
      <View style={[styles.abs, { left: 0, right: 0, bottom: -w, height: w, backgroundColor: color }]} />
      <View style={[styles.abs, { top: 0, bottom: 0, left: -w, width: w, backgroundColor: color }]} />
      <View style={[styles.abs, { top: 0, bottom: 0, right: -w, width: w, backgroundColor: color }]} />
    </>
  );
}

/** Faixa interna (inset box-shadow sem blur): `top` ou `bottom`, com `h` de altura. */
export function Inset({ side, h, color }: { side: 'top' | 'bottom'; h: number; color: string }) {
  return <View style={[styles.abs, { left: 0, right: 0, [side]: 0, height: h, backgroundColor: color }]} />;
}

// ---------------------------------------------------------------------------
// PxBox (.px-box / .px-box.light)
// ---------------------------------------------------------------------------

export interface PxBoxProps extends ViewProps {
  /** `.px-box.light`: fundo creme e texto escuro. */
  light?: boolean;
  /** Fundo no lugar de --panel (ex.: toast de cidade em --mint, aviso em --coral). */
  bg?: string;
  /** Cor de texto herdada pelos filhos (CSS `color`). */
  color?: string;
  /** Sombra "de chão" abaixo da caixa (padrão: sim). */
  drop?: boolean;
  /** Cor do contorno (padrão --ink). */
  outline?: string;
  children?: ReactNode;
}

/**
 * Painel escuro com contorno pixelado, brilho em cima, sombra embaixo e sombra de chão.
 * Ex.: <PxBox style={{ padding: 12 }}><Txt>Olá</Txt></PxBox> · <PxBox light>…</PxBox>
 */
export function PxBox({ light, bg, color, drop = true, outline = C.ink, style, children, ...rest }: PxBoxProps) {
  const textColor = color ?? (light ? C.ink : undefined);
  const content = textify(children);
  return (
    <View {...rest} style={[{ backgroundColor: bg ?? (light ? C.cream : C.panel) }, style]}>
      {drop && <View style={[styles.abs, styles.drop]} />}
      <Inset side="top" h={M.px} color={light ? C.white : 'rgba(255, 255, 255, 0.09)'} />
      <Inset side="bottom" h={M.px} color={light ? C.cream2 : 'rgba(0, 0, 0, 0.28)'} />
      <PxOutline color={outline} />
      {textColor ? <TextStyleProvider color={textColor}>{content}</TextStyleProvider> : content}
    </View>
  );
}

// ---------------------------------------------------------------------------
// PxButton (.px-btn)
// ---------------------------------------------------------------------------

export type ButtonVariant = 'default' | 'gold' | 'mint' | 'coral' | 'sky' | 'cream' | 'ghost';
export type ButtonSize = 'normal' | 'small' | 'round';

const VARIANTS: Record<ButtonVariant, { face: string; edge: string; text: string }> = {
  default: { face: C.panel3, edge: C.panel, text: C.cream },
  gold: { face: C.gold, edge: C.goldDark, text: C.ink },
  mint: { face: C.mint, edge: C.mintDark, text: C.ink },
  coral: { face: C.coral, edge: C.coralDark, text: C.cream },
  sky: { face: C.sky, edge: C.skyDark, text: C.ink },
  cream: { face: C.cream, edge: C.cream2, text: C.ink },
  ghost: { face: 'rgba(42, 36, 69, 0.85)', edge: 'rgba(20, 14, 40, 0.6)', text: C.cream },
};

const SIZES: Record<ButtonSize, { pt: number; pb: number; ph: number; font: number }> = {
  normal: { pt: 10, pb: 13, ph: 16, font: 16 },
  small: { pt: 6, pb: 9, ph: 10, font: 14 },
  round: { pt: 10, pb: 10, ph: 10, font: 16 },
};

export interface PxButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** `.block`: largura 100%. */
  block?: boolean;
  disabled?: boolean;
  /** Força o estado afundado (`.pressed`). */
  pressed?: boolean;
  onPress?: () => void;
  /** Tamanho do texto (ex.: 20 no botão INICIAR); o padrão vem de `size`. */
  fontSize?: number;
  /** Rótulo de acessibilidade (o `aria-label` do original). */
  label?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

/**
 * Botão pixel com borda inferior que "afunda" ao toque. Conteúdo em linha, centralizado, com gap 8.
 * Padding pode ser trocado por `style` (padding/paddingVertical/paddingTop... funcionam como no CSS).
 * Como no CSS (inline-flex), a largura acompanha o conteúdo se o pai não esticar (alignItems ≠ 'stretch');
 * use `block` para 100%.
 * Ex.: <PxButton variant="gold" onPress={start}><Icon name="play" size={28} color={C.ink} /><Arcade>INICIAR</Arcade></PxButton>
 */
export function PxButton({
  variant = 'default', size = 'normal', block, disabled, pressed: forcePressed, onPress, fontSize, label, testID, style,
  children,
}: PxButtonProps) {
  const v = VARIANTS[variant];
  const sz = SIZES[size];
  const { padding, rest: userStyle } = splitPadding(style, { pt: sz.pt, pb: sz.pb, pl: sz.ph, pr: sz.ph });
  // `filter: grayscale(0.7) brightness(0.8)` do :disabled. Na web vai o filtro de verdade; no nativo, as cores.
  const dim = (c: string) => (disabled && !isWeb ? grayscaleBrightness(c, 0.7, 0.8) : c);
  const face = dim(v.face);
  const edge = dim(v.edge);
  const ink = dim(C.ink);
  const text = dim(v.text);
  const font = fontSize ?? sz.font;
  const content = textify(children);
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      testID={testID}
      style={({ pressed }) => [
        styles.btn,
        padding,
        { backgroundColor: face },
        block && styles.block,
        (pressed || forcePressed) && !disabled && styles.btnPressed,
        disabled && isWeb && styles.btnDisabledWeb,
        userStyle,
      ]}
    >
      {({ pressed }) => {
        const down = (pressed || !!forcePressed) && !disabled;
        return (
          <>
            {down ? (
              <Inset side="top" h={M.px} color={edge} />
            ) : (
              <>
                <Inset side="bottom" h={M.px * 1.4} color={edge} />
                <Inset side="top" h={M.px} color="rgba(255, 255, 255, 0.25)" />
              </>
            )}
            <PxOutline color={ink} />
            <TextStyleProvider color={text} size={font} weight={700} spacing={0.02}>
              {content}
            </TextStyleProvider>
          </>
        );
      }}
    </Pressable>
  );
}

type Pad = { pt: number; pb: number; pl: number; pr: number };

/** Resolve padding como no CSS (o que vier do usuário vence o padrão, inclusive o atalho `padding`). */
function splitPadding(style: StyleProp<ViewStyle>, def: Pad): { padding: ViewStyle; rest: ViewStyle } {
  const flat = { ...(StyleSheet.flatten(style) ?? {}) } as ViewStyle & Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  let { pt, pb, pl, pr } = def;
  const all = num(flat.padding);
  if (all != null) pt = pb = pl = pr = all;
  const pv = num(flat.paddingVertical);
  if (pv != null) pt = pb = pv;
  const ph = num(flat.paddingHorizontal);
  if (ph != null) pl = pr = ph;
  pt = num(flat.paddingTop) ?? pt;
  pb = num(flat.paddingBottom) ?? pb;
  pl = num(flat.paddingLeft) ?? num(flat.paddingStart) ?? pl;
  pr = num(flat.paddingRight) ?? num(flat.paddingEnd) ?? pr;
  for (const k of ['padding', 'paddingVertical', 'paddingHorizontal', 'paddingTop', 'paddingBottom', 'paddingLeft',
    'paddingRight', 'paddingStart', 'paddingEnd']) delete flat[k];
  return { padding: { paddingTop: pt, paddingBottom: pb, paddingLeft: pl, paddingRight: pr }, rest: flat };
}

// ---------------------------------------------------------------------------
// Chip (.chip), Bar (.bar), RarityTag (.rarity-tag), PxCell
// ---------------------------------------------------------------------------

export interface ChipProps extends ViewProps {
  /** Cor do texto (ex.: C.muted para `.chip.muted`). */
  color?: string;
  /** Quadradinho 8×8 de status (`.status-pill .dot`): C.mint ok, C.gold aviso, C.coral erro, C.violet simulador. */
  dot?: string;
  children?: ReactNode;
}

/**
 * Etiqueta escura com contorno de 2px: 14px, peso 600. Ex.: <Chip><CoinImg size={16} /> {n}</Chip>
 * Não quebra linha (white-space: nowrap); textos longos devem limitar o espaço por fora.
 */
export function Chip({ color, dot, style, children, ...rest }: ChipProps) {
  return (
    <View {...rest} style={[styles.chip, style]}>
      <Inset side="top" h={2} color="rgba(255, 255, 255, 0.08)" />
      <PxOutline w={2} />
      {dot && <View style={[styles.dot, { backgroundColor: dot }]} />}
      <TextStyleProvider color={color ?? C.cream} size={14} weight={600}>
        {textify(children, { numberOfLines: 1 })}
      </TextStyleProvider>
    </View>
  );
}

export type BarVariant = 'gold' | 'mint' | 'sky';
const BAR_COLORS: Record<BarVariant, [string, string]> = {
  gold: [C.gold, C.goldDark],
  mint: [C.mint, C.mintDark],
  sky: [C.sky, C.skyDark],
};

/**
 * Barra de progresso (`.bar`): fundo --ink, preenchimento em dois tons (55% claro / 45% escuro), anima a
 * largura em 400ms. `percent` de 0 a 100. Ex.: <Bar percent={62} variant="mint" height={14} />
 */
export function Bar({ percent, variant = 'gold', height = 12, style }: {
  percent: number;
  variant?: BarVariant;
  height?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const p = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const [anim] = useState(() => new Animated.Value(p));
  useEffect(() => {
    const a = Animated.timing(anim, { toValue: p, duration: 400, useNativeDriver: false });
    a.start();
    return () => a.stop();
  }, [p, anim]);
  const [light, dark] = BAR_COLORS[variant];
  const width = anim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] });
  return (
    <View style={[styles.bar, { height }, style]}>
      <Inset side="top" h={2} color="rgba(0, 0, 0, 0.4)" />
      <Animated.View style={[styles.barFill, { width }]}>
        <View style={{ flex: 55, backgroundColor: light }} />
        <View style={{ flex: 45, backgroundColor: dark }} />
      </Animated.View>
    </View>
  );
}

/** `.rarity-tag`: faixa colorida com texto escuro em caixa alta. Ex.: <RarityTag color={r.color}>{r.label}</RarityTag> */
export function RarityTag({ color, children, style }: { color: string; children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.rarity, { backgroundColor: color }, style]}>
      <Txt size={13} weight={700} color={C.ink} upper spacing={0.08}>
        {children}
      </Txt>
    </View>
  );
}

/**
 * Célula clara de lista/grade (`.nearby-item`, `.dex-cell`, `.list-item`, `.char-cell`, `.summary-grid > div`):
 * fundo --panel-2 com sombra interna embaixo. `selected` = moldura dourada de 3px (`.char-cell.selected`).
 * Com `onPress` vira Pressable.
 */
export function PxCell({ selected, onPress, style, children, testID }: {
  selected?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  testID?: string;
}) {
  const deco = selected ? (
    <View style={[styles.abs, styles.fill, styles.selected]} />
  ) : (
    <Inset side="bottom" h={3} color="rgba(0, 0, 0, 0.25)" />
  );
  const content = textify(children);
  if (onPress) {
    return (
      <Pressable onPress={onPress} testID={testID} style={[styles.cell, style]}>
        {deco}
        {content}
      </Pressable>
    );
  }
  return (
    <View testID={testID} style={[styles.cell, style]}>
      {deco}
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  abs: { position: 'absolute', pointerEvents: 'none' },
  fill: { left: 0, right: 0, top: 0, bottom: 0 },
  drop: { left: 0, right: 0, bottom: -9, height: 6, backgroundColor: C.dropShadow },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  btnPressed: { transform: [{ translateY: 2 }] },
  // `cursor: not-allowed` só existe na web (o tipo do RN não aceita)
  btnDisabledWeb: { filter: 'grayscale(0.7) brightness(0.8)', cursor: 'not-allowed' } as unknown as ViewStyle,
  block: { alignSelf: 'stretch', width: '100%' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: 4,
    paddingBottom: 5,
    paddingHorizontal: 9,
    backgroundColor: C.chipBg,
  },
  dot: { width: 8, height: 8 },
  bar: { backgroundColor: C.ink, overflow: 'hidden' },
  barFill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  rarity: { paddingTop: 3, paddingBottom: 4, paddingHorizontal: 10 },
  cell: { backgroundColor: C.panel2 },
  selected: { borderWidth: 3, borderColor: C.gold },
});
