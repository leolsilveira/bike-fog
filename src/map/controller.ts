// Comandos de câmera para a interface, sem saber que o mapa vive numa WebView.
import { useSyncExternalStore } from 'react';
import { mapHost } from '../bridge/mapHost.ts';
import type { LngLat } from '../game/geo.ts';

let following = true;
const listeners = new Set<() => void>();

function setFollowing(v: boolean): void {
  if (following === v) return;
  following = v;
  listeners.forEach((fn) => fn());
}

mapHost.on('following', (m) => setFollowing(m.following));
mapHost.onConnect(() => setFollowing(true));

export const mapController = {
  get isFollowing(): boolean {
    return following;
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Volta a câmera para o jogador (no modo da aba atual). */
  recenter(): void {
    mapHost.send({ type: 'camera', action: 'recenter' });
  },
  /** Solta a câmera do jogador e mostra um ponto. */
  focus(p: LngLat): void {
    mapHost.send({ type: 'camera', action: 'focus', lng: p.lng, lat: p.lat });
  },
  zoomBy(delta: number): void {
    mapHost.send({ type: 'camera', action: 'zoomBy', delta });
  },
};

export function useFollowing(): boolean {
  return useSyncExternalStore(mapController.subscribe, () => following);
}
