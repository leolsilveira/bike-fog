// Diálogo nativo: Cancelar + ação destrutiva.
import { Alert } from 'react-native';

export function showConfirm(title: string, message: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    Alert.alert(
      title,
      message,
      [
        { text: 'Cancelar', style: 'cancel', onPress: () => finish(false) },
        { text: confirmLabel, style: 'destructive', onPress: () => finish(true) },
      ],
      // Android: tocar fora fecha o diálogo
      { cancelable: true, onDismiss: () => finish(false) },
    );
  });
}
