// Na web o Alert do react-native-web não faz nada; o confirm do navegador resolve.
export function showConfirm(title: string, message: string, _confirmLabel: string): Promise<boolean> {
  const text = message ? `${title}\n\n${message}` : title;
  try {
    return Promise.resolve(window.confirm(text));
  } catch {
    return Promise.resolve(false);
  }
}
