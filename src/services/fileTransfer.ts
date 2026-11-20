// Celular: seletor de arquivos (.zip / .gpx) e compartilhamento de .zip.
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

export async function pickActivityFile(): Promise<PickedFile | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (res.canceled || !res.assets?.length) return null;
  const asset = res.assets[0];
  const file = new File(asset.uri);
  const bytes = await file.bytes();
  return { name: asset.name ?? 'atividades.zip', bytes };
}

export async function shareZip(fileName: string, bytes: Uint8Array): Promise<void> {
  const file = new File(Paths.cache, fileName);
  await file.write(bytes);
  if (!(await Sharing.isAvailableAsync())) throw new Error('compartilhamento indisponível');
  await Sharing.shareAsync(file.uri, {
    mimeType: 'application/zip',
    UTI: 'public.zip-archive',
    dialogTitle: 'Exportar atividades',
  });
}
