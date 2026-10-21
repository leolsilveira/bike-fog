// Sprites em pixel art como imagens nítidas (PNG gerado a partir dos rasters de src/sprites).
// Mesmas props do original (legacy Sprites.tsx), com `style` do RN no lugar de className/style CSS.
import { createElement, useEffect, useState } from 'react';
import { Image, Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { iconRaster, type IconName } from '../../sprites/icons.ts';
import {
  BADGE_H, BADGE_W, coinIcon, poiBadge, poiIcon, type BadgeState, type CoinKind, type PoiCategory,
} from '../../sprites/items.ts';
import {
  characterById, characterFrame, FRAME_H, FRAME_W, frameCount, type Facing, type Modality,
} from '../../sprites/characters.ts';
import type { Raster } from '../../sprites/pixel.ts';
import { rasterUri } from '../rasterImage.ts';
import { C } from '../theme.ts';

const isWeb = Platform.OS === 'web';

/** Estilo do <img> na web: ampliação por vizinho mais próximo, como `img.px` do CSS original. */
const WEB_IMG_STYLE = {
  display: 'block',
  width: '100%',
  height: '100%',
  imageRendering: 'pixelated',
  pointerEvents: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
} as const;

interface PixelImageProps {
  /** Chave de cache do raster (inclua tudo que muda a arte: nome, cores, estado...). */
  rasterKey: string;
  make: () => Raster;
  width: number;
  height: number;
  style?: StyleProp<ViewStyle>;
  /** Visível ou não (quadros empilhados da animação). */
  hidden?: boolean;
}

/**
 * Imagem de pixel art. Na web vira um <img> com `image-rendering: pixelated` (idêntico ao original);
 * no nativo, um Image com o PNG já ampliado por vizinho mais próximo (ver rasterImage.ts).
 */
export function PixelImage({ rasterKey, make, width, height, style, hidden }: PixelImageProps) {
  const uri = rasterUri(rasterKey, make, width);
  const visibility = hidden ? styles.hidden : null;
  if (isWeb) {
    return (
      <View style={[{ width, height }, styles.noTouch, style, visibility]}>
        {createElement('img', { src: uri, alt: '', draggable: false, style: WEB_IMG_STYLE })}
      </View>
    );
  }
  return (
    <View style={[{ width, height }, styles.noTouch, style, visibility]}>
      <Image
        source={{ uri }}
        style={styles.fill}
        resizeMode="stretch"
        resizeMethod="scale"
        fadeDuration={0}
      />
    </View>
  );
}

interface ImgProps {
  size?: number;
  style?: StyleProp<ViewStyle>;
}

/** Ícone de interface 12×12. `color` = cor principal ('x'), `accent` = destaque ('a', padrão dourado). */
export function Icon({ name, color = C.cream, accent, size = 20, style }: ImgProps & {
  name: IconName;
  color?: string;
  accent?: string;
}) {
  return (
    <PixelImage
      rasterKey={`icon:${name}:${color}:${accent ?? ''}`}
      make={() => iconRaster(name, color, accent)}
      width={size}
      height={size}
      style={style}
    />
  );
}

/** Moeda parada (10×10). */
export function CoinImg({ kind = 'gold', size = 20, style }: ImgProps & { kind?: CoinKind }) {
  return <PixelImage rasterKey={`coin:${kind}`} make={() => coinIcon(kind)} width={size} height={size} style={style} />;
}

/** Emblema de POI (20×26): `width` em pontos, altura proporcional. */
export function BadgeImg({ category, state = 'wild', width = 40, style }: {
  category: PoiCategory;
  state?: BadgeState;
  width?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <PixelImage
      rasterKey={`badge:${category}:${state}`}
      make={() => poiBadge(category, state)}
      width={width}
      height={Math.round((width * BADGE_H) / BADGE_W)}
      style={style}
    />
  );
}

/** Ícone da categoria de POI sozinho (12×12). */
export function PoiIconImg({ category, size = 24, style }: ImgProps & { category: PoiCategory }) {
  return (
    <PixelImage rasterKey={`poiicon:${category}`} make={() => poiIcon(category)} width={size} height={size} style={style} />
  );
}

/**
 * Personagem (24×30) animado. `width` em pontos (altura = width × 1,25); `animate` liga o ciclo de passos/pedaladas.
 * Todos os quadros ficam montados e empilhados; a animação só alterna a visibilidade, então a troca de quadro
 * não pisca (trocar o `source` de um Image recarrega e pode deixar um quadro em branco).
 */
export function CharacterSprite({
  characterId,
  modality,
  facing = 'down',
  animate = true,
  fps,
  width = 48,
  style,
}: {
  characterId: string;
  modality: Modality;
  facing?: Facing;
  animate?: boolean;
  fps?: number;
  width?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const n = animate ? frameCount(modality) : 1;
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!animate) return;
    const count = frameCount(modality);
    const id = setInterval(() => setFrame((f) => (f + 1) % count), 1000 / (fps ?? (modality === 'run' ? 8 : 6)));
    // volta ao primeiro quadro ao parar ou ao trocar de herói/pose
    return () => {
      clearInterval(id);
      setFrame(0);
    };
  }, [characterId, modality, facing, animate, fps]);

  const height = Math.round((width * FRAME_H) / FRAME_W);
  const def = characterById(characterId);
  const frames: number[] = animate ? Array.from({ length: n }, (_, i) => i) : [-1];
  const current = Math.min(frame, n - 1);
  return (
    <View style={[{ width, height }, styles.noTouch, style]}>
      {frames.map((f, i) => (
        <PixelImage
          key={f}
          rasterKey={`char:${def.id}:${modality}:${facing}:${f}`}
          make={() => characterFrame(def, modality, facing, f)}
          width={width}
          height={height}
          style={styles.stack}
          hidden={animate && i !== current}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { width: '100%', height: '100%' },
  stack: { position: 'absolute', left: 0, top: 0 },
  hidden: { opacity: 0 },
  noTouch: { pointerEvents: 'none' },
});
