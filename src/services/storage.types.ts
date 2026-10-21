// Contrato do armazenamento local chave-valor (nativo: arquivos; web: IndexedDB).
export interface KvStorage {
  /** Valor JSON salvo na chave, ou undefined se não existir ou estiver ilegível. */
  getJson<T>(key: string): Promise<T | undefined>;
  setJson(key: string, value: unknown): Promise<void>;
  /** Bytes salvos na chave (névoa, trilhas). */
  getBytes(key: string): Promise<Uint8Array | undefined>;
  setBytes(key: string, bytes: Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
  /** Apaga tudo o que o jogo salvou. */
  clear(): Promise<void>;
}
