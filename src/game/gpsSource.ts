// GPS do aparelho (expo-location): permissão em primeiro plano + watchPositionAsync de alta precisão.
import * as Location from 'expo-location';
import type { GpsCallbacks, RawLocation } from './gpsTypes.ts';

/** Converte o objeto do expo-location. No iOS, velocidade/rumo negativos significam "desconhecido". */
export function fromExpo(loc: Location.LocationObject): RawLocation {
  const c = loc.coords;
  const speed = c.speed != null && Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null;
  const heading = c.heading != null && Number.isFinite(c.heading) && c.heading >= 0 ? c.heading % 360 : null;
  return {
    lng: c.longitude,
    lat: c.latitude,
    accuracy: c.accuracy != null && c.accuracy >= 0 ? c.accuracy : 999,
    speed,
    heading,
    t: loc.timestamp || Date.now(),
  };
}

/**
 * Liga o GPS. Resolve com a função que desliga (ou null se não deu: o status já foi informado).
 * `ask` = pode mostrar o pedido de permissão (ao voltar dos Ajustes, só confere).
 */
export async function startWatch(cb: GpsCallbacks, ask = true): Promise<(() => void) | null> {
  try {
    let perm = await Location.getForegroundPermissionsAsync();
    if (!perm.granted && perm.canAskAgain && ask) perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) {
      cb.onStatus('denied');
      return null;
    }
    if (!(await Location.hasServicesEnabledAsync().catch(() => true))) {
      cb.onStatus('unavailable');
      return null;
    }
    cb.onStatus('searching');
    const sub = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 1000,
        distanceInterval: 0,
        mayShowUserSettingsDialog: true,
      },
      (loc) => cb.onLocation(fromExpo(loc)),
      (reason) => {
        console.warn('[gps]', reason);
        cb.onStatus('unavailable');
      },
    );
    return () => sub.remove();
  } catch (err) {
    console.warn('[gps] indisponível', String(err));
    cb.onStatus('unavailable');
    return null;
  }
}
