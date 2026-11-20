// Celular: seletor de arquivos com leitura em streaming (blocos) e compartilhamento de .zip.
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export interface PickedActivityFile {
  name: string;
  size: number;
  /** Lê o próximo bloco de até `length` bytes (vazio = fim do arquivo). */
  readChunk(length: number): Promise<Uint8Array>;
  close(): void;
}

export async function pickActivityFile(): Promise<PickedActivityFile | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (res.canceled || !res.assets?.length) return null;
  const asset = res.assets[0];
  const file = new File(asset.uri);
  const handle = file.open();
  const size = handle.size ?? asset.size ?? 0;
  let closed = false;
  return {
    name: asset.name ?? 'atividades.zip',
    size,
    async readChunk(length: number): Promise<Uint8Array> {
      if (closed) return new Uint8Array(0);
      return handle.readBytes(length);
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        handle.close();
      } catch {
        // ignora erro ao fechar
      }
    },
  };
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
