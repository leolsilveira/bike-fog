// Celular: grava o GPX no cache e abre a folha de compartilhar.
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export async function shareGpx(fileName: string, gpx: string): Promise<void> {
  const file = new File(Paths.cache, fileName);
  await file.write(gpx);
  if (!(await Sharing.isAvailableAsync())) throw new Error('compartilhamento indisponível');
  await Sharing.shareAsync(file.uri, {
    mimeType: 'application/gpx+xml',
    UTI: 'com.topografix.gpx',
    dialogTitle: 'Exportar GPX',
  });
}
