// Web: seletor de arquivos (.zip / .gpx) e download de .zip pelo navegador.
export interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

export function pickActivityFile(): Promise<PickedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,.gpx,.gz,application/zip,application/gpx+xml';
    let settled = false;
    const done = (val: PickedFile | null) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) {
        done(null);
        return;
      }
      const buf = await f.arrayBuffer();
      done({ name: f.name, bytes: new Uint8Array(buf) });
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
