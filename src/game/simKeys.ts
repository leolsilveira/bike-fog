// Teclado do simulador (WASD/setas + Shift) só existe na web.
export interface KeyVector {
  x: number;
  y: number;
  turbo: boolean;
}

export function initSimKeys(_enabled: () => boolean, _onChange: (v: KeyVector) => void): void {}
