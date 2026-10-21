// Tipos compartilhados pelas fontes de GPS (nativa e web).

/** Leitura crua do GPS; `speed`/`heading` null = desconhecido. */
export interface RawLocation {
  lng: number;
  lat: number;
  accuracy: number;
  speed: number | null;
  heading: number | null;
  t: number;
}

export interface GpsCallbacks {
  onLocation(loc: RawLocation): void;
  onStatus(status: 'searching' | 'denied' | 'unavailable'): void;
}
