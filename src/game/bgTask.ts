// GPS em segundo plano durante a gravação (expo-task-manager + startLocationUpdatesAsync).
// `defineTask` precisa rodar no escopo global, na carga do bundle: este módulo é importado pelo index.ts da raiz.
// Não importa nada do jogo (evita ciclos): location.ts registra quem recebe as posições.
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

export const BG_LOCATION_TASK = 'desbrava-bg-location';

type Sink = (locations: Location.LocationObject[]) => void;

let sink: Sink | null = null;
let boot: (() => void) | null = null;
/** Posições que chegaram antes de o jogo iniciar (app aberto pelo sistema em segundo plano). */
const pending: Location.LocationObject[] = [];
const MAX_PENDING = 600;

TaskManager.defineTask<{ locations?: Location.LocationObject[] }>(BG_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('[gps-bg]', error.message);
    return;
  }
  const locations = data?.locations ?? [];
  if (!locations.length) return;
  if (sink) {
    sink(locations);
    return;
  }
  pending.push(...locations);
  if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
  boot?.();
});

/** Quem processa as posições (location.ts). Entrega o que estava guardado. */
export function setBackgroundSink(fn: Sink): void {
  sink = fn;
  if (pending.length) fn(pending.splice(0));
}

/** Como iniciar o jogo se uma posição chegar sem ele estar rodando (game/index.ts registra initGame). */
export function setBackgroundBoot(fn: () => void): void {
  boot = fn;
}

export interface BackgroundStart {
  /** A plataforma tem GPS em segundo plano (na web, não). */
  supported: boolean;
  /** As atualizações em segundo plano estão ligadas. */
  started: boolean;
  /** iOS: sem "Sempre". Grava com o app vivo em segundo plano, mas o iOS não o reabre se o fechar. */
  alwaysDenied: boolean;
}

/**
 * Liga as atualizações em segundo plano. Precisa ser chamado com o app em primeiro plano.
 * iOS: pede "Sempre" se `askAlways` (o próprio sistema só mostra o pedido uma vez).
 * Android: o serviço em primeiro plano (com notificação) dispensa a permissão de segundo plano,
 * que no Android 11+ só se dá nos Ajustes; por isso não pedimos.
 */
export async function startBackgroundLocation(askAlways: boolean): Promise<BackgroundStart> {
  if (Platform.OS === 'web') return { supported: false, started: false, alwaysDenied: false };
  let alwaysDenied = false;
  try {
    if (Platform.OS === 'ios') {
      let perm = await Location.getBackgroundPermissionsAsync();
      if (!perm.granted && perm.canAskAgain && askAlways) perm = await Location.requestBackgroundPermissionsAsync();
      alwaysDenied = !perm.granted;
    }
  } catch (err) {
    console.warn('[gps-bg] permissão', String(err));
  }
  try {
    if (!(await TaskManager.isAvailableAsync())) return { supported: true, started: false, alwaysDenied };
    if (await Location.hasStartedLocationUpdatesAsync(BG_LOCATION_TASK)) {
      return { supported: true, started: true, alwaysDenied };
    }
    await Location.startLocationUpdatesAsync(BG_LOCATION_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 1000,
      distanceInterval: 0,
      deferredUpdatesInterval: 0,
      deferredUpdatesDistance: 0,
      activityType: Location.ActivityType.Fitness,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'Desbrava está gravando sua atividade',
        notificationBody: 'Revelando a névoa e coletando moedas pelo caminho.',
        notificationColor: '#2a2445',
        killServiceOnDestroy: true,
      },
    });
    return { supported: true, started: true, alwaysDenied };
  } catch (err) {
    // Expo Go (sobretudo no Android), modo de fundo desligado no build etc.
    console.warn('[gps-bg] não deu para ligar', String(err));
    return { supported: true, started: false, alwaysDenied };
  }
}

export async function stopBackgroundLocation(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    if (await Location.hasStartedLocationUpdatesAsync(BG_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(BG_LOCATION_TASK);
    }
  } catch (err) {
    console.warn('[gps-bg] não deu para desligar', String(err));
  }
}
