// Tela acesa durante a gravação. Fica no nível do jogo (App.tsx) para valer em qualquer aba, inclusive Stats.
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

const KEEP_AWAKE_TAG = 'desbrava-gravacao';

/**
 * Tela acesa enquanto `active` (expo-keep-awake; na web é a Wake Lock API, como no original).
 * O navegador solta a trava quando a aba fica oculta: na web ela é pedida de novo ao voltar. No celular o
 * módulo nativo já religa sozinho ao voltar para o primeiro plano. As chamadas vão numa fila para o desligar
 * nunca passar na frente de um ligar pendente.
 */
export function useKeepAwakeWhile(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let queue: Promise<unknown> = Promise.resolve();
    const run = (fn: () => Promise<unknown>) => {
      queue = queue.then(fn).catch(() => undefined);
    };
    const acquire = (again: boolean) =>
      run(async () => {
        if (!alive) return;
        if (again) await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
        await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
      });
    acquire(false);
    const sub =
      Platform.OS === 'web' ? AppState.addEventListener('change', (st) => st === 'active' && acquire(true)) : null;
    return () => {
      alive = false;
      sub?.remove();
      run(() => deactivateKeepAwake(KEEP_AWAKE_TAG));
    };
  }, [active]);
}
