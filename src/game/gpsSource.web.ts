// GPS do navegador (Geolocation API), como na versão web original.
import type { LocationObject } from 'expo-location';
import type { GpsCallbacks, RawLocation } from './gpsTypes.ts';

export function fromExpo(loc: LocationObject): RawLocation {
  const c = loc.coords;
  return {
    lng: c.longitude,
    lat: c.latitude,
    accuracy: c.accuracy ?? 999,
    speed: c.speed != null && c.speed >= 0 ? c.speed : null,
    heading: c.heading != null && !Number.isNaN(c.heading) && c.heading >= 0 ? c.heading : null,
    t: loc.timestamp || Date.now(),
  };
}

export async function startWatch(cb: GpsCallbacks, _ask = true): Promise<(() => void) | null> {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    cb.onStatus('unavailable');
    return null;
  }
  cb.onStatus('searching');
  const id = navigator.geolocation.watchPosition(
    (pos) => {
      const c = pos.coords;
      cb.onLocation({
        lng: c.longitude,
        lat: c.latitude,
        accuracy: c.accuracy,
        speed: c.speed != null && c.speed >= 0 ? c.speed : null,
        heading: c.heading != null && !Number.isNaN(c.heading) ? c.heading : null,
        t: pos.timestamp || Date.now(),
      });
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        navigator.geolocation.clearWatch(id);
        cb.onStatus('denied');
      } else {
        cb.onStatus('unavailable');
      }
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}
