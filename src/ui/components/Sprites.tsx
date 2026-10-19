import { useEffect, useRef, type CSSProperties } from 'react';
import { iconRaster, type IconName } from '../../sprites/icons.ts';
import { coinIcon, poiBadge, poiIcon, type BadgeState, type CoinKind, type PoiCategory } from '../../sprites/items.ts';
import { frameCount, type Facing, type Modality } from '../../sprites/characters.ts';
import { cachedCharacterFrame, drawRaster, rasterUrl } from '../spriteCanvas.ts';

interface ImgProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
  alt?: string;
}

export function Icon({ name, color = '#fff6e0', accent, size = 20, className, style, alt = '' }: ImgProps & {
  name: IconName;
  color?: string;
  accent?: string;
}) {
  const src = rasterUrl(`icon:${name}:${color}:${accent ?? ''}`, () => iconRaster(name, color, accent));
  return <img className={`px ${className ?? ''}`} src={src} width={size} height={size} style={style} alt={alt} draggable={false} />;
}

export function CoinImg({ kind = 'gold', size = 20, className, style }: ImgProps & { kind?: CoinKind }) {
  const src = rasterUrl(`coin:${kind}`, () => coinIcon(kind));
  return <img className={`px ${className ?? ''}`} src={src} width={size} height={size} style={style} alt="" draggable={false} />;
}

export function BadgeImg({ category, state = 'wild', width = 40, className, style }: Omit<ImgProps, 'size'> & {
  category: PoiCategory;
  state?: BadgeState;
  width?: number;
}) {
  const src = rasterUrl(`badge:${category}:${state}`, () => poiBadge(category, state));
  return (
    <img className={`px ${className ?? ''}`} src={src} width={width} height={Math.round((width * 26) / 20)} style={style} alt="" draggable={false} />
  );
}

export function PoiIconImg({ category, size = 24, className }: ImgProps & { category: PoiCategory }) {
  const src = rasterUrl(`poiicon:${category}`, () => poiIcon(category));
  return <img className={`px ${className ?? ''}`} src={src} width={size} height={size} alt="" draggable={false} />;
}

/** Personagem animado (canvas). `animate` liga o ciclo de passos/pedaladas. */
export function CharacterSprite({
  characterId,
  modality,
  facing = 'down',
  animate = true,
  fps,
  className,
  style,
}: {
  characterId: string;
  modality: Modality;
  facing?: Facing;
  animate?: boolean;
  fps?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let frame = animate ? 0 : -1;
    drawRaster(canvas, cachedCharacterFrame(characterId, modality, facing, frame));
    if (!animate) return;
    const n = frameCount(modality);
    const id = setInterval(() => {
      frame = (frame + 1) % n;
      drawRaster(canvas, cachedCharacterFrame(characterId, modality, facing, frame));
    }, 1000 / (fps ?? (modality === 'run' ? 8 : 6)));
    return () => clearInterval(id);
  }, [characterId, modality, facing, animate, fps]);
  return <canvas ref={ref} className={`px ${className ?? ''}`} style={style} />;
}
