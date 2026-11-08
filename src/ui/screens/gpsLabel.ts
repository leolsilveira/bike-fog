// Texto e cor do indicador de GPS (folha "Nova atividade" e tela da atividade).
import type { GpsStatus } from '../../game/types.ts';
import { C } from '../theme.ts';

export const GPS_LABEL: Record<GpsStatus, [string, string]> = {
  off: ['GPS desligado', C.coral],
  searching: ['Procurando GPS…', C.gold],
  ok: ['GPS ok', C.mint],
  weak: ['GPS fraco', C.gold],
  denied: ['GPS bloqueado', C.coral],
  unavailable: ['GPS indisponível', C.coral],
  sim: ['Simulador', C.violet],
};
