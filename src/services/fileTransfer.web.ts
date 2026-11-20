// Web: seletor de arquivos com leitura em streaming (blocos) e download de .zip pelo navegador.
export interface PickedActivityFile {
  name: string;
  size: number;
  readChunk(length: number): Promise<Uint8Array>;
  close(): void;
}

export function pickActivityFile(): Promise<PickedActivityFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,.gpx,.gz,application/zip,application/gpx+xml';
    let settled = false;
    const done = (val: PickedActivityFile | null) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) {
        done(null);
        return;
      }
      let offset = 0;
      done({
        name: f.name,
        size: f.size,
        async readChunk(length: number): Promise<Uint8Array> {
          if (offset >= f.size) return new Uint8Array(0);
          const slice = f.slice(offset, offset + length);
          offset += slice.size;
          return new Uint8Array(await slice.arrayBuffer());
        },
        close() {
          offset = f.size;
        },
      });
    };
    input.oncancel = () => done(null);
    input.click();
  });
}

export async function shareZip(fileName: string, bytes: Uint8Array): Promise<void> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const url = URL.createObjectURL(new Blob([copy], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
