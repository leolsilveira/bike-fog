// Na web não há GPS em segundo plano: mesmas funções, sem efeito.
import type { LocationObject } from 'expo-location';

export const BG_LOCATION_TASK = 'desbrava-bg-location';

export function hasPendingBackgroundLocations(): boolean {
  return false;
}

export function setBackgroundSink(_fn: (locations: LocationObject[]) => void | Promise<void>): void {}

export function setBackgroundBoot(_fn: () => void | Promise<void>): void {}

export interface BackgroundStart {
  supported: boolean;
  started: boolean;
  alwaysDenied: boolean;
}

export async function startBackgroundLocation(_askAlways: boolean): Promise<BackgroundStart> {
  return { supported: false, started: false, alwaysDenied: false };
}

export async function stopBackgroundLocation(): Promise<void> {}
