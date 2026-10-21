// Teclado do simulador na web: WASD/setas movem, Shift é turbo (a física roda no mapa).
import type { KeyVector } from './simKeys.ts';

const KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', 'Shift'];

export type { KeyVector };

export function initSimKeys(enabled: () => boolean, onChange: (v: KeyVector) => void): void {
  if (typeof window === 'undefined') return;
  const down = new Set<string>();
  let turbo = false;
  const emit = () => {
    const x = (down.has('ArrowRight') || down.has('d') ? 1 : 0) - (down.has('ArrowLeft') || down.has('a') ? 1 : 0);
    const y = (down.has('ArrowUp') || down.has('w') ? 1 : 0) - (down.has('ArrowDown') || down.has('s') ? 1 : 0);
    onChange({ x, y, turbo });
  };
  const onKey = (e: KeyboardEvent) => {
    if (!enabled()) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!KEYS.includes(key)) return;
    e.preventDefault();
    if (key === 'Shift') turbo = e.type === 'keydown';
    else if (e.type === 'keydown') {
      if (down.has(key)) return; // repetição automática da tecla
      down.add(key);
    } else down.delete(key);
    emit();
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', () => {
    if (!down.size && !turbo) return;
    down.clear();
    turbo = false;
    emit();
  });
}
