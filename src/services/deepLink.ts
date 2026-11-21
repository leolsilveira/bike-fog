// Captura deep links e links web de convite (`desbrava://add/<username>`, `?add=<username>`).
import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
import { useGame } from '../game/store.ts';
import { parseInviteUsername } from './deepLinkCore.ts';

export { parseInviteUsername };

function handleIncomingUrl(url: string | null | undefined): void {
  const username = parseInviteUsername(url);
  if (!username) return;

  const store = useGame.getState();
  if (store.pendingInviteUsername === username) return;

  store.setPendingInviteUsername(username);
  if (store.authUserId) {
    store.toast(`Convite de @${username} recebido!`, 'info');
  } else {
    store.toast(`Convite de @${username} salvo! Entre para adicionar.`, 'info');
  }
}

export function initDeepLinks(): () => void {
  void Linking.getInitialURL()
    .then((initialUrl) => {
      if (initialUrl) {
        handleIncomingUrl(initialUrl);
      } else if (Platform.OS === 'web' && typeof window !== 'undefined') {
        handleIncomingUrl(window.location.href);
      }
    })
    .catch(() => undefined);

  const sub = Linking.addEventListener('url', ({ url }) => {
    handleIncomingUrl(url);
  });

  return () => {
    sub.remove();
  };
}
