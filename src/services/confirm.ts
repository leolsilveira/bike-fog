// Confirmação de ação destrutiva. Pode ser importado com ou sem extensão: a variante de plataforma
// fica em `confirmDialog` (Alert no celular, confirm do navegador na web).
import { showConfirm } from './confirmDialog';

export function confirmAsync(title: string, message: string, confirmLabel = 'Confirmar'): Promise<boolean> {
  return showConfirm(title, message, confirmLabel);
}
