// Armazenamento nativo: um arquivo por chave em Documents/desbrava (entra no backup do aparelho).
// Escrita atômica: grava `<nome>.tmp` e renomeia por cima; um save interrompido nunca corrompe o anterior.
import { Directory, File, Paths } from 'expo-file-system';
import { safeFileName } from './fileName.ts';
import type { KvStorage } from './storage.types.ts';

const DIR_NAME = 'desbrava';
const JSON_EXT = '.json';
const BIN_EXT = '.bin';
const TMP_EXT = '.tmp';

let dir: Directory | null = null;

function root(): Directory {
  if (!dir) {
    const d = new Directory(Paths.document, DIR_NAME);
    if (!d.exists) d.create({ intermediates: true, idempotent: true });
    dir = d;
  }
  return dir;
}

/** Operações na mesma chave rodam em fila (duas escritas simultâneas no mesmo .tmp se embaralhariam). */
const queues = new Map<string, Promise<unknown>>();

function serial<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(job, job);
  const tail = next.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}

async function writeAtomic(name: string, content: string | Uint8Array): Promise<void> {
  const d = root();
  const tmp = new File(d, name + TMP_EXT);
  await tmp.write(content);
  await tmp.move(new File(d, name), { overwrite: true });
}

/**
 * Lê o arquivo principal; se ele faltar ou estiver ilegível, tenta o `.tmp`
 * (o app pode ter sido morto entre apagar o antigo e renomear o novo).
 */
async function readFirst<T>(name: string, read: (f: File) => Promise<T>): Promise<T | undefined> {
  const d = root();
  for (const f of [new File(d, name), new File(d, name + TMP_EXT)]) {
    if (!f.exists) continue;
    try {
      return await read(f);
    } catch (err) {
      console.warn('[storage] leitura falhou', f.name, err);
    }
  }
  return undefined;
}

function deleteIfExists(f: File): void {
  try {
    if (f.exists) f.delete();
  } catch (err) {
    console.warn('[storage] não consegui apagar', f.name, err);
  }
}

export const storage: KvStorage = {
  getJson<T>(key: string): Promise<T | undefined> {
    const name = safeFileName(key) + JSON_EXT;
    return serial(key, () => readFirst(name, async (f) => JSON.parse(await f.text()) as T));
  },

  setJson(key: string, value: unknown): Promise<void> {
    const name = safeFileName(key) + JSON_EXT;
    return serial(key, () => writeAtomic(name, JSON.stringify(value)));
  },

  getBytes(key: string): Promise<Uint8Array | undefined> {
    const name = safeFileName(key) + BIN_EXT;
    return serial(key, () => readFirst(name, (f) => f.bytes()));
  },

  setBytes(key: string, bytes: Uint8Array): Promise<void> {
    const name = safeFileName(key) + BIN_EXT;
    return serial(key, () => writeAtomic(name, bytes));
  },

  remove(key: string): Promise<void> {
    const base = safeFileName(key);
    return serial(key, async () => {
      const d = root();
      for (const ext of [JSON_EXT, BIN_EXT]) {
        deleteIfExists(new File(d, base + ext));
        deleteIfExists(new File(d, base + ext + TMP_EXT));
      }
    });
  },

  async clear(): Promise<void> {
    await Promise.all([...queues.values()]);
    const d = root();
    if (d.exists) d.delete();
    dir = null;
    root();
  },
};
