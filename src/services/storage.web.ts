// Armazenamento na web: IndexedDB (idb-keyval). Mesmo banco da versão web antiga,
// então o save antigo continua valendo.
import { clear, createStore, del, get, set } from 'idb-keyval';
import type { KvStorage } from './storage.types.ts';

const db = createStore('desbrava', 'kv');

export const storage: KvStorage = {
  getJson<T>(key: string): Promise<T | undefined> {
    return get<T>(key, db);
  },

  async setJson(key: string, value: unknown): Promise<void> {
    await set(key, value, db);
  },

  async getBytes(key: string): Promise<Uint8Array | undefined> {
    const v: unknown = await get(key, db);
    if (v instanceof Uint8Array) return v;
    // a versão antiga guardava Float64Array direto: os bytes são os mesmos
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return undefined;
  },

  async setBytes(key: string, bytes: Uint8Array): Promise<void> {
    await set(key, bytes, db);
  },

  async remove(key: string): Promise<void> {
    await del(key, db);
  },

  async clear(): Promise<void> {
    await clear(db);
  },
};
